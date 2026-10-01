// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { __resetSettingsChangesForTests } from "./use-settings-change";
import { __resetManagedRuntimeUncertaintyForTests, type ManagedRuntimeValues } from "./managed-runtime-state";
import { useManagedRuntimeSettings } from "./use-managed-runtime-settings";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn(), fetchChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));
const initial = {
  revision: 41,
  llamaCpp: {
    enabled: false,
    autoStart: false,
    managementMode: "managed" as "managed" | "external",
    baseUrl: "http://127.0.0.1:8080/v1",
    alias: "saved-model",
    command: "llama-server",
    modelPath: "/models/saved.gguf",
  },
};
let owner: typeof initial;
let available: boolean;
let active: boolean;
let root: Root;
let container: HTMLDivElement;
let hook: ReturnType<typeof useManagedRuntimeSettings>;
const reload = vi.fn(async () => undefined);
function Probe() {
  hook = useManagedRuntimeSettings({ settings: owner as RuntimeSettingsResponse, available, active, reload });
  return null;
}
async function render() {
  await act(async () => root.render(<Probe />));
}
async function review() {
  act(() => hook.draft.setValue((value) => ({ ...value, alias: "reviewed-model" })));
  await act(async () => {
    await hook.requestReview();
  });
}
async function confirm() {
  await act(async () => {
    await hook.confirm();
  });
}
function pendingPlan(alias = "reviewed-model") {
  const receipt = { planId: "runtime-plan", status: "awaiting_approval", revision: 2, summary: "Approval required" };
  api.patchSettings.mockResolvedValue({ ...owner, changePlanReceipt: receipt });
  api.fetchChangePlan.mockResolvedValue({
    ...receipt,
    kind: "runtime_configuration",
    origin: { workspaceId: "default", surface: "settings" },
    target: { ownerId: "runtime_settings", resourceId: "llama_cpp_configuration", expectedRevision: 41 },
    request: {
      kind: "runtime_configuration",
      change: {
        operation: "llama_cpp_configuration",
        config: { enabled: false, autoStart: false, baseUrl: initial.llamaCpp.baseUrl, alias },
      },
    },
  });
}
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Real network forbidden in runtime settings tests.");
    }),
  );
  owner = structuredClone(initial);
  available = true;
  active = true;
  api.fetchSettings.mockImplementation(async () => owner);
  api.patchSettings.mockImplementation(async (input: { llamaCpp: ManagedRuntimeValues }) => ({
    ...owner,
    revision: owner.revision + 1,
    llamaCpp: { ...owner.llamaCpp, ...input.llamaCpp },
  }));
  reload.mockResolvedValue(undefined);
  container = document.createElement("div");
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  __resetManagedRuntimeUncertaintyForTests();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("shared managed runtime configuration owner", () => {
  it("reviews and cancels without writing; confirmation sends exact revision and no launch paths", async () => {
    await review();
    expect(api.patchSettings).not.toHaveBeenCalled();
    act(() => hook.cancel());
    await confirm();
    expect(api.patchSettings).not.toHaveBeenCalled();
    await review();
    await confirm();
    expect(api.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 41,
      llamaCpp: { enabled: false, autoStart: false, baseUrl: initial.llamaCpp.baseUrl, alias: "reviewed-model" },
    });
    expect(hook.draft.isDirty).toBe(false);
    expect(hook.notice).toContain("configuration saved and confirmed");
    expect(hook.notice).toContain("check the process");
  });
  it.each(["external", "unavailable", "changed revision"])("withholds confirmation for %s evidence", async (kind) => {
    await review();
    if (kind === "external") owner = { ...owner, llamaCpp: { ...owner.llamaCpp, managementMode: "external" } };
    if (kind === "unavailable") available = false;
    if (kind === "changed revision") owner = { ...owner, revision: 42 };
    await render();
    await confirm();
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(hook.reviewCurrent).toBe(false);
  });
  it("rejects fresh owner drift before dispatch while preserving the draft", async () => {
    await review();
    api.fetchSettings.mockResolvedValue({ ...owner, revision: 42 });
    await confirm();
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(hook.draft.value.alias).toBe("reviewed-model");
    expect(hook.notice).toContain("Runtime settings changed");
  });
  it("does not dispatch after navigating away during the fresh owner read", async () => {
    await review();
    let resolve!: (value: typeof owner) => void;
    api.fetchSettings.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    let result!: Promise<boolean>;
    await act(async () => {
      result = hook.confirm();
    });
    act(() => root.unmount());
    resolve(owner);
    await act(async () => {
      await result;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
    root = createRoot(container);
    await render();
    expect(hook.locked).toBe(false);
  });
  it("keeps a pending owner plan locked and retains the draft across remount", async () => {
    pendingPlan();
    await review();
    await confirm();
    expect(hook.change.change?.blocking).toBe(true);
    expect(hook.draft.isDirty).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(hook.locked).toBe(true);
    expect(hook.draft.value.alias).toBe("reviewed-model");
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
  });
  it("rejects a receipt refresh for a different configuration", async () => {
    pendingPlan("different-model");
    await review();
    await confirm();
    await act(async () => {
      await hook.change.refresh();
    });
    expect(hook.change.change?.error).toContain("does not match");
    expect(hook.locked).toBe(true);
  });
  it("clears the submission waiting notice after canonical settlement", async () => {
    pendingPlan();
    await review();
    await confirm();
    expect(hook.notice).toContain("Change submitted");
    const plan = await api.fetchChangePlan();
    api.fetchChangePlan.mockResolvedValue({ ...plan, status: "completed", revision: 3 });
    owner = { ...owner, revision: 42, llamaCpp: { ...owner.llamaCpp, alias: "reviewed-model" } };
    await act(async () => { await hook.change.refresh(); });
    expect(hook.change.change?.message).toBe("Change saved and confirmed.");
    expect(hook.notice).toBeNull();
    expect(hook.locked).toBe(false);
  });
  it.each([
    new Error("response lost"),
    { status: 409, body: { error: "unmarked conflict" } },
    {
      status: 409,
      body: { code: "STATE_CONFLICT", mutationCommitted: true, details: { expectedRevision: 41, currentRevision: 42 } },
    },
    {
      status: 409,
      body: { code: "STATE_CONFLICT", details: { expectedRevision: 41, currentRevision: 42, mutationCommitted: true } },
    },
  ])("locks unconfirmed results across both shells: %o", async (error) => {
    api.patchSettings.mockRejectedValue(error);
    await review();
    await confirm();
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(hook.uncertain).toContain("uncertain");
    expect(hook.locked).toBe(true);
    await review();
    await confirm();
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
  });
  it("unlocks only a marked precommit revision conflict", async () => {
    api.patchSettings.mockRejectedValue({
      status: 409,
      body: { code: "STATE_CONFLICT", details: { expectedRevision: 41, currentRevision: 42 } },
    });
    await review();
    await confirm();
    expect(hook.locked).toBe(false);
    expect(hook.notice).toContain("rejected the stale runtime revision");
  });
  it.each(["closed inspector", "replaced draft", "closed then reopened inspector", "changed then restored draft"])(
    "does not dispatch after %s during preflight",
    async (kind) => {
      await review();
      let resolve!: (value: typeof owner) => void;
      api.fetchSettings.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      let result!: Promise<boolean>;
      await act(async () => {
        result = hook.confirm();
      });
      if (kind.includes("inspector")) {
        active = false;
        await render();
        if (kind === "closed then reopened inspector") {
          active = true;
          await render();
        }
      } else {
        act(() => hook.draft.setValue((value) => ({ ...value, alias: "newer-draft" })));
        if (kind === "changed then restored draft")
          act(() => hook.draft.setValue((value) => ({ ...value, alias: "reviewed-model" })));
      }
      resolve(owner);
      await act(async () => {
        await result;
      });
      expect(api.patchSettings).not.toHaveBeenCalled();
      expect(hook.uncertain).toBeUndefined();
    },
  );
  it("does not call a mismatched owner acknowledgement saved", async () => {
    api.patchSettings.mockResolvedValue({ ...owner, revision: 42 });
    await review();
    await confirm();
    expect(hook.uncertain).toContain("uncertain");
    expect(hook.draft.isDirty).toBe(true);
  });
  it("preserves confirmed success if its subsequent refresh fails", async () => {
    reload.mockRejectedValue(new Error("refresh failed"));
    await review();
    await confirm();
    expect(hook.uncertain).toBeUndefined();
    expect(hook.notice).toContain("saved and confirmed");
    expect(hook.draft.isDirty).toBe(false);
  });
  it("rejects credentials embedded in a runtime endpoint before any mutation", async () => {
    act(() => hook.draft.setValue((value) => ({ ...value, baseUrl: "http://operator:secret@localhost:8080" })));
    await act(async () => {
      await hook.requestReview();
    });
    expect(hook.inputError).toContain("without credentials");
    expect(api.patchSettings).not.toHaveBeenCalled();
  });
});
