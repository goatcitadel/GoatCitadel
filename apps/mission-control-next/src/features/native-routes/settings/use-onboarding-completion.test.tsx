// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@goatcitadel/contracts";
import { onboardingFixture } from "./onboarding.test-support";
import { __resetOnboardingAttemptsForTests } from "./onboarding-completion-state";
import { useOnboardingCompletion } from "./use-onboarding-completion";

const api = vi.hoisted(() => ({ fetchOnboardingState: vi.fn(), completeOnboarding: vi.fn(), base: "owner" }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => api.base }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: Root, owner: OnboardingState, displayed: OnboardingState;
let control: ReturnType<typeof useOnboardingCompletion>;
function Probe({ scope, requireModel }: { scope: string; requireModel: boolean }) {
  control = useOnboardingCompletion({ state: displayed, scope, requireModel, requireSafeMode: requireModel });
  return null;
}
async function render(scope = "native", requireModel = true) {
  await act(async () =>
    root.render(
      <StrictMode>
        <Probe scope={scope} requireModel={requireModel} />
      </StrictMode>,
    ),
  );
}
function markComplete() {
  owner = { ...owner, completed: true, completedAt: "2026-09-30T12:00:00.000Z", completedBy: "operator" };
  return { state: structuredClone(owner) };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.base = "owner";
  owner = onboardingFixture();
  displayed = structuredClone(owner);
  api.fetchOnboardingState.mockImplementation(async () => structuredClone(owner));
  api.completeOnboarding.mockImplementation(async () => markComplete());
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  __resetOnboardingAttemptsForTests();
});

describe("shared onboarding completion marker", () => {
  it("requires a fresh review and independent marker readback without certifying inference", async () => {
    await render();
    let result: OnboardingState | null = null;
    await act(async () => {
      result = await control.complete();
    });
    expect(api.completeOnboarding).toHaveBeenCalledExactlyOnceWith("operator");
    expect(api.fetchOnboardingState).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ completed: true, firstTask: { status: "not_observed" } });
    expect(control.locked).toBe(false);
  });
  it("uses an already recorded marker without writing it again", async () => {
    markComplete();
    await render();
    await act(async () => control.complete());
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(control.locked).toBe(false);
  });
  it("does not count generated-at refresh metadata as a settings change", async () => {
    owner.setupReadiness!.generatedAt = "2026-10-01T00:00:00.000Z";
    await render();
    await act(async () => control.complete());
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
  });
  it.each(["revision", "model", "approval", "readiness"] as const)(
    "withholds completion after %s changes",
    async (kind) => {
      await render();
      if (kind === "revision") owner.settings.revision += 1;
      if (kind === "model") owner.settings.llm.activeModel = "different";
      if (kind === "approval") owner.settings.toolApprovalMode = "bypass";
      if (kind === "readiness") owner.setupReadiness!.items[0]!.status = "unknown";
      await act(async () => control.complete());
      expect(api.completeOnboarding).not.toHaveBeenCalled();
      expect(control.notice).toContain("Setup changed");
      expect(control.locked).toBe(false);
    },
  );
  it("preserves explicit classic marker semantics while native setup requires model readiness", async () => {
    owner.settings.llm.activeModel = "";
    displayed = structuredClone(owner);
    await render();
    expect(control.ready).toBe(false);
    await act(async () => control.complete());
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    await render("classic", false);
    await act(async () => control.complete());
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
  });
  it.each(["unmount", "scope-away-back", "installation"] as const)("cancels preflight on %s", async (kind) => {
    await render();
    const read = deferred<OnboardingState>();
    api.fetchOnboardingState.mockReturnValueOnce(read.promise);
    let pending!: Promise<OnboardingState | null>;
    await act(async () => {
      pending = control.complete();
    });
    if (kind === "unmount") await act(async () => root.render(null));
    if (kind === "scope-away-back") {
      await render("other");
      await render("native");
    }
    if (kind === "installation") api.base = "other";
    await act(async () => {
      read.resolve(owner);
      expect(await pending).toBeNull();
    });
    expect(api.completeOnboarding).not.toHaveBeenCalled();
  });
  it("does not navigate a new scope after the old dispatched request settles", async () => {
    await render();
    const write = deferred<{ state: OnboardingState }>();
    api.completeOnboarding.mockReturnValueOnce(write.promise);
    let pending!: Promise<OnboardingState | null>;
    await act(async () => {
      pending = control.complete();
    });
    await render("classic");
    expect(control.locked).toBe(true);
    await act(async () => control.complete());
    await act(async () => {
      write.resolve(markComplete());
      expect(await pending).toBeNull();
    });
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    expect(control.locked).toBe(false);
  });
  it("retains a lost response across shells and remounts", async () => {
    api.completeOnboarding.mockRejectedValue(new Error("response lost"));
    await render();
    await act(async () => control.complete());
    await act(async () => root.render(null));
    await render("classic", false);
    expect(control.attempt?.phase).toBe("unknown");
    await act(async () => control.complete());
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
  });
  it.each(["missing-marker", "actor", "settings", "readback", "installation"] as const)(
    "locks uncertain %s receipts",
    async (kind) => {
      api.completeOnboarding.mockImplementation(async () => {
        const receipt = markComplete();
        if (kind === "missing-marker") receipt.state.completedAt = undefined;
        if (kind === "actor") receipt.state.completedBy = "someone-else";
        if (kind === "settings") receipt.state.settings.revision += 1;
        if (kind === "readback") owner.completedAt = "2026-10-01T00:00:00.000Z";
        if (kind === "installation") api.base = "other";
        return receipt;
      });
      await render();
      await act(async () => control.complete());
      if (kind === "installation") {
        api.base = "owner";
        await render();
      }
      expect(control.attempt?.phase).toBe("unknown");
      expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    },
  );
});
