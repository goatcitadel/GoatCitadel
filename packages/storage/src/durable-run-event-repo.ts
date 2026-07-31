import type { DurableRunTimelineEvent } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface DurableRunEventRow {
  event_id: string;
  run_id: string;
  sequence: number | string;
  event_type: DurableRunTimelineEvent["eventType"];
  step_key: string | null;
  payload_json: string;
  created_at: string;
}

export class DurableRunEventRepository {
  private readonly insertStmt;
  private readonly listByRunStmt;
  private readonly listAfterSequenceStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO durable_run_events (
        event_id, run_id, sequence, event_type, step_key, payload_json, created_at
      ) VALUES (
        @eventId, @runId, @sequence, @eventType, @stepKey, @payloadJson, @createdAt
      )
    `);
    this.listByRunStmt = db.prepare(`
      SELECT event_id, run_id, sequence, event_type, step_key, payload_json, created_at
      FROM durable_run_events
      WHERE run_id = ?
      ORDER BY sequence ASC
      LIMIT ?
    `);
    this.listAfterSequenceStmt = db.prepare(`
      SELECT event_id, run_id, sequence, event_type, step_key, payload_json, created_at
      FROM durable_run_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `);
  }

  public append(input: Omit<DurableRunTimelineEvent, "sequence"> & { sequence?: number }): DurableRunTimelineEvent {
    return this.db.transaction("immediate", () => {
      const sequence = allocateDurableRunEventSequence(this.db, input.runId);
      this.insertStmt.run({
        eventId: input.eventId,
        runId: input.runId,
        sequence,
        eventType: input.eventType,
        stepKey: input.stepKey ?? null,
        payloadJson: JSON.stringify(input.payload ?? {}),
        createdAt: input.createdAt,
      });
      return { ...input, sequence };
    });
  }

  public listByRun(runId: string, limit = 300): DurableRunTimelineEvent[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const rows = this.listByRunStmt.all(runId, safeLimit) as unknown as DurableRunEventRow[];
    return rows.map(mapDurableRunEventRow);
  }

  public listAfterSequence(runId: string, afterSequence: number, limit = 300): DurableRunTimelineEvent[] {
    const safeAfterSequence = Math.max(0, Math.floor(afterSequence));
    const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const rows = this.listAfterSequenceStmt.all(runId, safeAfterSequence, safeLimit) as unknown as DurableRunEventRow[];
    return rows.map(mapDurableRunEventRow);
  }
}

/**
 * Allocates the next per-run timeline sequence inside the caller's transaction.
 *
 * The event table remains an independent recovery witness for roots created by
 * older writers that did not advance the sequence ledger. Taking the greater
 * of the ledger successor and the persisted-event successor heals that drift
 * without ever reusing an already committed sequence.
 */
export function allocateDurableRunEventSequence(db: DatabaseClient, runId: string): number {
  const row = db
    .prepare(
      `
      INSERT INTO durable_run_event_sequences (run_id, last_sequence)
      VALUES (
        @runId,
        (SELECT COALESCE(MAX(sequence), 0) + 1 FROM durable_run_events WHERE run_id = @runId)
      )
      ON CONFLICT(run_id) DO UPDATE SET
        last_sequence = CASE
          WHEN durable_run_event_sequences.last_sequence + 1 >
            (SELECT COALESCE(MAX(sequence), 0) + 1 FROM durable_run_events WHERE run_id = @runId)
          THEN durable_run_event_sequences.last_sequence + 1
          ELSE (SELECT COALESCE(MAX(sequence), 0) + 1 FROM durable_run_events WHERE run_id = @runId)
        END
      RETURNING last_sequence
    `,
    )
    .get<{ last_sequence: number | string }>({ runId });
  const sequence = Number(row?.last_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`Failed to allocate a durable timeline sequence for run ${runId}`);
  }
  return sequence;
}

function mapDurableRunEventRow(row: DurableRunEventRow): DurableRunTimelineEvent {
  return {
    eventId: row.event_id,
    runId: row.run_id,
    sequence: Number(row.sequence),
    eventType: row.event_type,
    stepKey: row.step_key ?? undefined,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    createdAt: row.created_at,
  };
}
