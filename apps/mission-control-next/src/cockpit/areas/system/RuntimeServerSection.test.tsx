// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { describeRuntimeService } from "@goatcitadel/mission-control-shared/content/runtime-service";
import { RuntimeServerSection } from "./RuntimeServerSection";
import { runtimeData, testDaemon } from "./runtime-page.test-data";

const preferences = vi.hoisted(() => ({ showTechnicalDetails: true }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
// The access-bound Radix dialog is covered by its own tests; this exercises the confirmation flow.
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

let host: HTMLDivElement, root: Root;
const runtime = { notice: null, daemonBusy: null, runDaemonAction: vi.fn(async () => undefined) };
beforeEach(() => {
  vi.clearAllMocks();
  preferences.showTechnicalDetails = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (data = runtimeData()) => act(() => root.render(<RuntimeServerSection data={data} runtime={runtime} />));
const button = (name: RegExp) => [...host.querySelectorAll("button")].find((node) => name.test(node.textContent ?? ""));

it("names the server as Health does and agrees on its status", () => {
  render();
  expect(host.querySelector("h2")?.textContent).toBe("GoatCitadel server");
  expect(host.textContent).toContain(describeRuntimeService(testDaemon as never).label);
  expect(host.querySelector("section")?.id).toBe("runtime-server");
});

it("offers no controls for a server another process manager runs, and shows its handoff", () => {
  render(
    runtimeData({
      daemon: { ...testDaemon, controllable: false, controlMessage: "Run by the Windows service." },
    }),
  );
  expect(button(/^Stop server/)).toBeUndefined();
  expect(button(/^Start server/)).toBeUndefined();
  const summaries = [...host.querySelectorAll("summary")].map((node) => node.textContent);
  expect(summaries).toContain("Process manager and commands");
});

it("stops the server only after the confirmation", async () => {
  render();
  await act(async () => button(/^Stop server$/)!.click());
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("lose the server until it starts again");
  await act(async () => [...dialog.querySelectorAll("button")].find((node) => node.textContent === "Cancel")!.click());
  expect(runtime.runDaemonAction).not.toHaveBeenCalled();
  await act(async () => button(/^Stop server$/)!.click());
  const confirm = [...host.querySelector('[role="dialog"]')!.querySelectorAll("button")].find(
    (node) => node.textContent === "Stop server",
  )!;
  await act(async () => confirm.click());
  expect(runtime.runDaemonAction).toHaveBeenCalledExactlyOnceWith("stop");
});

it("starts the server in one step", async () => {
  render(runtimeData({ daemon: { ...testDaemon, running: false, state: "stopped" } }));
  await act(async () => button(/^Start server$/)!.click());
  expect(runtime.runDaemonAction).toHaveBeenCalledExactlyOnceWith("start");
});

it("keeps host and process ID out of the page unless technical details are on", () => {
  preferences.showTechnicalDetails = false;
  render();
  expect(host.textContent).not.toContain("host-a");
  preferences.showTechnicalDetails = true;
  render();
  expect(host.textContent).toContain("host-a");
});
