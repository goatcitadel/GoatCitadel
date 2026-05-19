import type { GatewayRuntimeConfig } from "./config.js";
import { isLoopbackDevOrigin } from "./cors-origin-guard.js";
import { INSECURE_LOCAL_ONLY_OVERRIDE_ENV, isLoopbackHost, resolveAllowUnauthNetwork } from "./startup-guard.js";

export function assertDeploymentProfileStartupSafety(
  config: GatewayRuntimeConfig,
  allowedOrigins: Set<string>,
  options: { bindHost?: string; tailnetDevOriginsEnabled?: boolean } = {},
): void {
  if (config.assistant.deploymentProfile !== "remote_hardened") {
    assertAuthNoneExposureSafety(config, allowedOrigins, options);
    return;
  }

  const errors: string[] = [];
  if (config.assistant.auth.mode === "none") {
    errors.push("remote_hardened requires token or basic auth; auth.mode=none is not allowed.");
  }
  if (config.assistant.auth.allowLoopbackBypass) {
    errors.push("remote_hardened requires allowLoopbackBypass=false.");
  }
  const approvalMode = config.toolPolicy.tools?.approvalMode ?? config.assistant.toolApprovalMode;
  if (
    approvalMode === "bypass" ||
    config.assistant.defaultToolProfile === "danger" ||
    config.toolPolicy.tools?.profile === "danger"
  ) {
    errors.push("remote_hardened disables approval bypass.");
  }

  const explicitOrigins = process.env.GOATCITADEL_ALLOWED_ORIGINS?.trim();
  const hasNonLoopbackOrigin = [...allowedOrigins].some((origin) => !isLoopbackDevOrigin(origin));
  if (!explicitOrigins || !hasNonLoopbackOrigin) {
    errors.push("remote_hardened requires explicit non-loopback GOATCITADEL_ALLOWED_ORIGINS.");
  }

  const networkAllowlist = config.toolPolicy.sandbox.networkAllowlist.map((host) => host.trim()).filter(Boolean);
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

function assertAuthNoneExposureSafety(
  config: GatewayRuntimeConfig,
  allowedOrigins: Set<string>,
  options: { bindHost?: string; tailnetDevOriginsEnabled?: boolean },
): void {
  if (config.assistant.auth.mode !== "none" || resolveAllowUnauthNetwork()) {
    return;
  }

  const errors: string[] = [];
  const bindHost = options.bindHost ?? process.env.GATEWAY_HOST ?? "127.0.0.1";
  const explicitOrigins = process.env.GOATCITADEL_ALLOWED_ORIGINS?.trim();
  const hasNonLoopbackOrigin = [...allowedOrigins].some((origin) => !isLoopbackDevOrigin(origin));
  const tailnetExplicitlyEnabled = isTruthy(process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS);

  if (!isLoopbackHost(bindHost)) {
    errors.push(`auth.mode=none cannot bind to non-loopback host ${bindHost}.`);
  }
  if (config.assistant.deploymentProfile !== "local_dev") {
    errors.push(`auth.mode=none is only allowed for local_dev, got ${config.assistant.deploymentProfile}.`);
  }
  if (explicitOrigins && hasNonLoopbackOrigin) {
    errors.push("auth.mode=none cannot be combined with non-loopback GOATCITADEL_ALLOWED_ORIGINS.");
  }
  if (options.tailnetDevOriginsEnabled && tailnetExplicitlyEnabled) {
    errors.push("auth.mode=none cannot be combined with explicitly enabled tailnet dev origins.");
  }

  if (errors.length > 0) {
    throw new Error(
      `Unsafe auth-none exposure blocked: ${errors.join(" ")} Set ${INSECURE_LOCAL_ONLY_OVERRIDE_ENV}=true only for an intentional local-only override.`,
    );
  }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
