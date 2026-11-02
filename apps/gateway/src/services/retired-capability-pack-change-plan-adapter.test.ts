import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChangePlanCapabilityPackRequest, ChangePlanRecord } from "@goatcitadel/contracts";
import { createDefaultToolRegistry } from "@goatcitadel/policy-engine";
import { ChangePlanRepository, createChangePlanSchema, createDatabase } from "@goatcitadel/storage";
import {
  EvolutionControlPlaneAdapterRegistry,
  type EvolutionControlPlaneAdapter,
  type EvolutionControlPlaneAdapterContext,
} from "./evolution-control-plane-adapter.js";
import { EvolutionControlPlaneService } from "./evolution-control-plane-service.js";
import {
  CapabilityPacksRetiredError,
  RetiredCapabilityPackChangePlanAdapter,
} from "./retired-capability-pack-change-plan-adapter.js";

// Capability packs were replaced by plugins. A plan an older Gateway made still lists and reads, and startup settles a
// still-live one once, but nothing acts on it any more.

const RETIRED = {
  code: "CAPABILITY_PACKS_RETIRED",
  httpStatus: 409,
  message: "Capability packs were replaced by plugins.",
};
const files: string[] = [];
const databases: Array<ReturnType<typeof createDatabase>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const file of files.splice(0)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const actor = { workspaceId: "default", actorId: "operator-1", surface: "settings" as const };
const request: ChangePlanCapabilityPackRequest = {
  kind: "capability_pack",
  packId: "browser-qa",
  manifestHash: "a".repeat(64),
  assetIds: ["playwright"],
};

/** Stands in for the pack adapter an older Gateway registered, with the same identity. */
class OldPackAdapter implements EvolutionControlPlaneAdapter<ChangePlanCapabilityPackRequest> {
  public readonly adapterId = "capability-pack-execution";
  public readonly version = 1;
  public readonly kinds = ["capability_pack"] as const;
  public settle: "monitoring" | "completed" = "monitoring";
  public expiresAt: string | undefined;
  private made = 0;

  public async prepare(context: EvolutionControlPlaneAdapterContext) {
    // Each plan gets its own target: only one active plan may own a target.
    this.made += 1;
    return {
      target: { ownerId: "capability_pack", resourceId: `default:pack-${this.made}`, expectedHash: "b".repeat(64) },
      title: "Set up Browser QA",
      summary: "Set up 1 selected asset through its existing owner.",
      impact: "This can register, enable, and connect a shared MCP server.",
      risk: "safe" as const,
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({ title: "Review pack execution", confirmationText: "Set up." }),
      evidenceRefs: [`pack_manifest:${"a".repeat(64)}`],
      rollbackRefs: ["pack_compensation:v1"],
      ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
    };
  }

  public async apply(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    return {
      status: this.settle,
      evidenceRefs: [...plan.evidenceRefs, "pack_asset:playwright:pending"],
      rollbackRefs: plan.rollbackRefs,
      result: { summary: "Waiting for owner actions: playwright." },
    };
  }

  public async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    return { status: "monitoring" as const, evidenceRefs: plan.evidenceRefs, effectObserved: false };
  }

  public async rollback() {
    return { status: "rolled_back" as const };
  }
}

