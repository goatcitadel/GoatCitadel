// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import {
  createCronJob,
  deleteCronJob,
  fetchCronJob,
  fetchCronJobs,
  pauseCronJob,
  runCronJobNow,
  startCronJob,
  fetchCronReviewQueue,
} from "@goatcitadel/mission-control-shared/api/cron";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WorkSchedules } from "./WorkSchedules";
import { WorkArea } from "./WorkArea";
import { fetchObserveRunTrace } from "@goatcitadel/mission-control-shared/api/durable";
import { CockpitNavigationContext } from "../../app/cockpit-navigation-context";
import { commitCockpitNavigation } from "../../app/cockpit-history";
import {
  __resetSessionDraftsForTests,
  discardSessionDraft,
} from "../../../features/native-routes/library/session-drafts";
import { scheduleCreateDraftKey } from "../../../features/native-routes/ops/work-form-drafts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { resetScheduleOperationsForTests } from "../../../features/native-routes/ops/use-schedule-operations";

vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <section role="dialog">{children}</section> : null,
}));
vi.mock("@goatcitadel/mission-control-shared/api/cron", () => ({
  updateCronJob: vi.fn(),
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  fetchCronJob: vi.fn(),
  fetchCronJobs: vi.fn(),
  pauseCronJob: vi.fn(),
  runCronJobNow: vi.fn(),
  startCronJob: vi.fn(),
  fetchCronReviewQueue: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/durable")>()),
  fetchObserveRunTrace: vi.fn(),
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

const ownerGone = (id: string) =>
  new ApiRequestError(`Cron job not found: ${id}`, {
    kind: "http",
    status: 404,
    method: "GET",
    path: `/api/v1/cron/jobs/${encodeURIComponent(id)}`,
    body: { error: `Cron job not found: ${id}` },
  });

const settingsWith = (features: Record<string, boolean>) =>
  ({ features }) as unknown as Awaited<ReturnType<typeof fetchSettings>>;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  window.history.replaceState(null, "", "/work/schedules");
  resetScheduleOperationsForTests();
  __resetSessionDraftsForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchCronJobs).mockResolvedValue({ items: [job()] });
  vi.mocked(fetchCronJob).mockResolvedValue(job());
  vi.mocked(fetchCronReviewQueue).mockResolvedValue({ items: [] });
  vi.mocked(fetchSettings).mockResolvedValue(settingsWith({ cronReviewQueueV1Enabled: true }));
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
  it.each(["array", "object", "number", "boolean", "null"])(
    "does not POST non-string %s watchdog configuration",
    async (kind) => {
      await render();
      await click("New schedule");
      const form = container.querySelector<HTMLFormElement>('form[aria-label="New schedule"]')!,
        name = form.querySelector<HTMLInputElement>('input[maxlength="100"]')!,
        action = [...form.querySelectorAll<HTMLSelectElement>("select")].find((item) =>
          [...item.options].some((option) => option.value === "watchdog"),
        )!,
        config = form.querySelector<HTMLTextAreaElement>("textarea")!;
      const value =
        kind === "array"
          ? ["error"]
          : kind === "object"
            ? { severity: "error" }
            : kind === "number"
              ? 1
              : kind === "boolean"
                ? true
                : null;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(name, "Invalid config");
        name.dispatchEvent(new Event("input", { bubbles: true }));
        action.value = "watchdog";
        action.dispatchEvent(new Event("change", { bubbles: true }));
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          config,
          JSON.stringify({ watchdog: { checkId: "mcp_posture", severityThreshold: value, notifyHomeChannel: false } }),
        );
        config.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Create schedule");
      expect(createCronJob).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Watchdog configuration");
    },
  );
  it("shows an explicitly saved timezone in list, detail and review", async () => {
    vi.mocked(fetchCronJobs).mockResolvedValue({ items: [job({ schedule: "0 0 * * * America/New_York" })] });
    vi.mocked(fetchCronJob).mockResolvedValue(job({ schedule: "0 0 * * * America/New_York" }));
    await render();
    expect(container.textContent).toContain("Every day at 00:00 America/New_York");
    await click("Review schedule");
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain(
        "Runs in America/New_York",
      ),
    );
    await click("Pause");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Runs in America/New_York");
  });
  it("labels a schedule that names no timezone with the Gateway's UTC default", async () => {
    vi.mocked(fetchCronJobs).mockResolvedValue({ items: [job({ schedule: "0 9 * * *" })] });
    vi.mocked(fetchCronJob).mockResolvedValue(job({ schedule: "0 9 * * *" }));
    await render();
    expect(container.textContent).toContain("Every day at 09:00 UTC");
    await click("Review schedule");
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain(
        "Runs in UTC (the Gateway default",
      ),
    );
  });
  async function renderNavigating() {
    await act(async () =>
      root.render(
        <CockpitNavigationContext.Provider
          value={{
            navigate: (href) => {
              commitCockpitNavigation(href);
            },
            isTransitionPending: () => false,
            requestTransition: () => {},
          }}
        >
          <QueryClientProvider client={client}>
            <WorkSchedules />
          </QueryClientProvider>
        </CockpitNavigationContext.Provider>,
      ),
    );
  }
  it("retains a verified deletion receipt after its own actual URL transition and clears it on unrelated navigation", async () => {
    window.history.replaceState(null, "", "/work/schedules?jobId=job-a&shell=cockpit");
    await renderNavigating();
    await vi.waitFor(() => expect(container.textContent).toContain("Daily review"));
    await click("Delete schedule…");
    vi.mocked(deleteCronJob).mockResolvedValue({ deleted: true, jobId: "job-a" });
    vi.mocked(fetchCronJob).mockResolvedValueOnce(job()).mockRejectedValueOnce(ownerGone("job-a"));
    vi.mocked(fetchCronJobs).mockResolvedValue({ items: [] });
    await click("Delete schedule");
    await vi.waitFor(() => expect(new URLSearchParams(window.location.search).has("jobId")).toBe(false));
    expect(container.textContent).toContain("Schedule deleted.");
    expect(deleteCronJob).toHaveBeenCalledOnce();
    await act(async () => {
      commitCockpitNavigation("/work/schedules?jobId=job-b");
    });
    expect(container.textContent).not.toContain("Schedule deleted.");
  });
  it("retains the verified creation receipt across its own actual URL transition", async () => {
    const created = job({ jobId: "new-schedule-id", revision: 1, name: "Owned create" });
    vi.mocked(createCronJob).mockImplementation(async () => {
      vi.mocked(fetchCronJobs).mockResolvedValue({ items: [created] });
      return created;
    });
    vi.mocked(fetchCronJob).mockResolvedValue(created);
    await renderNavigating();
    await click("New schedule");
    const input = container.querySelector<HTMLInputElement>('form input[maxlength="100"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Owned create");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Create schedule");
    await vi.waitFor(() => expect(new URLSearchParams(window.location.search).get("jobId")).toBe("new-schedule-id"));
    expect(container.textContent).toContain("Schedule created.");
    expect(createCronJob).toHaveBeenCalledOnce();
  });
  it("follows same-mounted query navigation and history while retaining drafts and cancelling old reviews", async () => {
    const a = job(),
      b = job({ jobId: "job-b", name: "Second schedule" });
    vi.mocked(fetchCronJobs).mockResolvedValue({ items: [a, b] });
    vi.mocked(fetchCronJob).mockImplementation(async (id) => (id === "job-a" ? a : b));
    window.history.replaceState(null, "", "/work/schedules?jobId=job-a");
    await render();
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain("Daily review"),
    );
    const nameLabel = [...container.querySelectorAll("label")].find((label) => label.textContent === "Schedule name")!;
    const input = container.querySelector<HTMLInputElement>(`#${nameLabel.htmlFor}`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Preserved A draft");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Pause");
    await act(async () => {
      window.history.pushState(null, "", "/work/schedules?jobId=job-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain("Second schedule"),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(pauseCronJob).not.toHaveBeenCalled();
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain("Daily review"),
    );
    expect(
      [...container.querySelectorAll<HTMLInputElement>("input")].some((node) => node.value === "Preserved A draft"),
    ).toBe(true);
    await act(async () => {
      window.history.forward();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain("Second schedule"),
    );
    expect(pauseCronJob).not.toHaveBeenCalled();
  });
  it("keeps review cancellation mutation-free and rejects an expired review", async () => {
    await render();
    await review();
    await click("Pause");
    await click("Don't pause");
    expect(pauseCronJob).not.toHaveBeenCalled();
    expect(deleteCronJob).not.toHaveBeenCalled();
    await click("Pause");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    await click("Pause schedule");
    clock.mockRestore();
    expect(pauseCronJob).not.toHaveBeenCalled();
    expect(container.textContent).toContain("review expired");
  });
  it("creates supported advanced destination metadata and blocks malformed configuration before dispatch", async () => {
    await render();
    await click("New schedule");
    const form = container.querySelector<HTMLFormElement>('form[aria-label="New schedule"]')!;
    async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await type(form.querySelector<HTMLInputElement>('input[maxlength="100"]')!, "Advanced");
    const config = form.querySelector<HTMLTextAreaElement>("textarea")!;
    await type(config, "[]");
    await click("Create schedule");
    expect(createCronJob).not.toHaveBeenCalled();
    await type(config, '{"destination":"local"}');
    await click("Create schedule");
    expect(createCronJob).not.toHaveBeenCalled();
    expect(container.textContent).toContain("does not support action configuration");
    // Port4 cycle 4: the guided Frequency select now precedes the action select.
    const action = [...form.querySelectorAll<HTMLSelectElement>("select")].find((item) =>
      [...item.options].some((option) => option.value === "watchdog"),
    )!;
    await act(async () => {
      action.value = "watchdog";
      action.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await type(
      config,
      '{"watchdog":{"checkId":"runtime_health","severityThreshold":"warning","notifyHomeChannel":false}}',
    );
    const directoryLabel = [...form.querySelectorAll("label")].find(
      (label) => label.textContent === "Working directory",
    )!;
    await type(form.querySelector<HTMLInputElement>(`#${directoryLabel.htmlFor}`)!, "F:/disposable");
    const created = job({
      jobId: "new-schedule-id",
      revision: 1,
      name: "Advanced",
      workdir: "F:/disposable",
      action: "watchdog",
      actionConfig: { watchdog: { checkId: "runtime_health", severityThreshold: "warning", notifyHomeChannel: false } },
    });
    vi.mocked(createCronJob).mockResolvedValue(created);
    vi.mocked(fetchCronJob).mockResolvedValue(created);
    await click("Create schedule");
    expect(createCronJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Advanced",
        workdir: "F:/disposable",
        action: "watchdog",
        actionConfig: {
          watchdog: { checkId: "runtime_health", severityThreshold: "warning", notifyHomeChannel: false },
        },
      }),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Schedule created."));
  });
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
    await click("Run schedule now");
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

  it("links a requested run to its run page when the Gateway names one", async () => {
    vi.mocked(runCronJobNow).mockResolvedValueOnce({
      jobId: "job-a",
      runId: "cron-run-1",
      status: "pending",
      childDurableRunId: "run-77",
    });
    await render();
    await review();
    await click("Run now");
    await click("Run schedule now");
    await vi.waitFor(() => expect(container.textContent).toContain("Run requested."));
    const link = [...container.querySelectorAll("a")].find((item) => item.textContent === "Open run");
    expect(link?.getAttribute("href")).toContain("/work/runs/run-77");
    const reviewButton = [...container.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === "Review schedule",
    );
    expect(reviewButton?.getAttribute("aria-label")).toBe("Review schedule: Daily review");
  });

  it("retains a lost run response lock across route remounts", async () => {
    vi.mocked(runCronJobNow).mockRejectedValueOnce(new Error("response lost"));
    await render();
    await review();
    await click("Run now");
    await click("Run schedule now");
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
    await click("Pause schedule");
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
    await click("Run schedule now");
    await vi.waitFor(() => expect(container.textContent).toContain("changed during review"));
    expect(runCronJobNow).not.toHaveBeenCalled();
  });

  it("locks further actions after an unconfirmed mutation outcome", async () => {
    window.history.replaceState(
      { evidence: "schedule-record-recovery" },
      "",
      "/work/schedules?workspaceId=default&citadelId=current-citadel&runId=run-linked&sessionId=session-linked&filter=retained&shell=cockpit&shellScope=visit#schedule-evidence",
    );
    vi.mocked(runCronJobNow).mockRejectedValue(new Error("Response lost"));
    await render();
    await review();
    await click("Run now");
    await click("Run schedule now");
    await vi.waitFor(() => expect(container.textContent).toContain("action outcome is unconfirmed"));
    expect(container.querySelector<HTMLButtonElement>("button[disabled]")?.disabled).toBe(true);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("outcome is unconfirmed");
    expect(
      [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Run schedule now",
      )?.disabled,
    ).toBe(true);
    await click("Don't run now");
    const actionButtons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
      ["Run now", "Pause", "Delete schedule…"].includes(button.textContent?.trim() ?? ""),
    );
    expect(actionButtons).toHaveLength(3);
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
    const recovery = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent === "Inspect current schedule record",
    );
    expect(recovery).toBeDefined();
    const destination = new URL(recovery!.href);
    expect(destination.pathname).toBe("/work/schedules");
    expect(destination.searchParams.get("jobId")).toBe("job-a");
    expect(destination.searchParams.get("workspaceId")).toBe("default");
    expect(destination.searchParams.get("citadelId")).toBe("current-citadel");
    expect(destination.searchParams.get("runId")).toBe("run-linked");
    expect(destination.searchParams.get("sessionId")).toBe("session-linked");
    expect(destination.searchParams.get("filter")).toBe("retained");
    expect(destination.searchParams.get("shell")).toBe("cockpit");
    expect(destination.searchParams.has("shellScope")).toBe(false);
    expect(destination.hash).toBe("#schedule-evidence");
    await act(async () => root.render(null));
    window.history.replaceState(window.history.state, "", destination.pathname + destination.search + destination.hash);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkArea />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain("Daily review"),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Schedules");
    expect(fetchCronJob).toHaveBeenCalledWith("job-a", { signal: expect.any(AbortSignal) });
    expect(fetchObserveRunTrace).not.toHaveBeenCalled();
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .filter((button) => ["Run now", "Pause", "Delete schedule…"].includes(button.textContent?.trim() ?? ""))
        .every((button) => button.disabled),
    ).toBe(true);
    expect(runCronJobNow).toHaveBeenCalledTimes(1);
    expect(createCronJob).not.toHaveBeenCalled();
    expect(deleteCronJob).not.toHaveBeenCalled();
    expect(window.location.search).toBe(destination.search);
    expect(window.location.hash).toBe("#schedule-evidence");
    expect(window.history.state).toMatchObject({ evidence: "schedule-record-recovery" });
  });

  it("names schedule deletion plainly and offers Pause instead", async () => {
    vi.mocked(deleteCronJob).mockResolvedValue({ deleted: true, jobId: "job-a" } as never);
    await render();
    await review();
    await click("Delete schedule…");
    expect(container.textContent).toContain("Delete “Daily review”? Future runs stop and it can't be restored.");
    await click("Pause instead");
    expect(container.textContent).toContain("Pause this schedule?");
    expect(deleteCronJob).not.toHaveBeenCalled();
    await click("Don't pause");
    await click("Delete schedule…");
    // Deletion is confirmed only by the owner's exact not-found answer on the follow-up read.
    vi.mocked(fetchCronJob).mockResolvedValueOnce(job()).mockRejectedValueOnce(ownerGone("job-a"));
    await click("Delete schedule");
    await vi.waitFor(() => expect(container.textContent).toContain("Schedule deleted."));
    expect(deleteCronJob).toHaveBeenCalledOnce();
  });

  it("does not offer Pause instead when the schedule is already paused", async () => {
    vi.mocked(fetchCronJobs).mockResolvedValue({ items: [job({ enabled: false })] });
    vi.mocked(fetchCronJob).mockResolvedValue(job({ enabled: false }));
    await render();
    await review();
    await click("Delete schedule…");
    expect(container.textContent).toContain("Delete “Daily review”?");
    const labels = [...container.querySelectorAll("button")].map((item) => item.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(["Delete schedule", "Keep schedule"]));
    expect(labels).not.toContain("Pause instead");
    expect(deleteCronJob).not.toHaveBeenCalled();
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
  it("inspects the native schedule list after an uncertain create without selecting an unrelated job or unlocking retry", async () => {
    window.history.replaceState(
      { evidence: "schedule-create-recovery" },
      "",
      "/work/schedules?workspaceId=default&citadelId=current-citadel&jobId=job-a&runId=run-linked&sessionId=session-linked&filter=retained&shell=cockpit&shellScope=visit#schedule-evidence",
    );
    vi.mocked(createCronJob).mockRejectedValue(new Error("Response lost"));
    await render();
    await click("New schedule");
    const input = container.querySelector<HTMLInputElement>('form input[maxlength="100"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Unconfirmed schedule");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Create schedule");
    await vi.waitFor(() => expect(container.textContent).toContain("create outcome is unconfirmed"));
    expect(createCronJob).toHaveBeenCalledTimes(1);
    expect(input.disabled).toBe(true);
    const recovery = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.textContent === "Inspect current schedules",
    );
    expect(recovery).toBeDefined();
    const destination = new URL(recovery!.href);
    expect(destination.pathname).toBe("/work/schedules");
    expect(destination.searchParams.has("jobId")).toBe(false);
    expect(destination.searchParams.get("workspaceId")).toBe("default");
    expect(destination.searchParams.get("citadelId")).toBe("current-citadel");
    expect(destination.searchParams.get("runId")).toBe("run-linked");
    expect(destination.searchParams.get("sessionId")).toBe("session-linked");
    expect(destination.searchParams.get("filter")).toBe("retained");
    expect(destination.searchParams.get("shell")).toBe("cockpit");
    expect(destination.searchParams.has("shellScope")).toBe(false);
    expect(destination.hash).toBe("#schedule-evidence");
    const reads = vi.mocked(fetchCronJob).mock.calls.length;
    await act(async () => root.render(null));
    window.history.replaceState(window.history.state, "", destination.pathname + destination.search + destination.hash);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <WorkArea />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Daily review"));
    expect(container.querySelector("h1")?.textContent).toBe("Schedules");
    const recoveryDetail = container.querySelector('[aria-label="Schedule detail"]');
    expect(recoveryDetail?.querySelector("h2")?.textContent).toBe("Select a schedule");
    expect(recoveryDetail?.querySelectorAll("button")).toHaveLength(0);
    expect(fetchCronJob).toHaveBeenCalledTimes(reads);
    expect(fetchObserveRunTrace).not.toHaveBeenCalled();
    await click("New schedule");
    const retained = container.querySelector<HTMLInputElement>('form input[maxlength="100"]')!;
    expect(retained.value).toBe("Unconfirmed schedule");
    expect(retained.disabled).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Create schedule",
      )?.disabled,
    ).toBe(true);
    expect(createCronJob).toHaveBeenCalledTimes(1);
    expect(runCronJobNow).not.toHaveBeenCalled();
    expect(pauseCronJob).not.toHaveBeenCalled();
    expect(startCronJob).not.toHaveBeenCalled();
    expect(deleteCronJob).not.toHaveBeenCalled();
    expect(window.location.search).toBe(destination.search);
    expect(window.location.hash).toBe("#schedule-evidence");
    expect(window.history.state).toMatchObject({ evidence: "schedule-create-recovery" });
  });
  it("keeps unsent input across unmount and discards without a Gateway request", async () => {
    await render();
    await click("New schedule");
    const form = container.querySelector<HTMLFormElement>('form[aria-label="New schedule"]')!;
    const input = form.querySelector<HTMLInputElement>('input[maxlength="100"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Retained schedule");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => root.render(null));
    await render();
    await click("New schedule");
    expect(container.querySelector<HTMLInputElement>('input[maxlength="100"]')!.value).toBe("Retained schedule");
    await act(async () => discardSessionDraft(scheduleCreateDraftKey(getGatewayApiBaseUrl())));
    expect(container.querySelector<HTMLInputElement>('input[maxlength="100"]')!.value).toBe("");
    expect(createCronJob).not.toHaveBeenCalled();
    expect(runCronJobNow).not.toHaveBeenCalled();
  });
});

