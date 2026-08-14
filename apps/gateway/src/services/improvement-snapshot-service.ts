import { createHash } from "node:crypto";
import type { ImprovementRef } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { AutonomyControlService } from "./autonomy-control-service.js";
import type { SkillMutationService, SkillMutationSnapshot } from "./skill-mutation-service.js";
import { IMPROVEMENT_TUNE_SETTING_KEYS } from "./improvement-tune-reads.js";

/**
 * Self-improvement snapshot / apply / restore (B8c extraction): the governed
 * write paths behind improvement-service activation changes — repair-policy and
 * routing-policy maps in system settings, plus S2 skill self-authoring through
 * SkillMutationService. Verbatim moves from GatewayService behind a narrow
 * deps port; the improvement-service and autonomy-control wiring closures are
 * the only callers.
 */

const IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY = "improvement_repair_policy_config_v1";
const IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY = "improvement_routing_policy_config_v1";

export interface ImprovementSnapshotDeps {
  storage: { systemSettings: Pick<Storage["systemSettings"], "get" | "set"> };
  skillMutation: Pick<
    SkillMutationService,
    "captureSnapshotFor" | "applySkillMutation" | "promoteSelfAuthoredSkill" | "restoreSnapshot"
  >;
  isFeatureEnabled(flag: "autonomyV1Disabled"): Promise<boolean>;
  /** Lazily resolved in the gateway wiring: autonomy-control is constructed after improvement. */
  recordAutonomousMutation: AutonomyControlService["recordAutonomousMutation"];
}

export async function captureRepairPolicySnapshot(
  deps: ImprovementSnapshotDeps,
  targetKey: string,
): Promise<ImprovementRef> {
  return await captureImprovementPolicySnapshot(
    deps,
    IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY,
    "repair_policy_snapshot",
    targetKey,
  );
}

export function applyRepairPolicyCandidate(
  deps: ImprovementSnapshotDeps,
  targetKey: string,
  revisionRef: ImprovementRef,
): Promise<ImprovementRef> {
  return applyImprovementPolicyCandidate(
    deps,
    IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY,
    "repair_policy_config",
    targetKey,
    revisionRef,
  );
}

export async function restoreRepairPolicySnapshot(
  deps: ImprovementSnapshotDeps,
  snapshotRef: ImprovementRef,
): Promise<void> {
  await restoreImprovementPolicySnapshot(deps, IMPROVEMENT_REPAIR_POLICY_CONFIG_SETTING_KEY, snapshotRef);
}

export async function captureRoutingPolicySnapshot(
  deps: ImprovementSnapshotDeps,
  targetKey: string,
): Promise<ImprovementRef> {
  const tuneSettingKey = decisionTuneSettingKey(targetKey);
  if (tuneSettingKey) {
    const stored = await deps.storage.systemSettings.get<unknown>(tuneSettingKey);
    return {
      refType: "routing_policy_snapshot",
      refId: targetKey,
      hash: createHash("sha1")
        .update(JSON.stringify({ present: Boolean(stored), value: stored?.value }))
        .digest("hex"),
      metadata: {
        decisionTune: true,
        settingKey: tuneSettingKey,
        targetKey,
        present: Boolean(stored),
        previousValue: stored?.value,
      },
    };
  }
  return await captureImprovementPolicySnapshot(
    deps,
    IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY,
    "routing_policy_snapshot",
    targetKey,
  );
}

export function applyRoutingPolicyCandidate(
  deps: ImprovementSnapshotDeps,
  targetKey: string,
  revisionRef: ImprovementRef,
): Promise<ImprovementRef> {
  const tuneSettingKey = decisionTuneSettingKey(targetKey);
  if (tuneSettingKey) {
    return applyDecisionTuneCandidate(deps, targetKey, tuneSettingKey, revisionRef);
  }
  return applyImprovementPolicyCandidate(
    deps,
    IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY,
    "routing_policy_config",
    targetKey,
    revisionRef,
  );
}