function fixture() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-retired-packs-")), "test.db");
  files.push(dbPath);
  const database = createDatabase({ dbPath });
  createChangePlanSchema(database);
  databases.push(database);
  const sync = new ChangePlanRepository(database);
  const repository = {
    create: async (input: Parameters<ChangePlanRepository["create"]>[0]) => sync.create(input),
    get: async (planId: string) => sync.get(planId),
    list: async (input: Parameters<ChangePlanRepository["list"]>[0]) => sync.list(input),
    listActive: async (limit?: number) => sync.listActive(limit),
    transition: async (planId: string, input: Parameters<ChangePlanRepository["transition"]>[1]) =>
      sync.transition(planId, input),
  };
  const oldAdapter = new OldPackAdapter();
  const older = new EvolutionControlPlaneService({
    repository,
    adapters: new EvolutionControlPlaneAdapterRegistry([oldAdapter]),
  });
  const current = new EvolutionControlPlaneService({
    repository,
    adapters: new EvolutionControlPlaneAdapterRegistry([new RetiredCapabilityPackChangePlanAdapter()]),
    getApprovalDisposition: async () => "approved",
  });
  let key = 0;
  /** A plan the older Gateway made: waiting, or confirmed and then monitoring or completed. */
  const oldPlan = async (settle?: OldPackAdapter["settle"]) => {
    key += 1;
    const created = await older.create({ actor, request, idempotencyKey: `old-pack-${key}` });
    if (!settle) return created;
    oldAdapter.settle = settle;
    return await older.confirm(actor, created.planId, created.revision, created.requiredAction!.actionNonce);
  };
  /** A plan the older Gateway left waiting for its approval, as an Inbox decision finds it. */
  const awaitingApproval = async (approvalId: string) => {
    const waiting = await oldPlan();
    return await repository.transition(waiting.planId, {
      expectedRevision: waiting.revision,
      status: "awaiting_approval",
      actionNonce: waiting.requiredAction!.actionNonce,
      requiredAction: {
        kind: "approval",
        actionId: "action_pack_approval",
        actionNonce: "nonce-pack-approval",
        title: "Approve the pack",
        risk: "caution",
        approvalId,
      },
      eventType: "approval_requested",
      actorId: actor.actorId,
    });
  };
  return { repository, sync, oldAdapter, older, current, oldPlan, awaitingApproval };
}

async function expectRetired(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject(RETIRED);
}

