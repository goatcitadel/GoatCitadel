// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const owner = vi.hoisted(() => ({
  capture: vi.fn(),
  current: vi.fn(),
  mount: vi.fn(),
  load: vi.fn(),
  ready: Promise.resolve(),
}));
vi.mock("./application-root", () => ({
  captureApplicationRoot: owner.capture,
  isApplicationRootCurrent: owner.current,
}));
let container: HTMLDivElement;
const initial = "/settings/general?shell=classic";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  owner.ready = Promise.resolve();
  vi.doMock("../cockpit-entry", async () => {
    owner.load();
    await owner.ready;
    return { mountCockpit: owner.mount };
  });
  owner.capture.mockReturnValue({});
  owner.current.mockReturnValue(true);
  container = document.createElement("div");
  container.id = "root";
  document.body.appendChild(container);
  document.documentElement.dataset.shell = "classic";
  window.history.replaceState({ goatcitadelNavigationPosition: 5, retained: "state" }, "", initial);
  window.localStorage.setItem("goatcitadel.ui.shell.v1", "classic");
});
afterEach(() => {
  document.getElementById("root")?.remove();
  container.remove();
  window.history.replaceState(null, "", "/");
  window.localStorage.removeItem("goatcitadel.ui.shell.v1");
  delete document.documentElement.dataset.shell;
  vi.restoreAllMocks();
});
it("opens an exact scoped Inbox owner on the same entry and root", async () => {
  const pending = deferred();
  owner.ready = pending.promise;
  const { openCockpitShell } = await import("./cockpit-shell-transition");
  const length = window.history.length;
  const opening = openCockpitShell("/inbox?item=change_plan%3Aplan-a&workspaceId=workspace-a", {
    isCurrent: () => true,
  });
  await vi.waitFor(() => expect(owner.load).toHaveBeenCalledOnce());
  expect(owner.mount).not.toHaveBeenCalled();
  pending.resolve();
  expect(await opening).toBe("opened");
  expect(owner.mount).toHaveBeenCalledExactlyOnceWith(container);
  expect(window.location.pathname + window.location.search).toBe(
    "/inbox?item=change_plan%3Aplan-a&workspaceId=workspace-a&shell=cockpit",
  );
  expect(window.history.state).toEqual({ goatcitadelNavigationPosition: 5, retained: "state" });
  expect(window.history.length).toBe(length);
  expect(document.documentElement.dataset.shell).toBe("cockpit");
});
it.each(["scope", "abort", "root", "container", "shell", "classic-navigation", "popstate"])(
  "cancels a pending reverse handoff after %s",
  async (change) => {
    const pending = deferred();
    owner.ready = pending.promise;
    const { openCockpitShell } = await import("./cockpit-shell-transition");
    let current = true;
    const controller = new AbortController();
    const opening = openCockpitShell("/inbox", { isCurrent: () => current, signal: controller.signal });
    await vi.waitFor(() => expect(owner.load).toHaveBeenCalledOnce());
    if (change === "scope") current = false;
    if (change === "abort") controller.abort();
    if (change === "root") owner.current.mockReturnValue(false);
    if (change === "container") {
      const replacement = document.createElement("div");
      replacement.id = "root";
      container.replaceWith(replacement);
    }
    if (change === "shell") document.documentElement.dataset.shell = "cockpit";
    if (change === "classic-navigation" || change === "popstate") {
      window.history.replaceState(null, "", "/settings/runtime");
      window.dispatchEvent(new Event(change === "popstate" ? "popstate" : "goatcitadel:classic-location"));
      window.history.replaceState(null, "", initial);
    }
    pending.resolve();
    expect(await opening).toBe("cancelled");
    expect(owner.mount).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search).toBe(initial);
    expect(window.localStorage.getItem("goatcitadel.ui.shell.v1")).toBe("classic");
  },
);
it("allows only the latest reverse target and rejects foreign origins before loading", async () => {
  const pending = deferred();
  owner.ready = pending.promise;
  const { openCockpitShell } = await import("./cockpit-shell-transition");
  await expect(openCockpitShell("https://foreign.invalid/inbox", { isCurrent: () => true })).rejects.toThrow(
    "within this application",
  );
  expect(owner.load).not.toHaveBeenCalled();
  const first = openCockpitShell("/inbox?item=old", { isCurrent: () => true });
  const second = openCockpitShell("/inbox?item=current", { isCurrent: () => true });
  pending.resolve();
  expect(await first).toBe("cancelled");
  expect(await second).toBe("opened");
  expect(owner.mount).toHaveBeenCalledOnce();
  expect(window.location.search).toBe("?item=current&shell=cockpit");
});
