import { describe, expect, it } from "vitest";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import { projectWorkBoard, workRunTitle } from "./work-board";

function run(status: DurableRunRecord["status"], workflowKey = "chat.turn.execute"): DurableRunRecord {
  return {
    runId: `${workflowKey}-${status}`,
    workflowKey,
    status,
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: { workspaceId: "default" },
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  };
}

describe("projectWorkBoard", () => {
  it("groups canonical durable statuses without claiming every wait needs an operator", () => {
    const board = projectWorkBoard([
      run("running"), run("waiting"), run("dead_lettered"), run("completed"), run("cancelled"),
      run("running", "memory.maintenance"), run("completed", "proactive.tick"),
      { ...run("failed"), payload: { heartbeatOccurrenceId: "heartbeat-1" } },
    ], "default");
    expect(board.running).toHaveLength(1);
    expect(board.waiting.map((item) => item.status)).toEqual(["waiting"]);
    expect(board.failed.map((item) => item.status)).toEqual(["dead_lettered"]);
    expect(board.done.map((item) => item.status)).toEqual(["completed", "cancelled"]);
  });

  it("uses a readable objective when the runtime recorded one", () => {
    expect(workRunTitle({ ...run("running"), metadata: { objective: "  Plan\n the release  " } })).toBe("Plan the release");
    expect(workRunTitle(run("running"))).toBe("Chat turn");
  });

  it("excludes foreign and unknown-scope runs from the selected workspace", () => {
    const board = projectWorkBoard([
      run("running"),
      { ...run("waiting"), payload: { workspaceId: "other" } },
      { ...run("failed"), payload: {} },
      { ...run("completed"), metadata: { workspaceId: "other" } },
    ], "default");
    expect(board.running).toHaveLength(1);
    expect(board.waiting).toHaveLength(0);
    expect(board.failed).toHaveLength(0);
    expect(board.done).toHaveLength(0);
  });
});
