import type { LocalOperatorOverrideRecord } from "@goatcitadel/contracts";
import { fetchEffectivePermissionProfile } from "@goatcitadel/mission-control-shared/api/client";
import { EFFECTIVE_PERMISSION_CONTEXTS } from "./sections/PermissionProfileDraftFields";

export interface EffectivePermissionSurfaceState {
  surface: (typeof EFFECTIVE_PERMISSION_CONTEXTS)[number];
  profileId?: string;
  profileLabel?: string;
  approvalMode?: string;
  localOperatorOverrideId?: string;
  localOperatorOverride?: LocalOperatorOverrideRecord;
  error?: string;
}

/** Read each existing context owner independently; a failed context is never an empty policy. */
export async function readEffectivePermissionContexts(workspaceId: string): Promise<EffectivePermissionSurfaceState[]> {
  if (!workspaceId.trim()) throw new Error("Select a workspace before inspecting effective policy.");
  return Promise.all(
    EFFECTIVE_PERMISSION_CONTEXTS.map(async (surface) => {
      try {
        return readEffectivePermissionSurfaceState(
          surface,
          await fetchEffectivePermissionProfile({ workspaceId, surface }),
        );
      } catch (error) {
        return { surface, error: error instanceof Error ? error.message : "Effective policy unavailable." };
      }
    }),
  );
}

export function readEffectivePermissionSurfaceState(
  surface: EffectivePermissionSurfaceState["surface"],
  context: Record<string, unknown>,
): EffectivePermissionSurfaceState {
  const profile = isRecord(context.permissionProfile) ? context.permissionProfile : undefined;
  const override = readLocalOperatorOverride(context.localOperatorOverride);
  return {
    surface,
    profileId: readString(context.permissionProfileId) ?? readString(profile?.profileId),
    profileLabel: readString(context.permissionProfileLabel) ?? readString(profile?.label),
    approvalMode: readString(context.permissionProfileApprovalMode) ?? readString(profile?.approvalMode),
    localOperatorOverrideId: readString(context.localOperatorOverrideId) ?? override?.overrideId,
    localOperatorOverride: override,
  };
}

function readLocalOperatorOverride(value: unknown): LocalOperatorOverrideRecord | undefined {
  if (!isRecord(value)) return undefined;
  const overrideId = readString(value.overrideId),
    operatorId = readString(value.operatorId),
    reason = readString(value.reason),
    createdAt = readString(value.createdAt),
    expiresAt = readString(value.expiresAt);
  if (!overrideId || !operatorId || !reason || !createdAt || !expiresAt) return undefined;
  if (
    !["workspace", "session", "run", "operator"].includes(String(value.scope)) ||
    !["active", "revoked", "expired"].includes(String(value.status))
  )
    return undefined;
  return {
    overrideId,
    operatorId,
    reason,
    createdAt,
    expiresAt,
    scope: value.scope as LocalOperatorOverrideRecord["scope"],
    scopeRef: readString(value.scopeRef),
    status: value.status as LocalOperatorOverrideRecord["status"],
    createdBy: readString(value.createdBy) ?? operatorId,
    revokedAt: readString(value.revokedAt),
    revokedBy: readString(value.revokedBy),
  };
}
function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
