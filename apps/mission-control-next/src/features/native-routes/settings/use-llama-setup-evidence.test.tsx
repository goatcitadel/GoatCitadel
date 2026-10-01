// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord, LlamaCppSetupProjection } from "@goatcitadel/contracts";
import { useLlamaSetupEvidence } from "./use-llama-setup-evidence";
import { __resetLlamaSetupForTests, useLlamaSetupState } from "./llama-setup-state";
import { awaitingLlamaApproval, deferredLlama, llamaPlanFixture, llamaProjectionFixture } from "./llama-setup.test-support";
const api = vi.hoisted(() => ({ fetchLlamaCppSetup: vi.fn(), fetchChangePlan: vi.fn() }));
const owner = vi.hoisted(() => ({ installation: "fixture-gateway" }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => owner.installation }));
let root: Root, evidence: ReturnType<typeof useLlamaSetupEvidence>, state: ReturnType<typeof useLlamaSetupState>;
function Probe({ workspaceId }: { workspaceId: string }) {
  evidence = useLlamaSetupEvidence(workspaceId);
  state = useLlamaSetupState(owner.installation, workspaceId);
  return null;
}
const render = async (workspaceId = "workspace-a") => {
  await act(async () => root.render(<Probe workspaceId={workspaceId} />));
};
beforeEach(() => {
  vi.resetAllMocks();
  __resetLlamaSetupForTests();
  owner.installation = "fixture-gateway";
  root = createRoot(document.createElement("div"));
  api.fetchLlamaCppSetup.mockResolvedValue(llamaProjectionFixture());
});
afterEach(() => { act(() => root.unmount()); __resetLlamaSetupForTests(); });
describe("llama setup evidence request ownership", () => {
  it("aborts an older read and never lets its pending projection replace the fresh cancellation", async () => {
    const older = deferredLlama<LlamaCppSetupProjection>();
    api.fetchLlamaCppSetup.mockReturnValueOnce(older.promise);
    await render();
    const oldSignal = api.fetchLlamaCppSetup.mock.calls[0]![1] as AbortSignal;
    expect(oldSignal).toBeInstanceOf(AbortSignal);
    const cancelled: ChangePlanRecord = { ...llamaPlanFixture(), revision: 4, status: "cancelled", phase: "terminal", requiredAction: undefined };
    const current: LlamaCppSetupProjection = { ...llamaProjectionFixture(), recentPlan: { planId: cancelled.planId, revision: 4, status: "cancelled" } };
    api.fetchLlamaCppSetup.mockResolvedValueOnce(current);
    api.fetchChangePlan.mockResolvedValueOnce(cancelled);
    await act(async () => evidence.refresh());
    const freshSignal = api.fetchLlamaCppSetup.mock.calls[1]![1] as AbortSignal;
    expect(oldSignal.aborted).toBe(true);
    expect(freshSignal).not.toBe(oldSignal);
    expect(freshSignal.aborted).toBe(false);
    expect(evidence.projection).toEqual(current);
    expect(evidence.loading).toBe(false);
    expect(state.entry?.plan).toEqual(cancelled);
    expect(state.pending).toBeUndefined();
    // Even a transport that finishes despite abort cannot restore the older projection or plan.
    const pending = awaitingLlamaApproval(llamaPlanFixture());
    await act(async () => older.resolve({ ...llamaProjectionFixture(), pendingPlan: { planId: pending.planId, revision: pending.revision, status: pending.status } }));
    expect(evidence.projection).toEqual(current);
    expect(evidence.error).toBeUndefined();
    expect(state.entry?.plan).toEqual(cancelled);
    expect(api.fetchChangePlan).toHaveBeenCalledExactlyOnceWith(cancelled.planId, { workspaceId: "workspace-a" });
  });
  it("rejects a retained scope callback before it can abort or replace the current read, including ABA", async () => {
    await render();
    const oldRefresh = evidence.refresh;
    const pendingB = deferredLlama<LlamaCppSetupProjection>();
    api.fetchLlamaCppSetup.mockReturnValueOnce(pendingB.promise);
    await render("workspace-b");
    const bSignal = api.fetchLlamaCppSetup.mock.calls.at(-1)![1] as AbortSignal;
    const reads = api.fetchLlamaCppSetup.mock.calls.length;
    await act(async () => oldRefresh());
    expect(api.fetchLlamaCppSetup).toHaveBeenCalledTimes(reads);
    expect(bSignal.aborted).toBe(false);
    await render("workspace-a");
    expect(bSignal.aborted).toBe(true);
    expect(evidence.loading).toBe(false);
    const afterReturn = api.fetchLlamaCppSetup.mock.calls.length;
    await act(async () => oldRefresh());
    expect(api.fetchLlamaCppSetup).toHaveBeenCalledTimes(afterReturn);
    expect(evidence.loading).toBe(false);
    await act(async () => pendingB.resolve({ ...llamaProjectionFixture(), settingsRevision: 99 }));
    expect(evidence.projection?.settingsRevision).toBe(8);
  });
  it("aborts its owned transport on unmount and rejects dynamic installation changes before reading", async () => {
    const pending = deferredLlama<LlamaCppSetupProjection>();
    api.fetchLlamaCppSetup.mockReturnValueOnce(pending.promise);
    await render();
    const signal = api.fetchLlamaCppSetup.mock.calls[0]![1] as AbortSignal;
    const refresh = evidence.refresh;
    owner.installation = "other-gateway";
    await act(async () => refresh());
    expect(api.fetchLlamaCppSetup).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(llamaProjectionFixture()));
    await act(async () => refresh());
    expect(api.fetchLlamaCppSetup).toHaveBeenCalledTimes(1);
    expect(api.fetchChangePlan).not.toHaveBeenCalled();
  });
});
