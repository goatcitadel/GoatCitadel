import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChangePlanRecord, ChangePlanRuntimeConfigurationRequest } from "@goatcitadel/contracts";
import {
  ChangePlanRepository,
  createChangePlanSchema,
  createDatabase,
  type ChangePlanRepositoryCreateInput,
  type ChangePlanRepositoryListInput,
  type ChangePlanRepositoryTransitionInput,
} from "@goatcitadel/storage";
import {
  EvolutionControlPlaneAdapterRegistry,
  type EvolutionControlPlaneAdapter,
  type EvolutionControlPlaneAdapterContext,
  type EvolutionControlPlaneAdapterOutcome,
  type EvolutionControlPlaneOwnerInputReceipt,
} from "./evolution-control-plane-adapter.js";
import { EvolutionControlPlaneService } from "./evolution-control-plane-service.js";

const files: string[] = [];
const databases: Array<ReturnType<typeof createDatabase>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const file of files.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.rmSync(candidate, { force: true });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    }
  }
});

class TestAdapter implements EvolutionControlPlaneAdapter<ChangePlanRuntimeConfigurationRequest> {
  public readonly adapterId = "test-runtime-configuration";
  public readonly version = 1;
  public readonly kinds = ["runtime_configuration"] as const;
  public applyCount = 0;
  public rollbackCount = 0;
  public reconcileCount = 0;
  public mode: "confirmation" | "approval" | "secure" | "review_then_approval" = "confirmation";

