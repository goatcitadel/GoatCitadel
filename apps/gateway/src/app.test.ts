import { afterEach, describe, expect, it } from "vitest";
import { __internal } from "./app.js";
import type { GatewayRuntimeConfig } from "./config.js";
import { assertDeploymentProfileStartupSafety } from "./deployment-profile-guard.js";

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
});
