import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatCancelTurnResponse,
  ChatSessionStatusResponse,
  ChatThreadResponse,
  DevDiagnosticsListResponse,
  DurableRunRecord,
  RoutingPreflightResult,
} from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiRequest,
  type FakeOpenAiResponse,
  type FakeOpenAiServer,
} from "./test/fake-openai-server.js";

const TOKEN = "chat-cancel-admission-token-1234567890";
const ENV_KEYS = [
  "GATEWAY_HOST",
  "NODE_ENV",
  "GOATCITADEL_ALLOWED_ORIGINS",
  "GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS",
  "GOATCITADEL_AUTH_MODE",
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_DEV_DIAGNOSTICS_ENABLED",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_ROOT_DIR",
] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];
let fakeProvider: FakeOpenAiServer | undefined;
let releaseFirstProviderRequest: (() => void) | undefined;

describe("GC-USAB-042 durable Chat cancellation admission closure", { timeout: 180_000 }, () => {
  afterEach(async () => {
    releaseFirstProviderRequest?.();
    releaseFirstProviderRequest = undefined;
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    await fakeProvider?.close();
    fakeProvider = undefined;
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("cancels a pre-output durable stream, releases its exact admission, and admits the next turn", async () => {
    const firstProviderGate = createDeferred<void>();
    releaseFirstProviderRequest = () => firstProviderGate.resolve();
    let completionDispatchCount = 0;
    fakeProvider = await startFakeOpenAiCompatibleServer(async (request) => {
      if (request.method === "GET" && request.path === "/v1/models") {
        return { body: { data: [{ id: "fake-chat", object: "model", owned_by: "goatcitadel-test" }] } };
      }
      if (request.method === "POST" && request.path === "/v1/chat/completions") {
        completionDispatchCount += 1;
        if (completionDispatchCount === 1) await firstProviderGate.promise;
        return successfulStreamResponse(request, completionDispatchCount === 1 ? "Cancelled response." : "CHAT_OK");
      }
      return { status: 404, body: { error: { message: `No fake route for ${request.method} ${request.path}` } } };
    });
    configureGateway(fakeProvider.baseUrl);
    const app = await buildApp();
    try {
      const sessionResponse = await app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions",
        headers: mutationHeaders("gc-usab-042-session"),
        payload: { title: "GC-USAB-042 cancellation closure" },
      });
      expect(sessionResponse.statusCode, sessionResponse.body).toBe(201);
      const sessionId = (sessionResponse.json() as { sessionId: string }).sessionId;

      const firstPreflight = await routePreflight(app, sessionId, "Hold before output.", "gc-usab-042-preflight-1");
      const firstStreamPromise = app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send/stream`,
        headers: mutationHeaders("gc-usab-042-send-1"),
        payload: sendPayload("Hold before output.", firstPreflight),
      });

      const activeStatus = await pollFor(
        async () => readSessionStatus(app, sessionId),
        (status) =>
          status.work.availability === "available" &&
          Boolean(status.work.value.latestTurnId) &&
          status.work.value.durableRuns.some((run) => run.status === "queued" || run.status === "running") &&
          completionDispatchCount === 1,
        "a canonical active turn, durable run, and blocked pre-output provider dispatch",
      );
      const activeWork = expectAvailableWork(activeStatus);
      const turnId = activeWork.latestTurnId!;
      const runId = activeWork.durableRuns.find((run) => run.status === "queued" || run.status === "running")!.runId;
      expect(completionDispatchCount).toBe(1);

      const cancelResponse = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
        headers: mutationHeaders("gc-usab-042-cancel-1"),
        payload: { cancelledBy: "integration-test" },
      });
      expect(cancelResponse.statusCode, cancelResponse.body).toBe(200);
      expect(cancelResponse.json() as ChatCancelTurnResponse).toMatchObject({
        sessionId,
        turnId,
        cancelled: true,
        trace: { status: "cancelled", durable: { runId, status: "cancelled" } },
      });

      releaseFirstProviderRequest();
      releaseFirstProviderRequest = undefined;
      const firstStream = await firstStreamPromise;
      expect(firstStream.statusCode, firstStream.body.slice(0, 2_000)).toBe(200);

      const terminalThread = await pollFor(
        async () => readThread(app, sessionId),
        (thread) => thread.turns.some((turn) => turn.turnId === turnId && turn.trace.status === "cancelled"),
        "the cancelled turn trace",
      );
      expect(terminalThread.turns.find((turn) => turn.turnId === turnId)?.trace).toMatchObject({
        turnId,
        sessionId,
        status: "cancelled",
        durable: { runId, status: "cancelled", checkpointKind: "run_cancelled" },
      });
      const terminalRun = await pollFor(
        async () => readDurableRun(app, runId),
        (run) => run.status === "cancelled",
        "the cancelled durable run",
      );
      expect(terminalRun).toMatchObject({ runId, status: "cancelled" });
      expect(completionDispatchCount).toBe(1);

      // A same-session second turn is the public, end-to-end proof that the
      // first turn's canonical mutation admission was released. No direct
      // storage mutation or private Gateway implementation is consulted.
      const secondPreflight = await routePreflight(
        app,
        sessionId,
        "Reply with exactly: CHAT_OK",
        "gc-usab-042-preflight-2",
      );
      const secondStream = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send/stream`,
        headers: mutationHeaders("gc-usab-042-send-2"),
        payload: sendPayload("Reply with exactly: CHAT_OK", secondPreflight),
      });
      expect(secondStream.statusCode, secondStream.body.slice(0, 2_000)).toBe(200);
      expect(secondStream.body).toContain("CHAT_OK");
      expect(secondStream.body).not.toContain('"type":"error"');
      expect(completionDispatchCount).toBeGreaterThanOrEqual(2);

      const diagnosticsResponse = await app.inject({
        method: "GET",
        url: "/api/v1/dev/diagnostics?category=chat&limit=500",
        headers: operatorHeaders(),
      });
      expect(diagnosticsResponse.statusCode, diagnosticsResponse.body).toBe(200);
      const diagnostics = diagnosticsResponse.json() as DevDiagnosticsListResponse;
      const exactRecoveryDiagnostics = diagnostics.items.filter(
        (item) =>
          item.runId === runId &&
          (item.event === "chat.turn.terminal_delivery_admission_recovery" ||
            item.event === "chat.turn.terminal_admission_recovery"),
      );
      expect(exactRecoveryDiagnostics.filter((item) => item.runtimeStatus === "degraded")).toEqual([]);
      expect(JSON.stringify(exactRecoveryDiagnostics)).not.toContain("checkpoint-anchored runtime authority");
    } finally {
      releaseFirstProviderRequest?.();
      releaseFirstProviderRequest = undefined;
      await app.close();
    }
  });
});

