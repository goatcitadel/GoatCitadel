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

  it("posts an independent fork request to the selected turn endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ session: { sessionId: "forked" }, manifest: { forkId: "fork-1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { forkChatSessionFromTurn } = await import("./chat");

    await forkChatSessionFromTurn("source/session", "turn 1", { expectedRevision: 4, title: "Fork" });

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/chat/sessions/source%2Fsession/turns/turn%201/fork");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ expectedRevision: 4, title: "Fork" }),
    });
  });

  it("uses focused session timer endpoints without sending a chat turn", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ item: { timerId: "timer-1" }, items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { cancelChatTimer, createChatTimer, fetchChatTimers } = await import("./chat");

    await fetchChatTimers("session/1");
    await createChatTimer("session/1", {
      dueAt: "2026-07-29T00:00:00.000Z",
      timezone: "UTC",
      message: "Review proof",
    });
    await cancelChatTimer("session/1", "timer 1", 2);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining("/api/v1/chat/sessions/session%2F1/timers"),
      expect.stringContaining("/api/v1/chat/sessions/session%2F1/timers"),
      expect.stringContaining("/api/v1/chat/sessions/session%2F1/timers/timer%201"),
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: 2 }),
    });
  });

  it(
    "normalizes legacy Cowork origin surface to Chat",
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
      expect(headers["x-goatcitadel-origin-surface"]).toBe("chat");
      expect(headers["x-goatcitadel-browser-intent"]).toBe("mutation");
    },
    CHAT_API_TEST_TIMEOUT_MS,
  );

  it(
    "encodes exact anchored and snapshot-fenced history queries",
    async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
      vi.stubGlobal("fetch", fetchMock);
      const { fetchChatHistoryContinuation, fetchChatHistoryWindow, fetchChatMessagePage } = await import("./chat");

      await fetchChatHistoryWindow({
        workspaceId: "workspace / 1",
        sessionId: "session / 1",
        messageId: "message / 1",
        sequence: 42,
        limit: 17,
        maxBytes: 32_000,
      });
      await fetchChatHistoryContinuation({
        workspaceId: "workspace / 1",
        sessionId: "session / 1",
        direction: "newer",
        cursor: { messageId: "message / 2", sequence: 43, snapshotMaxSequence: 99 },
        limit: 11,
        maxBytes: 24_000,
      });
      await fetchChatMessagePage({
        workspaceId: "workspace / 1",
        sessionId: "session / 1",
        offset: 20,
        limit: 10,
        snapshotMaxSequence: 99,
        snapshotMessageCount: 45,
      });

      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls[0]).toContain(
        "/api/v1/chat/sessions/session%20%2F%201/history?workspaceId=workspace+%2F+1&messageId=message+%2F+1&sequence=42&limit=17&maxBytes=32000",
      );
      expect(urls[1]).toContain(
        "/api/v1/chat/sessions/session%20%2F%201/history?workspaceId=workspace+%2F+1&direction=newer&cursor=message+%2F+2&cursorSequence=43&snapshotMaxSequence=99&limit=11&maxBytes=24000",
      );
      expect(urls[2]).toContain(
        "/api/v1/chat/sessions/session%20%2F%201/history?workspaceId=workspace+%2F+1&limit=10&offset=20&snapshotMaxSequence=99&snapshotMessageCount=45",
      );
    },
    CHAT_API_TEST_TIMEOUT_MS,
  );

  it(
    "clamps both history queries to the gateway byte-budget bounds",
    async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
      vi.stubGlobal("fetch", fetchMock);
      const { fetchChatHistoryContinuation, fetchChatHistoryWindow } = await import("./chat");
      const baseWindow = {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        messageId: "message-1",
        sequence: 1,
      };
      const baseContinuation = {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        direction: "newer" as const,
        cursor: { messageId: "message-1", sequence: 1, snapshotMaxSequence: 2 },
      };

      await fetchChatHistoryWindow({ ...baseWindow, maxBytes: 512 });
      await fetchChatHistoryWindow({ ...baseWindow, maxBytes: 2_000_000 });
      await fetchChatHistoryContinuation({ ...baseContinuation, maxBytes: 512 });
      await fetchChatHistoryContinuation({ ...baseContinuation, maxBytes: 2_000_000 });

      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls[0]).toContain("maxBytes=1024");
      expect(urls[1]).toContain("maxBytes=1048576");
      expect(urls[2]).toContain("maxBytes=1024");
      expect(urls[3]).toContain("maxBytes=1048576");
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

      await chat.fetchChatProjects("all", 25, " workspace-1 ", "company");
      await chat.createChatProject({ citadelId: "company", name: "Project", workspacePath: "F:/repo" });
      await chat.importChatProject({ citadelId: "company", sourceType: "local_folder", sourcePath: "F:/repo" });
      await chat.updateChatProject("project 1", { expectedRevision: 5, citadelId: "company", name: "Renamed" });
      await chat.archiveChatProject("project 1", 6);
      await chat.restoreChatProject("project 1", 7);
      await chat.hardDeleteChatProject("project 1", 8);
      await chat.fetchChatSessions({
        scope: "all",
        citadelId: "company",
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
      await chat.createChatSession({ citadelId: "company", title: "Chat", mode: "chat" }, { originSurface: "chat" });
      await chat.archiveWorkspaceChatSessions({ workspaceId: "workspace-1", scope: "mission", includeHidden: true });
      await chat.updateChatSession(sessionId, {
        expectedRevision: 9,
        title: "Updated",
        folderName: "Ops",
        tags: ["release"],
      });
      await chat.deleteChatSession(sessionId, 10);
      await chat.pinChatSession(sessionId, 11);
      await chat.unpinChatSession(sessionId, 12);
      await chat.archiveChatSession(sessionId, 13);
      await chat.restoreChatSession(sessionId, 14);
      await chat.assignChatSessionProject(sessionId, "project-2", 15);
      await chat.assignChatSessionProject(sessionId, undefined, 16);
      await chat.setChatSessionBinding(sessionId, {
        transport: "integration",
        connectionId: "connection-1",
        target: "channel-1",
        writable: true,
      });
      await chat.fetchChatSessionBinding(sessionId);
      await chat.fetchChatSessionStatus(sessionId);
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
        citadelId: "company",
        sessionId,
        workspaceId: "workspace-1",
        projectId: "project-1",
        sourceSurface: "chat",
        kind: "document",
        limit: 3,
      });
      await chat.fetchChatGeneratedArtifact("artifact 1", "workspace 1", "company");
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
      await chat.updateChatSessionPrefs(sessionId, { expectedRevision: 17, model: "gpt-5.5" });
      await chat.fetchChatProactiveStatus(sessionId);
      await chat.updateChatProactivePolicy(sessionId, { expectedRevision: 18, proactiveMode: "suggest" });
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
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("citadelId=company"))).toBe(true);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("projectId=project-1"))).toBe(true);
      expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes('"citadelId":"company"'))).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/v1/chat/projects/project%201") &&
            init?.method === "PATCH" &&
            String(init.body).includes('"expectedRevision":5'),
        ),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/v1/chat/sessions/session%201") &&
            init?.method === "PATCH" &&
            String(init.body).includes('"expectedRevision":9'),
        ),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/v1/chat/sessions/session%201?mode=hard&expectedRevision=10") &&
            init?.method === "DELETE",
        ),
      ).toBe(true);
      expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes('"expectedRevision":18'))).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/v1/chat/projects/project%201/archive") &&
            init?.method === "POST" &&
            String(init.body).includes('"expectedRevision":6'),
        ),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/v1/chat/projects/project%201/restore") &&
            init?.method === "POST" &&
            String(init.body).includes('"expectedRevision":7'),
        ),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/api/v1/chat/projects/project%201?mode=hard&expectedRevision=8") &&
            init?.method === "DELETE",
        ),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/chat/sessions/session%201/agent-send")),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/v1/chat/sessions/session%201/status")),
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

  it("invalidates shell access when a direct Chat stream receives a Gateway-auth 401", async () => {
    const core = await import("./client-core");
    const chat = await import("./chat");
    core.persistGatewayAuthState({ mode: "token", token: "stale-token" });
    const listener = vi.fn();
    const unsubscribe = core.subscribeGatewayAuthRejection(listener);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized", authMode: "token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      chat.streamRetryChatTurn("session-1", "turn-1", { content: "retry" } as never, () => undefined),
    ).rejects.toThrow("API error 401");

    expect(core.readStoredGatewayAuthState()).toBeUndefined();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: "token", path: expect.stringContaining("/retry/stream"), status: 401 }),
    );
    unsubscribe();
  });
});

