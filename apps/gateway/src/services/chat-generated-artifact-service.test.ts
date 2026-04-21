import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { createChatGeneratedArtifactFromTurn, getChatGeneratedArtifact } from "./chat-generated-artifact-service.js";

async function createStorage(): Promise<{ storage: Storage; rootDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-generated-artifacts-"));
  return {
    rootDir,
    storage: new Storage({
      dbPath: path.join(rootDir, "runtime.sqlite"),
      transcriptsDir: path.join(rootDir, "transcripts"),
      auditDir: path.join(rootDir, "audit"),
    }),
  };
}

function seedSession(storage: Storage, sessionId: string, workspaceId = "default"): ChatSessionRecord {
  const now = "2026-04-20T00:00:00.000Z";
  storage.sessions.upsert({
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    kind: "dm",
    channel: "mission",
    account: "operator",
    timestamp: now,
  });
  storage.chatSessionMeta.patch(
    sessionId,
    {
      workspaceId,
      includeInHistory: true,
      pinned: false,
      lifecycleStatus: "active",
    },
    now,
  );
  storage.chatSessionPrefs.patch(
    sessionId,
    {
      mode: "code",
    },
    now,
  );
  return {
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    workspaceId,
    scope: "mission",
    includeInHistory: true,
    pinned: false,
    lifecycleStatus: "active",
    channel: "mission",
    account: "operator",
    updatedAt: now,
    lastActivityAt: now,
    tokenTotal: 0,
    costUsdTotal: 0,
  };
}

function seedAssistantTurn(storage: Storage, sessionId: string, turnId: string, assistantContent: string): void {
  const userMessageId = `user-${turnId}`;
  const assistantMessageId = `assistant-${turnId}`;
  storage.chatMessages.upsert({
    messageId: userMessageId,
    sessionId,
    role: "user",
    actorType: "user",
    actorId: "operator",
    content: "please generate an artifact",
    timestamp: "2026-04-20T00:00:01.000Z",
  });
  storage.chatMessages.upsert({
    messageId: assistantMessageId,
    sessionId,
    role: "assistant",
    actorType: "agent",
    actorId: "assistant",
    content: assistantContent,
    timestamp: "2026-04-20T00:00:02.000Z",
  });
  storage.chatTurnTraces.create({
    turnId,
    sessionId,
    userMessageId,
    assistantMessageId,
    status: "completed",
    mode: "code",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    routing: {
      liveDataIntent: false,
      primaryProviderId: "openai",
      primaryModel: "gpt-4.1",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-4.1",
      fallbackUsed: false,
    },
    startedAt: "2026-04-20T00:00:01.000Z",
    finishedAt: "2026-04-20T00:00:02.000Z",
  });
}

describe("chat-generated-artifact-service", () => {
  const roots: string[] = [];
  const storages: Storage[] = [];

  afterEach(async () => {
    for (const storage of storages.splice(0)) {
      storage.close();
    }
    await Promise.all(
      roots.splice(0).map(async (rootDir) => {
        await fs.rm(rootDir, { recursive: true, force: true });
      }),
    );
  });

  it("returns the existing artifact for repeated non-superseding creates on the same turn", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-1");
    seedAssistantTurn(storage, session.sessionId, "turn-1", "```ts\nexport const answer = 42;\n```");

    const host = {
      storage,
      requireChatSession: () => session,
    };

    const first = createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-1",
    });
    const second = createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-1",
    });

    assert.equal(second.artifactId, first.artifactId);
    assert.equal(storage.chatGeneratedArtifacts.listByTurn("turn-1", 10).length, 1);
  });

  it("persists artifact provenance metadata and supersede lineage", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-2");
    seedAssistantTurn(
      storage,
      session.sessionId,
      "turn-2",
      ["Intro", "```ts\nexport const answer = 42;\n```", "```js\nconsole.log(answer);\n```"].join("\n\n"),
    );

    const host = {
      storage,
      requireChatSession: () => session,
    };

    const initial = createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-2",
    });
    const superseded = createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-2",
      supersedeLatest: true,
    });

    const hydrated = getChatGeneratedArtifact(host, superseded.artifactId);

    assert.equal(initial.sourceBlockIndex, 0);
    assert.match(initial.contentHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(superseded.version, 2);
    assert.equal(superseded.supersedesArtifactId, initial.artifactId);
    assert.equal(hydrated.contentHash, initial.contentHash);
  });
});
