import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import { SystemSettingsRepository } from "./system-settings-repo.js";
import { createHash } from "node:crypto";
import type { DatabaseClient } from "./db.js";

export interface ConsolidationCursor {
  finishedAt: string;
  turnId: string;
}
export interface ConsolidationProgress {
  revision: number;
  cursor?: ConsolidationCursor;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastAttemptAt?: string;
  sourceExclusionCount?: number;
  sourceExclusions?: Array<ConsolidationSourceExclusion & { recordedAt: string }>;
}
export interface ConsolidationSourceExclusion extends ConsolidationCursor {
  sessionId: string;
  sourceHash: string;
  reason: "source_size_limit" | "digest_size_limit" | "credential_values";
}

/** Data-only CAS operations work through the existing async/PostgreSQL worker. */
export class MemoryConsolidationProgressRepository {
  public constructor(
    private readonly settings: SystemSettingsRepository,
    private readonly db: DatabaseClient,
  ) {}

  public readProgress(workspaceId: string): ConsolidationProgress {
    return this.settings.get<ConsolidationProgress>(key(workspaceId))?.value ?? { revision: 0 };
  }

  public claimProgress(
    workspaceId: string,
    expectedRevision: number,
    leaseOwner: string,
    now: string,
  ): ConsolidationProgress | undefined {
    if (!leaseOwner || !Number.isFinite(Date.parse(now)))
      throw new ValidationError({ message: "Invalid consolidation lease." });
    const settingKey = key(workspaceId);
    const previous = this.settings.get<ConsolidationProgress>(settingKey);
    const value = previous?.value ?? { revision: 0 };
    if (value.revision !== expectedRevision || (value.leaseExpiresAt && value.leaseExpiresAt > now)) return undefined;
    return this.settings.compareAndSet(
      settingKey,
      previous,
      {
        ...value,
        revision: value.revision + 1,
        leaseOwner,
        leaseExpiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
        lastAttemptAt: now,
      },
      now,
    )?.value;
  }

  public commitProgress(
    workspaceId: string,
    expectedRevision: number,
    leaseOwner: string,
    cursor: ConsolidationCursor | undefined,
    now: string,
    sourceExclusions: ConsolidationSourceExclusion[] = [],
  ): ConsolidationProgress {
    return this.db.transaction("immediate", () => {
      const settingKey = key(workspaceId);
      const previous = this.settings.get<ConsolidationProgress>(settingKey);
      if (
        !previous ||
        previous.value.revision !== expectedRevision ||
        previous.value.leaseOwner !== leaseOwner ||
        !previous.value.leaseExpiresAt ||
        previous.value.leaseExpiresAt <= now
      )
        throw new ConflictError({ message: "Consolidation lease changed or expired." });
      if (
        cursor &&
        (!Number.isFinite(Date.parse(cursor.finishedAt)) ||
          (previous.value.cursor && compareCursor(cursor, previous.value.cursor) < 0))
      )
        throw new ConflictError({ message: "Consolidation cursor cannot move backwards." });
      if (sourceExclusions.length > 500)
        throw new ValidationError({ message: "Too many consolidation source dispositions." });
      const recorded: Array<ConsolidationSourceExclusion & { recordedAt: string }> = [];
      for (const exclusion of sourceExclusions) {
        if (
          !exclusion.turnId ||
          exclusion.turnId.length > 300 ||
          !exclusion.sessionId ||
          exclusion.sessionId.length > 300 ||
          !/^[a-f0-9]{64}$/.test(exclusion.sourceHash) ||
          !Number.isFinite(Date.parse(exclusion.finishedAt)) ||
          !["source_size_limit", "digest_size_limit", "credential_values"].includes(exclusion.reason)
        ) {
          throw new ValidationError({ message: "Invalid consolidation source disposition." });
        }
        const identity = createHash("sha256")
          .update(
            JSON.stringify([
              exclusion.sessionId,
              exclusion.turnId,
              exclusion.finishedAt,
              exclusion.sourceHash,
              exclusion.reason,
            ]),
          )
          .digest("hex");
        const receiptKey = `memory_consolidation_exclusion_v1:${encodeURIComponent(workspaceId)}:${identity}`;
        if (this.settings.get(receiptKey)) continue;
        const receipt = { ...exclusion, recordedAt: now };
        if (!this.settings.compareAndSet(receiptKey, undefined, { workspaceId, ...receipt }, now)) {
          throw new ConflictError({ message: "Consolidation source disposition changed." });
        }
        recorded.push(receipt);
      }
      const exclusionCount = (previous.value.sourceExclusionCount ?? 0) + recorded.length;
      const next: ConsolidationProgress = {
        revision: expectedRevision + 1,
        cursor: cursor ?? previous.value.cursor,
        lastAttemptAt: previous.value.lastAttemptAt,
        ...(exclusionCount
          ? {
              sourceExclusionCount: exclusionCount,
              sourceExclusions: [...(previous.value.sourceExclusions ?? []), ...recorded].slice(-50),
            }
          : {}),
      };
      const saved = this.settings.compareAndSet(settingKey, previous, next, now);
      if (!saved) throw new ConflictError({ message: "Consolidation progress changed." });
      return saved.value;
    });
  }
}

function key(workspaceId: string): string {
  if (!workspaceId?.trim() || workspaceId.length > 300)
    throw new ValidationError({ field: "workspaceId", message: "Consolidation needs a canonical workspace." });
  return `memory_consolidation_progress_v2:${encodeURIComponent(workspaceId)}`;
}

export function compareCursor(left: ConsolidationCursor, right: ConsolidationCursor): number {
  return left.finishedAt < right.finishedAt
    ? -1
    : left.finishedAt > right.finishedAt
      ? 1
      : left.turnId < right.turnId
        ? -1
        : left.turnId > right.turnId
          ? 1
          : 0;
}
