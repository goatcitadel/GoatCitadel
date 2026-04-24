import { afterEach, describe, expect, it } from "vitest";
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
