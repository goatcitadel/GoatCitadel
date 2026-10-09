// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord, LlamaCppSetupProjection } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { __resetLlamaSetupForTests, rememberLlamaPlan, type LlamaSetupChange } from "./llama-setup-state";
import { useLlamaSetup } from "./use-llama-setup";
import { freshReadsActive } from "@goatcitadel/mission-control-shared/api/fresh-reads";
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
// Each owner write reports the attempt it dispatched, as the real capture would for its Gateway route.
const attempts = vi.hoisted(() => ({ paths: [] as string[], read: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => owner.base,
  captureMutationAttempt: (dispatch: () => Promise<unknown>, onAttempt: (attempt: unknown) => void) => {
    const path = attempts.paths.shift();
    if (path) onAttempt({ attemptKey: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", method: "POST", path });
    return dispatch();
  },
}));
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMutationAttempt: attempts.read,
}));
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
  attempts.paths.length = 0;
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
      idempotencyKey: expect.stringMatching(/^llama-setup:[0-9a-f-]{36}$/),
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
  async function checkOutcome() {
    await act(async () => {
      await control.checkOutcome();
    });
  }
  it("settles a lost confirmation from the attempt record and the canonical plan", async () => {
    choose();
    review();
    await confirm();
    act(() => control.confirmationReview());
    attempts.paths.push("/api/v1/change-plans/plan-1/confirmations");
    api.confirmChangePlan.mockImplementationOnce(async () => {
      plan = awaitingLlamaApproval(plan);
      throw new Error("response lost");
    });
    await confirm();
    expect(control.state.attempt).toMatchObject({
      state: "uncertain",
      transport: { routePattern: "/api/v1/change-plans/:planId/confirmations" },
    });
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    await checkOutcome();
    expect(control.state.attempt).toBeUndefined();
    expect(control.plan?.status).toBe("awaiting_approval");
    expect(control.notice).toMatch(/recorded this setup confirmation as processed/);
    expect(api.confirmChangePlan).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost plan create by replaying its plan key only when the Gateway recorded it", async () => {
    choose();
    review();
    attempts.paths.push("/api/v1/change-plans");
    const create = api.createChangePlan.getMockImplementation()!;
    api.createChangePlan.mockRejectedValueOnce(new Error("response lost"));
    await confirm();
    expect(control.state.attempt?.state).toBe("uncertain");
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    api.createChangePlan.mockImplementation(create);
    await checkOutcome();
    expect(api.createChangePlan).toHaveBeenCalledTimes(2);
    const [first, replay] = api.createChangePlan.mock.calls.map(([input]) => input);
    expect(first.idempotencyKey).toMatch(/^llama-setup:[0-9a-f-]{36}$/);
    expect(replay).toEqual(first);
    expect(control.state.attempt).toBeUndefined();
    expect(control.plan?.status).toBe("awaiting_confirmation");
  });
  it("never replays a released plan create", async () => {
    choose();
    review();
    attempts.paths.push("/api/v1/change-plans");
    api.createChangePlan.mockRejectedValueOnce(new Error("response lost"));
    await confirm();
    attempts.read.mockResolvedValue({ status: "failed", claimExpired: false });
    await checkOutcome();
    expect(api.createChangePlan).toHaveBeenCalledTimes(1);
    expect(control.state.attempt).toBeUndefined();
    expect(control.notice).toMatch(/not replayed/);
  });
  it.each([
    [{ status: "pending", claimExpired: false }, /still running/],
    [{ status: "absent" }, /no record/],
  ])("keeps the setup lock for %o", async (record, message) => {
    choose();
    review();
    attempts.paths.push("/api/v1/change-plans");
    api.createChangePlan.mockRejectedValueOnce(new Error("response lost"));
    await confirm();
    attempts.read.mockResolvedValue(record);
    await checkOutcome();
    expect(control.state.attempt?.state).toBe("uncertain");
    expect(control.state.attempt?.message).toMatch(message);
    expect(api.createChangePlan).toHaveBeenCalledTimes(1);
  });
  it("keeps the setup lock when the attempt read fails, with fixed copy", async () => {
    choose();
    review();
    attempts.paths.push("/api/v1/change-plans");
    api.createChangePlan.mockRejectedValueOnce(new Error("response lost"));
    await confirm();
    attempts.read.mockRejectedValue(new Error("API error 403: gateway-internal-detail"));
    await checkOutcome();
    expect(control.state.attempt?.state).toBe("uncertain");
    expect(control.state.attempt?.message).toMatch(/check failed/);
    expect(control.state.attempt?.message).not.toContain("gateway-internal-detail");
  });
  it("never reads, replays or adopts against a different Gateway installation", async () => {
    choose();
    review();
    attempts.paths.push("/api/v1/change-plans");
    api.createChangePlan.mockRejectedValueOnce(new Error("response lost"));
    await confirm();
    owner.base = "other-gateway";
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    await checkOutcome();
    owner.base = "fixture-gateway";
    await render();
    expect(attempts.read).not.toHaveBeenCalled();
    expect(api.createChangePlan).toHaveBeenCalledTimes(1);
    expect(control.state.attempt?.state).toBe("uncertain");
    expect(control.state.attempt?.message).toMatch(/different Gateway/);
  });
  it("keeps the lock when the Gateway changes while a released create's setup is read back", async () => {
    choose();
    review();
    attempts.paths.push("/api/v1/change-plans");
    api.createChangePlan.mockRejectedValueOnce(new Error("response lost"));
    await confirm();
    attempts.read.mockResolvedValue({ status: "failed", claimExpired: false });
    let switchDuringRead = true;
    api.fetchLlamaCppSetup.mockImplementation(async () => {
      if (switchDuringRead) owner.base = "other-gateway";
      switchDuringRead = false;
      return structuredClone(projection);
    });
    await checkOutcome();
    owner.base = "fixture-gateway";
    await render();
    expect(control.state.attempt?.state).toBe("uncertain");
    expect(control.state.attempt?.message).toMatch(/different Gateway/);
    expect(control.notice ?? "").not.toMatch(/not replayed/);
  });
  it("keeps the lock when a lost replay is released, because the original plan may exist", async () => {
    choose();
    review();
    attempts.paths.push("/api/v1/change-plans");
    api.createChangePlan.mockRejectedValueOnce(new Error("response lost"));
    await confirm();
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    attempts.paths.push("/api/v1/change-plans");
    api.createChangePlan.mockRejectedValueOnce(new Error("replay response lost"));
    await checkOutcome();
    expect(api.createChangePlan).toHaveBeenCalledTimes(2);
    expect(control.state.attempt?.state).toBe("uncertain");
    attempts.read.mockResolvedValue({ status: "failed", claimExpired: false });
    await checkOutcome();
    expect(api.createChangePlan).toHaveBeenCalledTimes(2);
    expect(control.state.attempt?.state).toBe("uncertain");
    expect(control.state.attempt?.message).toMatch(/original plan may exist/);
    expect(control.notice ?? "").not.toMatch(/not replayed/);
  });
  it("re-reads the plan fresh when settling a lost confirmation", async () => {
    choose();
    review();
    await confirm();
    act(() => control.confirmationReview());
    attempts.paths.push("/api/v1/change-plans/plan-1/confirmations");
    api.confirmChangePlan.mockImplementationOnce(async () => {
      plan = awaitingLlamaApproval(plan);
      throw new Error("response lost");
    });
    await confirm();
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    let fresh = false;
    api.fetchChangePlan.mockImplementation(async () => {
      fresh = freshReadsActive();
      return structuredClone(plan);
    });
    await checkOutcome();
    expect(fresh).toBe(true);
  });
  it("offers no outcome check for a setup write it could not identify", async () => {
    choose();
    review();
    api.createChangePlan.mockRejectedValueOnce(new Error("response lost"));
    await confirm();
    expect(control.state.attempt?.transport).toBeUndefined();
    await checkOutcome();
    expect(attempts.read).not.toHaveBeenCalled();
    expect(control.state.attempt?.state).toBe("uncertain");
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
