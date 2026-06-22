/**
 * Operator profile service (P2-S4b).
 *
 * Owns the cross-session operator profile: a durable, workspace-scoped model of
 * the operator's standing preferences, recurring goals, and constraints. It is
 * GoatCitadel's "deepening model of who you are" — persisted across sessions and
 * injected once per session as a frozen, compact USER.md-style snapshot (the
 * `memoryDigest` of the P0-A base prompt).
 *
 * Three responsibilities:
 *   - {@link OperatorProfileService.ensureOperatorProfile} — lazily create the
 *     profile and stamp its id onto `WorkspacePrefs.operatorProfileId`.
 *   - {@link OperatorProfileService.composeFrozenProfileDigest} — build the frozen
 *     snapshot, cached by `workspaceId + revision` so it is byte-stable within a
 *     session (it does not bust the P0-A cache prefix mid-session) and cheap
 *     (no model call on the hot path). Secrets are always stripped.
 *   - {@link OperatorProfileService.recordOperatorProfileFacts} — durable,
 *     cross-session write routed through the memory write gate: secrets blocked,
 *     agent-proposed facts stay proposed unless full autonomy is on, and the
 *     prior revision is snapshotted for rollback.
 *
 * Safety: profile injection is read-only; writes are reversible (prior snapshot
 * captured); secrets are blocked regardless of autonomy; auto-apply respects the
 * master autonomy kill switch (`autonomyV1Disabled`).
 */
