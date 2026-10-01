// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import {
  createCronJob,
  deleteCronJob,
  fetchCronJob,
  fetchCronJobs,
  pauseCronJob,
  runCronJobNow,
} from "@goatcitadel/mission-control-shared/api/cron";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import { resetScheduleOperationsForTests, useScheduleOperations } from "./use-schedule-operations";
import type { ScheduleReceipt } from "./schedule-operation";

vi.mock("@goatcitadel/mission-control-shared/api/cron", () => ({
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  fetchCronJob: vi.fn(),
  fetchCronJobs: vi.fn(),
  pauseCronJob: vi.fn(),
  runCronJobNow: vi.fn(),
  startCronJob: vi.fn(),
}));
const job = (patch: Partial<CronJobRecordResponse> = {}): CronJobRecordResponse => ({
  jobId: "schedule-owned",
  revision: 3,
  name: "Review",
  schedule: "0 9 * * *",
  action: "task",
  enabled: true,
  ...patch,
});
const input = {
  jobId: "created-owned",
  name: "Created",
  schedule: "0 10 * * *",
  action: "task" as const,
  enabled: true,
};
const deleted = (message = "Cron job not found: schedule-owned", path = "/api/v1/cron/jobs/schedule-owned") =>
  new ApiRequestError(message, { kind: "http", status: 404, method: "GET", path, body: { error: message } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let control: ReturnType<typeof useScheduleOperations>;
let renderer: ReactTestRenderer | undefined;
function Host({ identity = "workspace-a:view-a" }: { identity?: string }) {
  control = useScheduleOperations(identity);
  return null;
}
async function mount(identity?: string) {
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Host identity={identity} />
      </StrictMode>,
    );
  });
}
async function update(identity: string) {
  await act(async () => {
    renderer!.update(
      <StrictMode>
        <Host identity={identity} />
      </StrictMode>,
    );
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  resetScheduleOperationsForTests();
  vi.mocked(fetchCronJob).mockResolvedValue(job());
  vi.mocked(fetchCronJobs).mockResolvedValue({ items: [job()] });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  resetScheduleOperationsForTests();
});

describe("shared schedule operation admission", () => {
  it("cancels a preflight after unmount without writing", async () => {
    const read = deferred<CronJobRecordResponse>();
    vi.mocked(fetchCronJob).mockReturnValue(read.promise);
    await mount();
    let pending!: Promise<ScheduleReceipt | undefined>;
    act(() => {
      pending = control.execute({ kind: "run", job: job() });
    });
    act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => {
      read.resolve(job());
      await pending;
    });
    expect(runCronJobNow).not.toHaveBeenCalled();
    await mount();
    expect(control.locked(job().jobId)).toBe(false);
  });
  it("cancels selection away-and-back and rejects the captured old callback", async () => {
    const read = deferred<CronJobRecordResponse>();
    vi.mocked(fetchCronJob).mockReturnValue(read.promise);
    await mount();
    const old = control.execute;
    let pending!: Promise<ScheduleReceipt | undefined>;
    act(() => {
      pending = old({ kind: "run", job: job() });
    });
    await update("workspace-b:view-b");
    await update("workspace-a:view-a");
    await act(async () => {
      read.resolve(job());
      await pending;
    });
    await act(async () => {
      await old({ kind: "run", job: job() });
    });
    expect(runCronJobNow).not.toHaveBeenCalled();
    expect(fetchCronJob).toHaveBeenCalledTimes(1);
  });
  it("cancels creation if the editor changes during the initial directory read", async () => {
    const read = deferred<{ items: CronJobRecordResponse[] }>();
    vi.mocked(fetchCronJobs).mockReturnValue(read.promise);
    await mount();
    let pending!: Promise<ScheduleReceipt | undefined>;
    act(() => {
      pending = control.execute({ kind: "create", input });
    });
    act(() => control.invalidate());
    await act(async () => {
      read.resolve({ items: [] });
      await pending;
    });
    expect(createCronJob).not.toHaveBeenCalled();
  });
  it("retains an unknown run after remount and another workspace", async () => {
    vi.mocked(runCronJobNow).mockRejectedValue(new Error("response lost"));
    await mount();
    await act(async () => {
      await control.execute({ kind: "run", job: job() });
    });
    act(() => renderer!.unmount());
    renderer = undefined;
    await mount("classic:workspace-b");
    expect(control.attempt(job().jobId)?.phase).toBe("uncertain");
    await act(async () => {
      await control.execute({ kind: "cancel", job: job() });
    });
    expect(runCronJobNow).toHaveBeenCalledTimes(1);
    expect(deleteCronJob).not.toHaveBeenCalled();
  });
  it("retains unknown creation admission and the known requested job ID across shells", async () => {
    vi.mocked(createCronJob).mockRejectedValue(new Error("response lost"));
    await mount();
    await act(async () => {
      await control.execute({ kind: "create", input });
    });
    act(() => renderer!.unmount());
    renderer = undefined;
    await mount("classic:workspace-b");
    expect(control.locked()).toBe(true);
    expect(control.locked(input.jobId)).toBe(true);
    await act(async () => {
      await control.execute({ kind: "create", input: { ...input, jobId: "different-id" } });
    });
    expect(createCronJob).toHaveBeenCalledTimes(1);
  });
  it("holds admission synchronously against a double click", async () => {
    const read = deferred<CronJobRecordResponse>();
    vi.mocked(fetchCronJob).mockReturnValue(read.promise);
    await mount();
    let pending!: Promise<ScheduleReceipt | undefined>;
    act(() => {
      pending = control.execute({ kind: "run", job: job() });
      void control.execute({ kind: "run", job: job() });
    });
    expect(fetchCronJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      read.resolve(job({ revision: 4 }));
      await pending;
    });
    expect(runCronJobNow).not.toHaveBeenCalled();
  });
  it("requires exact current configuration before dispatch and releases a stale preflight", async () => {
    vi.mocked(fetchCronJob).mockResolvedValue(job({ actionConfig: { prompt: "changed" } }));
    await mount();
    await act(async () => {
      await control.execute({ kind: "pause", job: job() });
    });
    expect(pauseCronJob).not.toHaveBeenCalled();
    expect(control.message).toContain("changed during review");
    expect(control.locked(job().jobId)).toBe(false);
  });
  it("preserves numeric CAS and independently confirms paused configuration", async () => {
    const saved = job({ revision: 4, enabled: false });
    vi.mocked(pauseCronJob).mockResolvedValue(saved);
    vi.mocked(fetchCronJob).mockResolvedValueOnce(job()).mockResolvedValue(saved);
    await mount();
    let result: ScheduleReceipt | undefined;
    await act(async () => {
      result = await control.execute({ kind: "pause", job: job() });
    });
    expect(pauseCronJob).toHaveBeenCalledWith(job().jobId, 3);
    expect(result).toEqual({ kind: "pause", job: saved });
    const signals = vi.mocked(fetchCronJob).mock.calls.map((call) => call[1]?.signal);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(signals[0]).not.toBe(signals[1]);
  });
  it.each(["wrong receipt", "wrong readback"])("locks after %s for a configuration change", async (mode) => {
    const saved = job({ revision: 4, enabled: false });
    vi.mocked(pauseCronJob).mockResolvedValue(mode === "wrong receipt" ? { ...saved, jobId: "foreign" } : saved);
    vi.mocked(fetchCronJob)
      .mockResolvedValueOnce(job())
      .mockResolvedValue(job({ revision: 5 }));
    await mount();
    await act(async () => {
      await control.execute({ kind: "pause", job: job() });
    });
    expect(control.attempt(job().jobId)?.phase).toBe("uncertain");
  });
  it("confirms creation without turning an origin callback failure into uncertainty", async () => {
    const saved = job({ ...input, revision: 1 });
    vi.mocked(createCronJob).mockResolvedValue(saved);
    vi.mocked(fetchCronJob).mockResolvedValue(saved);
    await mount();
    let result: ScheduleReceipt | undefined;
    await act(async () => {
      result = await control.execute({ kind: "create", input }, () => {
        throw new Error("display callback");
      });
    });
    expect(result).toEqual({ kind: "create", job: saved });
    expect(control.locked()).toBe(false);
  });
  it("acknowledges the origin after late confirmed creation without publishing into a new view", async () => {
    const response = deferred<CronJobRecordResponse>();
    const saved = job({ ...input, revision: 1 });
    vi.mocked(createCronJob).mockReturnValue(response.promise);
    vi.mocked(fetchCronJob).mockResolvedValue(saved);
    const recorded = vi.fn();
    await mount();
    let pending!: Promise<ScheduleReceipt | undefined>;
    await act(async () => {
      pending = control.execute({ kind: "create", input }, recorded);
    });
    await update("workspace-b:view-b");
    let result: ScheduleReceipt | undefined;
    await act(async () => {
      response.resolve(saved);
      result = await pending;
    });
    expect(result).toBeUndefined();
    expect(recorded).toHaveBeenCalledWith({ kind: "create", job: saved });
    expect(control.locked()).toBe(false);
    expect(control.message).toBeUndefined();
  });
  it("requires exact run receipt identity and completed-run owner linkage", async () => {
    vi.mocked(runCronJobNow).mockResolvedValue({ jobId: job().jobId, runId: "run-a", status: "ok" });
    vi.mocked(fetchCronJob)
      .mockResolvedValueOnce(job())
      .mockResolvedValue(job({ lastRunId: "different-run" }));
    await mount();
    await act(async () => {
      await control.execute({ kind: "run", job: job() });
    });
    expect(control.attempt(job().jobId)?.phase).toBe("uncertain");
  });
  it("returns a pending run acknowledgement without inventing completion", async () => {
    const run = { jobId: job().jobId, runId: "run-a", status: "pending" as const };
    vi.mocked(runCronJobNow).mockResolvedValue(run);
    await mount();
    let result: ScheduleReceipt | undefined;
    await act(async () => {
      result = await control.execute({ kind: "run", job: job() });
    });
    expect(result).toEqual({ kind: "run", run });
  });
  it("confirms deletion only from the exact owner not-found response", async () => {
    vi.mocked(deleteCronJob).mockResolvedValue({ deleted: true, jobId: job().jobId });
    vi.mocked(fetchCronJob).mockResolvedValueOnce(job()).mockRejectedValueOnce(deleted());
    await mount();
    let result: ScheduleReceipt | undefined;
    await act(async () => {
      result = await control.execute({ kind: "cancel", job: job() });
    });
    expect(result).toEqual({ kind: "cancel", jobId: job().jobId });
    expect(deleteCronJob).toHaveBeenCalledWith(job().jobId, 3);
  });
  it.each([deleted("database unavailable"), deleted(undefined, "/api/v1/cron/jobs/other")])(
    "does not mistake a blanket/foreign 404 for deletion",
    async (error) => {
      vi.mocked(deleteCronJob).mockResolvedValue({ deleted: true, jobId: job().jobId });
      vi.mocked(fetchCronJob).mockResolvedValueOnce(job()).mockRejectedValueOnce(error);
      await mount();
      await act(async () => {
        await control.execute({ kind: "cancel", job: job() });
      });
      expect(control.attempt(job().jobId)?.phase).toBe("uncertain");
    },
  );
});
