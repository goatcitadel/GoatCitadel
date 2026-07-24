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
  private readonly allocateSequenceStmt;
  private readonly insertStmt;
  private readonly listByRunStmt;
  private readonly listAfterSequenceStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.allocateSequenceStmt = db.prepare(`
      INSERT INTO durable_run_event_sequences (run_id, last_sequence)
      VALUES (?, 1)
      ON CONFLICT(run_id) DO UPDATE SET
        last_sequence = durable_run_event_sequences.last_sequence + 1
      RETURNING last_sequence
    `);
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
      const sequence = this.allocateSequence(input.runId);
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

  private allocateSequence(runId: string): number {
    const row = this.allocateSequenceStmt.get<{ last_sequence: number | string }>(runId);
    const sequence = Number(row?.last_sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error(`Failed to allocate a durable timeline sequence for run ${runId}`);
    }
    return sequence;
  }
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
