import { describe, expect, it, vi } from "vitest";
import type { DurableRunRecord, McpServerRecord } from "@goatcitadel/contracts";
import {
  MCP_DURABLE_TASKS_CANCEL_TOOL_NAME,
  MCP_DURABLE_TASKS_GET_TOOL_NAME,
  MCP_DURABLE_TASKS_LIST_TOOL_NAME,
  MCP_DURABLE_TASKS_URL,
  createInternalMcpDurableTasksTools,
  handleInternalMcpDurableTasksInvoke,
  isInternalMcpDurableTasksServer,
} from "./mcp-durable-tasks.js";

const DEFAULT_WORKSPACE_ID = "workspace-1";

function createRun(overrides: Partial<DurableRunRecord> = {}): DurableRunRecord {
  return {
    runId: "run-1",
    workflowKey: "approval.wait",
    status: "running",
    attemptCount: 1,
    maxAttempts: 5,
    version: 1,
    payload: { workspaceId: DEFAULT_WORKSPACE_ID, secret: "should-not-leak" },
    createdAt: "2026-06-22T10:00:00.000Z",
    updatedAt: "2026-06-22T10:01:00.000Z",
    ...overrides,
  };
}

function server(): McpServerRecord {
  return { serverId: "durable-tasks", url: MCP_DURABLE_TASKS_URL } as McpServerRecord;
}

describe("mcp-durable-tasks", () => {
  it("detects the internal server and exposes list/get/cancel tools", () => {
    expect(isInternalMcpDurableTasksServer({ url: MCP_DURABLE_TASKS_URL })).toBe(true);
    expect(isInternalMcpDurableTasksServer({ url: "https://example.test" })).toBe(false);
    const tools = createInternalMcpDurableTasksTools("durable-tasks").map((t) => t.toolName);
    expect(tools).toEqual([
      MCP_DURABLE_TASKS_LIST_TOOL_NAME,
      MCP_DURABLE_TASKS_GET_TOOL_NAME,
      MCP_DURABLE_TASKS_CANCEL_TOOL_NAME,
    ]);
  });

  it("lists tasks as payload-free views", async () => {
    const deps = {
      listRuns: vi.fn(() => [
        createRun(),
        createRun({ runId: "run-2", payload: { workspaceId: "workspace-2", secret: "should-not-leak" } }),
      ]),
      getRun: vi.fn(),
      cancelRun: vi.fn(),
    };
    const result = await handleInternalMcpDurableTasksInvoke(
      server(),
      {
        serverId: "durable-tasks",
        toolName: MCP_DURABLE_TASKS_LIST_TOOL_NAME,
        workspaceId: DEFAULT_WORKSPACE_ID,
        arguments: { limit: 10 },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    const tasks = result.output?.tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ taskId: "run-1", workflowKey: "approval.wait", status: "running" });
    expect(tasks[0]).not.toHaveProperty("payload");
    expect(deps.listRuns).toHaveBeenCalledWith(200);
  });

  it("gets a task and reports not-found cleanly", async () => {
    const deps = {
      listRuns: vi.fn(),
      getRun: vi.fn((id: string) => (id === "run-1" ? createRun() : undefined)),
      cancelRun: vi.fn(),
    };
    const found = await handleInternalMcpDurableTasksInvoke(
      server(),
      {
        serverId: "durable-tasks",
        toolName: MCP_DURABLE_TASKS_GET_TOOL_NAME,
        workspaceId: DEFAULT_WORKSPACE_ID,
        arguments: { taskId: "run-1" },
      },
      deps,
    );
    expect((found.output?.task as { taskId: string }).taskId).toBe("run-1");
    const missing = await handleInternalMcpDurableTasksInvoke(
      server(),
      {
        serverId: "durable-tasks",
        toolName: MCP_DURABLE_TASKS_GET_TOOL_NAME,
        workspaceId: DEFAULT_WORKSPACE_ID,
        arguments: { taskId: "nope" },
      },
      deps,
    );
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not found/i);
  });

  it("cancels a task via the cancel port", async () => {
    const deps = {
      listRuns: vi.fn(),
      getRun: vi.fn(() => createRun()),
      cancelRun: vi.fn(() => createRun({ status: "cancelled" })),
    };
    const result = await handleInternalMcpDurableTasksInvoke(
      server(),
      {
        serverId: "durable-tasks",
        toolName: MCP_DURABLE_TASKS_CANCEL_TOOL_NAME,
        workspaceId: DEFAULT_WORKSPACE_ID,
        arguments: { taskId: "run-1" },
      },
      deps,
    );
    expect(deps.cancelRun).toHaveBeenCalledWith("run-1");
    expect((result.output?.task as { status: string }).status).toBe("cancelled");
  });

  it("does not expose or cancel durable tasks from another workspace", async () => {
    const deps = {
      listRuns: vi.fn(),
      getRun: vi.fn(() => createRun({ payload: { workspaceId: "workspace-2" } })),
      cancelRun: vi.fn(() => createRun({ status: "cancelled", payload: { workspaceId: "workspace-2" } })),
    };
    const getResult = await handleInternalMcpDurableTasksInvoke(
      server(),
      {
        serverId: "durable-tasks",
        toolName: MCP_DURABLE_TASKS_GET_TOOL_NAME,
        workspaceId: DEFAULT_WORKSPACE_ID,
        arguments: { taskId: "run-2" },
      },
      deps,
    );
    const cancelResult = await handleInternalMcpDurableTasksInvoke(
      server(),
      {
        serverId: "durable-tasks",
        toolName: MCP_DURABLE_TASKS_CANCEL_TOOL_NAME,
        workspaceId: DEFAULT_WORKSPACE_ID,
        arguments: { taskId: "run-2" },
      },
      deps,
    );
    expect(getResult.ok).toBe(false);
    expect(cancelResult.ok).toBe(false);
    expect(deps.cancelRun).not.toHaveBeenCalled();
  });

  it("fails closed when workspace scope is missing", async () => {
    const deps = { listRuns: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn() };
    const result = await handleInternalMcpDurableTasksInvoke(
      server(),
      { serverId: "durable-tasks", toolName: MCP_DURABLE_TASKS_LIST_TOOL_NAME, arguments: {} },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/workspace scope/i);
    expect(deps.listRuns).not.toHaveBeenCalled();
  });

  it("rejects unknown tools and non-durable servers", async () => {
    const deps = { listRuns: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn() };
    const unknown = await handleInternalMcpDurableTasksInvoke(
      server(),
      {
        serverId: "durable-tasks",
        toolName: "goatcitadel.durable.tasks.bogus",
        workspaceId: DEFAULT_WORKSPACE_ID,
        arguments: {},
      },
      deps,
    );
    expect(unknown.ok).toBe(false);
    const wrongServer = await handleInternalMcpDurableTasksInvoke(
      { serverId: "x", url: "https://example.test" } as McpServerRecord,
      { serverId: "x", toolName: MCP_DURABLE_TASKS_LIST_TOOL_NAME, arguments: {} },
      deps,
    );
    expect(wrongServer.ok).toBe(false);
  });
});
