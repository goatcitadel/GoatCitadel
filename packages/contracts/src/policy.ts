import type {
  InternalToolCallV1,
  InternalToolResultV1,
  SecretResolutionBoundary,
  ToolAuditRecord,
  ToolExecutionTrustLevel,
} from "./internal-tooling.js";
import type { ContextSourceAttribution } from "./ingestion.js";
import type { WardEffect } from "./citadel-wards.js";

export type ToolApprovalMode = "approve_all" | "approve_risky" | "bypass";

export type ToolProfile = "minimal" | "standard" | "coding" | "ops" | "research" | "chat-agent" | "danger";

export type FilesystemReadAccessMode = "roots_only" | "approval_required" | "full_disk";

export type PermissionProfileBuiltinId =
  | "safe"
  | "trusted_local_power"
  | "scheduled-restricted"
  | "heartbeat-restricted";
export type PermissionProfileStatus = "active" | "archived";
export type PermissionProfileScope = "global" | "operator" | "workspace";
export type PermissionProfileCreateScope = Exclude<PermissionProfileScope, "global">;
export type PermissionProfileActivationScope = "operator" | "workspace" | "session";
export type PermissionSurface = "chat" | "cowork" | "code" | "tools" | "mcp" | "all";

export interface PermissionProfileRecord {
  profileId: string;
  label: string;
  description?: string;
  builtin: boolean;
  status: PermissionProfileStatus;
  scope: PermissionProfileScope;
  scopeRef?: string;
  approvalMode: ToolApprovalMode;
  legacyToolProfile?: string;
  toolPatterns: string[];
  allow: string[];
  deny: string[];
  readAccessMode?: FilesystemReadAccessMode;
  defaultForSurfaces?: PermissionSurface[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

// ---------------------------------------------------------------------------
// Restricted autonomous-turn permission profiles (Phase 1: proactive/autonomous)
// ---------------------------------------------------------------------------
//
// Shared source of truth for the two built-in restricted profiles used by every
// cron / scheduled / heartbeat / proactive / background autonomous turn. They
// live here (the contracts package) so both the storage built-in seed
// (`permission-profile-repo.ts`) and the gateway policy builder
// (`gateway/autonomous-turn-policy.ts`) reference the same records without a
// cross-package dependency inversion. These profiles only *narrow* the tool
// surface — deny-wins and Citadel Wards in the policy engine are untouched.

/** Permission-profile id for cron / scheduled autonomous agent turns. */
export const SCHEDULED_TURN_PERMISSION_PROFILE_ID = "scheduled-restricted";

/** Permission-profile id for silent heartbeat (read-only) self-wake turns. */
export const HEARTBEAT_PERMISSION_PROFILE_ID = "heartbeat-restricted";

/** Stable created/updated timestamp for the built-in restricted profiles. */
const RESTRICTED_PROFILE_CREATED_AT = "2026-06-21T00:00:00.000Z";

/**
 * Dangerous / side-effecting tool patterns denied on scheduled autonomous
 * turns. Denied tools fail closed in the engine (deny-wins): an autonomous turn
 * that needs one must raise an approval instead of acting silently.
 *
 * `schedule.*` is denied outright (anti-recursion): a scheduled/heartbeat turn
 * runs unattended, so there is no operator to clear an approval. Approval-gating
 * self-scheduling is therefore NOT a hard block for an autonomous turn — it
 * would simply park forever (or, worse, auto-approve under a permissive policy).
 * Denying the whole family means a scheduled turn can never self-schedule more
 * work. Interactive surfaces still get `schedule.manage` (it is not denied on
 * non-restricted profiles), so a human can always create/list/cancel schedules.
 */
export const SCHEDULED_RESTRICTED_DENY: readonly string[] = [
  "shell.*",
  "fs.write",
  "fs.move",
  "fs.delete",
  "git.commit",
  "git.push",
  "http.post",
  "*.send",
  "mcp.invoke",
  "browser.interact",
  // Anti-recursion: scheduled/heartbeat turns cannot create more scheduled work.
  "schedule.*",
];

/**
 * Read-only tool allowlist for heartbeat turns. Expressed as the profile's
 * effective `toolPatterns` so the deny-by-default posture is structural.
 */
export const HEARTBEAT_READ_ONLY_ALLOW: readonly string[] = [
  "time.now",
  "memory.read",
  "memory.search",
  "calendar.read",
  "gmail.read",
];

/**
 * Deny list for heartbeat turns — enforces a genuine read-only allowlist.
 *
 * A heartbeat profile cannot be made read-only by `toolPatterns` alone:
 * `resolveEffectivePolicy` unions the *base* config's `tools.allow` (which in
 * the shipped `tool-policy.json` includes broad families such as `session.*`,
 * `chat.*`, `memory.*`, `skills.*`, `docs.*`, `knowledge.*`, `fs.read`,
 * `file.*`, `code.search`) into the effective tool set. Because deny-wins is
 * absolute, the only reliable lever is the deny list. We therefore deny every
 * non-allowlisted family the base config might grant, plus the dangerous set.
 * The result is that the effective surface collapses to
 * {@link HEARTBEAT_READ_ONLY_ALLOW} ("deny the rest"), regardless of how
 * permissive the base config is. The `memory.read` / `memory.search` reads stay
 * callable because we deny only the `memory` *write* ops, not `memory.*`.
 */
export const HEARTBEAT_RESTRICTED_DENY: readonly string[] = [
  // Dangerous / side-effecting set (same as scheduled).
  ...SCHEDULED_RESTRICTED_DENY,
  // Caution-level mutations inside read families.
  "memory.write",
  "memory.upsert",
  // Non-allowlisted base-config read families (collapse to the allowlist).
  "fs.*",
  "file.*",
  "code.*",
  "docs.*",
  "knowledge.*",
  "session.*",
  // Authoring / lifecycle / messaging families not needed for a silent read.
  // (`schedule.*` is already denied via the inherited SCHEDULED_RESTRICTED_DENY.)
  "skills.*",
  "skill.*",
  "chat.*",
  "connector.*",
  "task.*",
  "http.*",
];

/** The scheduled-restricted built-in profile (side-effecting tools denied). */
export const SCHEDULED_RESTRICTED_PROFILE: PermissionProfileRecord = {
  profileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID,
  label: "Scheduled (Restricted)",
  description:
    "Restricted profile for cron/scheduled autonomous agent turns. Side-effecting and dangerous tools are denied (they surface as approvals); risky tools require approval. Deny-wins and Citadel Wards still apply.",
  builtin: true,
  status: "active",
  scope: "global",
  approvalMode: "approve_risky",
  toolPatterns: ["*"],
  allow: [],
  deny: [...SCHEDULED_RESTRICTED_DENY],
  readAccessMode: "approval_required",
  defaultForSurfaces: [],
  createdBy: "system",
  createdAt: RESTRICTED_PROFILE_CREATED_AT,
  updatedAt: RESTRICTED_PROFILE_CREATED_AT,
};

/** The heartbeat-restricted built-in profile (read-only allowlist). */
export const HEARTBEAT_RESTRICTED_PROFILE: PermissionProfileRecord = {
  profileId: HEARTBEAT_PERMISSION_PROFILE_ID,
  label: "Heartbeat (Read-only)",
  description:
    "Read-only profile for silent heartbeat self-wake turns. Only time/memory/calendar/gmail read tools are available; all side-effecting tools are denied. Deny-wins and Citadel Wards still apply.",
  builtin: true,
  status: "active",
  scope: "global",
  approvalMode: "approve_all",
  toolPatterns: [...HEARTBEAT_READ_ONLY_ALLOW],
  allow: [],
  deny: [...HEARTBEAT_RESTRICTED_DENY],
  readAccessMode: "approval_required",
  defaultForSurfaces: [],
  createdBy: "system",
  createdAt: RESTRICTED_PROFILE_CREATED_AT,
  updatedAt: RESTRICTED_PROFILE_CREATED_AT,
};

/** Both restricted profiles seeded for autonomous turns, in id order. */
export const AUTONOMOUS_RESTRICTED_PROFILES: readonly PermissionProfileRecord[] = [
  SCHEDULED_RESTRICTED_PROFILE,
  HEARTBEAT_RESTRICTED_PROFILE,
];

export interface PermissionProfileCreateInput {
  label: string;
  description?: string;
  scope?: PermissionProfileCreateScope;
  scopeRef?: string;
  approvalMode: ToolApprovalMode;
  legacyToolProfile?: string;
  toolPatterns?: string[];
  allow?: string[];
  deny?: string[];
  readAccessMode?: FilesystemReadAccessMode;
  defaultForSurfaces?: PermissionSurface[];
  createdBy: string;
}

export interface PermissionProfileUpdateInput {
  label?: string;
  description?: string;
  approvalMode?: ToolApprovalMode;
  legacyToolProfile?: string;
  toolPatterns?: string[];
  allow?: string[];
  deny?: string[];
  readAccessMode?: FilesystemReadAccessMode;
  defaultForSurfaces?: PermissionSurface[];
  updatedBy: string;
}

export interface PermissionProfileActivationRecord {
  activationId: string;
  profileId: string;
  operatorId?: string;
  workspaceId?: string;
  sessionId?: string;
  surface?: PermissionSurface;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionProfileActivationInput {
  profileId: string;
  operatorId?: string;
  workspaceId?: string;
  sessionId?: string;
  surface?: PermissionSurface;
  createdBy: string;
}

export type LocalOperatorOverrideScope = "operator" | "workspace" | "session" | "run";
export type LocalOperatorOverrideStatus = "active" | "expired" | "revoked";

export interface LocalOperatorOverrideRecord {
  overrideId: string;
  operatorId: string;
  scope: LocalOperatorOverrideScope;
  scopeRef?: string;
  reason: string;
  status: LocalOperatorOverrideStatus;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface LocalOperatorOverrideCreateInput {
  operatorId: string;
  scope: LocalOperatorOverrideScope;
  scopeRef?: string;
  reason: string;
  ttlSeconds: number;
  createdBy: string;
}

export interface ToolPolicyActorContext {
  operatorId?: string;
  authActorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" | "a2a_peer";
  permissionProfileId?: string;
  permissionProfile?: PermissionProfileRecord;
  localOperatorOverrideId?: string;
  localOperatorOverride?: LocalOperatorOverrideRecord;
  surface?: PermissionSurface;
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  approvedCodeModeRunId?: string;
  matchedGrantId?: string;
  matchedGrantAllowedHosts?: string[];
  fullWebAccess?: boolean;
}

export type ToolLoopDetectorKind = "repeated_same_call" | "no_progress_polling" | "ping_pong";

export interface ToolLoopDetectionConfig {
  enabled: boolean;
  historySize: number;
  warningThreshold: number;
  criticalThreshold: number;
  globalThreshold: number;
  detectors: Record<ToolLoopDetectorKind, boolean>;
}

/**
 * Intent-based destructive-argument gate. Generalizes the shell-risk pattern to
 * arbitrary tools: a tool is permitted in general but its specific high-risk
 * argument values (e.g. `terraform destroy`) require approval even under a bypass
 * approval mode. Empty/absent config leaves the gate inert (no behavior change).
 */
export interface ToolRiskyArgumentPattern {
  /** Glob over tool names (exact, or trailing `*`, or `*`). e.g. "shell.exec", "terraform.*", "*". */
  toolNamePattern: string;
  /** Dot path into the tool args to test (e.g. "command", "input.operation"). Omit to test the whole args JSON. */
  argumentPath?: string;
  /** Glob patterns matched (case-insensitive, word-bounded) against the resolved argument value. */
  valuePatterns: string[];
}

export interface ToolPolicyConfig {
  profiles?: Record<string, string[]>;
  tools: {
    approvalMode?: ToolApprovalMode;
    profile?: ToolProfile;
    allow: string[];
    deny: string[];
    loopDetection?: ToolLoopDetectionConfig;
  };
  agents: Record<string, { tools?: Partial<ToolPolicyConfig["tools"]> }>;
  sandbox: {
    writeJailRoots: string[];
    readOnlyRoots: string[];
    readAccessMode?: FilesystemReadAccessMode;
    networkAllowlist: string[];
    riskyShellPatterns: string[];
    requireApprovalForRiskyShell: boolean;
    /** Intent-based destructive-argument patterns (generalizes riskyShellPatterns to any tool). */
    riskyArgumentPatterns?: ToolRiskyArgumentPattern[];
  };
}

export interface ToolInvokeRequest {
  toolName: string;
  args: Record<string, unknown>;
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  /** Protected parent operating-world scope resolved by the gateway when available. */
  citadelId?: string;
  taskId?: string;
  runId?: string;
  signal?: AbortSignal;
  trustLevel?: ToolExecutionTrustLevel;
  sourceAttribution?: ContextSourceAttribution[];
  authContext?: {
    boundary?: SecretResolutionBoundary;
    secretRefs?: string[];
  };
  consentContext?: {
    operatorId?: string;
    source?: "ui" | "tui" | "agent";
    reason?: string;
  };
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  surface?: PermissionSurface;
  policyContext?: ToolPolicyActorContext;
  dryRun?: boolean;
  externalRuntime?: boolean;
}

export interface ToolInvokeResult {
  outcome: "executed" | "approval_required" | "blocked";
  approvalId?: string;
  expiresAt?: string;
  policyReason: string;
  auditEventId: string;
  result?: Record<string, unknown>;
  internalCall?: InternalToolCallV1;
  internalResult?: InternalToolResultV1;
  audit?: ToolAuditRecord;
  /**
   * The raw Citadel Ward effect that matched this invocation, when a Ward matched
   * with a non-`allow` effect. Surfaced (not persisted) so downstream execution can
   * enforce the previously-silent effects (`require_dry_run`, `route_local`,
   * `redact`) that the policy engine does not itself gate — e.g. the tool
   * invocation coordinator scrubs known secret patterns from `result` when this is
   * `"redact"`. `undefined` when no Ward matched or the match resolved to `allow`.
   */
  wardEffect?: WardEffect;
}

export interface EffectiveToolPolicy {
  approvalMode: ToolApprovalMode;
  profile?: string;
  permissionProfileId?: string;
  permissionProfileLabel?: string;
  localOperatorOverrideId?: string;
  allowSet: Set<string>;
  denySet: Set<string>;
  effectiveTools: Set<string>;
  readAccessMode?: FilesystemReadAccessMode;
}

/**
 * Two orthogonal policy axes (the Codex PermissionProfile × AskForApproval shape):
 * sandbox access ("what the agent can touch") is independent of approval escalation
 * ("when to interrupt the human"). The engine already evaluates these independently;
 * these types make the composition explicit and auditable for operator-facing config.
 */
export interface SandboxAccessPolicy {
  filesystemReadMode: FilesystemReadAccessMode;
  networkAllowlist: string[];
  writeJailRoots: string[];
  readOnlyRoots: string[];
  riskyShellPatterns: string[];
  riskyArgumentPatterns: ToolRiskyArgumentPattern[];
}

export interface ApprovalEscalationPolicy {
  approvalMode: ToolApprovalMode;
  requireApprovalForRiskyShell: boolean;
}

export interface ToolPolicyAxes {
  sandbox: SandboxAccessPolicy;
  approval: ApprovalEscalationPolicy;
}
