import type { DurableRunTimelineEvent } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface DurableRunEventRow {
  event_id: string;
  run_id: string;
  event_type: DurableRunTimelineEvent["eventType"];
  step_key: string | null;
  payload_json: string;
  created_at: string;
}

export class DurableRunEventRepository {
  private readonly insertStmt;
  private readonly listByRunStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO durable_run_events (
        event_id, run_id, event_type, step_key, payload_json, created_at
      ) VALUES (
        @eventId, @runId, @eventType, @stepKey, @payloadJson, @createdAt
      )
    `);
    this.listByRunStmt = db.prepare(`
      SELECT event_id, run_id, event_type, step_key, payload_json, created_at
      FROM durable_run_events
      WHERE run_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `);
  }

  public append(input: DurableRunTimelineEvent): DurableRunTimelineEvent {
    this.insertStmt.run({
      eventId: input.eventId,
      runId: input.runId,
      eventType: input.eventType,
      stepKey: input.stepKey ?? null,
      payloadJson: JSON.stringify(input.payload ?? {}),
      createdAt: input.createdAt,
    });
    return input;
  }

  public listByRun(runId: string, limit = 300): DurableRunTimelineEvent[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    const rows = this.listByRunStmt.all(runId, safeLimit) as unknown as DurableRunEventRow[];
    return rows.map((row) => ({
      eventId: row.event_id,
      runId: row.run_id,
      eventType: row.event_type,
      stepKey: row.step_key ?? undefined,
      payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
      createdAt: row.created_at,
    }));
  }
}
