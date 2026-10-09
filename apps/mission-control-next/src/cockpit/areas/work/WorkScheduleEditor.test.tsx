// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkScheduleEditor } from "./WorkScheduleEditor";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { resetScheduleOperationsForTests } from "../../../features/native-routes/ops/use-schedule-operations";
import { fetchCronJob, updateCronJob } from "@goatcitadel/mission-control-shared/api/cron";
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <section role="dialog">{children}</section> : null }));
vi.mock("@goatcitadel/mission-control-shared/api/cron", () => ({ fetchCronJob: vi.fn(), updateCronJob: vi.fn(), fetchCronJobs: vi.fn(), createCronJob: vi.fn(), deleteCronJob: vi.fn(), pauseCronJob: vi.fn(), runCronJobNow: vi.fn(), startCronJob: vi.fn() }));
const job = { jobId: "daily", revision: 2, name: "Daily", action: "watchdog" as const, enabled: true, schedule: "0 9 * * *", workdir: "F:/disposable", contextFrom: "source-a", actionConfig: { watchdog: { checkId: "runtime_health", severityThreshold: "warning", notifyHomeChannel: false } } };
let renderer: ReactTestRenderer;
beforeEach(async () => { vi.resetAllMocks(); __resetSessionDraftsForTests(); resetScheduleOperationsForTests(); vi.mocked(fetchCronJob).mockResolvedValue(job); await act(async () => { renderer = create(<WorkScheduleEditor job={job} available={true} onSaved={vi.fn()} />); }); });
afterEach(() => act(() => renderer.unmount()));
async function click(label: string) { const button = renderer.root.findAllByType("button").find(node => node.children.join("") === label); expect(button).toBeDefined(); await act(async () => button!.props.onClick()); }
it.each(["array", "object", "number", "boolean", "null"])("does not PATCH non-string %s watchdog configuration", async kind => {
  const value = kind === "array" ? ["mcp_posture"] : kind === "object" ? { check: "mcp_posture" } : kind === "number" ? 1 : kind === "boolean" ? true : null;
  await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: JSON.stringify({ watchdog: { checkId: value, severityThreshold: "error", notifyHomeChannel: false } }) } }));
  await click("Review schedule changes"); await click("Save schedule changes");
  expect(updateCronJob).not.toHaveBeenCalled(); expect(fetchCronJob).not.toHaveBeenCalled(); expect(JSON.stringify(renderer.toJSON())).toContain("Watchdog configuration");
});
it("cancelled review dispatches no mutation; confirmed edit preserves supported advanced configuration", async () => {
  await act(async () => renderer.root.findAllByType("input")[0]!.props.onChange({ target: { value: "Revised" } }));
  await click("Review schedule changes"); await click("Keep editing"); expect(updateCronJob).not.toHaveBeenCalled();
  const saved = { ...job, revision: 3, name: "Revised" };
  vi.mocked(fetchCronJob).mockResolvedValueOnce(job).mockResolvedValueOnce(saved); vi.mocked(updateCronJob).mockResolvedValue(saved);
  await click("Review schedule changes"); await click("Save schedule changes");
  expect(updateCronJob).toHaveBeenCalledWith("daily", expect.objectContaining({ expectedRevision: 2, name: "Revised", workdir: job.workdir, contextFrom: job.contextFrom, actionConfig: job.actionConfig }));
});
it("stale preflight leaves the advanced draft intact and emits no update", async () => {
  await act(async () => renderer.root.findAllByType("input")[0]!.props.onChange({ target: { value: "Preserved" } }));
  vi.mocked(fetchCronJob).mockResolvedValue({ ...job, revision: 3 }); await click("Review schedule changes"); await click("Save schedule changes");
  expect(updateCronJob).not.toHaveBeenCalled(); expect(renderer.root.findAllByType("input")[0]!.props.value).toBe("Preserved"); expect(JSON.stringify(renderer.toJSON())).toContain("changed during review");
});
