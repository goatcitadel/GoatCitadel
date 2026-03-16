import { afterEach, describe, expect, it } from "vitest";
import type { GatewayRuntimeConfig } from "./config.js";
import { assertDeploymentProfileStartupSafety } from "./deployment-profile-guard.js";

describe("assertDeploymentProfileStartupSafety", () => {
  const originalAllowedOrigins = process.env.GOATCITADEL_ALLOWED_ORIGINS;

  afterEach(() => {
    if (originalAllowedOrigins === undefined) {
      delete process.env.GOATCITADEL_ALLOWED_ORIGINS;
      return;
    }
    process.env.GOATCITADEL_ALLOWED_ORIGINS = originalAllowedOrigins;
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

    expect(() =>
      assertDeploymentProfileStartupSafety(config, new Set(["https://citadel.example.com"])),
    ).not.toThrow();
  });
});
