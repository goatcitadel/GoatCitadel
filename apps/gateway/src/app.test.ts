import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { __internal, buildApp } from "./app.js";
import type { GatewayRuntimeConfig } from "./config.js";
import { assertDeploymentProfileStartupSafety } from "./deployment-profile-guard.js";

// Anchor on this file's location, not process.cwd(), so the diagnostics config
// fixture resolves regardless of where the test runner is launched from.
// src -> repo root is three levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("assertDeploymentProfileStartupSafety", () => {
  const originalAllowedOrigins = process.env.GOATCITADEL_ALLOWED_ORIGINS;
  const originalTailnet = process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS;
  const originalOverride = process.env.GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY;

  afterEach(() => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.GOATCITADEL_ALLOWED_ORIGINS;
    } else {
      process.env.GOATCITADEL_ALLOWED_ORIGINS = originalAllowedOrigins;
    }
    if (originalTailnet === undefined) {
      delete process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS;
    } else {
      process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = originalTailnet;
    }
    if (originalOverride === undefined) {
      delete process.env.GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY;
    } else {
      process.env.GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY = originalOverride;
    }
  });

  it("rejects invalid remote_hardened posture", () => {
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
    const config = {
      assistant: {
        deploymentProfile: "remote_hardened",
        auth: {
          mode: "none",
          allowLoopbackBypass: true,
        },
      },
      toolPolicy: {
        sandbox: {
          networkAllowlist: [],
        },
      },
    } as unknown as GatewayRuntimeConfig;

    expect(() => assertDeploymentProfileStartupSafety(config, new Set(["http://localhost:5173"]))).toThrow(
      /Invalid remote_hardened deployment profile/i,
    );
  });

  it("accepts hardened posture with auth, explicit origins, and host allowlist", () => {
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "https://citadel.example.com";
    const config = {
      assistant: {
        deploymentProfile: "remote_hardened",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
      },
      toolPolicy: {
        sandbox: {
          networkAllowlist: ["api.openai.com"],
        },
      },
    } as unknown as GatewayRuntimeConfig;

    expect(() => assertDeploymentProfileStartupSafety(config, new Set(["https://citadel.example.com"]))).not.toThrow();
  });

  it("rejects remote_hardened startup when persisted tool posture bypasses approvals", () => {
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "https://citadel.example.com";
    const config = {
      assistant: {
        deploymentProfile: "remote_hardened",
        toolApprovalMode: "bypass",
        defaultToolProfile: "danger",
        auth: {
          mode: "token",
          allowLoopbackBypass: false,
        },
      },
      toolPolicy: {
        tools: {
          approvalMode: "bypass",
          profile: "danger",
        },
        sandbox: {
          networkAllowlist: ["api.openai.com"],
        },
      },
    } as unknown as GatewayRuntimeConfig;

    expect(() => assertDeploymentProfileStartupSafety(config, new Set(["https://citadel.example.com"]))).toThrow(
      /remote_hardened disables approval bypass/,
    );
  });

  it("rejects auth-none exposure outside local loopback defaults", () => {
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "https://citadel.example.com";
    process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "true";
    const config = {
      assistant: {
        deploymentProfile: "trusted_local",
        auth: {
          mode: "none",
          allowLoopbackBypass: false,
        },
      },
      toolPolicy: {
        sandbox: {
          networkAllowlist: ["api.openai.com"],
        },
      },
    } as unknown as GatewayRuntimeConfig;

    expect(() =>
      assertDeploymentProfileStartupSafety(config, new Set(["https://citadel.example.com"]), {
        bindHost: "0.0.0.0",
        tailnetDevOriginsEnabled: true,
      }),
    ).toThrow(/Unsafe auth-none exposure blocked/i);
  });

  it("rejects auth-none local dev when tailnet or private dev origins are enabled", () => {
    delete process.env.GOATCITADEL_ALLOWED_ORIGINS;
    delete process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS;
    const config = {
      assistant: {
        deploymentProfile: "local_dev",
        auth: {
          mode: "none",
          allowLoopbackBypass: false,
        },
      },
      toolPolicy: {
        sandbox: {
          networkAllowlist: ["api.openai.com"],
        },
      },
    } as unknown as GatewayRuntimeConfig;

    expect(() =>
      assertDeploymentProfileStartupSafety(config, new Set(["http://localhost:5173"]), {
        bindHost: "127.0.0.1",
        tailnetDevOriginsEnabled: true,
      }),
    ).toThrow(/enabled tailnet\/private dev origins/i);
  });

  it("allows the explicit auth-none local-only override", () => {
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "https://citadel.example.com";
    process.env.GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY = "true";
    const config = {
      assistant: {
        deploymentProfile: "trusted_local",
        auth: {
          mode: "none",
          allowLoopbackBypass: false,
        },
      },
      toolPolicy: {
        sandbox: {
          networkAllowlist: ["api.openai.com"],
        },
      },
    } as unknown as GatewayRuntimeConfig;

    expect(() =>
      assertDeploymentProfileStartupSafety(config, new Set(["https://citadel.example.com"]), {
        bindHost: "0.0.0.0",
      }),
    ).not.toThrow();
  });
});

