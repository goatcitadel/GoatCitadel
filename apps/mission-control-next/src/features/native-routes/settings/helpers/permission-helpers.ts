import type {
  FilesystemReadAccessMode,
  LocalOperatorOverrideScope,
  PermissionProfileRecord,
  PermissionSurface,
  ToolApprovalMode,
  ToolGrantRecord,
} from "@goatcitadel/contracts";
import { formatDateTime, splitLineOrCommaList } from "./input-format";

export const TOOL_APPROVAL_MODE_OPTIONS: ToolApprovalMode[] = ["approve_all", "approve_risky", "bypass"];

export type PermissionProfileEditorDraft = {
  label: string;
  description: string;
  approvalMode: ToolApprovalMode;
  toolPatterns: string;
  allow: string;
  deny: string;
  readAccessMode: FilesystemReadAccessMode | "";
  defaultForSurfaces: PermissionSurface[];
};

export function matchesToolGrant(grant: ToolGrantRecord, toolName: string) {
  const pattern = grant.toolPattern.trim();
  if (!pattern) {
    return false;
  }
  if (pattern === "*") {
    return true;
  }
  if (!pattern.includes("*")) {
    return pattern === toolName;
  }
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

export function isToolGrantAvailable(grant: ToolGrantRecord, nowMs = Date.now()) {
  if (grant.revokedAt) {
    return false;
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= nowMs) {
      return false;
    }
  }
  if (grant.grantType === "one_time") {
    return (grant.usesRemaining ?? 0) > 0;
  }
  return true;
}

export function describeToolGrantAvailability(grant: ToolGrantRecord, nowMs = Date.now()) {
  if (grant.revokedAt) {
    return `revoked ${formatDateTime(grant.revokedAt)}`;
  }
  if (grant.expiresAt) {
    const expiry = Date.parse(grant.expiresAt);
    if (Number.isFinite(expiry) && expiry <= nowMs) {
      return `expired ${formatDateTime(grant.expiresAt)}`;
    }
  }
  if (grant.grantType === "one_time" && (grant.usesRemaining ?? 0) <= 0) {
    return "exhausted";
  }
  return "available";
}

export function defaultToolGrantExpiry(nowMs = Date.now()) {
  return new Date(nowMs + 60 * 60 * 1000).toISOString();
}

export function createEmptyPermissionProfileDraft(): PermissionProfileEditorDraft {
  return {
    label: "",
    description: "",
    approvalMode: "approve_all",
    toolPatterns: "session.status\nmemory.read",
    allow: "",
    deny: "",
    readAccessMode: "",
    defaultForSurfaces: [],
  };
}

export function createPermissionProfileDraftFromRecord(profile: PermissionProfileRecord): PermissionProfileEditorDraft {
  return {
    label: profile.label,
    description: profile.description ?? "",
    approvalMode: profile.approvalMode,
    toolPatterns: profile.toolPatterns.join("\n"),
    allow: (profile.allow ?? []).join("\n"),
    deny: (profile.deny ?? []).join("\n"),
    readAccessMode: profile.readAccessMode ?? "",
    defaultForSurfaces: profile.defaultForSurfaces ?? [],
  };
}

export function permissionProfileDraftToMutation(draft: PermissionProfileEditorDraft) {
  const description = draft.description.trim();
  return {
    label: draft.label.trim(),
    description: description || undefined,
    approvalMode: draft.approvalMode,
    toolPatterns: splitLineOrCommaList(draft.toolPatterns),
    allow: splitLineOrCommaList(draft.allow),
    deny: splitLineOrCommaList(draft.deny),
    readAccessMode: draft.readAccessMode || undefined,
    defaultForSurfaces: draft.defaultForSurfaces,
  };
}

export function togglePermissionProfileSurface(
  current: PermissionSurface[],
  surface: PermissionSurface,
  checked: boolean,
): PermissionSurface[] {
  if (checked) {
    return current.includes(surface) ? current : [...current, surface];
  }
  return current.filter((item) => item !== surface);
}

export function normalizeToolApprovalMode(value: string | undefined): ToolApprovalMode {
  return TOOL_APPROVAL_MODE_OPTIONS.includes(value as ToolApprovalMode) ? (value as ToolApprovalMode) : "approve_risky";
}

export function describeToolApprovalMode(value: ToolApprovalMode): string {
  if (value === "approve_all") {
    return "Ask every time";
  }
  if (value === "bypass") {
    return "Skip normal prompts";
  }
  return "Ask for risky work";
}

export function describeToolApprovalModeHelp(value: ToolApprovalMode): string {
  if (value === "approve_all") {
    return "Every otherwise-allowed tool call asks first; useful for audits and first-run learning.";
  }
  if (value === "bypass") {
    return "Allowed tools run without normal prompts in local profiles except nuclear-risk, risky-shell, and read work outside the active read posture. Remote Hardened rejects this mode; hard policy blocks still apply.";
  }
  return "Low-risk allowed tools can run, but caution, danger, and nuclear-risk work asks first.";
}

export function describePermissionProfile(profile: PermissionProfileRecord): string {
  if (profile.description?.trim()) {
    return profile.description.trim();
  }
  const posture = describeToolApprovalMode(profile.approvalMode);
  const scope = profile.scope === "global" ? "global" : `${profile.scope} scoped`;
  return `${posture}; ${scope}; ${profile.toolPatterns.length} tool pattern${
    profile.toolPatterns.length === 1 ? "" : "s"
  }.`;
}

export function labelForPermissionProfile(profileId: string, profiles: PermissionProfileRecord[] = []): string {
  return profiles.find((profile) => profile.profileId === profileId)?.label ?? profileId;
}

export function labelForLocalOperatorOverrideScope(scope: LocalOperatorOverrideScope): string {
  switch (scope) {
    case "operator":
      return "This operator";
    case "session":
      return "Specific session";
    case "run":
      return "Specific run";
    default:
      return "Current workspace";
  }
}

export function resolveLocalOperatorOverrideScopeRef(
  scope: LocalOperatorOverrideScope,
  draftScopeRef: string | undefined,
  activeWorkspaceId: string,
): string | undefined {
  if (scope === "operator") {
    return undefined;
  }
  if (scope === "workspace") {
    return activeWorkspaceId;
  }
  const trimmed = draftScopeRef?.trim();
  return trimmed ? trimmed : undefined;
}

export function resetLocalOperatorOverrideScopeRefForScope(
  scope: LocalOperatorOverrideScope,
  activeWorkspaceId: string,
): string {
  return scope === "workspace" ? activeWorkspaceId : "";
}
