// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LlamaCppRuntimeStatus, LlamaCppSetupProjection } from "@goatcitadel/contracts";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthLocalRuntimeActions } from "./HealthLocalRuntimeActions";
import {
  __resetLocalRuntimeAttemptForTests,
  readLocalRuntimeAttempt,
  readLocalRuntimeReview,
  startReviewedLocalRuntime,
} from "./health-local-runtime-actions";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), fetchLlamaCppSetup: vi.fn(), startLlamaCppRuntime: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/platform", () => api);
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));

const runtime: LlamaCppRuntimeStatus = {
  enabled: true,
  desiredState: "stopped",
  processState: "stopped",
  healthy: false,
  baseUrl: "http://127.0.0.1:8080/v1",
  updatedAt: "2026-09-30T00:00:00.000Z",
  leaseDiagnostics: {
    state: "idle",
    activeLeaseCount: 0,
    ownership: "none",
    purposes: [],
    persistentDemand: { manual: false, api: false, autostart: false },
    evidence: {},
  },
};
const settings = {
  revision: 7,
  llamaCpp: {
    enabled: true,
    autoStart: false,
    managementMode: "managed",
    baseUrl: runtime.baseUrl,
    command: "C:\\llama\\llama-server.exe",
    extraArgs: [],
    alias: "local-model",
    modelPath: "C:\\models\\local.gguf",
    status: runtime,
  },
} satisfies Pick<RuntimeSettingsResponse, "revision" | "llamaCpp">;
const setup: LlamaCppSetupProjection = {
  settingsRevision: 7,
  managementMode: "managed",
  baseUrl: runtime.baseUrl,
  runtime,
  ownership: "none",
  binary: { found: true, label: "llama-server.exe" },
  models: [],
  catalog: { status: "unavailable", modelIds: [] },
  chatRoute: { providerId: "llamacpp", model: "local-model", thinkingLevel: "off" },
};
const started: LlamaCppRuntimeStatus = {
  ...runtime,
  desiredState: "running",
  processState: "running",
  healthy: true,
  pid: 123,
  leaseDiagnostics: { ...runtime.leaseDiagnostics!, ownership: "owned", state: "persistent" },
};
const startedSetup: LlamaCppSetupProjection = { ...setup, ownership: "owned", runtime: started };
let root: Root;
let container: HTMLDivElement;
let refresh = vi.fn<() => Promise<void>>();
beforeEach(() => {
  __resetLocalRuntimeAttemptForTests();
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchSettings.mockResolvedValue(settings);
  api.fetchLlamaCppSetup.mockResolvedValue(setup);
  api.startLlamaCppRuntime.mockResolvedValue(started);
  refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function render(workspaceId = "workspace-a") {
  await act(async () => root.render(<HealthLocalRuntimeActions workspaceId={workspaceId} onRefresh={refresh} />));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}
function successSequence() {
  api.fetchLlamaCppSetup.mockResolvedValueOnce(setup).mockResolvedValueOnce(setup).mockResolvedValue(startedSetup);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}

describe("System managed local runtime start", () => {
  it("reads only on request, shows exact saved review, and starts once only after host-wide confirmation", async () => {
    successSequence();
    await render();
    expect(api.fetchSettings).not.toHaveBeenCalled();
    await click("Review local runtime start");
    expect(api.fetchLlamaCppSetup).toHaveBeenCalledWith("workspace-a");
    expect(api.startLlamaCppRuntime).not.toHaveBeenCalled();
    expect(container.textContent).toContain("local.gguf");
    expect(container.textContent).not.toContain("C:\\models");
    expect(container.textContent).toContain("cannot bind startup atomically");
    await click("Confirm host-wide start");
    expect(api.startLlamaCppRuntime).toHaveBeenCalledExactlyOnceWith();
    expect(container.textContent).toContain("health probe passed");
    expect(refresh).toHaveBeenCalledOnce();
    expect(api.fetchSettings).toHaveBeenCalledTimes(3);
    expect(api.fetchLlamaCppSetup).toHaveBeenCalledTimes(3);
  });
  it.each([
    ["disabled", { ...settings.llamaCpp, enabled: false }, { ...setup, runtime: { ...runtime, enabled: false } }],
    ["external", { ...settings.llamaCpp, managementMode: "external" }, { ...setup, managementMode: "external" }],
    ["starting", settings.llamaCpp, { ...setup, runtime: { ...runtime, processState: "starting" } }],
    ["running demand", settings.llamaCpp, { ...setup, runtime: { ...runtime, desiredState: "running" } }],
    [
      "non-idle lifecycle",
      settings.llamaCpp,
      { ...setup, runtime: { ...runtime, leaseDiagnostics: { ...runtime.leaseDiagnostics!, state: "starting" } } },
    ],
    [
      "pre-spawn startup",
      settings.llamaCpp,
      {
        ...setup,
        runtime: {
          ...runtime,
          desiredState: "running",
          leaseDiagnostics: { ...runtime.leaseDiagnostics!, state: "starting" },
        },
      },
    ],
    ["owned", settings.llamaCpp, { ...setup, ownership: "owned" }],
    ["observed", settings.llamaCpp, { ...setup, ownership: "external" }],
    ["PID present", settings.llamaCpp, { ...setup, runtime: { ...runtime, pid: 321 } }],
    ["missing ownership", settings.llamaCpp, { ...setup, runtime: { ...runtime, leaseDiagnostics: undefined } }],
    [
      "active lease",
      settings.llamaCpp,
      { ...setup, runtime: { ...runtime, leaseDiagnostics: { ...runtime.leaseDiagnostics!, activeLeaseCount: 1 } } },
    ],
    ["binary missing", settings.llamaCpp, { ...setup, binary: { found: false } }],
    ["model missing", { ...settings.llamaCpp, modelPath: "" }, setup],
    [
      "pending plan",
      settings.llamaCpp,
      { ...setup, pendingPlan: { planId: "plan-a", revision: 1, status: "awaiting_approval" } },
    ],
  ])("does not start when %s", async (_label, saved, projected) => {
    api.fetchSettings.mockResolvedValue({ ...settings, llamaCpp: saved });
    api.fetchLlamaCppSetup.mockResolvedValue(projected);
    await render();
    await click("Review local runtime start");
    await click("Confirm host-wide start");
    expect(api.startLlamaCppRuntime).not.toHaveBeenCalled();
    expect(readLocalRuntimeAttempt()).toBeUndefined();
  });
  it.each([{ settingsRevision: 8 }, { baseUrl: "http://other:8080/v1" }, { runtime: { ...runtime, enabled: false } }])(
    "withholds inconsistent owner evidence %j",
    async (change) => {
      api.fetchLlamaCppSetup.mockResolvedValue({ ...setup, ...change });
      await expect(readLocalRuntimeReview("workspace-a")).rejects.toThrow("inconsistent settings evidence");
      expect(api.startLlamaCppRuntime).not.toHaveBeenCalled();
    },
  );
  it.each(["revision", "configuration", "ownership", "pre-spawn startup"])(
    "refuses changed %s at confirmation without locking a never-submitted request",
    async (change) => {
      const review = await readLocalRuntimeReview("workspace-a");
      if (change === "revision") {
        api.fetchSettings.mockResolvedValue({ ...settings, revision: 8 });
        api.fetchLlamaCppSetup.mockResolvedValue({ ...setup, settingsRevision: 8 });
      } else if (change === "configuration")
        api.fetchSettings.mockResolvedValue({
          ...settings,
          llamaCpp: { ...settings.llamaCpp, extraArgs: ["--threads", "2"] },
        });
      else if (change === "pre-spawn startup")
        api.fetchLlamaCppSetup.mockResolvedValue({
          ...setup,
          runtime: {
            ...runtime,
            desiredState: "running",
            leaseDiagnostics: { ...runtime.leaseDiagnostics!, state: "starting" },
          },
        });
      else api.fetchLlamaCppSetup.mockResolvedValue({ ...setup, ownership: "external" });
      await expect(startReviewedLocalRuntime(review, () => true)).rejects.toThrow("changed");
      expect(api.startLlamaCppRuntime).not.toHaveBeenCalled();
      expect(readLocalRuntimeAttempt()).toBeUndefined();
    },
  );
  it("rejects a matching but invalid zero settings revision", async () => {
    api.fetchSettings.mockResolvedValue({ ...settings, revision: 0 });
    api.fetchLlamaCppSetup.mockResolvedValue({ ...setup, settingsRevision: 0 });
    await expect(readLocalRuntimeReview("workspace-a")).rejects.toThrow("inconsistent settings evidence");
    expect(api.startLlamaCppRuntime).not.toHaveBeenCalled();
  });
  it("preserves the complete saved configuration comparison without showing extra launch arguments", async () => {
    api.fetchSettings.mockResolvedValue({
      ...settings,
      llamaCpp: { ...settings.llamaCpp, extraArgs: ["--api-key", "synthetic-private-argument"] },
    });
    await render();
    await click("Review local runtime start");
    expect(container.textContent).not.toContain("synthetic-private-argument");
  });
  it("ignores a late review after workspace selection changes", async () => {
    const reply = deferred<typeof setup>();
    api.fetchLlamaCppSetup.mockReturnValue(reply.promise);
    await render();
    await click("Review local runtime start");
    await render("workspace-b");
    await act(async () => reply.resolve(setup));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(api.startLlamaCppRuntime).not.toHaveBeenCalled();
  });
  it("does not submit if the review closes during its final owner reads", async () => {
    const review = await readLocalRuntimeReview("workspace-a");
    await expect(startReviewedLocalRuntime(review, () => false)).rejects.toThrow("no longer open");
    expect(api.startLlamaCppRuntime).not.toHaveBeenCalled();
    expect(readLocalRuntimeAttempt()).toBeUndefined();
  });
  it("locks a duplicate submission across workspaces while a request is running", async () => {
    const review = await readLocalRuntimeReview("workspace-a");
    const reply = deferred<typeof started>();
    api.startLlamaCppRuntime.mockReturnValue(reply.promise);
    const pending = startReviewedLocalRuntime(review, () => true);
    await expect(startReviewedLocalRuntime({ ...review, workspaceId: "workspace-b" }, () => true)).rejects.toThrow(
      "already pending",
    );
    api.fetchLlamaCppSetup.mockResolvedValue(startedSetup);
    reply.resolve(started);
    await pending;
    expect(api.startLlamaCppRuntime).toHaveBeenCalledOnce();
  });
  it("retains an uncertain result after navigation and permits only a read-only inspection", async () => {
    api.startLlamaCppRuntime.mockRejectedValue(new Error("Connection lost after dispatch"));
    await render();
    await click("Review local runtime start");
    await click("Confirm host-wide start");
    expect(container.textContent).toContain("no verified outcome");
    await render("workspace-b");
    await click("Inspect local runtime");
    await click("Confirm host-wide start");
    expect(container.textContent).toContain("Host-wide runtime action from another workspace");
    expect(api.startLlamaCppRuntime).toHaveBeenCalledOnce();
    expect(readLocalRuntimeAttempt()?.phase).toBe("uncertain");
  });
  it.each(["readback failed", "changed settings", "different process", "foreign endpoint", "external ownership"])(
    "withholds unverified success when %s",
    async (change) => {
      const review = await readLocalRuntimeReview("workspace-a");
      api.fetchLlamaCppSetup.mockResolvedValueOnce(setup);
      if (change === "readback failed") api.fetchLlamaCppSetup.mockRejectedValueOnce(new Error("Unavailable"));
      else
        api.fetchLlamaCppSetup.mockResolvedValueOnce({
          ...startedSetup,
          ...(change === "external ownership" ? { ownership: "external" } : {}),
          runtime: {
            ...started,
            ...(change === "different process" ? { pid: 999 } : {}),
            ...(change === "foreign endpoint" ? { baseUrl: "http://other:8080/v1" } : {}),
          },
        });
      if (change === "changed settings")
        api.fetchSettings.mockResolvedValueOnce(settings).mockResolvedValueOnce({ ...settings, revision: 8 });
      await startReviewedLocalRuntime(review, () => true);
      expect(readLocalRuntimeAttempt()?.phase).toBe("uncertain");
      expect(api.startLlamaCppRuntime).toHaveBeenCalledOnce();
    },
  );
  it("withholds contradictory healthy-but-starting owner evidence", async () => {
    const review = await readLocalRuntimeReview("workspace-a");
    api.startLlamaCppRuntime.mockResolvedValue({ ...started, processState: "starting" });
    await startReviewedLocalRuntime(review, () => true);
    expect(readLocalRuntimeAttempt()?.phase).toBe("uncertain");
  });
  it("does not call a starting process healthy or a successful owner result a failed refresh", async () => {
    successSequence();
    refresh.mockRejectedValue(new Error("Health summary unavailable"));
    api.fetchLlamaCppSetup.mockResolvedValue({
      ...startedSetup,
      runtime: { ...started, healthy: false, processState: "starting" },
    });
    await render();
    await click("Review local runtime start");
    await click("Confirm host-wide start");
    expect(container.textContent).toContain("owned runtime starting");
    expect(container.textContent).not.toContain("health probe passed");
    expect(readLocalRuntimeAttempt()?.phase).toBe("verified");
  });
});