export async function restoreRoutingPolicySnapshot(
  deps: ImprovementSnapshotDeps,
  snapshotRef: ImprovementRef,
): Promise<void> {
  const metadata = isRecord(snapshotRef.metadata) ? snapshotRef.metadata : {};
  if (metadata.decisionTune === true) {
    const settingKey = decisionTuneSettingKey(String(metadata.targetKey ?? snapshotRef.refId));
    if (!settingKey || metadata.settingKey !== settingKey) {
      throw new Error("Decision-tune rollback material does not match an allowlisted runtime setting.");
    }
    await deps.storage.systemSettings.set(settingKey, metadata.present === true ? metadata.previousValue : null);
    return;
  }
  await restoreImprovementPolicySnapshot(deps, IMPROVEMENT_ROUTING_POLICY_CONFIG_SETTING_KEY, snapshotRef);
}

// ── S2: skill self-authoring activation callbacks ─────────────────────────
// These delegate to SkillMutationService. They are the governed write path for
// skill_revision candidates flowing through improvement-service
// applyActivationChange. isSkillCallable is never bypassed: the candidate is
// written non-callable, and promotion to `approved` happens only under master
// autonomy and only through this recorded, reversible activation.

export async function captureSkillRevisionSnapshot(
  deps: ImprovementSnapshotDeps,
  targetKey: string,
  revisionRef: ImprovementRef,
): Promise<ImprovementRef> {
  const { skillId, skillMarkdown } = readSkillRevisionRef(targetKey, revisionRef);
  const snapshot = await deps.skillMutation.captureSnapshotFor({ skillId, skillMarkdown });
  // NOTE: the unified autonomy-audit entry is intentionally NOT appended here.
  // This snapshot is captured at PROPOSAL time (an approval is then created and
  // the apply happens only later, after approval — or never). Recording the
  // audit now would leave a phantom entry for a mutation that never landed
  // (rejected/expired approval, or a throwing apply), which revertAutonomous-
  // ChangesSince would then "restore". The audit is appended in
  // applySkillRevisionCandidate AFTER the write actually succeeds.
  return buildSkillRevisionSnapshotRef(snapshot, targetKey);
}

/** Build the value-carrying snapshot ref consumed by restoreSkillRevisionSnapshot. */
function buildSkillRevisionSnapshotRef(snapshot: SkillMutationSnapshot, targetKey: string): ImprovementRef {
  return {
    refType: "skill_revision_snapshot",
    refId: snapshot.skillId,
    hash: createHash("sha1").update(JSON.stringify(snapshot)).digest("hex"),
    metadata: {
      targetKey,
      skillId: snapshot.skillId,
      snapshot: snapshot as unknown as Record<string, unknown>,
    },
  };
}

export async function applySkillRevisionCandidate(
  deps: ImprovementSnapshotDeps,
  targetKey: string,
  revisionRef: ImprovementRef,
): Promise<ImprovementRef> {
  const { skillId, skillMarkdown, evaluationRunId, sourceTurnId, summary } = readSkillRevisionRef(
    targetKey,
    revisionRef,
  );
  if (!skillMarkdown) {
    throw new Error(`Skill revision ${targetKey} is missing skill content; refusing to apply an empty mutation.`);
  }
  // Capture the prior state immediately BEFORE the write so the audit restoreRef
  // carries the correct pre-mutation bytes (the proposal-time snapshot is on the
  // activation rail; this one backs the unified autonomy-audit ledger).
  const priorSnapshot = await deps.skillMutation.captureSnapshotFor({ skillId, skillMarkdown });
  // Validate + security-scan + secret-block + jail-write as non-callable candidate.
  const result = await deps.skillMutation.applySkillMutation({
    skillMarkdown,
    skillId,
    evaluationRunId,
    sourceTurnId,
    summary,
  });
  // Full autonomy: promote to a callable `approved` state ONLY when the master
  // autonomy switch is engaged. When off, the skill stays a non-callable
  // `candidate` (pure proposal mode). Promotion is reversible by the snapshot.
  const autonomyEnabled = !(await deps.isFeatureEnabled("autonomyV1Disabled"));
  const lifecycle = autonomyEnabled
    ? await deps.skillMutation.promoteSelfAuthoredSkill(result.skillId)
    : result.lifecycle;
  // Unified audit: append ONLY now that the write (and any promote) has
  // succeeded, so a failed/blocked apply never leaves a phantom ledger entry.
  // The snapshot ref is value-carrying (prior bytes inline) and is exactly what
  // restoreSkillRevisionSnapshot consumes. Best-effort; never blocks the apply.
  await deps
    .recordAutonomousMutation({
      kind: "skill_revision",
      targetKey: result.skillId,
      restoreRef: { kind: "skill_revision", snapshotRef: buildSkillRevisionSnapshotRef(priorSnapshot, targetKey) },
    })
    .catch(() => undefined);
  return {
    refType: "skill_revision_config",
    refId: result.skillId,
    hash: result.changeHash,
    metadata: {
      targetKey,
      skillId: result.skillId,
      lifecycleState: lifecycle.lifecycleState,
      autoPromoted: autonomyEnabled,
      callable: lifecycle.lifecycleState === "approved" || lifecycle.lifecycleState === "trusted",
    },
  };
}

