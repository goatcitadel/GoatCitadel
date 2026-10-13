import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { DurableChatTurnExecutionPayloadAuthority } from "@goatcitadel/contracts";
import { GatewayService } from "./services/gateway-service.js";
import type { HeartbeatOccurrenceService } from "./services/heartbeat-occurrence-service.js";
import { loadGatewayConfig } from "./config.js";
import { startFakeOpenAiCompatibleServer } from "./test/fake-openai-server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("runs a fresh occurrence-bound heartbeat through the real safe tool owner and retains its quiet decision across restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-heartbeat-tool-"));
  let toolRequests = 0;
  let observedToolResult = false;
  const provider = await startFakeOpenAiCompatibleServer((request) => {
    if (request.path === "/v1/models") return { body: { data: [{ id: "fixture-chat", object: "model" }] } };
    if (request.path !== "/v1/chat/completions") return { status: 404 };
    const body = request.body as {
      stream?: boolean;
      tools?: Array<{ function: { name: string } }>;
      messages?: Array<{ role: string; content?: unknown }>;
    };
    const toolResult = body.messages?.find((message) => message.role === "tool");
    observedToolResult ||= Boolean(toolResult);
    const tool = body.tools?.find((entry) => /time[._]now/u.test(entry.function.name));
    const toolCalls =
      !toolResult && tool
        ? [
            {
              index: 0,
              id: "call_heartbeat_time",
              type: "function",
              function: { name: tool.function.name, arguments: "{}" },
            },
          ]
        : undefined;
    if (toolCalls) toolRequests += 1;
    const content = '{"notify":false}';
    return body.stream
      ? {
          sseFrames: [
            JSON.stringify({
              model: "fixture-chat",
              choices: [
                {
                  index: 0,
                  delta: toolCalls ? { tool_calls: toolCalls } : { role: "assistant", content },
                  finish_reason: toolCalls ? "tool_calls" : "stop",
                },
              ],
            }),
            "[DONE]",
          ],
        }
      : {
          body: {
            model: "fixture-chat",
            choices: [
              {
                message: toolCalls
                  ? { role: "assistant", content: null, tool_calls: toolCalls }
                  : { role: "assistant", content },
                finish_reason: toolCalls ? "tool_calls" : "stop",
              },
            ],
          },
        };
  });
  let gateway: GatewayService | undefined;
  try {
    const configDir = path.join(root, "config");
    await fs.mkdir(configDir);
    const examples = fileURLToPath(new URL("../../../config/", import.meta.url));
    for (const name of [
      "assistant.config.example.json",
      "tool-policy.example.json",
      "budgets.example.json",
      "cron-jobs.example.json",
    ])
      await fs.copyFile(path.join(examples, name), path.join(configDir, name));
    const config = JSON.parse(await fs.readFile(path.join(examples, "goatcitadel.example.json"), "utf8"));
    config.llm = {
      activeProviderId: "fake-openai",
      activeModel: "fixture-chat",
      providers: [
        {
          providerId: "fake-openai",
          label: "Heartbeat fixture",
          baseUrl: provider.baseUrl,
          apiStyle: "openai-chat-completions",
          defaultModel: "fixture-chat",
        },
      ],
    };
    config.assistant.approvalExplainer.enabled = false;
    await fs.writeFile(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
    const policy = JSON.parse(await fs.readFile(path.join(configDir, "tool-policy.example.json"), "utf8"));
    policy.tools.allow.push("time.now");
    await fs.writeFile(path.join(configDir, "tool-policy.json"), JSON.stringify(policy));
    await fs.writeFile(
      path.join(configDir, "llm-model-metadata.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "fake-openai/fixture-chat": { contextWindow: 128_000, outputTokenLimit: 16_000 },
        },
      }),
    );
    for (const [key, value] of Object.entries({
      GATEWAY_HOST: "127.0.0.1",
      NODE_ENV: "test",
      GOATCITADEL_ROOT_DIR: root,
      GOATCITADEL_DATABASE_DRIVER: "sqlite",
      GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
      GOATCITADEL_FEATURE_AUTONOMY_V1_DISABLED: "false",
      GOATCITADEL_FEATURE_PROACTIVE_HEARTBEAT_TURNS_V1_ENABLED: "true",
    }))
      vi.stubEnv(key, value);
    gateway = new GatewayService(await loadGatewayConfig(root));
    await gateway.init();
    const session = await gateway.createChatSession({ title: "Heartbeat tool proof" });
    const sessionId = session.sessionId;
    await gateway.storage.sessionAutonomyPrefs.patch(sessionId, {
      heartbeatEnabled: true,
      activeHours: { start: 0, end: 0 },
    });
    // This is the existing internal scheduler owner, not a fabricated system request or mock enqueue.
    const owner = (gateway as unknown as { heartbeatOccurrenceService: HeartbeatOccurrenceService })
      .heartbeatOccurrenceService;
    expect(
      await owner.claimAndEnqueue({ workspaceId: "default", sessionId, expectedPriorCadence: {}, idleFloorSeconds: 0 }),
    ).toEqual({ disposition: "enqueued" });
    const cadence = await gateway.storage.sessionAutonomyPrefs.get(sessionId);
    const occurrenceId = cadence!.lastProactiveRunId!;
    expect(occurrenceId).toBeTruthy();
    let occurrence = await gateway.storage.heartbeatOccurrences.find(occurrenceId);
    await vi.waitFor(
      async () => {
        occurrence = await gateway!.storage.heartbeatOccurrences.find(occurrenceId);
        const run = await gateway!.storage.durableRuns.getRun(occurrence!.durableRunId);
        expect(run.status).toBe("completed");
      },
      { timeout: 60_000, interval: 150 },
    );
    await owner.recoverAll();
    occurrence = await gateway.storage.heartbeatOccurrences.find(occurrenceId);
    expect(occurrence).toMatchObject({ state: "terminal", terminalStatus: "completed" });
    const run = await gateway.storage.durableRuns.getRun(occurrence!.durableRunId);
    const authority = run.payload as unknown as DurableChatTurnExecutionPayloadAuthority;
    expect(toolRequests).toBe(1);
    expect(observedToolResult).toBe(true);
    expect(await gateway.storage.chatToolRuns.listByTurn(authority.turnId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "time.now", status: "executed" })]),
    );
    expect(authority.capabilityProfileId).toBeUndefined();
    const feature = await gateway.storage.sessionMutationAdmissions.findFeatureReferences({
      admissionId: authority.admissionId,
      sessionIncarnationId: authority.sessionIncarnationId,
      workspaceId: authority.workspaceId,
      sessionId,
      turnId: authority.turnId,
    });
    expect(feature?.referenceSha256).toBe(authority.featureReferenceSha256);
    expect(feature?.references.heartbeatOccurrence?.ownerId).toBe(occurrenceId);
    expect((await gateway.listChatMessages(sessionId)).filter((message) => message.role === "assistant")).toEqual([]);
    const retained = occurrence;
    const dispatchCount = provider.requests.filter((request) => request.path === "/v1/chat/completions").length;
    await gateway.close();
    gateway = undefined;
    gateway = new GatewayService(await loadGatewayConfig(root));
    await gateway.init();
    expect(await gateway.storage.heartbeatOccurrences.find(occurrenceId)).toEqual(retained);
    expect(provider.requests.filter((request) => request.path === "/v1/chat/completions")).toHaveLength(dispatchCount);
    expect((await gateway.listChatMessages(sessionId)).filter((message) => message.role === "assistant")).toEqual([]);
  } finally {
    await gateway?.close();
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 180_000);
