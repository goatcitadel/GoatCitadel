import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChatMessageRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatMessageRepository } from "./chat-message-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import { ChatTurnRecoveryRepository } from "./chat-turn-recovery-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createStore(): {
  db: DatabaseClient;
  messages: ChatMessageRepository;
  traces: ChatTurnTraceRepository;
  recovery: ChatTurnRecoveryRepository;
} {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-turn-recovery-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    db,
    messages: new ChatMessageRepository(db),
    traces: new ChatTurnTraceRepository(db),
    recovery: new ChatTurnRecoveryRepository(db),
  };
}

function message(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    messageId: `msg-${randomUUID()}`,
    sessionId: "session-a",
    role: "user",
    actorType: "user",
    actorId: "operator",
    sourceAuthority: "operator",
    content: "hello",
    timestamp: "2026-07-07T19:46:19.000Z",
    ...overrides,
  };
}

describe("ChatTurnRecoveryRepository", () => {
  it("finds the latest user message of a session that has no turn trace", () => {
    const { messages, recovery } = createStore();
    messages.upsert(message({ messageId: "msg-orphan", sessionId: "session-a" }));

    const orphans = recovery.listOrphanedLatestUserMessages();

    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]?.sessionId, "session-a");
    assert.equal(orphans[0]?.messageId, "msg-orphan");
    assert.equal(orphans[0]?.timestamp, "2026-07-07T19:46:19.000Z");
  });

  it("ignores user messages that already have a turn trace", () => {
    const { messages, traces, recovery } = createStore();
    messages.upsert(message({ messageId: "msg-traced", sessionId: "session-b" }));
    traces.create({
      turnId: "turn-traced",
      sessionId: "session-b",
      userMessageId: "msg-traced",
      status: "failed",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: "2026-07-07T19:46:19.000Z",
    });

    assert.deepEqual(recovery.listOrphanedLatestUserMessages(), []);
  });

  it("ignores sessions whose latest message is an assistant reply", () => {
    const { messages, recovery } = createStore();
    messages.upsert(message({ messageId: "msg-user", sessionId: "session-c", timestamp: "2026-07-07T19:00:00.000Z" }));
    messages.upsert(
      message({
        messageId: "msg-assistant",
        sessionId: "session-c",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        timestamp: "2026-07-07T19:00:05.000Z",
      }),
    );

    assert.deepEqual(recovery.listOrphanedLatestUserMessages(), []);
  });

  it("ignores latest user messages persisted by non-user actors (autonomous seeds)", () => {
    const { messages, recovery } = createStore();
    messages.upsert(
      message({ messageId: "msg-heartbeat", sessionId: "session-d", actorType: "system", actorId: "heartbeat" }),
    );

    assert.deepEqual(recovery.listOrphanedLatestUserMessages(), []);
  });

  it("only reports the newest message per session and honours the limit", () => {
    const { messages, traces, recovery } = createStore();
    // Older user message already has its turn; the crash orphaned only the newest one.
    messages.upsert(message({ messageId: "msg-old", sessionId: "session-e", timestamp: "2026-07-07T18:00:00.000Z" }));
    traces.create({
      turnId: "turn-old",
      sessionId: "session-e",
      userMessageId: "msg-old",
      status: "completed",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: "2026-07-07T18:00:00.000Z",
      finishedAt: "2026-07-07T18:00:30.000Z",
    });
    messages.upsert(message({ messageId: "msg-new", sessionId: "session-e", timestamp: "2026-07-07T19:46:19.000Z" }));
    messages.upsert(message({ messageId: "msg-other", sessionId: "session-f" }));

    const orphans = recovery.listOrphanedLatestUserMessages();
    assert.deepEqual(orphans.map((item) => item.messageId).sort(), ["msg-new", "msg-other"]);

    assert.equal(recovery.listOrphanedLatestUserMessages(1).length, 1);
  });
});