describe("retired capability pack plans", () => {
  it("reads an old capability pack plan", async () => {
    const h = fixture();
    const waiting = await h.oldPlan();
    const monitoring = await h.oldPlan("monitoring");
    expect(monitoring.status).toBe("monitoring");

    await expect(h.current.get(actor, waiting.planId)).resolves.toEqual(waiting);
    await expect(h.current.get(actor, monitoring.planId)).resolves.toEqual(monitoring);
    const listed = await h.current.list(actor);
    expect(listed.map((plan) => plan.planId).sort()).toEqual([waiting.planId, monitoring.planId].sort());

    await expect(h.current.get(actor, waiting.planId)).resolves.toMatchObject({ status: "awaiting_confirmation" });
  });

  it("settles an old monitoring plan once, and leaves it readable", async () => {
    const h = fixture();
    const monitoring = await h.oldPlan("monitoring");

    await expect(h.current.reconcileActive()).resolves.toHaveLength(1);
    const settled = await h.current.get(actor, monitoring.planId);
    expect(settled).toMatchObject({
      status: "manual_required",
      kind: "capability_pack",
      adapter: { adapterId: "capability-pack-execution", version: 1 },
      evidenceRefs: monitoring.evidenceRefs,
      rollbackRefs: monitoring.rollbackRefs,
      result: { summary: RETIRED.message, failureCode: "capability_packs_retired" },
    });

    // It is no longer active, so the next start doesn't touch it again.
    await expect(h.current.reconcileActive()).resolves.toEqual([]);
    await expect(h.current.get(actor, monitoring.planId)).resolves.toEqual(settled);
  });

  it("settles an old plan stopped while applying", async () => {
    const h = fixture();
    const waiting = await h.oldPlan();
    // An older Gateway stopped after it started applying: the step it writes before calling the adapter.
    const applying = await h.repository.transition(waiting.planId, {
      expectedRevision: waiting.revision,
      status: "applying",
      actionNonce: waiting.requiredAction!.actionNonce,
      requiredAction: null,
      eventType: "apply_started",
      actorId: actor.actorId,
    });
    expect(applying.status).toBe("applying");

    await expect(h.current.reconcileActive()).resolves.toHaveLength(1);
    await expect(h.current.get(actor, waiting.planId)).resolves.toMatchObject({
      status: "manual_required",
      evidenceRefs: applying.evidenceRefs,
      result: { summary: RETIRED.message, failureCode: "capability_packs_retired" },
    });
  });

  it("settles an old plan approved in the Inbox without recording an apply", async () => {
    const h = fixture();
    const waiting = await h.awaitingApproval("approval-pack-1");
    expect(waiting.status).toBe("awaiting_approval");

    const settled = await h.current.resumeApproved(actor, waiting.planId, waiting.revision, "approval-pack-1");

    expect(settled).toMatchObject({
      status: "manual_required",
      evidenceRefs: waiting.evidenceRefs,
      result: { summary: RETIRED.message, failureCode: "capability_packs_retired" },
    });
    // Its trail goes straight from waiting to needing the operator: no apply was ever started.
    const events = h.sync.listEvents(waiting.planId).map((event) => event.eventType);
    expect(events).not.toContain("approval_verified_apply_started");
    expect(events).not.toContain("rollback_approval_verified");
    expect(events.at(-1)).toBe("manual_required");
  });

  it("lets the operator cancel an old plan that never started", async () => {
    const h = fixture();
    const waiting = await h.oldPlan();
    const approval = await h.awaitingApproval("approval-pack-2");

    await expect(
      h.current.cancel(actor, waiting.planId, waiting.revision, waiting.requiredAction!.actionNonce),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      h.current.cancel(actor, approval.planId, approval.revision, approval.requiredAction!.actionNonce),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("lets startup expire an old waiting plan", async () => {
    const h = fixture();
    h.oldAdapter.expiresAt = "2000-01-01T00:00:00.000Z";
    const expired = await h.oldPlan();

    await expect(h.current.reconcileActive()).resolves.toHaveLength(1);
    await expect(h.current.get(actor, expired.planId)).resolves.toMatchObject({
      status: "failed",
      result: { failureCode: "expired" },
    });
  });

  it("answers retired for any action on it", async () => {
    const h = fixture();
    const waiting = await h.oldPlan();
    const monitoring = await h.oldPlan("monitoring");
    const completed = await h.oldPlan("completed");
    const nonce = waiting.requiredAction!.actionNonce;

    await expectRetired(h.current.confirm(actor, waiting.planId, waiting.revision, nonce));
    await expectRetired(h.current.confirmLegacy(actor, waiting.planId, waiting.revision));
    await expectRetired(
      h.current.respond(actor, waiting.planId, {
        expectedRevision: waiting.revision,
        actionId: waiting.requiredAction!.actionId,
        actionNonce: nonce,
        values: {},
      }),
    );
    await expectRetired(
      h.current.resumeOwnerInput(actor, waiting.planId, waiting.revision, nonce, {
        actionId: waiting.requiredAction!.actionId,
        actionKind: "secure_input",
        ownerId: "secret_owner",
        ownerResourceId: "pack-secret",
      }),
    );
    await expectRetired(h.current.requestRollback(actor, completed.planId, completed.revision));
    await expectRetired(h.current.verifyMonitoringPlan(actor, monitoring.planId, monitoring.revision));

    // Nothing was written: each plan is still the one the older Gateway left.
    await expect(h.current.get(actor, waiting.planId)).resolves.toEqual(waiting);
    await expect(h.current.get(actor, monitoring.planId)).resolves.toEqual(monitoring);
    await expect(h.current.get(actor, completed.planId)).resolves.toEqual(completed);

    const adapter = new RetiredCapabilityPackChangePlanAdapter();
    const context = {} as EvolutionControlPlaneAdapterContext;
    expect(() => adapter.refuseAction()).toThrow(CapabilityPacksRetiredError);
    await expectRetired(adapter.prepare());
    await expectRetired(adapter.apply());
    await expectRetired(adapter.verify());
    await expectRetired(adapter.rollback());
    await expectRetired(adapter.respond());
    await expectRetired(adapter.reviewArtifacts());
    await expectRetired(adapter.resumeOwnerInput());
    await expect(adapter.discard()).resolves.toBeUndefined();
    await expect(adapter.reconcile(context, monitoring)).resolves.toEqual({
      status: "manual_required",
      effectObserved: false,
      evidenceRefs: monitoring.evidenceRefs,
      rollbackRefs: monitoring.rollbackRefs,
      result: { summary: RETIRED.message, failureCode: "capability_packs_retired" },
    });
  });

  it("offers Chat no capability pack plans", async () => {
    const changeRequest = createDefaultToolRegistry().get("change.request");
    expect(changeRequest).toBeDefined();
    expect(JSON.stringify(changeRequest!.argSchema)).not.toContain("capability_pack");

    // A model that sends the kind anyway reaches the retired adapter, and no plan is made.
    const h = fixture();
    const chat = { workspaceId: "default", actorId: "agent-1", surface: "chat" as const, sessionId: "session-1" };
    await expectRetired(h.current.create({ actor: chat, request, idempotencyKey: "chat-pack-1" }));
    await expect(h.current.list(chat)).resolves.toEqual([]);
  });
});
