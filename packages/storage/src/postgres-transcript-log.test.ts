import assert from "node:assert/strict";
import test from "node:test";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement, DbTransactionMode } from "./db.js";
import { PostgresTranscriptLog } from "./postgres-transcript-log.js";

interface StoredTranscriptRow {
  event_id: string;
  action_id: string | null;
  idempotency_key: string | null;
  session_id: string;
  session_key: string | null;
  occurred_at: string;
  event_type: TranscriptEvent["type"];
  actor_type: TranscriptEvent["actorType"];
  actor_id: string;
  payload: unknown;
  token_input: number | null;
  token_output: number | null;
  cost_usd: number | null;
  event_sequence: number;
}

test("PostgresTranscriptLog reuses the existing sequence when the same event is appended twice", async () => {
  const db = new InMemoryTranscriptDb();
  const log = new PostgresTranscriptLog(db);
  const event = buildEvent();

  const first = await log.append(event);
  const second = await log.append(event);
  const stored = await log.read(event.sessionId);

  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.eventId, event.eventId);
});

test("PostgresTranscriptLog strips null bytes from payloads before JSONB persistence", async () => {
  const db = new InMemoryTranscriptDb();
  const log = new PostgresTranscriptLog(db);
  const event = buildEvent({
    payload: {
      message: {
        role: "assistant",
        content: "hello\u0000world",
      },
      labels: ["ok", "nu\u0000ll"],
      optional: null,
      nested: {
        "bad\u0000key": "va\u0000lue",
      },
    },
  });

  await log.append(event);
  const stored = db.rows[0];
  const readBack = await log.read(event.sessionId);

  assert.ok(stored);
  assert.equal(String(stored.payload).includes("\\u0000"), false);
  assert.deepEqual(readBack[0]?.payload, {
    message: {
      role: "assistant",
      content: "helloworld",
    },
    labels: ["ok", "null"],
    optional: null,
    nested: {
      badkey: "value",
    },
  });
});

test("PostgresTranscriptLog preserves literal null escape sequences in JSON text", async () => {
  const db = new InMemoryTranscriptDb();
  const log = new PostgresTranscriptLog(db);
  const event = buildEvent({
    payload: {
      message: {
        role: "assistant",
        content: String.raw`hello\u0000world`,
      },
      labels: ["ok", String.raw`nu\u0000ll`],
      nested: {
        [String.raw`bad\u0000key`]: String.raw`va\u0000lue`,
      },
    },
  });

  await log.append(event);
  const stored = db.rows[0];
  const readBack = await log.read(event.sessionId);

  assert.ok(stored);
  assert.equal(String(stored.payload).includes(String.raw`\u0000`), true);
  assert.deepEqual(readBack[0]?.payload, {
    message: {
      role: "assistant",
      content: String.raw`hello\u0000world`,
    },
    labels: ["ok", String.raw`nu\u0000ll`],
    nested: {
      [String.raw`bad\u0000key`]: String.raw`va\u0000lue`,
    },
  });
});

test("PostgresTranscriptLog strips lone surrogate code points before JSONB persistence", async () => {
  const db = new InMemoryTranscriptDb();
  const log = new PostgresTranscriptLog(db);
  const event = buildEvent({
    payload: {
      message: {
        role: "assistant",
        content: "bad\ud800value",
      },
      labels: ["ok", "bad\udc00label"],
      nested: {
        "bad\udc00key": "still\ud800bad",
        validPair: "smile \ud83d\ude00",
      },
    },
  });

  await log.append(event);
  const stored = db.rows[0];
  const readBack = await log.read(event.sessionId);

  assert.ok(stored);
  assert.equal(String(stored.payload).includes("\\ud800"), false);
  assert.equal(String(stored.payload).includes("\\udc00"), false);
  assert.equal(String(stored.payload).includes("😀"), true);
  assert.deepEqual(readBack[0]?.payload, {
    message: {
      role: "assistant",
      content: "badvalue",
    },
    labels: ["ok", "badlabel"],
    nested: {
      badkey: "stillbad",
      validPair: "smile 😀",
    },
  });
});

test("PostgresTranscriptLog handles insert races, object payload rows, malformed JSON, and deletes", async () => {
  const db = new InMemoryTranscriptDb();
  const log = new PostgresTranscriptLog(db);

  db.forceInsertNoop = true;
  assert.equal(await log.append(buildEvent({ eventId: "evt-noop" })), 1);
  db.forceInsertNoop = false;

  db.rows.push(
    buildStoredRow({ event_id: "evt-object", event_sequence: 1, payload: { direct: true } }),
    buildStoredRow({ event_id: "evt-malformed", event_sequence: 2, payload: "{bad-json" }),
  );

  const readBack = await log.read("sess-1");
  assert.deepEqual(
    readBack.map((event) => event.payload),
    [{ direct: true }, {}],
  );

  await log.delete("sess-1");
  assert.deepEqual(await log.read("sess-1"), []);
});

