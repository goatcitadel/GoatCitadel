import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function installMockWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        protocol: "http:",
        hostname: "localhost",
        pathname: "/cowork",
        search: "",
        hash: "",
      },
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
    },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function sseResponse(...chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const normalized = new Headers(headers);
  return Object.fromEntries(normalized.entries());
}

const CHAT_API_TEST_TIMEOUT_MS = 30_000;

describe("chat API origin surface headers", () => {
  beforeEach(() => {
    vi.resetModules();
    installMockWindow();
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-uuid",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it(
    "defaults chat requests to chat origin surface",
    async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ sessionId: "session-1" }));
      vi.stubGlobal("fetch", fetchMock);
      const { createChatSession } = await import("./chat");

      await createChatSession({ mode: "chat" });

      const headers = toHeaderRecord(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers["x-goatcitadel-origin-surface"]).toBe("chat");
      expect(headers["x-goatcitadel-browser-intent"]).toBe("mutation");
    },
    CHAT_API_TEST_TIMEOUT_MS,
  );

  it(
    "allows Cowork to override chat-route origin surface",
    async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ sessionId: "session-1", turnId: "turn-1" }));
      vi.stubGlobal("fetch", fetchMock);
      const { sendAgentChatMessage } = await import("./chat");

      await sendAgentChatMessage(
        "session-1",
        { content: "Coordinate beta outreach", mode: "cowork" },
        {
          originSurface: "cowork",
        },
      );

      const headers = toHeaderRecord(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers["x-goatcitadel-origin-surface"]).toBe("cowork");
      expect(headers["x-goatcitadel-browser-intent"]).toBe("mutation");
    },
    CHAT_API_TEST_TIMEOUT_MS,
  );

  it(
    "wires chat API helpers to deterministic gateway routes",
    async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/content?disposition=attachment")) {
          return Promise.resolve(
            new Response("attachment-bytes", {
              status: 200,
              headers: {
                "content-type": "text/plain",
              },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            success: true,
            data: {
              ok: true,
              fileName: "note.txt",
              mimeType: "text/plain",
              items: [],
              conflicts: [],
              state: {},
              item: {},
              policy: {},
              idleSeconds: 0,
              hasRunningTurn: false,
              pendingSuggestions: 0,
              actionsLastHour: 0,
              rebuiltAt: "2026-05-12T00:00:00.000Z",
            },
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const chat = await import("./chat");
      const sessionId = "session 1";
      const turnId = "turn 1";
      const genericMessage = { content: "Coordinate the release", mode: "cowork" } as never;

      await chat.fetchChatProjects("all", 25, " workspace-1 ");
      await chat.createChatProject({ name: "Project", workspacePath: "F:/repo" });
      await chat.importChatProject({ sourceType: "local_folder", sourcePath: "F:/repo" });
      await chat.updateChatProject("project 1", { name: "Renamed" });
      await chat.archiveChatProject("project 1");
      await chat.restoreChatProject("project 1");
      await chat.hardDeleteChatProject("project 1");
      await chat.fetchChatSessions({
        scope: "all",
        workspaceId: "workspace-1",
        projectId: "project-1",
        folderId: "folder-1",
        tag: "urgent",
        q: "deploy",
        view: "archived",
        includeHidden: true,
        limit: 17,
        cursor: "cursor-1",
      });
      await chat.createChatSession({ title: "Chat", mode: "chat" }, { originSurface: "chat" });
      await chat.archiveWorkspaceChatSessions({ workspaceId: "workspace-1", scope: "mission", includeHidden: true });
      await chat.updateChatSession(sessionId, { title: "Updated", folderName: "Ops", tags: ["release"] });
      await chat.deleteChatSession(sessionId);
      await chat.pinChatSession(sessionId);
      await chat.unpinChatSession(sessionId);
      await chat.archiveChatSession(sessionId);
      await chat.restoreChatSession(sessionId);
      await chat.assignChatSessionProject(sessionId, "project-2");
      await chat.assignChatSessionProject(sessionId);
      await chat.setChatSessionBinding(sessionId, {
        transport: "integration",
        connectionId: "connection-1",
        target: "channel-1",
        writable: true,
      });
      await chat.fetchChatSessionBinding(sessionId);
      await chat.fetchChatSessionWorkbench(sessionId);
      await chat.createChatSessionWorkbenchWorktree(sessionId, { baseRef: "main" });
      await chat.fetchChatSessionWorkbenchTree(sessionId);
      await chat.fetchChatSessionWorkbenchFile(sessionId, "src/index.ts");
      await chat.saveChatSessionWorkbenchFile(sessionId, {
        relativePath: "src/index.ts",
        content: "export {};",
      } as never);
      await chat.runChatSessionWorkbenchFileOperation(sessionId, {
        operation: "create_file",
        path: "src/new.ts",
      });
      await chat.fetchChatSessionWorkbenchFileDiff(sessionId, "src/index.ts");
      await chat.fetchChatSessionWorkbenchDiff(sessionId);
      await chat.fetchChatSessionWorkbenchOutput(sessionId);
      await chat.runChatSessionWorkbenchCommand(sessionId, { command: "pnpm test" } as never);
      await chat.applyChatSessionWorkbenchPatch(sessionId, { patch: "diff --git" } as never);
      await chat.exportChatSessionWorkbenchPatch(sessionId);
      await chat.revertChatSessionWorkbenchFile(sessionId, { relativePath: "src/index.ts" } as never);
      await chat.revertChatSessionWorkbenchChanges(sessionId);
      await chat.fetchChatMessages(sessionId, 5000, "cursor-2");
      await chat.fetchChatGeneratedArtifacts({
        sessionId,
        workspaceId: "workspace-1",
        sourceSurface: "chat",
        kind: "document",
        limit: 3,
      });
      await chat.fetchChatGeneratedArtifact("artifact 1", "workspace 1");
      await chat.fetchChatSessionGeneratedArtifacts(sessionId, { kind: "document", sourceSurface: "code", limit: 4 });
      await chat.createChatGeneratedArtifact(sessionId, turnId, { supersedeLatest: true });
      await chat.fetchThreadKnowledgeAttachments(sessionId);
      await chat.attachThreadKnowledgeAttachment(sessionId, {
        url: "https://example.test/doc",
        retrievalMode: "semantic",
      });
      await chat.removeThreadKnowledgeAttachment(sessionId, "attachment 1");
      await chat.fetchChatThread(sessionId);
      await chat.answerChatUserInputPrompt(sessionId, turnId, "prompt 1", { answer: "ship it" } as never);
      await chat.fetchChatPendingApprovals(sessionId);
      await chat.sendAgentChatMessage(sessionId, genericMessage, { originSurface: "cowork" });
      await chat.preflightChatRoute(sessionId, { content: "route me", mode: "chat" } as never, {
        originSurface: "chat",
      });
      await chat.selectChatBranchTurn(sessionId, turnId);
      await chat.retryChatTurn(sessionId, turnId, { content: "retry" } as never, { originSurface: "code" });
      await chat.editChatTurn(sessionId, turnId, genericMessage, { originSurface: "chat" });
      await chat.cancelChatTurn(sessionId, turnId, "operator");
      await chat.cancelChatTurn(sessionId, turnId);
      await chat.approveChatTool(sessionId, "approval 1", { allowScope: "session" });
      await chat.approveChatTool(sessionId, "approval 2");
      await chat.denyChatTool(sessionId, "approval 1");
      await chat.fetchChatToolArtifact("artifact 1", "workspace 1");
      await chat.uploadChatAttachment({
        sessionId,
        projectId: "project-1",
        file: new File(["hello"], "note.txt", { type: "text/plain" }),
      });
      await chat.fetchChatAttachment("attachment 1");
      const downloaded = await chat.downloadChatAttachment("attachment 1");
      await chat.fetchChatAttachmentPreview("attachment 1");
      await chat.fetchChatSessionPrefs(sessionId);
      await chat.updateChatSessionPrefs(sessionId, { model: "gpt-5.5" } as never);
      await chat.fetchChatProactiveStatus(sessionId);
      await chat.updateChatProactivePolicy(sessionId, { proactiveMode: "suggest" } as never);
      await chat.triggerChatProactive(sessionId, { source: "manual", reason: "test" });
      await chat.triggerChatProactive(sessionId);
      await chat.fetchChatProactiveRuns(sessionId, 999);
      await chat.fetchChatLearnedMemory(sessionId, 5000);
      await chat.updateChatLearnedMemoryItem(sessionId, "memory 1", { status: "accepted" } as never);
      await chat.rebuildChatLearnedMemory(sessionId);
      await chat.fetchChatSpecialistCandidates(sessionId, 999);
      await chat.createChatSpecialistCandidate(sessionId, {
        turnId,
        suggestion: { role: "Reviewer", reason: "Needs review" },
      } as never);
      await chat.updateChatSpecialistCandidate(sessionId, "candidate 1", { status: "accepted" } as never);
      await chat.suggestChatDelegation(sessionId, { objective: "Review" } as never);
      await chat.acceptChatDelegation(sessionId, { suggestionId: "suggestion-1" } as never);
      await chat.fetchChatCommandCatalog();
      await chat.parseChatCommand(sessionId, "/research local-first AI");
      await chat.runChatResearch(sessionId, { query: "coverage", mode: "quick" });
      await chat.fetchChatResearchRun(sessionId, "run 1");
      await chat.runChatDelegation(sessionId, { task: "Plan", surfaceMode: "cowork" } as never);
      await chat.fetchChatDelegationRun(sessionId, "run 1");

      expect(downloaded.fileName).toBe("note.txt");
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/chat/projects?"))).toBe(true);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("workspaceId=workspace-1"))).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/chat/sessions/session%201/agent-send")),
      ).toBe(true);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
    },
    CHAT_API_TEST_TIMEOUT_MS,
  );

  it(
    "streams chat and delegation events and reports error responses",
    async () => {
      const chat = await import("./chat");
      const chunks: unknown[] = [];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(sseResponse({ type: "delta", sessionId: "session-1", turnId: "turn-1", delta: "hi" }))
        .mockResolvedValueOnce(sseResponse({ type: "delta", sessionId: "session-1", turnId: "turn-1", delta: "retry" }))
        .mockResolvedValueOnce(
          sseResponse({ type: "message_done", sessionId: "session-1", turnId: "turn-1", content: "done" }),
        )
        .mockResolvedValueOnce(
          sseResponse({ type: "delta", sessionId: "session-1", turnId: "turn-1", delta: "resume" }),
        )
        .mockResolvedValueOnce(
          sseResponse({ type: "status", runId: "run-1", message: "started" }, { type: "done", runId: "run-1" }),
        )
        .mockResolvedValueOnce(new Response("failed stream", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);

      await chat.streamAgentChatMessage("session-1", { content: "hello" } as never, (chunk) => chunks.push(chunk), {
        originSurface: "chat",
      });
      await chat.streamRetryChatTurn("session-1", "turn-1", { content: "retry" } as never, (chunk) =>
        chunks.push(chunk),
      );
      await chat.streamEditChatTurn("session-1", "turn-1", { content: "edit" } as never, (chunk) => chunks.push(chunk));
      await chat.resumeChatTurnStream("session-1", "turn-1", (chunk) => chunks.push(chunk), {
        sinceEventId: "event-1",
        originSurface: "cowork",
      });
      await chat.streamChatDelegation("session-1", { task: "delegate", surfaceMode: "cowork" } as never, (chunk) =>
        chunks.push(chunk),
      );

      await expect(
        chat.streamAgentChatMessage("session-1", { content: "fail" } as never, () => undefined),
      ).rejects.toThrow("API error 500");
      expect(chunks.map((chunk) => (chunk as { type: string }).type)).toEqual([
        "delta",
        "delta",
        "message_done",
        "delta",
        "status",
        "done",
      ]);
    },
    CHAT_API_TEST_TIMEOUT_MS,
  );

  it(
    "covers chat stream failures, delegation stream errors, and FileReader attachment encoding",
    async () => {
      const chat = await import("./chat");
      const chunks: unknown[] = [];
      let fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          sseResponse({ type: "error", sessionId: "session-1", turnId: "turn-1", error: "chunk failed" }),
        )
        .mockResolvedValueOnce(new Response("retry failed", { status: 409 }))
        .mockResolvedValueOnce(new Response("edit failed", { status: 422 }))
        .mockResolvedValueOnce(new Response("resume failed", { status: 410 }))
        .mockResolvedValueOnce(new Response("delegation failed", { status: 500 }))
        .mockResolvedValueOnce(
          sseResponse(
            { type: "status", runId: "run-1", message: "started" },
            { type: "error", runId: "run-1", error: "delegate failed" },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        chat.streamAgentChatMessage("session-1", { content: "fail" } as never, (chunk) => chunks.push(chunk)),
      ).rejects.toThrow("chunk failed");
      await expect(
        chat.streamRetryChatTurn("session-1", "turn-1", { content: "retry" } as never, () => undefined),
      ).rejects.toThrow("API error 409");
      await expect(
        chat.streamEditChatTurn("session-1", "turn-1", { content: "edit" } as never, () => undefined),
      ).rejects.toThrow("API error 422");
      await expect(chat.resumeChatTurnStream("session-1", "turn-1", () => undefined)).rejects.toThrow("API error 410");
      await expect(
        chat.streamChatDelegation("session-1", { task: "delegate", surfaceMode: "cowork" } as never, () => undefined),
      ).rejects.toThrow("API error 500");
      await expect(
        chat.streamChatDelegation("session-1", { task: "delegate", surfaceMode: "cowork" } as never, (chunk) =>
          chunks.push(chunk),
        ),
      ).rejects.toThrow("delegate failed");
      expect(chunks.map((chunk) => (chunk as { type: string }).type)).toEqual(["error", "status", "error"]);

      fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, data: { fileName: "note.txt", mimeType: "text/plain" } }))
        .mockResolvedValueOnce(new Response("missing", { status: 404 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(chat.downloadChatAttachment("attachment-1")).rejects.toThrow("API error 404");

      class SuccessfulFileReader {
        public error: Error | null = null;
        public result: string | ArrayBuffer | null = "data:text/plain;base64,Zm9v";
        public onerror: (() => void) | null = null;
        public onload: (() => void) | null = null;
        public readAsDataURL(): void {
          this.onload?.();
        }
      }
      fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { attachmentId: "attachment-2" } }));
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("FileReader", SuccessfulFileReader);
      await chat.uploadChatAttachment({ sessionId: "session-1", file: new File(["foo"], "note.txt", { type: "" }) });
      expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({
        bytesBase64: "Zm9v",
        mimeType: "application/octet-stream",
      });

      class FailingFileReader extends SuccessfulFileReader {
        public override error = new Error("reader failed");
        public override readAsDataURL(): void {
          this.onerror?.();
        }
      }
      vi.stubGlobal("FileReader", FailingFileReader);
      await expect(
        chat.uploadChatAttachment({
          sessionId: "session-1",
          file: new File(["foo"], "note.txt", { type: "text/plain" }),
        }),
      ).rejects.toThrow("reader failed");

      class NonStringFileReader extends SuccessfulFileReader {
        public override result = new ArrayBuffer(0);
      }
      vi.stubGlobal("FileReader", NonStringFileReader);
      await expect(
        chat.uploadChatAttachment({
          sessionId: "session-1",
          file: new File(["foo"], "note.txt", { type: "text/plain" }),
        }),
      ).rejects.toThrow("Failed to encode attachment.");
    },
    CHAT_API_TEST_TIMEOUT_MS,
  );
});