describe("chat stream terminal diagnostics", () => {
  beforeEach(() => {
    vi.resetModules();
    installMockWindow();
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-uuid",
    });
    // Diagnostics are off by default outside Vite DEV; force them on so the
    // terminal-event bookkeeping is observable in this test.
    vi.stubEnv("VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED", "true");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it(
    "records a stream.aborted terminal diagnostic when the stream is aborted",
    async () => {
      const chat = await import("./chat");
      const { listClientDiagnostics } = await import("../state/dev-diagnostics-store");

      const abortError =
        typeof DOMException === "function"
          ? new DOMException("The operation was aborted.", "AbortError")
          : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw abortError;
        }),
      );

      const controller = new AbortController();
      await expect(
        chat.streamAgentChatMessage("session-1", { content: "hello" } as never, () => undefined, {
          signal: controller.signal,
        }),
      ).rejects.toBe(abortError);

      const events = listClientDiagnostics({ category: "chat" }).map((event) => event.event);
      expect(events).toContain("stream.start");
      expect(events).toContain("stream.aborted");
      expect(events).not.toContain("stream.complete");
    },
    CHAT_API_TEST_TIMEOUT_MS,
  );

  it(
    "requests a turn capability profile with encoded identity and workspace scope",
    async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ state: "legacy_missing" }));
      vi.stubGlobal("fetch", fetchMock);
      const { fetchChatTurnCapabilityProfile } = await import("./chat");

      await fetchChatTurnCapabilityProfile("session / 1", "turn / 1", "workspace / 1");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toContain(
        "/api/v1/chat/sessions/session%20%2F%201/turns/turn%20%2F%201/capability-profile?workspaceId=workspace+%2F+1",
      );
      expect((fetchMock.mock.calls[0]?.[1]?.method ?? "GET").toUpperCase()).toBe("GET");
    },
    CHAT_API_TEST_TIMEOUT_MS,
  );

  it(
    "records a stream.error terminal diagnostic when the transport fails",
    async () => {
      const chat = await import("./chat");
      const { listClientDiagnostics } = await import("../state/dev-diagnostics-store");

      const transportError = new Error("network down");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw transportError;
        }),
      );

      await expect(
        chat.streamAgentChatMessage("session-1", { content: "hello" } as never, () => undefined),
      ).rejects.toThrow("network down");

      const events = listClientDiagnostics({ category: "chat" }).map((event) => event.event);
      expect(events).toContain("stream.start");
      expect(events).toContain("stream.error");
      expect(events).not.toContain("stream.aborted");
      expect(events).not.toContain("stream.complete");
    },
    CHAT_API_TEST_TIMEOUT_MS,
  );
});
