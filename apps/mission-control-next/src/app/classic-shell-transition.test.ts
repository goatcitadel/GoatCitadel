// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const owner = vi.hoisted(() => ({
  capture: vi.fn(),
  current: vi.fn(),
  mountClassic: vi.fn(),
  load: vi.fn(),
  ready: Promise.resolve(),
}));
vi.mock("./application-root", () => ({
  captureApplicationRoot: owner.capture,
  isApplicationRootCurrent: owner.current,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let container: HTMLDivElement;
const initialPath = "/settings/citadel?shell=cockpit";
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  owner.ready = Promise.resolve();
  vi.doMock("../classic-entry", async () => {
    owner.load();
    await owner.ready;
    return { mountClassic: owner.mountClassic };
  });
  owner.capture.mockReturnValue({});
  owner.current.mockReturnValue(true);
  container = document.createElement("div");
  container.id = "root";
  document.body.appendChild(container);
  document.documentElement.dataset.shell = "cockpit";
  window.history.replaceState({ goatcitadelNavigationPosition: 7, retained: "entry" }, "", initialPath);
  window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
});
afterEach(() => {
  document.getElementById("root")?.remove();
  container.remove();
  window.history.replaceState(null, "", "/");
  window.localStorage.removeItem("goatcitadel.ui.shell.v1");
  delete document.documentElement.dataset.shell;
  vi.restoreAllMocks();
});

const unchanged = () => {
  expect(window.location.pathname + window.location.search).toBe(initialPath);
  expect(document.documentElement.dataset.shell).toBe("cockpit");
  expect(window.localStorage.getItem("goatcitadel.ui.shell.v1")).toBe("cockpit");
  expect(owner.mountClassic).not.toHaveBeenCalled();
};

describe("same-document classic owner fallback", () => {
  it("opens a temporary owner view without changing the saved layout", async () => {
    const { openClassicShell } = await import("./classic-shell-transition");
    expect(await openClassicShell("/ops/approvals?approvalId=exact&shellScope=visit", { isCurrent: () => true })).toBe(
      "opened",
    );
    expect(document.documentElement.dataset.shell).toBe("classic");
    expect(window.location.search).toContain("approvalId=exact");
    expect(window.localStorage.getItem("goatcitadel.ui.shell.v1")).toBe("cockpit");
  });

  it("loads lazily then replaces the current entry and mounts its existing root", async () => {
    const loading = deferred();
    owner.ready = loading.promise;
    const { openClassicShell } = await import("./classic-shell-transition");
    expect(owner.load).not.toHaveBeenCalled();
    const previousLength = window.history.length;
    const open = openClassicShell("/library/citadel-overview?record=one#profile", { isCurrent: () => true });
    await vi.waitFor(() => expect(owner.load).toHaveBeenCalledOnce());
    unchanged();
    loading.resolve();
    expect(await open).toBe("opened");
    expect(owner.mountClassic).toHaveBeenCalledExactlyOnceWith(container);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(
      "/library/citadel-overview?record=one&shell=classic#profile",
    );
    expect(window.history.state).toEqual({ goatcitadelNavigationPosition: 7, retained: "entry" });
    expect(window.history.length).toBe(previousLength);
    expect(document.documentElement.dataset.shell).toBe("classic");
    expect(window.localStorage.getItem("goatcitadel.ui.shell.v1")).toBe("classic");
  });

  it.each(["scope", "abort", "root-render", "root-replaced", "shell"])(
    "cancels a late module after %s changes",
    async (change) => {
      const loading = deferred();
      owner.ready = loading.promise;
      const { openClassicShell } = await import("./classic-shell-transition");
      let active = true;
      const controller = new AbortController();
      const open = openClassicShell("/library/citadel-overview", {
        isCurrent: () => active,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(owner.load).toHaveBeenCalledOnce());
      if (change === "scope") active = false;
      if (change === "abort") controller.abort();
      if (change === "root-render") owner.current.mockReturnValue(false);
      if (change === "root-replaced") {
        const other = document.createElement("div");
        other.id = "root";
        container.replaceWith(other);
      }
      if (change === "shell") document.documentElement.dataset.shell = "classic";
      loading.resolve();
      expect(await open).toBe("cancelled");
      expect(owner.mountClassic).not.toHaveBeenCalled();
      expect(window.location.pathname + window.location.search).toBe(initialPath);
      expect(window.localStorage.getItem("goatcitadel.ui.shell.v1")).toBe("cockpit");
    },
  );

  it.each(["popstate", "hashchange", "goatcitadel:cockpit-location"])(
    "cancels navigation away and back observed by %s",
    async (event) => {
      const loading = deferred();
      owner.ready = loading.promise;
      const { openClassicShell } = await import("./classic-shell-transition");
      const open = openClassicShell("/library/citadel-overview", { isCurrent: () => true });
      await vi.waitFor(() => expect(owner.load).toHaveBeenCalledOnce());
      window.history.replaceState(null, "", "/settings/models");
      window.dispatchEvent(new Event(event));
      window.history.replaceState(null, "", initialPath);
      window.dispatchEvent(new Event(event));
      loading.resolve();
      expect(await open).toBe("cancelled");
      unchanged();
    },
  );

  it("allows only the newest handoff to commit", async () => {
    const loading = deferred();
    owner.ready = loading.promise;
    const { openClassicShell } = await import("./classic-shell-transition");
    const first = openClassicShell("/library/citadel-overview?record=old", { isCurrent: () => true });
    const second = openClassicShell("/library/citadel-overview?record=current", { isCurrent: () => true });
    loading.resolve();
    expect(await first).toBe("cancelled");
    expect(await second).toBe("opened");
    expect(owner.mountClassic).toHaveBeenCalledOnce();
    expect(window.location.search).toBe("?record=current&shell=classic");
  });

  it("preserves the current view and storage when the lazy entry cannot load", async () => {
    owner.ready = Promise.reject(new Error("Chunk unavailable"));
    // The dynamic import installs its rejection handler during this turn.
    void owner.ready.catch(() => undefined);
    const { openClassicShell } = await import("./classic-shell-transition");
    await expect(openClassicShell("/library/citadel-overview", { isCurrent: () => true })).rejects.toThrow();
    unchanged();
  });

  it("rejects external targets and missing ownership without importing the entry", async () => {
    const { openClassicShell } = await import("./classic-shell-transition");
    await expect(openClassicShell("https://external.invalid/library", { isCurrent: () => true })).rejects.toThrow(
      "within this application",
    );
    owner.capture.mockReturnValue(undefined);
    await expect(openClassicShell("/library/citadel-overview", { isCurrent: () => true })).rejects.toThrow(
      "root is unavailable",
    );
    expect(owner.load).not.toHaveBeenCalled();
    unchanged();
  });

  it("does not start loading for an already-aborted view", async () => {
    const { openClassicShell } = await import("./classic-shell-transition");
    const controller = new AbortController();
    controller.abort();
    expect(
      await openClassicShell("/library/citadel-overview", { isCurrent: () => true, signal: controller.signal }),
    ).toBe("cancelled");
    expect(owner.load).not.toHaveBeenCalled();
    unchanged();
  });
});
