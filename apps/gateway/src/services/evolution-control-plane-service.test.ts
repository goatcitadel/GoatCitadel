import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { eventFor as operatorApprovalSkipEventFor } from "./evolution-control-plane-operator-approval-skip.js";

const SAVE = { operatorSettingsSave: true } as const;
const files: string[] = [];
const databases: Array<ReturnType<typeof createDatabase>> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
  for (const file of files.splice(0)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

class TestAdapter implements EvolutionControlPlaneAdapter<ChangePlanRuntimeConfigurationRequest> {
  public readonly adapterId = "test-runtime-configuration";
  public readonly version = 1;
  public readonly kinds = ["runtime_configuration"] as const;
  public applyCount = 0;
  public rollbackCount = 0;
  public reconcileCount = 0;
  public discardCount = 0;
  public discardError?: Error;
  public mode: "confirmation" | "approval" | "secure" | "review_then_approval" = "confirmation";

  public async discard(): Promise<void> {
    this.discardCount += 1;
    if (this.discardError) throw this.discardError;
  }

  public async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanRuntimeConfigurationRequest) {
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
      risk:
        this.mode === "review_then_approval"
          ? ("danger" as const)
          : request.change.operation === "network_allowlist" ||
              request.change.operation === "gateway_auth_configuration"
            ? ("danger" as const)
            : request.change.operation === "llama_cpp_setup" || request.change.operation === "feature_flag"
              ? ("caution" as const)
              : ("safe" as const),
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

function fixture(
  mode: TestAdapter["mode"] = "confirmation",
  extra: Pick<ConstructorParameters<typeof EvolutionControlPlaneService>[0], "allowsOperatorApprovalSkip"> = {},
) {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-evolution-service-")), "test.db");
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
    listAwaitingApproval: async (approvalId: string, limit?: number) => sync.listAwaitingApproval(approvalId, limit),
    transition: async (planId: string, input: ChangePlanRepositoryTransitionInput) => sync.transition(planId, input),
  };
  const adapter = new TestAdapter();
  adapter.mode = mode;
  if (mode !== "approval" && mode !== "review_then_approval")
    Object.defineProperty(adapter, "stage", { value: undefined });
  let approvalDisposition: "approved" | "pending" | "denied" | "expired" | undefined = "pending";
  const createApproval = vi.fn(async () => "approval-final");
  const getApprovalDisposition = vi.fn(async () => approvalDisposition);
  const service = new EvolutionControlPlaneService({
    repository,
    adapters: new EvolutionControlPlaneAdapterRegistry([adapter]),
    getApprovalDisposition,
    createApproval,
    ...extra,
  });
  return {
    service,
    adapter,
    sync,
    createApproval,
    repository,
    getApprovalDisposition,
    approve: () => {
      approvalDisposition = "approved";
    },
    disposition: (value: typeof approvalDisposition) => {
      approvalDisposition = value;
    },
  };
}

const actor = { workspaceId: "default", actorId: "operator-1", surface: "chat" as const, sessionId: "session-1" };
const request: ChangePlanRuntimeConfigurationRequest = {
  kind: "runtime_configuration",
  change: { operation: "budget_mode", mode: "balanced" },
};

describe("EvolutionControlPlaneService", () => {
  it("rejects a stale cancellation nonce before adapter discard or any plan transition", async () => {
    const f = fixture();
    const plan = await f.service.create({ actor, request });
    const beforeEvents = f.sync.listEvents(plan.planId);
    const transition = vi.spyOn(f.repository, "transition");

    await expect(f.service.cancel(actor, plan.planId, plan.revision, "stale-action-nonce")).rejects.toThrow(
      "nonce is missing or stale",
    );

    expect(f.adapter.discardCount).toBe(0);
    expect(f.adapter.applyCount).toBe(0);
    expect(transition).not.toHaveBeenCalled();
    expect(await f.service.get(actor, plan.planId)).toEqual(plan);
    expect(f.sync.listEvents(plan.planId)).toEqual(beforeEvents);
  });

  it.each(["explicit", "omitted"] as const)(
    "preserves cancellation with a current or compatibility %s action nonce",
    async (mode) => {
      const f = fixture();
      const plan = await f.service.create({ actor, request });
      const transition = vi.spyOn(f.repository, "transition");

      const cancelled =
        mode === "omitted"
          ? await f.service.cancel(actor, plan.planId, plan.revision)
          : await f.service.cancel(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);

      expect(cancelled.status).toBe("cancelled");
      expect(f.adapter.discardCount).toBe(1);
      expect(f.adapter.applyCount).toBe(0);
      expect(transition).toHaveBeenCalledExactlyOnceWith(
        plan.planId,
        expect.objectContaining({
          expectedRevision: plan.revision,
          status: "cancelled",
          actionNonce: plan.requiredAction!.actionNonce,
        }),
      );
      expect(f.sync.listEvents(plan.planId).filter((event) => event.eventType === "cancelled")).toHaveLength(1);
    },
  );

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

  it.each(["denied", "expired"] as const)(
    "settles a %s approval during resume without applying the effect",
    async (decision) => {
      const f = fixture("approval");
      const plan = await f.service.create({ actor, request });
      const waiting = await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
      f.disposition(decision);
      const settled = await f.service.resumeApproved(actor, plan.planId, waiting.revision, "approval-1");
      expect(settled).toMatchObject({
        status: decision === "denied" ? "cancelled" : "failed",
        result: { failureCode: `approval_${decision}` },
        revision: waiting.revision + 1,
      });
      expect(settled.requiredAction).toBeUndefined();
      expect(settled.approvalRefs).toContain("approval-1");
      expect(f.adapter.applyCount).toBe(0);
      expect(f.adapter.rollbackCount).toBe(0);
      expect(f.adapter.discardCount).toBe(1);
      expect(f.sync.listActive()).toEqual([]);
    },
  );

  it("retains a refused wait for retry when its temporary-input cleanup owner is unavailable", async () => {
    const f = fixture("approval");
    const plan = await f.service.create({ actor, request });
    const waiting = await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    f.disposition("denied");
    f.adapter.discardError = new Error("temporary input cleanup unavailable");
    await expect(f.service.reconcileApproval("approval-1")).rejects.toThrow("temporary input cleanup unavailable");
    expect(await f.service.get(actor, plan.planId)).toMatchObject({
      status: "awaiting_approval",
      revision: waiting.revision,
    });
    f.adapter.discardError = undefined;
    expect(await f.service.reconcileApproval("approval-1")).toBe(1);
    expect(await f.service.reconcileApproval("approval-1")).toBe(0);
    expect(f.adapter.discardCount).toBe(2);
    expect(f.adapter.applyCount).toBe(0);
  });

  it.each(["denied", "expired"] as const)(
    "reconciles a %s child approval on restart without replaying activation",
    async (decision) => {
      const f = fixture("approval");
      const plan = await f.service.create({ actor, request });
      await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
      f.disposition(decision);
      const [settled] = await f.service.reconcileActive();
      expect(settled).toMatchObject({
        status: decision === "denied" ? "cancelled" : "failed",
        result: { failureCode: `approval_${decision}` },
      });
      expect(f.adapter.applyCount).toBe(0);
      expect(f.adapter.reconcileCount).toBe(0);
      expect(await f.service.reconcileActive()).toEqual([]);
    },
  );

  it("settles through the durable resolution callback and converges concurrent replays on one event", async () => {
    const f = fixture("approval");
    const plan = await f.service.create({ actor, request });
    const waiting = await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    f.disposition("denied");
    expect(await f.service.reconcileApproval("unrelated-approval")).toBe(0);
    expect((await f.service.get(actor, plan.planId)).revision).toBe(waiting.revision);
    await Promise.all([f.service.reconcileApproval("approval-1"), f.service.reconcileApproval("approval-1")]);
    const settled = await f.service.get(actor, plan.planId);
    expect(settled.status).toBe("cancelled");
    expect(settled.revision).toBe(waiting.revision + 1);
    expect(f.sync.listEvents(plan.planId).filter((event) => event.eventType === "approval_denied")).toHaveLength(1);
    expect(await f.service.reconcileApproval("approval-1")).toBe(0);
    expect(f.adapter.applyCount).toBe(0);
    expect(f.adapter.reconcileCount).toBe(0);
  });

  it.each(["pending", "approved", undefined] as const)(
    "keeps %s approval waiting without automatic apply or invented refusal",
    async (decision) => {
      const f = fixture("approval");
      const plan = await f.service.create({ actor, request });
      const waiting = await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
      f.disposition(decision);
      expect(await f.service.reconcileApproval("approval-1")).toBe(0);
      expect(await f.service.reconcileActive()).toEqual([]);
      expect(await f.service.get(actor, plan.planId)).toEqual(waiting);
      expect(f.adapter.applyCount).toBe(0);
    },
  );

  it("resumes an approved llama.cpp setup once from the durable signal and on startup", async () => {
    const setupRequest: ChangePlanRuntimeConfigurationRequest = {
      kind: "runtime_configuration",
      change: {
        operation: "llama_cpp_setup",
        managementMode: "external",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "local-model",
      },
    };
    const signalled = fixture();
    const first = await signalled.service.create({ actor, request: setupRequest });
    const waiting = await signalled.service.confirm(
      actor,
      first.planId,
      first.revision,
      first.requiredAction!.actionNonce,
    );
    expect(waiting.status).toBe("awaiting_approval");
    signalled.approve();
    await Promise.all([
      signalled.service.reconcileApproval("approval-final"),
      signalled.service.reconcileApproval("approval-final"),
    ]);
    expect((await signalled.service.get(actor, first.planId)).status).toBe("completed");
    expect(signalled.adapter.applyCount).toBe(1);
    expect(await signalled.service.reconcileApproval("approval-final")).toBe(0);

    const restarted = fixture();
    const second = await restarted.service.create({ actor, request: setupRequest });
    await restarted.service.confirm(actor, second.planId, second.revision, second.requiredAction!.actionNonce);
    restarted.approve();
    expect((await restarted.service.reconcileActive())[0]?.status).toBe("completed");
    expect(restarted.adapter.applyCount).toBe(1);
    expect(await restarted.service.reconcileActive()).toEqual([]);
  });

  it("applies an approved Settings switch once the approval is decided, with no separate Continue step (#496)", async () => {
    const settingsActor = { workspaceId: "default", actorId: "operator-1", surface: "settings" as const };
    const flagRequest: ChangePlanRuntimeConfigurationRequest = {
      kind: "runtime_configuration",
      change: { operation: "feature_flag", flag: "claudeCliWarmContinuationEnabled", enabled: false },
    };
    const f = fixture();
    const plan = await f.service.create({ actor: settingsActor, request: flagRequest });
    const waiting = await f.service.confirm(
      settingsActor,
      plan.planId,
      plan.revision,
      plan.requiredAction!.actionNonce,
      {
        operatorSettingsSave: true,
      },
    );
    expect(waiting.status).toBe("awaiting_approval");
    f.approve();
    await f.service.reconcileApproval("approval-final");
    expect((await f.service.get(settingsActor, plan.planId)).status).toBe("completed");
    expect(f.adapter.applyCount).toBe(1);
  });

  it("keeps a plan that only claims the Settings surface waiting for its continuation", async () => {
    // The generic create route accepts a caller-chosen surface; only the server-owned Settings save binds auto-apply.
    const settingsActor = { workspaceId: "default", actorId: "operator-1", surface: "settings" as const };
    const f = fixture();
    const plan = await f.service.create({
      actor: settingsActor,
      request: {
        kind: "runtime_configuration",
        change: { operation: "network_allowlist", entries: ["192.168.0.199:3002"] },
      },
    });
    const waiting = await f.service.confirm(
      settingsActor,
      plan.planId,
      plan.revision,
      plan.requiredAction!.actionNonce,
    );
    expect(waiting.evidenceRefs).not.toContain("operator-save:settings");
    f.approve();
    expect(await f.service.reconcileApproval("approval-final")).toBe(0);
    expect(await f.service.get(settingsActor, plan.planId)).toEqual(waiting);
    expect(f.adapter.applyCount).toBe(0);
  });

  it("applies any approved Settings runtime change once the approval is decided, with no separate Continue step", async () => {
    const settingsActor = { workspaceId: "default", actorId: "operator-1", surface: "settings" as const };
    const allowlistRequest: ChangePlanRuntimeConfigurationRequest = {
      kind: "runtime_configuration",
      change: { operation: "network_allowlist", entries: ["api.openai.com", "192.168.0.199:3002"] },
    };
    const f = fixture();
    const plan = await f.service.create({ actor: settingsActor, request: allowlistRequest });
    const waiting = await f.service.confirm(
      settingsActor,
      plan.planId,
      plan.revision,
      plan.requiredAction!.actionNonce,
      {
        operatorSettingsSave: true,
      },
    );
    expect(waiting.evidenceRefs).toContain("operator-save:settings");
    f.approve();
    await f.service.reconcileApproval("approval-final");
    expect((await f.service.get(settingsActor, plan.planId)).status).toBe("completed");
    expect(f.adapter.applyCount).toBe(1);
  });

  it("keeps an approved Settings authentication change waiting for its credential continuation", async () => {
    const settingsActor = { workspaceId: "default", actorId: "operator-1", surface: "settings" as const };
    const f = fixture();
    const plan = await f.service.create({
      actor: settingsActor,
      request: {
        kind: "runtime_configuration",
        change: { operation: "gateway_auth_configuration", mode: "token", allowLoopbackBypass: false },
      },
    });
    const waiting = await f.service.confirm(
      settingsActor,
      plan.planId,
      plan.revision,
      plan.requiredAction!.actionNonce,
      {
        operatorSettingsSave: true,
      },
    );
    f.approve();
    expect(await f.service.reconcileApproval("approval-final")).toBe(0);
    expect(await f.service.get(settingsActor, plan.planId)).toEqual(waiting);
    expect(f.adapter.applyCount).toBe(0);
  });

  it("keeps a 'settings' plan bound to a conversation waiting for its continuation", async () => {
    // The create route accepts a caller-chosen surface; a plan carrying Chat linkage is not a Settings switch.
    const linked = {
      workspaceId: "default",
      actorId: "operator-1",
      surface: "settings" as const,
      sessionId: "session-1",
    };
    const f = fixture();
    const plan = await f.service.create({
      actor: linked,
      request: {
        kind: "runtime_configuration",
        change: { operation: "feature_flag", flag: "claudeCliWarmContinuationEnabled", enabled: false },
      },
    });
    await f.service.confirm(linked, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    f.approve();
    expect(await f.service.reconcileApproval("approval-final")).toBe(0);
    expect(f.adapter.applyCount).toBe(0);
  });

  it("keeps an approved Chat-proposed switch waiting for its Chat continuation", async () => {
    const f = fixture();
    const plan = await f.service.create({
      actor,
      request: {
        kind: "runtime_configuration",
        change: { operation: "feature_flag", flag: "claudeCliWarmContinuationEnabled", enabled: false },
      },
    });
    const waiting = await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    f.approve();
    expect(await f.service.reconcileApproval("approval-final")).toBe(0);
    expect(await f.service.get(actor, plan.planId)).toEqual(waiting);
    expect(f.adapter.applyCount).toBe(0);
  });

  it.each(["denied", "expired"] as const)("never applies a %s llama.cpp setup", async (decision) => {
    const f = fixture();
    const plan = await f.service.create({
      actor,
      request: {
        kind: "runtime_configuration",
        change: {
          operation: "llama_cpp_setup",
          managementMode: "external",
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "local-model",
        },
      },
    });
    await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    f.disposition(decision);
    expect((await f.service.reconcileActive())[0]?.status).toBe(decision === "denied" ? "cancelled" : "failed");
    expect(f.adapter.applyCount).toBe(0);
  });

  it("settles a refusal that committed before the parent persisted its approval wait", async () => {
    const f = fixture("approval");
    const plan = await f.service.create({ actor, request });
    f.disposition("denied");
    expect(await f.service.reconcileApproval("approval-1")).toBe(0);
    const settled = await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    expect(settled.status).toBe("cancelled");
    expect(settled.requiredAction).toBeUndefined();
    expect(f.adapter.applyCount).toBe(0);
  });

  it("does not overwrite a concurrent cancellation or settle a different approval binding", async () => {
    const f = fixture("approval");
    const plan = await f.service.create({ actor, request });
    const waiting = await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    f.disposition("denied");
    await expect(f.service.resumeApproved(actor, plan.planId, waiting.revision, "other-approval")).rejects.toThrow(
      "binding changed",
    );
    await expect(
      f.service.resumeApproved({ ...actor, workspaceId: "elsewhere" }, plan.planId, waiting.revision, "approval-1"),
    ).rejects.toThrow("not found");
    f.getApprovalDisposition.mockImplementationOnce(async () => {
      await f.service.cancel(actor, plan.planId, waiting.revision);
      return "denied";
    });
    const settled = await f.service.resumeApproved(actor, plan.planId, waiting.revision, "approval-1");
    expect(settled.status).toBe("cancelled");
    expect(f.sync.listEvents(plan.planId).filter((event) => event.eventType === "approval_denied")).toEqual([]);
    expect(f.adapter.applyCount).toBe(0);
  });

  it("leaves canonical waiting state intact when approval lookup is unavailable", async () => {
    const f = fixture("approval");
    const plan = await f.service.create({ actor, request });
    const waiting = await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    f.getApprovalDisposition.mockRejectedValueOnce(new Error("approval owner offline"));
    await expect(f.service.reconcileApproval("approval-1")).rejects.toThrow("approval owner offline");
    expect(await f.service.get(actor, plan.planId)).toEqual(waiting);
    expect(f.adapter.applyCount).toBe(0);
  });

  it("does not apply a plan whose own deadline elapsed after canonical approval", async () => {
    const f = fixture("approval");
    const plan = await f.service.create({ actor, request });
    const waiting = await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
    f.approve();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(waiting.expiresAt!) + 1000);
    const settled = await f.service.resumeApproved(actor, plan.planId, waiting.revision, "approval-1");
    expect(settled).toMatchObject({ status: "failed", result: { failureCode: "expired" } });
    expect(f.adapter.applyCount).toBe(0);
  });

  it.each(["denied", "expired"] as const)(
    "preserves the existing effect when rollback approval is %s",
    async (decision) => {
      const f = fixture();
      const plan = await f.service.create({ actor, request });
      const completed = await f.service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce);
      const requested = await f.service.requestRollback(actor, completed.planId, completed.revision);
      const waiting = await f.service.confirm(
        actor,
        requested.planId,
        requested.revision,
        requested.requiredAction!.actionNonce,
      );
      f.disposition(decision);
      await f.service.reconcileApproval("approval-rollback");
      expect(await f.service.get(actor, plan.planId)).toMatchObject({
        status: "manual_required",
        result: { failureCode: `rollback_approval_${decision}` },
      });
      expect(f.adapter.applyCount).toBe(1);
      expect(f.adapter.rollbackCount).toBe(1);
      expect(f.adapter.discardCount).toBe(0);
      expect((await f.service.get(actor, plan.planId)).appliedAt).toBe(completed.appliedAt);
      expect(waiting.status).toBe("awaiting_approval");
    },
  );

  describe("operator Settings and Capabilities approval skip", () => {
    const settingsActor = { workspaceId: "default", actorId: "operator-1", surface: "settings" as const };
    const capabilitiesActor = { workspaceId: "default", actorId: "operator-1", surface: "capabilities" as const };
    const flagRequest: ChangePlanRuntimeConfigurationRequest = {
      kind: "runtime_configuration",
      change: { operation: "feature_flag", flag: "codeModeV1Enabled", enabled: true },
    };

    it("applies a confirmed caution plan with no approval when the Settings save asks and the owner allows it", async () => {
      const allowsOperatorApprovalSkip = vi.fn(async () => true);
      const { service, adapter, createApproval, sync } = fixture("confirmation", { allowsOperatorApprovalSkip });
      const plan = await service.create({ actor: settingsActor, request: flagRequest });
      expect(plan.risk).toBe("caution");

      const settled = await service.confirm(
        settingsActor,
        plan.planId,
        plan.revision,
        plan.requiredAction!.actionNonce,
        { operatorSettingsSave: true },
      );

      expect(settled.status).toBe("completed");
      expect(createApproval).not.toHaveBeenCalled();
      expect(adapter.applyCount).toBe(1);
      expect(allowsOperatorApprovalSkip).toHaveBeenCalledWith(expect.objectContaining({ planId: plan.planId }));
      expect(sync.listEvents(plan.planId)).toContainEqual(
        expect.objectContaining({
          eventType: "operator_approval_skipped",
          actorId: "operator-1",
          payload: { risk: "caution", reason: "settings_approval_skip_enabled" },
        }),
      );
    });

    it("still asks for approval when the owner does not allow the skip", async () => {
      const { service, adapter, createApproval } = fixture("confirmation", {
        allowsOperatorApprovalSkip: async () => false,
      });
      const plan = await service.create({ actor: settingsActor, request: flagRequest });

      const waiting = await service.confirm(
        settingsActor,
        plan.planId,
        plan.revision,
        plan.requiredAction!.actionNonce,
        {
          operatorSettingsSave: true,
        },
      );

      expect(waiting.status).toBe("awaiting_approval");
      expect(createApproval).toHaveBeenCalledOnce();
      expect(adapter.applyCount).toBe(0);
    });

    it("never skips for a confirmation that did not come from the Settings save", async () => {
      const allowsOperatorApprovalSkip = vi.fn(async () => true);
      const { service, adapter } = fixture("confirmation", { allowsOperatorApprovalSkip });
      const plan = await service.create({ actor: settingsActor, request: flagRequest });

      const waiting = await service.confirm(
        settingsActor,
        plan.planId,
        plan.revision,
        plan.requiredAction!.actionNonce,
      );

      expect(waiting.status).toBe("awaiting_approval");
      expect(adapter.applyCount).toBe(0);
      expect(allowsOperatorApprovalSkip).not.toHaveBeenCalled();
    });

    it("never skips for a plan that started outside Settings", async () => {
      const allowsOperatorApprovalSkip = vi.fn(async () => true);
      const { service, adapter } = fixture("confirmation", { allowsOperatorApprovalSkip });
      const plan = await service.create({ actor, request: flagRequest });

      const waiting = await service.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce, {
        operatorSettingsSave: true,
      });

      expect(waiting.status).toBe("awaiting_approval");
      expect(adapter.applyCount).toBe(0);
      expect(allowsOperatorApprovalSkip).not.toHaveBeenCalled();
    });

    // R95: the Capabilities actions the skip covers are a connector install and a plugin install or uninstall (the real
    // installs are proven end to end in connector-install-change-plan-adapter.test.ts,
    // plugin-install-change-plan-adapter.test.ts and gateway-service.operator-approval-skip.test.ts).
    it("skips approval for a Capabilities connector or plugin install, and for no other Capabilities plan", async () => {
      const deps = { allowsOperatorApprovalSkip: vi.fn(async () => true) };
      const planOf = (kind: ChangePlanRecord["kind"], surface: ChangePlanRecord["origin"]["surface"]) =>
        ({ planId: "plan-1", kind, risk: "danger", origin: { surface, workspaceId: "default" } }) as ChangePlanRecord;

      for (const kind of ["connector_install", "plugin_install", "plugin_uninstall"] as const) {
        expect(await operatorApprovalSkipEventFor(planOf(kind, "capabilities"), SAVE, deps), kind).toEqual({
          eventType: "operator_approval_skipped",
          eventPayload: { risk: "danger", reason: "settings_approval_skip_enabled" },
        });
      }
      expect(await operatorApprovalSkipEventFor(planOf("runtime_configuration", "capabilities"), SAVE, deps)).toBe(
        undefined,
      );
      // A plugin plan from anywhere but Capabilities never asks for the skip.
      expect(await operatorApprovalSkipEventFor(planOf("plugin_install", "chat"), SAVE, deps)).toBe(undefined);
      // Settings keeps every kind it saves today.
      expect(await operatorApprovalSkipEventFor(planOf("runtime_configuration", "settings"), SAVE, deps)).toEqual(
        expect.objectContaining({ eventType: "operator_approval_skipped" }),
      );
      expect(deps.allowsOperatorApprovalSkip).toHaveBeenCalledTimes(4);
    });

    it("keeps the Inbox approval for a Capabilities plan that isn't a connector install", async () => {
      const allowsOperatorApprovalSkip = vi.fn(async () => true);
      const { service, adapter, createApproval } = fixture("confirmation", { allowsOperatorApprovalSkip });
      const plan = await service.create({ actor: capabilitiesActor, request: flagRequest });
      expect(plan.origin.surface).toBe("capabilities");

      const waiting = await service.confirm(
        capabilitiesActor,
        plan.planId,
        plan.revision,
        plan.requiredAction!.actionNonce,
        { operatorSettingsSave: true },
      );

      expect(waiting.status).toBe("awaiting_approval");
      expect(createApproval).toHaveBeenCalledOnce();
      expect(adapter.applyCount).toBe(0);
      expect(allowsOperatorApprovalSkip).not.toHaveBeenCalled();
    });

    it("waits in Inbox for a Capabilities save when the setting is off", async () => {
      const { service, adapter, createApproval } = fixture("confirmation", {
        allowsOperatorApprovalSkip: async () => false,
      });
      const plan = await service.create({ actor: capabilitiesActor, request: flagRequest });

      const waiting = await service.confirm(
        capabilitiesActor,
        plan.planId,
        plan.revision,
        plan.requiredAction!.actionNonce,
        { operatorSettingsSave: true },
      );

      expect(waiting.status).toBe("awaiting_approval");
      expect(waiting.requiredAction?.kind).toBe("approval");
      expect(createApproval).toHaveBeenCalledOnce();
      expect(adapter.applyCount).toBe(0);
    });

    // The Gateway's owner answers false under remote_hardened even with the setting on
    // (gateway-service.operator-approval-skip.test.ts, which covers the Capabilities install); this stand-in shows the
    // owner has the last word.
    it("always asks under remote_hardened", async () => {
      const allowsOperatorApprovalSkip = vi.fn(async () => false);
      const { service, adapter, createApproval } = fixture("confirmation", { allowsOperatorApprovalSkip });
      const plan = await service.create({ actor: settingsActor, request: flagRequest });

      const waiting = await service.confirm(
        settingsActor,
        plan.planId,
        plan.revision,
        plan.requiredAction!.actionNonce,
        {
          operatorSettingsSave: true,
        },
      );

      expect(waiting.status).toBe("awaiting_approval");
      expect(waiting.requiredAction?.kind).toBe("approval");
      expect(allowsOperatorApprovalSkip).toHaveBeenCalledWith(expect.objectContaining({ planId: plan.planId }));
      expect(createApproval).toHaveBeenCalledOnce();
      expect(adapter.applyCount).toBe(0);
    });

    it.each(["chat", "system"] as const)("never skips a %s-surface plan", async (surface) => {
      const allowsOperatorApprovalSkip = vi.fn(async () => true);
      const { service, adapter } = fixture("confirmation", { allowsOperatorApprovalSkip });
      const operator = { workspaceId: "default", actorId: "operator-1", surface };
      const plan = await service.create({ actor: operator, request: flagRequest });

      const waiting = await service.confirm(operator, plan.planId, plan.revision, plan.requiredAction!.actionNonce, {
        operatorSettingsSave: true,
      });

      expect(waiting.status).toBe("awaiting_approval");
      expect(waiting.requiredAction?.kind).toBe("approval");
      expect(adapter.applyCount).toBe(0);
      expect(allowsOperatorApprovalSkip).not.toHaveBeenCalled();
    });
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