class InMemoryTranscriptDb implements DatabaseClient {
  public readonly dialect = "postgres" as const;
  public readonly rows: StoredTranscriptRow[] = [];
  public forceInsertNoop = false;

  public prepare(sql: string): DbStatement {
    if (sql.includes("COALESCE(MAX(event_sequence), 0) + 1")) {
      return {
        run: () => ({ changes: 0 }),
        get: <T = unknown>(sessionId: unknown) =>
          ({
            next_sequence:
              this.rows
                .filter((row) => row.session_id === sessionId)
                .reduce((max, row) => Math.max(max, row.event_sequence), 0) + 1,
          }) as T,
        all: () => [],
      };
    }

    if (sql.includes("SELECT event_sequence") && sql.includes("AND event_id = ?")) {
      return {
        run: () => ({ changes: 0 }),
        get: <T = unknown>(sessionId: unknown, eventId: unknown) => {
          const row = this.rows.find((item) => item.session_id === sessionId && item.event_id === eventId);
          return (row ? { event_sequence: row.event_sequence } : undefined) as T | undefined;
        },
        all: () => [],
      };
    }

    if (sql.includes("INSERT INTO transcript_events")) {
      return {
        run: (params: unknown) => {
          const input = params as Record<string, unknown>;
          if (this.forceInsertNoop) {
            return { changes: 0 };
          }
          const existing = this.rows.find(
            (row) => row.session_id === input.sessionId && row.event_id === input.eventId,
          );
          if (existing) {
            return { changes: 0 };
          }
          this.rows.push({
            session_id: String(input.sessionId),
            event_id: String(input.eventId),
            event_sequence: Number(input.eventSequence),
            action_id: toNullableString(input.actionId),
            idempotency_key: toNullableString(input.idempotencyKey),
            session_key: toNullableString(input.sessionKey),
            occurred_at: String(input.occurredAt),
            event_type: input.eventType as TranscriptEvent["type"],
            actor_type: input.actorType as TranscriptEvent["actorType"],
            actor_id: String(input.actorId),
            payload: String(input.payload),
            token_input: toNullableNumber(input.tokenInput),
            token_output: toNullableNumber(input.tokenOutput),
            cost_usd: toNullableNumber(input.costUsd),
          });
          return { changes: 1 };
        },
        get: () => undefined,
        all: () => [],
      };
    }

    if (sql.includes("FROM transcript_events") && sql.includes("ORDER BY event_sequence ASC")) {
      return {
        run: () => ({ changes: 0 }),
        get: () => undefined,
        all: <T = unknown>(sessionId: unknown) =>
          this.rows
            .filter((row) => row.session_id === sessionId)
            .sort((left, right) => left.event_sequence - right.event_sequence) as T[],
      };
    }

    if (sql.includes("DELETE FROM transcript_events")) {
      return {
        run: (sessionId: unknown) => {
          const before = this.rows.length;
          const kept = this.rows.filter((row) => row.session_id !== sessionId);
          this.rows.splice(0, this.rows.length, ...kept);
          return { changes: before - this.rows.length };
        },
        get: () => undefined,
        all: () => [],
      };
    }

    throw new Error(`Unexpected SQL in test double: ${sql}`);
  }

  public exec(_sql: string): void {}

  public close(): void {}

  public transaction<T>(_mode: DbTransactionMode, callback: () => T): T {
    return callback();
  }
}

function buildStoredRow(overrides: Partial<StoredTranscriptRow>): StoredTranscriptRow {
  return {
    event_id: "evt-1",
    action_id: null,
    idempotency_key: null,
    session_id: "sess-1",
    session_key: null,
    occurred_at: "2026-04-15T22:00:00.000Z",
    event_type: "message.assistant",
    actor_type: "agent",
    actor_id: "assistant:test",
    payload: "{}",
    token_input: null,
    token_output: null,
    cost_usd: null,
    event_sequence: 1,
    ...overrides,
  };
}

function buildEvent(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    eventId: "evt-1",
    actionId: "action-1",
    idempotencyKey: "idem-1",
    sessionId: "sess-1",
    sessionKey: "chat:local:test",
    timestamp: "2026-04-15T22:00:00.000Z",
    type: "message.assistant",
    actorType: "agent",
    actorId: "assistant:test",
    payload: {
      message: {
        role: "assistant",
        content: "hello world",
      },
    },
    tokenInput: 10,
    tokenOutput: 20,
    costUsd: 0.01,
    ...overrides,
  };
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
