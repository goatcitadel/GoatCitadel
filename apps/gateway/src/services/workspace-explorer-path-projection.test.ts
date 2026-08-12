import { describe, expect, it, vi } from "vitest";
import {
  ChatTurnAgentRunner,
  type ChatTurnAgentRunnerDeps,
  type ChatTurnAgentRunnerInput,
} from "./chat-turn-agent-runner.js";
import { createExecuteToolCallForTest, createMockStorage } from "./chat-turn-agent-runner-test-fixtures.js";
import {
  READ_ONLY_EXPLORER_PERMISSION_PROFILE_ID,
  projectWorkspaceExplorerPathValue,
} from "./workspace-explorer-path-projection.js";

describe("workspace explorer host-path projection", () => {
  it("normalizes Windows and POSIX paths recursively and contains out-of-workspace paths", () => {
    const projected = projectWorkspaceExplorerPathValue(
      {
        windows: {
          path: "F:\\private\\workspace\\apps\\gateway\\src\\main.ts",
          note: "Read F:/private/workspace/docs/owner.md and C:\\Users\\operator\\secrets.txt",
        },
        posix: {
          path: "/srv/workspace/packages/storage/src/index.ts",
          note: "See file:///srv/workspace/README.md and /home/operator/.ssh/id_ed25519",
        },
      },
      ["F:\\private\\workspace", "/srv/workspace"],
    );

    expect(projected).toEqual({
      windows: {
        path: "apps/gateway/src/main.ts",
        note: "Read docs/owner.md and [outside-workspace-path]",
      },
      posix: {
        path: "packages/storage/src/index.ts",
        note: "See README.md and [outside-workspace-path]",
      },
    });
  });

  it("keeps roots with spaces relative and supports local and UNC file URLs", () => {
    const projected = projectWorkspaceExplorerPathValue(
      {
        prose: "Read F:\\code\\My Project\\src\\owner.ts then /srv/My Project/docs/owner.md",
        localFileUrl: "file:///F:/code/My%20Project/src/owner.ts",
        shortPosixFileUrl: "file:/srv/My%20Project/docs/owner.md",
        shortWindowsFileUrl: "file:F:/code/My%20Project/src/owner.ts",
        uncFileUrl: "file://fileserver/share/workspace/docs/owner.md",
      },
      ["F:\\code\\My Project", "/srv/My Project", "\\\\fileserver\\share\\workspace"],
    );

    expect(projected).toEqual({
      prose: "Read src\\owner.ts then docs/owner.md",
      localFileUrl: "src/owner.ts",
      shortPosixFileUrl: "docs/owner.md",
      shortWindowsFileUrl: "src/owner.ts",
      uncFileUrl: "docs/owner.md",
    });
  });

  it("contains punctuation-separated POSIX host paths", () => {
    expect(
      projectWorkspaceExplorerPathValue(
        "paths:/srv/workspace/a,/home/operator/.ssh/id;(/etc/passwd)|/var/private/key",
        ["/srv/workspace"],
      ),
    ).toBe("paths:a,[outside-workspace-path];([outside-workspace-path])|[outside-workspace-path]");
  });

  it("projects absolute object keys without losing deterministic collisions", () => {
    const projected = projectWorkspaceExplorerPathValue(
      {
        "/srv/workspace/src/owner.ts": "inside",
        "/home/operator/.ssh/id": "first outside",
        "C:\\Users\\operator\\secret.txt": "second outside",
      },
      ["/srv/workspace"],
    );

    expect(projected).toEqual({
      "src/owner.ts": "inside",
      "[outside-workspace-path]": "first outside",
      "[outside-workspace-path]#2": "second outside",
    });
    expect(JSON.stringify(projected)).not.toContain("/home/operator");
    expect(JSON.stringify(projected)).not.toContain("C:\\\\Users");
  });

  it.each([
    {
      toolName: "fs.read",
      rootPath: "F:\\private\\workspace",
      args: { path: "F:\\private\\workspace\\src\\owner.ts" },
      result: {
        path: "F:\\private\\workspace\\src\\owner.ts",
        content: "Owner: F:\\private\\workspace\\src\\owner.ts; private: C:\\Users\\operator\\secret.txt",
      },
      expectedPath: "src/owner.ts",
    },
    {
      toolName: "file.read_range",
      rootPath: "/srv/workspace",
      args: { path: "/srv/workspace/src/owner.ts", startLine: 1, endLine: 2 },
      result: {
        path: "/srv/workspace/src/owner.ts",
        content: "source /srv/workspace/src/owner.ts; private /home/operator/.ssh/config",
      },
      expectedPath: "src/owner.ts",
    },
    {
      toolName: "code.search",
      rootPath: "F:\\private\\workspace",
      args: { path: "F:\\private\\workspace", query: "owner" },
      result: {
        path: "F:\\private\\workspace",
        matches: [
          { path: "F:\\private\\workspace\\apps\\gateway\\src\\owner.ts", line: 4 },
          { path: "C:\\Users\\operator\\private.txt", line: 1 },
        ],
      },
      expectedPath: ".",
    },
  ])("projects $toolName before its result is persisted or streamed", async (testCase) => {
    const baseStorage = explorerStorage(testCase.rootPath);
    const executeToolCall = createExecuteToolCallForTest({
      storage: baseStorage,
      toolNames: [testCase.toolName],
      invokeTool: async () => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: `audit-${testCase.toolName}`,
        result: testCase.result,
      }),
    });

    const settled = await executeToolCall({
      input: explorerTurnInput(),
      turnId: "explorer-turn",
      toolName: testCase.toolName,
      rawArgs: testCase.args,
      localFileIntent: true,
    });

    expect(settled.record.status).toBe("executed");
    expect(settled.record.result?.path).toBe(testCase.expectedPath);
    const serialized = JSON.stringify({ record: settled.record, chunk: settled.chunk });
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(serialized).not.toContain("/srv/workspace");
    expect(serialized).not.toContain("/home/operator");
    expect(serialized).toContain("[outside-workspace-path]");
  });

  it("does not change ordinary non-explorer tool results", async () => {
    const executeToolCall = createExecuteToolCallForTest({
      toolNames: ["fs.read"],
      invokeTool: async () => ({
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-standard-read",
        result: { path: "F:\\private\\workspace\\src\\owner.ts", content: "ordinary result" },
      }),
    });

    const settled = await executeToolCall({
      input: { ...explorerTurnInput(), permissionProfileId: "safe", parentDelegationStepId: undefined },
      turnId: "standard-turn",
      toolName: "fs.read",
      rawArgs: { path: "F:\\private\\workspace\\src\\owner.ts" },
      localFileIntent: true,
    });

    expect(settled.record.result?.path).toBe("F:\\private\\workspace\\src\\owner.ts");
  });

  it("buffers raw explorer provider deltas and emits only the whole projected answer", async () => {
    const storage = explorerStorage("F:\\private\\workspace");
    async function* createChatCompletionStream() {
      // Intentionally split an absolute path across provider chunks: projecting
      // individual fragments is insufficient, so explorer deltas stay private.
      yield { choices: [{ index: 0, delta: { content: "Owner F:\\private\\work" } }] };
      yield { choices: [{ index: 0, delta: { content: "space\\src\\owner.ts" }, finish_reason: "stop" }] };
    }
    const runner = new ChatTurnAgentRunner({
      storage,
      listToolCatalog: () => [],
      createChatCompletion: async () => ({ model: "test-model", choices: [] }),
      createChatCompletionStream,
      invokeTool: async () => ({ outcome: "blocked", policyReason: "not used" }),
    });

    const chunks = [];
    for await (const chunk of runner.runStream(explorerTurnInput())) chunks.push(chunk);

    expect(chunks.some((chunk) => chunk.type === "delta")).toBe(false);
    expect(chunks.find((chunk) => chunk.type === "message_done")).toMatchObject({
      content: "Owner src\\owner.ts",
    });
    expect(JSON.stringify(chunks)).not.toContain("F:\\\\private");
  });

  it("makes the projected filesystem result, never the host path, visible to the explorer model", async () => {
    const storage = explorerStorage("F:\\private\\workspace");
    storage.chatToolRuns = {
      ...storage.chatToolRuns,
      listByTurn: async () => [
        {
          toolRunId: "persisted-explorer-read",
          turnId: "explorer-turn",
          sessionId: "explorer-child",
          toolName: "file.read_range",
          status: "executed",
          args: {
            path: "F:\\private\\workspace\\src\\owner.ts",
            startLine: 1,
            endLine: 2,
          },
          result: {
            path: "F:\\private\\workspace\\src\\owner.ts",
            content: "owner from C:\\Users\\operator\\private.txt",
          },
          startedAt: "2026-08-12T00:00:00.000Z",
          finishedAt: "2026-08-12T00:00:01.000Z",
        },
      ],
    };
    const createChatCompletion = vi.fn(async (request: { messages: Array<{ role: string; content?: string }> }) => {
      const toolMessage = request.messages.findLast((message) => message.role === "tool");
      expect(toolMessage?.content).toContain('"path":"src/owner.ts"');
      expect(toolMessage?.content).toContain("[outside-workspace-path]");
      expect(toolMessage?.content).not.toContain("F:\\\\private");
      expect(toolMessage?.content).not.toContain("C:\\\\Users");
      return {
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Owner src/owner.ts" } }],
      };
    });
    const runner = new ChatTurnAgentRunner({
      storage,
      listToolCatalog: () => [],
      createChatCompletion,
      invokeTool: async () => ({ outcome: "blocked", policyReason: "not used" }),
    });

    const chunks = [];
    for await (const chunk of runner.runStream(explorerTurnInput())) chunks.push(chunk);

    expect(createChatCompletion).toHaveBeenCalledOnce();
    expect(chunks.find((chunk) => chunk.type === "message_done")).toMatchObject({ content: "Owner src/owner.ts" });
    expect(JSON.stringify(chunks)).not.toContain("F:\\\\private");
    expect(JSON.stringify(chunks)).not.toContain("C:\\\\Users");
  });
});

