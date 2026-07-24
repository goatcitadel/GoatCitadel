import { createHash } from "node:crypto";
import { canonicalJsonString } from "./canonical-json.js";
import { assertBoundedGovernanceMetadata } from "./skill-governance.js";

/**
 * HX-402 P0 shared immutable lifecycle foundation
 * (docs/review/HX_402_REMAINING_PRODUCER_AUDIT_2026-07-14.md).
 *
 * A governed lifecycle mutation is the bounded, typed envelope every P1-P3
 * producer must write into the immutable `governed_lifecycle_events` source in
 * the same database transaction as its canonical mutation, source history
 * record, and Journey event. The envelope carries the exact mutation identity,
 * a versioned canonical-material hash (never raw protected content), the real
 * actor/scope linkage, and explicit `sourceRequired`/`approvalRequired`
 * declarations that must byte-match the frozen kind registry below.
 */
export const GOVERNED_LIFECYCLE_EVENT_VERSION = "goatcitadel.governed-lifecycle-event.v1" as const;

/** Version tag folded into every canonical-material fingerprint. */
export const GOVERNED_MUTATION_MATERIAL_VERSION = "goatcitadel.governed-mutation-material.v1" as const;

export type GovernedMutationDomain = "memory" | "skill_state" | "capability_state" | "improvement";

export type GovernedMutationScopeKind = "workspace" | "global";

export type GovernedMutationActorType = "operator" | "system" | "approval_effect";

export type MemoryGovernedOperation =
  | "item_updated"
  | "pin_changed"
  | "ttl_changed"
  | "item_forgotten"
  | "batch_mutated"
  | "maintenance_expired"
  | "entity_created"
  | "entity_forgotten"
  | "relation_created"
  | "decision_created"
  | "decision_retrospective_added"
  | "decision_forgotten"
  | "learning_created"
  | "learning_superseded"
  | "learning_forgotten"
  | "trace_candidate_promoted"
  | "session_learned_updated";

export type SkillStateGovernedOperation =
  | "enabled"
  | "disabled"
  | "slept"
  | "auto_set"
  | "activation_policy_updated"
  | "system_disabled";

export type CapabilityStateGovernedOperation =
  | "proposal_created"
  | "candidate_promoted"
  | "candidate_revoked"
  | "candidate_rolled_back"
  | "system_revoked";

export type ImprovementGovernedOperation =
  | "activation_applied"
  | "activation_paused"
  | "activation_rolled_back"
  | "activation_failed";

export type GovernedMutationOperation =
  | MemoryGovernedOperation
  | SkillStateGovernedOperation
  | CapabilityStateGovernedOperation
  | ImprovementGovernedOperation;

export type GovernedMutationTargetKind =
  | "memory_item"
  | "memory_batch"
  | "memory_entity"
  | "memory_relation"
  | "memory_decision"
  | "memory_learning"
  | "session_learned_memory"
  | "skill"
  | "skill_activation_policy"
  | "capability_proposal"
  | "capability_candidate"
  | "improvement_activation";

export interface GovernedMutationKindDeclaration {
  readonly domain: GovernedMutationDomain;
  readonly operation: GovernedMutationOperation;
  readonly targetKind: GovernedMutationTargetKind;
  readonly sourceRequired: boolean;
  readonly approvalRequired: boolean;
  /**
   * Fail-safe internal transitions (skill disable / capability revoke and
   * scheduled memory expiry) bypass approval only through unforgeable module
   * authority. Their events therefore require the `system` actor type; an
   * operator or approval-effect actor can never mint them.
   */
  readonly systemActorOnly: boolean;
}

const kind = (
  domain: GovernedMutationDomain,
  operation: GovernedMutationOperation,
  targetKind: GovernedMutationTargetKind,
  requirements: { sourceRequired: boolean; approvalRequired: boolean; systemActorOnly?: boolean },
): GovernedMutationKindDeclaration =>
  Object.freeze({
    domain,
    operation,
    targetKind,
    sourceRequired: requirements.sourceRequired,
    approvalRequired: requirements.approvalRequired,
    systemActorOnly: requirements.systemActorOnly === true,
  });

