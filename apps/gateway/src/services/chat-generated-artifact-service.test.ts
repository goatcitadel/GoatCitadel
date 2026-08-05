import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { createChatGeneratedArtifactFromTurn, getChatGeneratedArtifact } from "./chat-generated-artifact-service.js";

async function createStorage(): Promise<{ storage: Storage; asyncStorage: AsyncStorage; rootDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-generated-artifacts-"));
  const storage = new Storage({
    dbPath: path.join(rootDir, "runtime.sqlite"),
    transcriptsDir: path.join(rootDir, "transcripts"),
    auditDir: path.join(rootDir, "audit"),
  });
  return {
    rootDir,
    storage,
    asyncStorage: createSqliteAsyncStorage(storage),
  };
}

function seedSession(
  storage: Storage,
  sessionId: string,
  workspaceId = "default",
  mode: "chat" | "cowork" | "code" = "code",
  projectId?: string,
): ChatSessionRecord {
  const now = "2026-04-20T00:00:00.000Z";
  storage.sessions.upsert({
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    kind: "dm",
    channel: "mission",
    account: "operator",
    timestamp: now,
  });
  storage.chatSessionLifecycles.initialize({
    workspaceId,
    sessionId,
    actorId: "test-fixture",
    idempotencyKey: `test:lifecycle:init:${sessionId}`,
    correlationId: `test:correlation:lifecycle:init:${sessionId}`,
    metadataTimestamp: now,
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
      mode,
    },
    now,
  );
  return {
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    workspaceId,
    projectId,
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
    const { storage, asyncStorage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-1");
    seedAssistantTurn(storage, session.sessionId, "turn-1", "```ts\nexport const answer = 42;\n```");

    const host = {
      storage: asyncStorage,
      requireChatSession: async () => session,
    };

    const first = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-1",
    });
    const second = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-1",
    });

    assert.equal(second.artifactId, first.artifactId);
    assert.equal(storage.chatGeneratedArtifacts.listByTurn("turn-1", 10).length, 1);
  });

  it("persists artifact provenance metadata and supersede lineage", async () => {
    const { storage, asyncStorage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-2", "default", "chat", "project-2");
    seedAssistantTurn(
      storage,
      session.sessionId,
      "turn-2",
      ["Intro", "```ts\nexport const answer = 42;\n```", "```js\nconsole.log(answer);\n```"].join("\n\n"),
    );

    const host = {
      storage: asyncStorage,
      requireChatSession: async () => session,
    };

    const initial = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-2",
    });
    const superseded = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-2",
      supersedeLatest: true,
    });

    const hydrated = await getChatGeneratedArtifact(host, superseded.artifactId, {
      workspaceId: session.workspaceId,
    });

    assert.equal(initial.sourceBlockIndex, 0);
    assert.equal(initial.projectId, "project-2");
    assert.match(initial.contentHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(initial.sourceSurface, "code");
    assert.equal(superseded.version, 2);
    assert.equal(superseded.supersedesArtifactId, initial.artifactId);
    assert.equal(hydrated.contentHash, initial.contentHash);
  });

  it("rejects artifact reads when the requested workspace does not own the session", async () => {
    const { storage, asyncStorage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-workspace-check", "workspace-a");
    seedAssistantTurn(storage, session.sessionId, "turn-workspace-check", "```ts\nexport const answer = 42;\n```");

    const host = {
      storage: asyncStorage,
      requireChatSession: async () => session,
    };

    const artifact = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-workspace-check",
    });

    await assert.rejects(
      getChatGeneratedArtifact(host, artifact.artifactId, { workspaceId: "workspace-b" }),
      /Artifact does not belong to the requested workspace/,
    );
  });

  it("returns the same superseded artifact for repeated identical new-version requests", async () => {
    const { storage, asyncStorage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-3");
    seedAssistantTurn(storage, session.sessionId, "turn-3", "```ts\nexport const answer = 42;\n```");

    const host = {
      storage: asyncStorage,
      requireChatSession: async () => session,
    };

    const initial = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-3",
    });
    const firstSupersede = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-3",
      supersedeLatest: true,
    });
    const secondSupersede = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-3",
      supersedeLatest: true,
    });

    assert.equal(firstSupersede.artifactId, secondSupersede.artifactId);
    assert.equal(firstSupersede.supersedesArtifactId, initial.artifactId);
    assert.equal(storage.chatGeneratedArtifacts.listByTurn("turn-3", 10).length, 2);
  });

  it("collapses concurrent supersede requests that observe the same parent artifact", async () => {
    const { storage, asyncStorage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-4");
    seedAssistantTurn(storage, session.sessionId, "turn-4", "```ts\nexport const answer = 42;\n```");

    const host = {
      storage: asyncStorage,
      requireChatSession: async () => session,
    };

    const initial = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-4",
    });
    const originalListByTurn = storage.chatGeneratedArtifacts.listByTurn.bind(storage.chatGeneratedArtifacts);
    storage.chatGeneratedArtifacts.listByTurn = (() => [initial]) as typeof storage.chatGeneratedArtifacts.listByTurn;

    try {
      const [firstSupersede, secondSupersede] = await Promise.all([
        Promise.resolve().then(() =>
          createChatGeneratedArtifactFromTurn(host, {
            sessionId: session.sessionId,
            turnId: "turn-4",
            supersedeLatest: true,
          }),
        ),
        Promise.resolve().then(() =>
          createChatGeneratedArtifactFromTurn(host, {
            sessionId: session.sessionId,
            turnId: "turn-4",
            supersedeLatest: true,
          }),
        ),
      ]);

      assert.equal(firstSupersede.artifactId, secondSupersede.artifactId);
      assert.equal(originalListByTurn("turn-4", 10).length, 2);
    } finally {
      storage.chatGeneratedArtifacts.listByTurn = originalListByTurn;
    }
  });

  it("rethrows when a post-collision artifact does not match the requested create identity", async () => {
    const expectedError = new Error("insert failed");
    const session = {
      sessionId: "sess-mismatch",
      sessionKey: "mission:operator:sess-mismatch",
      workspaceId: "default",
      scope: "mission",
      includeInHistory: true,
      pinned: false,
      lifecycleStatus: "active",
      channel: "mission",
      account: "operator",
      updatedAt: "2026-04-20T00:00:00.000Z",
      lastActivityAt: "2026-04-20T00:00:00.000Z",
      tokenTotal: 0,
      costUsdTotal: 0,
    } satisfies ChatSessionRecord;

    const host = {
      requireChatSession: async () => session,
      storage: {
        chatTurnTraces: {
          get: async () => ({
            turnId: "turn-mismatch",
            sessionId: session.sessionId,
            userMessageId: "user-turn-mismatch",
            assistantMessageId: "assistant-turn-mismatch",
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
          }),
        },
        gatewaySql: {
          prepare: async () => ({
            get: async () => ({
              content: "```ts\nexport const answer = 42;\n```",
            }),
          }),
        },
        chatGeneratedArtifacts: {
          listByTurn: async () => [],
          create: async () => {
            throw expectedError;
          },
          get: async () => ({
            artifactId: "gart-mismatch",
            sessionId: session.sessionId,
            workspaceId: "default",
            turnId: "turn-mismatch",
            title: "Wrong artifact",
            kind: "html",
            content: "<div>wrong</div>",
            sourceSurface: "code",
            version: 1,
            providerId: "openai",
            model: "gpt-4.1",
            sourceBlockIndex: 99,
            contentHash: "wrong",
            createdAt: "2026-04-20T00:00:03.000Z",
            updatedAt: "2026-04-20T00:00:03.000Z",
          }),
        },
      },
    };

    await assert.rejects(
      createChatGeneratedArtifactFromTurn(host as Parameters<typeof createChatGeneratedArtifactFromTurn>[0], {
        sessionId: session.sessionId,
        turnId: "turn-mismatch",
      }),
      expectedError,
    );
  });
});
