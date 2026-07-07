import { createHash, randomUUID } from "node:crypto";
import { isRecord } from "./companion-auth-helpers.js";
import type {
  SkillActivationPolicy,
  SkillImportValidationResult,
  SkillRuntimeState,
  SkillStateRecord,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

const SKILL_ACTIVATION_POLICY_SETTING_KEY = "skill_activation_policy_v1";
const SKILL_STATE_METADATA_SETTING_KEY = "skill_state_metadata_v1";
const DEFAULT_SKILL_ACTIVATION_POLICY: SkillActivationPolicy = {
  guardedAutoThreshold: 0.72,
  requireFirstUseConfirmation: true,
};

export interface SkillStateServiceCtx {
  gatewaySql: Storage["gatewaySql"];
  systemSettings: Pick<Storage["systemSettings"], "get" | "set">;
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
    const rows = toSkillStateRows(
      this.ctx.gatewaySql
        .prepare(
          `
      SELECT skill_id AS skillId, state, note, updated_at AS updatedAt, first_auto_approved_at AS firstAutoApprovedAt
      FROM skill_state
    `,
        )
        .all(),
    );
    const metadata = this.readSkillStateMetadata();

    return new Map(
      rows.map((row) => [
        row.skillId,
        {
          ...row,
          pinned: metadata[row.skillId]?.pinned,
          usageCount: metadata[row.skillId]?.usageCount,
          lastUsedAt: metadata[row.skillId]?.lastUsedAt,
        },
      ]),
    );
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
    }
  }

  setSkillState(skillId: string, state: SkillRuntimeState, note?: string): SkillStateRecord {
    const knownSkill = this.host.listSkills().find((skill) => skill.skillId === skillId);
    if (!knownSkill) {
      throw new Error(`Unknown skill: ${skillId}`);
    }
    const currentState = this.readSkillStates().get(skillId);
    if (currentState?.pinned && currentState.state !== state) {
      throw new Error(`Pinned skill ${skillId} cannot be changed directly; create a skill mutation proposal first.`);
    }
    const now = new Date().toISOString();
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
        note: note?.trim() || null,
        updatedAt: now,
      });

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
        payloadJson: JSON.stringify({ state, note: note?.trim() || undefined }),
        createdAt: now,
      });

    const updated = this.readSkillStates().get(skillId);
    if (!updated) {
      throw new Error(`Failed to persist skill state for ${skillId}`);
    }

    return updated;
  }

  bulkSetSkillState(skillIds: string[], state: SkillRuntimeState, note?: string): SkillStateRecord[] {
    const uniqueIds = [...new Set(skillIds)];
    const updated: SkillStateRecord[] = [];
    for (const skillId of uniqueIds) {
      updated.push(this.setSkillState(skillId, state, note));
    }
    return updated;
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
    const stored = this.ctx.systemSettings.get<SkillActivationPolicy>(SKILL_ACTIVATION_POLICY_SETTING_KEY)?.value;
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

  updateActivationPolicy(input: Partial<SkillActivationPolicy>): SkillActivationPolicy {
    const current = this.getActivationPolicy();
    const next: SkillActivationPolicy = {
      guardedAutoThreshold: clamp01(input.guardedAutoThreshold ?? current.guardedAutoThreshold),
      requireFirstUseConfirmation: input.requireFirstUseConfirmation ?? current.requireFirstUseConfirmation,
    };
    this.ctx.systemSettings.set(SKILL_ACTIVATION_POLICY_SETTING_KEY, next);
    return next;
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
    this.setSkillState(skillId, snapshot.priorState, snapshot.priorNote);
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

function toSkillStateRows(value: unknown): SkillStateRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is SkillStateRecord =>
          isRecord(row) &&
          typeof row.skillId === "string" &&
          typeof row.state === "string" &&
          (typeof row.note === "string" || row.note === null) &&
          typeof row.updatedAt === "string" &&
          (typeof row.firstAutoApprovedAt === "string" || row.firstAutoApprovedAt === null),
      )
    : [];
}
