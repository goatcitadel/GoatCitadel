import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalReplaySnapshot, ChangePlanRecord } from "@goatcitadel/contracts";
import {
  __resetSettingsApprovalContinuationsForTests,
  useSettingsApprovalContinuation,
} from "./use-settings-approval-continuation";

const api = vi.hoisted(() => ({ plan: vi.fn(), approval: vi.fn(), respond: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlan: api.plan,
  fetchApprovalReplay: api.approval,
  respondToChangePlan: api.respond,
}));

function plan(): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "plan-budget",
    origin: { surface: "settings", workspaceId: "default" },
    adapter: { adapterId: "runtime_configuration", version: 1 },
    kind: "runtime_configuration",
    scope: "runtime",
    status: "awaiting_approval",
    phase: "authorization",
    revision: 3,
    request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode: "power" } },
    intentHash: "reviewed-intent",
    target: { ownerId: "runtime_settings", resourceId: "budget_mode", expectedRevision: 1 },
    title: "Budget preference",
    summary: "Approval required",
    impact: "Update installation preference",
    risk: "caution",
    requiredAction: {
      kind: "approval",
      approvalId: "approval-budget",
      actionId: "action-budget",
      actionNonce: "nonce-budget",
      title: "Approve preference",
      risk: "caution",
    },
    actionSnapshotHash: "awaiting-action",
    approvalRefs: ["approval-budget"],
    evidenceRefs: [],
    rollbackRefs: [],
    createdAt: "2026-09-30T10:00:00Z",
    updatedAt: "2026-09-30T10:01:00Z",
  };
}
function replay(): ApprovalReplaySnapshot {
  return {
    approval: {
      approvalId: "approval-budget",
      kind: "change_plan_effect",
      status: "approved",
      resolutionOutcome: "approved",
      riskLevel: "caution",
      payload: {
        planId: "plan-budget",
        kind: "runtime_configuration",
        scope: "runtime",
        intentHash: "reviewed-intent",
        targetOwnerId: "runtime_settings",
        targetResourceId: "budget_mode",
        targetRevision: 1,
        adapterId: "runtime_configuration",
        adapterVersion: 1,
        actionSnapshotHash: "staging-action",
      },
      linkage: { workspaceId: "default", actionType: "change_plan_effect" },
      preview: {},
      createdAt: "2026-09-30T10:00:00Z",
      explanationStatus: "not_requested",
    },
    events: [],
    effects: [],
  };
}
function receipt(): ChangePlanRecord {
  return {
    ...plan(),
    status: "completed",
    phase: "terminal",
    revision: 5,
    requiredAction: undefined,
    result: { summary: "Applied" },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("explicit Settings approval continuation", () => {
  let renderer: ReactTestRenderer;
  let control: ReturnType<typeof useSettingsApprovalContinuation>;
  const settled = vi.fn(async () => undefined);
  function Harness({
    reviewed = plan(),
    workspaceId = "default",
  }: {
    reviewed?: ChangePlanRecord;
    workspaceId?: string;
  }) {
    control = useSettingsApprovalContinuation({ plan: reviewed, workspaceId, onSettled: settled });
    return null;
  }
  async function mount(reviewed = plan()) {
    await act(async () => {
      renderer = create(<Harness reviewed={reviewed} />);
    });
  }
  async function resume() {
    let result = false;
    await act(async () => {
      result = await control.continueApproved();
    });
    return result;
  }
  beforeEach(() => {
    __resetSettingsApprovalContinuationsForTests();
    vi.clearAllMocks();
    api.plan.mockReset().mockResolvedValue(plan());
    api.approval.mockReset().mockResolvedValue(replay());
    api.respond.mockReset().mockResolvedValue(receipt());
    settled.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
  });

  it("does not mutate on mount and uses the exact twice-checked action and canonical approval", async () => {
    await mount();
    expect(api.plan).not.toHaveBeenCalled();
    expect(await resume()).toBe(true);
    expect(api.plan.mock.calls).toEqual([
      ["plan-budget", { workspaceId: "default" }],
      ["plan-budget", { workspaceId: "default" }],
    ]);
    expect(api.approval).toHaveBeenCalledWith("approval-budget");
    expect(api.respond).toHaveBeenCalledExactlyOnceWith(
      "plan-budget",
      { workspaceId: "default" },
      {
        expectedRevision: 3,
        actionId: "action-budget",
        actionNonce: "nonce-budget",
        values: {},
      },
    );
    expect(api.plan.mock.invocationCallOrder[0]).toBeLessThan(api.approval.mock.invocationCallOrder[0]!);
    expect(api.approval.mock.invocationCallOrder[0]).toBeLessThan(api.plan.mock.invocationCallOrder[1]!);
    expect(api.plan.mock.invocationCallOrder[1]).toBeLessThan(api.respond.mock.invocationCallOrder[0]!);
    expect(settled).toHaveBeenCalledOnce();
    expect(control.state).toBe("recorded");
    expect(control.message).not.toContain("saved and confirmed");
  });

  it("reports pending approval exactly, allows later explicit review, and never posts before approval", async () => {
    const pending = replay();
    pending.approval.status = "pending";
    pending.approval.resolutionOutcome = undefined;
    api.approval.mockResolvedValueOnce(pending);
    await mount();
    expect(await resume()).toBe(false);
    expect(control.message).toBe("The approval is not approved yet. Review the required approval first.");
    expect(api.respond).not.toHaveBeenCalled();
    expect(control.disabled).toBe(false);
    expect(await resume()).toBe(true);
  });

  it.each([
    [
      "wrong ID",
      (value: ApprovalReplaySnapshot) => {
        value.approval.approvalId = "foreign";
      },
    ],
    [
      "wrong workspace",
      (value: ApprovalReplaySnapshot) => {
        value.approval.linkage!.workspaceId = "foreign";
      },
    ],
    [
      "wrong kind",
      (value: ApprovalReplaySnapshot) => {
        value.approval.kind = "tool";
      },
    ],
    [
      "wrong plan",
      (value: ApprovalReplaySnapshot) => {
        value.approval.payload.planId = "foreign";
      },
    ],
    [
      "wrong plan kind",
      (value: ApprovalReplaySnapshot) => {
        value.approval.payload.kind = "session_model";
      },
    ],
    [
      "wrong target",
      (value: ApprovalReplaySnapshot) => {
        value.approval.payload.targetResourceId = "other";
      },
    ],
    [
      "wrong target revision",
      (value: ApprovalReplaySnapshot) => {
        value.approval.payload.targetRevision = 2;
      },
    ],
    [
      "wrong intent",
      (value: ApprovalReplaySnapshot) => {
        value.approval.payload.intentHash = "other";
      },
    ],
    [
      "wrong adapter",
      (value: ApprovalReplaySnapshot) => {
        value.approval.payload.adapterVersion = 2;
      },
    ],
    [
      "rejected",
      (value: ApprovalReplaySnapshot) => {
        value.approval.status = "rejected";
      },
    ],
    [
      "edited",
      (value: ApprovalReplaySnapshot) => {
        value.approval.status = "edited";
      },
    ],
    [
      "expired",
      (value: ApprovalReplaySnapshot) => {
        value.approval.resolutionOutcome = "expired";
      },
    ],
  ] as const)("rejects %s approval evidence without a response POST", async (_name, change) => {
    const value = replay();
    change(value);
    api.approval.mockResolvedValue(value);
    await mount();
    expect(await resume()).toBe(false);
    expect(api.respond).not.toHaveBeenCalled();
  });

  it.each(["first", "second"])("withholds a changed revision on the %s exact plan read", async (read) => {
    if (read === "second") api.plan.mockResolvedValueOnce(plan());
    api.plan.mockResolvedValueOnce({ ...plan(), revision: 4 });
    await mount();
    expect(await resume()).toBe(false);
    expect(api.respond).not.toHaveBeenCalled();
    expect(control.message).toContain("has changed");
  });

  it("rejects a changed nonce with an unchanged plan revision", async () => {
    const current = plan();
    api.plan
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, requiredAction: { ...current.requiredAction!, actionNonce: "other" } });
    await mount();
    expect(await resume()).toBe(false);
    expect(api.respond).not.toHaveBeenCalled();
  });

  it.each([
    ["rollback", { ...plan(), result: { summary: "Rollback", failureCode: "rollback_approval_pending" } }],
    ["foreign workspace", { ...plan(), origin: { surface: "settings" as const, workspaceId: "foreign" } }],
    ["non-approval action", { ...plan(), requiredAction: undefined }],
  ] as const)("does not offer %s continuation", async (_name, reviewed) => {
    await mount(reviewed);
    expect(control.visible).toBe(false);
    expect(await resume()).toBe(false);
    expect(api.plan).not.toHaveBeenCalled();
    expect(api.respond).not.toHaveBeenCalled();
  });

  it("accepts equivalent canonical object key order", async () => {
    const current = plan();
    api.plan.mockResolvedValue({
      ...current,
      target: { expectedRevision: 1, resourceId: "budget_mode", ownerId: "runtime_settings" },
    });
    await mount();
    expect(await resume()).toBe(true);
  });

  it.each(["unmount", "workspace", "plan"])(
    "cancels before dispatch after %s changes while approval is loading",
    async (change) => {
      const pending = deferred<ApprovalReplaySnapshot>();
      api.approval.mockReturnValue(pending.promise);
      await mount();
      let request!: Promise<boolean>;
      await act(async () => {
        request = control.continueApproved();
      });
      await act(async () => {
        if (change === "unmount") renderer.unmount();
        else
          renderer.update(
            <Harness
              workspaceId={change === "workspace" ? "other" : "default"}
              reviewed={change === "plan" ? { ...plan(), revision: 4 } : plan()}
            />,
          );
      });
      await act(async () => {
        pending.resolve(replay());
        expect(await request).toBe(false);
      });
      expect(api.respond).not.toHaveBeenCalled();
    },
  );

  it("locks duplicate clicks and remounts while dispatch is pending", async () => {
    const pending = deferred<ChangePlanRecord>();
    api.respond.mockReturnValue(pending.promise);
    await mount();
    let request!: Promise<boolean>;
    await act(async () => {
      request = control.continueApproved();
    });
    expect(control.state).toBe("submitted");
    expect(await resume()).toBe(false);
    await act(async () => renderer.unmount());
    await mount();
    expect(control.disabled).toBe(true);
    expect(await resume()).toBe(false);
    await act(async () => {
      pending.resolve(receipt());
      expect(await request).toBe(true);
    });
    expect(api.respond).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    expect(control.state).toBe("recorded");
  });

  it.each(["lost response", "foreign receipt", "unchanged receipt"])(
    "keeps %s locked across remount",
    async (outcome) => {
      if (outcome === "lost response") api.respond.mockRejectedValue(new Error("Network unavailable"));
      else
        api.respond.mockResolvedValue(
          outcome === "unchanged receipt"
            ? plan()
            : { ...receipt(), target: { ...plan().target, resourceId: "foreign" } },
        );
      await mount();
      expect(await resume()).toBe(false);
      expect(control.state).toBe("uncertain");
      await act(async () => renderer.unmount());
      await mount();
      expect(control.disabled).toBe(true);
      expect(await resume()).toBe(false);
      expect(api.respond).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
    },
  );

  it("keeps a valid receipt recorded when owner refresh fails", async () => {
    settled.mockRejectedValue(new Error("Readback offline"));
    await mount();
    expect(await resume()).toBe(true);
    expect(control.state).toBe("recorded");
    expect(control.message).toContain("could not be refreshed");
    await act(async () => renderer.unmount());
    await mount();
    expect(await resume()).toBe(false);
    expect(api.respond).toHaveBeenCalledOnce();
  });

  it("retains one explicit dispatch after StrictMode mount cleanup and reinitialization", async () => {
    await act(async () => {
      renderer = create(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });
    expect(api.respond).not.toHaveBeenCalled();
    expect(await resume()).toBe(true);
    expect(api.respond).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each(["first", "final"])("cancels an away/back scope transition during the %s plan read", async (read) => {
    const pending = deferred<ChangePlanRecord>();
    if (read === "final") api.plan.mockResolvedValueOnce(plan());
    api.plan.mockReturnValueOnce(pending.promise);
    await mount();
    let request!: Promise<boolean>;
    await act(async () => {
      request = control.continueApproved();
    });
    await act(async () => {
      renderer.update(<Harness workspaceId="other" />);
    });
    await act(async () => {
      renderer.update(<Harness workspaceId="default" />);
    });
    await act(async () => {
      pending.resolve(plan());
      expect(await request).toBe(false);
    });
    expect(api.respond).not.toHaveBeenCalled();
    expect(control.disabled).toBe(false);
    expect(await resume()).toBe(true);
    expect(api.respond).toHaveBeenCalledOnce();
  });
});
