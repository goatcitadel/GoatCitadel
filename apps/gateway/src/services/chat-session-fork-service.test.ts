import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import {
  createChatSession,
  forkChatSessionFromTurn,
  listChatSessions,
  type ChatSessionDependencies,
} from "./chat-session-service.js";

describe("forkChatSessionFromTurn", () => {
  const tempDirs: string[] = [];
  afterEach(async () => Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

  it("materializes the selected path and attachment bytes without replaying execution records", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-chat-fork-"));
    tempDirs.push(root);
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    const deps = {} as ChatSessionDependencies;
    const requireSession = (sessionId: string): ChatSessionRecord => {
      const record = listChatSessions(deps, {
        workspaceId: "workspace-1",
        view: "all",
        includeHidden: true,
        limit: 100,
      }).find((session) => session.sessionId === sessionId);
      if (!record) throw new Error(`missing session ${sessionId}`);
      return record;
    };
    Object.assign(deps, {
      storage,
      operatorSummaryCache: { invalidate() {} },
      normalizeWorkspaceId: (value) => value?.trim() || "workspace-1",
      ensureChatSessionRuntimeGrants() {},
      requireChatSession: requireSession,
      getSession: (sessionId) => storage.sessions.getBySessionId(sessionId),
      publishRealtime() {},
      clearChatTurnWriteLease() {},
      removeChatSessionStoredFile: async () => undefined,
      copyChatSessionStoredFile: async (storageRelPath, copyId) => {
        const destinationRelPath = `forks/${copyId}-${path.basename(storageRelPath)}`;
        await fs.mkdir(path.join(root, "forks"), { recursive: true });
        await fs.copyFile(path.join(root, storageRelPath), path.join(root, destinationRelPath));
        return destinationRelPath.replaceAll("\\", "/");
      },
      ensureChatSessionModelDefaults: (_sessionId, prefs) => prefs,
      hydrateChatPrefsWithAutonomy: (_sessionId, prefs) => prefs,
      patchSessionAutonomyPrefs() {},
    });
    const source = createChatSession(deps, { workspaceId: "workspace-1", title: "Source" });
    await fs.writeFile(path.join(root, "attachment.txt"), "frozen bytes", "utf8");
    storage.chatAttachments.create({
      attachmentId: "attachment-1",
      sessionId: source.sessionId,
      workspaceId: "workspace-1",
      fileName: "attachment.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      sha256: "b".repeat(64),
      storageRelPath: "attachment.txt",
      extractStatus: "ready",
    });
    storage.chatMessages.upsert({
      messageId: "user-1",
      sessionId: source.sessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "Use this file",
      timestamp: "2026-07-27T20:00:00.000Z",
      attachments: [
        { attachmentId: "attachment-1", fileName: "attachment.txt", mimeType: "text/plain", sizeBytes: 12 },
      ],
    });
    storage.chatMessages.upsert({
      messageId: "assistant-1",
      sessionId: source.sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "goatcitadel",
      content: "Done",
      timestamp: "2026-07-27T20:00:01.000Z",
    });
    storage.chatTurnTraces.create({
      turnId: "turn-1",
      sessionId: source.sessionId,
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      status: "completed",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "off",
      durable: { runId: "durable-source", status: "completed" },
      startedAt: "2026-07-27T20:00:00.000Z",
      finishedAt: "2026-07-27T20:00:01.000Z",
    });

    const result = await forkChatSessionFromTurn(
      deps,
      source.sessionId,
      "turn-1",
      { expectedRevision: requireSession(source.sessionId).revision },
      "operator",
    );
    const copiedTrace = storage.chatTurnTraces.listBySession(result.session.sessionId)[0]!;
    const copiedAttachment = storage.chatAttachments.listBySession(result.session.sessionId)[0]!;
    expect(copiedTrace.durable).toBeUndefined();
    expect(copiedTrace.routing.forkImport).toMatchObject({ durableRunId: "durable-source", sourceTurnId: "turn-1" });
    expect(await fs.readFile(path.join(root, copiedAttachment.storageRelPath), "utf8")).toBe("frozen bytes");
    expect(result.manifest.messageMappings).toHaveLength(2);
    expect(result.manifest.attachmentCopies).toHaveLength(1);
    storage.deleteChatSessionDataWithRevision(
      source.sessionId,
      storage.chatSessionMeta.get(source.sessionId)!.revision,
    );
    expect(storage.chatMessages.list(result.session.sessionId)).toHaveLength(2);
    storage.close();
  });

  it("rejects a fork when the selected path contains active work", async () => {
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(os.tmpdir(), "gc-chat-fork-active-transcripts"),
      auditDir: path.join(os.tmpdir(), "gc-chat-fork-active-audit"),
    });
    const deps = {} as ChatSessionDependencies;
    Object.assign(deps, {
      storage,
      operatorSummaryCache: { invalidate() {} },
      normalizeWorkspaceId: (value) => value?.trim() || "workspace-1",
      ensureChatSessionRuntimeGrants() {},
      requireChatSession: (sessionId) =>
        listChatSessions(deps, { workspaceId: "workspace-1", view: "all", includeHidden: true }).find(
          (item) => item.sessionId === sessionId,
        )!,
      getSession: (sessionId) => storage.sessions.getBySessionId(sessionId),
      publishRealtime() {},
      clearChatTurnWriteLease() {},
      removeChatSessionStoredFile: async () => undefined,
      copyChatSessionStoredFile: async (value) => value,
      ensureChatSessionModelDefaults: (_sessionId, prefs) => prefs,
      hydrateChatPrefsWithAutonomy: (_sessionId, prefs) => prefs,
      patchSessionAutonomyPrefs() {},
    });
    const source = createChatSession(deps, { workspaceId: "workspace-1" });
    storage.chatMessages.upsert({
      messageId: "user-active",
      sessionId: source.sessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "wait",
      timestamp: new Date().toISOString(),
    });
    storage.chatTurnTraces.create({
      turnId: "turn-active",
      sessionId: source.sessionId,
      userMessageId: "user-active",
      status: "running",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "off",
    });
    await expect(forkChatSessionFromTurn(deps, source.sessionId, "turn-active", {}, "operator")).rejects.toThrow(
      /unsettled work/i,
    );
    storage.close();
  });
});
