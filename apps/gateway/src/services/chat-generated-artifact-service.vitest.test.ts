import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatGeneratedArtifactRecord, ChatSessionRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
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
): ChatSessionRecord {
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
      mode,
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
    storage,
    requireChatSession: vi.fn(() => session),
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

    const artifact = createChatGeneratedArtifactFromTurn(createHost(storage, session), {
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
    const session = seedSession(storage, "sess-list", "workspace-a", "cowork");
    seedAssistantTurn(storage, session.sessionId, "turn-list", "```mermaid\ngraph TD\n  A --> B\n```", "cowork");
    const host = createHost(storage, session);

    const artifact = createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-list",
    });
    const sessionItems = listChatGeneratedArtifacts(host, { sessionId: " sess-list ", limit: 10 });
    const visibleItems = listChatGeneratedArtifacts(host, {
      workspaceId: " workspace-a ",
      sourceSurface: "cowork",
      kind: "mermaid",
      limit: 10,
    });
    const hydrated = getChatGeneratedArtifact(host, artifact.artifactId, { workspaceId: "workspace-a" });
    const turns = attachGeneratedArtifactsToThreadTurns(
      [{ turnId: "turn-list" }, { turnId: "turn-empty" }] as ChatThreadTurnRecord[],
      new Map([["turn-list", [artifact]]]),
    );

    expect(sessionItems.map((item) => item.artifactId)).toEqual([artifact.artifactId]);
    expect(visibleItems.map((item) => item.artifactId)).toEqual([artifact.artifactId]);
    expect(hydrated.artifactId).toBe(artifact.artifactId);
    expect(host.requireChatSession).toHaveBeenCalledWith("sess-list");
    expect(turns[0]?.generatedArtifacts).toEqual([buildGeneratedArtifactReference(artifact)]);
    expect(turns[1]?.generatedArtifacts).toEqual([]);
  });

  it("reuses existing turn artifacts and preserves supersede lineage idempotently", async () => {
    const { storage, rootDir } = await createStorage();
    roots.push(rootDir);
    storages.push(storage);
    const session = seedSession(storage, "sess-supersede");
    seedAssistantTurn(storage, session.sessionId, "turn-supersede", "```ts\nexport const answer = 42;\n```");
    const host = createHost(storage, session);

    const initial = createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-supersede",
    });
    const repeated = createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-supersede",
    });
    const superseded = createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-supersede",
      supersedeLatest: true,
    });
    const repeatedSupersede = createChatGeneratedArtifactFromTurn(host, {
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
    const artifact = createChatGeneratedArtifactFromTurn(host, {
      sessionId: session.sessionId,
      turnId: "turn-errors",
    });

    expect(() => getChatGeneratedArtifact(host, "   ", { workspaceId: "workspace-a" })).toThrow(/artifactId/i);
    expect(() => getChatGeneratedArtifact(host, artifact.artifactId, { workspaceId: "   " })).toThrow(/workspaceId/i);
    expect(() => getChatGeneratedArtifact(host, artifact.artifactId, { workspaceId: "workspace-b" })).toThrow(
      /requested workspace/i,
    );
    expect(() => createChatGeneratedArtifactFromTurn(host, { sessionId: " ", turnId: "turn-errors" })).toThrow(
      /sessionId/i,
    );
    expect(() => createChatGeneratedArtifactFromTurn(host, { sessionId: session.sessionId, turnId: " " })).toThrow(
      /turnId/i,
    );

    storage.chatTurnTraces.create({
      ...storage.chatTurnTraces.get("turn-errors"),
      turnId: "turn-wrong-session",
      sessionId: "other-session",
    });
    expect(() =>
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-wrong-session",
      }),
    ).toThrow(/does not belong to session/);

    storage.chatTurnTraces.create({
      ...storage.chatTurnTraces.get("turn-errors"),
      turnId: "turn-no-assistant",
      assistantMessageId: undefined,
    });
    expect(() =>
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-no-assistant",
      }),
    ).toThrow(/assistant turns/);

    storage.chatTurnTraces.create({
      ...storage.chatTurnTraces.get("turn-errors"),
      turnId: "turn-blank-assistant-id",
      assistantMessageId: "   ",
    });
    expect(() =>
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-blank-assistant-id",
      }),
    ).toThrow(/Assistant output is missing/);

    storage.chatMessages.upsert({
      messageId: "assistant-empty",
      sessionId: session.sessionId,
      role: "assistant",
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
    expect(() =>
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-empty-output",
      }),
    ).toThrow(/empty/);
  }, 15_000);

  it("returns a matching artifact after create collisions and rethrows mismatched collisions", () => {
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
      requireChatSession: vi.fn(() => session),
      storage: {
        chatTurnTraces: { get: vi.fn(() => trace) },
        gatewaySql: {
          prepare: vi.fn(() => ({
            get: vi.fn(() => ({ content: "```ts\nexport const answer = 42;\n```" })),
          })),
        },
        chatGeneratedArtifacts: {
          listByTurn: vi.fn(() => []),
          create: vi.fn((input: ChatGeneratedArtifactRecord) => {
            collidedArtifact = { ...input };
            throw createError;
          }),
          get: vi.fn(() => collidedArtifact),
        },
      },
    } as unknown as ChatGeneratedArtifactDependencies;

    expect(
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-collision",
      }),
    ).toEqual(expect.objectContaining({ artifactId: collidedArtifact?.artifactId }));

    vi.mocked(host.storage.chatGeneratedArtifacts.get).mockReturnValue({
      ...collidedArtifact!,
      kind: "html",
      contentHash: "wrong",
    });
    expect(() =>
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-collision",
      }),
    ).toThrow(createError);

    vi.mocked(host.storage.chatGeneratedArtifacts.get).mockImplementation(() => {
      throw new Error("not found after collision");
    });
    expect(() =>
      createChatGeneratedArtifactFromTurn(host, {
        sessionId: session.sessionId,
        turnId: "turn-collision",
      }),
    ).toThrow(createError);
  });
});

function seedMockSession(): ChatSessionRecord {
  return {
    sessionId: "sess-collision",
    sessionKey: "mission:operator:sess-collision",
    workspaceId: "default",
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
