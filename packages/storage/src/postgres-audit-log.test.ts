import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient, DbStatement, DbTransactionMode } from "./db.js";
import { PostgresAuditLog } from "./postgres-audit-log.js";
import { runWithRequestAttribution } from "./request-attribution.js";

interface StoredAuditRow {
  stream_name: string;
  event_id: string;
  event_sequence: number;
  occurred_at: string;
  actor_id: string | null;
  payload: unknown;
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
  assert.equal(String(stored.payload).includes("\\u0000"), false);
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
  assert.equal(String(stored.payload).includes("\\ud800"), false);
  assert.equal(String(stored.payload).includes("\\udc00"), false);
  assert.equal(String(stored.payload).includes("😀"), true);
});

test("PostgresAuditLog lists JSON strings, object payloads, and skips malformed payload rows", async () => {
  const db = new InMemoryAuditDb();
  const log = new PostgresAuditLog(db);

  db.rows.push(
    auditRow({ event_id: "event-empty", event_sequence: 1, payload: "" }),
    auditRow({ event_id: "event-object", event_sequence: 2, payload: { direct: true } }),
    auditRow({ event_id: "event-json", event_sequence: 3, payload: '{"parsed":true}' }),
    auditRow({ event_id: "event-scalar", event_sequence: 4, payload: '"scalar"' }),
    auditRow({ event_id: "event-bad-json", event_sequence: 5, payload: "{not-json" }),
  );

  const listed = await log.list("tool_invocations");

  assert.deepEqual(listed, [{ direct: true }, { parsed: true }]);
});

test("PostgresAuditLog appends without actor attribution and sanitizes arrays", async () => {
  const db = new InMemoryAuditDb();
  const log = new PostgresAuditLog(db);

  await log.append("tool_invocations", {
    eventId: "event-array",
    values: ["ok", "bad\u0000value"],
  });

  assert.equal(db.rows[0]?.actor_id, null);
  assert.equal(String(db.rows[0]?.payload).includes("\\u0000"), false);
});

test("PostgresAuditLog fills request attribution and falls back when sequence rows are missing", async () => {
  const db = new InMemoryAuditDb();
  db.omitNextSequenceRow = true;
  const log = new PostgresAuditLog(db);

  await runWithRequestAttribution(
    {
      correlationId: "corr-attribution",
      traceId: "trace-attribution",
      originSurface: "code",
      actorId: "operator-1",
      deviceId: "device-1",
      grantId: "grant-1",
      companionSessionId: "companion-1",
    },
    () =>
      log.append("tool_invocations", {
        eventId: "event-attribution",
        detail: "from attribution",
      }),
  );

  assert.equal(db.rows[0]?.event_sequence, 1);
  assert.equal(db.rows[0]?.actor_id, "operator-1");
  const payload = JSON.parse(String(db.rows[0]?.payload)) as Record<string, unknown>;
  assert.equal(payload.correlationId, "corr-attribution");
  assert.equal(payload.traceId, "trace-attribution");
  assert.equal(payload.originSurface, "code");
  assert.equal(payload.deviceId, "device-1");
  assert.equal(payload.grantId, "grant-1");
  assert.equal(payload.companionSessionId, "companion-1");
});

function auditRow(overrides: Partial<StoredAuditRow>): StoredAuditRow {
  return {
    stream_name: "tool_invocations",
    event_id: "event",
    event_sequence: 1,
    occurred_at: "2026-02-27T10:00:00.000Z",
    actor_id: null,
    payload: "{}",
    ...overrides,
  };
}

class InMemoryAuditDb implements DatabaseClient {
  public readonly dialect = "postgres" as const;
  public readonly rows: StoredAuditRow[] = [];
  public omitNextSequenceRow = false;

  public prepare(sql: string): DbStatement {
    if (sql.includes("COALESCE(MAX(event_sequence), 0) + 1")) {
      return {
        run: () => ({ changes: 0 }),
        get: <T = unknown>(streamName: unknown) => {
          if (this.omitNextSequenceRow) {
            this.omitNextSequenceRow = false;
            return undefined as T;
          }
          return {
            next_sequence:
              this.rows
                .filter((row) => row.stream_name === streamName)
                .reduce((max, row) => Math.max(max, row.event_sequence), 0) + 1,
          } as T;
        },
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
