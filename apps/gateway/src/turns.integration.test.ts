import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { startFakeOpenAiCompatibleServer, type FakeOpenAiServer } from "./test/fake-openai-server.js";

// Full-stack smoke for POST /api/v1/turns/complete (the MatterGoat turn contract).
// Boots the REAL gateway — operator-bearer auth, the idempotency plugin, route
// access, and the handler itself — rather than a bare route, so it verifies the
// endpoint is genuinely wired into the app. The isolated runtime config provides
// the local test provider, so a fully-authorized, well-formed turn reaches the
// handler and returns the MatterGoat completion envelope end to end.

const TOKEN = "turns-smoke-token-1234567890";
const ENV_KEYS = [
  "GATEWAY_HOST",
  "GOATCITADEL_ALLOWED_ORIGINS",
  "GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS",
  "GOATCITADEL_AUTH_MODE",
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_ROOT_DIR",
] as const;

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];
let fakeProvider: FakeOpenAiServer | undefined;

const validBody = {
  session_id: "mg_session_smoke",
  turn_id: "mg_turn_smoke",
  agent_ref: "agent_smoke",
  operation: "mattergoat_collaborate",
  user_ref: "user_smoke",
  channel_ref: "chan_smoke",
  messages: [
    { role: "system", message: "system prompt", file_ids: [] },
    { role: "user", author_ref: "user_smoke", message: "alice: why is this failing?", file_ids: [] },
  ],
};

describe("turns:complete full-stack smoke", () => {
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await fakeProvider?.close();
    fakeProvider = undefined;
  });

  it("enforces auth + idempotency and routes a well-formed turn to the handler", async () => {
    fakeProvider = await startFakeOpenAiCompatibleServer();
    configureGateway(fakeProvider.baseUrl);
    const app = await buildApp();
    try {
      // 1. No bearer token → the auth plugin rejects (operator route).
      const unauthorized = await app.inject({
        method: "POST",
        url: "/api/v1/turns/complete",
        headers: { "idempotency-key": "k1" },
        payload: validBody,
      });
      expect(unauthorized.statusCode).toBe(401);

      // 2. Authorized but missing Idempotency-Key → the idempotency plugin rejects.
      const noIdempotency = await app.inject({
        method: "POST",
        url: "/api/v1/turns/complete",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: validBody,
      });
      expect(noIdempotency.statusCode).toBe(400);

      // 3. Authorized + idempotency key + invalid body → zod validation rejects.
      const invalidBody = await app.inject({
        method: "POST",
        url: "/api/v1/turns/complete",
        headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "k2" },
        payload: { session_id: "only" },
      });
      expect(invalidBody.statusCode).toBe(400);

      // 4. Fully authorized, well-formed turn → passes auth + idempotency + routing
      // and reaches the handler, returning the MatterGoat completion envelope.
      const routed = await app.inject({
        method: "POST",
        url: "/api/v1/turns/complete",
        headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "k3" },
        payload: validBody,
      });
      expect(routed.statusCode).not.toBe(401); // passed auth
      expect(routed.statusCode).not.toBe(404); // route is registered
      expect(routed.statusCode).not.toBe(400); // passed validation + idempotency
      expect(routed.statusCode).toBe(200);
      expect(routed.json()).toMatchObject({
        message: expect.any(String),
        markers: expect.any(Array),
        needs_approval: expect.any(Boolean),
        provider: expect.any(String),
        model: expect.any(String),
        run_id: expect.any(String),
        usage: {
          input_tokens: expect.any(Number),
          output_tokens: expect.any(Number),
        },
      });
    } finally {
      await app.close();
    }
  }, 90_000);
});

function configureGateway(providerBaseUrl: string): void {
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_ROOT_DIR = createIsolatedConfigRoot(providerBaseUrl);
}

function createIsolatedConfigRoot(providerBaseUrl: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-turns-smoke-"));
  const repoRoot = path.resolve(process.cwd(), "../..");
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
  // Read the base from the tracked example template rather than the runtime
  // config/goatcitadel.json, which is gitignored and absent in a fresh checkout
  // (it is synced at gateway boot). Using the example keeps this hermetic and
  // identical between local and CI.
  const unifiedConfigPath = path.join(root, "config", "goatcitadel.json");
  const baseConfigPath = fs.existsSync(unifiedConfigPath)
    ? unifiedConfigPath
    : path.join(root, "config", "goatcitadel.example.json");
  const unifiedConfig = JSON.parse(fs.readFileSync(baseConfigPath, "utf8")) as Record<string, unknown>;
  unifiedConfig.llm = llmConfig;
  fs.writeFileSync(unifiedConfigPath, `${JSON.stringify(unifiedConfig, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(root, "config", "llm-providers.json"), `${JSON.stringify(llmConfig, null, 2)}\n`, "utf8");
  tempRoots.push(root);
  return root;
}
