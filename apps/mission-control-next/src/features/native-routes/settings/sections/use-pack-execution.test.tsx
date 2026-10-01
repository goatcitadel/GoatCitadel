import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { CapabilityPackManifest, ChangePlanRecord } from "@goatcitadel/contracts";
import { usePackExecution } from "./use-pack-execution";
import { usePackPlanAction } from "./use-pack-plan-action";
import { __resetPackAttemptsForTests } from "./pack-mutation-state";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { packManifest, packPreview, packPlan, approvedPack } from "./pack-execution.test-support";
import { packChildItem } from "./pack-plan-presentation";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  verify: vi.fn(),
  rollback: vi.fn(),
  respond: vi.fn(),
  approval: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlans: api.list,
  fetchChangePlan: api.get,
  fetchCapabilityPackPreview: api.preview,
  createChangePlan: api.create,
  confirmChangePlan: api.confirm,
  cancelChangePlan: api.cancel,
  verifyChangePlan: api.verify,
  requestChangePlanRollback: api.rollback,
  respondToChangePlan: api.respond,
  fetchApprovalReplay: api.approval,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://fixture",
}));
let renderer: ReactTestRenderer | undefined,
  execution: ReturnType<typeof usePackExecution>,
  action: ReturnType<typeof usePackPlanAction>,
  saved: ChangePlanRecord;
