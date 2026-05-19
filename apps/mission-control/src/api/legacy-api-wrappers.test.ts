import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  buildGatewayHeaders: vi.fn((_path: string, _method: string, _correlationId: string, headers?: HeadersInit) => ({
    "content-type": "application/json",
    ...(headers as Record<string, string> | undefined),
  })),
  buildGatewayUrl: vi.fn((path: string) => `http://gateway.local${path}`),
  createCorrelationId: vi.fn(() => "corr-1"),
  readGatewayAuthHeaders: vi.fn(() => ({ Authorization: "Bearer test-token" })),
  request: vi.fn(),
}));

vi.mock("./client-core.js", () => ({
  buildGatewayHeaders: apiMocks.buildGatewayHeaders,
  buildGatewayUrl: apiMocks.buildGatewayUrl,
  readGatewayAuthHeaders: apiMocks.readGatewayAuthHeaders,
  request: apiMocks.request,
}));

vi.mock("../state/dev-diagnostics-store", () => ({
  createCorrelationId: apiMocks.createCorrelationId,
  recordClientDiagnostic: vi.fn(),
}));

vi.mock("./streaming.js", () => ({
  consumeSseResponse: vi.fn(async (_body: ReadableStream<Uint8Array> | null, onChunk: (chunk: unknown) => void) => {
    onChunk({ type: "token", text: "ok" });
    onChunk({ type: "error", turnId: "turn-1", error: "stream warning" });
  }),
  iterateSsePayloads: vi.fn(async function* () {
    yield JSON.stringify({ type: "progress", message: "routing" });
    yield JSON.stringify({ type: "error", error: "delegation failed" });
  }),
  parseSseJson: vi.fn((value: string) => JSON.parse(value) as unknown),
}));

function lastRequest(): [string, RequestInit | undefined] {
  const call = apiMocks.request.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected request to be called.");
  }
  return call as [string, RequestInit | undefined];
}

function jsonBody(init: RequestInit | undefined): unknown {
  return JSON.parse(String(init?.body ?? "{}"));
}