const APPROVED = { sourceRequired: true, approvalRequired: true } as const;
const SYSTEM_ONLY = { sourceRequired: true, approvalRequired: false, systemActorOnly: true } as const;

/**
 * The frozen governed-mutation kind registry. Every event kind declares its
 * exact target kind and both requirement booleans explicitly; producers and
 * both database dialects fail closed on any kind, target, or requirement pair
 * that is not listed here verbatim. Extending this registry requires a new
 * migration pair that re-freezes the database-side registry triggers.
 */
export const GOVERNED_MUTATION_KINDS: readonly GovernedMutationKindDeclaration[] = Object.freeze([
  kind("memory", "item_updated", "memory_item", APPROVED),
  kind("memory", "pin_changed", "memory_item", APPROVED),
  kind("memory", "ttl_changed", "memory_item", APPROVED),
  kind("memory", "item_forgotten", "memory_item", APPROVED),
  kind("memory", "batch_mutated", "memory_batch", APPROVED),
  kind("memory", "maintenance_expired", "memory_item", SYSTEM_ONLY),
  kind("memory", "entity_created", "memory_entity", APPROVED),
  kind("memory", "entity_forgotten", "memory_entity", APPROVED),
  kind("memory", "relation_created", "memory_relation", APPROVED),
  kind("memory", "decision_created", "memory_decision", APPROVED),
  kind("memory", "decision_retrospective_added", "memory_decision", APPROVED),
  kind("memory", "decision_forgotten", "memory_decision", APPROVED),
  kind("memory", "learning_created", "memory_learning", APPROVED),
  kind("memory", "learning_superseded", "memory_learning", APPROVED),
  kind("memory", "learning_forgotten", "memory_learning", APPROVED),
  kind("memory", "trace_candidate_promoted", "memory_learning", APPROVED),
  kind("memory", "session_learned_updated", "session_learned_memory", APPROVED),
  kind("skill_state", "enabled", "skill", APPROVED),
  kind("skill_state", "disabled", "skill", APPROVED),
  kind("skill_state", "slept", "skill", APPROVED),
  kind("skill_state", "auto_set", "skill", APPROVED),
  kind("skill_state", "activation_policy_updated", "skill_activation_policy", APPROVED),
  kind("skill_state", "system_disabled", "skill", SYSTEM_ONLY),
  kind("capability_state", "proposal_created", "capability_proposal", {
    sourceRequired: true,
    approvalRequired: false,
  }),
  kind("capability_state", "candidate_promoted", "capability_candidate", APPROVED),
  kind("capability_state", "candidate_revoked", "capability_candidate", APPROVED),
  kind("capability_state", "candidate_rolled_back", "capability_candidate", APPROVED),
  kind("capability_state", "system_revoked", "capability_candidate", SYSTEM_ONLY),
  kind("improvement", "activation_applied", "improvement_activation", APPROVED),
  kind("improvement", "activation_paused", "improvement_activation", APPROVED),
  kind("improvement", "activation_rolled_back", "improvement_activation", APPROVED),
  kind("improvement", "activation_failed", "improvement_activation", APPROVED),
]);

const KIND_INDEX = new Map<string, GovernedMutationKindDeclaration>(
  GOVERNED_MUTATION_KINDS.map((declaration) => [`${declaration.domain}:${declaration.operation}`, declaration]),
);

/** Fail-closed registry lookup; unknown kinds are never inferred or defaulted. */
export function governedMutationKind(domain: string, operation: string): GovernedMutationKindDeclaration {
  const declaration = KIND_INDEX.get(`${domain}:${operation}`);
  if (!declaration) {
    throw new TypeError(`Governed mutation kind ${domain}:${operation} is not in the frozen registry.`);
  }
  return declaration;
}

