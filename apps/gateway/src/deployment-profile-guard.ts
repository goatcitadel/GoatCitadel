import type { GatewayRuntimeConfig } from "./config.js";
import { isLoopbackDevOrigin } from "./cors-origin-guard.js";

export function assertDeploymentProfileStartupSafety(
  config: GatewayRuntimeConfig,
  allowedOrigins: Set<string>,
): void {
  if (config.assistant.deploymentProfile !== "remote_hardened") {
    return;
  }

  const errors: string[] = [];
  if (config.assistant.auth.mode === "none") {
    errors.push("remote_hardened requires token or basic auth; auth.mode=none is not allowed.");
  }
  if (config.assistant.auth.allowLoopbackBypass) {
    errors.push("remote_hardened requires allowLoopbackBypass=false.");
  }

  const explicitOrigins = process.env.GOATCITADEL_ALLOWED_ORIGINS?.trim();
  const hasNonLoopbackOrigin = [...allowedOrigins].some((origin) => !isLoopbackDevOrigin(origin));
  if (!explicitOrigins || !hasNonLoopbackOrigin) {
    errors.push("remote_hardened requires explicit non-loopback GOATCITADEL_ALLOWED_ORIGINS.");
  }

  const networkAllowlist = config.toolPolicy.sandbox.networkAllowlist
    .map((host) => host.trim())
    .filter(Boolean);
  if (networkAllowlist.length === 0) {
    errors.push("remote_hardened requires a non-empty outbound host allowlist.");
  }
  if (networkAllowlist.some((host) => host === "*")) {
    errors.push("remote_hardened forbids wildcard outbound host allowlists.");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid remote_hardened deployment profile: ${errors.join(" ")}`);
  }
}
