import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient, DbStatement, DbTransactionMode } from "./db.js";
import { PostgresAuditLog } from "./postgres-audit-log.js";

interface StoredAuditRow {
  stream_name: string;
  event_id: string;
  event_sequence: number;
  occurred_at: string;
  actor_id: string | null;
  payload: string;
}

test("PostgresAuditLog strips null bytes from JSONB payloads before insert", async () => {
  const db = new InMemoryAuditDb();
  const log = new PostgresAuditLog(db);

  await log.append("tool_invocations", {
    actorId: "agent-1",
    detail: "bad\u0000value",
    nested: {
      "bad\u0000key": "still\u0000bad",
    },
  });

  assert.equal(db.rows.length, 1);
  const stored = db.rows[0];
  assert.ok(stored);
  assert.equal(stored.payload.includes("\\u0000"), false);
});

test("PostgresAuditLog strips lone surrogate escapes from JSONB payloads before insert", async () => {
  const db = new InMemoryAuditDb();
  const log = new PostgresAuditLog(db);

  await log.append("tool_invocations", {
    actorId: "agent-1",
    detail: "bad\ud800value",
    nested: {
      "bad\udc00key": "still\udc00bad",
      validPair: "smile \ud83d\ude00",
    },
  });

  assert.equal(db.rows.length, 1);
  const stored = db.rows[0];
  assert.ok(stored);
  assert.equal(stored.payload.includes("\\ud800"), false);
  assert.equal(stored.payload.includes("\\udc00"), false);
  assert.equal(stored.payload.includes("😀"), true);
});

class InMemoryAuditDb implements DatabaseClient {
  public readonly dialect = "postgres" as const;
  public readonly rows: StoredAuditRow[] = [];

  public prepare(sql: string): DbStatement {
    if (sql.includes("COALESCE(MAX(event_sequence), 0) + 1")) {
      return {
        run: () => ({ changes: 0 }),
        get: <T = unknown>(streamName: unknown) => ({
          next_sequence: this.rows
            .filter((row) => row.stream_name === streamName)
            .reduce((max, row) => Math.max(max, row.event_sequence), 0) + 1,
        }) as T,
        all: () => [],
      };
    }
    if (sql.includes("INSERT INTO audit_events")) {
      return {
        run: (params: unknown) => {
          const input = params as Record<string, unknown>;
          this.rows.push({
            stream_name: String(input.streamName),
            event_id: String(input.eventId),
            event_sequence: Number(input.eventSequence),
            occurred_at: String(input.occurredAt),
            actor_id: typeof input.actorId === "string" ? input.actorId : null,
            payload: String(input.payload),
          });
          return { changes: 1 };
        },
        get: () => undefined,
        all: () => [],
      };
    }
    if (sql.includes("SELECT payload") && sql.includes("FROM audit_events")) {
      return {
        run: () => ({ changes: 0 }),
        get: () => undefined,
        all: <T = unknown>(streamName: unknown) =>
          this.rows.filter((row) => row.stream_name === streamName).map((row) => ({ payload: row.payload })) as T[],
      };
    }
    throw new Error(`Unexpected SQL in audit test double: ${sql}`);
  }

  public exec(_sql: string): void {}

  public close(): void {}

  public transaction<T>(_mode: DbTransactionMode, callback: () => T): T {
    return callback();
  }
}
