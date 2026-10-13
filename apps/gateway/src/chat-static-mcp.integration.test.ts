import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatThreadResponse, McpServerRecord } from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { startFakeOpenAiCompatibleServer } from "./test/fake-openai-server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("resumes a fresh public static MCP approval after app restart and retains exactly one actual invocation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-public-static-mcp-"));
  const marker = "MCP_PUBLIC_APPROVAL_RESULT";
  let calls = 0,
    selectedToolVisible = false,
    resultSeenByProvider = false;
  const mcp = await startFakeOpenAiCompatibleServer((request) => {
    if (request.path !== "/mcp" || request.method !== "POST") return { status: 404 };
    const message = request.body as {
      id?: string | number;
      method: string;
      params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
    };
    if (message.id === undefined) return { status: 202 };
    let result;
    if (message.method === "initialize")
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "public-static-mcp-fixture", version: "1.0.0" },
      };
    else if (message.method === "tools/list")
      result = {
        tools: [
          {
            name: "feature_quality_read",
            description: "Read one fixed public-approval fixture marker, with no external effects.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          },
        ],
      };
    else if (message.method === "tools/call") {
      expect(message.params).toMatchObject({ name: "feature_quality_read", arguments: {} });
      calls += 1;
      result = { content: [{ type: "text", text: marker }], isError: false };
    } else return { status: 400 };
    return { body: { jsonrpc: "2.0", id: message.id, result } };
  });
  const provider = await startFakeOpenAiCompatibleServer((request) => {
    if (request.path === "/v1/models") return { body: { data: [{ id: "fixture-chat", object: "model" }] } };
    if (request.path !== "/v1/chat/completions") return { status: 404 };
    const body = request.body as {
      stream?: boolean;
      tools?: Array<{ function: { name: string } }>;
      messages?: Array<{ role: string; content?: unknown }>;
    };
    const hasResult = (body.messages ?? []).some(
      (message) => message.role === "tool" && JSON.stringify(message.content).includes(marker),
    );
    const tool = body.tools?.find((entry) => entry.function.name.startsWith("mcp_s_"));
    if (body.stream) selectedToolVisible ||= Boolean(tool);
    if (body.stream && hasResult) resultSeenByProvider = true;
    const toolCalls =
      body.stream && !hasResult && tool
        ? [
            {
              index: 0,
              id: "call_public_static_mcp",
              type: "function",
              function: { name: tool.function.name, arguments: "{}" },
            },
          ]
        : undefined;
    const content = hasResult ? `The approved tool returned ${marker}.` : "Controlled fixture auxiliary response.";
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
              usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
            }),
            "[DONE]",
          ],
        }
      : {
          body: {
            model: "fixture-chat",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
          },
        };
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let cancelOwnedTurn: (() => Promise<void>) | undefined;
  const streamAbort = new AbortController();
  let pendingSend: Promise<unknown> | undefined;
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
          label: "Static MCP controlled fixture",
          baseUrl: provider.baseUrl,
          apiStyle: "openai-chat-completions",
          defaultModel: "fixture-chat",
        },
      ],
    };
    config.assistant.approvalExplainer.enabled = false;
    // Only this disposable fixed read-only server is allowed. Approval remains mandatory.
    config.toolPolicy.tools.deny = config.toolPolicy.tools.deny.filter((name: string) => name !== "mcp.invoke");
    config.toolPolicy.tools.allow.push("mcp.invoke");
    config.toolPolicy.tools.approvalMode = "approve_all";
    await fs.writeFile(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
    await fs.writeFile(path.join(configDir, "tool-policy.json"), JSON.stringify(config.toolPolicy));
    await fs.writeFile(
      path.join(configDir, "llm-model-metadata.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "fake-openai/fixture-chat": { contextWindow: 64_000, outputTokenLimit: 4096 },
        },
      }),
    );
    const token = "static-mcp-test-operator-1234567890";
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
      GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
      GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
      GOATCITADEL_FEATURE_CHAT_STATIC_MCP_V1_ENABLED: "true",
    }))
      vi.stubEnv(key, value);
    let sequence = 0;
    const headers = () => ({ authorization: `Bearer ${token}`, "idempotency-key": `static-mcp-proof-${++sequence}` });
    app = await buildApp();
    const gatewayUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      headers: headers(),
      payload: {
        label: "Public approval fixture",
        transport: "http",
        url: `${mcp.baseUrl.slice(0, -3)}/mcp`,
        authType: "none",
        enabled: true,
        category: "development",
        trustTier: "restricted",
        policy: { requireFirstToolApproval: true, allowedToolPatterns: ["feature_quality_read"] },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const server = created.json() as McpServerRecord;
    const connected = await app.inject({
      method: "POST",
      url: `/api/v1/mcp/servers/${server.serverId}/connect-reviewed`,
      headers: headers(),
      payload: { expectedRevision: server.revision, expectedConnectionRevision: server.connectionRevision ?? null },
    });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json().server.status).toBe("connected");
    const discovered = await app.inject({
      method: "GET",
      url: `/api/v1/mcp/servers/${server.serverId}/tools`,
      headers: headers(),
    });
    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(discovered.body).toContain("feature_quality_read");
    expect(calls).toBe(0);
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions",
      headers: headers(),
      payload: { title: "Static MCP approval proof" },
    });
    expect(session.statusCode, session.body).toBe(201);
    const sessionId = session.json().sessionId as string;
    const sessionUrl = `/api/v1/chat/sessions/${sessionId}`;
    const readThread = async () => {
      const response = await app!.inject({ method: "GET", url: `${sessionUrl}/thread`, headers: headers() });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as ChatThreadResponse;
    };
    cancelOwnedTurn = async () => {
      if (!app) return;
      const turn = (await readThread()).turns.at(-1);
      if (turn && !["completed", "failed", "cancelled"].includes(turn.trace.status))
        await app.inject({
          method: "POST",
          url: `${sessionUrl}/turns/${turn.turnId}/cancel`,
          headers: headers(),
          payload: {},
        });
    };
    const input = {
      content: `Invoke exactly once mcp.${server.serverId}.feature_quality_read with empty arguments. Use normal approval and report the actual result.`,
      providerId: "fake-openai",
      model: "fixture-chat",
      subagentPolicy: "off",
      webMode: "off",
      memoryMode: "off",
      useMemory: false,
    };
    const preflight = await app.inject({
      method: "POST",
      url: `${sessionUrl}/route-preflight`,
      headers: headers(),
      payload: { action: "send", ...input },
    });
    expect(preflight.statusCode, preflight.body).toBe(200);
    // Use a real owned socket: buffered request injection does not settle its
    // hijacked SSE response when only the synthetic request is aborted.
    const sent = fetch(`${gatewayUrl}${sessionUrl}/agent-send/stream`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ ...input, routeDecision: preflight.json().decision }),
      signal: streamAbort.signal,
    });
    pendingSend = sent;
    void pendingSend.catch(() => undefined);
    const streamed = await sent;
    expect(streamed.status).toBe(200);
    let turn: ChatThreadResponse["turns"][number];
    await vi.waitFor(
      async () => {
        turn = (await readThread()).turns.at(-1)!;
        expect(turn?.trace.status, JSON.stringify(turn?.trace)).toBe("waiting_for_approval");
      },
      { timeout: 60_000, interval: 150 },
    );
    expect(selectedToolVisible).toBe(true);
    expect(calls).toBe(0);
    const pendingTool = turn!.toolRuns.find((tool) => tool.approvalId)!;
    const evidenceUrl = `/api/v1/mcp/servers/${server.serverId}/test-evidence?workspaceId=default`;
    const beforeApprovalEvidence = await app.inject({ method: "GET", url: evidenceUrl, headers: headers() });
    expect(beforeApprovalEvidence.statusCode, beforeApprovalEvidence.body).toBe(200);
    expect(beforeApprovalEvidence.json().state).toBe("unverified");
    const invalidTokenEvidence = await app.inject({
      method: "GET",
      url: evidenceUrl,
      headers: { authorization: "Bearer invalid-fixture-token" },
    });
    expect([401, 403]).toContain(invalidTokenEvidence.statusCode);
    expect(pendingTool?.status).toBe("approval_required");
    const approvalId = pendingTool.approvalId!,
      turnId = turn!.turnId,
      runId = turn!.trace.durable!.runId;
    const replay = await app.inject({
      method: "GET",
      url: `/api/v1/approvals/${approvalId}/replay`,
      headers: headers(),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().approval).toMatchObject({ status: "pending", linkage: { sessionId, turnId, runId } });
    expect(replay.json().approval.linkage.durableRunId).not.toBe(runId);
    // Restart the real app over the same disposable SQLite state. No private
    // authority handle or mocked pending action survives this boundary.
    // The SSE request stays open while approval is pending; disconnect the
    // client after observing canonical wait instead of awaiting final output.
    streamAbort.abort();
    await pendingSend.catch(() => undefined);
    await app.close();
    app = undefined;
    app = await buildApp();
    expect(calls).toBe(0);
    const resolved = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/resolve`,
      headers: headers(),
      payload: { decision: "approve" },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    await vi.waitFor(
      async () => {
        turn = (await readThread()).turns.find((value) => value.turnId === turnId)!;
        expect(turn?.trace.status, JSON.stringify(turn?.trace)).toBe("completed");
        expect(turn?.assistantMessage?.content).toContain(marker);
      },
      { timeout: 60_000, interval: 150 },
    );
    expect(calls).toBe(1);
    expect(resultSeenByProvider).toBe(true);
    expect(turn!.trace.durable?.runId).toBe(runId);
    expect(turn!.trace.capabilityProfileId).toBeUndefined();
    const executed = turn!.toolRuns.find((tool) => tool.toolRunId === pendingTool.toolRunId)!;
    expect(executed).toMatchObject({ status: "executed", approvalId, toolName: pendingTool.toolName });
    expect(JSON.stringify(executed.result)).toContain(marker);
    // A duplicate approval cannot dispatch the external call a second time.
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/resolve`,
      headers: headers(),
      payload: { decision: "approve" },
    });
    expect([200, 409]).toContain(duplicate.statusCode);
    expect(calls).toBe(1);
    await vi.waitFor(
      async () => {
        const tested = await app!.inject({ method: "GET", url: evidenceUrl, headers: headers() });
        expect(tested.statusCode, tested.body).toBe(200);
        expect(tested.json(), tested.body).toMatchObject({
          state: "verified",
          receipt: { sessionId, turnId, durableRunId: runId, toolRunId: executed.toolRunId, approvalId },
        });
        expect(tested.body).not.toContain(marker);
      },
      { timeout: 10_000, interval: 100 },
    );
    const otherWorkspace = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: headers(),
      payload: { name: "MCP proof other workspace" },
    });
    expect(otherWorkspace.statusCode, otherWorkspace.body).toBe(201);
    const otherEvidence = await app.inject({
      method: "GET",
      url: `/api/v1/mcp/servers/${server.serverId}/test-evidence?workspaceId=${encodeURIComponent(otherWorkspace.json().workspaceId)}`,
      headers: headers(),
    });
    expect(otherEvidence.statusCode, otherEvidence.body).toBe(200);
    expect(otherEvidence.json()).toMatchObject({ state: "unverified" });
    expect(otherEvidence.json().receipt).toBeUndefined();
    const currentServer = (
      await app.inject({ method: "GET", url: `/api/v1/mcp/servers/${server.serverId}`, headers: headers() })
    ).json() as McpServerRecord;
    const changedServer = await app.inject({
      method: "PATCH",
      url: `/api/v1/mcp/servers/${server.serverId}`,
      headers: headers(),
      payload: { expectedRevision: currentServer.revision, label: "Reviewed changed fixture" },
    });
    expect(changedServer.statusCode, changedServer.body).toBe(200);
    const staleEvidence = await app.inject({ method: "GET", url: evidenceUrl, headers: headers() });
    expect(staleEvidence.statusCode, staleEvidence.body).toBe(200);
    expect(staleEvidence.json().state).toBe("stale");
    expect(staleEvidence.json().receipt).toBeUndefined();
    expect(calls).toBe(1);
  } finally {
    streamAbort.abort();
    await cancelOwnedTurn?.();
    await pendingSend?.catch(() => undefined);
    await app?.close();
    await provider.close();
    await mcp.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 180_000);
