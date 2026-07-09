import type { PermissionProfileRecord, ToolGrantRecord, ToolPolicyActorContext } from "@goatcitadel/contracts";
import { HEARTBEAT_PERMISSION_PROFILE_ID, SCHEDULED_TURN_PERMISSION_PROFILE_ID } from "./autonomous-turn-policy.js";

export function isActiveToolGrant(grant: ToolGrantRecord): boolean {
  if (grant.revokedAt) {
    return false;
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= Date.now()) {
      return false;
    }
  }
  if (grant.grantType === "one_time") {
    return (grant.usesRemaining ?? 0) > 0;
  }
  return true;
}

export function canMutatePermissionProfile(profile: PermissionProfileRecord, actorId: string): boolean {
  if (profile.builtin) {
    return false;
  }
  if (profile.scope === "operator") {
    return profile.scopeRef === actorId && profile.createdBy === actorId;
  }
  if (profile.scope === "workspace") {
    return profile.createdBy === actorId;
  }
  return false;
}

export function grantPatternMatches(pattern: string, toolName: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(toolName);
}

export function isSystemOwnedRestrictedPermissionProfileRequest(
  profileId: string,
  input: {
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
  },
): boolean {
  if (profileId !== SCHEDULED_TURN_PERMISSION_PROFILE_ID && profileId !== HEARTBEAT_PERMISSION_PROFILE_ID) {
    return false;
  }
  if (input.authActorSource !== "none") {
    return false;
  }
  const operatorId = input.operatorId?.trim();
  const authActorId = input.authActorId?.trim();
  return Boolean(
    operatorId &&
    authActorId &&
    operatorId === authActorId &&
    (operatorId === "system-cron" || operatorId === "system"),
  );
}
