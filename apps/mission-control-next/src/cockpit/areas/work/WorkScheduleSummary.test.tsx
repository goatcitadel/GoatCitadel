// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import {
  lastRunOutcomeLabel,
  lastRunPartial,
  lastRunSkipReason,
  WorkScheduleListItem,
  WorkScheduleRecordDetails,
} from "./WorkScheduleSummary";

function buildJob(overrides: Partial<CronJobRecordResponse> = {}): CronJobRecordResponse {
  return {
    jobId: "memory-consolidation-weekly",
    revision: 1,
    name: "Memory consolidation",
    action: "memory_consolidation",
    schedule: "0 2 * * 0",
    enabled: true,
    ...overrides,
  } as CronJobRecordResponse;
}

const partialOutput = JSON.stringify({ result: "partial", partialReason: "autonomy_kill_switch" });

describe("schedule last-run outcome", () => {
  it("labels skipped and partial runs distinctly from a success", () => {
    expect(lastRunOutcomeLabel(buildJob({ lastRunStatus: "skipped" }))).toBe("Skipped (no work done)");
    expect(lastRunOutcomeLabel(buildJob({ lastRunStatus: "ok", lastRunOutput: partialOutput }))).toBe(
      "Partially completed",
    );
    expect(lastRunOutcomeLabel(buildJob({ lastRunStatus: "ok", lastRunOutput: '{"result":"ok"}' }))).toBe("Succeeded");
    expect(lastRunOutcomeLabel(buildJob({ lastRunStatus: "ok", lastRunOutput: "not json" }))).toBe("Succeeded");
    expect(lastRunOutcomeLabel(buildJob({ lastRunStatus: "failed" }))).toBe("Failed");
    expect(lastRunOutcomeLabel(buildJob())).toBe("Not reported");
  });

  it("reads the Gateway skip reason only for skipped runs and tolerates malformed output", () => {
    const output = JSON.stringify({ result: "skipped", skipReason: "memory_consolidation_flags_disabled" });
    expect(lastRunSkipReason(buildJob({ lastRunStatus: "skipped", lastRunOutput: output }))).toBe(
      "memory_consolidation_flags_disabled",
    );
    expect(lastRunSkipReason(buildJob({ lastRunStatus: "ok", lastRunOutput: output }))).toBeUndefined();
    expect(lastRunSkipReason(buildJob({ lastRunStatus: "skipped", lastRunOutput: "not json" }))).toBeUndefined();
    expect(lastRunSkipReason(buildJob({ lastRunStatus: "skipped" }))).toBeUndefined();
  });

  it("reads a partial run only from a cleanly settled run output", () => {
    expect(lastRunPartial(buildJob({ lastRunStatus: "ok", lastRunOutput: partialOutput }))).toEqual({
      reason: "autonomy_kill_switch",
    });
    expect(lastRunPartial(buildJob({ lastRunStatus: "ok", lastRunOutput: '{"result":"partial"}' }))).toEqual({
      reason: undefined,
    });
    expect(lastRunPartial(buildJob({ lastRunStatus: "failed", lastRunOutput: partialOutput }))).toBeUndefined();
    expect(lastRunPartial(buildJob({ lastRunStatus: "ok", lastRunOutput: '{"result":"ok"}' }))).toBeUndefined();
  });
});

describe("schedule summary rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows a skipped last run and its reason instead of success", () => {
    const job = buildJob({
      lastRunStatus: "skipped",
      lastRunOutput: JSON.stringify({ result: "skipped", skipReason: "autonomy_kill_switch" }),
    });

    act(() =>
      root.render(
        <ul>
          <WorkScheduleListItem job={job} onReview={() => {}} />
        </ul>,
      ),
    );
    expect(container.textContent).toContain("Last outcome: Skipped (no work done)");
    expect(container.textContent).not.toContain("Succeeded");

    act(() => root.render(<WorkScheduleRecordDetails selected={job} />));
    expect(container.textContent).toContain("Last run was skipped and did no work.");
    expect(container.textContent).toMatch(/Reason: Autonomy kill switch\./i);
  });

  it("shows a partial last run and why it stopped instead of success", () => {
    const job = buildJob({ lastRunStatus: "ok", lastRunOutput: partialOutput });

    act(() =>
      root.render(
        <ul>
          <WorkScheduleListItem job={job} onReview={() => {}} />
        </ul>,
      ),
    );
    expect(container.textContent).toContain("Last outcome: Partially completed");
    expect(container.textContent).not.toContain("Succeeded");

    act(() => root.render(<WorkScheduleRecordDetails selected={job} />));
    expect(container.textContent).toContain("Last run stopped before finishing all of its work");
    expect(container.textContent).toMatch(/Reason: Autonomy kill switch\./i);
  });
});