import type {
  MemoryWriteAuthority,
  OperatorProfileFact,
  OperatorProfileRecord,
} from "@goatcitadel/contracts";
import {
  MAX_OPERATOR_PROFILE_FACT_LENGTH,
  MAX_OPERATOR_PROFILE_FACTS,
  MAX_OPERATOR_PROFILE_SUMMARY_LENGTH,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { createOperatorProfileId } from "@goatcitadel/storage";
import { MemoryWriteGateService } from "./memory-write-gate-service.js";

type OperatorProfileStorage = Pick<Storage, "operatorProfiles" | "workspaces">;

export interface OperatorProfileServiceDeps {
  storage: OperatorProfileStorage;
  /** Reuse the master autonomy kill switch (`autonomyV1Disabled`). */
  isFeatureEnabled(flag: string): boolean;
  /** Optional injectable gate (defaults to a fresh stateless instance). */
  memoryWriteGate?: MemoryWriteGateService;
  /** Optional clock for deterministic tests. */
  now?: () => string;
}

export interface RecordOperatorProfileFactsInput {
  facts: OperatorProfileFact[];
  /** Defaults to `agent_proposed` (the S1 fork / extraction path). */
  authority?: MemoryWriteAuthority;
}

export interface RecordOperatorProfileFactsResult {
  /** The profile after the write (unchanged on a fully-blocked/empty write). */
  record: OperatorProfileRecord;
  /** `applied` ⇒ persisted now; `proposed` ⇒ held pending review (not persisted). */
  outcome: "applied" | "proposed";
  /** Facts dropped because they tripped the secret block. */
  blockedFacts: OperatorProfileFact[];
  /** Snapshot of the profile before this write, when a write actually applied. */
  priorSnapshot?: OperatorProfileRecord;
  /** Facts being held for review when `outcome === "proposed"`. */
  proposedFacts?: OperatorProfileFact[];
}

interface CachedDigest {
  revision: number;
  digest: string;
}

export class OperatorProfileService {
  private readonly storage: OperatorProfileStorage;
  private readonly isFeatureEnabled: (flag: string) => boolean;
  private readonly gate: MemoryWriteGateService;
  private readonly now: () => string;
  /** Frozen-digest cache keyed by workspaceId → {revision, digest}. */
  private readonly digestCache = new Map<string, CachedDigest>();

  public constructor(deps: OperatorProfileServiceDeps) {
    this.storage = deps.storage;
    this.isFeatureEnabled = deps.isFeatureEnabled;
    this.gate = deps.memoryWriteGate ?? new MemoryWriteGateService();
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Ensure a profile exists for the workspace and that
   * `WorkspacePrefs.operatorProfileId` points at it. Idempotent. Returns the
   * profile record. First use creates an empty profile (revision 1) and stamps
   * its id onto the workspace prefs.
   */
  public ensureOperatorProfile(workspaceId: string): OperatorProfileRecord {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const workspace = this.storage.workspaces.find(normalizedWorkspaceId);
    const stampedId = workspace?.workspacePrefs?.operatorProfileId;

    if (stampedId) {
      const existing = this.storage.operatorProfiles.get(stampedId);
      if (existing) {
        return existing;
      }
      // Prefs point at a missing profile (e.g. partial restore) — recreate under
      // the stamped id so the pointer stays valid.
      return this.storage.operatorProfiles.upsert(
        { operatorProfileId: stampedId, workspaceId: normalizedWorkspaceId, summary: "", facts: [] },
        this.now(),
      );
    }

    // No pointer yet. Reuse a profile already keyed to this workspace if present,
    // else create a fresh one; then stamp the id onto prefs (when the workspace exists).
    const byWorkspace = this.storage.operatorProfiles.getByWorkspace(normalizedWorkspaceId);
    const profile =
      byWorkspace ??
      this.storage.operatorProfiles.upsert(
        { operatorProfileId: createOperatorProfileId(), workspaceId: normalizedWorkspaceId, summary: "", facts: [] },
        this.now(),
      );
    this.stampOperatorProfileId(normalizedWorkspaceId, profile.operatorProfileId);
    return profile;
  }

  /**
   * Compose the frozen, compact USER.md-style digest for the workspace. Cached by
   * `workspaceId + revision` so it is byte-stable for a session and recomputed
   * only when the profile changes. Returns `undefined` when there is nothing
   * useful to inject (no summary and no facts). Secrets are always stripped.
   */
  public composeFrozenProfileDigest(workspaceId: string): string | undefined {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const profile = this.readProfile(normalizedWorkspaceId);
    if (!profile) {
      return undefined;
    }

    const cached = this.digestCache.get(normalizedWorkspaceId);
    if (cached && cached.revision === profile.revision) {
      return cached.digest || undefined;
    }

    const digest = renderFrozenProfileDigest(profile, this.gate);
    this.digestCache.set(normalizedWorkspaceId, { revision: profile.revision, digest });
    return digest || undefined;
  }

  /**
   * Durable cross-session write of operator facts, gated for safety.
   *
   * Secrets are always blocked (dropped from the write). With full autonomy on
   * (master kill switch `autonomyV1Disabled` off) an agent-proposed write
   * auto-applies — still snapshotted + secret-filtered. With autonomy off the
   * write is held as `proposed` and NOT persisted. Trusted/operator authorities
   * always apply. Every applied write captures the prior revision for rollback.
   */
  public recordOperatorProfileFacts(
    workspaceId: string,
    input: RecordOperatorProfileFactsInput,
  ): RecordOperatorProfileFactsResult {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const authority: MemoryWriteAuthority = input.authority ?? "agent_proposed";
    const profile = this.ensureOperatorProfile(normalizedWorkspaceId);

    const accepted: OperatorProfileFact[] = [];
    const blockedFacts: OperatorProfileFact[] = [];
    let anyProposed = false;
    for (const fact of normalizeFacts(input.facts)) {
      const decision = this.gate.evaluate({ authority, content: fact.content });
      if (decision.decision === "blocked") {
        blockedFacts.push(fact);
        continue;
      }
      if (decision.decision === "proposed") {
        anyProposed = true;
        continue;
      }
      accepted.push(fact);
    }

    // The gate forces agent writes to `proposed` unless authority is trusted. Under
    // full autonomy we may apply them anyway (snapshotted + secret-filtered); with
    // autonomy off they stay proposed and unpersisted.
    const fullAutonomy = !this.isFeatureEnabled("autonomyV1Disabled");
    const applyProposed = anyProposed && fullAutonomy;
    const factsToApply = applyProposed
      ? [...accepted, ...this.filterSecretsForAutoApply(input.facts, blockedFacts)]
      : accepted;

    if (factsToApply.length === 0) {
      // Exclude blocked facts by CONTENT: `normalizeFacts` returns fresh objects
      // each call, so a reference check against `blockedFacts` never matches and
      // would leak a blocked (secret) fact into `proposedFacts`.
      const blockedContents = new Set(blockedFacts.map((fact) => fact.content));
      const proposedFacts = anyProposed
        ? normalizeFacts(input.facts).filter((fact) => !blockedContents.has(fact.content))
        : [];
      return {
        record: profile,
        outcome: proposedFacts.length > 0 ? "proposed" : "applied",
        blockedFacts,
        ...(proposedFacts.length > 0 ? { proposedFacts } : {}),
      };
    }

    const merged = mergeFacts(profile.facts, factsToApply);
    const write = this.storage.operatorProfiles.upsertCapturingPrior(
      {
        operatorProfileId: profile.operatorProfileId,
        workspaceId: normalizedWorkspaceId,
        summary: profile.summary,
        facts: merged,
      },
      this.now(),
    );
    // Revision changed ⇒ drop any stale cached digest for this workspace.
    this.digestCache.delete(normalizedWorkspaceId);

    return {
      record: write.record,
      outcome: "applied",
      blockedFacts,
      ...(write.priorSnapshot ? { priorSnapshot: write.priorSnapshot } : {}),
    };
  }

  /** Replace the prose summary (trusted path, e.g. the S1 fork). Snapshotted. */
  public setOperatorProfileSummary(workspaceId: string, summary: string): RecordOperatorProfileFactsResult {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
    const profile = this.ensureOperatorProfile(normalizedWorkspaceId);
    const decision = this.gate.evaluate({ authority: "trusted_lifecycle", content: summary });
    if (decision.decision === "blocked") {
      return { record: profile, outcome: "applied", blockedFacts: [] };
    }
    const write = this.storage.operatorProfiles.upsertCapturingPrior(
      {
        operatorProfileId: profile.operatorProfileId,
        workspaceId: normalizedWorkspaceId,
        summary: clampText(summary, MAX_OPERATOR_PROFILE_SUMMARY_LENGTH),
        facts: profile.facts,
      },
      this.now(),
    );
    this.digestCache.delete(normalizedWorkspaceId);
    return {
      record: write.record,
      outcome: "applied",
      blockedFacts: [],
      ...(write.priorSnapshot ? { priorSnapshot: write.priorSnapshot } : {}),
    };
  }

  /** Restore a captured snapshot (global "revert autonomous changes" support). */
  public restoreOperatorProfileSnapshot(snapshot: OperatorProfileRecord): OperatorProfileRecord {
    const restored = this.storage.operatorProfiles.restore(snapshot, this.now());
    this.digestCache.delete(normalizeWorkspaceId(restored.workspaceId));
    return restored;
  }

  private readProfile(workspaceId: string): OperatorProfileRecord | undefined {
    const stampedId = this.storage.workspaces.find(workspaceId)?.workspacePrefs?.operatorProfileId;
    if (stampedId) {
      const byId = this.storage.operatorProfiles.get(stampedId);
      if (byId) {
        return byId;
      }
    }
    return this.storage.operatorProfiles.getByWorkspace(workspaceId);
  }

  private stampOperatorProfileId(workspaceId: string, operatorProfileId: string): void {
    const workspace = this.storage.workspaces.find(workspaceId);
    if (!workspace) {
      // No workspace record (e.g. default-only / test fixture). The profile is
      // still keyed by workspaceId, so reads fall back to getByWorkspace.
      return;
    }
    const prefs = workspace.workspacePrefs ?? {};
    if (prefs.operatorProfileId === operatorProfileId) {
      return;
    }
    this.storage.workspaces.update(workspaceId, {
      workspacePrefs: { ...prefs, operatorProfileId },
    });
  }

  /**
   * Under full autonomy, agent facts that the gate flagged `proposed` (not
   * blocked) are applied, but anything secret-like is still dropped — the secret
   * block is absolute regardless of autonomy.
   */
  private filterSecretsForAutoApply(
    facts: OperatorProfileFact[],
    alreadyBlocked: OperatorProfileFact[],
  ): OperatorProfileFact[] {
    // Dedup by CONTENT, not reference: `normalizeFacts` produces new objects on
    // every call, so an identity `Set(alreadyBlocked)` never matches the
    // re-normalized facts and the already-blocked exclusion would silently no-op
    // (relying entirely on the operator-authority secret re-check below).
    const blockedContents = new Set(alreadyBlocked.map((fact) => fact.content));
    const out: OperatorProfileFact[] = [];
    for (const fact of normalizeFacts(facts)) {
      if (blockedContents.has(fact.content)) {
        continue;
      }
      const decision = this.gate.evaluate({ authority: "operator", content: fact.content });
      if (decision.decision === "blocked") {
        continue;
      }
      out.push(fact);
    }
    return out;
  }
}

const FACT_KIND_LABELS: Record<OperatorProfileFact["kind"], string> = {
  preference: "Preferences",
  goal: "Goals",
  constraint: "Constraints",
  fact: "Facts",
};

const FACT_KIND_ORDER: OperatorProfileFact["kind"][] = ["preference", "goal", "constraint", "fact"];

/**
 * Render the frozen USER.md-style digest. Bounded length, secrets stripped, facts
 * grouped by kind. Pure (no I/O) given the profile + gate.
 */
function renderFrozenProfileDigest(profile: OperatorProfileRecord, gate: MemoryWriteGateService): string {
  const sections: string[] = [];
  const summary = profile.summary.trim();
  if (summary && gate.evaluate({ authority: "operator", content: summary }).decision !== "blocked") {
    sections.push(clampText(summary, MAX_OPERATOR_PROFILE_SUMMARY_LENGTH));
  }

  const safeFacts = profile.facts
    .filter((fact) => fact.content.trim())
    .filter((fact) => gate.evaluate({ authority: "operator", content: fact.content }).decision !== "blocked")
    .slice(0, MAX_OPERATOR_PROFILE_FACTS);

  for (const kind of FACT_KIND_ORDER) {
    const ofKind = safeFacts.filter((fact) => fact.kind === kind);
    if (ofKind.length === 0) {
      continue;
    }
    const lines = ofKind.map((fact) => `- ${clampText(fact.content.trim(), MAX_OPERATOR_PROFILE_FACT_LENGTH)}`);
    sections.push(`${FACT_KIND_LABELS[kind]}:\n${lines.join("\n")}`);
  }

  if (sections.length === 0) {
    return "";
  }
  return ["Operator profile (durable; persists across sessions):", ...sections].join("\n\n");
}

function normalizeFacts(facts: OperatorProfileFact[]): OperatorProfileFact[] {
  if (!Array.isArray(facts)) {
    return [];
  }
  return facts
    .filter((fact) => fact && typeof fact.content === "string" && fact.content.trim())
    .map((fact) => ({
      kind: fact.kind,
      content: clampText(fact.content.trim(), MAX_OPERATOR_PROFILE_FACT_LENGTH),
      confidence: clamp01(fact.confidence),
      ...(typeof fact.sourceRef === "string" && fact.sourceRef.trim() ? { sourceRef: fact.sourceRef } : {}),
    }));
}

/**
 * Merge new facts into existing ones: dedupe on (kind, normalized content),
 * preferring the higher confidence; keep newest-first and bound the total.
 */
function mergeFacts(existing: OperatorProfileFact[], incoming: OperatorProfileFact[]): OperatorProfileFact[] {
  const byKey = new Map<string, OperatorProfileFact>();
  const keyOf = (fact: OperatorProfileFact): string => `${fact.kind}::${fact.content.trim().toLowerCase()}`;
  // Incoming first so new facts win order; existing fills in the rest.
  for (const fact of [...incoming, ...existing]) {
    if (!fact.content.trim()) {
      continue;
    }
    const key = keyOf(fact);
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, fact);
      continue;
    }
    if (fact.confidence > prior.confidence) {
      byKey.set(key, { ...prior, confidence: fact.confidence });
    }
  }
  return [...byKey.values()].slice(0, MAX_OPERATOR_PROFILE_FACTS);
}

function clampText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function normalizeWorkspaceId(workspaceId?: string): string {
  const trimmed = workspaceId?.trim();
  return trimmed || "default";
}