describe("request diagnostic severity", () => {
  it.each([
    ["GET", "/api/v1/dashboard/state", 401, true],
    ["GET", "/api/v1/onboarding/startup", 401, true],
    ["PUT", "/api/v1/notifications/presence", 401, true],
    ["GET", "/health", 503, false],
  ])(
    "keeps expected auth and readiness control responses at debug level",
    (method, route, statusCode, authRejected) => {
      expect(__internal.classifyRequestFinishDiagnosticLevel(method, route, statusCode, authRejected)).toBe("debug");
    },
  );

  it.each([
    ["POST", "/api/v1/integrations/webhook", 401, false, "warn"],
    ["GET", "/api/v1/chat/sessions", 401, false, "warn"],
    ["GET", "/api/v1/observe/health", 500, false, "error"],
    ["GET", "/api/v1/dashboard/state", 503, false, "error"],
  ])("preserves actionable %s %s %i responses as %s", (method, route, statusCode, authRejected, expected) => {
    expect(__internal.classifyRequestFinishDiagnosticLevel(method, route, statusCode, authRejected)).toBe(expected);
  });
});

describe("gateway app config helpers", () => {
  const originalAllowedOrigins = process.env.GOATCITADEL_ALLOWED_ORIGINS;

  afterEach(() => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.GOATCITADEL_ALLOWED_ORIGINS;
    } else {
      process.env.GOATCITADEL_ALLOWED_ORIGINS = originalAllowedOrigins;
    }
  });

  it("rejects invalid CORS origin environment entries", () => {
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "example.com,ftp://bad.example";

    expect(() => __internal.resolveAllowedOrigins()).toThrow(/Invalid origin in GOATCITADEL_ALLOWED_ORIGINS/);
  });

  it("normalizes valid CORS origins without accepting paths or credentials", () => {
    expect(__internal.normalizeConfiguredOrigin("https://example.com/", "TEST_ORIGIN")).toBe("https://example.com");
    expect(() => __internal.normalizeConfiguredOrigin("https://example.com/app", "TEST_ORIGIN")).toThrow(
      /Invalid origin/,
    );
    expect(() => __internal.normalizeConfiguredOrigin("https://user@example.com", "TEST_ORIGIN")).toThrow(
      /Invalid origin/,
    );
  });

  it("allowlists common loopback IP representations for rate limiting", () => {
    expect(__internal.isLoopbackRateLimitAllowlisted("127.0.0.1")).toBe(true);
    expect(__internal.isLoopbackRateLimitAllowlisted("127.12.34.56")).toBe(true);
    expect(__internal.isLoopbackRateLimitAllowlisted("::1%lo0")).toBe(true);
    expect(__internal.isLoopbackRateLimitAllowlisted("::FFFF:127.0.0.1")).toBe(true);
    expect(__internal.isLoopbackRateLimitAllowlisted("::ffff:7f00:1")).toBe(true);
    expect(__internal.isLoopbackRateLimitAllowlisted("192.168.1.5")).toBe(false);
  });

  it("calculates request durations only when a start timestamp is present", () => {
    expect(__internal.calculateRequestDurationMs({})).toBeUndefined();
    expect(__internal.calculateRequestDurationMs({ requestStartedAtMs: performance.now() - 5 })).toBeGreaterThanOrEqual(
      0,
    );
  });

  it("uses the SSE rate-limit bucket for realtime and dev diagnostics streams only", () => {
    expect(__internal.classifyRateLimitBucket("/api/v1/events/stream", "GET")).toBe("sse");
    expect(__internal.classifyRateLimitBucket("/api/v1/dev/diagnostics/stream", "GET")).toBe("sse");
    expect(__internal.classifyRateLimitBucket("/api/v1/chat/sessions/session-1/messages/stream", "POST")).toBe(
      "mutation",
    );
    expect(
      __internal.classifyRateLimitBucket("/api/v1/integrations/connections/:connectionId/:channel/inbound", "POST"),
    ).toBe("webhook_ingress");
    expect(
      __internal.classifyRateLimitBucket("/api/v1/integrations/connections/:connectionId/telegram/webhook", "POST"),
    ).toBe("webhook_ingress");
    expect(
      __internal.classifyRateLimitBucket("/api/v1/integrations/connections/:connectionId/whatsapp/webhook", "GET"),
    ).toBe("general");
  });

  it("does not allowlist loopback-looking rate-limit keys with proxy provenance", () => {
    expect(
      __internal.isLoopbackRateLimitAllowlisted("127.0.0.1", {
        headers: { "x-forwarded-for": "203.0.113.5" },
        ips: [],
      }),
    ).toBe(false);
    expect(
      __internal.isLoopbackRateLimitAllowlisted("::1", {
        headers: { forwarded: "for=203.0.113.5" },
        ips: ["127.0.0.1"],
      }),
    ).toBe(false);
    expect(
      __internal.isLoopbackRateLimitAllowlisted("::ffff:127.0.0.1", {
        headers: {},
        ips: ["127.0.0.1", "203.0.113.5"],
      }),
    ).toBe(false);
    expect(
      __internal.isLoopbackRateLimitAllowlisted("127.0.0.1", {
        headers: { "x-real-ip": "" },
        ips: [],
      }),
    ).toBe(false);
    expect(
      __internal.isLoopbackRateLimitAllowlisted("127.0.0.1", {
        headers: { "x-forwarded-for": "" },
        ips: [],
      }),
    ).toBe(false);
  });
});

