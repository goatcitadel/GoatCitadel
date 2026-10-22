import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { buildCoworkExecutionSnapshot } from "./CoworkExecutionGlance";

const continuation = {
  nextActionLabel: "Next",
  nextActionDetail: "Detail",
  blockerCount: 0,
  activeCount: 0,
  reviewCount: 0,
  deliverableCount: 0,
  recoveryCount: 0,
  selectedTaskLabel: "None",
  hierarchyDetail: "",
  boardTruth: "",
};

const snapshot = (pendingApprovals: number | undefined, tasks: TaskRecord[] = []) =>
  buildCoworkExecutionSnapshot({
    tasks,
    deletedTasks: [],
    selectedTask: null,
    deliverables: [],
    deliverablesLoading: false,
    operators: [],
    pendingApprovals,
    continuation,
  });

describe("buildCoworkExecutionSnapshot approval attention", () => {
  it("says the approval queue is unknown, not clear, when the host has no count", () => {
    const result = snapshot(undefined);
    expect(result.attentionLabel).toBe("Unknown");
    expect(result.attentionDetail).toContain("approval queue is unavailable");
  });

  it("treats approval-linked tasks as evidence even without a count", () => {
    const task = { taskId: "t1", title: "T", status: "assigned", proactiveContext: { approvalId: "a1" } } as TaskRecord;
    expect(snapshot(undefined, [task]).attentionLabel).toBe("Waiting approval");
  });

  it("is clear when the host reports zero", () => {
    expect(snapshot(0).attentionLabel).toBe("Clear");
  });
});
