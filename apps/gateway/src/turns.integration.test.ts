import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

// Full-stack smoke for POST /api/v1/turns/complete (the MatterGoat turn contract).
// Boots the REAL gateway — operator-bearer auth, the idempotency plugin, route
// access, and the handler itself — rather than a bare route, so it verifies the
// endpoint is genuinely wired into the app. The LLM provider is intentionally
// absent (no API key here), so a fully-authorized, well-formed turn reaches the
// handler and fails only at the provider call (5xx) — which is exactly the signal
// that everything up to the model invocation works end to end.

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
  });

  it("enforces auth + idempotency and routes a well-formed turn to the handler", async () => {
    configureGateway();
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
      // and reaches the handler. With no LLM provider configured the model call
      // fails (5xx) — proving everything up to the provider invocation is wired.
      const routed = await app.inject({
        method: "POST",
        url: "/api/v1/turns/complete",
        headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "k3" },
        payload: validBody,
      });
      expect(routed.statusCode).not.toBe(401); // passed auth
      expect(routed.statusCode).not.toBe(404); // route is registered
      expect(routed.statusCode).not.toBe(400); // passed validation + idempotency
      expect(routed.statusCode).toBeGreaterThanOrEqual(500); // reached handler; provider absent
    } finally {
      await app.close();
    }
  }, 45_000);
});

function configureGateway(): void {
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_ROOT_DIR = createIsolatedConfigRoot();
}

function createIsolatedConfigRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-turns-smoke-"));
  const repoRoot = path.resolve(process.cwd(), "../..");
  fs.cpSync(path.join(repoRoot, "config"), path.join(root, "config"), { recursive: true });
  tempRoots.push(root);
  return root;
}
