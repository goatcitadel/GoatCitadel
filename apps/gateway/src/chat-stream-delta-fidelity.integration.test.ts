import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RoutingPreflightResult } from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiRequest,
  type FakeOpenAiResponse,
  type FakeOpenAiServer,
} from "./test/fake-openai-server.js";

const TOKEN = "chat-stream-delta-fidelity-token-1234567890";
const REPLY = "Verification stub reply.";
const ENV_KEYS = [
  "GATEWAY_HOST",
  "NODE_ENV",
  "GOATCITADEL_ALLOWED_ORIGINS",
  "GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS",
  "GOATCITADEL_AUTH_MODE",
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_ROOT_DIR",
] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];
let fakeProvider: FakeOpenAiServer | undefined;

interface SseEvent {
  type?: string;
  delta?: string;
  content?: string;
  repaired?: boolean;
}

describe("Chat stream delta fidelity", { timeout: 180_000 }, () => {
  afterEach(async () => {
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

  it("streams every final-content character as deltas when the provider's finish chunk carries text", async () => {
    fakeProvider = await startFakeOpenAiCompatibleServer(async (request) => {
      if (request.method === "GET" && request.path === "/v1/models") {
        return { body: { data: [{ id: "fake-chat", object: "model", owned_by: "goatcitadel-test" }] } };
      }
      if (request.method === "POST" && request.path === "/v1/chat/completions") {
        return splitFinishChunkStreamResponse(request, REPLY);
      }
      return { status: 404, body: { error: { message: `No fake route for ${request.method} ${request.path}` } } };
    });
    configureGateway(fakeProvider.baseUrl);
    const app = await buildApp();
    try {
      const sessionResponse = await app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions",
        headers: mutationHeaders("delta-fidelity-session"),
        payload: { title: "Delta fidelity" },
      });
      expect(sessionResponse.statusCode, sessionResponse.body).toBe(201);
      const sessionId = (sessionResponse.json() as { sessionId: string }).sessionId;
      const prompt = "Reply with the verification stub.";
      const preflight = await routePreflight(app, sessionId, prompt);

      const stream = await app.inject({
        method: "POST",
        url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send/stream`,
        headers: mutationHeaders("delta-fidelity-send"),
        payload: {
          content: prompt,
          providerId: preflight.decision.effectiveProviderId,
          model: preflight.decision.effectiveModel,
          subagentPolicy: "off",
          routeDecision: preflight.decision,
        },
      });
      expect(stream.statusCode, stream.body.slice(0, 2_000)).toBe(200);

      const events = parseSseEvents(stream.body);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      const messageDone = events.filter((event) => event.type === "message_done");
      expect(messageDone).toHaveLength(1);
      expect(messageDone[0]).toMatchObject({ content: REPLY, repaired: false });
      const deltaText = events
        .filter((event) => event.type === "delta")
        .map((event) => event.delta ?? "")
        .join("");
      expect(deltaText).toBe(messageDone[0]?.content);
      const doneIndex = events.findIndex((event) => event.type === "message_done");
      expect(events.slice(doneIndex).some((event) => event.type === "delta")).toBe(false);
    } finally {
      await app.close();
    }
  });
});

// Mirrors the deterministic verification stub: the second half of the reply
// arrives in the same chunk as finish_reason, a legal OpenAI-compatible shape.
function splitFinishChunkStreamResponse(request: FakeOpenAiRequest, content: string): FakeOpenAiResponse {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const model = typeof body.model === "string" ? body.model : "fake-chat";
  if (body.stream !== true) {
    return {
      body: {
        id: "delta-fidelity-completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        model,
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      },
    };
  }
  const splitAt = Math.ceil(content.length / 2);
  return {
    sseFrames: [
      JSON.stringify({
        id: "delta-fidelity-stream",
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: content.slice(0, splitAt) } }],
      }),
      JSON.stringify({
        id: "delta-fidelity-stream",
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { content: content.slice(splitAt) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }),
      "[DONE]",
    ],
  };
}

function parseSseEvents(body: string): SseEvent[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n"),
    )
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as SseEvent);
}

async function routePreflight(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
  content: string,
): Promise<RoutingPreflightResult> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/route-preflight`,
    headers: mutationHeaders("delta-fidelity-preflight"),
    payload: { action: "send", content, subagentPolicy: "off" },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json() as RoutingPreflightResult;
  expect(result.blockedReason).toBeUndefined();
  return result;
}

function mutationHeaders(idempotencyKey: string): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "idempotency-key": idempotencyKey };
}

function configureGateway(providerBaseUrl: string): void {
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.NODE_ENV = "test";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_ROOT_DIR = createIsolatedConfigRoot(providerBaseUrl);
}

function createIsolatedConfigRoot(providerBaseUrl: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-chat-delta-fidelity-"));
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
  const baseConfigPath = path.join(root, "config", "goatcitadel.example.json");
  const unifiedConfig = JSON.parse(fs.readFileSync(baseConfigPath, "utf8")) as Record<string, unknown>;
  unifiedConfig.llm = llmConfig;
  fs.writeFileSync(
    path.join(root, "config", "goatcitadel.json"),
    `${JSON.stringify(unifiedConfig, null, 2)}\n`,
    "utf8",
  );
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
