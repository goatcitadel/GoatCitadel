import { createHash } from "node:crypto";
import type {
  DurableChildStateChangedPayload,
  DurableChildWatcherCatchUpResult,
  DurableChildWatcherCreateRequest,
  DurableChildWatcherRecord,
  DurableRunTimelineEvent,
} from "@goatcitadel/contracts";
import {
  assertDurableChildWatcherCreateRequestBounds,
  assertDurableChildWatcherIdBounds,
  assertDurableChildWatcherRunIdBounds,
  redactSecretText,
  redactStructuredSecrets,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface DurableChildWatcherRow {
  watcher_id: string;
  revision: number | string;
  parent_run_id: string;
  child_run_id: string;
  state: DurableChildWatcherRecord["state"];
  next_sequence: number | string;
  last_consumed_sequence: number | string;
  projected_notice_count: number | string;
  source: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  detached_at: string | null;
  reattached_at: string | null;
  closed_at: string | null;
}

interface DurableRunEventRow {
  event_id: string;
  run_id: string;
  sequence: number | string;
  event_type: DurableRunTimelineEvent["eventType"];
  step_key: string | null;
  payload_json: string;
  created_at: string;
}

const PROJECTABLE_CHILD_EVENT_TYPES = new Set<DurableRunTimelineEvent["eventType"]>([
  "run_created",
  "run_started",
  "run_paused",
  "run_resumed",
  "run_waiting",
  "run_woken",
  "run_retry_scheduled",
  "run_cancelled",
  "run_completed",
  "run_failed",
  "continuation_gate",
  "run_dead_lettered",
  "run_lease_expired",
  "run_reclaimed",
  "run_incomplete_worker_exit",
  "run_retry_budget_exhausted",
  "dead_letter_recovered",
]);

export const DURABLE_CHILD_PAYLOAD_PROJECTION_LIMITS = {
  maxBytes: 8 * 1024,
  maxDepth: 6,
  maxItems: 128,
  maxPreviewKeys: 16,
} as const;

export interface DurableChildWatcherReconcileSummary {
  watcherCount: number;
  consumedCount: number;
  projectedCount: number;
  watcherIdsWithMore: string[];
}

export interface DurableChildWatcherControlResult {
  watcher: DurableChildWatcherRecord;
  outcome: "applied" | "converged";
}

export class DurableChildWatcherRepository {
  private readonly getStmt;
  private readonly getByPairStmt;
  private readonly wouldCreateCycleStmt;
  private readonly listByParentStmt;
  private readonly getScanCursorStmt;
  private readonly listAttachedAfterCursorStmt;
  private readonly listAttachedThroughCursorStmt;
  private readonly updateScanCursorStmt;
  private readonly listAttachedByChildStmt;
  private readonly listChildEventsStmt;
  private readonly hasChildEventsAfterStmt;
  private readonly getParentEventStmt;
  private readonly allocateParentSequenceStmt;
  private readonly insertParentEventStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare(`
      SELECT *
      FROM durable_child_watchers
      WHERE watcher_id = ?
    `);
    this.getByPairStmt = db.prepare(`
      SELECT *
      FROM durable_child_watchers
      WHERE parent_run_id = ? AND child_run_id = ?
    `);
    this.wouldCreateCycleStmt = db.prepare(`
      WITH RECURSIVE descendants(run_id) AS (
        SELECT child_run_id
        FROM durable_child_watchers
        WHERE parent_run_id = ? AND state <> 'closed'
        UNION
        SELECT watcher.child_run_id
        FROM durable_child_watchers AS watcher
        INNER JOIN descendants ON watcher.parent_run_id = descendants.run_id
        WHERE watcher.state <> 'closed'
      )
      SELECT run_id
      FROM descendants
      WHERE run_id = ?
      LIMIT 1
    `);
    this.listByParentStmt = db.prepare(`
      SELECT *
      FROM durable_child_watchers
      WHERE parent_run_id = ?
      ORDER BY created_at ASC, watcher_id ASC
      LIMIT ?
    `);
    this.getScanCursorStmt = db.prepare(
      db.dialect === "postgres"
        ? `
          SELECT last_watcher_id
          FROM durable_child_watcher_scan_state
          WHERE scan_key = 'global'
          FOR UPDATE
        `
        : `
          SELECT last_watcher_id
          FROM durable_child_watcher_scan_state
          WHERE scan_key = 'global'
        `,
    );
    this.listAttachedAfterCursorStmt = db.prepare(`
      SELECT watcher_id
      FROM durable_child_watchers
      WHERE state = 'attached' AND watcher_id > ?
      ORDER BY watcher_id ASC
      LIMIT ?
    `);
    this.listAttachedThroughCursorStmt = db.prepare(`
      SELECT watcher_id
      FROM durable_child_watchers
      WHERE state = 'attached' AND watcher_id <= ?
      ORDER BY watcher_id ASC
      LIMIT ?
    `);
    this.updateScanCursorStmt = db.prepare(`
      UPDATE durable_child_watcher_scan_state
      SET last_watcher_id = ?, updated_at = ?
      WHERE scan_key = 'global'
    `);
    this.listAttachedByChildStmt = db.prepare(`
      SELECT watcher_id
      FROM durable_child_watchers
      WHERE state = 'attached' AND child_run_id = ?
      ORDER BY watcher_id ASC
      LIMIT ?
    `);
    this.listChildEventsStmt = db.prepare(`
      SELECT event_id, run_id, sequence, event_type, step_key, payload_json, created_at
      FROM durable_run_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `);
    this.hasChildEventsAfterStmt = db.prepare(`
      SELECT event_id
      FROM durable_run_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT 1
    `);
    this.getParentEventStmt = db.prepare(`
      SELECT event_id
      FROM durable_run_events
      WHERE event_id = ?
    `);
    this.allocateParentSequenceStmt = db.prepare(`
      INSERT INTO durable_run_event_sequences (run_id, last_sequence)
      VALUES (?, 1)
      ON CONFLICT(run_id) DO UPDATE SET
        last_sequence = durable_run_event_sequences.last_sequence + 1
      RETURNING last_sequence
    `);
    this.insertParentEventStmt = db.prepare(`
      INSERT INTO durable_run_events (
        event_id, run_id, sequence, event_type, step_key, payload_json, created_at
      ) VALUES (?, ?, ?, 'child_state_changed', ?, ?, ?)
    `);
  }

  public create(input: {
    watcherId: string;
    parentRunId: string;
    childRunId: string;
    source?: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): DurableChildWatcherRecord {
    assertDurableChildWatcherCreateRequestBounds(input satisfies DurableChildWatcherCreateRequest);
    if (input.parentRunId === input.childRunId) {
      throw new Error("A durable run cannot watch itself");
    }
    return this.db.transaction("immediate", () => {
      this.lockWatcherGraphState();
      this.lockEndpointRuns(input.parentRunId, input.childRunId);
      const existing = this.getByPair(input.parentRunId, input.childRunId);
      if (existing) {
        return existing;
      }
      if (this.wouldCreateCycleStmt.get(input.childRunId, input.parentRunId)) {
        throw new Error(`Durable child watcher ${input.parentRunId} -> ${input.childRunId} would create a run cycle`);
      }
      const now = input.createdAt ?? new Date().toISOString();
      this.db
        .prepare(
          `
          INSERT INTO durable_child_watchers (
            watcher_id, revision, parent_run_id, child_run_id, state,
            next_sequence, last_consumed_sequence, projected_notice_count,
            source, metadata_json, created_at, updated_at
          ) VALUES (?, 1, ?, ?, 'attached', 1, 0, 0, ?, ?, ?, ?)
          ON CONFLICT(parent_run_id, child_run_id) DO NOTHING
        `,
        )
        .run(
          input.watcherId,
          input.parentRunId,
          input.childRunId,
          input.source ?? null,
          JSON.stringify(input.metadata ?? {}),
          now,
          now,
        );
      const watcher = this.getByPair(input.parentRunId, input.childRunId);
      if (!watcher) {
        throw new Error(`Failed to create durable child watcher ${input.watcherId}`);
      }
      return watcher;
    });
  }

  public get(watcherId: string): DurableChildWatcherRecord {
    assertDurableChildWatcherIdBounds(watcherId);
    const row = this.getStmt.get<DurableChildWatcherRow>(watcherId);
    if (!row) {
      throw new Error(`Durable child watcher not found: ${watcherId}`);
    }
    return mapWatcherRow(row);
  }

  public getByPair(parentRunId: string, childRunId: string): DurableChildWatcherRecord | undefined {
    assertDurableChildWatcherRunIdBounds(parentRunId);
    assertDurableChildWatcherRunIdBounds(childRunId);
    const row = this.getByPairStmt.get<DurableChildWatcherRow>(parentRunId, childRunId);
    return row ? mapWatcherRow(row) : undefined;
  }

  public listByParent(parentRunId: string, limit = 200): DurableChildWatcherRecord[] {
    assertDurableChildWatcherRunIdBounds(parentRunId);
    const safeLimit = clampLimit(limit, 500);
    return this.listByParentStmt.all<DurableChildWatcherRow>(parentRunId, safeLimit).map(mapWatcherRow);
  }

  public detach(watcherId: string, detachedAt = new Date().toISOString()): DurableChildWatcherRecord {
    const current = this.get(watcherId);
    if (current.state !== "attached") {
      return current;
    }
    const result = this.db
      .prepare(
        `
        UPDATE durable_child_watchers
        SET state = 'detached', revision = revision + 1, detached_at = ?, updated_at = ?
        WHERE watcher_id = ? AND state = 'attached'
      `,
      )
      .run(detachedAt, detachedAt, watcherId);
    if (result.changes !== 1) {
      return this.get(watcherId);
    }
    return this.get(watcherId);
  }

  public detachIfRevision(
    watcherId: string,
    parentRunId: string,
    expectedRevision: number,
    detachedAt = new Date().toISOString(),
  ): DurableChildWatcherControlResult {
    return this.transitionIfRevision({
      watcherId,
      parentRunId,
      expectedRevision,
      fromState: "attached",
      toState: "detached",
      timestampColumn: "detached_at",
      timestamp: detachedAt,
    });
  }

  public reattach(watcherId: string, reattachedAt = new Date().toISOString()): DurableChildWatcherRecord {
    const current = this.get(watcherId);
    if (current.state === "closed") {
      throw new Error(`Closed durable child watcher ${watcherId} cannot be reattached`);
    }
    if (current.state === "attached") {
      return current;
    }
    const result = this.db
      .prepare(
        `
        UPDATE durable_child_watchers
        SET state = 'attached', revision = revision + 1, reattached_at = ?, updated_at = ?
        WHERE watcher_id = ? AND state = 'detached'
      `,
      )
      .run(reattachedAt, reattachedAt, watcherId);
    if (result.changes !== 1) {
      return this.get(watcherId);
    }
    return this.get(watcherId);
  }

  public reattachIfRevision(
    watcherId: string,
    parentRunId: string,
    expectedRevision: number,
    reattachedAt = new Date().toISOString(),
  ): DurableChildWatcherControlResult {
    return this.transitionIfRevision({
      watcherId,
      parentRunId,
      expectedRevision,
      fromState: "detached",
      toState: "attached",
      timestampColumn: "reattached_at",
      timestamp: reattachedAt,
    });
  }

  /** Claim a watcher generation without changing attachment state. Must run in the caller's mutation transaction. */
  public claimControlRevision(
    watcherId: string,
    parentRunId: string,
    expectedRevision: number,
    updatedAt = new Date().toISOString(),
  ): DurableChildWatcherRecord {
    assertDurableChildWatcherIdBounds(watcherId);
    assertDurableChildWatcherRunIdBounds(parentRunId);
    assertPositiveRevision(expectedRevision);
    const update = this.db
      .prepare(
        `
      UPDATE durable_child_watchers
      SET revision = revision + 1, updated_at = ?
      WHERE watcher_id = ? AND parent_run_id = ? AND revision = ?
    `,
      )
      .run(updatedAt, watcherId, parentRunId, expectedRevision);
    if (update.changes === 1) return this.get(watcherId);
    const current = this.getForUpdate(watcherId);
    assertWatcherParent(current, parentRunId);
    throw new Error(
      `Durable child watcher ${watcherId} changed from revision ${expectedRevision} to ${current.revision} before control could be applied.`,
    );
  }

  public close(watcherId: string, closedAt = new Date().toISOString()): DurableChildWatcherRecord {
    const current = this.get(watcherId);
    if (current.state === "closed") {
      return current;
    }
    this.db
      .prepare(
        `
        UPDATE durable_child_watchers
        SET state = 'closed', revision = revision + 1, closed_at = ?, updated_at = ?
        WHERE watcher_id = ? AND state <> 'closed'
      `,
      )
      .run(closedAt, closedAt, watcherId);
    return this.get(watcherId);
  }

  public catchUpWatcher(watcherId: string, limit = 100): DurableChildWatcherCatchUpResult {
    assertDurableChildWatcherIdBounds(watcherId);
    const safeLimit = clampLimit(limit, 500);
    return this.db.transaction("immediate", () => {
      const watcher = this.getForUpdate(watcherId);
      if (watcher.state !== "attached") {
        return {
          watcher,
          consumedCount: 0,
          projectedCount: 0,
          hasMore: false,
          notices: [],
        };
      }

      const childEvents = this.listChildEventsStmt.all<DurableRunEventRow>(
        watcher.childRunId,
        watcher.lastConsumedSequence,
        safeLimit,
      );
      if (childEvents.length === 0) {
        return {
          watcher,
          consumedCount: 0,
          projectedCount: 0,
          hasMore: false,
          notices: [],
        };
      }

      const observedAt = new Date().toISOString();
      const notices: DurableRunTimelineEvent[] = [];
      let projectedCount = 0;
      for (const row of childEvents) {
        if (!isProjectableChildEvent(row.event_type)) {
          continue;
        }
        const eventId = buildChildNoticeEventId(watcher.watcherId, Number(row.sequence));
        if (this.getParentEventStmt.get(eventId)) {
          continue;
        }
        const parentSequence = this.allocateParentSequence(watcher.parentRunId);
        const childPayloadProjection = projectChildPayload(row.payload_json);
        const payload: DurableChildStateChangedPayload = {
          watcherId: watcher.watcherId,
          parentRunId: watcher.parentRunId,
          childRunId: watcher.childRunId,
          childEventId: row.event_id,
          childSequence: Number(row.sequence),
          childEventType: row.event_type,
          ...(row.step_key ? { childStepKey: row.step_key } : {}),
          ...(childPayloadProjection.childPayload ? { childPayload: childPayloadProjection.childPayload } : {}),
          childPayloadEvidence: childPayloadProjection.childPayloadEvidence,
          childCreatedAt: row.created_at,
          observedAt,
        };
        this.insertParentEventStmt.run(
          eventId,
          watcher.parentRunId,
          parentSequence,
          row.step_key,
          JSON.stringify(payload),
          observedAt,
        );
        projectedCount += 1;
        notices.push({
          eventId,
          runId: watcher.parentRunId,
          sequence: parentSequence,
          eventType: "child_state_changed",
          stepKey: row.step_key ?? undefined,
          payload: payload as unknown as Record<string, unknown>,
          createdAt: observedAt,
        });
      }

      const lastConsumedSequence = Number(childEvents.at(-1)!.sequence);
      const update = this.db
        .prepare(
          `
          UPDATE durable_child_watchers
          SET next_sequence = ?,
              last_consumed_sequence = ?,
              projected_notice_count = projected_notice_count + ?,
              revision = revision + 1,
              updated_at = ?
          WHERE watcher_id = ?
            AND state = 'attached'
            AND last_consumed_sequence = ?
        `,
        )
        .run(
          lastConsumedSequence + 1,
          lastConsumedSequence,
          projectedCount,
          observedAt,
          watcher.watcherId,
          watcher.lastConsumedSequence,
        );
      if (update.changes !== 1) {
        throw new Error(`Durable child watcher ${watcher.watcherId} changed during catch-up`);
      }
      const refreshed = this.get(watcher.watcherId);
      const hasMore = Boolean(this.hasChildEventsAfterStmt.get(watcher.childRunId, lastConsumedSequence));
      return {
        watcher: refreshed,
        consumedCount: childEvents.length,
        projectedCount,
        hasMore,
        notices,
      };
    });
  }

  public catchUpAttached(
    input: {
      watcherLimit?: number;
      eventLimitPerWatcher?: number;
    } = {},
  ): DurableChildWatcherReconcileSummary {
    const watcherLimit = clampLimit(input.watcherLimit ?? 100, 500);
    return this.db.transaction("immediate", () => {
      const cursor = this.getScanCursorForUpdate();
      const rows = this.listAttachedAfterCursorStmt.all<{ watcher_id: string }>(cursor, watcherLimit);
      if (rows.length < watcherLimit) {
        rows.push(
          ...this.listAttachedThroughCursorStmt.all<{ watcher_id: string }>(cursor, watcherLimit - rows.length),
        );
      }
      const summary = this.catchUpWatcherRows(rows, input.eventLimitPerWatcher);
      if (rows.length > 0) {
        this.updateScanCursorStmt.run(rows.at(-1)!.watcher_id, new Date().toISOString());
      }
      return summary;
    });
  }

  public catchUpAttachedByChild(
    childRunId: string,
    input: { watcherLimit?: number; eventLimitPerWatcher?: number } = {},
  ): DurableChildWatcherReconcileSummary {
    assertDurableChildWatcherRunIdBounds(childRunId);
    const watcherLimit = clampLimit(input.watcherLimit ?? 100, 500);
    const rows = this.listAttachedByChildStmt.all<{ watcher_id: string }>(childRunId, watcherLimit);
    return this.catchUpWatcherRows(rows, input.eventLimitPerWatcher);
  }

  private catchUpWatcherRows(
    rows: Array<{ watcher_id: string }>,
    eventLimitPerWatcher = 100,
  ): DurableChildWatcherReconcileSummary {
    const summary: DurableChildWatcherReconcileSummary = {
      watcherCount: 0,
      consumedCount: 0,
      projectedCount: 0,
      watcherIdsWithMore: [],
    };
    for (const row of rows) {
      const result = this.catchUpWatcher(row.watcher_id, eventLimitPerWatcher);
      summary.watcherCount += 1;
      summary.consumedCount += result.consumedCount;
      summary.projectedCount += result.projectedCount;
      if (result.hasMore) {
        summary.watcherIdsWithMore.push(row.watcher_id);
      }
    }
    return summary;
  }

  /** Lock and return the exact watcher generation inside a caller-owned transaction. */
  public getForUpdate(watcherId: string): DurableChildWatcherRecord {
    assertDurableChildWatcherIdBounds(watcherId);
    const sql =
      this.db.dialect === "postgres"
        ? "SELECT * FROM durable_child_watchers WHERE watcher_id = ? FOR UPDATE"
        : "SELECT * FROM durable_child_watchers WHERE watcher_id = ?";
    const row = this.db.prepare(sql).get<DurableChildWatcherRow>(watcherId);
    if (!row) {
      throw new Error(`Durable child watcher not found: ${watcherId}`);
    }
    return mapWatcherRow(row);
  }

  private transitionIfRevision(input: {
    watcherId: string;
    parentRunId: string;
    expectedRevision: number;
    fromState: "attached" | "detached";
    toState: "attached" | "detached";
    timestampColumn: "detached_at" | "reattached_at";
    timestamp: string;
  }): DurableChildWatcherControlResult {
    assertDurableChildWatcherIdBounds(input.watcherId);
    assertDurableChildWatcherRunIdBounds(input.parentRunId);
    assertPositiveRevision(input.expectedRevision);
    const update = this.db
      .prepare(
        `
      UPDATE durable_child_watchers
      SET state = ?, revision = revision + 1, ${input.timestampColumn} = ?, updated_at = ?
      WHERE watcher_id = ? AND parent_run_id = ? AND revision = ? AND state = ?
    `,
      )
      .run(
        input.toState,
        input.timestamp,
        input.timestamp,
        input.watcherId,
        input.parentRunId,
        input.expectedRevision,
        input.fromState,
      );
    if (update.changes === 1) return { watcher: this.get(input.watcherId), outcome: "applied" };
    const current = this.getForUpdate(input.watcherId);
    assertWatcherParent(current, input.parentRunId);
    if (current.state === input.toState) return { watcher: current, outcome: "converged" };
    throw new Error(
      `Durable child watcher ${input.watcherId} changed from revision ${input.expectedRevision} to ${current.revision} before control could be applied.`,
    );
  }

  private getScanCursorForUpdate(): string {
    const row = this.getScanCursorStmt.get<{ last_watcher_id: string }>();
    if (!row) {
      throw new Error("Durable child watcher scan cursor is missing");
    }
    return row.last_watcher_id;
  }

  private lockWatcherGraphState(): void {
    this.getScanCursorForUpdate();
  }

  private lockEndpointRuns(parentRunId: string, childRunId: string): void {
    const sql =
      this.db.dialect === "postgres"
        ? `
          SELECT run_id
          FROM durable_runs
          WHERE run_id IN (?, ?)
          ORDER BY run_id ASC
          FOR UPDATE
        `
        : `
          SELECT run_id
          FROM durable_runs
          WHERE run_id IN (?, ?)
          ORDER BY run_id ASC
        `;
    const rows = this.db.prepare(sql).all<{ run_id: string }>(parentRunId, childRunId);
    if (rows.length !== 2) {
      throw new Error(`Durable child watcher endpoints must both exist: ${parentRunId} -> ${childRunId}`);
    }
  }

  private allocateParentSequence(parentRunId: string): number {
    const row = this.allocateParentSequenceStmt.get<{ last_sequence: number | string }>(parentRunId);
    const sequence = Number(row?.last_sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error(`Failed to allocate a durable timeline sequence for parent run ${parentRunId}`);
    }
    return sequence;
  }
}

function isProjectableChildEvent(
  eventType: DurableRunTimelineEvent["eventType"],
): eventType is Exclude<DurableRunTimelineEvent["eventType"], "child_state_changed"> {
  return eventType !== "child_state_changed" && PROJECTABLE_CHILD_EVENT_TYPES.has(eventType);
}

function buildChildNoticeEventId(watcherId: string, childSequence: number): string {
  const digest = createHash("sha256").update(`${watcherId}\u0000${childSequence}`).digest("hex");
  return `child-watch-${digest}`;
}

function projectChildPayload(rawPayload: string): {
  childPayload?: Record<string, unknown>;
  childPayloadEvidence: DurableChildStateChangedPayload["childPayloadEvidence"];
} {
  const originalByteCount = Buffer.byteLength(rawPayload, "utf8");
  const originalSha256 = createHash("sha256").update(rawPayload, "utf8").digest("hex");
  const baseEvidence = {
    hashAlgorithm: "sha256" as const,
    originalSha256,
    originalByteCount,
  };
  if (originalByteCount > DURABLE_CHILD_PAYLOAD_PROJECTION_LIMITS.maxBytes) {
    return omittedPayloadProjection(baseEvidence, "byte_limit", inferJsonTopLevelType(rawPayload), undefined);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return omittedPayloadProjection(baseEvidence, "invalid_json", "unknown", undefined);
  }
  if (!isPlainRecord(parsed)) {
    return omittedPayloadProjection(baseEvidence, "invalid_shape", describeTopLevelType(parsed), undefined);
  }

  const violation = inspectPayloadBounds(parsed);
  if (violation) {
    return omittedPayloadProjection(baseEvidence, violation, "object", parsed);
  }

  const redacted = redactStructuredSecrets(parsed);
  const redactedBytes = Buffer.byteLength(JSON.stringify(redacted.value), "utf8");
  if (redactedBytes > DURABLE_CHILD_PAYLOAD_PROJECTION_LIMITS.maxBytes) {
    return omittedPayloadProjection(baseEvidence, "byte_limit", "object", parsed);
  }
  return {
    childPayload: redacted.value,
    childPayloadEvidence: {
      ...baseEvidence,
      disposition: "included_redacted",
      redactionCount: redacted.redactionCount,
    },
  };
}

function omittedPayloadProjection(
  baseEvidence: Pick<
    DurableChildStateChangedPayload["childPayloadEvidence"],
    "hashAlgorithm" | "originalSha256" | "originalByteCount"
  >,
  reason: NonNullable<DurableChildStateChangedPayload["childPayloadEvidence"]["omissionReason"]>,
  topLevelType: NonNullable<DurableChildStateChangedPayload["childPayloadEvidence"]["preview"]>["topLevelType"],
  parsed: Record<string, unknown> | undefined,
): { childPayloadEvidence: DurableChildStateChangedPayload["childPayloadEvidence"] } {
  const keys = parsed ? Object.keys(parsed) : [];
  const topLevelKeys = keys.slice(0, DURABLE_CHILD_PAYLOAD_PROJECTION_LIMITS.maxPreviewKeys).map(boundPreviewKey);
  return {
    childPayloadEvidence: {
      ...baseEvidence,
      disposition: "omitted",
      omissionReason: reason,
      preview: {
        topLevelType,
        ...(parsed ? { topLevelKeyCount: keys.length, topLevelKeys } : {}),
        summary: `Child payload omitted by the ${reason} safety boundary (${baseEvidence.originalByteCount} bytes).`,
      },
    },
  };
}

function inspectPayloadBounds(
  root: Record<string, unknown>,
): "depth_limit" | "item_limit" | "invalid_shape" | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let itemCount = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > DURABLE_CHILD_PAYLOAD_PROJECTION_LIMITS.maxDepth) {
      return "depth_limit";
    }
    if (current.value === null || typeof current.value !== "object") {
      continue;
    }
    if (!Array.isArray(current.value) && !isPlainRecord(current.value)) {
      return "invalid_shape";
    }
    if (!Array.isArray(current.value)) {
      for (const key of Object.keys(current.value)) {
        if (redactSecretText(key).redactionCount > 0) {
          return "invalid_shape";
        }
      }
    }
    const entries = Array.isArray(current.value) ? current.value : Object.values(current.value);
    itemCount += entries.length;
    if (itemCount > DURABLE_CHILD_PAYLOAD_PROJECTION_LIMITS.maxItems) {
      return "item_limit";
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      stack.push({ value: entries[index], depth: current.depth + 1 });
    }
  }
  return undefined;
}

