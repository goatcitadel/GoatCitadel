import { beforeEach, expect, it, vi } from "vitest";
import { performScheduleOperation } from "./schedule-operation";
import { fetchCronJob, updateCronJob } from "@goatcitadel/mission-control-shared/api/cron";
vi.mock("@goatcitadel/mission-control-shared/api/cron", () => ({ fetchCronJob: vi.fn(), updateCronJob: vi.fn(), fetchCronJobs: vi.fn(), createCronJob: vi.fn(), deleteCronJob: vi.fn(), pauseCronJob: vi.fn(), runCronJobNow: vi.fn(), startCronJob: vi.fn() }));
const job = { jobId: "daily", revision: 2, name: "Daily", action: "task" as const, enabled: true, schedule: "0 9 * * *" };
beforeEach(() => vi.resetAllMocks());
it("recognizes the Gateway's normalized cleared description as a confirmed save", async () => {
  const before = { ...job, description: "Remove this" }, saved = { ...job, revision: 3 };
  vi.mocked(fetchCronJob).mockResolvedValueOnce(before).mockResolvedValueOnce(saved); vi.mocked(updateCronJob).mockResolvedValue(saved);
  expect(await performScheduleOperation({ kind: "edit", job: before, input: { description: "" } }, () => true, vi.fn())).toEqual({ kind: "edit", job: saved });
});
it("saves reviewed timing with the current revision and independently reads the receipt", async () => {
  const saved = { ...job, revision: 3, schedule: "0 10 * * *" };
  vi.mocked(fetchCronJob).mockResolvedValueOnce(job).mockResolvedValueOnce(saved);
  vi.mocked(updateCronJob).mockResolvedValue(saved);
  const dispatched = vi.fn();
  expect(await performScheduleOperation({ kind: "edit", job, input: { schedule: saved.schedule } }, () => true, dispatched)).toEqual({ kind: "edit", job: saved });
  expect(updateCronJob).toHaveBeenCalledWith("daily", { expectedRevision: 2, schedule: saved.schedule });
  expect(dispatched).toHaveBeenCalledOnce();
});
it("preserves the draft without a write when the reviewed revision or scope is stale", async () => {
  vi.mocked(fetchCronJob).mockResolvedValue({ ...job, revision: 3 });
  await expect(performScheduleOperation({ kind: "edit", job, input: { name: "Draft" } }, () => true, vi.fn())).rejects.toThrow("changed during review");
  vi.mocked(fetchCronJob).mockResolvedValue(job);
  expect(await performScheduleOperation({ kind: "edit", job, input: { name: "Draft" } }, () => false, vi.fn())).toBeUndefined();
  expect(updateCronJob).not.toHaveBeenCalled();
});
it("rejects a mismatched save receipt instead of claiming persistence", async () => {
  vi.mocked(fetchCronJob).mockResolvedValue(job);
  vi.mocked(updateCronJob).mockResolvedValue({ ...job, revision: 3 });
  await expect(performScheduleOperation({ kind: "edit", job, input: { name: "Draft" } }, () => true, vi.fn())).rejects.toThrow("receipt");
});
