import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InboundChannelEventRecord } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../config.js";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiRequest,
  type FakeOpenAiResponse,
  type FakeOpenAiServer,
} from "../test/fake-openai-server.js";
import { handleDiscordRuntimeInbound } from "./discord-runtime-bridge-service.js";
import { GatewayService } from "./gateway-service.js";

const ENV_KEYS = [
  "NODE_ENV",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_ROOT_DIR",
  "GOATCITADEL_SURFACE_ROUTER_JUDGE_ENABLED",
] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];
let gateway: GatewayService | undefined;
let fakeProvider: FakeOpenAiServer | undefined;
let fakeDiscord: FakeDiscordWebhookServer | undefined;

describe("Discord durable inbound turn admission", { timeout: 120_000 }, () => {
  afterEach(async () => {
    await gateway?.close().catch(() => undefined);
    gateway = undefined;
    await fakeProvider?.close().catch(() => undefined);
    fakeProvider = undefined;
    await fakeDiscord?.close().catch(() => undefined);
    fakeDiscord = undefined;
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it("binds a real system turn admission to the durable capability profile and replays without redelivery", async () => {
    fakeProvider = await startFakeOpenAiCompatibleServer(successfulProviderResponse);
    fakeDiscord = await startFakeDiscordWebhookServer();
    const root = createIsolatedConfigRoot(fakeProvider.baseUrl);
    configureGateway(root);
    gateway = new GatewayService(await loadGatewayConfig(root));
    await gateway.initCritical();

    const connection = await gateway.routeServices.integrations.createIntegrationConnection({
      catalogId: "channel.discord",
      label: "Discord inbound admission integration test",
      enabled: true,
      status: "connected",
      config: {
        runtimeMode: "gateway",
        webhookUrl: fakeDiscord.webhookUrl,
        defaultChannelId: "discord-channel-1",
        inboundAccessMode: "open_legacy",
      },
    });
    const sourceMessageId = "discord-source-admission-1";
    const idempotencyKey = `discord:${connection.connectionId}:${sourceMessageId}`;
    const inbound = {
      connectionId: connection.connectionId,
      target: "discord-channel-1",
      actorId: "discord-user-1",
      displayName: "Discord Test User",
      content: "Reply with exactly: DISCORD_OK",
      sourceMessageId,
      peer: "discord-user-1",
      room: "discord-channel-1",
      metadata: {
        guildId: "discord-guild-1",
        channelId: "discord-channel-1",
        runtimeMode: "gateway",
      },
    };

    await handleDiscordRuntimeInbound(gateway, inbound);
    const event = await pollFor(
      async () =>
        await gateway!.storage.inboundChannelEvents.getByIdentity({
          channelKey: "discord",
          connectionId: connection.connectionId,
          idempotencyKey,
        }),
      (candidate) =>
        candidate?.status === "completed" ||
        candidate?.status === "failed" ||
        candidate?.status === "manual_reconciliation_required" ||
        candidate?.status === "suppressed" ||
        candidate?.lastError?.includes("capability admission requires an active turn-write admission") === true,
      "the Discord inbound turn to complete or expose an admission failure",
    );
    expect(event?.status, event?.lastError ?? JSON.stringify(event)).toBe("completed");
    const completed = requireCompletedEvent(event);
    expect(completed).toMatchObject({
      channelKey: "discord",
      connectionId: connection.connectionId,
      idempotencyKey,
      dispatchKind: "agent_turn",
      providerSourceId: sourceMessageId,
      status: "completed",
      attemptCount: 1,
    });
    expect(completed.sessionId).toEqual(expect.any(String));
    expect(completed.messageId).toEqual(expect.any(String));
    expect(completed.turnId).toEqual(expect.any(String));
    expect(completed.assistantMessageId).toEqual(expect.any(String));
    expect(completed.durableRunId).toEqual(expect.any(String));
    expect(completed.deliveryId).toEqual(expect.any(String));
    expect(completed.providerMessageId).toBeUndefined();

    const run = await pollFor(
      async () => await gateway!.storage.durableRuns.getRun(completed.durableRunId!),
      (candidate) =>
        candidate.status === "completed" || candidate.status === "failed" || candidate.status === "cancelled",
      "the linked durable Chat run to settle",
    );
    expect(run.status, run.lastError).toBe("completed");
    expect(run).toMatchObject({
      runId: completed.durableRunId,
      workflowKey: "chat.turn.execute",
      payload: {
        version: "chat.turn.execute.v2",
        sessionId: completed.sessionId,
        turnId: completed.turnId,
      },
    });
    const admissionId = requireString(run.payload.admissionId, "run.payload.admissionId");
    const admission = await pollFor(
      async () => await gateway!.storage.sessionMutationAdmissions.require(admissionId),
      (candidate) => candidate.status !== "active",
      "the durable terminal authority to close the inbound turn admission",
    );
    expect(admission).toMatchObject({
      admissionId,
      admissionKind: "turn_write",
      actorKind: "system",
      actorId: `system:integration:${connection.connectionId}`,
      operation: "chat_turn",
      status: "completed",
      sessionId: completed.sessionId,
      turnId: completed.turnId,
      terminalAuthorityKind: "durable_terminal",
      terminalDurableRunId: completed.durableRunId,
      terminalDurableRunStatus: "completed",
    });

    const profileEnvelope = await gateway.storage.chatTurnCapabilityProfiles.inspectByTurn(completed.turnId!);
    expect(profileEnvelope.state, profileEnvelope.error).toBe("available");
    const profile = profileEnvelope.profile;
    expect(profile).toBeDefined();
    expect(profile).toMatchObject({
      identity: {
        sessionId: completed.sessionId,
        turnId: completed.turnId,
        durableRunId: completed.durableRunId,
      },
      source: {
        channel: "discord",
        account: connection.connectionId,
      },
    });
    const bindingProof = await gateway.storage.sessionMutationAdmissions.requireCapabilityProfileBinding({
      admissionId,
      sessionIncarnationId: admission.sessionIncarnationId,
      workspaceId: admission.workspaceId,
      sessionId: completed.sessionId!,
      turnId: completed.turnId!,
      profileId: profile!.profileId,
      profileHash: profile!.hashes.profileHash,
      createdAt: profile!.createdAt,
    });
    expect(bindingProof).toMatchObject({
      admission: { admissionId },
      binding: {
        profileId: profile!.profileId,
        turnId: completed.turnId,
        profileHash: profile!.hashes.profileHash,
      },
    });

    const delivery = await pollFor(
      async () =>
        (await gateway!.storage.commsDeliveries.list(connection.connectionId, 20)).find(
          (candidate) => candidate.deliveryId === completed.deliveryId,
        ),
      (candidate) =>
        candidate?.status === "sent" ||
        candidate?.status === "failed" ||
        candidate?.status === "manual_reconciliation_required",
      "the queued Discord reply delivery to settle",
    );
    expect(delivery?.status, delivery?.error).toBe("sent");
    expect(delivery).toMatchObject({
      deliveryId: completed.deliveryId,
      connectionId: connection.connectionId,
      channelKey: "discord",
      target: "discord-channel-1",
      providerMessageId: "discord-provider-message-1",
      attempts: 1,
    });

    const completionDispatchCount = countProviderCompletions(fakeProvider);
    expect(completionDispatchCount).toBeGreaterThan(0);
    expect(fakeDiscord.requests).toHaveLength(1);
    expect(fakeDiscord.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/webhooks/discord-test-id/discord-test-token",
      search: "?wait=true",
      body: { content: "DISCORD_OK" },
    });

    await handleDiscordRuntimeInbound(gateway, inbound);
    const replayed = await gateway.storage.inboundChannelEvents.getByIdentity({
      channelKey: "discord",
      connectionId: connection.connectionId,
      idempotencyKey,
    });
    expect(replayed).toMatchObject({
      eventId: completed.eventId,
      status: "completed",
      sessionId: completed.sessionId,
      turnId: completed.turnId,
      durableRunId: completed.durableRunId,
      deliveryId: completed.deliveryId,
    });
    expect(countProviderCompletions(fakeProvider)).toBe(completionDispatchCount);
    expect(fakeDiscord.requests).toHaveLength(1);
  });
});

function successfulProviderResponse(request: FakeOpenAiRequest): FakeOpenAiResponse {
  if (request.method === "GET" && request.path === "/v1/models") {
    return { body: { data: [{ id: "fake-chat", object: "model", owned_by: "goatcitadel-test" }] } };
  }
  if (request.method === "POST" && request.path === "/v1/chat/completions") {
    const body = asRecord(request.body);
    if (body.stream === true) {
      return {
        sseFrames: [
          JSON.stringify({
            id: "discord-admission-stream",
            choices: [{ index: 0, delta: { content: "DISCORD_OK" }, finish_reason: "stop" }],
            model: typeof body.model === "string" ? body.model : "fake-chat",
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          }),
          "[DONE]",
        ],
      };
    }
    return {
      body: {
        id: "discord-admission-completion",
        object: "chat.completion",
        model: typeof body.model === "string" ? body.model : "fake-chat",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "DISCORD_OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
    };
  }
  return { status: 404, body: { error: { message: `No fake route for ${request.method} ${request.path}` } } };
}

interface FakeDiscordWebhookRequest {
  method: string;
  path: string;
  search: string;
  rawBody: string;
  body: unknown;
}

interface FakeDiscordWebhookServer {
  webhookUrl: string;
  requests: FakeDiscordWebhookRequest[];
  close: () => Promise<void>;
}

async function startFakeDiscordWebhookServer(): Promise<FakeDiscordWebhookServer> {
  const requests: FakeDiscordWebhookRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      search: url.search,
      rawBody,
      body: parseJson(rawBody),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "discord-provider-message-1" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    webhookUrl: `http://127.0.0.1:${address.port}/api/webhooks/discord-test-id/discord-test-token`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function configureGateway(root: string): void {
  process.env.NODE_ENV = "test";
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_ROOT_DIR = root;
  process.env.GOATCITADEL_SURFACE_ROUTER_JUDGE_ENABLED = "0";
}

function createIsolatedConfigRoot(providerBaseUrl: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-discord-inbound-admission-"));
  fs.cpSync(path.join(findRepoRoot(), "config"), path.join(root, "config"), { recursive: true });
  const llmConfig = {
    activeProviderId: "fake-openai",
    activeModel: "fake-chat",
    providers: [
      {
        providerId: "fake-openai",
        label: "Fake OpenAI",
        baseUrl: providerBaseUrl,
        apiStyle: "openai-chat-completions",
        defaultModel: "fake-chat",
      },
    ],
  };
  const baseConfigPath = path.join(root, "config", "goatcitadel.example.json");
  const unifiedConfig = JSON.parse(fs.readFileSync(baseConfigPath, "utf8")) as Record<string, unknown>;
  unifiedConfig.llm = llmConfig;
  appendLoopbackNetworkAllowlist(unifiedConfig);
  fs.writeFileSync(
    path.join(root, "config", "goatcitadel.json"),
    `${JSON.stringify(unifiedConfig, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(root, "config", "llm-providers.json"), `${JSON.stringify(llmConfig, null, 2)}\n`, "utf8");
  const toolPolicyPath = path.join(root, "config", "tool-policy.json");
  // config/tool-policy.json is gitignored, so a fresh checkout (CI) only carries the example.
  const toolPolicySourcePath = fs.existsSync(toolPolicyPath)
    ? toolPolicyPath
    : path.join(root, "config", "tool-policy.example.json");
  const toolPolicy = JSON.parse(fs.readFileSync(toolPolicySourcePath, "utf8")) as Record<string, unknown>;
  appendLoopbackNetworkAllowlist({ toolPolicy });
  fs.writeFileSync(toolPolicyPath, `${JSON.stringify(toolPolicy, null, 2)}\n`, "utf8");
  const metadataPath = path.join(root, "config", "llm-model-metadata.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { entries: Record<string, unknown> };
  metadata.entries["fake-openai/fake-chat"] = {
    contextWindow: 128_000,
    outputTokenLimit: 16_000,
    reasoning: { supportedEfforts: ["low", "medium", "high"] },
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  tempRoots.push(root);
  return root;
}

function appendLoopbackNetworkAllowlist(config: Record<string, unknown>): void {
  const toolPolicy = asRecord(config.toolPolicy);
  const sandbox = asRecord(toolPolicy.sandbox);
  const networkAllowlist = Array.isArray(sandbox.networkAllowlist) ? sandbox.networkAllowlist : [];
  sandbox.networkAllowlist = [...new Set([...networkAllowlist, "127.0.0.1"])];
  toolPolicy.sandbox = sandbox;
  config.toolPolicy = toolPolicy;
}

function countProviderCompletions(provider: FakeOpenAiServer): number {
  return provider.requests.filter((request) => request.method === "POST" && request.path === "/v1/chat/completions")
    .length;
}

function requireCompletedEvent(event: InboundChannelEventRecord | undefined): InboundChannelEventRecord {
  if (!event || event.status !== "completed") {
    throw new Error(`Discord inbound event did not complete: ${JSON.stringify(event)}`);
  }
  return event;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} was not a non-empty string.`);
  return value;
}

async function pollFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last).slice(0, 4_000)}`);
}

function parseJson(rawBody: string): unknown {
  if (!rawBody.trim()) return undefined;
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, "config", "goatcitadel.example.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Unable to locate GoatCitadel repository root.");
    current = parent;
  }
}