describe("scheduler review and run evidence", () => {
  it("lists scheduler review items read-only, without offering a retry", async () => {
    vi.mocked(fetchCronReviewQueue).mockResolvedValue({
      items: [
        {
          itemId: "r-1",
          jobId: "job-a",
          runId: "run-12345678",
          severity: "high",
          status: "open",
          summary: { trigger: "scheduled", warning: "Child run failed" },
          createdAt: "2026-10-07T09:00:00.000Z",
          updatedAt: "2026-10-07T09:05:00.000Z",
        },
      ],
    });
    await render();
    const queue = await vi.waitFor(() => {
      const region = container.querySelector<HTMLElement>('[aria-label="Scheduler review"]');
      expect(region?.textContent).toContain("Child run failed");
      return region!;
    });
    // The schedule list names the job; ids stay in technical details.
    expect(queue.textContent).toContain("Daily review · Scheduled");
    expect(queue.textContent).toContain("High severity");
    expect(queue.textContent).not.toContain("job-a");
    expect(queue.textContent).not.toContain("run-12345678");
    expect(queue.textContent).toContain("Retrying is not offered here");
    expect([...queue.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Retry");
    expect(fetchCronReviewQueue).toHaveBeenCalledWith(200);
  });

  it("states an empty or unavailable review queue truthfully", async () => {
    vi.mocked(fetchCronReviewQueue).mockRejectedValue(new Error("Review queue unavailable"));
    await render();
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Scheduler review"]')?.textContent).toContain(
        "Review queue unavailable",
      ),
    );
    expect(container.textContent).not.toContain("No scheduler review items");
  });

  it("does not request the review queue when the Gateway reports the feature flag off", async () => {
    vi.mocked(fetchSettings).mockResolvedValue(settingsWith({ cronReviewQueueV1Enabled: false }));
    await render();
    const region = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>('[aria-label="Scheduler review"]');
      expect(found?.textContent).toContain("Scheduler review is switched off in runtime settings");
      return found!;
    });
    expect(fetchCronReviewQueue).not.toHaveBeenCalled();
    expect(region.textContent).not.toContain("No scheduler review items");
    expect(region.querySelector("button")).toBeNull();
  });

  it("drops loaded review items once a settings refresh reports the flag off", async () => {
    vi.mocked(fetchCronReviewQueue).mockResolvedValue({
      items: [
        {
          itemId: "r-1",
          jobId: "job-a",
          runId: "run-12345678",
          severity: "high",
          status: "open",
          summary: { trigger: "scheduled", warning: "Child run failed" },
          createdAt: "2026-10-07T09:00:00.000Z",
          updatedAt: "2026-10-07T09:05:00.000Z",
        },
      ],
    });
    await render();
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Scheduler review"]')?.textContent).toContain("Child run failed"),
    );
    vi.mocked(fetchSettings).mockResolvedValue(settingsWith({ cronReviewQueueV1Enabled: false }));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["work", "schedules-settings"] });
    });
    const region = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>('[aria-label="Scheduler review"]');
      expect(found?.textContent).toContain("Scheduler review is switched off in runtime settings");
      return found!;
    });
    expect(region.textContent).not.toContain("Child run failed");
    expect(region.textContent).not.toContain("No scheduler review items");
    expect(fetchCronReviewQueue).toHaveBeenCalledTimes(1);
  });

  it("revalidates the flag on Refresh and skips the queue request when it has been switched off", async () => {
    await render();
    const region = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>('[aria-label="Scheduler review"]');
      expect(found?.textContent).toContain("No scheduler review items");
      return found!;
    });
    expect(fetchCronReviewQueue).toHaveBeenCalledTimes(1);
    vi.mocked(fetchSettings).mockResolvedValue(settingsWith({ cronReviewQueueV1Enabled: false }));
    const refresh = [...region.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Refresh");
    if (!refresh) throw new Error("Missing scheduler review Refresh button");
    await act(async () => refresh.click());
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Scheduler review"]')?.textContent).toContain(
        "Scheduler review is switched off in runtime settings",
      ),
    );
    expect(fetchSettings).toHaveBeenCalledTimes(2);
    expect(fetchCronReviewQueue).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Scheduler review"]')?.textContent).not.toContain(
      "No scheduler review items",
    );
  });

  it("reports unknown review availability, without requesting the queue, when settings cannot be read", async () => {
    vi.mocked(fetchSettings).mockRejectedValue(new Error("Settings unreachable"));
    await render();
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Scheduler review"]')?.textContent).toContain(
        "Scheduler review availability is unknown",
      ),
    );
    expect(container.querySelector('[aria-label="Scheduler review"]')?.textContent).toContain("Settings unreachable");
    expect(fetchCronReviewQueue).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("No scheduler review items");
  });

  it("says the review queue is unavailable, not empty, when the Gateway refuses it", async () => {
    vi.mocked(fetchCronReviewQueue).mockRejectedValue(
      new ApiRequestError("Feature disabled", {
        kind: "http",
        status: 409,
        method: "GET",
        path: "/api/v1/cron/review-queue",
      }),
    );
    await render();
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Scheduler review"]')?.textContent).toContain(
        "Scheduler review is unavailable on this Gateway",
      ),
    );
    expect(container.textContent).not.toContain("No scheduler review items");
  });

  it("notes the last run's signed evidence in schedule detail and keeps its id out of the primary text", async () => {
    vi.mocked(fetchCronJob).mockResolvedValue(job({ lastRunEvidenceEnvelopeId: "env-abcdef123456" }));
    await render();
    await click("Review schedule");
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain(
        "Signed evidence recorded",
      ),
    );
    expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).not.toContain("env-abcdef123456");
    expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain("Last run evidence");
  });
});

describe("Work schedules on stacked widths", () => {
  afterEach(() => vi.unstubAllGlobals());
  const viewport = (stacked: boolean) =>
    vi.stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: stacked && media.includes("width <"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

  it("marks the reviewed schedule and moves focus to its detail heading below the two-column width", async () => {
    viewport(true);
    const original = Element.prototype.scrollIntoView;
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original;
    });
    await render();
    const item = () => container.querySelector("li")!;
    expect(item().hasAttribute("aria-current")).toBe(false);
    await review();
    expect(item().getAttribute("aria-current")).toBe("true");
    expect(item().textContent).toContain("Shown in detail");
    const heading = container.querySelector('[aria-label="Schedule detail"] h2')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.textContent).toBe("Daily review");
    expect(scroll).toHaveBeenCalled();
  });

  it("keeps focus on the list when the detail sits beside it", async () => {
    viewport(false);
    await render();
    await review();
    expect(container.querySelector("li")?.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).not.toBe(container.querySelector('[aria-label="Schedule detail"] h2'));
  });
});
