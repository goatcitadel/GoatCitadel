import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { Storage, createLocalAsyncStorage } from "@goatcitadel/storage";
import { APPROVAL_EXPIRY_ACTOR_ID, type ChangePlanRecord } from "@goatcitadel/contracts";
import { EvolutionControlPlaneService } from "./services/evolution-control-plane-service.js";
import { EvolutionControlPlaneAdapterRegistry } from "./services/evolution-control-plane-adapter.js";
import { RuntimeConfigurationChangePlanAdapter } from "./services/runtime-configuration-change-plan-adapter.js";
import { readChangePlanApprovalDisposition } from "./services/evolution-control-plane-approval-disposition.js";
import { createChatContinuationForGateway } from "./services/chat-continuation-composition.js";

it("renews one exact expired setup across tabs, applies only after fresh approval, and never revives old authority", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-chat-continuation-"));
  expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(root)).toMatch(/^gc-chat-continuation-/u);
  const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    }),
    store = createLocalAsyncStorage(storage);
  try {
    const actor = { workspaceId: "default", sessionId: "s", actorId: "operator", surface: "chat" as const },
      timestamp = new Date().toISOString();
    storage.sessions.upsert({
      sessionId: "s",
      sessionKey: "s",
      kind: "dm",
      channel: "web",
      account: "operator",
      timestamp,
    });
    storage.chatSessionMeta.ensure("s", timestamp, "default");
    storage.chatSessionMeta.patch("s", { origin: "operator" });
    let settings = {
      revision: 4,
      features: { memoryLifecycleAdminV1Enabled: false, evolutionControlPlaneV1Enabled: true },
    };
    const update = vi.fn(async (input: any) => {
      expect(input.expectedRevision).toBe(settings.revision);
      settings = { revision: settings.revision + 1, features: { ...settings.features, ...input.features } };
      return settings as never;
    });
    const adapter = new RuntimeConfigurationChangePlanAdapter({
      getSettings: async () => settings as never,
      updateSettings: update,
      hasTemporaryAuthCredential: () => false,
      consumeTemporaryAuthCredential: () => {
        throw new Error("No credentials in this fixture");
      },
      discardTemporaryAuthCredential: () => {},
    });
    const approvalCreate = vi.fn(
      async (plan: ChangePlanRecord) =>
        (
          await store.approvals.create({
            kind: "change_plan_effect",
            riskLevel: "caution",
            payload: {
              planId: plan.planId,
              intentHash: plan.intentHash,
              targetRevision: plan.target.expectedRevision,
              adapterId: plan.adapter.adapterId,
              adapterVersion: plan.adapter.version,
            },
            preview: {},
            linkage: { workspaceId: actor.workspaceId, sessionId: actor.sessionId },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          })
        ).approvalId,
    );
    const plane = new EvolutionControlPlaneService({
      repository: store.changePlans,
      adapters: new EvolutionControlPlaneAdapterRegistry([adapter]),
      getApprovalDisposition: (id) => readChangePlanApprovalDisposition(store.approvals, id),
      createApproval: approvalCreate,
    });
    const initial = await plane.create({
      actor,
      request: {
        kind: "runtime_configuration",
        change: { operation: "feature_flag", flag: "memoryLifecycleAdminV1Enabled", enabled: true },
      },
    });
    const waiting = await plane.confirm(actor, initial.planId, initial.revision, initial.requiredAction!.actionNonce);
    const approvalId = waiting.requiredAction?.kind === "approval" ? waiting.requiredAction.approvalId! : "";
    expect(approvalId).toBeTruthy();
    // Advance only the owned fixture's canonical expiry, then use the real expiry and refusal owners.
    storage.db
      .prepare("UPDATE approvals SET expires_at=? WHERE approval_id=?")
      .run(new Date(Date.now() - 1000).toISOString(), approvalId);
    storage.approvals.resolve(
      approvalId,
      { decision: "reject", resolvedBy: APPROVAL_EXPIRY_ACTOR_ID },
      { allowExpired: true },
    );
    storage.approvalEvents.append({
      approvalId,
      eventType: "resolved",
      actorId: APPROVAL_EXPIRY_ACTOR_ID,
      payload: { outcome: "expired" },
    });
    await plane.reconcileApproval(approvalId);
    const service = createChatContinuationForGateway(
      {
        storage: store,
        readSettingsRevision: () => settings.revision,
      },
      plane,
    );
    const input = { ...actor, approvalId, reason: "approval_expired" as const };
    const viewed = await service.inspect(input);
    expect(viewed.status, viewed.reason).toBe("review_required");
    expect(approvalCreate).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      service.prepare({ ...input, expectedSourceHash: viewed.sourceHash }),
      service.prepare({ ...input, expectedSourceHash: viewed.sourceHash }),
    ]);
    expect(first.plan!.planId).toBe(second.plan!.planId);
    expect(first.plan!.planId).not.toBe(initial.planId);
    expect(approvalCreate).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const fresh = await plane.confirm(
      actor,
      first.plan!.planId,
      first.plan!.revision,
      first.plan!.requiredAction!.actionNonce,
    );
    const freshId = fresh.requiredAction?.kind === "approval" ? fresh.requiredAction.approvalId! : "";
    expect(freshId).not.toBe(approvalId);
    await expect(plane.resumeApproved(actor, fresh.planId, fresh.revision, approvalId)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    storage.approvals.resolve(freshId, { decision: "approve", resolvedBy: actor.actorId });
    const applied = await plane.resumeApproved(actor, fresh.planId, fresh.revision, freshId);
    expect(applied.status).toBe("completed");
    expect(update).toHaveBeenCalledTimes(1);
    expect(settings.features.memoryLifecycleAdminV1Enabled).toBe(true);
    expect(storage.approvals.get(approvalId).status).toBe("rejected");
    expect((await plane.get(actor, initial.planId)).result?.failureCode).toBe("approval_expired");
    await expect(service.prepare({ ...input, expectedSourceHash: viewed.sourceHash })).rejects.toThrow();
    expect(update).toHaveBeenCalledTimes(1);
    await expect(service.inspect({ ...input, workspaceId: "foreign" })).rejects.toThrow();
    storage.chatSessionMeta.patch("s", { lifecycleStatus: "archived" });
    await expect(service.inspect(input)).rejects.toThrow();
  } finally {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
