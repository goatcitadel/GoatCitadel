import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { ApprovalReplayEvent } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ApprovalEventRow {
  event_id: string;
  approval_id: string;
  event_type: ApprovalReplayEvent["eventType"];
  actor_id: string;
  timestamp: string;
  payload_json: string;
}

export interface AppendApprovalEventInput {
  approvalId: string;
  eventType: ApprovalReplayEvent["eventType"];
  actorId: string;
  timestamp?: string;
  payload: Record<string, unknown>;
}

export class ApprovalEventRepository {
  private readonly insertStmt;
  private readonly listByApprovalStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO approval_events (
        event_id, approval_id, event_type, actor_id, timestamp, payload_json
      ) VALUES (@eventId, @approvalId, @eventType, @actorId, @timestamp, @payloadJson)
    `);

    this.listByApprovalStmt = db.prepare(
      "SELECT * FROM approval_events WHERE approval_id = ? ORDER BY timestamp ASC",
    );
  }

  public append(input: AppendApprovalEventInput): ApprovalReplayEvent {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const eventId = randomUUID();
    this.insertStmt.run({
      eventId,
      approvalId: input.approvalId,
      eventType: input.eventType,
      actorId: input.actorId,
      timestamp,
      payloadJson: JSON.stringify(input.payload),
    });

    return {
      eventId,
      approvalId: input.approvalId,
      eventType: input.eventType,
      actorId: input.actorId,
      timestamp,
      payload: input.payload,
    };
  }

  public listByApprovalId(approvalId: string): ApprovalReplayEvent[] {
    const rows = this.listByApprovalStmt.all(approvalId);
    assertApprovalEventRows(rows);
    const approvalEventRows: ApprovalEventRow[] = rows;
    return approvalEventRows.map((row) => ({
      eventId: row.event_id,
      approvalId: row.approval_id,
      eventType: row.event_type,
      actorId: row.actor_id,
      timestamp: row.timestamp,
      payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    }));
  }
}

function assertApprovalEventRows(rows: unknown[]): asserts rows is ApprovalEventRow[] {
  for (const row of rows) {
    if (!isApprovalEventRow(row)) {
      throw new TypeError("approval_events query returned an unexpected row shape");
    }
  }
}

function isApprovalEventRow(row: unknown): row is ApprovalEventRow {
  if (!isRecord(row)) {
    return false;
  }
  return typeof row.event_id === "string"
    && typeof row.approval_id === "string"
    && typeof row.event_type === "string"
    && typeof row.actor_id === "string"
    && typeof row.timestamp === "string"
    && typeof row.payload_json === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


