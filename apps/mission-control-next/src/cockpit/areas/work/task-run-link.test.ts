import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { taskConversationId, taskRunHref } from "./task-run-link";

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId: "task-a",
  revision: 1,
  workspaceId: "workspace-a",
  title: "Task",
  status: "review",
  priority: "normal",
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T01:00:00.000Z",
  ...overrides,
});

describe("task run link", () => {
  it("links a durable run id from either context and encodes it", () => {
    expect(taskRunHref(task({ agenticContext: { durableRunId: "run 1" } as TaskRecord["agenticContext"] }))).toBe(
      "/work/runs/run%201",
    );
    expect(taskRunHref(task({ proactiveContext: { durableRunId: "run-2" } as TaskRecord["proactiveContext"] }))).toBe(
      "/work/runs/run-2",
    );
  });

  it("never links a delegation's own run id", () => {
    expect(
      taskRunHref(task({ agenticContext: { runId: "delegation-run-1" } as TaskRecord["agenticContext"] })),
    ).toBeUndefined();
    expect(taskRunHref(task())).toBeUndefined();
  });

  it("finds the conversation in the order proactive, child, parent", () => {
    expect(taskConversationId(task())).toBeUndefined();
    expect(
      taskConversationId(task({ agenticContext: { parentSessionId: "s-1" } as TaskRecord["agenticContext"] })),
    ).toBe("s-1");
    expect(
      taskConversationId(
        task({ agenticContext: { parentSessionId: "s-1", childSessionId: "s-2" } as TaskRecord["agenticContext"] }),
      ),
    ).toBe("s-2");
    expect(
      taskConversationId(
        task({
          proactiveContext: { sessionId: "s-3" } as TaskRecord["proactiveContext"],
          agenticContext: { childSessionId: "s-2" } as TaskRecord["agenticContext"],
        }),
      ),
    ).toBe("s-3");
  });
});