export async function restoreSkillRevisionSnapshot(
  deps: ImprovementSnapshotDeps,
  snapshotRef: ImprovementRef,
): Promise<void> {
  const metadata = isRecord(snapshotRef.metadata) ? snapshotRef.metadata : {};
  const snapshot = metadata.snapshot;
  if (!isRecord(snapshot) || typeof snapshot.skillId !== "string") {
    throw new Error("Skill revision snapshot is missing its captured state; cannot restore.");
  }
  await deps.skillMutation.restoreSnapshot(snapshot as unknown as SkillMutationSnapshot);
}

function readSkillRevisionRef(
  targetKey: string,
  revisionRef: ImprovementRef,
): {
  skillId?: string;
  skillMarkdown?: string;
  evaluationRunId?: string;
  sourceTurnId?: string;
  summary?: string;
} {
  const metadata = isRecord(revisionRef.metadata) ? revisionRef.metadata : {};
  const proposed = isRecord(metadata.proposedChange) ? metadata.proposedChange : {};
  const readString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const skillMarkdown =
    readString(metadata.skillMarkdown) ??
    readString(metadata.skillContent) ??
    readString(proposed.skillMarkdown) ??
    readString(proposed.skillContent);
  const skillId =
    readString(metadata.skillId) ??
    readString(proposed.skillId) ??
    readString(targetKey.startsWith("skill:") ? targetKey.slice("skill:".length) : undefined);
  return {
    skillId,
    skillMarkdown,
    evaluationRunId: readString(metadata.evaluationRunId) ?? readString(proposed.evaluationRunId),
    sourceTurnId: readString(metadata.sourceTurnId) ?? readString(proposed.sourceTurnId),
    summary: readString(metadata.summary) ?? readString(proposed.skillName) ?? readString(proposed.title),
  };
}

async function captureImprovementPolicySnapshot(
  deps: ImprovementSnapshotDeps,
  settingKey: string,
  refType: ImprovementRef["refType"],
  targetKey: string,
): Promise<ImprovementRef> {
  const policies = await readImprovementPolicyMap(deps, settingKey);
  const hadValue = Object.prototype.hasOwnProperty.call(policies, targetKey);
  const previousValue = hadValue ? policies[targetKey] : null;
  return {
    refType,
    refId: targetKey,
    hash: createHash("sha1").update(JSON.stringify({ hadValue, previousValue })).digest("hex"),
    metadata: {
      settingKey,
      targetKey,
      hadValue,
      previousValue,
    },
  };
}

