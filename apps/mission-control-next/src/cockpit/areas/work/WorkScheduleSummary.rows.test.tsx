// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import { WorkScheduleListItem } from "./WorkScheduleSummary";

vi.mock("../../data/use-workspace-name", () => ({
  useWorkspaceNameLookup: () => () => undefined,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: undefined }),
}));

function buildJob(overrides: Partial<CronJobRecordResponse> = {}): CronJobRecordResponse {
  return {
    jobId: "job-1",
    revision: 1,
    name: "Weekly backup",
    action: "backup",
    schedule: "0 2 * * 0",
    enabled: true,
    ...overrides,
  } as CronJobRecordResponse;
}

describe("schedule list rows", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(job: CronJobRecordResponse) {
    act(() =>
      root.render(
        <ul>
          <WorkScheduleListItem job={job} onReview={() => {}} />
        </ul>,
      ),
    );
    return container.querySelector("li")!;
  }

  it("is a hairline row without its own border or radius", () => {
    const item = render(buildJob());
    expect(item.className).not.toMatch(/\bborder\b/u);
    expect(item.className).not.toContain("rounded");
    expect(item.className).not.toContain("bg-raised");
    expect(item.className).toContain("px-3");
  });

  it("shows Enabled and Paused as status badges that announce nothing", () => {
    const enabled = render(buildJob());
    const badge = enabled.querySelector("[data-tone]")!;
    expect(badge.textContent).toBe("Enabled");
    expect(badge.getAttribute("data-tone")).toBe("done");

    const paused = render(buildJob({ enabled: false }));
    expect(paused.querySelector("[data-tone]")!.textContent).toBe("Paused");
    expect(paused.querySelector("[data-tone]")!.getAttribute("data-tone")).toBe("neutral");

    expect(container.querySelector("[aria-live], [role='status'], [role='alert']")).toBeNull();
  });
});
