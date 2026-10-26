import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseClient } from "./db.js";
import { ChatSessionBindingRepository } from "./chat-session-binding-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createStore(): { db: DatabaseClient; repo: ChatSessionBindingRepository } {
  const dbPath = tempDbs.path("goatcitadel-chat-session-binding");
  const db = tempDbs.open({ dbPath });
  return { db, repo: new ChatSessionBindingRepository(db) };
}

function setRawField(db: DatabaseClient, sessionId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_session_bindings SET ${field} = ? WHERE session_id = ?`).run(value, sessionId);
}

describe("ChatSessionBindingRepository", () => {
  it("upserts, preserves defaults, and lists bindings by session and workspace", () => {
    const { repo } = createStore();
    const first = repo.upsert(
      {
        sessionId: "session-a",
        workspaceId: " workspace-a ",
        transport: "integration",
        connectionId: "connection-a",
        target: "slack:#ops",
        writable: false,
      },
      "2026-03-26T00:00:01.000Z",
    );

    assert.deepEqual(first, {
      sessionId: "session-a",
      transport: "integration",
      connectionId: "connection-a",
      target: "slack:#ops",
      writable: false,
      createdAt: "2026-03-26T00:00:01.000Z",
      updatedAt: "2026-03-26T00:00:01.000Z",
    });
    assert.deepEqual(repo.get("session-a"), first);

    const updated = repo.upsert(
      {
        sessionId: "session-a",
        transport: "llm",
      },
      "2026-03-26T00:00:02.000Z",
    );
    assert.equal(updated.transport, "llm");
    assert.equal(updated.connectionId, undefined);
    assert.equal(updated.target, undefined);
    assert.equal(updated.writable, false);
    assert.equal(updated.createdAt, "2026-03-26T00:00:01.000Z");
    assert.equal(updated.updatedAt, "2026-03-26T00:00:02.000Z");

    assert.deepEqual(repo.listBySessionIds([]), new Map());
    assert.deepEqual(repo.listBySessionIds(["session-a"], "workspace-a").get("session-a"), updated);
    assert.equal(repo.listBySessionIds(["session-a"], "workspace-b").size, 0);
    assert.equal(repo.get("missing-session"), undefined);
    assert.throws(
      () => repo.upsert({ sessionId: "session-b", workspaceId: "bad workspace", transport: "llm" }),
      /workspaceId contains unsupported characters/,
    );
    assert.throws(() => repo.listBySessionIds(["session-a"], " "), /workspaceId is required/);
  });

  it("round-trips conversation details and keeps them when a later upsert omits them", () => {
    const { db, repo } = createStore();
    const direct = { kind: "direct" as const, counterpartActorId: "42", title: "Sam Lee" };
    const first = repo.upsert(
      {
        sessionId: "session-a",
        workspaceId: "workspace-a",
        transport: "integration",
        connectionId: "connection-a",
        target: "telegram:42",
        conversation: direct,
      },
      "2026-03-26T00:00:01.000Z",
    );
    assert.deepEqual(first.conversation, direct);
    assert.equal(first.target, "telegram:42");
    assert.deepEqual(repo.get("session-a")?.conversation, direct);
    // Stored beside the target in the existing column; no new column or table.
    const stored = db
      .prepare("SELECT target_json FROM chat_session_bindings WHERE session_id = ?")
      .get("session-a") as {
      target_json: string;
    };
    assert.deepEqual(JSON.parse(stored.target_json), { target: "telegram:42", conversation: direct });

    const withoutConversation = repo.upsert(
      {
        sessionId: "session-a",
        transport: "integration",
        connectionId: "connection-a",
        target: "telegram:42",
      },
      "2026-03-26T00:00:02.000Z",
    );
    assert.deepEqual(withoutConversation.conversation, direct);
    assert.equal(withoutConversation.target, "telegram:42");

    const group = { kind: "group" as const, title: "Family group" };
    const refreshed = repo.upsert(
      {
        sessionId: "session-a",
        transport: "integration",
        connectionId: "connection-a",
        target: "telegram:42",
        conversation: group,
      },
      "2026-03-26T00:00:03.000Z",
    );
    assert.deepEqual(refreshed.conversation, group);

    const leftChannel = repo.upsert({ sessionId: "session-a", transport: "llm" }, "2026-03-26T00:00:04.000Z");
    assert.equal(leftChannel.conversation, undefined);
    assert.equal(leftChannel.target, undefined);
  });

  it("drops the stored conversation when a later upsert points the binding at a different connection or target", () => {
    const { repo } = createStore();
    const direct = { kind: "direct" as const, counterpartActorId: "42", title: "Sam Lee" };
    const seed = (): void => {
      repo.upsert({
        sessionId: "session-a",
        transport: "integration",
        connectionId: "connection-a",
        target: "telegram:42",
        conversation: direct,
      });
    };

    seed();
    const sameBinding = repo.upsert({
      sessionId: "session-a",
      transport: "integration",
      connectionId: "connection-a",
      target: "telegram:42",
    });
    assert.deepEqual(sameBinding.conversation, direct);

    const otherTarget = repo.upsert({
      sessionId: "session-a",
      transport: "integration",
      connectionId: "connection-a",
      target: "telegram:77",
    });
    assert.equal(otherTarget.conversation, undefined);
    assert.equal(otherTarget.target, "telegram:77");
    assert.equal(repo.get("session-a")?.conversation, undefined);

    seed();
    const otherConnection = repo.upsert({
      sessionId: "session-a",
      transport: "integration",
      connectionId: "connection-b",
      target: "telegram:42",
    });
    assert.equal(otherConnection.conversation, undefined);

    seed();
    const targetCleared = repo.upsert({
      sessionId: "session-a",
      transport: "integration",
      connectionId: "connection-a",
    });
    assert.equal(targetCleared.conversation, undefined);

    // A caller that re-points the binding and supplies fresh details still gets them stored.
    seed();
    const group = { kind: "group" as const, title: "Family group" };
    const repointedWithDetails = repo.upsert({
      sessionId: "session-a",
      transport: "integration",
      connectionId: "connection-b",
      target: "telegram:-100",
      conversation: group,
    });
    assert.deepEqual(repointedWithDetails.conversation, group);
  });

  it("normalizes conversation details and ignores stored ones that are malformed", () => {
    const { db, repo } = createStore();
    repo.upsert({ sessionId: "session-a", transport: "integration", target: "telegram:42" });

    const normalized = repo.upsert({
      sessionId: "session-a",
      transport: "integration",
      target: "telegram:42",
      conversation: { kind: "group", counterpartActorId: "9", title: " Family group " },
    });
    assert.deepEqual(normalized.conversation, { kind: "group", title: "Family group" });

    for (const conversation of ["direct", [], { kind: "channel" }, { counterpartActorId: "42" }]) {
      setRawField(db, "session-a", "target_json", JSON.stringify({ target: "telegram:42", conversation }));
      const binding = repo.get("session-a");
      assert.equal(binding?.target, "telegram:42");
      assert.equal(binding?.conversation, undefined);
    }

    // A recognised kind survives; fields of the wrong type or outside the contract are dropped.
    setRawField(
      db,
      "session-a",
      "target_json",
      JSON.stringify({
        target: "telegram:42",
        conversation: { kind: "direct", counterpartActorId: 42, title: ["x"], extra: "dropped" },
      }),
    );
    assert.deepEqual(repo.get("session-a")?.conversation, { kind: "direct" });

    // JSON that is not an object at all leaves a binding with neither target nor conversation.
    setRawField(db, "session-a", "target_json", "null");
    assert.equal(repo.get("session-a")?.target, undefined);
    assert.equal(repo.get("session-a")?.conversation, undefined);
  });

  it("lists bindings by session id", () => {
    const { repo } = createStore();
    const direct = { kind: "direct" as const, counterpartActorId: "42", title: "Sam Lee" };
    repo.upsert({ sessionId: "session-a", transport: "integration", target: "t-a", conversation: direct });
    repo.upsert({ sessionId: "session-b", transport: "integration", target: "t-b" });
    repo.upsert({ sessionId: "session-c", transport: "llm" });

    const listed = repo.listBySessionIds(["session-a", "session-b", "session-missing"]);
    assert.deepEqual([...listed.keys()].sort(), ["session-a", "session-b"]);
    assert.deepEqual(listed.get("session-a")?.conversation, direct);
    assert.equal(listed.get("session-b")?.conversation, undefined);
    assert.equal(listed.get("session-b")?.target, "t-b");
  });

  it("fails clearly on malformed stored rows and malformed targets", () => {
    const { db, repo } = createStore();
    repo.upsert({
      sessionId: "session-a",
      workspaceId: "workspace-a",
      transport: "integration",
      target: "discord:ops",
    });

    setRawField(db, "session-a", "target_json", "[]");
    assert.equal(repo.get("session-a")?.target, undefined);

    setRawField(db, "session-a", "writable", new Uint8Array([1]));
    assert.throws(() => repo.get("session-a"), /Unexpected chat_session_bindings row shape/);
    assert.throws(() => repo.listBySessionIds(["session-a"]), /Unexpected chat_session_bindings row shape/);

    const unreadableStore = createStore();
    const internal = unreadableStore.repo as unknown as {
      getStmt: { get: (...args: unknown[]) => unknown };
    };
    internal.getStmt = { get: () => undefined };
    assert.throws(
      () =>
        unreadableStore.repo.upsert({
          sessionId: "session-unreadable",
          transport: "llm",
        }),
      /chat_session_bindings upsert did not return a row/,
    );
  });
});