async function applyImprovementPolicyCandidate(
  deps: ImprovementSnapshotDeps,
  settingKey: string,
  refType: ImprovementRef["refType"],
  targetKey: string,
  revisionRef: ImprovementRef,
): Promise<ImprovementRef> {
  const policies = await readImprovementPolicyMap(deps, settingKey);
  const proposedChange = isRecord(revisionRef.metadata) ? revisionRef.metadata.proposedChange : undefined;
  const nextValue = proposedChange ?? revisionRef.metadata ?? {};
  await writeImprovementPolicyMap(deps, settingKey, {
    ...policies,
    [targetKey]: nextValue,
  });
  return {
    refType,
    refId: targetKey,
    hash: createHash("sha1").update(JSON.stringify(nextValue)).digest("hex"),
    metadata: {
      settingKey,
      targetKey,
      appliedValue: nextValue,
    },
  };
}

async function restoreImprovementPolicySnapshot(
  deps: ImprovementSnapshotDeps,
  expectedSettingKey: string,
  snapshotRef: ImprovementRef,
): Promise<void> {
  const metadata = isRecord(snapshotRef.metadata) ? snapshotRef.metadata : {};
  const settingKey =
    typeof metadata.settingKey === "string" && metadata.settingKey.trim().length > 0
      ? metadata.settingKey
      : expectedSettingKey;
  const targetKey = typeof metadata.targetKey === "string" ? metadata.targetKey : snapshotRef.refId;
  const hadValue = metadata.hadValue === true;
  const policies = await readImprovementPolicyMap(deps, settingKey);
  const next = { ...policies };
  if (hadValue) {
    next[targetKey] = metadata.previousValue;
  } else {
    delete next[targetKey];
  }
  await writeImprovementPolicyMap(deps, settingKey, next);
}

async function readImprovementPolicyMap(
  deps: ImprovementSnapshotDeps,
  settingKey: string,
): Promise<Record<string, unknown>> {
  const stored = (await deps.storage.systemSettings.get<unknown>(settingKey))?.value;
  return isRecord(stored) ? { ...stored } : {};
}

async function writeImprovementPolicyMap(
  deps: ImprovementSnapshotDeps,
  settingKey: string,
  next: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(next).length === 0) {
    await deps.storage.systemSettings.set(settingKey, null);
    return;
  }
  await deps.storage.systemSettings.set(settingKey, next);
}

async function applyDecisionTuneCandidate(
  deps: ImprovementSnapshotDeps,
  targetKey: string,
  settingKey: string,
  revisionRef: ImprovementRef,
): Promise<ImprovementRef> {
  const metadata = isRecord(revisionRef.metadata) ? revisionRef.metadata : {};
  const proposed = isRecord(metadata.proposedChange) ? metadata.proposedChange : {};
  if (proposed.strategy !== "decision_tune" || proposed.settingKey !== settingKey) {
    throw new Error("Decision-tune candidate revision is not bound to its allowlisted target.");
  }
  const nextValue = validateDecisionTuneValue(settingKey, proposed.nextValue);
  await deps.storage.systemSettings.set(settingKey, nextValue);
  return {
    refType: "routing_policy_config",
    refId: targetKey,
    hash: createHash("sha1").update(JSON.stringify(nextValue)).digest("hex"),
    metadata: { decisionTune: true, settingKey, targetKey, appliedValue: nextValue },
  };
}

function decisionTuneSettingKey(targetKey: string): string | undefined {
  const prefix = "decision_tune:";
  if (!targetKey.startsWith(prefix)) return undefined;
  const requested = targetKey.slice(prefix.length);
  const settingKey = Object.values(IMPROVEMENT_TUNE_SETTING_KEYS).find((candidate) => candidate === requested);
  if (!settingKey) {
    throw new Error("Decision-tune target is not an allowlisted runtime setting.");
  }
  return settingKey;
}

function validateDecisionTuneValue(settingKey: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Decision-tune candidate value must be a finite number.");
  }
  if (
    settingKey === IMPROVEMENT_TUNE_SETTING_KEYS.blockerTemplate &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10
  ) {
    return value;
  }
  if (
    settingKey === IMPROVEMENT_TUNE_SETTING_KEYS.retryThreshold &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 10
  ) {
    return value;
  }
  if (settingKey === IMPROVEMENT_TUNE_SETTING_KEYS.liveIntentThreshold && value >= 0 && value <= 1) {
    return value;
  }
  throw new Error("Decision-tune candidate value is outside its allowlisted range.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
