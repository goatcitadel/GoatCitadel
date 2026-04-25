import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const TOKEN = "security-review-token-1234567890";
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
] as const;

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

describe("gateway route rate limits", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("applies mutation rate limits to security-sensitive control-plane routes", async () => {
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
  });
});

function configureRateLimitedGateway(): void {
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "true";
  process.env.GOATCITADEL_RATE_LIMIT_MAX_GENERAL = "20";
  process.env.GOATCITADEL_RATE_LIMIT_MAX_MUTATION = "2";
  process.env.GOATCITADEL_RATE_LIMIT_MAX_AUTH = "20";
  process.env.GOATCITADEL_RATE_LIMIT_MAX_SSE_CONNECT = "20";
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
