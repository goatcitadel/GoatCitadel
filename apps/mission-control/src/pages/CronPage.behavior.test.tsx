import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  fetchCronJob: vi.fn(),
  fetchCronJobs: vi.fn(),
  fetchCronReviewQueue: vi.fn(),
  fetchCronRunDiff: vi.fn(),
  fetchSettings: vi.fn(),
  pauseCronJob: vi.fn(),
  retryCronReviewQueueItem: vi.fn(),
  runCronJobNow: vi.fn(),
  startCronJob: vi.fn(),
  updateCronJob: vi.fn(),
}));

const refreshMocks = vi.hoisted(() => ({
  callback: undefined as undefined | (() => Promise<void> | void),
  onFallbackStateChange: undefined as undefined | ((fallback: boolean) => void),
}));

vi.mock("../api/client", () => ({
  createCronJob: apiMocks.createCronJob,
  deleteCronJob: apiMocks.deleteCronJob,
  fetchCronJob: apiMocks.fetchCronJob,
  fetchCronJobs: apiMocks.fetchCronJobs,
  fetchCronReviewQueue: apiMocks.fetchCronReviewQueue,
  fetchCronRunDiff: apiMocks.fetchCronRunDiff,
  fetchSettings: apiMocks.fetchSettings,
  pauseCronJob: apiMocks.pauseCronJob,
  retryCronReviewQueueItem: apiMocks.retryCronReviewQueueItem,
  runCronJobNow: apiMocks.runCronJobNow,
  startCronJob: apiMocks.startCronJob,
  updateCronJob: apiMocks.updateCronJob,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: vi.fn(
    (
      _channel: string,
      callback: () => Promise<void> | void,
      options?: { onFallbackStateChange?: (fallback: boolean) => void },
    ) => {
      refreshMocks.callback = callback;
      refreshMocks.onFallbackStateChange = options?.onFallbackStateChange;
    },
  ),
}));

import { CronPage } from "./CronPage";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return ((node as { children?: unknown[] }).children ?? []).map((child) => instanceText(child)).join(" ");
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

function findButton(renderer: ReactTestRenderer, label: string, occurrence = 0) {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).replace(/\s+/g, " ").includes(label),
  )[occurrence];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function findInputById(renderer: ReactTestRenderer, id: string) {
  return renderer.root.find((node) => typeof node.type === "string" && node.props.id === id);
}

async function changeInput(renderer: ReactTestRenderer, id: string, value: string): Promise<void> {
  const input = findInputById(renderer, id);
  await act(async () => {
    input.props.onChange({ target: { value } });
  });
}

function findInputByType(renderer: ReactTestRenderer, type: string, occurrence = 0) {
  const input = renderer.root.findAll((node) => typeof node.type === "string" && node.props.type === type)[occurrence];
  if (!input) {
    throw new Error(`Input not found: ${type}`);
  }
  return input;
}

function findInputByPlaceholder(renderer: ReactTestRenderer, placeholder: string) {
  return renderer.root.find((node) => typeof node.type === "string" && node.props.placeholder === placeholder);
}

async function clickButton(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  const button = findButton(renderer, label, occurrence);
  await act(async () => {
    button.props.onClick();
  });
}

const now = "2026-05-14T12:00:00.000Z";

const cronJob = {
  jobId: "daily-review",
  name: "Daily Review",
  action: "task" as const,
  description: "Review system health.",
  schedule: "0 2 * * * UTC",
  enabled: true,
  lastRunAt: "2026-05-14T02:00:00.000Z",
  nextRunAt: "2026-05-15T02:00:00.000Z",
  updatedAt: now,
};

