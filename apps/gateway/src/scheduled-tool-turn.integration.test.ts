import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatThreadResponse, DurableChatTurnExecutionPayloadAuthority } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { buildApp } from "./app.js";
import { startFakeOpenAiCompatibleServer } from "./test/fake-openai-server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("runs one scheduled tool-using Chat child through canonical owners and retains it across restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-scheduled-tool-"));
  let toolRequests = 0;
  let observedToolResult = false;
  const provider = await startFakeOpenAiCompatibleServer((request) => {
    if (request.path === "/v1/models") return { body: { data: [{ id: "fixture-chat", object: "model" }] } };
    if (request.path !== "/v1/chat/completions") return { status: 404 };
    const body = request.body as {
      stream?: boolean;
      tools?: Array<{ function: { name: string; description?: string } }>;
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
              id: "call_scheduled_time",
              type: "function",
              function: { name: tool.function.name, arguments: "{}" },
            },
          ]
        : undefined;
    if (toolCalls) toolRequests += 1;
    const content = toolResult ? "SCHEDULED_TOOL_COMPLETE" : "SCHEDULED_TOOL_UNAVAILABLE";
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
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let storage: Storage | undefined;
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
          label: "Scheduled fixture",
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
    const token = "scheduled-tool-test-operator-1234567890";
    for (const [key, value] of Object.entries({
      GATEWAY_HOST: "127.0.0.1",
      NODE_ENV: "test",
      GOATCITADEL_ROOT_DIR: root,
      GOATCITADEL_ALLOWED_ORIGINS: "http://localhost:5173",
      GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_TOKEN: token,
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
      GOATCITADEL_DATABASE_DRIVER: "sqlite",
      GOATCITADEL_RATE_LIMIT_ENABLED: "false",
      GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
      GOATCITADEL_FEATURE_AUTONOMY_V1_DISABLED: "false",
      GOATCITADEL_FEATURE_SCHEDULED_CHAT_TURNS_V1_ENABLED: "true",
    }))
      vi.stubEnv(key, value);
    let sequence = 0;
    const headers = () => ({ authorization: `Bearer ${token}`, "idempotency-key": `scheduled-tool-${++sequence}` });
    app = await buildApp();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions",
      headers: headers(),
      payload: { title: "Scheduled tool proof" },
    });
    expect(session.statusCode, session.body).toBe(201);
    const sessionId = session.json().sessionId as string;
    const job = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs",
      headers: headers(),
      payload: {
        jobId: "scheduled-tool-proof",
        name: "Scheduled tool proof",
        action: "agent_turn",
        schedule: "0 0 * * * UTC",
        enabled: true,
        actionConfig: {
          agentTurn: {
            prompt: "Use time.now once, then report SCHEDULED_TOOL_COMPLETE.",
            sessionId,
            createdBy: { permissionProfileId: "trusted_local_power" },
          },
        },
      },
    });
    expect(job.statusCode, job.body).toBe(201);
    expect(job.json().actionConfig.agentTurn.createdBy.operatorId).toBeTruthy();
    const admitted = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs/scheduled-tool-proof/run",
      headers: headers(),
      payload: {},
    });
    expect(admitted.statusCode, admitted.body).toBe(200);
    const occurrenceId = admitted.json().runId as string;
    expect(occurrenceId).toBeTruthy();
    let completed: ChatThreadResponse["turns"][number] | undefined;
    await vi.waitFor(
      async () => {
        const response = await app!.inject({
          method: "GET",
          url: `/api/v1/chat/sessions/${sessionId}/thread`,
          headers: headers(),
        });
        expect(response.statusCode, response.body).toBe(200);
        completed = (response.json() as ChatThreadResponse).turns.at(-1);
        expect(completed?.trace.status, JSON.stringify(completed?.trace)).toBe("completed");
      },
      { timeout: 60_000, interval: 150 },
    );
    expect(toolRequests).toBe(1);
    expect(observedToolResult).toBe(true);
    expect(completed!.assistantMessage?.content).toContain("SCHEDULED_TOOL_COMPLETE");
    expect(completed!.toolRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "time.now", status: "executed" })]),
    );
    const runId = completed!.trace.durable!.runId;
    const configRead = app.gatewayConfig;
    await app.close();
    app = undefined;
    const dispatchCount = provider.requests.filter((request) => request.path === "/v1/chat/completions").length;
    app = await buildApp();
    const retained = await app.inject({ method: "GET", url: `/api/v1/cron/runs/${occurrenceId}`, headers: headers() });
    expect(retained.statusCode, retained.body).toBe(200);
    expect(retained.json().canonical.childDurableRunId).toBe(runId);
    expect(provider.requests.filter((request) => request.path === "/v1/chat/completions")).toHaveLength(dispatchCount);
    await app.close();
    app = undefined;
    storage = new Storage({
      dbPath: configRead.dbPath,
      transcriptsDir: path.join(root, "read-transcripts"),
      auditDir: path.join(root, "read-audit"),
    });
    const run = storage.durableRuns.getRun(runId);
    expect(run.status).toBe("completed");
    const authority = run.payload as unknown as DurableChatTurnExecutionPayloadAuthority;
    expect(authority.capabilityProfileId).toBeUndefined();
    const feature = storage.sessionMutationAdmissions.findFeatureReferences({
      admissionId: authority.admissionId,
      sessionIncarnationId: authority.sessionIncarnationId,
      workspaceId: authority.workspaceId,
      sessionId,
      turnId: authority.turnId,
    });
    expect(feature?.referenceSha256).toBe(authority.featureReferenceSha256);
    expect(feature?.references.scheduledOccurrence?.ownerId).toBe(occurrenceId);
    expect(storage.cronRuns.listByJob("scheduled-tool-proof")).toHaveLength(1);
    expect(storage.cronRuns.get(occurrenceId)?.childDurableRunId).toBe(runId);
    // There is no external destination in this fixture. Delivery retry is proved separately.
    expect(storage.cronRuns.get(occurrenceId)?.deliveryRunId).toBeUndefined();
  } finally {
    storage?.close();
    await app?.close();
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 180_000);
