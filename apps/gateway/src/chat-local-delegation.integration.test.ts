import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatDelegateResponse,
  ChatDelegateSuggestResponse,
  ChatDelegationRunDetail,
  ChatThreadResponse,
  DurableChildWatcherRecord,
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

const TOKEN = "local-delegation-test-1234567890";
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
let releaseChild: (() => void) | undefined;

describe("supervised profile-free local delegation public admission", { timeout: 180_000 }, () => {
  afterEach(async () => {
    releaseChild?.();
    releaseChild = undefined;
    await fakeProvider?.close();
    fakeProvider = undefined;
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const root of tempRoots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
  });

  it.each([false, true])(
    "preserves one real local child across observation and acceptance replay (cancel=%s)",
    async (cancel) => {
      const held = createDeferred<void>();
      releaseChild = () => held.resolve();
      let childDispatches = 0;
      fakeProvider = await startFakeOpenAiCompatibleServer(async (request) => {
        if (request.method === "GET" && request.path === "/v1/models") {
          return { body: { data: [{ id: "fake-chat", object: "model", owned_by: "test" }] } };
        }
        if (request.method !== "POST" || request.path !== "/v1/chat/completions") {
          return { status: 404, body: { error: "Unknown fixture endpoint" } };
        }
        const requestBody = (request.body ?? {}) as Record<string, unknown>;
        if (requestBody.stream === true && JSON.stringify(requestBody).includes("LOCAL_CHILD_HOLD")) {
          childDispatches += 1;
          await held.promise;
        }
        return successfulStreamResponse(request, childDispatches ? "CHILD_OK" : "PARENT_OK");
      });
      configureGateway(fakeProvider.baseUrl);
      const app = await buildApp();
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/chat/sessions",
          headers: mutationHeaders("local-parent"),
          payload: { title: "Supervised local parent" },
        });
        expect(created.statusCode, created.body).toBe(201);
        const sessionId = created.json<{ sessionId: string }>().sessionId;
        const preflight = await routePreflight(app, sessionId, "Reply PARENT_OK", "local-parent-preflight");
        const sent = await app.inject({
          method: "POST",
          url: `/api/v1/chat/sessions/${sessionId}/agent-send/stream`,
          headers: mutationHeaders("local-parent-send"),
          payload: sendPayload("Reply PARENT_OK", preflight),
        });
        expect(sent.statusCode, sent.body).toBe(200);
        const thread = await readThread(app, sessionId);
        const parentRunId = thread.turns.find((turn) => turn.trace.status === "completed")?.trace.durable?.runId;
        expect(parentRunId).toBeTruthy();
        const parentRun = await readDurableRun(app, parentRunId!);
        expect(parentRun.payload).not.toHaveProperty("capabilityProfileId");
        const objective = "LOCAL_CHILD_HOLD: produce one short analysis";
        const suggestion = await app.inject({
          method: "POST",
          url: `/api/v1/chat/sessions/${sessionId}/delegate/suggest`,
          headers: mutationHeaders("local-suggest"),
          payload: { objective, roles: ["Researcher"], mode: "sequential" },
        });
        expect(suggestion.statusCode, suggestion.body).toBe(200);
        const payload = {
          objective,
          roles: ["Researcher"],
          mode: "sequential",
          policyRunId: parentRunId,
          suggestionId: suggestion.json<ChatDelegateSuggestResponse>().suggestion.suggestionId,
        };
        const acceptance = app.inject({
          method: "POST",
          url: `/api/v1/chat/sessions/${sessionId}/delegate/accept`,
          headers: mutationHeaders("local-accept"),
          payload,
        });
        void acceptance.catch(() => undefined);
        const watchers = await pollFor(
          async () => {
            const result = await app.inject({
              method: "GET",
              url: `/api/v1/durable/runs/${parentRunId}/child-watchers`,
              headers: operatorHeaders(),
            });
            expect(result.statusCode, result.body).toBe(200);
            const items = result.json<{ items: DurableChildWatcherRecord[] }>().items;
            if (items[0]) {
              const child = await readDurableRun(app, items[0].childRunId);
              if (["failed", "dead_letter", "cancelled"].includes(child.status))
                throw new Error(
                  "Child failed: " +
                    JSON.stringify({ runId: child.runId, status: child.status, lastError: child.lastError }),
                );
            }
            return items;
          },
          (items) => items.length === 1 && childDispatches === 1,
          "one bound child and one live provider dispatch",
        );
        const watcher = watchers[0]!;
        expect(watcher.source).toBe("chat_delegation");
        const runId = String(watcher.metadata.delegationRunId);
        const detail = await app.inject({
          method: "GET",
          url: `/api/v1/chat/sessions/${sessionId}/delegations/${runId}`,
          headers: operatorHeaders(),
        });
        expect(detail.statusCode, detail.body).toBe(200);
        const step = detail.json<ChatDelegationRunDetail>().steps[0]!;
        expect(step).toMatchObject({
          status: "running",
          durableRunId: watcher.childRunId,
          childSessionId: watcher.metadata.childSessionId,
        });
        const child = await readDurableRun(app, watcher.childRunId);
        expect(child.status).toBe("running");
        expect(child.payload).toMatchObject({
          version: "chat.turn.execute.v2",
          sessionId: step.childSessionId,
          turnId: watcher.metadata.childTurnId,
          request: { parentDelegationStepId: step.stepId, policyRunId: runId },
        });
        expect(child.payload).not.toHaveProperty("capabilityProfileId");
        expect(child.metadata).not.toHaveProperty("remoteWorkerChatContextSha256");
        for (const action of ["detach", "reattach"]) {
          const result = await app.inject({
            method: "POST",
            url: `/api/v1/durable/child-watchers/${watcher.watcherId}/${action}`,
            headers: mutationHeaders(`local-${action}`),
            payload: {},
          });
          expect(result.statusCode, result.body).toBe(200);
          expect((await readDurableRun(app, watcher.childRunId)).status).toBe("running");
          expect(childDispatches).toBe(1);
        }
        if (cancel) {
          const cancellation = await app.inject({
            method: "POST",
            url: `/api/v1/durable/runs/${child.runId}/cancel`,
            headers: mutationHeaders("local-cancel"),
            payload: {},
          });
          expect(cancellation.statusCode, cancellation.body).toBe(200);
          expect(cancellation.json<DurableRunRecord>()).toMatchObject({ runId: child.runId, status: "cancelled" });
        } else {
          releaseChild();
          releaseChild = undefined;
        }
        const accepted = await acceptance;
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(accepted.json<ChatDelegateResponse>()).toMatchObject({ runId, status: cancel ? "failed" : "completed" });
        if (cancel) {
          expect((await readDurableRun(app, child.runId)).status).toBe("cancelled");
          const cancelledDetail = await app.inject({
            method: "GET",
            url: `/api/v1/chat/sessions/${sessionId}/delegations/${runId}`,
            headers: operatorHeaders(),
          });
          expect(cancelledDetail.json<ChatDelegationRunDetail>().steps[0]).toMatchObject({
            stepId: step.stepId,
            childTurnId: step.childTurnId,
            durableRunId: child.runId,
            status: "cancelled",
          });
        }
        const replay = await app.inject({
          method: "POST",
          url: `/api/v1/chat/sessions/${sessionId}/delegate/accept`,
          headers: mutationHeaders("local-accept-replay"),
          payload,
        });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json<ChatDelegateResponse>()).toMatchObject({ runId, status: cancel ? "failed" : "completed" });
        expect(childDispatches).toBe(1);
        const other = await app.inject({
          method: "POST",
          url: "/api/v1/chat/sessions",
          headers: mutationHeaders("local-other"),
          payload: { title: "Foreign parent" },
        });
        const foreign = await app.inject({
          method: "POST",
          url: `/api/v1/chat/sessions/${other.json<{ sessionId: string }>().sessionId}/delegate/accept`,
          headers: mutationHeaders("local-foreign"),
          payload,
        });
        expect(foreign.statusCode, foreign.body).toBe(409);
        expect(childDispatches).toBe(1);
      } finally {
        releaseChild?.();
        releaseChild = undefined;
        await app.close();
      }
    },
  );
});

function successfulStreamResponse(request: FakeOpenAiRequest, content: string): FakeOpenAiResponse {
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (body.stream !== true) {
    return {
      body: {
        id: "local-delegation-completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        model: typeof body.model === "string" ? body.model : "fake-chat",
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
    };
  }
  return {
    sseFrames: [
      JSON.stringify({
        id: "local-delegation-stream",
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-local-delegation-"));
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
