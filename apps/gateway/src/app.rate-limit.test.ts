import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const TOKEN = "security-review-token-1234567890";
// Full Fastify app boots are import-heavy; under a loaded machine (verify lanes
// building concurrently) 45s was routinely exceeded. Generous by design — a real
// hang still fails, just later.
const RATE_LIMIT_TEST_TIMEOUT_MS = 120_000;
const ENV_KEYS = [
  "GATEWAY_HOST",
  "GOATCITADEL_ALLOWED_ORIGINS",
  "GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS",
  "GOATCITADEL_AUTH_MODE",
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_RATE_LIMIT_MAX_GENERAL",
  "GOATCITADEL_RATE_LIMIT_MAX_MUTATION",
  "GOATCITADEL_RATE_LIMIT_MAX_AUTH",
  "GOATCITADEL_RATE_LIMIT_MAX_SSE_CONNECT",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_ROOT_DIR",
] as const;

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];

describe("gateway route rate limits", () => {
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
      await removeTempRoot(root);
    }
  });

  it(
    "applies mutation rate limits to security-sensitive control-plane routes",
    async () => {
      configureRateLimitedGateway();
      const app = await buildApp();
      try {
        await expectMutationRouteToRateLimit(
          app,
          "/api/v1/llm/providers/openai-codex/oauth/device/start",
          "203.0.113.41",
        );
        await expectMutationRouteToRateLimit(app, "/api/v1/approvals", "203.0.113.42");
      } finally {
        await app.close();
      }
    },
    RATE_LIMIT_TEST_TIMEOUT_MS,
  );

  it(
    "applies explicit rate limits to Slack OAuth routes",
    async () => {
      configureRateLimitedGateway();
      const app = await buildApp();
      try {
        await expectRouteToRateLimit(app, "GET", "/api/v1/integrations/slack/oauth/status", "203.0.113.51", 200);
        await expectRouteToRateLimit(app, "POST", "/api/v1/integrations/slack/oauth/start", "203.0.113.52", 400);
        await expectRouteToRateLimit(app, "GET", "/api/v1/integrations/slack/oauth/callback", "203.0.113.53", 400);
        await expectRouteToRateLimit(app, "POST", "/api/v1/integrations/slack/oauth/disconnect", "203.0.113.54", 400);
      } finally {
        await app.close();
      }
    },
    RATE_LIMIT_TEST_TIMEOUT_MS,
  );

  it(
    "applies explicit rate limits to provider webhook routes",
    async () => {
      configureRateLimitedGateway();
      const app = await buildApp();
      try {
        await expectRouteToRateLimit(
          app,
          "POST",
          "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/slack/webhook",
          "203.0.113.61",
          404,
        );
        await expectRouteToRateLimit(
          app,
          "POST",
          "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/telegram/webhook",
          "203.0.113.62",
          404,
        );
        await expectRouteToRateLimit(
          app,
          "GET",
          "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/whatsapp/webhook",
          "203.0.113.63",
          404,
        );
        await expectRouteToRateLimit(
          app,
          "POST",
          "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/whatsapp/webhook",
          "203.0.113.64",
          404,
        );
        await expectRouteToRateLimit(
          app,
          "POST",
          "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/line/webhook",
          "203.0.113.65",
          404,
        );
        await expectRouteToRateLimit(
          app,
          "POST",
          "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/nextcloud-talk/webhook",
          "203.0.113.66",
          404,
        );
      } finally {
        await app.close();
      }
    },
    RATE_LIMIT_TEST_TIMEOUT_MS,
  );
});

function configureRateLimitedGateway(): void {
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "true";
  process.env.GOATCITADEL_RATE_LIMIT_MAX_GENERAL = "2";
  process.env.GOATCITADEL_RATE_LIMIT_MAX_MUTATION = "2";
  process.env.GOATCITADEL_RATE_LIMIT_MAX_AUTH = "20";
  process.env.GOATCITADEL_RATE_LIMIT_MAX_SSE_CONNECT = "20";
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_ROOT_DIR = createIsolatedConfigRoot();
}

function createIsolatedConfigRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-rate-limit-"));
  const repoRoot = path.resolve(process.cwd(), "../..");
  fs.cpSync(path.join(repoRoot, "config"), path.join(root, "config"), { recursive: true });
  tempRoots.push(root);
  return root;
}

async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.promises.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetriableWindowsCleanupError(error) || attempt === 4) {
        throw error;
      }
      await delay(100 * (attempt + 1));
    }
  }
}

function isRetriableWindowsCleanupError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code !== undefined &&
    ["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))
  );
}

async function expectMutationRouteToRateLimit(app: Awaited<ReturnType<typeof buildApp>>, url: string, ip: string) {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url,
      remoteAddress: ip,
      headers: {
        authorization: `Bearer ${TOKEN}`,
      },
    });
    statuses.push(response.statusCode);
  }

  expect(statuses).toEqual([400, 400, 429]);
}

async function expectRouteToRateLimit(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "GET" | "POST",
  url: string,
  ip: string,
  expectedInitialStatus: number,
) {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await app.inject({
      method,
      url,
      remoteAddress: ip,
      headers: {
        authorization: `Bearer ${TOKEN}`,
      },
      ...(method === "POST" ? { payload: {} } : {}),
    });
    statuses.push(response.statusCode);
  }

  expect(statuses).toEqual([expectedInitialStatus, expectedInitialStatus, 429]);
}
