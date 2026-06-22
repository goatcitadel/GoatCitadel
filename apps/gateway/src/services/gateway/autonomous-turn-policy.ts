import type {
  PermissionProfileRecord,
  PermissionSurface,
  ToolInvokeRequest,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import {
  HEARTBEAT_PERMISSION_PROFILE_ID,
  HEARTBEAT_RESTRICTED_PROFILE,
  SCHEDULED_RESTRICTED_PROFILE,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
} from "@goatcitadel/contracts";

/**
 * Shared restricted-policy foundation for Phase 1 (proactive / autonomous) turns.
 *
 * Safety invariant (non-negotiable): every cron / scheduled / heartbeat /
 * proactive / background turn runs through `engine.invoke` under one of the
 * restricted permission profiles. Dangerous tools are denied so they surface as
 * approvals (never silent autonomous actions). Deny-wins and Citadel Wards in
 * `packages/policy-engine` remain untouched — these profiles only *narrow* the
 * tool surface; they never widen it.
 *
 * The profile records are defined once in `@goatcitadel/contracts`
 * (`policy.ts`) so both the storage built-in seed
 * (`packages/storage/src/permission-profile-repo.ts`) and this builder share a
 * single source of truth. `buildAutonomousTurnContext` attaches the full record
 * directly to the returned `policyContext`, guaranteeing `resolveEffectivePolicy`
 * honors the restricted deny-list even on call paths that do not pass through
 * the permission-profile store.
 */

export {
  AUTONOMOUS_RESTRICTED_PROFILES,
  HEARTBEAT_PERMISSION_PROFILE_ID,
  HEARTBEAT_READ_ONLY_ALLOW,
  HEARTBEAT_RESTRICTED_DENY,
  HEARTBEAT_RESTRICTED_PROFILE,
  SCHEDULED_RESTRICTED_DENY,
  SCHEDULED_RESTRICTED_PROFILE,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
} from "@goatcitadel/contracts";

/** Kind of autonomous turn — selects which restricted profile applies. */
export type AutonomousTurnKind = "scheduled" | "heartbeat";

/**
 * Return the restricted permission-profile record for a given autonomous turn
 * kind. Pure lookup.
 */
export function resolveAutonomousPermissionProfile(kind: AutonomousTurnKind): PermissionProfileRecord {
  return kind === "heartbeat" ? HEARTBEAT_RESTRICTED_PROFILE : SCHEDULED_RESTRICTED_PROFILE;
}

/** Map a restricted permission-profile id back to its autonomous turn kind. */
export function autonomousTurnKindForProfileId(profileId: string): AutonomousTurnKind | undefined {
  if (profileId === HEARTBEAT_PERMISSION_PROFILE_ID) {
    return "heartbeat";
  }
  if (profileId === SCHEDULED_TURN_PERMISSION_PROFILE_ID) {
    return "scheduled";
  }
  return undefined;
}

/**
 * True when a turn is an autonomous (cron / commitment / heartbeat) self-wake,
 * detected via its restricted permission profile. Every autonomous turn is
 * enqueued by `enqueueAutonomousChatTurn` under one of the two restricted
 * profiles, so the `permissionProfileId` is the cleanest signal already carried
 * on the turn request — no extra plumbing or session-origin lookup needed.
 *
 * Post-turn self-improvement hooks (commitment classifier, background review)
 * use this to skip autonomous outputs: those turns run inside human sessions but
 * must not feed the classifier/review loop (a heartbeat `{notify:false}` is not
 * a user commitment, and re-reviewing autonomous output is a cost-amplifying
 * feedback loop).
 */
export function isAutonomousTurnRequest(input: { permissionProfileId?: string }): boolean {
  return autonomousTurnKindForProfileId(input.permissionProfileId ?? "") !== undefined;
}

export interface AutonomousTurnContextInput {
  /** Which restricted profile to run under. */
  kind: AutonomousTurnKind;
  /**
   * The system actor that owns this autonomous turn (e.g. "system-cron",
   * "system-heartbeat"). Becomes the operatorId/authActorId carried on the
   * policy + consent context for the full audit trail.
   */
  systemActorId: string;
  /** Durable/proactive run id for provenance and audit correlation. */
  runId: string;
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
  /** Permission surface; defaults to "tools" for autonomous turns. */
  surface?: PermissionSurface;
  /** Human-readable reason recorded on the consent context. */
  reason?: string;
}

export interface AutonomousTurnContext {
  policyContext: ToolPolicyActorContext;
  consentContext: NonNullable<ToolInvokeRequest["consentContext"]>;
}

/**
 * Build the `policyContext` (+ `consentContext`) used by `invokeTool` for an
 * autonomous turn, mirroring the construction in `chat-proactive-service.ts`.
 *
 * The returned `policyContext` carries:
 *  - the restricted `permissionProfile` record **and** its `permissionProfileId`
 *    (so `resolveEffectivePolicy` applies the restricted deny-list),
 *  - the system actor (`operatorId` / `authActorId` = `systemActorId`,
 *    `authActorSource: "none"`),
 *  - the `runId` for audit/provenance correlation.
 *
 * Immutable: returns fresh objects; never mutates `input`.
 */
export function buildAutonomousTurnContext(input: AutonomousTurnContextInput): AutonomousTurnContext {
  const profile = resolveAutonomousPermissionProfile(input.kind);
  const surface: PermissionSurface = input.surface ?? "tools";

  const policyContext: ToolPolicyActorContext = {
    operatorId: input.systemActorId,
    authActorId: input.systemActorId,
    authActorSource: "none",
    permissionProfileId: profile.profileId,
    permissionProfile: profile,
    surface,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    runId: input.runId,
  };

  const consentContext: NonNullable<ToolInvokeRequest["consentContext"]> = {
    operatorId: input.systemActorId,
    source: "agent",
    reason: input.reason ?? `autonomous ${input.kind} turn`,
  };

  return { policyContext, consentContext };
}