describe("applyBaselineSecurityHeaders (GWROUTES-001)", () => {
  function createFakeReply(initialHeaders: Record<string, string> = {}) {
    const headers = new Map<string, string>(
      Object.entries(initialHeaders).map(([name, value]) => [name.toLowerCase(), value]),
    );
    return {
      headers,
      getHeader(name: string) {
        return headers.get(name.toLowerCase());
      },
      header(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
    };
  }

  it("sets the baseline CSP and unconditional security headers on a fresh response", () => {
    const reply = createFakeReply();

    __internal.applyBaselineSecurityHeaders(reply, { isNonLoopbackBind: false });

    expect(reply.getHeader("Content-Security-Policy")).toBe(__internal.BASELINE_CONTENT_SECURITY_POLICY);
    expect(reply.getHeader("Content-Security-Policy")).toContain("script-src 'self'");
    expect(reply.getHeader("X-Content-Type-Options")).toBe("nosniff");
    expect(reply.getHeader("X-Frame-Options")).toBe("DENY");
    expect(reply.getHeader("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(reply.getHeader("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(reply.getHeader("Strict-Transport-Security")).toBeUndefined();
  });

  it("does NOT overwrite a route-set Content-Security-Policy (preview sandbox survives)", () => {
    const routeCsp =
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'none'; style-src 'self'; img-src data: blob:; font-src 'none'; connect-src 'none'";
    const reply = createFakeReply({ "Content-Security-Policy": routeCsp });

    __internal.applyBaselineSecurityHeaders(reply, { isNonLoopbackBind: false });

    // The route's hardened CSP must win over the baseline.
    expect(reply.getHeader("Content-Security-Policy")).toBe(routeCsp);
    expect(reply.getHeader("Content-Security-Policy")).toContain("script-src 'none'");
    expect(reply.getHeader("Content-Security-Policy")).not.toBe(__internal.BASELINE_CONTENT_SECURITY_POLICY);
    // Other baseline headers are still applied unconditionally.
    expect(reply.getHeader("X-Content-Type-Options")).toBe("nosniff");
  });

  it("treats a blank route CSP as absent and falls back to the baseline", () => {
    const reply = createFakeReply({ "Content-Security-Policy": "   " });

    __internal.applyBaselineSecurityHeaders(reply, { isNonLoopbackBind: false });

    expect(reply.getHeader("Content-Security-Policy")).toBe(__internal.BASELINE_CONTENT_SECURITY_POLICY);
  });

  it("adds HSTS only on non-loopback binds", () => {
    const reply = createFakeReply();

    __internal.applyBaselineSecurityHeaders(reply, { isNonLoopbackBind: true });

    expect(reply.getHeader("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  });
});

// 120s for every test here: each boots the full Fastify app (import-heavy);
// under a loaded machine (verify lanes building concurrently) the global 15s
// testTimeout is routinely exceeded. Generous by design — real hangs still fail.
describe("gateway request diagnostics", { timeout: 120_000 }, () => {
  const envKeys = [
    "GATEWAY_HOST",
    "GOATCITADEL_ALLOWED_ORIGINS",
    "GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS",
    "GOATCITADEL_AUTH_MODE",
    "GOATCITADEL_DATABASE_DRIVER",
    "GOATCITADEL_DEV_DIAGNOSTICS_ENABLED",
    "GOATCITADEL_RATE_LIMIT_ENABLED",
    "GOATCITADEL_ROOT_DIR",
  ] as const;
  const originalEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const key of envKeys) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    for (const root of tempRoots.splice(0)) {
      let attempts = 5;
      while (attempts > 0) {
        try {
          await fs.promises.rm(root, { recursive: true, force: true });
          break;
        } catch (error) {
          attempts--;
          if (attempts === 0) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  });

  it("records request finish diagnostics with duration and correlation evidence", async () => {
    configureDiagnosticsGateway(tempRoots);
    const app = await buildApp();
    try {
      const correlationId = "diag-corr-1";
      const health = await app.inject({
        method: "GET",
        url: "/health",
        headers: {
          "x-goatcitadel-correlation-id": correlationId,
        },
      });
      expect(health.statusCode).toBe(200);

      const diagnostics = await app.inject({
        method: "GET",
        url: "/api/v1/dev/diagnostics?category=api&limit=20",
      });
      expect(diagnostics.statusCode).toBe(200);
      const body = diagnostics.json() as {
        items: Array<{
          event: string;
          route?: string;
          correlationId?: string;
          durationMs?: number;
          context?: Record<string, unknown>;
        }>;
      };
      const finish = body.items.find(
        (item) => item.event === "request.finish" && item.route === "/health" && item.correlationId === correlationId,
      );

      expect(finish).toBeDefined();
      expect(finish?.durationMs).toEqual(expect.any(Number));
      expect(finish?.durationMs).toBeGreaterThanOrEqual(0);
      expect(finish?.context).toMatchObject({
        method: "GET",
        statusCode: 200,
        durationMs: finish?.durationMs,
      });
    } finally {
      await app.close();
    }
  }, 45_000);

  it("strips query strings from recorded request diagnostics", async () => {
    configureDiagnosticsGateway(tempRoots);
    const app = await buildApp();
    try {
      const correlationId = "diag-corr-token";
      const health = await app.inject({
        method: "GET",
        url: "/health?access_token=secret-token&state=ok",
        headers: {
          "x-goatcitadel-correlation-id": correlationId,
        },
      });
      expect(health.statusCode).toBe(200);

      const diagnostics = await app.inject({
        method: "GET",
        url: "/api/v1/dev/diagnostics?category=api&limit=20",
      });
      expect(diagnostics.statusCode).toBe(200);
      const bodyText = diagnostics.body;
      expect(bodyText).toContain("/health");
      expect(bodyText).not.toContain("secret-token");
      expect(bodyText).not.toContain("access_token");
      expect(bodyText).not.toContain("state=ok");
    } finally {
      await app.close();
    }
  }, 45_000);

  it("rejects a disallowed browser origin before auth-none can authorize the control plane", async () => {
    configureDiagnosticsGateway(tempRoots);
    const app = await buildApp();
    try {
      const allowed = await app.inject({
        method: "GET",
        url: "/api/v1/settings",
        headers: { origin: "http://localhost:5173" },
      });
      const disallowed = await app.inject({
        method: "GET",
        url: "/api/v1/settings",
        headers: { origin: "https://attacker.example" },
      });

      expect(allowed.statusCode).toBe(200);
      expect(disallowed.statusCode).toBeGreaterThanOrEqual(400);
      expect(disallowed.body).toContain("Origin not allowed by CORS policy");
      expect(disallowed.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  }, 45_000);

  it("projects credential-bearing error bodies globally without changing successful token issuance", async () => {
    configureDiagnosticsGateway(tempRoots);
    const app = await buildApp();
    app.get(
      "/__test/public-error-projection",
      { config: { goatcitadelRouteAccessClass: "public" } },
      async (_request, reply) =>
        reply.code(400).send({
          error: "Provider failed with Authorization: Bearer app-error-secret",
          details: {
            webhookUrl: "https://hooks.slack.com/services/T000/B000/app-path-secret",
          },
          validation: { fieldErrors: { token: ["Required"] } },
        }),
    );
    app.get("/__test/successful-token-issuance", { config: { goatcitadelRouteAccessClass: "public" } }, async () => ({
      token: `grat_${"a".repeat(43)}`,
    }));
    try {
      const failed = await app.inject({ method: "GET", url: "/__test/public-error-projection" });
      const succeeded = await app.inject({ method: "GET", url: "/__test/successful-token-issuance" });

      expect(failed.statusCode).toBe(400);
      expect(failed.body).not.toContain("app-error-secret");
      expect(failed.body).not.toContain("app-path-secret");
      expect(failed.json()).toMatchObject({
        error: "Provider failed with Authorization: [REDACTED]",
        details: { webhookUrl: "[REDACTED]" },
        validation: { fieldErrors: { token: ["Required"] } },
      });
      expect(succeeded.statusCode).toBe(200);
      expect(succeeded.body).toContain("grat_");
    } finally {
      await app.close();
    }
  }, 45_000);
});

function configureDiagnosticsGateway(tempRoots: string[]): void {
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "none";
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_DEV_DIAGNOSTICS_ENABLED = "true";
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_ROOT_DIR = createDiagnosticsConfigRoot(tempRoots);
}

function createDiagnosticsConfigRoot(tempRoots: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-diagnostics-"));
  fs.cpSync(path.join(REPO_ROOT, "config"), path.join(root, "config"), { recursive: true });
  tempRoots.push(root);
  return root;
}