export function findGovernedMutationKind(
  domain: string,
  operation: string,
): GovernedMutationKindDeclaration | undefined {
  return KIND_INDEX.get(`${domain}:${operation}`);
}

/**
 * Canonical-material fingerprint: the SHA-256 of the versioned canonical JSON
 * envelope around bounded, content-free material. Producers must fingerprint
 * hashes and durable references, never raw protected content; the bounded
 * metadata assertion rejects oversized or content-bearing payloads.
 */
export function computeGovernedMutationMaterialSha256(material: Record<string, unknown>): string {
  assertBoundedGovernanceMetadata(material, "governed mutation material");
  return createHash("sha256")
    .update(canonicalJsonString({ version: GOVERNED_MUTATION_MATERIAL_VERSION, material }), "utf8")
    .digest("hex");
}

export interface GovernedLifecycleEventRecord {
  schemaVersion: typeof GOVERNED_LIFECYCLE_EVENT_VERSION;
  eventId: string;
  idempotencyKey: string;
  domain: GovernedMutationDomain;
  operation: GovernedMutationOperation;
  targetKind: GovernedMutationTargetKind;
  targetId: string;
  materialSha256: string;
  scopeKind: GovernedMutationScopeKind;
  workspaceId?: string;
  actorId: string;
  actorType: GovernedMutationActorType;
  sessionId?: string;
  turnId?: string;
  sourceRequired: boolean;
  approvalRequired: boolean;
  sourceKind?: string;
  sourceId?: string;
  approvalId?: string;
  occurredAt: string;
  recordedAt: string;
}

const REQUIRED_EVENT_KEYS = [
  "schemaVersion",
  "eventId",
  "idempotencyKey",
  "domain",
  "operation",
  "targetKind",
  "targetId",
  "materialSha256",
  "scopeKind",
  "actorId",
  "actorType",
  "sourceRequired",
  "approvalRequired",
  "occurredAt",
  "recordedAt",
] as const;

const OPTIONAL_EVENT_KEYS = ["workspaceId", "sessionId", "turnId", "sourceKind", "sourceId", "approvalId"] as const;

