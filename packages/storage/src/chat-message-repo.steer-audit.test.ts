import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChatMessageRecord } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { ChatMessageRepository } from "./chat-message-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): ChatMessageRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-messages-steer-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new ChatMessageRepository(db);
}

function baseMessage(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    messageId: overrides.messageId ?? `m-${randomUUID()}`,
    sessionId: overrides.sessionId ?? "sess-steer",
    role: overrides.role ?? "user",
    actorType: overrides.actorType ?? "user",
    actorId: overrides.actorId ?? "operator",
    sourceAuthority: overrides.sourceAuthority ?? "operator",
    content: overrides.content ?? "hello",
    timestamp: overrides.timestamp ?? "2026-03-05T01:00:00.000Z",
    ...overrides,
  };
}

describe("ChatMessageRepository steer audit columns", () => {
  it("defaults steered and parentDelegationStepId to undefined on a fresh record", () => {
    const repo = createRepo();
    const message = baseMessage({ messageId: "m-default", content: "plain" });
    repo.upsert(message);

    const loaded = repo.get("m-default");
    assert.ok(loaded);
    assert.equal(loaded?.steered, undefined);
    assert.equal(loaded?.parentDelegationStepId, undefined);
  });

  it("round-trips steered=true and parentDelegationStepId", () => {
    const repo = createRepo();
    repo.upsert(
      baseMessage({
        messageId: "m-steered",
        content: "[Steer] reframe the answer",
        steered: true,
        parentDelegationStepId: "step-1",
      }),
    );

    const loaded = repo.get("m-steered");
    assert.equal(loaded?.steered, true);
    assert.equal(loaded?.parentDelegationStepId, "step-1");
  });

  it("round-trips steered=false distinctly from undefined", () => {
    const repo = createRepo();
    repo.upsert(
      baseMessage({
        messageId: "m-not-steered",
        content: "regular user message",
        steered: false,
      }),
    );

    const loaded = repo.get("m-not-steered");
    assert.equal(loaded?.steered, false);
    assert.equal(loaded?.parentDelegationStepId, undefined);
  });
});