describe("CronPage behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMocks.callback = undefined;
    refreshMocks.onFallbackStateChange = undefined;
    vi.stubGlobal("window", {
      confirm: vi.fn(() => true),
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    apiMocks.fetchSettings.mockResolvedValue({
      features: {
        cronReviewQueueV1Enabled: true,
      },
    });
    apiMocks.fetchCronJobs.mockResolvedValue({
      items: [cronJob],
    });
    apiMocks.fetchCronJob.mockResolvedValue(cronJob);
    apiMocks.fetchCronReviewQueue.mockResolvedValue({
      items: [
        {
          itemId: "queue-1",
          jobId: "daily-review",
          runId: "run-review-1",
          severity: "high",
          status: "open",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    apiMocks.createCronJob.mockResolvedValue({ ...cronJob, jobId: "weekly-release-checklist" });
    apiMocks.updateCronJob.mockResolvedValue(cronJob);
    apiMocks.pauseCronJob.mockResolvedValue({ ...cronJob, enabled: false });
    apiMocks.startCronJob.mockResolvedValue(cronJob);
    apiMocks.runCronJobNow.mockResolvedValue({ runId: "run-manual-1" });
    apiMocks.deleteCronJob.mockResolvedValue({ ok: true });
    apiMocks.retryCronReviewQueueItem.mockResolvedValue({ itemId: "queue-1" });
    apiMocks.fetchCronRunDiff.mockResolvedValue({
      runId: "run-review-1",
      diff: { status: { before: "open", after: "retrying" } },
    });
  });

  it("creates a task job, controls an existing job, and opens review queue diffs", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<CronPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Daily Review");
      expect(rendererText(renderer)).toContain("1 review items");

      await changeInput(renderer, "cronJobName", "Weekly Release Checklist");
      await changeInput(renderer, "cronJobDescription", "Review deployments and incident queue.");
      expect(findInputById(renderer, "cronJobId").props.value).toBe("weekly-release-checklist");

      await clickButton(renderer, "Create Job");
      await flush();

      expect(apiMocks.createCronJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "weekly-release-checklist",
          name: "Weekly Release Checklist",
          action: "task",
          description: "Review deployments and incident queue.",
          schedule: expect.any(String),
          enabled: true,
        }),
      );
      expect(rendererText(renderer)).toContain("Created weekly-release-checklist");

      await clickButton(renderer, "Edit");
      await flush();
      await changeInput(renderer, "cronJobDescription", "Updated operator notes.");
      await clickButton(renderer, "Save Changes");
      await flush();

      expect(apiMocks.updateCronJob).toHaveBeenCalledWith(
        "daily-review",
        expect.objectContaining({
          description: "Updated operator notes.",
          enabled: true,
        }),
      );

      await clickButton(renderer, "Pause");
      await flush();
      expect(apiMocks.pauseCronJob).toHaveBeenCalledWith("daily-review");

      await clickButton(renderer, "Run");
      await flush();
      expect(apiMocks.runCronJobNow).toHaveBeenCalledWith("daily-review");

      await clickButton(renderer, "Diff");
      await flush();
      expect(apiMocks.fetchCronRunDiff).toHaveBeenCalledWith("run-review-1");
      expect(rendererText(renderer)).toContain("Run diff: run-review-1");

      await clickButton(renderer, "Retry");
      await flush();
      expect(apiMocks.retryCronReviewQueueItem).toHaveBeenCalledWith("queue-1");

      await clickButton(renderer, "Delete");
      await flush();
      expect(window.confirm).toHaveBeenCalledWith("Delete cron job daily-review?");
      expect(apiMocks.deleteCronJob).toHaveBeenCalledWith("daily-review");
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("validates required task fields and weekly schedule day selection", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<CronPage />);
      });
      await flush();

      await clickButton(renderer, "Create Job");
      await flush();
      expect(rendererText(renderer)).toContain("Job name is required.");

      await changeInput(renderer, "cronJobName", "Weekly Review");
      await clickButton(renderer, "Create Job");
      await flush();
      expect(rendererText(renderer)).toContain("Add what this scheduled job should do.");

      await changeInput(renderer, "cronJobDescription", "Review the weekly state.");
      const frequencySelect = findInputById(renderer, "cronFrequency");
      await act(async () => {
        frequencySelect.props.onChange({ target: { value: "weekly" } });
      });
      const checkedDay = renderer.root.findAll(
        (node) => node.type === "input" && node.props.type === "checkbox" && node.props.checked === true,
      )[0];
      await act(async () => {
        checkedDay?.props.onChange();
      });
      await clickButton(renderer, "Create Job");
      await flush();

      expect(rendererText(renderer)).toContain("Pick at least one day for a weekly schedule.");
      expect(apiMocks.createCronJob).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("handles disabled review queues, detail errors, start action, and cancelled deletes", async () => {
    const disabledJob = {
      ...cronJob,
      jobId: "paused-review",
      name: "Paused Review",
      enabled: false,
      schedule: "10 */4 * * * UTC",
    };
    apiMocks.fetchSettings.mockResolvedValue({
      features: {
        cronReviewQueueV1Enabled: false,
      },
    });
    apiMocks.fetchCronJobs.mockResolvedValue({ items: [disabledJob] });
    apiMocks.fetchCronJob.mockRejectedValueOnce(new Error("detail failed"));
    vi.mocked(window.confirm).mockReturnValueOnce(false);

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<CronPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Review queue off");
      expect(text).toContain("Review queue is disabled right now");
      expect(text).toContain("detail failed");
      expect(apiMocks.fetchCronReviewQueue).not.toHaveBeenCalled();

      await clickButton(renderer, "Start");
      await flush();
      expect(apiMocks.startCronJob).toHaveBeenCalledWith("paused-review");

      await clickButton(renderer, "Delete");
      await flush();
      expect(window.confirm).toHaveBeenCalledWith("Delete cron job paused-review?");
      expect(apiMocks.deleteCronJob).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("surfaces review queue refresh errors and fallback polling state", async () => {
    apiMocks.fetchCronReviewQueue.mockRejectedValueOnce(new Error("review queue failed"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<CronPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("review queue failed");

      await act(async () => {
        refreshMocks.onFallbackStateChange?.(true);
      });
      expect(rendererText(renderer)).toContain("Live updates degraded, checking periodically.");

      apiMocks.fetchCronReviewQueue.mockResolvedValueOnce({ items: [] });
      await act(async () => {
        await refreshMocks.callback?.();
      });
      await flush();

      expect(rendererText(renderer)).toContain("No review items recorded yet.");
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("covers schedule controls for custom IDs, hourly timing, dates, and time-zone validation", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<CronPage />);
      });
      await flush();

      await changeInput(renderer, "cronJobId", "custom-id");
      await changeInput(renderer, "cronJobName", "Name Should Not Replace Custom ID");
      expect(findInputById(renderer, "cronJobId").props.value).toBe("custom-id");

      const frequencySelect = findInputById(renderer, "cronFrequency");
      await act(async () => {
        frequencySelect.props.onChange({ target: { value: "hourly" } });
      });
      const intervalSelect = renderer.root.findAll((node) => node.type === "select")[1];
      await act(async () => {
        intervalSelect?.props.onChange({ target: { value: "12" } });
      });
      const minuteInput = findInputByType(renderer, "number");
      await act(async () => {
        minuteInput.props.onChange({ target: { value: "70" } });
      });
      expect(rendererText(renderer)).toContain("Generated schedule:");
      expect(rendererText(renderer)).toContain("59 */12 * * *");

      await act(async () => {
        frequencySelect.props.onChange({ target: { value: "daily" } });
      });
      const timeInput = findInputByType(renderer, "time");
      await act(async () => {
        timeInput.props.onChange({ target: { value: "not-a-time" } });
      });
      await act(async () => {
        timeInput.props.onChange({ target: { value: "09:45" } });
      });
      const dateInput = findInputByType(renderer, "date");
      await act(async () => {
        dateInput.props.onChange({ target: { value: "2026-05-20" } });
      });
      const timeZoneInput = findInputByPlaceholder(renderer, "America/Los_Angeles");
      await act(async () => {
        timeZoneInput.props.onChange({ target: { value: "" } });
      });
      await changeInput(renderer, "cronJobDescription", "Run the custom schedule.");
      await clickButton(renderer, "Create Job");
      await flush();
      expect(rendererText(renderer)).toContain("Time zone is required.");

      await act(async () => {
        timeZoneInput.props.onChange({ target: { value: "UTC" } });
      });
      await clickButton(renderer, "Create Job");
      await flush();
      expect(apiMocks.createCronJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "custom-id",
          schedule: "45 9 * * * UTC",
          endAt: expect.any(String),
        }),
      );
    } finally {
      renderer.unmount();
      vi.unstubAllGlobals();
    }
  });
});