export function assertGovernedLifecycleEventRecord(value: unknown): asserts value is GovernedLifecycleEventRecord {
  if (!isRecord(value)) throw new TypeError("Governed lifecycle event must be an object.");
  if (value.schemaVersion !== GOVERNED_LIFECYCLE_EVENT_VERSION) {
    throw new TypeError("Unsupported governed lifecycle event schema version.");
  }
  assertExactKeys(value, REQUIRED_EVENT_KEYS, OPTIONAL_EVENT_KEYS);
  const input = value as unknown as GovernedLifecycleEventRecord;
  assertCanonicalIdentity(input.eventId, "event ID", 256);
  assertCanonicalIdentity(input.idempotencyKey, "idempotency key", 512);
  const declaration = governedMutationKind(String(input.domain), String(input.operation));
  if (input.targetKind !== declaration.targetKind) {
    throw new TypeError(
      `Governed mutation ${declaration.domain}:${declaration.operation} targets ${declaration.targetKind}, not ${String(input.targetKind)}.`,
    );
  }
  assertCanonicalIdentity(input.targetId, "target ID", 256);
  assertSha256(input.materialSha256, "material");
  if (input.scopeKind === "workspace") {
    assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
  } else if (input.scopeKind === "global") {
    if (input.workspaceId !== undefined) {
      throw new TypeError("Global governed lifecycle events cannot claim a workspace ID.");
    }
  } else {
    throw new TypeError("Unsupported governed lifecycle scope kind.");
  }
  assertCanonicalIdentity(input.actorId, "actor ID", 256);
  if (input.actorType !== "operator" && input.actorType !== "system" && input.actorType !== "approval_effect") {
    throw new TypeError("Unsupported governed lifecycle actor type.");
  }
  if (declaration.systemActorOnly && input.actorType !== "system") {
    throw new TypeError(
      `Governed mutation ${declaration.domain}:${declaration.operation} requires unforgeable system actor authority.`,
    );
  }
  assertOptionalCanonicalIdentity(input.sessionId, "session ID", 256);
  assertOptionalCanonicalIdentity(input.turnId, "turn ID", 256);
  if (input.turnId !== undefined && input.sessionId === undefined) {
    throw new TypeError("Governed lifecycle turn linkage requires a session ID.");
  }
  if (input.sourceRequired !== declaration.sourceRequired || input.approvalRequired !== declaration.approvalRequired) {
    throw new TypeError(
      `Governed mutation ${declaration.domain}:${declaration.operation} must declare sourceRequired=${String(declaration.sourceRequired)} and approvalRequired=${String(declaration.approvalRequired)} exactly.`,
    );
  }
  if (input.sourceRequired) {
    assertCanonicalIdentity(input.sourceKind, "source kind", 128);
    assertCanonicalIdentity(input.sourceId, "source ID", 256);
  } else {
    assertOptionalCanonicalIdentity(input.sourceKind, "source kind", 128);
    assertOptionalCanonicalIdentity(input.sourceId, "source ID", 256);
    if ((input.sourceKind === undefined) !== (input.sourceId === undefined)) {
      throw new TypeError("Governed lifecycle source kind and source ID must be declared together.");
    }
  }
  if (input.approvalRequired) {
    assertCanonicalIdentity(input.approvalId, "approval ID", 256);
  } else if (input.approvalId !== undefined) {
    throw new TypeError("Governed mutations that do not require approval cannot carry an approval ID.");
  }
  assertCanonicalTimestamp(input.occurredAt, "occurred-at");
  assertCanonicalTimestamp(input.recordedAt, "recorded-at");
}