function boundPreviewKey(key: string): string {
  return `sha256:${createHash("sha256").update(key, "utf8").digest("hex")}`;
}

function inferJsonTopLevelType(rawPayload: string): "object" | "array" | "primitive" | "unknown" {
  const first = rawPayload.trimStart()[0];
  if (first === "{") return "object";
  if (first === "[") return "array";
  if (first === '"' || first === "t" || first === "f" || first === "n" || first === "-" || /\d/.test(first ?? "")) {
    return "primitive";
  }
  return "unknown";
}

function describeTopLevelType(value: unknown): "object" | "array" | "primitive" | "unknown" {
  if (Array.isArray(value)) return "array";
  if (isPlainRecord(value)) return "object";
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return "primitive";
  return "unknown";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapWatcherRow(row: DurableChildWatcherRow): DurableChildWatcherRecord {
  return {
    watcherId: row.watcher_id,
    revision: Number(row.revision),
    parentRunId: row.parent_run_id,
    childRunId: row.child_run_id,
    state: row.state,
    nextSequence: Number(row.next_sequence),
    lastConsumedSequence: Number(row.last_consumed_sequence),
    projectedNoticeCount: Number(row.projected_notice_count),
    source: row.source ?? undefined,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    detachedAt: row.detached_at ?? undefined,
    reattachedAt: row.reattached_at ?? undefined,
    closedAt: row.closed_at ?? undefined,
  };
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function assertPositiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Durable child watcher revision must be a positive safe integer");
  }
}

function assertWatcherParent(watcher: DurableChildWatcherRecord, parentRunId: string): void {
  if (watcher.parentRunId !== parentRunId) {
    throw new Error(`Durable child watcher not found: ${watcher.watcherId}`);
  }
}
