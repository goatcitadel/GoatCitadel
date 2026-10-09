// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkSchedules } from "./WorkSchedules";
import { WorkScheduleEditor } from "./WorkScheduleEditor";
import { CockpitNavigationContext } from "../../app/cockpit-navigation-context";
import { commitCockpitNavigation } from "../../app/cockpit-history";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { resetScheduleOperationsForTests } from "../../../features/native-routes/ops/use-schedule-operations";
import { fetchCronJob, fetchCronJobs, updateCronJob, pauseCronJob } from "@goatcitadel/mission-control-shared/api/cron";
vi.mock("@goatcitadel/mission-control-shared/api/cron", () => ({ fetchCronJob: vi.fn(), fetchCronJobs: vi.fn(), updateCronJob: vi.fn(), pauseCronJob: vi.fn(), createCronJob: vi.fn(), deleteCronJob: vi.fn(), runCronJobNow: vi.fn(), startCronJob: vi.fn() }));
const a = { jobId: "job-a", revision: 2, name: "A schedule", schedule: "0 0 * * * UTC", action: "watchdog" as const, enabled: true, actionConfig: { watchdog: { checkId: "runtime_health", severityThreshold: "warning", notifyHomeChannel: false } } };
const b = { ...a, jobId: "job-b", name: "B schedule" };
let container: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => { vi.resetAllMocks(); __resetSessionDraftsForTests(); resetScheduleOperationsForTests(); window.history.replaceState(null, "", "/work/schedules?jobId=job-a&shell=cockpit"); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } }); vi.mocked(fetchCronJobs).mockResolvedValue({ items: [a, b] }); vi.mocked(fetchCronJob).mockImplementation(async id => id === a.jobId ? a : b); });
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
// No inline Dialog mock: query only roles exposed by the real Radix portal, excluding its aria-hidden background.
function getByRole(role: string, options?: { name: string }) {
  const candidates = [...document.querySelectorAll<HTMLElement>(role === "button" ? "button" : `[role="${role}"]`)];
  const matches = candidates.filter(node => !node.closest('[aria-hidden="true"], [hidden]') && (!options || (node.getAttribute("aria-label") ?? node.textContent?.trim()) === options.name));
  expect(matches.length, `accessible ${role} ${options?.name ?? ""}`).toBe(1);
  return matches[0]!;
}
async function click(name: string) { await act(async () => getByRole("button", { name }).click()); }
it.each(["before confirmation", "after rejected preflight"])("retains the reviewed snapshot and accessible conflict after canonical revision refresh settles %s", async timing => {
  await render(); await vi.waitFor(() => expect(container.textContent).toContain("Edit schedule")); await click("Pause");
  const updated = { ...a, revision: 3, name: "Changed schedule", schedule: "0 12 * * * UTC" };
  vi.mocked(fetchCronJob).mockResolvedValue(updated);
  if (timing === "after rejected preflight") {
    await click("Confirm pause");
    expect(getByRole("alert").textContent).toContain("changed during review");
  }
  await act(async () => { await client.invalidateQueries({ queryKey: ["cockpit", "schedule", a.jobId] }); });
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(getByRole("dialog").contains(getByRole("alert"))).toBe(true);
  expect(getByRole("alert").textContent).toContain("changed during review");
  expect(getByRole("dialog").textContent).toContain("A schedule");
  expect(getByRole("dialog").textContent).not.toContain("Changed schedule");
  expect(getByRole("button", { name: "Confirm pause" }).hasAttribute("disabled")).toBe(true);
  expect(pauseCronJob).not.toHaveBeenCalled();
  await click("Keep schedule"); await click("Pause");
  expect(getByRole("dialog").textContent).toContain("Changed schedule");
  expect(getByRole("button", { name: "Confirm pause" }).hasAttribute("disabled")).toBe(false);
});
async function render(editor = false) { await act(async () => root.render(<CockpitNavigationContext.Provider value={{ navigate: href => { commitCockpitNavigation(href); }, requestTransition: () => {}, isTransitionPending: () => false }}><QueryClientProvider client={client}>{editor ? <WorkScheduleEditor job={a} available={true} onSaved={vi.fn()} /> : <WorkSchedules />}</QueryClientProvider></CockpitNavigationContext.Provider>)); }
it("requires one fresh authorized GET on cached history return despite a 30-second default stale time", async () => {
  await render(); await vi.waitFor(() => expect(container.textContent).toContain("Edit schedule"));
  expect(vi.mocked(fetchCronJob).mock.calls.filter(([id]) => id === "job-a")).toHaveLength(1);
  await act(async () => { commitCockpitNavigation("/work/schedules?jobId=job-b"); });
  await vi.waitFor(() => expect(getByRole("button", { name: "Review schedule changes" }).hasAttribute("disabled")).toBe(false));
  expect(vi.mocked(fetchCronJob).mock.calls.filter(([id]) => id === "job-b")).toHaveLength(1);
  await act(async () => { commitCockpitNavigation("/work/schedules?jobId=job-a"); });
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Schedule detail"]')?.textContent).toContain("A schedule"));
  await vi.waitFor(() => expect(vi.mocked(fetchCronJob).mock.calls.filter(([id]) => id === "job-a")).toHaveLength(2));
  let complete!: (value: typeof b) => void;
  vi.mocked(fetchCronJob).mockImplementation(id => id === "job-b" ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(a));
  await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 20)); });
  await vi.waitFor(() => expect(vi.mocked(fetchCronJob).mock.calls.filter(([id]) => id === "job-b")).toHaveLength(2));
  const review = [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Review schedule changes");
  if (review) expect(review.disabled).toBe(true);
  await act(async () => complete(b));
  await vi.waitFor(() => expect(getByRole("button", { name: "Review schedule changes" }).hasAttribute("disabled")).toBe(false));
  await click("Review schedule changes"); expect(getByRole("dialog").textContent).toContain("B schedule");
});
it("exposes invalid editor configuration inside the real accessible review portal without PATCH", async () => {
  await render(true);
  const config = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(config, '{"watchdog":{"checkId":["mcp_posture"],"severityThreshold":"error","notifyHomeChannel":false}}'); config.dispatchEvent(new Event("input", { bubbles: true })); });
  await click("Review schedule changes"); await click("Save schedule changes");
  expect(getByRole("dialog").contains(getByRole("alert"))).toBe(true); expect(getByRole("alert").textContent).toContain("Watchdog configuration"); expect(updateCronJob).not.toHaveBeenCalled();
});
it.each(["stale", "unavailable", "uncertain"])("exposes %s editor outcome in the real accessible portal", async kind => {
  await render(true); await click("Review schedule changes");
  if (kind === "stale") vi.mocked(fetchCronJob).mockResolvedValue({ ...a, revision: 3 });
  else if (kind === "unavailable") vi.mocked(fetchCronJob).mockRejectedValue(new Error("Schedule access unavailable"));
  else vi.mocked(updateCronJob).mockRejectedValue(new Error("Response lost"));
  await click("Save schedule changes");
  await vi.waitFor(() => expect(getByRole("dialog").contains(getByRole("alert"))).toBe(true));
  expect(getByRole("alert").textContent).toContain(kind === "stale" ? "changed during review" : kind === "unavailable" ? "Schedule access unavailable" : "outcome is unconfirmed");
  if (kind !== "uncertain") expect(updateCronJob).not.toHaveBeenCalled(); else expect(getByRole("button", { name: "Save schedule changes" }).hasAttribute("disabled")).toBe(true);
});
it.each(["stale", "unavailable", "uncertain"])("exposes %s pause outcome in the real accessible action portal", async kind => {
  await render(); await vi.waitFor(() => expect(container.textContent).toContain("Edit schedule")); await click("Pause");
  if (kind === "stale") vi.mocked(fetchCronJob).mockResolvedValue({ ...a, revision: 3 });
  else if (kind === "unavailable") vi.mocked(fetchCronJob).mockRejectedValue(new Error("Schedule access unavailable"));
  else vi.mocked(pauseCronJob).mockRejectedValue(new Error("Response lost"));
  await click("Confirm pause");
  await vi.waitFor(() => expect(getByRole("dialog").contains(getByRole("alert"))).toBe(true));
  expect(getByRole("alert").textContent).toContain(kind === "stale" ? "changed during review" : kind === "unavailable" ? "Schedule access unavailable" : "outcome is unconfirmed");
  if (kind !== "uncertain") expect(pauseCronJob).not.toHaveBeenCalled(); else expect(getByRole("button", { name: "Confirm pause" }).hasAttribute("disabled")).toBe(true);
});