function successfulStreamResponse(request: FakeOpenAiRequest, content: string): FakeOpenAiResponse {
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (body.stream !== true) {
    return {
      body: {
        id: "gc-usab-042-completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        model: typeof body.model === "string" ? body.model : "fake-chat",
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
    };
  }
  return {
    sseFrames: [
      JSON.stringify({
        id: "gc-usab-042-stream",
        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
        model: typeof body.model === "string" ? body.model : "fake-chat",
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
      "[DONE]",
    ],
  };
}

async function routePreflight(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
  content: string,
  idempotencyKey: string,
): Promise<RoutingPreflightResult> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/route-preflight`,
    headers: mutationHeaders(idempotencyKey),
    payload: { action: "send", content, subagentPolicy: "off" },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json() as RoutingPreflightResult;
  expect(result.blockedReason).toBeUndefined();
  return result;
}

function sendPayload(content: string, preflight: RoutingPreflightResult): Record<string, unknown> {
  return {
    content,
    providerId: preflight.decision.effectiveProviderId,
    model: preflight.decision.effectiveModel,
    subagentPolicy: "off",
    routeDecision: preflight.decision,
  };
}

async function readSessionStatus(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
): Promise<ChatSessionStatusResponse> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/status`,
    headers: operatorHeaders(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ChatSessionStatusResponse;
}

async function readThread(app: Awaited<ReturnType<typeof buildApp>>, sessionId: string): Promise<ChatThreadResponse> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`,
    headers: operatorHeaders(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ChatThreadResponse;
}

async function readDurableRun(app: Awaited<ReturnType<typeof buildApp>>, runId: string): Promise<DurableRunRecord> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/durable/runs/${encodeURIComponent(runId)}`,
    headers: operatorHeaders(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as DurableRunRecord;
}

function expectAvailableWork(status: ChatSessionStatusResponse) {
  if (status.work.availability !== "available") {
    throw new Error(`Session work status was unavailable: ${status.work.reason}`);
  }
  return status.work.value;
}

async function pollFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 20_000,
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

function operatorHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

function mutationHeaders(idempotencyKey: string): Record<string, string> {
  return { ...operatorHeaders(), "idempotency-key": idempotencyKey };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve: (value?: T) => resolve(value as T) };
}

function configureGateway(providerBaseUrl: string): void {
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.NODE_ENV = "test";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_DEV_DIAGNOSTICS_ENABLED = "true";
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_ROOT_DIR = createIsolatedConfigRoot(providerBaseUrl);
}

function createIsolatedConfigRoot(providerBaseUrl: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-chat-cancel-admission-"));
  const repoRoot = findRepoRoot();
  fs.cpSync(path.join(repoRoot, "config"), path.join(root, "config"), { recursive: true });
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
  const unifiedConfigPath = path.join(root, "config", "goatcitadel.json");
  const baseConfigPath = path.join(root, "config", "goatcitadel.example.json");
  const unifiedConfig = JSON.parse(fs.readFileSync(baseConfigPath, "utf8")) as Record<string, unknown>;
  unifiedConfig.llm = llmConfig;
  fs.writeFileSync(unifiedConfigPath, `${JSON.stringify(unifiedConfig, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(root, "config", "llm-providers.json"), `${JSON.stringify(llmConfig, null, 2)}\n`, "utf8");
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

function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, "config", "goatcitadel.example.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Unable to locate GoatCitadel repository root.");
    current = parent;
  }
}