export function isGovernedLifecycleEventRecord(value: unknown): value is GovernedLifecycleEventRecord {
  try {
    assertGovernedLifecycleEventRecord(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Approval vocabulary for the P1-P3 governed lifecycle effects (types only;
// worker wiring is P5). The union members live in `approvals.ts`.
// ---------------------------------------------------------------------------

export const MEMORY_LIFECYCLE_APPROVAL_KIND = "memory.lifecycle" as const;
export const SKILL_LIFECYCLE_APPROVAL_KIND = "skill.lifecycle" as const;
export const CAPABILITY_LIFECYCLE_APPROVAL_KIND = "capability.lifecycle" as const;
export const IMPROVEMENT_LIFECYCLE_APPROVAL_KIND = "improvement.lifecycle" as const;

export const MEMORY_LIFECYCLE_EFFECT_KIND = "memory_lifecycle_apply" as const;
export const SKILL_LIFECYCLE_EFFECT_KIND = "skill_lifecycle_apply" as const;
export const CAPABILITY_LIFECYCLE_EFFECT_KIND = "capability_lifecycle_apply" as const;
export const IMPROVEMENT_LIFECYCLE_EFFECT_KIND = "improvement_lifecycle_apply" as const;

export const MEMORY_LIFECYCLE_EFFECT_TARGET_KIND = "memory_record" as const;
export const SKILL_LIFECYCLE_EFFECT_TARGET_KIND = "skill_state" as const;
export const CAPABILITY_LIFECYCLE_EFFECT_TARGET_KIND = "capability_candidate" as const;
export const IMPROVEMENT_LIFECYCLE_EFFECT_TARGET_KIND = "improvement_operation" as const;

// ---------------------------------------------------------------------------
// Improvement intent/inspection/settlement state machine (HX-402 P0).
// External effects are NEVER database-atomic: the durable operation rows are
// the crash-recovery truth, and success is only ever concluded from an exact
// post-callback re-inspection, never from an attempted callback.
// ---------------------------------------------------------------------------

export type ImprovementLifecycleOperationKind = "activate" | "pause" | "rollback";

export type ImprovementLifecycleTargetKind = "improvement_activation" | "improvement_candidate";

export type ImprovementLifecycleInspectionDisposition = "matches_intent" | "diverged" | "unreachable";

export type ImprovementLifecycleSettlementDisposition = "applied" | "failed" | "aborted";

export interface ImprovementLifecycleOperationRecord {
  operationId: string;
  idempotencyKey: string;
  workspaceId: string;
  operationKind: ImprovementLifecycleOperationKind;
  targetKind: ImprovementLifecycleTargetKind;
  targetId: string;
  /** Fresh approval per operation; a later mutation can never reuse it. */
  approvalId: string;
  requestSha256: string;
  actorId: string;
  sessionId?: string;
  turnId?: string;
  createdAt: string;
}

export interface ImprovementLifecycleClaimRecord {
  operationId: string;
  claimGeneration: number;
  workerId: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface ImprovementLifecycleInspectionRecord {
  inspectionId: string;
  operationId: string;
  claimGeneration: number;
  observedStateSha256: string;
  disposition: ImprovementLifecycleInspectionDisposition;
  observedAt: string;
}

export interface ImprovementLifecycleSettlementRecord {
  settlementId: string;
  operationId: string;
  claimGeneration: number;
  inspectionId: string;
  disposition: ImprovementLifecycleSettlementDisposition;
  observedStateSha256: string;
  result: Record<string, unknown>;
  resultSha256: string;
  settledAt: string;
}

export function isImprovementLifecycleOperationKind(value: unknown): value is ImprovementLifecycleOperationKind {
  return value === "activate" || value === "pause" || value === "rollback";
}

export function isImprovementLifecycleTargetKind(value: unknown): value is ImprovementLifecycleTargetKind {
  return value === "improvement_activation" || value === "improvement_candidate";
}

export function isImprovementLifecycleInspectionDisposition(
  value: unknown,
): value is ImprovementLifecycleInspectionDisposition {
  return value === "matches_intent" || value === "diverged" || value === "unreachable";
}

export function isImprovementLifecycleSettlementDisposition(
  value: unknown,
): value is ImprovementLifecycleSettlementDisposition {
  return value === "applied" || value === "failed" || value === "aborted";
}

/**
 * The exact intent digest. The generated approval ID is the immutable parent
 * linkage; excluding it lets the exact request be hashed before the approval
 * repository allocates that ID, while intent creation still verifies the
 * one-to-one approval binding.
 */
export function computeImprovementLifecycleRequestSha256(
  input: Omit<ImprovementLifecycleOperationRecord, "requestSha256" | "approvalId">,
): string {
  return createHash("sha256").update(canonicalJsonString(input), "utf8").digest("hex");
}

export function computeImprovementLifecycleResultSha256(result: Record<string, unknown>): string {
  assertBoundedGovernanceMetadata(result, "improvement lifecycle result");
  return createHash("sha256").update(canonicalJsonString(result), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Local bounded-identity helpers (Journey conventions).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): void {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`Governed lifecycle event is missing required key '${key}'.`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Governed lifecycle event carries unsupported key '${key}'.`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`Governed lifecycle ${label} hash must be SHA-256 hex.`);
  }
}

function assertOptionalCanonicalIdentity(value: string | undefined, label: string, maxLength: number): void {
  if (value !== undefined) assertCanonicalIdentity(value, label, maxLength);
}

function assertCanonicalIdentity(value: string | undefined, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError(`Governed lifecycle ${label} is missing or too long.`);
  }
  if (value !== value.normalize("NFKC").trim()) {
    throw new TypeError(`Governed lifecycle ${label} must use its canonical identity form.`);
  }
}

function assertCanonicalTimestamp(value: unknown, label: string): asserts value is string {
  const canonical = (() => {
    try {
      return typeof value === "string" && new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  })();
  if (!canonical) throw new TypeError(`Governed lifecycle ${label} must be a canonical ISO timestamp.`);
}
