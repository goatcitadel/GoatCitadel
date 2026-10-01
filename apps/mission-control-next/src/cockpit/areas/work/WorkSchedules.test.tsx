// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import {
  createCronJob,
  deleteCronJob,
  fetchCronJob,
  fetchCronJobs,
  pauseCronJob,
  runCronJobNow,
  startCronJob,
} from "@goatcitadel/mission-control-shared/api/cron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkSchedules } from "./WorkSchedules";
import { __resetSessionDraftsForTests, discardSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { scheduleCreateDraftKey } from "../../../features/native-routes/ops/work-form-drafts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { resetScheduleOperationsForTests } from "../../../features/native-routes/ops/use-schedule-operations";

vi.mock("@goatcitadel/mission-control-shared/api/cron", () => ({
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  fetchCronJob: vi.fn(),
  fetchCronJobs: vi.fn(),
  pauseCronJob: vi.fn(),
  runCronJobNow: vi.fn(),
  startCronJob: vi.fn(),
}));
vi.mock("../../../features/native-routes/ops/schedule-id", () => ({
  createScheduleJobId: () => "new-schedule-id",
}));

const job = (overrides: Partial<CronJobRecordResponse> = {}): CronJobRecordResponse => ({
  jobId: "job-a",
  revision: 2,
  name: "Daily review",
  action: "task",
  schedule: "0 9 * * *",
  enabled: true,
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  resetScheduleOperationsForTests();
  __resetSessionDraftsForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchCronJobs).mockResolvedValue({ items: [job()] });
  vi.mocked(fetchCronJob).mockResolvedValue(job());
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
});

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WorkSchedules />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Daily review"));
}

async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Missing ${label} button`);
  await act(async () => button.click());
}

async function review(): Promise<void> {
  await click("Review schedule");
  await vi.waitFor(() =>
    expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain("0 9 * * *"),
  );
}

describe("Work schedules", () => {
  it("does not dispatch a reviewed action when its preflight finishes after navigation", async () => {
    await render();
    await review();
    await click("Run now");
    let finish!: (value: CronJobRecordResponse) => void;
    vi.mocked(fetchCronJob).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await click("Confirm run");
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <p>Another route</p>
        </QueryClientProvider>,
      ),
    );
    await act(async () => finish(job()));
    expect(runCronJobNow).not.toHaveBeenCalled();
  });

  it("retains a lost run response lock across route remounts", async () => {
    vi.mocked(runCronJobNow).mockRejectedValueOnce(new Error("response lost"));
    await render();
    await review();
    await click("Run now");
    await click("Confirm run");
    await vi.waitFor(() => expect(container.textContent).toContain("action outcome is unconfirmed"));
    await act(async () => root.render(<p>Another route</p>));
    await render();
    await review();
    const run = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Run now",
    );
    expect(run?.disabled).toBe(true);
    await act(async () => run?.click());
    expect(runCronJobNow).toHaveBeenCalledTimes(1);
  });

  it("rechecks the exact revision before a confirmed pause", async () => {
    vi.mocked(pauseCronJob).mockResolvedValue(job({ revision: 3, enabled: false }));
    vi.mocked(fetchCronJob)
      .mockResolvedValueOnce(job())
      .mockResolvedValueOnce(job())
      .mockResolvedValue(job({ revision: 3, enabled: false }));
    await render();
    await review();
    await click("Pause");
    expect(pauseCronJob).not.toHaveBeenCalled();
    await click("Confirm pause");
    await vi.waitFor(() => expect(pauseCronJob).toHaveBeenCalledWith("job-a", 2));
    await vi.waitFor(() => expect(container.textContent).toContain("Schedule paused."));
    expect(fetchCronJob).toHaveBeenCalledTimes(4);
  });

  it("withholds a run when the schedule changes during review", async () => {
    vi.mocked(fetchCronJob)
      .mockResolvedValueOnce(job())
      .mockResolvedValue(job({ revision: 3 }));
    await render();
    await review();
    await click("Run now");
    await click("Confirm run");
    await vi.waitFor(() => expect(container.textContent).toContain("changed during review"));
    expect(runCronJobNow).not.toHaveBeenCalled();
  });

  it("locks further actions after an unconfirmed mutation outcome", async () => {
    vi.mocked(runCronJobNow).mockRejectedValue(new Error("Response lost"));
    await render();
    await review();
    await click("Run now");
    await click("Confirm run");
    await vi.waitFor(() => expect(container.textContent).toContain("action outcome is unconfirmed"));
    expect(container.querySelector<HTMLButtonElement>("button[disabled]")?.disabled).toBe(true);
    const actionButtons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
      ["Run now", "Pause", "Cancel schedule"].includes(button.textContent?.trim() ?? ""),
    );
    expect(actionButtons).toHaveLength(3);
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
    expect(container.querySelector<HTMLAnchorElement>('a[href="/ops/schedules?shell=classic"]')).not.toBeNull();
  });

  it("creates a Gateway schedule and selects its confirmed record", async () => {
    vi.mocked(createCronJob).mockResolvedValue(job({ jobId: "new-schedule-id", revision: 1, name: "Evening review" }));
    vi.mocked(fetchCronJob).mockResolvedValue(job({ jobId: "new-schedule-id", revision: 1, name: "Evening review" }));
    await render();
    await click("New schedule");
    const input = container.querySelector<HTMLInputElement>('form input[maxlength="100"]');
    if (!input) throw new Error("Missing schedule name");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Evening review");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Create schedule");
    await vi.waitFor(() =>
      expect(createCronJob).toHaveBeenCalledWith({
        jobId: "new-schedule-id",
        name: "Evening review",
        schedule: "0 9 * * *",
        action: "task",
        enabled: true,
      }),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Schedule created."));
    expect(deleteCronJob).not.toHaveBeenCalled();
    expect(startCronJob).not.toHaveBeenCalled();
  });
});

describe("retained schedule creation input", () => {
  it("keeps unsent input across unmount and discards without a Gateway request", async () => {
    await render(); await click("New schedule");
    const form = container.querySelector<HTMLFormElement>('form[aria-label="New schedule"]')!;
    const input = form.querySelector<HTMLInputElement>('input[maxlength="100"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Retained schedule");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => root.render(null)); await render(); await click("New schedule");
    expect(container.querySelector<HTMLInputElement>('input[maxlength="100"]')!.value).toBe("Retained schedule");
    await act(async () => discardSessionDraft(scheduleCreateDraftKey(getGatewayApiBaseUrl())));
    expect(container.querySelector<HTMLInputElement>('input[maxlength="100"]')!.value).toBe("");
    expect(createCronJob).not.toHaveBeenCalled();
    expect(runCronJobNow).not.toHaveBeenCalled();
  });
});