function explorerTurnInput(): ChatTurnAgentRunnerInput {
  const content = "Use file.read_range to read F:\\private\\workspace\\src\\owner.ts and identify the owner.";
  return {
    sessionId: "explorer-child",
    turnId: "explorer-turn",
    userMessageId: "explorer-message",
    parentDelegationStepId: "explorer-step",
    content,
    mode: "chat",
    providerId: "test",
    model: "test-model",
    webMode: "off",
    memoryMode: "off",
    retrievalMode: "standard",
    thinkingLevel: "standard",
    toolAutonomy: "manual",
    permissionProfileId: READ_ONLY_EXPLORER_PERMISSION_PROFILE_ID,
    historyMessages: [{ role: "user", content }],
  };
}

function explorerStorage(rootPath: string): ChatTurnAgentRunnerDeps["storage"] {
  const storage = createMockStorage() as ChatTurnAgentRunnerDeps["storage"] & Record<string, unknown>;
  storage.chatDelegationSteps = {
    get: async () => ({
      stepId: "explorer-step",
      runId: "explorer-run",
      role: "workspace-explorer",
      index: 0,
      status: "running",
      childSessionId: "explorer-child",
      scopeControl: {
        rootPath,
        workingPath: ".",
        approvedPaths: ["."],
        scopeHash: "scope-hash",
        dispatchGeneration: "dispatch-1",
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
      startedAt: "2026-08-12T00:00:00.000Z",
    }),
  } as never;
  storage.chatSessionProjects = {
    get: async () => ({ sessionId: "explorer-child", projectId: "project-1" }),
  } as never;
  return storage;
}
