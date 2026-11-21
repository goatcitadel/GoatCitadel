import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import type { MemoryClaim, MemoryLearningRecord } from "@goatcitadel/contracts";
import { MemoryLearningRepository } from "./memory-learning-repo.js";
import { LearnedMemoryRepository } from "./learned-memory-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
import { SessionRepository } from "./session-repo.js";
import { ChatMessageRepository } from "./chat-message-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";

const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
it("binds consolidation to full canonical private operator source bytes and current scope", () => {
  const db = files.open({ dbPath: files.path("canonical-consolidation") }),
    repo = new MemoryLearningRepository(db),
    now = new Date().toISOString();
  new SessionRepository(db).upsert({
    sessionId: "dm",
    sessionKey: "dm",
    kind: "dm",
    channel: "web",
    account: "operator",
    timestamp: now,
  });
  const meta = new ChatSessionMetaRepository(db);
  meta.ensure("dm", now, "default");
  meta.patch("dm", { origin: "operator" });
  const messages = new ChatMessageRepository(db);
  messages.upsert({
    sessionId: "dm",
    messageId: "u",
    role: "user",
    actorType: "user",
    actorId: "operator",
    sourceAuthority: "operator",
    content: "Keep the original requirement. " + "x".repeat(500),
    timestamp: now,
  });
  messages.upsert({
    sessionId: "dm",
    messageId: "a",
    role: "assistant",
    actorType: "agent",
    actorId: "assistant",
    sourceAuthority: "agent_proposed",
    content: "Completed the review",
    timestamp: now,
  });
  new ChatTurnTraceRepository(db).create({
    sessionId: "dm",
    turnId: "t",
    userMessageId: "u",
    assistantMessageId: "a",
    status: "completed",
    finishedAt: now,
    completion: { status: "complete", repaired: false, providerCallCount: 1 },
    mode: "chat",
    webMode: "off",
    memoryMode: "auto",
    thinkingLevel: "standard",
  });
  const input = { workspaceId: "default", sessionId: "dm", turnIds: ["t"] },
    first = repo.readConsolidationSource(input);
  assert.ok(first);
  assert.equal(first.events.length, 2);
  assert.equal(repo.readConsolidationSource({ ...input, workspaceId: "foreign" }), undefined);
  db.prepare("UPDATE chat_messages SET content=content || ' late correction' WHERE message_id='u'").run();
  assert.notEqual(repo.readConsolidationSource(input)?.sourceHash, first.sourceHash);
  db.prepare("UPDATE chat_turn_traces SET memory_mode='off' WHERE turn_id='t'").run();
  assert.equal(repo.readConsolidationSource(input), undefined);
  db.prepare("UPDATE chat_turn_traces SET memory_mode='auto' WHERE turn_id='t'").run();
  db.prepare("UPDATE chat_messages SET content=? WHERE message_id='u'").run("ordinary text ".repeat(6000));
  const excluded = repo.inspectConsolidationSource(input);
  assert.equal(excluded.status, "excluded");
  assert.ok("sourceHash" in excluded && /^[a-f0-9]{64}$/.test(excluded.sourceHash));
  assert.equal(repo.readConsolidationSource(input), undefined);
});
const claim: MemoryClaim = {
  identity: {
    subject: "operator",
    predicate: "reply_length",
    scope: { kind: "workspace", id: "default" },
    cardinality: "scalar",
  },
  value: "concise",
};
function learning(learningId: string, overrides: Partial<MemoryLearningRecord> = {}): MemoryLearningRecord {
  return {
    learningId,
    workspaceId: "default",
    key: "reply",
    type: "operator_preference",
    insight: "Prefer concise replies",
    confidence: 0.8,
    status: "trusted",
    authority: "operator",
    sourceRefs: [],
    fileRefs: [],
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
    claim,
    ...overrides,
  };
}

it("retains one trusted scalar property, rejects stale corrections, and preserves prior history", () => {
  const db = files.open({ dbPath: files.path("memory-claims") });
  try {
    const repo = new MemoryLearningRepository(db);
    const old = repo.insert(learning("old"));
    assert.equal(old.sourceHash?.length, 64);
    assert.deepEqual(old.claim, claim);
    assert.throws(() => repo.insert(learning("competing")));
    const next = learning("next", { claim: { ...claim, value: "detailed" }, insight: "Prefer detailed replies" });
    assert.throws(() => repo.supersede({ learningId: old.learningId, expectedSourceHash: "stale", next }));
    assert.equal(repo.get("old")?.status, "trusted");
    const applied = repo.supersede({ learningId: old.learningId, expectedSourceHash: old.sourceHash!, next });
    assert.equal(applied.previous.status, "superseded");
    assert.equal(applied.previous.insight, "Prefer concise replies");
    assert.equal(applied.previous.supersededById, "next");
    assert.equal(applied.next.status, "trusted");
    assert.throws(() =>
      repo.supersede({ learningId: old.learningId, expectedSourceHash: old.sourceHash!, next: learning("raced") }),
    );
    assert.equal(repo.findClaim("default", claim).length, 1);
    assert.deepEqual(repo.list({ workspaceId: "foreign" }), []);
    assert.throws(() => repo.insert(learning("foreign", { workspaceId: "B" })));
    assert.equal(repo.insert(learning("legacy", { claim: undefined })).claim, undefined);
  } finally {
    db.close();
  }
});

it("atomically corrects session evidence and never binds a foreign session claim", () => {
  const db = files.open({ dbPath: files.path("session-claims") });
  try {
    new ChatSessionMetaRepository(db).ensure("session", "2026-11-18T00:00:00.000Z", "default");
    const repo = new LearnedMemoryRepository(db);
    const input = {
      sessionId: "session",
      itemType: "preference" as const,
      content: "Prefer concise replies",
      confidence: 0.8,
      status: "active" as const,
      redacted: false,
      sourceKind: "user",
      sourceRef: "message",
      snippet: "preference",
      claim,
    };
    const first = repo.insertItem(input);
    assert.deepEqual(first.claim, claim);
    assert.throws(
      () =>
        repo.updateItemFields(first.itemId, {
          status: "active",
          content: "Silently changed to detailed replies",
          confidence: 0.8,
        }),
      /exact-source correction/,
    );
    assert.equal(repo.getItem(first.itemId)?.sourceHash, first.sourceHash);
    assert.throws(() =>
      repo.insertItem({
        ...input,
        claim: { ...claim, identity: { ...claim.identity, scope: { kind: "session", id: "foreign" } } },
      }),
    );
    const next = repo.correctItem({
      itemId: first.itemId,
      expectedSourceHash: first.sourceHash!,
      replacement: { ...input, claim: { ...claim, value: "detailed" }, content: "Prefer detailed replies" },
    });
    assert.equal(next.status, "active");
    assert.equal(repo.getItem(first.itemId)?.status, "superseded");
    assert.throws(() =>
      repo.correctItem({ itemId: first.itemId, expectedSourceHash: first.sourceHash!, replacement: input }),
    );
    assert.equal(repo.findActiveByType("session", "preference").filter((item) => item.status === "active").length, 1);
  } finally {
    db.close();
  }
});
