// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord, LlamaCppSetupProjection } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { __resetLlamaSetupForTests, rememberLlamaPlan, type LlamaSetupChange } from "./llama-setup-state";
import { useLlamaSetup } from "./use-llama-setup";
import {
  awaitingLlamaApproval,
  deferredLlama,
  llamaPlanFixture,
  llamaProjectionFixture,
} from "./llama-setup.test-support";
const api = vi.hoisted(() => ({
  fetchLlamaCppSetup: vi.fn(),
  previewLlmModels: vi.fn(),
  stageLlamaCppManagedSelection: vi.fn(),
  createChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  fetchChangePlan: vi.fn(),
  fetchApprovalReplay: vi.fn(),
  respondToChangePlan: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
const owner = vi.hoisted(() => ({ base: "fixture-gateway" }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => owner.base }));
let root: Root,
  control: ReturnType<typeof useLlamaSetup>,
  workspaceId: string,
  projection: LlamaCppSetupProjection,
  plan: ChangePlanRecord;
function Probe() {
  control = useLlamaSetup(workspaceId);
  return null;
}
async function render(show = true) {
  await act(async () => root.render(<StrictMode>{show ? <Probe /> : null}</StrictMode>));
}
function choose(managed = false) {
  act(() =>
    control.setDraft({
      mode: managed ? "managed" : "external",
      baseUrl: projection.baseUrl,
      model: managed ? "Local Model.gguf" : "served-model",
    }),
  );
}
function review() {
  act(() => control.prepareReview());
}
async function confirm() {
  await act(async () => control.confirmReview());
}
beforeEach(async () => {
  vi.resetAllMocks();
  __resetLlamaSetupForTests();
  __resetSessionDraftsForTests();
  owner.base = "fixture-gateway";
  workspaceId = "workspace-a";
  projection = llamaProjectionFixture();
  plan = llamaPlanFixture();
  api.fetchLlamaCppSetup.mockImplementation(async () => structuredClone(projection));
  api.previewLlmModels.mockResolvedValue({ source: "live", items: [{ id: "served-model" }] });
  api.stageLlamaCppManagedSelection.mockResolvedValue({
    selectionId: "selection-1",
    modelId: "Local Model.gguf",
    alias: "Local-Model",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  api.createChangePlan.mockImplementation(
    async (input: { workspaceId: string; request: { change: LlamaSetupChange } }) => {
      plan = llamaPlanFixture(input.request.change, input.workspaceId);
      return structuredClone(plan);
    },
  );
  api.fetchChangePlan.mockImplementation(async () => structuredClone(plan));
  api.confirmChangePlan.mockImplementation(async () => {
    plan = awaitingLlamaApproval(plan);
    return structuredClone(plan);
  });
  root = createRoot(document.createElement("div"));
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  __resetSessionDraftsForTests();
  __resetLlamaSetupForTests();
});
describe("shared governed llama setup", () => {
  it("requires separate cancellable prepare and canonical confirmation with exact owner readback", async () => {
    choose();
    review();
    expect(api.createChangePlan).not.toHaveBeenCalled();
    act(() => control.cancelReview());
    await confirm();
    expect(api.createChangePlan).not.toHaveBeenCalled();
    review();
    await confirm();
    expect(api.createChangePlan).toHaveBeenCalledTimes(1);
    const setupReads = api.fetchLlamaCppSetup.mock.calls;
    const preflightSignal = setupReads.at(-1)?.[1];
    expect(preflightSignal).toBeInstanceOf(AbortSignal);
    expect(setupReads.slice(0, -1).every((call) => call[1] !== preflightSignal)).toBe(true);
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(control.plan?.status).toBe("awaiting_confirmation");
    expect(control.plan?.adapter).toEqual({ adapterId: "runtime-configuration", version: 2 });
    expect(control.draft.isDirty).toBe(true);
    act(() => control.confirmationReview());
    await confirm();
    expect(api.confirmChangePlan).toHaveBeenCalledExactlyOnceWith(
      "plan-1",
      { workspaceId },
      { expectedRevision: 1, actionNonce: "nonce-1" },
    );
    expect(control.plan?.status).toBe("awaiting_approval");
    expect(control.state.attempt).toBeUndefined();
    expect(api.respondToChangePlan).not.toHaveBeenCalled();
    expect(api.fetchApprovalReplay).not.toHaveBeenCalled();
  });
  it.each([
    { adapterId: "runtime_configuration", version: 1 },
    { adapterId: "runtime-configuration", version: 1 },
    { adapterId: "other-runtime", version: 2 },
  ])("withholds an obsolete or foreign recorded adapter $adapterId/$version", async (adapter) => {
    api.createChangePlan.mockResolvedValue({ ...plan, adapter });
    choose();
    review();
    await confirm();
    expect(api.createChangePlan).toHaveBeenCalledTimes(1);
    expect(control.plan).toBeUndefined();
    expect(control.state.attempt?.state).toBe("uncertain");
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
  });
  it("stages only a Gateway-discovered managed model and puts only opaque selection in the plan", async () => {
    choose(true);
    review();
    await confirm();
    expect(api.stageLlamaCppManagedSelection).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      modelId: "Local Model.gguf",
    });
    expect(api.createChangePlan).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      surface: "settings",
      request: {
        kind: "runtime_configuration",
        change: {
          operation: "llama_cpp_setup",
          managementMode: "managed",
          baseUrl: projection.baseUrl,
          model: "Local-Model",
          selectionId: "selection-1",
          autoStart: true,
        },
      },
    });
  });
  it.each(["expired", "wrong-model", "missing-selection"])(
    "withholds plan creation for %s managed custody receipt",
    async (kind) => {
      api.stageLlamaCppManagedSelection.mockResolvedValue({
        selectionId: kind === "missing-selection" ? "" : "selection-1",
        modelId: kind === "wrong-model" ? "other.gguf" : "Local Model.gguf",
        alias: "model",
        expiresAt: kind === "expired" ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
      });
      choose(true);
      review();
      await confirm();
      expect(api.createChangePlan).not.toHaveBeenCalled();
      expect(control.state.attempt?.state).toBe("uncertain");
    },
  );
  it.each(["stale", "fallback", "removed"])("does not prepare a model with %s live catalog evidence", async (kind) => {
    choose();
    review();
    api.previewLlmModels.mockResolvedValue({
      source: kind === "fallback" ? "error_fallback" : "live",
      catalogStatus: kind === "stale" ? "stale" : "fresh",
      items: [{ id: kind === "removed" ? "other" : "served-model" }],
    });
    await confirm();
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(control.state.attempt).toBeUndefined();
  });
  it("rejects changed settings before any write", async () => {
    choose();
    review();
    projection = { ...projection, settingsRevision: 9 };
    await confirm();
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(control.notice).toContain("changed");
  });
  it.each(["workspace-away-back", "draft-away-back", "unmount"])("cancels preflight after %s", async (kind) => {
    choose();
    review();
    const wait = deferredLlama<LlamaCppSetupProjection>();
    api.fetchLlamaCppSetup.mockReturnValueOnce(wait.promise);
    let run!: Promise<void>;
    act(() => {
      run = control.confirmReview();
    });
    if (kind === "workspace-away-back") {
      workspaceId = "workspace-b";
      await render();
      workspaceId = "workspace-a";
      await render();
    } else if (kind === "draft-away-back") {
      act(() => control.setDraft((value) => ({ ...value, model: "other" })));
      choose();
    } else await render(false);
    await act(async () => {
      wait.resolve(projection);
      await run;
    });
    expect(api.createChangePlan).not.toHaveBeenCalled();
  });
  it("does not create a plan if navigation occurs during managed custody staging", async () => {
    choose(true);
    review();
    const wait = deferredLlama<unknown>();
    api.stageLlamaCppManagedSelection.mockReturnValueOnce(wait.promise);
    let run!: Promise<void>;
    await act(async () => {
      run = control.confirmReview();
    });
    await render(false);
    await act(async () => {
      wait.resolve({
        selectionId: "sel",
        modelId: "Local Model.gguf",
        alias: "Local",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      await run;
    });
    await render();
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(control.state.attempt).toBeUndefined();
  });
  it("retains an unknown create outcome and public draft across workspace and shell remount", async () => {
    choose();
    review();
    api.createChangePlan.mockRejectedValueOnce(new Error("response lost"));
    await confirm();
    await render(false);
    workspaceId = "workspace-b";
    await render();
    expect(control.locked).toBe(true);
    workspaceId = "workspace-a";
    await render();
    expect(control.draft.value.model).toBe("served-model");
    review();
    await confirm();
    expect(api.createChangePlan).toHaveBeenCalledTimes(1);
  });
  it.each(["workspace", "request", "revision", "adapter"])("locks unexpected %s plan receipt", async (kind) => {
    const bad = {
      ...plan,
      ...(kind === "workspace" ? { origin: { ...plan.origin, workspaceId: "foreign" } } : {}),
      ...(kind === "request" ? { intentHash: "changed" } : {}),
      ...(kind === "revision" ? { target: { ...plan.target, expectedRevision: 0 } } : {}),
      ...(kind === "adapter" ? { adapter: { ...plan.adapter, version: 3 } } : {}),
    };
    api.createChangePlan.mockResolvedValueOnce(bad);
    if (kind === "request")
      api.fetchChangePlan.mockResolvedValueOnce({
        ...bad,
        request: {
          kind: "runtime_configuration",
          change: {
            operation: "llama_cpp_setup",
            managementMode: "external",
            baseUrl: projection.baseUrl,
            model: "foreign-model",
          },
        },
      });
    choose();
    review();
    await confirm();
    expect(control.state.attempt?.state).toBe("uncertain");
    expect(control.plan).toBeUndefined();
  });
  it("records a verified late create result in its original workspace without replacing another draft", async () => {
    choose();
    review();
    const wait = deferredLlama<ChangePlanRecord>();
    api.createChangePlan.mockReturnValueOnce(wait.promise);
    let run!: Promise<void>;
    await act(async () => {
      run = control.confirmReview();
    });
    workspaceId = "workspace-b";
    await render();
    choose(true);
    await act(async () => {
      wait.resolve(plan);
      await run;
    });
    expect(control.plan).toBeUndefined();
    expect(control.draft.value.mode).toBe("managed");
    expect(control.canPrepare).toBe(false);
    workspaceId = "workspace-a";
    await render();
    expect(control.plan?.planId).toBe("plan-1");
  });
  it("keeps writes unavailable until the projected pending plan is read", async () => {
    const wait = deferredLlama<ChangePlanRecord>();
    projection = { ...projection, pendingPlan: { planId: plan.planId, revision: 1, status: plan.status } };
    api.fetchChangePlan.mockReturnValueOnce(wait.promise);
    await act(async () => {
      void control.refresh();
    });
    choose();
    expect(control.canPrepare).toBe(false);
    await act(async () => wait.resolve(plan));
    expect(control.plan?.planId).toBe(plan.planId);
    expect(control.canPrepare).toBe(false);
  });
  it("keeps edited draft across a later owner refresh", async () => {
    choose();
    act(() => control.setDraft((value) => ({ ...value, baseUrl: "http://127.0.0.1:9900/v1" })));
    projection = { ...projection, settingsRevision: 9, baseUrl: "http://127.0.0.1:9990/v1" };
    await act(async () => control.refresh());
    expect(control.draft.value.baseUrl).toBe("http://127.0.0.1:9900/v1");
    expect(control.draft.hasRemoteChanges).toBe(true);
    expect(control.canPrepare).toBe(false);
  });
  it("ignores older plan reads and prevents a second workspace setup while recorded work is pending", async () => {
    act(() => rememberLlamaPlan(owner.base, awaitingLlamaApproval(plan)));
    act(() => rememberLlamaPlan(owner.base, plan));
    expect(control.plan?.revision).toBe(3);
    workspaceId = "workspace-b";
    await render();
    choose();
    expect(control.canPrepare).toBe(false);
    expect(control.state.pending?.workspaceId).toBe("workspace-a");
  });
  it("does not accept a foreign installation settlement", async () => {
    choose();
    review();
    const wait = deferredLlama<ChangePlanRecord>();
    api.fetchChangePlan.mockReturnValueOnce(wait.promise);
    let run!: Promise<void>;
    await act(async () => {
      run = control.confirmReview();
    });
    owner.base = "foreign";
    await act(async () => {
      wait.resolve(plan);
      await run;
    });
    owner.base = "fixture-gateway";
    await render();
    expect(control.state.attempt?.state).toBe("uncertain");
    expect(control.plan).toBeUndefined();
  });
  it("rejects a newer canonical plan before confirming an earlier review", async () => {
    act(() => rememberLlamaPlan(owner.base, plan));
    act(() => control.confirmationReview());
    plan = { ...plan, revision: 2 };
    await confirm();
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(control.state.attempt).toBeUndefined();
  });
  it.each(["lost", "unchanged", "foreign"])("retains unknown confirmation after %s receipt", async (kind) => {
    act(() => rememberLlamaPlan(owner.base, plan));
    act(() => control.confirmationReview());
    if (kind === "lost") api.confirmChangePlan.mockRejectedValueOnce(new Error("response lost"));
    else
      api.confirmChangePlan.mockResolvedValueOnce(
        kind === "unchanged" ? plan : { ...awaitingLlamaApproval(plan), planId: "foreign" },
      );
    await confirm();
    await render(false);
    await render();
    expect(control.state.attempt?.state).toBe("uncertain");
    expect(control.canConfirm).toBe(false);
    expect(api.confirmChangePlan).toHaveBeenCalledTimes(1);
  });
});
