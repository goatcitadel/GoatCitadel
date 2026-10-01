// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingBootstrapInput, OnboardingState } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { useOnboardingDefaults } from "./use-onboarding-defaults";
import { onboardingFixture } from "./onboarding.test-support";
import { gatewayAuthSettingsFixture } from "./gateway-auth.test-support";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { __resetOnboardingAttemptsForTests } from "./onboarding-completion-state";

const api = vi.hoisted(() => ({
  fetchOnboardingState: vi.fn(),
  fetchSettings: vi.fn(),
  bootstrapOnboarding: vi.fn(),
  base: "installation-a",
  settled: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getGatewayApiBaseUrl: () => api.base,
}));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: Root, state: OnboardingState, displayed: OnboardingState, control: ReturnType<typeof useOnboardingDefaults>;
function runtime() {
  return { ...gatewayAuthSettingsFixture(), ...state.settings, deploymentProfile: "local_dev" as const };
}
function Probe({ workspaceId = "workspace-a", active = true }) {
  control = useOnboardingDefaults({
    state: displayed,
    runtime: { ...runtime(), ...displayed.settings },
    workspaceId,
    active,
    onSettled: api.settled,
  });
  return null;
}
async function render(workspaceId = "workspace-a", active = true) {
  await act(async () =>
    root.render(
      <StrictMode>
        <Probe workspaceId={workspaceId} active={active} />
      </StrictMode>,
    ),
  );
}
async function review() {
  await act(async () =>
    control.edit({ ...control.draft.value, budgetMode: "saver", networkAllowlist: "example.com, api.example.com" }),
  );
  await act(async () => control.begin());
  expect(control.review).not.toBeNull();
}
function apply(input: OnboardingBootstrapInput) {
  state = {
    ...state,
    settings: {
      ...state.settings,
      revision: input.expectedRevision + 1,
      budgetMode: input.budgetMode!,
      toolApprovalMode: input.toolApprovalMode!,
      networkAllowlist: input.networkAllowlist!,
      auth: { ...state.settings.auth, allowLoopbackBypass: false },
    },
  };
  return { appliedAt: "2026-09-30T12:00:00.000Z", state: structuredClone(state) };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.base = "installation-a";
  state = onboardingFixture();
  state.settings.auth.allowLoopbackBypass = true;
  displayed = structuredClone(state);
  api.fetchOnboardingState.mockImplementation(async () => structuredClone(state));
  api.fetchSettings.mockImplementation(async () => runtime());
  api.bootstrapOnboarding.mockImplementation(async (input: OnboardingBootstrapInput) => apply(input));
  api.settled.mockResolvedValue(undefined);
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  __resetSessionDraftsForTests();
  __resetOnboardingAttemptsForTests();
});
describe("reviewed onboarding defaults", () => {
  it("uses exact CAS, fresh distinct reads and loopback bypass off without finishing setup", async () => {
    await render();
    await review();
    expect(api.bootstrapOnboarding).not.toHaveBeenCalled();
    await act(async () => {
      await control.confirm();
    });
    expect(api.bootstrapOnboarding).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 41,
      budgetMode: "saver",
      toolApprovalMode: "approve_all",
      networkAllowlist: ["example.com", "api.example.com"],
      auth: { allowLoopbackBypass: false },
    });
    expect(state.completed).toBe(false);
    expect(control.locked).toBe(false);
    expect(control.draft.isDirty).toBe(false);
    const signals = [...api.fetchSettings.mock.calls, ...api.fetchOnboardingState.mock.calls].map(
      (call) => call[0].signal,
    );
    expect(signals).toHaveLength(4);
    expect(new Set(signals).size).toBe(4);
  });
  it("cancels a review without writing", async () => {
    await render();
    await review();
    await act(async () => control.cancel());
    await act(async () => {
      await control.confirm();
    });
    expect(api.bootstrapOnboarding).not.toHaveBeenCalled();
  });
  it.each(["scope", "draft", "active"])("fences %s away-and-back during preflight", async (kind) => {
    await render();
    await review();
    const wait = deferred<OnboardingState>();
    api.fetchOnboardingState.mockReturnValueOnce(wait.promise);
    let pending!: Promise<boolean>;
    act(() => {
      pending = control.confirm();
    });
    if (kind === "scope") {
      await render("workspace-b");
      await render();
    }
    if (kind === "active") {
      await render("workspace-a", false);
      await render();
    }
    if (kind === "draft") {
      const old = control.draft.value;
      await act(async () => control.edit({ ...old, networkAllowlist: "other" }));
      await act(async () => control.edit(old));
    }
    await act(async () => {
      wait.resolve(state);
      await pending;
    });
    expect(api.bootstrapOnboarding).not.toHaveBeenCalled();
    expect(control.locked).toBe(false);
  });
  it("withholds stale canonical settings without adopting their revision", async () => {
    await render();
    await review();
    state.settings.revision++;
    await act(async () => {
      await control.confirm();
    });
    expect(api.bootstrapOnboarding).not.toHaveBeenCalled();
    expect(control.notice).toContain("changed during review");
    expect(control.draft.baseRevision).toBe(41);
  });
  it("retains lost-response admission across workspace, shell and remount", async () => {
    await render();
    await review();
    api.bootstrapOnboarding.mockRejectedValue(new Error("response lost"));
    await act(async () => {
      await control.confirm();
    });
    await act(async () => root.render(null));
    await render("workspace-b");
    expect(control.attempt?.phase).toBe("unknown");
    await act(async () => control.begin());
    expect(control.review).toBeNull();
    expect(api.bootstrapOnboarding).toHaveBeenCalledTimes(1);
  });
  it.each(["scope", "auth", "revision", "marker"])("withholds a foreign %s receipt", async (kind) => {
    await render();
    await review();
    api.bootstrapOnboarding.mockImplementation(async (input: OnboardingBootstrapInput) => {
      const result = apply(input);
      if (kind === "scope") api.base = "installation-b";
      if (kind === "auth") result.state.settings.auth.allowLoopbackBypass = true;
      if (kind === "revision") result.state.settings.revision++;
      if (kind === "marker") result.state.completed = true;
      return result;
    });
    await act(async () => {
      await control.confirm();
    });
    api.base = "installation-a";
    await render();
    expect(control.attempt?.phase).toBe("unknown");
    expect(api.settled).not.toHaveBeenCalled();
  });
  it("keeps generic 409 uncertain but unlocks an exact owner revision conflict", async () => {
    await render();
    await review();
    api.bootstrapOnboarding.mockRejectedValue(
      new ApiRequestError("stale", {
        kind: "http",
        method: "POST",
        path: "/api/v1/onboarding/bootstrap",
        status: 409,
        body: { code: "STATE_CONFLICT", details: { expectedRevision: 41, currentRevision: 42 } },
      }),
    );
    await act(async () => {
      await control.confirm();
    });
    expect(control.locked).toBe(false);
    await act(async () => control.begin());
    api.bootstrapOnboarding.mockRejectedValue(
      new ApiRequestError("unknown", {
        kind: "http",
        method: "POST",
        path: "/api/v1/onboarding/bootstrap",
        status: 409,
        body: {},
      }),
    );
    await act(async () => {
      await control.confirm();
    });
    expect(control.attempt?.phase).toBe("unknown");
  });
  it("acknowledges the origin after navigation and preserves newer input without a late view callback", async () => {
    await render();
    await review();
    const wait = deferred<ReturnType<typeof apply>>();
    api.bootstrapOnboarding.mockImplementationOnce(async (input: OnboardingBootstrapInput) => {
      const receipt = apply(input);
      await wait.promise;
      return receipt;
    });
    let pending!: Promise<boolean>;
    act(() => {
      pending = control.confirm();
    });
    await vi.waitFor(() => expect(api.bootstrapOnboarding).toHaveBeenCalledOnce());
    await act(async () => control.edit({ ...control.draft.value, networkAllowlist: "newer.example" }));
    await render("workspace-b");
    await act(async () => {
      wait.resolve({ state, appliedAt: "2026-09-30T12:00:00.000Z" });
      await pending;
    });
    displayed = structuredClone(state);
    await render();
    expect(control.draft.value.networkAllowlist).toBe("newer.example");
    expect(control.draft.isDirty).toBe(true);
    expect(control.draft.baseRevision).toBe(42);
    expect(api.settled).not.toHaveBeenCalled();
  });
});
