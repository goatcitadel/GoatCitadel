import type { AuthRuntimeSettings, DeploymentProfile, ToolApprovalMode } from "@goatcitadel/contracts";

import { isLoopbackDevOrigin } from "../../cors-origin-guard.js";
import * as connectionUrlHelpers from "../connection-url-helpers.js";
import type { UpdateSettingsInput } from "../settings-auth-service.js";

export interface DeploymentProfileUpdateGuardContext {
  currentDeploymentProfile: DeploymentProfile;
  currentAuthMode: AuthRuntimeSettings["mode"];
  currentAllowLoopbackBypass: boolean;
  currentDefaultToolProfile?: string;
  currentToolPolicyProfile?: string;
  currentToolPolicyApprovalMode?: ToolApprovalMode;
  currentAssistantToolApprovalMode?: ToolApprovalMode;
  currentNetworkAllowlist: string[];
  allowedOriginsEnv?: string;
}

export function assertDeploymentProfileUpdate(
  input: UpdateSettingsInput,
  context: DeploymentProfileUpdateGuardContext,
): void {
  const nextProfile = input.deploymentProfile ?? context.currentDeploymentProfile;
  if (nextProfile !== "remote_hardened") {
    return;
  }

  const nextAuthMode = input.auth?.mode ?? context.currentAuthMode;
  const nextAllowLoopbackBypass = input.auth?.allowLoopbackBypass ?? context.currentAllowLoopbackBypass;
  const nextDefaultToolProfile = input.defaultToolProfile ?? context.currentDefaultToolProfile;
  const nextToolPolicyProfile = context.currentToolPolicyProfile;
  const nextToolApprovalMode =
    input.toolApprovalMode ??
    (input.defaultToolProfile ? legacyToolProfileToApprovalMode(input.defaultToolProfile) : undefined) ??
    context.currentToolPolicyApprovalMode ??
    context.currentAssistantToolApprovalMode ??
    legacyToolProfileToApprovalMode(context.currentToolPolicyProfile ?? context.currentDefaultToolProfile) ??
    "approve_risky";
  const nextAllowlist = (input.networkAllowlist ?? context.currentNetworkAllowlist)
    .map((host) => host.trim())
    .filter(Boolean);

  const errors: string[] = [];
  if (nextAuthMode === "none") {
    errors.push("remote_hardened requires token or basic auth.");
  }
  if (nextAllowLoopbackBypass) {
    errors.push("remote_hardened disables loopback bypass.");
  }
  if (nextToolApprovalMode === "bypass") {
    errors.push("remote_hardened disables approval bypass.");
  }
  if (nextDefaultToolProfile === "danger" || nextToolPolicyProfile === "danger") {
    errors.push("remote_hardened disables danger tool profiles.");
  }
  if (!hasExplicitNonLoopbackAllowedOrigin(context.allowedOriginsEnv)) {
    errors.push("remote_hardened requires explicit non-loopback GOATCITADEL_ALLOWED_ORIGINS.");
  }
  if (nextAllowlist.length === 0) {
    errors.push("remote_hardened requires a non-empty outbound host allowlist.");
  }
  if (nextAllowlist.some((host) => host === "*")) {
    errors.push("remote_hardened forbids wildcard outbound host allowlists.");
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
}

export interface FirecrawlRuntimeUpdateGuardContext {
  currentNetworkAllowlist: string[];
  currentFirecrawlEnabled: boolean;
  currentFirecrawlBaseUrl: string;
}

export function assertFirecrawlRuntimeUpdate(
  input: UpdateSettingsInput,
  context: FirecrawlRuntimeUpdateGuardContext,
): void {
  const nextAllowlist = (input.networkAllowlist ?? context.currentNetworkAllowlist)
    .map((host) => host.trim())
    .filter(Boolean);
  const nextEnabled = input.web?.firecrawl?.enabled ?? context.currentFirecrawlEnabled;
  const nextBaseUrl = input.web?.firecrawl?.baseUrl?.trim() || context.currentFirecrawlBaseUrl;

  if (!nextEnabled) {
    return;
  }
  if (!connectionUrlHelpers.isUrlAllowlistedInList(nextBaseUrl, nextAllowlist)) {
    throw new Error(
      `web.firecrawl.baseUrl must be present in the outbound allowlist before Firecrawl can be enabled: ${nextBaseUrl}`,
    );
  }
}

function legacyToolProfileToApprovalMode(profile: string | undefined): ToolApprovalMode | undefined {
  if (!profile) {
    return undefined;
  }
  return profile === "danger" ? "bypass" : "approve_risky";
}

function hasExplicitNonLoopbackAllowedOrigin(rawOrigins: string | undefined): boolean {
  if (!rawOrigins?.trim()) {
    return false;
  }
  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .some((origin) => {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return false;
        }
        return !isLoopbackDevOrigin(parsed.origin);
      } catch {
        return false;
      }
    });
}
