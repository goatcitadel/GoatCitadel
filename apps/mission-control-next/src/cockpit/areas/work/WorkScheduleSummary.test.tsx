// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import {
  lastRunOutcomeLabel,
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

describe("schedule last-run outcome", () => {
  it("labels a skipped run distinctly from a success", () => {
    expect(lastRunOutcomeLabel("skipped")).toBe("Skipped (no work done)");
    expect(lastRunOutcomeLabel("ok")).toBe("Succeeded");
    expect(lastRunOutcomeLabel("failed")).toBe("Failed");
    expect(lastRunOutcomeLabel(undefined)).toBe("Not reported");
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
});
