import { describe, expect, it } from "vitest";
import type { DurableDeadLetterRecord, DurableRunRecord } from "@goatcitadel/contracts";
import { canControlWorkRun, sameWorkRunEvidence } from "./work-run-control-guard";

const run: DurableRunRecord = {
  runId: "run-a", workflowKey: "maintenance.repair", status: "running", attemptCount: 1, maxAttempts: 3,
  version: 2, payload: { workspaceId: "default" }, metadata: { workspaceId: "default" },
  createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T01:00:00Z",
};
const letter: DurableDeadLetterRecord = {
  deadLetterId: "dead-a", runId: "run-a", reason: "Stopped", payload: {}, createdAt: "2026-09-28T02:00:00Z",
};

describe("Work run control guard", () => {
  it("limits actions to current scoped, eligible owner states", () => {
    expect(canControlWorkRun(run, "pause", "default")).toBe(true);
    expect(canControlWorkRun(run, "cancel", "default")).toBe(true);
    expect(canControlWorkRun(run, "resume", "default")).toBe(false);
    expect(canControlWorkRun({ ...run, status: "paused" }, "resume", "default")).toBe(true);
    expect(canControlWorkRun({ ...run, status: "completed" }, "cancel", "default")).toBe(false);
    expect(canControlWorkRun(run, "cancel", "other")).toBe(false);
    expect(canControlWorkRun({ ...run, metadata: { workspaceId: "other" } }, "pause", "default")).toBe(false);
    expect(canControlWorkRun({ ...run, version: Number.NaN }, "pause", "default")).toBe(false);
    expect(canControlWorkRun({ ...run, status: "failed" }, "retry", "default")).toBe(true);
    expect(canControlWorkRun({ ...run, status: "failed", attemptCount: 3 }, "retry", "default")).toBe(false);
    expect(canControlWorkRun({ ...run, status: "dead_lettered" }, "recover", "default", letter)).toBe(true);
    expect(canControlWorkRun({ ...run, status: "dead_lettered" }, "recover", "default")).toBe(false);
    expect(canControlWorkRun({ ...run, status: "dead_lettered", attemptCount: 20 }, "recover", "default", letter)).toBe(false);
    expect(canControlWorkRun({ ...run, status: "dead_lettered" }, "recover", "default", { ...letter, resolvedAt: "later" })).toBe(false);
  });

  it("requires unchanged owner evidence before requesting a transition", () => {
    expect(sameWorkRunEvidence(run, { ...run })).toBe(true);
    expect(sameWorkRunEvidence(run, { ...run, version: 3 })).toBe(false);
    expect(sameWorkRunEvidence(run, { ...run, updatedAt: "later" })).toBe(false);
    expect(sameWorkRunEvidence(run, { ...run, status: "waiting" })).toBe(false);
  });
});
