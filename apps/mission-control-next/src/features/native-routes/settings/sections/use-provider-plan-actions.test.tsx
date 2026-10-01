// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { useProviderPlanActions } from "./use-provider-plan-actions";
import { __resetProviderMutationStateForTests } from "./provider-mutation-state";

const api = vi.hoisted(() => ({
  fetchChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  submitChangePlanProviderSecret: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
const plan: ChangePlanRecord = {
  schemaVersion: 1,
  planId: "fixture-plan",
  origin: { workspaceId: "default", surface: "settings" },
  adapter: { adapterId: "provider-connection", version: 3 },
  kind: "provider_connection",
  scope: "provider",
  status: "awaiting_confirmation",
  phase: "confirmation",
  revision: 2,
  intentHash: "fixture-intent",
  request: { kind: "provider_connection", providerId: "fixture" },
  target: { ownerId: "provider_connection", resourceId: "fixture" },
  title: "Connect",
  summary: "Review",
  impact: "Connection",
  risk: "safe",
  requiredAction: { kind: "confirmation", actionId: "fixture-action", actionNonce: "fixture-nonce", title: "Confirm", confirmationText: "Confirm this fixture profile." },
  approvalRefs: [],
  evidenceRefs: [],
  rollbackRefs: [],
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
};
const settled = { ...plan, revision: 3, status: "completed" as const, requiredAction: undefined };
const setNotice = vi.fn(),
  onAcknowledged = vi.fn(),
  onSettled = vi.fn(async (): Promise<void> => undefined);
let owner: ReturnType<typeof useProviderPlanActions>,
  root: Root,
  container: HTMLDivElement,
  current: ChangePlanRecord | null,
  view: string;
function Probe() {
  owner = useProviderPlanActions({
    plan: current,
    setPlan: (value) => {
      current = value;
    },
    setNotice,
    onAcknowledged,
    onSettled,
    viewIdentity: view,
  });
  return null;
}
const render = () =>
  act(async () => {
    root.render(<Probe />);
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetProviderMutationStateForTests();
  current = plan;
  view = "provider-a";
  api.fetchChangePlan.mockResolvedValue(plan);
  api.confirmChangePlan.mockResolvedValue(settled);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network in provider plan fixture");
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetProviderMutationStateForTests();
  vi.unstubAllGlobals();
});

describe("provider plan review continuation", () => {
  it("does not dispatch a retained plan after the operator leaves and returns during its owner read", async () => {
    const read = deferred<ChangePlanRecord>();
    api.fetchChangePlan.mockReturnValue(read.promise);
    await render();
    let task!: Promise<void>;
    await act(async () => {
      task = owner.confirm(plan);
    });
    view = "provider-b";
    await render();
    view = "provider-a";
    await render();
    await act(async () => {
      read.resolve(plan);
      await task;
    });
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(onAcknowledged).not.toHaveBeenCalled();
    expect(owner.mutation.pending).toBe(false);
    expect(owner.mutation.uncertain).toBeUndefined();
  });
  it("admits one exact reviewed confirmation and blocks an ambiguous result after remount", async () => {
    const read = deferred<ChangePlanRecord>();
    api.fetchChangePlan.mockReturnValue(read.promise);
    api.confirmChangePlan.mockRejectedValue(new Error("Lost reply"));
    await render();
    let task!: Promise<void>;
    await act(async () => {
      task = owner.confirm(plan);
      await owner.confirm(plan);
    });
    expect(api.fetchChangePlan).toHaveBeenCalledOnce();
    await act(async () => {
      read.resolve(plan);
      await task;
    });
    await act(async () => root.render(<p>Other view</p>));
    await render();
    await act(async () => {
      await owner.confirm(plan);
    });
    expect(api.confirmChangePlan).toHaveBeenCalledExactlyOnceWith(
      plan.planId,
      { workspaceId: "default", sessionId: undefined, turnId: undefined },
      { expectedRevision: 2, actionNonce: "fixture-nonce" },
    );
    expect(owner.mutation.uncertain).toBeTruthy();
  });
  it("keeps acknowledged truth when the following display refresh fails", async () => {
    onSettled.mockRejectedValue(new Error("Read failed"));
    await render();
    await act(async () => {
      await owner.confirm(plan);
    });
    expect(onAcknowledged).toHaveBeenCalledWith(settled);
    expect(current).toBeNull();
    expect(setNotice).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining("acknowledged") }),
    );
    expect(owner.mutation.uncertain).toBeUndefined();
  });
});
