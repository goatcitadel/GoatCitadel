import type { DatabaseSync } from "node:sqlite";

export function createRealtimeStreamLeaseSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS realtime_stream_leases (
      lease_id TEXT PRIMARY KEY,
      stream_name TEXT NOT NULL,
      client_id TEXT NOT NULL,
      gateway_node_id TEXT NOT NULL,
      requested_cursor INTEGER,
      last_sent_sequence INTEGER,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      last_event_at TEXT,
      closed_at TEXT,
      close_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_realtime_stream_leases_stream_state_updated
      ON realtime_stream_leases(stream_name, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_realtime_stream_leases_client_state_updated
      ON realtime_stream_leases(client_id, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_realtime_stream_leases_node_state_updated
      ON realtime_stream_leases(gateway_node_id, state, updated_at DESC);
  `);
}