describe("legacy Mission Control API wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.request.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds task list filters and mutation payloads without leaking untrimmed workspace ids", async () => {
    const tasks = await import("./tasks");

    await tasks.fetchTasks("blocked" as never, " workspace-1 ");
    expect(lastRequest()[0]).toBe("/api/v1/tasks?limit=100&view=active&status=blocked&workspaceId=workspace-1");

    await tasks.fetchTasksByView("trash", "done" as never, "workspace-2");
    expect(lastRequest()[0]).toBe("/api/v1/tasks?limit=100&view=trash&status=done&workspaceId=workspace-2");

    await tasks.deleteTask("task/id", {
      mode: "hard",
      deletedBy: "operator",
      deleteReason: "duplicate",
      confirmToken: "delete-task",
    });
    const [deletePath, deleteInit] = lastRequest();
    expect(deletePath).toBe("/api/v1/tasks/task%2Fid?mode=hard");
    expect(deleteInit?.method).toBe("DELETE");
    expect(jsonBody(deleteInit)).toEqual({
      mode: "hard",
      deletedBy: "operator",
      deleteReason: "duplicate",
      confirmToken: "delete-task",
    });

    await tasks.addTaskActivity("task/id", { message: "note" });
    expect(lastRequest()[0]).toBe("/api/v1/tasks/task%2Fid/activities");
    expect(jsonBody(lastRequest()[1])).toEqual({ activityType: "comment", message: "note" });

    await tasks.addTaskDeliverable("task/id", { title: "Patch" });
    expect(lastRequest()[0]).toBe("/api/v1/tasks/task%2Fid/deliverables");
    expect(jsonBody(lastRequest()[1])).toEqual({ deliverableType: "artifact", title: "Patch" });
  });

  it("clamps API query limits while preserving optional workspace filters", async () => {
    const improvement = await import("./improvement");
    const promptPacks = await import("./prompt-packs");
    const memory = await import("./memory");
    const capabilities = await import("./capabilities");

    await improvement.fetchImprovementSignals(999, "workspace-1");
    expect(lastRequest()[0]).toBe("/api/v1/improvement/signals?limit=500&workspaceId=workspace-1");

    await improvement.fetchImprovementCandidates(0, "workspace-2");
    expect(lastRequest()[0]).toBe("/api/v1/improvement/candidates?limit=1&workspaceId=workspace-2");

    await promptPacks.fetchPromptPacks(10_000);
    expect(lastRequest()[0]).toBe("/api/v1/prompt-packs?limit=2000");

    await promptPacks.runPromptPackBenchmark("pack/id", {
      testCodes: ["chat-basic"],
      providers: [{ providerId: "openai", model: "gpt-5-mini" }],
      executionStyle: "agentic_surface",
    });
    const [benchmarkPath, benchmarkInit] = lastRequest();
    expect(benchmarkPath).toBe("/api/v1/prompt-packs/pack%2Fid/benchmark/run");
    expect(benchmarkInit?.method).toBe("POST");
    expect(jsonBody(benchmarkInit)).toEqual({
      testCodes: ["chat-basic"],
      providers: [{ providerId: "openai", model: "gpt-5-mini" }],
      executionStyle: "agentic_surface",
    });

    await promptPacks.fetchPromptPackReviews("pack/id", "test/id");
    expect(lastRequest()[0]).toBe("/api/v1/prompt-packs/pack%2Fid/tests/test%2Fid/reviews");

    await memory.fetchMemoryItems({ namespace: "project", status: "all", query: "routing", limit: 9999 });
    expect(lastRequest()[0]).toBe("/api/v1/memory/items?namespace=project&status=all&query=routing&limit=500");

    await memory.fetchMemoryItemHistory("memory/id", 0);
    expect(lastRequest()[0]).toBe("/api/v1/memory/items/memory%2Fid/history?limit=1");

    await capabilities.fetchCodeModeRuns({
      limit: 999,
      workspaceId: "workspace/1",
      sessionId: "session/1",
      turnId: "turn/1",
      status: "failed",
    });
    expect(lastRequest()[0]).toBe(
      "/api/v1/code-mode/runs?limit=500&workspaceId=workspace%2F1&sessionId=session%2F1&turnId=turn%2F1&status=failed",
    );

    await capabilities.fetchCodeModeRun("run/1", {
      workspaceId: "workspace/1",
      sessionId: "session/1",
      turnId: "turn/1",
    });
    expect(lastRequest()[0]).toBe(
      "/api/v1/code-mode/runs/run%2F1?sessionId=session%2F1&turnId=turn%2F1&workspaceId=workspace%2F1",
    );
  });

  it("wires chat project, workbench, attachment, and delegation transports", async () => {
    const chat = await import("./chat");

    await chat.fetchChatProjects("all", 25, " workspace-1 ");
    expect(lastRequest()[0]).toBe("/api/v1/chat/projects?view=all&limit=25&workspaceId=workspace-1");

    await chat.importChatProject({
      sourceType: "github_repo",
      repoUrl: "https://github.com/goatcitadel/example",
      ref: "main",
    });
    expect(lastRequest()[0]).toBe("/api/v1/chat/projects/import");
    expect(lastRequest()[1]?.method).toBe("POST");

    await chat.fetchChatSessionWorkbench("session/id");
    expect(lastRequest()[0]).toBe("/api/v1/chat/sessions/session%2Fid/workbench");

    await chat.createChatSessionWorkbenchWorktree("session/id", { baseRef: "origin/main" });
    expect(lastRequest()[0]).toBe("/api/v1/chat/sessions/session%2Fid/workbench/worktree");
    expect(jsonBody(lastRequest()[1])).toEqual({ baseRef: "origin/main" });

    await chat.fetchChatSessionWorkbenchTree("session/id");
    expect(lastRequest()[0]).toBe("/api/v1/chat/sessions/session%2Fid/workbench/tree");

    await chat.fetchChatSessionWorkbenchFile("session/id", "src/app.ts");
    expect(lastRequest()[0]).toBe("/api/v1/chat/sessions/session%2Fid/workbench/file?path=src%2Fapp.ts");

    await chat.saveChatSessionWorkbenchFile("session/id", {
      relativePath: "src/app.ts",
      content: "export {};",
    } as never);
    expect(lastRequest()[0]).toBe("/api/v1/chat/sessions/session%2Fid/workbench/file");
    expect(lastRequest()[1]?.method).toBe("PUT");

    await chat.fetchChatSessionWorkbenchFileDiff("session/id", "src/app.ts");
    expect(lastRequest()[0]).toBe("/api/v1/chat/sessions/session%2Fid/workbench/file-diff?path=src%2Fapp.ts");

    await chat.fetchChatSessionWorkbenchDiff("session/id");
    expect(lastRequest()[0]).toBe("/api/v1/chat/sessions/session%2Fid/workbench/diff");

    await chat.fetchChatSessionWorkbenchOutput("session/id");
    expect(lastRequest()[0]).toBe("/api/v1/chat/sessions/session%2Fid/workbench/output");

    await chat.fetchChatMessages("session/id", 2_000, "cursor-1");
    expect(lastRequest()[0]).toBe("/api/v1/chat/sessions/session%2Fid/messages?limit=1000&cursor=cursor-1");

    await chat.uploadChatAttachment({
      sessionId: "session/id",
      projectId: "project/id",
      file: new File(["hello"], "hello.txt", { type: "" }),
    });
    expect(lastRequest()[0]).toBe("/api/v1/chat/attachments");
    expect(jsonBody(lastRequest()[1])).toEqual({
      sessionId: "session/id",
      projectId: "project/id",
      fileName: "hello.txt",
      mimeType: "application/octet-stream",
      bytesBase64: "aGVsbG8=",
    });

    class SuccessFileReader {
      public error: Error | null = null;
      public onerror: (() => void) | null = null;
      public onload: (() => void) | null = null;
      public result: string | ArrayBuffer | null = null;

      public readAsDataURL(): void {
        this.result = "data:text/plain;base64,ZmFrZQ==";
        this.onload?.();
      }
    }
    vi.stubGlobal("FileReader", SuccessFileReader);
    await chat.uploadChatAttachment({
      sessionId: "session/id",
      file: new File(["fake"], "fake.txt", { type: "text/plain" }),
    });
    expect(jsonBody(lastRequest()[1])).toMatchObject({
      fileName: "fake.txt",
      mimeType: "text/plain",
      bytesBase64: "ZmFrZQ==",
    });

    class BadResultFileReader extends SuccessFileReader {
      public override readAsDataURL(): void {
        this.result = new ArrayBuffer(0);
        this.onload?.();
      }
    }
    vi.stubGlobal("FileReader", BadResultFileReader);
    await expect(
      chat.uploadChatAttachment({
        sessionId: "session/id",
        file: new File(["bad"], "bad.txt", { type: "text/plain" }),
      }),
    ).rejects.toThrow("Failed to encode attachment.");

    class ErrorFileReader extends SuccessFileReader {
      public override readAsDataURL(): void {
        this.error = new Error("reader failed");
        this.onerror?.();
      }
    }
    vi.stubGlobal("FileReader", ErrorFileReader);
    await expect(
      chat.uploadChatAttachment({
        sessionId: "session/id",
        file: new File(["bad"], "error.txt", { type: "text/plain" }),
      }),
    ).rejects.toThrow("reader failed");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Blob(["downloaded"], { type: "text/plain" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    apiMocks.request.mockImplementationOnce(async () => ({ fileName: "note.txt", mimeType: "text/plain" }));

    await expect(chat.downloadChatAttachment("attachment/id")).resolves.toMatchObject({
      fileName: "note.txt",
      mimeType: "text/plain",
    });
    expect(apiMocks.readGatewayAuthHeaders).toHaveBeenCalledWith("/api/v1/chat/attachments/attachment%2Fid/content");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gateway.local/api/v1/chat/attachments/attachment%2Fid/content?disposition=attachment",
      { headers: { Authorization: "Bearer test-token" } },
    );

    await expect(chat.downloadChatAttachment("attachment/id")).rejects.toThrow("API error 404: missing");
  });

  it("adds explicit origin headers to chat stream requests and surfaces stream errors", async () => {
    const chat = await import("./chat");
    const response = new Response(new ReadableStream(), { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const sendChunks: unknown[] = [];
    await chat.streamAgentChatMessage("session/id", { content: "hello" } as never, (chunk) => sendChunks.push(chunk), {
      originSurface: "code",
    });
    expect(sendChunks).toEqual([
      { type: "token", text: "ok" },
      { type: "error", turnId: "turn-1", error: "stream warning" },
    ]);
    expect(apiMocks.buildGatewayHeaders).toHaveBeenCalledWith(
      "/api/v1/chat/sessions/session%2Fid/agent-send/stream",
      "POST",
      "corr-1",
      expect.objectContaining({
        "x-goatcitadel-origin-surface": "code",
        "x-goatcitadel-session-id": "session/id",
      }),
    );

    const delegationChunks: unknown[] = [];
    await expect(
      chat.streamChatDelegation("session/id", { surfaceMode: "cowork" } as never, (chunk) =>
        delegationChunks.push(chunk),
      ),
    ).rejects.toThrow("delegation failed");
    expect(delegationChunks).toEqual([
      { type: "progress", message: "routing" },
      { type: "error", error: "delegation failed" },
    ]);

    await chat.streamRetryChatTurn("session/id", "turn/id", { content: "retry" } as never, vi.fn(), {
      originSurface: "chat",
    });
    await chat.streamEditChatTurn("session/id", "turn/id", { content: "edit" } as never, vi.fn(), {
      originSurface: "cowork",
    });
    expect(apiMocks.buildGatewayUrl).toHaveBeenCalledWith(
      "/api/v1/chat/sessions/session%2Fid/turns/turn%2Fid/retry/stream",
    );
    expect(apiMocks.buildGatewayUrl).toHaveBeenCalledWith(
      "/api/v1/chat/sessions/session%2Fid/turns/turn%2Fid/edit/stream",
    );
  });
});