  public async prepare(context: EvolutionControlPlaneAdapterContext) {
    if (this.mode === "secure") {
      return {
        target: { ownerId: "secure_owner", resourceId: "provider-openai", expectedRevision: 1 },
        title: "Connect provider",
        summary: "Collect the credential through the dedicated secure owner.",
        impact: "The credential never enters the Change Plan.",
        risk: "safe" as const,
        status: "awaiting_input" as const,
        requiredAction: context.actions.secureInput({
          targetId: "secure-field-openai",
          title: "Enter provider credential",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      };
    }
    return {
      target: { ownerId: "runtime_settings", resourceId: "budget_mode", expectedRevision: 1 },
      title: "Change budget mode",
      summary: "Set the bounded runtime budget mode.",
      impact: "New turns use the selected budget posture.",
      risk: this.mode === "review_then_approval" ? ("danger" as const) : ("safe" as const),
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({
        title: "Confirm budget mode",
        confirmationText: "Use balanced budget mode.",
      }),
      rollbackRefs: ["runtime-settings:snapshot:revision:1"],
    };
  }

  public async stage(context: EvolutionControlPlaneAdapterContext): Promise<EvolutionControlPlaneAdapterOutcome> {
    if (this.mode === "review_then_approval") {
      return {
        status: "awaiting_input",
        evidenceRefs: ["staged:manifest-1"],
        requiredAction: context.actions.artifactReview({
          title: "Review exact patch",
          artifactRefs: ["artifact:patch-1"],
        }),
      };
    }
    if (this.mode !== "approval") throw new Error("unexpected stage");
    return {
      status: "awaiting_approval",
      requiredAction: context.actions.approval({
        title: "Approve budget change",
        risk: "caution",
        approvalId: "approval-1",
      }),
    };
  }

  public shouldStage(plan: ChangePlanRecord): boolean {
    return this.mode !== "review_then_approval" || !plan.evidenceRefs.includes("staged:manifest-1");
  }

  public async reviewArtifacts(
    context: EvolutionControlPlaneAdapterContext,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    if (this.mode !== "review_then_approval") throw new Error("unexpected artifact review");
    return {
      status: "awaiting_confirmation",
      evidenceRefs: ["staged:manifest-1"],
      requiredAction: context.actions.confirmation({
        title: "Apply and restart",
        confirmationText: "Apply only the exact reviewed patch.",
      }),
    };
  }

  public async apply(): Promise<EvolutionControlPlaneAdapterOutcome> {
    this.applyCount += 1;
    return {
      status: "verifying",
      evidenceRefs: ["runtime-settings:revision:2"],
      result: { summary: "Owner write completed." },
    };
  }

  public async verify(): Promise<EvolutionControlPlaneAdapterOutcome> {
    return {
      status: "completed",
      evidenceRefs: ["runtime-settings:revision:2"],
      result: { summary: "Owner state matches." },
    };
  }

  public async reconcile() {
    this.reconcileCount += 1;
    return {
      effectObserved: false,
      status: "manual_required" as const,
      result: { summary: "Owner state is ambiguous; apply was not replayed." },
    };
  }

  public async rollback(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    this.rollbackCount += 1;
    if (plan.result?.failureCode !== "rollback_approval_pending") {
      return {
        status: "awaiting_approval",
        approvalRefs: ["approval-rollback"],
        requiredAction: context.actions.approval({
          title: "Approve exact rollback",
          risk: "caution",
          approvalId: "approval-rollback",
        }),
        result: { summary: "Rollback awaits fresh approval.", failureCode: "rollback_approval_pending" },
      };
    }
    return {
      status: "rolled_back",
      rollbackRefs: plan.rollbackRefs,
      result: { summary: "The exact snapshot was restored." },
    };
  }

  public async resumeOwnerInput(
    context: EvolutionControlPlaneAdapterContext,
    _plan: ChangePlanRecord,
    _receipt: EvolutionControlPlaneOwnerInputReceipt,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    return {
      status: "awaiting_confirmation",
      requiredAction: context.actions.confirmation({
        title: "Confirm connection",
        confirmationText: "Connect the verified provider.",
      }),
    };
  }
}

function fixture(mode: TestAdapter["mode"] = "confirmation") {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-evolution-service-${randomUUID()}.db`);
  files.push(dbPath);
  const database = createDatabase({ dbPath });
  createChangePlanSchema(database);
  databases.push(database);
  const sync = new ChangePlanRepository(database);
  const repository = {
    create: async (input: ChangePlanRepositoryCreateInput) => sync.create(input),
    get: async (planId: string) => sync.get(planId),
    list: async (input: ChangePlanRepositoryListInput) => sync.list(input),
    listActive: async (limit?: number) => sync.listActive(limit),
    transition: async (planId: string, input: ChangePlanRepositoryTransitionInput) => sync.transition(planId, input),
  };
  const adapter = new TestAdapter();
  adapter.mode = mode;
  if (mode !== "approval" && mode !== "review_then_approval")
    Object.defineProperty(adapter, "stage", { value: undefined });
  let approvalDisposition: "approved" | "pending" = "pending";
  const createApproval = vi.fn(async () => "approval-final");
  const service = new EvolutionControlPlaneService({
    repository,
    adapters: new EvolutionControlPlaneAdapterRegistry([adapter]),
    getApprovalDisposition: async () => approvalDisposition,
    createApproval,
  });
  return {
    service,
    adapter,
    sync,
    createApproval,
    approve: () => {
      approvalDisposition = "approved";
    },
  };
}

const actor = { workspaceId: "default", actorId: "operator-1", surface: "chat" as const, sessionId: "session-1" };
const request: ChangePlanRuntimeConfigurationRequest = {
  kind: "runtime_configuration",
  change: { operation: "budget_mode", mode: "balanced" },
};

describe("EvolutionControlPlaneService", () => {
  it("does not invoke the mutation owner before exact confirmation", async () => {
    const { service, adapter } = fixture();
    const plan = await service.create({ actor, request });
    expect(plan.status).toBe("awaiting_confirmation");
    expect(adapter.applyCount).toBe(0);

    const completed = await service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    expect(completed.status).toBe("completed");
    expect(adapter.applyCount).toBe(1);
    await expect(service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce)).rejects.toThrow(
      "changed elsewhere",
    );
    expect(adapter.applyCount).toBe(1);
  });

  it("shows workspace-unbound Settings plans in the current Chat without leaking other Chat plans", async () => {
    const { service } = fixture();
    const settingsPlan = await service.create({
      actor: { workspaceId: "default", actorId: "operator-1", surface: "settings" },
      request,
    });
    const listed = await service.list(actor, { sessionId: "session-1", limit: 12 });
    expect(listed.map((plan) => plan.planId)).toContain(settingsPlan.planId);
    expect(listed.find((plan) => plan.planId === settingsPlan.planId)?.origin.sessionId).toBeUndefined();
    expect((await service.get(actor, settingsPlan.planId)).planId).toBe(settingsPlan.planId);
    const completed = await service.confirm(
      actor,
      settingsPlan.planId,
      settingsPlan.revision,
      settingsPlan.requiredAction!.actionNonce,
    );
    expect(completed.status).toBe("completed");
  });

  it("does not expose a Chat-bound plan to a workspace-only Settings actor", async () => {
    const { service } = fixture();
    const chatPlan = await service.create({ actor, request });
    await expect(
      service.get({ workspaceId: "default", actorId: "operator-1", surface: "settings" }, chatPlan.planId),
    ).rejects.toThrow(/not found/iu);
  });

  it("re-reads canonical approval and refuses pending approval", async () => {
    const { service, adapter, approve } = fixture("approval");
    const plan = await service.create({ actor, request });
    const awaitingApproval = await service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    expect(awaitingApproval.status).toBe("awaiting_approval");
    expect(adapter.applyCount).toBe(0);

    await expect(service.resumeApproved(actor, plan.planId, awaitingApproval.revision, "approval-1")).rejects.toThrow(
      "not resolved",
    );
    approve();
    const completed = await service.resumeApproved(actor, plan.planId, awaitingApproval.revision, "approval-1");
    expect(completed.status).toBe("completed");
    expect(completed.approvalRefs).toContain("approval-1");
    expect(adapter.applyCount).toBe(1);
  });

  it("does not replay staging when an exact artifact review is followed by final confirmation", async () => {
    const { service, adapter, createApproval } = fixture("review_then_approval");
    const plan = await service.create({ actor, request });
    const staged = await service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    expect(staged.status).toBe("awaiting_input");
    expect(staged.requiredAction?.kind).toBe("artifact_review");
    const reviewed = await service.respond(actor, plan.planId, {
      expectedRevision: staged.revision,
      actionId: staged.requiredAction!.actionId,
      actionNonce: staged.requiredAction!.actionNonce,
      values: {},
    });
    expect(reviewed.status).toBe("awaiting_confirmation");
    const approval = await service.confirm(actor, plan.planId, reviewed.revision, reviewed.requiredAction!.actionNonce);
    expect(approval.status).toBe("awaiting_approval");
    expect(createApproval).toHaveBeenCalledOnce();
    expect(adapter.applyCount).toBe(0);
  });

  it("resumes dedicated secure input using only a sanitized owner receipt", async () => {
    const { service, adapter } = fixture("secure");
    const plan = await service.create({ actor, request });
    expect(plan.requiredAction?.kind).toBe("secure_input");
    const confirmation = await service.resumeOwnerInput(
      actor,
      plan.planId,
      plan.revision,
      plan.requiredAction!.actionNonce,
      {
        actionId: plan.requiredAction!.actionId,
        actionKind: "secure_input",
        ownerId: "secret_store",
        ownerResourceId: "reservation-1",
        ownerRevision: 1,
        evidenceRefs: ["provider-probe:ready"],
      },
    );
    expect(confirmation.status).toBe("awaiting_confirmation");
    expect(JSON.stringify(confirmation)).not.toMatch(/api.?key|password|credential-value/iu);
    expect(adapter.applyCount).toBe(0);
  });

  it("reconciles ambiguous in-flight state without replaying apply", async () => {
    const { service, adapter, sync } = fixture();
    const plan = await service.create({ actor, request });
    sync.transition(plan.planId, {
      expectedRevision: plan.revision,
      status: "applying",
      actionNonce: plan.requiredAction!.actionNonce,
      requiredAction: null,
    });
    const [reconciled] = await service.reconcileActive();
    expect(reconciled?.status).toBe("manual_required");
    expect(adapter.reconcileCount).toBe(1);
    expect(adapter.applyCount).toBe(0);
  });

  it("resumes an owner-governed rollback through its fresh canonical approval", async () => {
    const { service, adapter, approve } = fixture();
    const plan = await service.create({ actor, request });
    const completed = await service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    const requested = await service.requestRollback(actor, completed.planId, completed.revision);
    const awaitingApproval = await service.confirm(
      actor,
      requested.planId,
      requested.revision,
      requested.requiredAction!.actionNonce,
    );
    expect(awaitingApproval).toMatchObject({
      status: "awaiting_approval",
      result: { failureCode: "rollback_approval_pending" },
    });
    expect(adapter.rollbackCount).toBe(1);
    approve();
    const rolledBack = await service.resumeApproved(
      actor,
      awaitingApproval.planId,
      awaitingApproval.revision,
      "approval-rollback",
    );
    expect(rolledBack.status).toBe("rolled_back");
    expect(adapter.rollbackCount).toBe(2);
    expect(adapter.applyCount).toBe(1);
  });
});
