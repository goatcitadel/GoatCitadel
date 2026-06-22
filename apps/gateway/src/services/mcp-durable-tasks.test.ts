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

function createRun(overrides: Partial<DurableRunRecord> = {}): DurableRunRecord {
  return {
    runId: "run-1",
    workflowKey: "approval.wait",
    status: "running",
    attemptCount: 1,
    maxAttempts: 5,
    version: 1,
    payload: { secret: "should-not-leak" },
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
    const deps = { listRuns: vi.fn(() => [createRun()]), getRun: vi.fn(), cancelRun: vi.fn() };
    const result = await handleInternalMcpDurableTasksInvoke(
      server(),
      { serverId: "durable-tasks", toolName: MCP_DURABLE_TASKS_LIST_TOOL_NAME, arguments: { limit: 10 } },
      deps,
    );
    expect(result.ok).toBe(true);
    const tasks = result.output?.tasks as Array<Record<string, unknown>>;
    expect(tasks[0]).toMatchObject({ taskId: "run-1", workflowKey: "approval.wait", status: "running" });
    expect(tasks[0]).not.toHaveProperty("payload");
    expect(deps.listRuns).toHaveBeenCalledWith(10);
  });

  it("gets a task and reports not-found cleanly", async () => {
    const deps = {
      listRuns: vi.fn(),
      getRun: vi.fn((id: string) => (id === "run-1" ? createRun() : undefined)),
      cancelRun: vi.fn(),
    };
    const found = await handleInternalMcpDurableTasksInvoke(
      server(),
      { serverId: "durable-tasks", toolName: MCP_DURABLE_TASKS_GET_TOOL_NAME, arguments: { taskId: "run-1" } },
      deps,
    );
    expect((found.output?.task as { taskId: string }).taskId).toBe("run-1");
    const missing = await handleInternalMcpDurableTasksInvoke(
      server(),
      { serverId: "durable-tasks", toolName: MCP_DURABLE_TASKS_GET_TOOL_NAME, arguments: { taskId: "nope" } },
      deps,
    );
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not found/i);
  });

  it("cancels a task via the cancel port", async () => {
    const deps = {
      listRuns: vi.fn(),
      getRun: vi.fn(),
      cancelRun: vi.fn(() => createRun({ status: "cancelled" })),
    };
    const result = await handleInternalMcpDurableTasksInvoke(
      server(),
      { serverId: "durable-tasks", toolName: MCP_DURABLE_TASKS_CANCEL_TOOL_NAME, arguments: { taskId: "run-1" } },
      deps,
    );
    expect(deps.cancelRun).toHaveBeenCalledWith("run-1");
    expect((result.output?.task as { status: string }).status).toBe("cancelled");
  });

  it("rejects unknown tools and non-durable servers", async () => {
    const deps = { listRuns: vi.fn(), getRun: vi.fn(), cancelRun: vi.fn() };
    const unknown = await handleInternalMcpDurableTasksInvoke(
      server(),
      { serverId: "durable-tasks", toolName: "goatcitadel.durable.tasks.bogus", arguments: {} },
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
