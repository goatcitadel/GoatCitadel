import type { FilesystemReadAccessMode, PermissionProfileRecord, ToolApprovalMode } from "@goatcitadel/contracts";
import { SCHEDULED_RESTRICTED_PROFILE } from "@goatcitadel/contracts";
import { matchesToolPattern } from "@goatcitadel/policy-engine";

export interface ScheduledCreatorIntersectionInput {
  creatorProfile: PermissionProfileRecord;
  runId: string;
  knownToolNames: readonly string[];
  now?: string;
}

export function buildScheduledCreatorIntersectionProfile(
  input: ScheduledCreatorIntersectionInput,
): PermissionProfileRecord {
  const creatorPatterns = input.creatorProfile.toolPatterns.length > 0 ? input.creatorProfile.toolPatterns : ["*"];
  const catalogDeniedByCreator = creatorPatterns.includes("*")
    ? []
    : input.knownToolNames.filter(
        (toolName) => !creatorPatterns.some((pattern) => matchesToolPattern(pattern, toolName)),
      );
  const now = input.now ?? new Date().toISOString();
  return {
    ...SCHEDULED_RESTRICTED_PROFILE,
    profileId: `scheduled-intersection:${input.runId}`,
    label: `Scheduled Intersection (${input.creatorProfile.label})`,
    description:
      "Non-persisted scheduled profile intersecting scheduled-restricted with the creator's active permission profile.",
    builtin: true,
    scope: "global",
    approvalMode: stricterToolApprovalMode(
      SCHEDULED_RESTRICTED_PROFILE.approvalMode,
      input.creatorProfile.approvalMode,
    ),
    legacyToolProfile: input.creatorProfile.legacyToolProfile ?? SCHEDULED_RESTRICTED_PROFILE.legacyToolProfile,
    toolPatterns: creatorPatterns,
    allow: intersectPatternLists(SCHEDULED_RESTRICTED_PROFILE.allow, input.creatorProfile.allow),
    deny: uniqueStrings([
      ...SCHEDULED_RESTRICTED_PROFILE.deny,
      ...input.creatorProfile.deny,
      ...catalogDeniedByCreator,
    ]),
    readAccessMode: stricterFilesystemReadAccessMode(
      SCHEDULED_RESTRICTED_PROFILE.readAccessMode,
      input.creatorProfile.readAccessMode,
    ),
    defaultForSurfaces: [],
    createdBy: "system-scheduled-profile-intersection",
    createdAt: now,
    updatedAt: now,
  };
}

export function permissionProfileAppliesToCreator(input: {
  profile: PermissionProfileRecord;
  creatorActorId?: string;
  workspaceId: string;
}): boolean {
  switch (input.profile.scope) {
    case "global":
      return true;
    case "operator":
      return Boolean(input.creatorActorId && input.profile.scopeRef === input.creatorActorId);
    case "workspace":
      return Boolean(input.profile.scopeRef && input.profile.scopeRef === input.workspaceId);
    default:
      return false;
  }
}

function stricterToolApprovalMode(left: ToolApprovalMode, right: ToolApprovalMode): ToolApprovalMode {
  const rank: Record<ToolApprovalMode, number> = { bypass: 0, approve_risky: 1, approve_all: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function stricterFilesystemReadAccessMode(
  left: FilesystemReadAccessMode | undefined,
  right: FilesystemReadAccessMode | undefined,
): FilesystemReadAccessMode | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const rank: Record<FilesystemReadAccessMode, number> = { roots_only: 0, approval_required: 1, full_disk: 2 };
  return rank[left] <= rank[right] ? left : right;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function intersectPatternLists(left: readonly string[], right: readonly string[]): string[] {
  const normalizedLeft = uniqueStrings(left);
  const normalizedRight = uniqueStrings(right);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return [];
  }
  if (normalizedLeft.includes("*")) {
    return normalizedRight;
  }
  if (normalizedRight.includes("*")) {
    return normalizedLeft;
  }
  return normalizedLeft.filter((leftPattern) =>
    normalizedRight.some(
      (rightPattern) => matchesToolPattern(leftPattern, rightPattern) || matchesToolPattern(rightPattern, leftPattern),
    ),
  );
}
