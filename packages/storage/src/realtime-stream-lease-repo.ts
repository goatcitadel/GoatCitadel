import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";

interface RealtimeStreamLeaseRow {
  lease_id: string;
  stream_name: string;
  client_id: string;
  gateway_node_id: string;
  requested_cursor: number | null;
  last_sent_sequence: number | null;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string;
  last_event_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
}

export interface RealtimeStreamLeaseRecord {
  leaseId: string;
  streamName: string;
  clientId: string;
  gatewayNodeId: string;
  requestedCursor?: number;
  lastSentSequence?: number;
  state: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  lastEventAt?: string;
  closedAt?: string;
  closeReason?: string;
}

export class RealtimeStreamLeaseRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly touchStmt;
  private readonly closeStmt;
  private readonly closeSupersededClientStmt;
  private readonly closeOpenNodeStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO realtime_stream_leases (
        lease_id,
        stream_name,
        client_id,
        gateway_node_id,
        requested_cursor,
        last_sent_sequence,
        state,
        created_at,
        updated_at,
        last_heartbeat_at,
        last_event_at,
        closed_at,
        close_reason
      ) VALUES (
        @leaseId,
        @streamName,
        @clientId,
        @gatewayNodeId,
        @requestedCursor,
        NULL,
        'open',
        @createdAt,
        @updatedAt,
        @lastHeartbeatAt,
        NULL,
        NULL,
        NULL
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM realtime_stream_leases WHERE lease_id = ?");
    this.touchStmt = db.prepare(`
      UPDATE realtime_stream_leases
      SET updated_at = @updatedAt,
          last_heartbeat_at = @lastHeartbeatAt,
          requested_cursor = COALESCE(@requestedCursor, requested_cursor),
          last_sent_sequence = COALESCE(@lastSentSequence, last_sent_sequence),
          last_event_at = COALESCE(@lastEventAt, last_event_at)
      WHERE lease_id = @leaseId
        AND state = 'open'
    `);
    this.closeStmt = db.prepare(`
      UPDATE realtime_stream_leases
      SET state = 'closed',
          updated_at = @closedAt,
          last_heartbeat_at = @closedAt,
          closed_at = @closedAt,
          close_reason = @closeReason
      WHERE lease_id = @leaseId
        AND state = 'open'
    `);
    this.closeSupersededClientStmt = db.prepare(`
      UPDATE realtime_stream_leases
      SET state = 'closed',
          updated_at = @closedAt,
          last_heartbeat_at = @closedAt,
          closed_at = @closedAt,
          close_reason = @closeReason
      WHERE stream_name = @streamName
        AND client_id = @clientId
        AND state = 'open'
    `);
    this.closeOpenNodeStmt = db.prepare(`
      UPDATE realtime_stream_leases
      SET state = 'closed',
          updated_at = @closedAt,
          last_heartbeat_at = @closedAt,
          closed_at = @closedAt,
          close_reason = @closeReason
      WHERE gateway_node_id = @gatewayNodeId
        AND state = 'open'
    `);
  }

  public open(input: {
    streamName: string;
    clientId: string;
    gatewayNodeId: string;
    requestedCursor?: number;
    openedAt?: string;
    closeReasonOnReplace?: string;
  }): RealtimeStreamLeaseRecord {
    const openedAt = input.openedAt ?? new Date().toISOString();
    const leaseId = randomUUID();
    this.closeSupersededClientStmt.run({
      streamName: input.streamName,
      clientId: input.clientId,
      closedAt: openedAt,
      closeReason: input.closeReasonOnReplace ?? "superseded",
    });
    this.insertStmt.run({
      leaseId,
      streamName: input.streamName,
      clientId: input.clientId,
      gatewayNodeId: input.gatewayNodeId,
      requestedCursor: input.requestedCursor ?? null,
      createdAt: openedAt,
      updatedAt: openedAt,
      lastHeartbeatAt: openedAt,
    });
    return this.get(leaseId) as RealtimeStreamLeaseRecord;
  }

  public get(leaseId: string): RealtimeStreamLeaseRecord | undefined {
    const row = this.getStmt.get(leaseId) as RealtimeStreamLeaseRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public touch(input: {
    leaseId: string;
    at?: string;
    requestedCursor?: number;
    lastSentSequence?: number;
    lastEventAt?: string;
  }): RealtimeStreamLeaseRecord | undefined {
    const at = input.at ?? new Date().toISOString();
    this.touchStmt.run({
      leaseId: input.leaseId,
      updatedAt: at,
      lastHeartbeatAt: at,
      requestedCursor: input.requestedCursor ?? null,
      lastSentSequence: input.lastSentSequence ?? null,
      lastEventAt: input.lastEventAt ?? null,
    });
    return this.get(input.leaseId);
  }

  public close(input: {
    leaseId: string;
    closedAt?: string;
    closeReason?: string;
  }): RealtimeStreamLeaseRecord | undefined {
    const closedAt = input.closedAt ?? new Date().toISOString();
    this.closeStmt.run({
      leaseId: input.leaseId,
      closedAt,
      closeReason: input.closeReason ?? "closed",
    });
    return this.get(input.leaseId);
  }

  public closeOpenForNode(input: {
    gatewayNodeId: string;
    closedAt?: string;
    closeReason?: string;
  }): number {
    const closedAt = input.closedAt ?? new Date().toISOString();
    const result = this.closeOpenNodeStmt.run({
      gatewayNodeId: input.gatewayNodeId,
      closedAt,
      closeReason: input.closeReason ?? "process_restart",
    });
    return Number(result.changes ?? 0);
  }
}

function mapRow(row: RealtimeStreamLeaseRow): RealtimeStreamLeaseRecord {
  return {
    leaseId: row.lease_id,
    streamName: row.stream_name,
    clientId: row.client_id,
    gatewayNodeId: row.gateway_node_id,
    requestedCursor: typeof row.requested_cursor === "number" ? row.requested_cursor : undefined,
    lastSentSequence: typeof row.last_sent_sequence === "number" ? row.last_sent_sequence : undefined,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastEventAt: row.last_event_at ?? undefined,
    closedAt: row.closed_at ?? undefined,
    closeReason: row.close_reason ?? undefined,
  };
}


