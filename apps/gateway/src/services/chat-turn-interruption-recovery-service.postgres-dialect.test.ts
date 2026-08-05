import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuditLog,
  createDatabase,
  createLocalAsyncStorage,
  Storage,
  TranscriptLog,
  type DatabaseClient,
} from "@goatcitadel/storage";
import { reconcileInterruptedChatTurns } from "./chat-turn-interruption-recovery-service.js";

/**
 * Postgres-dialect variant of chat-turn-interruption-recovery-service.test.ts.
 *
 * Reuses the strict-client harness pattern from
 * durable-run-service.boot-recovery.postgres-dialect.test.ts (PR #182): a
 * postgres-dialect facade over sqlite whose `exec` rejects sqlite-only
 * transaction-control/PRAGMA SQL the way the real Postgres driver does. The
 * reconciler's new cross-table queries (listActive and the orphaned-latest-
 * user-message join) run through prepare/all only, so this pins that the boot
 * reconciliation path never issues dialect-unsafe raw exec statements. The
 * sqlite-backed facade strips only Postgres row-lock syntax used by repository
 * startup recovery; real Postgres coverage owns that syntax's semantics.
 */

interface Harness {
  rootDir: string;
  storage: Storage;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

function createPostgresDialectStrictDb(rootDir: string): DatabaseClient {
  const inner = createDatabase({ dbPath: path.join(rootDir, "backing.sqlite") });
  return {
    dialect: "postgres",
    prepare: (sql) => {
      let stmt: ReturnType<DatabaseClient["prepare"]> | undefined;
      const resolve = () => (stmt ??= inner.prepare(translatePostgresSqlForSqlite(sql)));
      return {
        run: (...params: unknown[]) => resolve().run(...params),
        get: (...params: unknown[]) => resolve().get(...params),
        all: (...params: unknown[]) => resolve().all(...params),
      };
    },
    exec: (sql) => {
      const leadingKeyword =
        sql
          .trim()
          .split(/[\s;(]+/, 1)[0]
          ?.toUpperCase() ?? "";
      if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "PRAGMA", "END"].includes(leadingKeyword)) {
        throw new Error(`sqlite-dialect exec reached the postgres driver: "${sql.trim().slice(0, 40)}"`);
      }
      inner.exec(sql);
    },
    close: () => inner.close(),
    transaction: (mode, callback) => inner.transaction(mode, callback),
  };
}

function translatePostgresSqlForSqlite(sql: string): string {
  return sql.replace(/\bFOR UPDATE(?:\s+SKIP LOCKED)?\b/giu, "");
}

function createHarness(): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-turn-interruption-pg-dialect-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });
  const storage = new Storage({
    db: createPostgresDialectStrictDb(rootDir),
    transcriptsDir,
    auditDir,
    transcripts: new TranscriptLog(transcriptsDir),
    audit: new AuditLog(auditDir),
  });
  const harness = { rootDir, storage };
  harnesses.push(harness);
  return harness;
}

describe("chat-turn interruption recovery on the postgres dialect", () => {
  it("reconciles a stranded trace and an orphaned user message without sqlite-only exec statements", async () => {
    const { storage } = createHarness();
    storage.chatMessages.upsert({
      messageId: "msg-stranded",
      sessionId: "session-stranded",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "stranded turn",
      timestamp: "2026-07-07T19:46:19.000Z",
    });
    storage.chatTurnTraces.create({
      turnId: "turn-stranded",
      sessionId: "session-stranded",
      userMessageId: "msg-stranded",
      status: "running",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: "2026-07-07T19:46:20.000Z",
    });
    storage.chatMessages.upsert({
      messageId: "msg-orphan",
      sessionId: "session-orphan",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "orphaned message",
      timestamp: "2026-07-07T19:50:00.000Z",
    });

    const result = await reconcileInterruptedChatTurns({
      storage: createLocalAsyncStorage(storage),
      publishRealtime: vi.fn(async () => undefined),
      recordDevDiagnostic: vi.fn(),
      now: () => "2026-07-07T20:00:00.000Z",
    });

    expect(result.interruptedTurnIds).toEqual(["turn-stranded"]);
    expect(result.synthesizedTurnIds).toHaveLength(1);
    expect(storage.chatTurnTraces.get("turn-stranded").status).toBe("failed");
    expect(storage.chatTurnTraces.get(result.synthesizedTurnIds[0]!).failure?.failureClass).toBe(
      "interrupted_by_restart",
    );
  });
});
