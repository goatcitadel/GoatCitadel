import { describe, it, expect } from "vitest";
import type { TaskRecord } from "@goatcitadel/contracts";
import { toKanbanCard, toKanbanColumn, type KanbanColumnId } from "./kanban-card-model";

const baseTask: TaskRecord = {
  taskId: "t-1",
  workspaceId: "default",
  title: "Build feature",
  status: "in_progress",
  priority: "high",
  assignedAgentId: "agent-7",
  createdAt: "2026-05-15T11:00:00.000Z",
  updatedAt: "2026-05-15T11:55:00.000Z",
};

describe("kanban-card-model", () => {
  it("toKanbanCard surfaces unresolved distress severity, retry count, heartbeat age", () => {
    const card = toKanbanCard(
      {
        ...baseTask,
        distressSignals: [
          {
            signalId: "ds-1",
            code: "tool_error",
            severity: "critical",
            title: "x",
            summary: "y",
            createdAt: "2026-05-15T11:30:00.000Z",
          },
        ],
        retryBudget: { maxRetries: 3, retryCount: 1 },
        agenticContext: { heartbeatAt: "2026-05-15T11:50:00.000Z" },
      },
      { now: () => Date.parse("2026-05-15T12:00:00.000Z") },
    );
    expect(card.distressSummary).toMatchObject({ critical: 1, warn: 0, info: 0 });
    expect(card.retryDisplay).toBe("1 / 3");
    expect(card.lastHeartbeatAgeSeconds).toBe(600);
  });

  it("toKanbanCard returns undefined heartbeat age when agenticContext has no heartbeatAt", () => {
    const card = toKanbanCard(baseTask);
    expect(card.lastHeartbeatAgeSeconds).toBeUndefined();
  });

  it("toKanbanCard excludes resolved signals from distress summary", () => {
    const card = toKanbanCard({
      ...baseTask,
      distressSignals: [
        {
          signalId: "ds-1",
          code: "needs_user",
          severity: "warn",
          title: "x",
          summary: "y",
          createdAt: "2026-05-15T11:30:00.000Z",
          resolvedAt: "2026-05-15T11:31:00.000Z",
        },
      ],
    });
    expect(card.distressSummary).toEqual({ info: 0, warn: 0, critical: 0 });
    expect(card.unresolvedDistress).toEqual([]);
  });

  it("toKanbanColumn assigns statuses to the four operator columns", () => {
    expect<KanbanColumnId>(toKanbanColumn("planning")).toBe("backlog");
    expect<KanbanColumnId>(toKanbanColumn("inbox")).toBe("backlog");
    expect<KanbanColumnId>(toKanbanColumn("assigned")).toBe("backlog");
    expect<KanbanColumnId>(toKanbanColumn("in_progress")).toBe("in_progress");
    expect<KanbanColumnId>(toKanbanColumn("testing")).toBe("in_progress");
    expect<KanbanColumnId>(toKanbanColumn("review")).toBe("in_progress");
    expect<KanbanColumnId>(toKanbanColumn("blocked")).toBe("blocked");
    expect<KanbanColumnId>(toKanbanColumn("done")).toBe("done");
  });

  it("toKanbanCard renders no retryDisplay when retryBudget is absent", () => {
    const card = toKanbanCard(baseTask);
    expect(card.retryDisplay).toBeUndefined();
  });
});