const updated = vi.fn();
function Execution({
  workspace = "a",
  manifest = packManifest,
}: {
  workspace?: string;
  manifest?: CapabilityPackManifest;
}) {
  execution = usePackExecution(manifest, workspace);
  return null;
}
function Action({ plan = saved, workspace = "a" }: { plan?: ChangePlanRecord; workspace?: string }) {
  action = usePackPlanAction(plan, workspace, updated);
  return null;
}
async function mount(view: React.ReactNode) {
  await act(async () => {
    renderer = create(<StrictMode>{view}</StrictMode>);
  });
}
async function replace(view: React.ReactNode) {
  await act(async () => renderer!.update(<StrictMode>{view}</StrictMode>));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetPackAttemptsForTests();
  __resetSessionDraftsForTests();
  saved = packPlan();
  api.list.mockResolvedValue({ items: [] });
  api.get.mockImplementation(async () => saved);
  api.preview.mockResolvedValue(packPreview);
  api.create.mockImplementation(async () => saved);
  api.confirm.mockImplementation(async () => {
    saved = { ...saved, revision: 2, status: "monitoring", phase: "monitoring", requiredAction: undefined };
    return saved;
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});
it("creates only after explicit review with exact manifest/assets/workspace and independent readback", async () => {
  await mount(<Execution />);
  expect(api.create).not.toHaveBeenCalled();
  await act(async () => execution.reviewSetup());
  expect(execution.review).not.toBeNull();
  await act(async () => {
    await execution.confirmSetup();
  });
  expect(api.create).toHaveBeenCalledWith({ workspaceId: "a", surface: "settings", request: saved.request });
  expect(api.get).toHaveBeenCalledWith("plan", { workspaceId: "a" });
  expect(execution.parents).toEqual([saved]);
  expect(api.confirm).not.toHaveBeenCalled();
});
it.each(["scope", "away-back", "cancel", "selection", "unmount"])("cancels setup preflight on %s", async (timing) => {
  await mount(<Execution />);
  await act(async () => execution.reviewSetup());
  const wait = deferred<typeof packPreview>();
  api.preview.mockReturnValueOnce(wait.promise);
  let task!: Promise<boolean>;
  await act(async () => {
    task = execution.confirmSetup();
  });
  if (timing === "scope" || timing === "away-back") {
    await replace(<Execution workspace="b" />);
    if (timing === "away-back") await replace(<Execution />);
  }
  if (timing === "cancel") await act(async () => execution.cancelReview());
  if (timing === "selection") await act(async () => execution.setSelected([]));
  if (timing === "unmount")
    await act(async () => {
      renderer!.unmount();
      renderer = undefined;
    });
  await act(async () => {
    wait.resolve(packPreview);
    await task;
  });
  expect(api.create).not.toHaveBeenCalled();
});
it("withholds changed definitions and local manifests", async () => {
  await mount(<Execution />);
  await act(async () => execution.reviewSetup());
  api.preview.mockResolvedValue({ ...packPreview, manifest: { ...packManifest, version: "changed" } });
  await act(async () => {
    await execution.confirmSetup();
  });
  expect(api.create).not.toHaveBeenCalled();
  await replace(
    <Execution manifest={{ ...packManifest, provenance: { ...packManifest.provenance, source: "local_file" } }} />,
  );
  expect(execution.ready).toBe(false);
});
it("locks uncertain creation across remount and changed manifest instead of repeating", async () => {
  api.create.mockRejectedValue(new Error("Lost response"));
  await mount(<Execution />);
  await act(async () => execution.reviewSetup());
  await act(async () => {
    await execution.confirmSetup();
  });
  await act(async () => renderer!.unmount());
  await mount(<Execution manifest={{ ...packManifest, version: "changed" }} />);
  expect(execution.attempt.phase).toBe("uncertain");
  expect(execution.ready).toBe(false);
  expect(api.create).toHaveBeenCalledTimes(1);
});
it("reads linked exact child IDs without verifying or approving and withholds foreign children", async () => {
  const parent = packPlan({ status: "monitoring", requiredAction: undefined, evidenceRefs: ["change_plan:child"] });
  api.list.mockResolvedValue({ items: [parent] });
  const child = packPlan({
    planId: "child",
    kind: "capability_candidate",
    request: { kind: "capability_candidate", proposalId: "proposal" },
    evidenceRefs: ["capability_proposal:proposal"],
  });
  api.get.mockResolvedValue(child);
  await mount(<Execution />);
  expect(execution.children).toEqual([child]);
  expect(packChildItem(child)).toBe("capability_proposal:proposal");
  expect(api.verify).not.toHaveBeenCalled();
  expect(api.respond).not.toHaveBeenCalled();
  api.get.mockResolvedValue({ ...child, origin: { ...child.origin, workspaceId: "foreign" } });
  await act(async () => execution.refresh());
  expect(execution.parents).toEqual([]);
  expect(execution.children).toEqual([]);
  expect(execution.error).toContain("withheld");
});
it("confirms exact current nonce/revision once after reviewed fresh owner read", async () => {
  await mount(<Action />);
  await act(async () => action.request("confirm"));
  expect(action.review).not.toBeNull();
  await act(async () => {
    await Promise.all([action.confirm(), action.confirm()]);
  });
  expect(api.confirm).toHaveBeenCalledTimes(1);
  expect(api.confirm).toHaveBeenCalledWith(
    "plan",
    { workspaceId: "a" },
    { expectedRevision: 1, actionNonce: "nonce-one" },
  );
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(updated).toHaveBeenCalledTimes(1);
});
it.each(["revision", "action", "request"])("withholds changed %s before plan write", async (field) => {
  await mount(<Action />);
  await act(async () => action.request("confirm"));
  saved =
    field === "revision"
      ? { ...saved, revision: 2 }
      : field === "action"
        ? {
            ...saved,
            requiredAction: {
              kind: "confirmation",
              actionId: "changed",
              actionNonce: "changed",
              title: "Changed",
              confirmationText: "Changed",
            },
          }
        : {
            ...saved,
            request: { kind: "capability_pack", packId: "pack", manifestHash: "f".repeat(64), assetIds: ["asset"] },
          };
  await act(async () => action.confirm());
  expect(api.confirm).not.toHaveBeenCalled();
  expect(action.attempt.phase).toBe("idle");
});
it.each(["scope", "away-back", "cancel", "unmount"])("cancels pending action preflight on %s", async (timing) => {
  await mount(<Action />);
  await act(async () => action.request("confirm"));
  const wait = deferred<ChangePlanRecord>();
  api.get.mockReturnValueOnce(wait.promise);
  let task!: Promise<void>;
  await act(async () => {
    task = action.confirm();
  });
  if (timing === "scope" || timing === "away-back") {
    await replace(<Action workspace="b" />);
    if (timing === "away-back") await replace(<Action />);
  }
  if (timing === "cancel") await act(async () => action.cancel());
  if (timing === "unmount")
    await act(async () => {
      renderer!.unmount();
      renderer = undefined;
    });
  await act(async () => {
    wait.resolve(saved);
    await task;
  });
  expect(api.confirm).not.toHaveBeenCalled();
});
it("retains action uncertainty across remount even if fresh owner shows a later result", async () => {
  api.confirm.mockRejectedValue(new Error("Lost response"));
  await mount(<Action />);
  await act(async () => action.request("confirm"));
  await act(async () => action.confirm());
  await act(async () => renderer!.unmount());
  saved = { ...saved, revision: 2 };
  await mount(<Action />);
  expect(action.attempt.phase).toBe("uncertain");
  await act(async () => action.request("confirm"));
  expect(action.review).toBeNull();
  expect(api.confirm).toHaveBeenCalledTimes(1);
});
it("does not confirm foreign receipts or mismatched independent readback", async () => {
  api.confirm.mockResolvedValue({ ...saved, planId: "foreign", revision: 2, requiredAction: undefined });
  await mount(<Action />);
  await act(async () => action.request("confirm"));
  await act(async () => action.confirm());
  expect(action.attempt.phase).toBe("uncertain");
  expect(updated).not.toHaveBeenCalled();
});
it("separates read refresh from explicit verification and uses current monitoring revision", async () => {
  saved = packPlan({ status: "monitoring", requiredAction: undefined, revision: 5 });
  api.verify.mockImplementation(
    async () => (saved = { ...saved, revision: 6, status: "completed", phase: "terminal" }),
  );
  await mount(<Action />);
  expect(api.verify).not.toHaveBeenCalled();
  await act(async () => action.request("verify"));
  await act(async () => action.confirm());
  expect(api.verify).toHaveBeenCalledWith("plan", { workspaceId: "a" }, 5);
  expect(updated).toHaveBeenCalledTimes(1);
});
it.each(["pending", "foreign", "payload", "refused"])(
  "requires exact approved binding (%s) with zero resume",
  async (mode) => {
    saved = packPlan({
      status: "awaiting_approval",
      approvalRefs: ["approval"],
      requiredAction: {
        kind: "approval",
        actionId: "resume",
        actionNonce: "resume-nonce",
        title: "Approval",
        risk: "danger",
        approvalId: "approval",
      },
    });
    const replay = approvedPack(saved);
    if (mode === "pending") replay.approval.status = "pending";
    if (mode === "foreign") replay.approval.linkage!.workspaceId = "b";
    if (mode === "payload") replay.approval.payload.intentHash = "f".repeat(64);
    if (mode === "refused") replay.approval.resolutionOutcome = "delivery_failed";
    api.approval.mockResolvedValue(replay);
    await mount(<Action />);
    await act(async () => action.request("continue"));
    await act(async () => action.confirm());
    expect(api.respond).not.toHaveBeenCalled();
    expect(action.attempt.phase).toBe("idle");
  },
);
it("resumes a bound approved rollback only explicitly and rechecks plan after approval", async () => {
  saved = packPlan({
    status: "awaiting_approval",
    approvalRefs: ["approval"],
    requiredAction: {
      kind: "approval",
      actionId: "resume",
      actionNonce: "resume-nonce",
      title: "Rollback approval",
      risk: "danger",
      approvalId: "approval",
    },
    result: { summary: "Waiting", failureCode: "rollback_approval_pending" },
  });
  api.approval.mockResolvedValue(approvedPack(saved));
  api.respond.mockImplementation(
    async () =>
      (saved = { ...saved, revision: 2, status: "rolled_back", phase: "terminal", requiredAction: undefined }),
  );
  await mount(<Action />);
  await act(async () => action.request("continue"));
  expect(api.respond).not.toHaveBeenCalled();
  await act(async () => action.confirm());
  expect(api.respond).toHaveBeenCalledWith(
    "plan",
    { workspaceId: "a" },
    { expectedRevision: 1, actionId: "resume", actionNonce: "resume-nonce", values: {} },
  );
  expect(api.get).toHaveBeenCalledTimes(3);
  expect(updated).toHaveBeenCalledTimes(1);
});
it("requests rollback review without applying and cancels exact pending action", async () => {
  saved = packPlan({ status: "completed", requiredAction: undefined, rollbackRefs: ["recorded:rollback"] });
  api.rollback.mockImplementation(
    async () =>
      (saved = {
        ...saved,
        status: "awaiting_confirmation",
        revision: 2,
        requiredAction: {
          kind: "confirmation",
          purpose: "rollback",
          actionId: "rollback",
          actionNonce: "rollback-nonce",
          title: "Rollback",
          confirmationText: "Revert",
        },
      }),
  );
  await mount(<Action />);
  await act(async () => action.request("rollback"));
  await act(async () => action.confirm());
  expect(api.rollback).toHaveBeenCalledWith("plan", { workspaceId: "a" }, 1);
  expect(api.confirm).not.toHaveBeenCalled();
  await replace(<Action />);
  api.cancel.mockImplementation(
    async () => (saved = { ...saved, status: "cancelled", requiredAction: undefined, revision: 3 }),
  );
  await act(async () => action.request("cancel"));
  await act(async () => action.confirm());
  expect(api.cancel).toHaveBeenCalledWith(
    "plan",
    { workspaceId: "a" },
    { expectedRevision: 2, actionNonce: "rollback-nonce" },
  );
});

it("keeps owner verification, cancellation and rollback review available after plan expiry", async () => {
  const expiresAt = "2000-01-01T00:00:00Z";
  saved = packPlan({ expiresAt });
  await mount(<Action />);
  expect(action.actions).toEqual(["cancel"]);
  saved = packPlan({ expiresAt, status: "monitoring", requiredAction: undefined });
  await replace(<Action />);
  expect(action.actions).toEqual(["verify"]);
  saved = packPlan({ expiresAt, status: "completed", requiredAction: undefined, rollbackRefs: ["rollback:one"] });
  await replace(<Action />);
  expect(action.actions).toEqual(["rollback"]);
});
it("honors canonical approved disposition independently of its old request expiration", async () => {
  saved = packPlan({
    status: "awaiting_approval",
    approvalRefs: ["approval"],
    requiredAction: {
      kind: "approval",
      actionId: "resume",
      actionNonce: "nonce",
      title: "Approval",
      risk: "danger",
      approvalId: "approval",
    },
  });
  const replay = approvedPack(saved);
  replay.approval.expiresAt = "2000-01-01T00:00:00Z";
  api.approval.mockResolvedValue(replay);
  api.respond.mockImplementation(
    async () => (saved = { ...saved, revision: 2, status: "monitoring", requiredAction: undefined }),
  );
  await mount(<Action />);
  await act(async () => action.request("continue"));
  await act(async () => action.confirm());
  expect(api.respond).toHaveBeenCalledTimes(1);
  expect(updated).toHaveBeenCalledTimes(1);
});
