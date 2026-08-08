import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatGeneratedArtifactRecord, ChatSessionRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachGeneratedArtifactsToThreadTurns,
  buildGeneratedArtifactReference,
  createChatGeneratedArtifactFromTurn,
  getChatGeneratedArtifact,
  listChatGeneratedArtifacts,
  type ChatGeneratedArtifactDependencies,
} from "./chat-generated-artifact-service.js";

const now = "2026-04-20T00:00:00.000Z";

async function createStorage(): Promise<{ storage: Storage; rootDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-generated-artifacts-vitest-"));
  return {
    rootDir,
    storage: new Storage({
      dbPath: path.join(rootDir, "runtime.sqlite"),
      transcriptsDir: path.join(rootDir, "transcripts"),
      auditDir: path.join(rootDir, "audit"),
    }),
  };
}

function seedSession(
  storage: Storage,
  sessionId: string,
  workspaceId = "default",
  mode: "chat" | "cowork" | "code" = "code",
  projectId?: string,
): ChatSessionRecord {
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

function seedAssistantTurn(
  storage: Storage,
  sessionId: string,
  turnId: string,
  assistantContent: string,
  mode: "chat" | "cowork" | "code" = "code",
): void {
  const userMessageId = `user-${turnId}`;
  const assistantMessageId = `assistant-${turnId}`;
  storage.chatMessages.upsert({
    messageId: userMessageId,
    sessionId,
    role: "user",
    sourceAuthority: "operator",
    actorType: "user",
    actorId: "operator",
    content: "please generate an artifact",
    timestamp: "2026-04-20T00:00:01.000Z",
  });
  storage.chatMessages.upsert({
    messageId: assistantMessageId,
    sessionId,
    role: "assistant",
    sourceAuthority: "agent_proposed",
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
    mode,
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

function createHost(storage: Storage, session: ChatSessionRecord): ChatGeneratedArtifactDependencies {
  return {
    storage: createSqliteAsyncStorage(storage),
    requireChatSession: vi.fn(async () => session),
  };
}

describe("chat-generated-artifact-service vitest coverage", () => {
  const roots: string[] = [];
  const storages: Storage[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const storage of storages.splice(0)) {
      storage.close();
    }
    await Promise.all(roots.splice(0).map((rootDir) => fs.rm(rootDir, { recursive: true, force: true })));
  });

  it.each([
    {
      label: "mermaid block",
      content: "```mermaid\ngraph TD\n  A --> B\n```",
      kind: "mermaid",
      title: "Mermaid diagram",
      language: "mermaid",
      sourceBlockIndex: 0,
    },
    {
      label: "html block",
      content: "```html\n<main>Preview</main>\n```",
      kind: "html",
      title: "HTML preview",
      language: "html",
      sourceBlockIndex: 0,
    },
    {
      label: "raw html",
      content: "<section>Preview</section>",
      kind: "html",
      title: "HTML preview",
      language: "html",
      sourceBlockIndex: undefined,
    },
    {
      label: "code block",
      content: "```ts\nexport const answer = 42;\n```",
      kind: "code",
      title: "TS snippet",
      language: "ts",
      sourceBlockIndex: 0,
    },
    {
      label: "markdown draft",
      content: "# Plan\n\n- Inspect\n- Validate",
      kind: "markdown",
      title: "Markdown draft",
      language: "markdown",
      sourceBlockIndex: undefined,
    },
    {
      label: "plain text note",
      content: "Short generated note.",
      kind: "text",
      title: "Generated note",
      language: "text",
      sourceBlockIndex: undefined,
    },
  ])("infers and persists a $label artifact from assistant text", async (input) => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, `sess-${input.kind}-${input.label.replaceAll(" ", "-")}`);
    const turnId = `turn-${input.kind}-${input.label.replaceAll(" ", "-")}`;
    seedAssistantTurn(storage, session.sessionId, turnId, input.content);

    const artifact = await createChatGeneratedArtifactFromTurn(createHost(storage, session), {
      sessionId: session.sessionId,
      turnId,
    });

    expect(artifact).toEqual(
      expect.objectContaining({
        kind: input.kind,
        title: input.title,
        language: input.language,
        sourceBlockIndex: input.sourceBlockIndex,
        sourceSurface: "code",
        providerId: "openai",
        model: "gpt-4.1",
        version: 1,
      }),
    );
    expect(artifact.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("lists visible artifacts, validates session ownership, and attaches thread references", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-list", "workspace-a", "cowork", "project-a");
    seedAssistantTurn(storage, session.sessionId, "turn-list", "```mermaid\ngraph TD\n  A --> B\n```", "cowork");
    const host = createHost(storage, session);

    const artifact = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-list",
    });
    const sessionItems = await listChatGeneratedArtifacts(host, { sessionId: " sess-list ", limit: 10 });
    const visibleItems = await listChatGeneratedArtifacts(host, {
      workspaceId: " workspace-a ",
      projectId: " project-a ",
      sourceSurface: "cowork",
      kind: "mermaid",
      limit: 10,
    });
    const hydrated = await getChatGeneratedArtifact(host, artifact.artifactId, { workspaceId: "workspace-a" });
    const turns = attachGeneratedArtifactsToThreadTurns(
      [{ turnId: "turn-list" }, { turnId: "turn-empty" }] as ChatThreadTurnRecord[],
      new Map([["turn-list", [artifact]]]),
    );

    expect(sessionItems.map((item) => item.artifactId)).toEqual([artifact.artifactId]);
    expect(visibleItems.map((item) => item.artifactId)).toEqual([artifact.artifactId]);
    expect(artifact.projectId).toBe("project-a");
    expect(hydrated.artifactId).toBe(artifact.artifactId);
    expect(host.requireChatSession).toHaveBeenCalledWith("sess-list");
    expect(turns[0]?.generatedArtifacts).toEqual([buildGeneratedArtifactReference(artifact)]);
    expect(turns[1]?.generatedArtifacts).toEqual([]);
  });

  it("projects legacy secrets out of generated-artifact references without mutating storage truth", () => {
    const artifact = {
      artifactId: "artifact-legacy",
      sessionId: "session-legacy",
      turnId: "turn-legacy",
      title: "Deploy with DATABASE_PASSWORD=tiny-db-secret",
      kind: "markdown",
      content: "canonical artifact content",
      sourceSurface: "chat",
      version: 1,
      providerId: "provider-legacy",
      model: "Bearer tiny-model-secret",
      createdAt: now,
      updatedAt: now,
    } satisfies ChatGeneratedArtifactRecord;

    const reference = buildGeneratedArtifactReference(artifact);

    expect(JSON.stringify(reference)).not.toContain("tiny-db-secret");
    expect(JSON.stringify(reference)).not.toContain("tiny-model-secret");
    expect(reference).toMatchObject({
      artifactId: "artifact-legacy",
      providerId: "provider-legacy",
    });
    expect(artifact.title).toContain("tiny-db-secret");
    expect(artifact.model).toContain("tiny-model-secret");
  });

  it("reuses existing turn artifacts and preserves supersede lineage idempotently", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-supersede");
    seedAssistantTurn(storage, session.sessionId, "turn-supersede", "```ts\nexport const answer = 42;\n```");
    const host = createHost(storage, session);

    const initial = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-supersede",
    });
    const repeated = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-supersede",
    });
    const superseded = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-supersede",
      supersedeLatest: true,
    });
    const repeatedSupersede = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-supersede",
      supersedeLatest: true,
    });

    expect(repeated.artifactId).toBe(initial.artifactId);
    expect(superseded.version).toBe(2);
    expect(superseded.supersedesArtifactId).toBe(initial.artifactId);
    expect(repeatedSupersede.artifactId).toBe(superseded.artifactId);
    expect(storage.chatGeneratedArtifacts.listByTurn("turn-supersede", 10)).toHaveLength(2);
  });

  it("rejects invalid reads and assistant-output mismatches", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-errors", "workspace-a");
    seedAssistantTurn(storage, session.sessionId, "turn-errors", "```ts\nexport const answer = 42;\n```");
    const host = createHost(storage, session);
    const artifact = await createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-errors",
    });

    await expect(getChatGeneratedArtifact(host, "   ", { workspaceId: "workspace-a" })).rejects.toThrow(/artifactId/i);
    await expect(getChatGeneratedArtifact(host, artifact.artifactId, { workspaceId: "   " })).rejects.toThrow(
      /workspaceId/i,
    );
    await expect(getChatGeneratedArtifact(host, artifact.artifactId, { workspaceId: "workspace-b" })).rejects.toThrow(
      /requested workspace/i,
    );
    await expect(createChatGeneratedArtifactFromTurn(host, { sessionId: " ", turnId: "turn-errors" })).rejects.toThrow(
      /sessionId/i,
    );
    await expect(
      createChatGeneratedArtifactFromTurn(host, { sessionId: session.sessionId, turnId: " " }),
    ).rejects.toThrow(/turnId/i);

    storage.chatTurnTraces.create({
      ...storage.chatTurnTraces.get("turn-errors"),
      turnId: "turn-wrong-session",
      sessionId: "other-session",
    });
    await expect(
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-wrong-session",
      }),
    ).rejects.toThrow(/does not belong to session/);

    storage.chatTurnTraces.create({
      ...storage.chatTurnTraces.get("turn-errors"),
      turnId: "turn-no-assistant",
      assistantMessageId: undefined,
    });
    await expect(
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-no-assistant",
      }),
    ).rejects.toThrow(/assistant turns/);

    storage.chatTurnTraces.create({
      ...storage.chatTurnTraces.get("turn-errors"),
      turnId: "turn-blank-assistant-id",
      assistantMessageId: "   ",
    });
    await expect(
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-blank-assistant-id",
      }),
    ).rejects.toThrow(/Assistant output is missing/);

    storage.chatMessages.upsert({
      messageId: "assistant-empty",
      sessionId: session.sessionId,
      role: "assistant",
      sourceAuthority: "agent_proposed",
      actorType: "agent",
      actorId: "assistant",
      content: "   ",
      timestamp: "2026-04-20T00:00:03.000Z",
    });
    storage.chatTurnTraces.create({
      ...storage.chatTurnTraces.get("turn-errors"),
      turnId: "turn-empty-output",
      assistantMessageId: "assistant-empty",
    });
    await expect(
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-empty-output",
      }),
    ).rejects.toThrow(/empty/);
  }, 15_000);

  it("returns a matching artifact after create collisions and rethrows mismatched collisions", async () => {
    const session = seedMockSession();
    const trace = {
      turnId: "turn-collision",
      sessionId: session.sessionId,
      userMessageId: "user-turn-collision",
      assistantMessageId: "assistant-turn-collision",
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
    };
    const createError = new Error("insert failed");
    let collidedArtifact: ChatGeneratedArtifactRecord | undefined;
    const host = {
      requireChatSession: vi.fn(async () => session),
      storage: {
        chatTurnTraces: { get: vi.fn(async () => trace) },
        gatewaySql: {
          prepare: vi.fn(() => ({
            get: vi.fn(async () => ({ content: "```ts\nexport const answer = 42;\n```" })),
          })),
        },
        chatGeneratedArtifacts: {
          listByTurn: vi.fn(async () => []),
          create: vi.fn(async (input: ChatGeneratedArtifactRecord) => {
            collidedArtifact = { ...input };
            throw createError;
          }),
          get: vi.fn(async () => collidedArtifact),
        },
      },
    } as unknown as ChatGeneratedArtifactDependencies;

    expect(
      await createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-collision",
      }),
    ).toEqual(expect.objectContaining({ artifactId: collidedArtifact?.artifactId }));

    vi.mocked(host.storage.chatGeneratedArtifacts.get).mockResolvedValue({
      ...collidedArtifact!,
      kind: "html",
      contentHash: "wrong",
    });
    await expect(
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-collision",
      }),
    ).rejects.toThrow(createError);

    vi.mocked(host.storage.chatGeneratedArtifacts.get).mockImplementation(async () => {
      throw new Error("not found after collision");
    });
    await expect(
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-collision",
      }),
    ).rejects.toThrow(createError);
  });
});

function seedMockSession(): ChatSessionRecord {
  return {
    sessionId: "sess-collision",
    sessionKey: "mission:operator:sess-collision",
    workspaceId: "default",
    projectId: "project-collision",
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
