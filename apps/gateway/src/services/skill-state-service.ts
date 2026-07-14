import { createHash, randomUUID } from "node:crypto";
import { isRecord } from "./companion-auth-helpers.js";
import type {
  SkillActivationPolicy,
  SkillImportValidationResult,
  SkillRuntimeState,
  SkillStateRecord,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

const SKILL_ACTIVATION_POLICY_SETTING_KEY = "skill_activation_policy_v1";
const SKILL_STATE_METADATA_SETTING_KEY = "skill_state_metadata_v1";
const SKILL_ACTIVATION_POLICY_AGGREGATE_ID = "global";
const DEFAULT_SKILL_ACTIVATION_POLICY: Omit<SkillActivationPolicy, "revision"> = {
  guardedAutoThreshold: 0.72,
  requireFirstUseConfirmation: true,
};

type SkillActivationPolicyPatch = Partial<Omit<SkillActivationPolicy, "revision">>;
type PersistedSkillState = Omit<SkillStateRecord, "revision" | "pinned" | "usageCount" | "lastUsedAt">;

export interface SkillStateServiceCtx {
  gatewaySql: Storage["gatewaySql"];
  systemSettings: Pick<Storage["systemSettings"], "get" | "set">;
  skillAggregateRevisions: Storage["skillAggregateRevisions"];
}

/**
 * Host callbacks are lazy closures over the gateway so construction order does not
 * matter; they are only invoked at call time.
 */
export interface SkillStateServiceHost {
  /** Known skills for the setSkillState existence check. */
  listSkills(): Array<{ skillId: string }>;
  /** Unified autonomous-mutation audit (curator idle-archive snapshots). */
  recordAutonomousMutation(input: {
    kind: "curator_archive";
    targetKey: string;
    restoreRef: { kind: "curator_archive"; skillId: string };
  }): void;
  recordDevDiagnostic(input: {
    level: "warn";
    category: "cron";
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }): void;
}

/**
 * Owns the skill runtime-state substrate: the `skill_state` /
 * `skill_activation_events` tables, the system-settings-backed usage metadata and
 * activation policy, and the curator idle-archive snapshot/restore pair.
 * Extracted from GatewayService (B4).
 */
export class SkillStateService {
  constructor(
    private readonly ctx: SkillStateServiceCtx,
    private readonly host: SkillStateServiceHost,
  ) {}

  readSkillStates(): Map<string, SkillStateRecord> {
    const rows = this.readPersistedSkillStates();
    const metadata = this.readSkillStateMetadata();

    return new Map(
      [...rows.values()].map((row) => {
        const revision = this.ctx.skillAggregateRevisions.ensure("runtime_skill", row.skillId).revision;
        return [row.skillId, this.decorateSkillState(row, revision, metadata)] as const;
      }),
    );
  }

  private readPersistedSkillStates(): Map<string, PersistedSkillState> {
    const rows = toPersistedSkillStateRows(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT skill_id AS skillId, state, note, updated_at AS updatedAt, first_auto_approved_at AS firstAutoApprovedAt
      FROM skill_state
    `,
        )
        .all(),
    );
    return new Map(rows.map((row) => [row.skillId, row]));
  }

  ensureSkillStates(skillIds: string[]): void {
    const unique = [...new Set(skillIds)];
    const now = new Date().toISOString();
    const insert = this.ctx.gatewaySql.prepare(`
      INSERT INTO skill_state (skill_id, state, note, updated_at, first_auto_approved_at)
      VALUES (@skillId, @state, @note, @updatedAt, NULL)
      ON CONFLICT (skill_id) DO NOTHING
    `);
    for (const skillId of unique) {
      insert.run({
        skillId,
        state: "enabled",
        note: null,
        updatedAt: now,
      });
      this.ctx.skillAggregateRevisions.ensure("runtime_skill", skillId, now);
    }
  }

  setSkillState(
    skillId: string,
    state: SkillRuntimeState,
    note: string | undefined,
    expectedRevision: number,
  ): SkillStateRecord {
    const knownSkill = this.host.listSkills().find((skill) => skill.skillId === skillId);
    if (!knownSkill) {
      throw new NotFoundError({ entity: "skill", id: skillId });
    }
    const now = new Date().toISOString();
    const normalizedNote = normalizeSkillStateNote(note);
    const result = this.ctx.skillAggregateRevisions.runWithRevision(
      "runtime_skill",
      skillId,
      expectedRevision,
      () => {
        const currentState = this.readPersistedSkillStates().get(skillId);
        this.assertSkillStateMutationAllowed(skillId, state, currentState);
        if (currentState && currentState.state === state && currentState.note === normalizedNote) {
          return { value: currentState, changed: false };
        }
        const next = this.persistSkillState(skillId, state, normalizedNote, currentState, now);
        this.recordSkillStateEvent(skillId, state, normalizedNote, now);
        return { value: next, changed: true };
      },
      now,
    );
    return this.decorateSkillState(result.value, result.revision, this.readSkillStateMetadata());
  }

  bulkSetSkillState(
    skillIds: string[],
    state: SkillRuntimeState,
    note: string | undefined,
    expectedRevisionsBySkillId: Record<string, number>,
  ): SkillStateRecord[] {
    const uniqueIds = [...new Set(skillIds)].sort(compareCodeUnits);
    const knownSkillIds = new Set(this.host.listSkills().map((skill) => skill.skillId));
    for (const skillId of uniqueIds) {
      if (!knownSkillIds.has(skillId)) {
        throw new NotFoundError({ entity: "skill", id: skillId });
      }
      if (!Object.prototype.hasOwnProperty.call(expectedRevisionsBySkillId, skillId)) {
        throw new ValidationError({
          code: "FIELD_REQUIRED",
          field: `expectedRevisionsBySkillId.${skillId}`,
        });
      }
    }
    const unexpectedIds = Object.keys(expectedRevisionsBySkillId).filter((skillId) => !uniqueIds.includes(skillId));
    if (unexpectedIds.length > 0) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "expectedRevisionsBySkillId",
        message: `Unexpected skill revision entries: ${unexpectedIds.sort(compareCodeUnits).join(", ")}`,
      });
    }

    const normalizedNote = normalizeSkillStateNote(note);
    const now = new Date().toISOString();
    const result = this.ctx.skillAggregateRevisions.runWithRevisions(
      uniqueIds.map((skillId) => ({
        aggregateKind: "runtime_skill",
        aggregateId: skillId,
        expectedRevision: expectedRevisionsBySkillId[skillId]!,
      })),
      () => {
        const currentStates = this.readPersistedSkillStates();
        for (const skillId of uniqueIds) {
          this.assertSkillStateMutationAllowed(skillId, state, currentStates.get(skillId));
        }

        let changed = false;
        const values = uniqueIds.map((skillId) => {
          const currentState = currentStates.get(skillId);
          if (currentState && currentState.state === state && currentState.note === normalizedNote) {
            return currentState;
          }
          changed = true;
          const next = this.persistSkillState(skillId, state, normalizedNote, currentState, now);
          this.recordSkillStateEvent(skillId, state, normalizedNote, now);
          return next;
        });
        return { value: values, changed };
      },
      now,
    );
    const revisionsBySkillId = new Map(result.revisions.map((item) => [item.aggregateId, item.revision]));
    const metadata = this.readSkillStateMetadata();
    return result.value.map((item) => this.decorateSkillState(item, revisionsBySkillId.get(item.skillId)!, metadata));
  }

  private persistSkillState(
    skillId: string,
    state: SkillRuntimeState,
    note: string | undefined,
    current: PersistedSkillState | undefined,
    now: string,
  ): PersistedSkillState {
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO skill_state (skill_id, state, note, updated_at, first_auto_approved_at)
      VALUES (@skillId, @state, @note, @updatedAt, NULL)
      ON CONFLICT(skill_id) DO UPDATE SET
        state = excluded.state,
        note = excluded.note,
        updated_at = excluded.updated_at
    `,
      )
      .run({
        skillId,
        state,
        note: note ?? null,
        updatedAt: now,
      });

    return {
      skillId,
      state,
      note,
      updatedAt: now,
      firstAutoApprovedAt: current?.firstAutoApprovedAt,
    };
  }

  private recordSkillStateEvent(
    skillId: string,
    state: SkillRuntimeState,
    note: string | undefined,
    now: string,
  ): void {
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO skill_activation_events (
        event_id, skill_id, event_type, payload_json, created_at
      ) VALUES (
        @eventId, @skillId, @eventType, @payloadJson, @createdAt
      )
    `,
      )
      .run({
        eventId: randomUUID(),
        skillId,
        eventType: "state_updated",
        payloadJson: JSON.stringify({ state, note }),
        createdAt: now,
      });
  }

  private assertSkillStateMutationAllowed(
    skillId: string,
    state: SkillRuntimeState,
    currentState: PersistedSkillState | undefined,
  ): void {
    const pinned = this.readSkillStateMetadata()[skillId]?.pinned === true;
    if (pinned && currentState?.state !== state) {
      throw new ConflictError({
        message: `Pinned skill ${skillId} cannot be changed directly; create a skill mutation proposal first.`,
      });
    }
  }

  private decorateSkillState(
    row: PersistedSkillState,
    revision: number,
    metadata: Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }>,
  ): SkillStateRecord {
    return {
      ...row,
      revision,
      pinned: metadata[row.skillId]?.pinned,
      usageCount: metadata[row.skillId]?.usageCount,
      lastUsedAt: metadata[row.skillId]?.lastUsedAt,
    };
  }

  recordSkillUsage(skillIds: string[]): void {
    const uniqueSkillIds = [...new Set(skillIds.filter((skillId) => skillId.trim().length > 0))];
    if (uniqueSkillIds.length === 0) {
      return;
    }
    const metadata = this.readSkillStateMetadata();
    const now = new Date().toISOString();
    for (const skillId of uniqueSkillIds) {
      const current = metadata[skillId] ?? {};
      metadata[skillId] = {
        ...current,
        usageCount: (current.usageCount ?? 0) + 1,
        lastUsedAt: now,
      };
    }
    this.ctx.systemSettings.set(SKILL_STATE_METADATA_SETTING_KEY, metadata);
  }

  getActivationPolicy(): SkillActivationPolicy {
    const revision = this.ctx.skillAggregateRevisions.ensure(
      "activation_policy",
      SKILL_ACTIVATION_POLICY_AGGREGATE_ID,
    ).revision;
    return { revision, ...this.readActivationPolicyValue() };
  }

  private readActivationPolicyValue(): Omit<SkillActivationPolicy, "revision"> {
    const stored = this.ctx.systemSettings.get<Partial<SkillActivationPolicy>>(
      SKILL_ACTIVATION_POLICY_SETTING_KEY,
    )?.value;
    if (!stored) {
      return { ...DEFAULT_SKILL_ACTIVATION_POLICY };
    }
    return {
      guardedAutoThreshold: clamp01(
        stored.guardedAutoThreshold ?? DEFAULT_SKILL_ACTIVATION_POLICY.guardedAutoThreshold,
      ),
      requireFirstUseConfirmation:
        stored.requireFirstUseConfirmation ?? DEFAULT_SKILL_ACTIVATION_POLICY.requireFirstUseConfirmation,
    };
  }

  updateActivationPolicy(input: SkillActivationPolicyPatch, expectedRevision: number): SkillActivationPolicy {
    const result = this.ctx.skillAggregateRevisions.runWithRevision(
      "activation_policy",
      SKILL_ACTIVATION_POLICY_AGGREGATE_ID,
      expectedRevision,
      () => {
        const current = this.readActivationPolicyValue();
        const next: Omit<SkillActivationPolicy, "revision"> = {
          guardedAutoThreshold: clamp01(input.guardedAutoThreshold ?? current.guardedAutoThreshold),
          requireFirstUseConfirmation: input.requireFirstUseConfirmation ?? current.requireFirstUseConfirmation,
        };
        const changed =
          next.guardedAutoThreshold !== current.guardedAutoThreshold ||
          next.requireFirstUseConfirmation !== current.requireFirstUseConfirmation;
        if (changed) {
          this.ctx.systemSettings.set(SKILL_ACTIVATION_POLICY_SETTING_KEY, next);
        }
        return { value: next, changed };
      },
    );
    return { revision: result.revision, ...result.value };
  }

  /**
   * Capture a reversible snapshot of a skill's prior runtime-state row before the
   * S3 idle janitor archives (disables) it. Persisted into `system_settings` so
   * the global "revert autonomous changes" path can restore the exact prior
   * state/note via {@link restoreCuratorIdleSnapshot}. Best-effort: a snapshot
   * failure must not abort the sweep (which is itself failure-isolated), so this
   * swallows errors. The archive is reversible regardless — a curator-archived
   * skill is a `disabled` row re-enableable from the snapshot.
   */
  captureCuratorIdleSnapshot(skillId: string): void {
    try {
      const prior = this.readSkillStates().get(skillId);
      this.ctx.systemSettings.set(curatorIdleSnapshotKey(skillId), {
        skillId,
        priorState: prior?.state ?? "enabled",
        priorNote: prior?.note,
        priorPinned: prior?.pinned ?? false,
        capturedAt: new Date().toISOString(),
      });
      // Unified audit: the snapshot self-persists in system_settings under the
      // deterministic key, so the restoreRef only needs the skillId (best-effort).
      this.host.recordAutonomousMutation({
        kind: "curator_archive",
        targetKey: skillId,
        restoreRef: { kind: "curator_archive", skillId },
      });
    } catch (error) {
      this.host.recordDevDiagnostic({
        level: "warn",
        category: "cron",
        event: "curator_idle_snapshot_failed",
        message: "failed to snapshot skill state before idle archive",
        context: { skillId, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /**
   * Restore a skill archived by the S3 idle janitor to its captured prior state.
   * Returns false when no snapshot exists for the skill. Used by the global
   * autonomous-rollback path.
   */
  restoreCuratorIdleSnapshot(skillId: string): boolean {
    const snapshot = this.ctx.systemSettings.get<{
      skillId: string;
      priorState: SkillRuntimeState;
      priorNote?: string;
      priorPinned?: boolean;
    }>(curatorIdleSnapshotKey(skillId))?.value;
    if (!snapshot || snapshot.skillId !== skillId) {
      return false;
    }
    const expectedRevision = this.ctx.skillAggregateRevisions.ensure("runtime_skill", skillId).revision;
    this.setSkillState(skillId, snapshot.priorState, snapshot.priorNote, expectedRevision);
    return true;
  }

  recordSkillImportEvent(
    validation: SkillImportValidationResult,
    eventType: "import_validated" | "import_installed",
  ): void {
    const now = new Date().toISOString();
    const skillId = validation.inferredSkillId
      ? `import:${validation.inferredSkillId}`
      : `import:${createHash("sha1").update(validation.candidate.canonicalKey).digest("hex").slice(0, 12)}`;
    this.ctx.gatewaySql
      .prepare(
        `
      INSERT INTO skill_activation_events (
        event_id, skill_id, event_type, payload_json, created_at
      ) VALUES (
        @eventId, @skillId, @eventType, @payloadJson, @createdAt
      )
    `,
      )
      .run({
        eventId: randomUUID(),
        skillId,
        eventType,
        payloadJson: JSON.stringify({
          sourceProvider: validation.candidate.sourceProvider,
          sourceRef: validation.candidate.sourceRef,
          canonicalKey: validation.candidate.canonicalKey,
          valid: validation.valid,
          riskLevel: validation.riskLevel,
          skillName: validation.inferredSkillName,
          skillId: validation.inferredSkillId,
          warnings: validation.warnings,
          errors: validation.errors,
        }),
        createdAt: now,
      });
  }

  private readSkillStateMetadata(): Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }> {
    const value = this.ctx.systemSettings.get<
      Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }>
    >(SKILL_STATE_METADATA_SETTING_KEY)?.value;
    if (!value || typeof value !== "object") {
      return {};
    }
    const output: Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }> = {};
    for (const [skillId, metadata] of Object.entries(value)) {
      if (!isRecord(metadata)) {
        continue;
      }
      output[skillId] = {
        pinned: metadata.pinned === true ? true : undefined,
        usageCount:
          typeof metadata.usageCount === "number" && metadata.usageCount >= 0 ? metadata.usageCount : undefined,
        lastUsedAt: typeof metadata.lastUsedAt === "string" ? metadata.lastUsedAt : undefined,
      };
    }
    return output;
  }
}

function curatorIdleSnapshotKey(skillId: string): string {
  return `curator_idle_skill_snapshot_v1:${skillId}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function toPersistedSkillStateRows(value: unknown): PersistedSkillState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((row) => {
    if (
      !isRecord(row) ||
      typeof row.skillId !== "string" ||
      (row.state !== "enabled" && row.state !== "sleep" && row.state !== "disabled") ||
      (typeof row.note !== "string" && row.note !== null) ||
      typeof row.updatedAt !== "string" ||
      (typeof row.firstAutoApprovedAt !== "string" && row.firstAutoApprovedAt !== null)
    ) {
      return [];
    }
    return [
      {
        skillId: row.skillId,
        state: row.state,
        note: typeof row.note === "string" ? row.note : undefined,
        updatedAt: row.updatedAt,
        firstAutoApprovedAt: typeof row.firstAutoApprovedAt === "string" ? row.firstAutoApprovedAt : undefined,
      },
    ];
  });
}

function normalizeSkillStateNote(note: string | undefined): string | undefined {
  return note?.trim() || undefined;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
