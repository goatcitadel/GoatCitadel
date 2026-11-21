import { expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { prepareAssistantSetupReview } from "./assistant-setup-review-service.js";
function fixture() {
  const request = {
      kind: "runtime_configuration",
      change: { operation: "feature_flag", flag: "memoryLifecycleAdminV1Enabled", enabled: true },
    },
    readiness = {
      version: 1,
      workspaceId: "A",
      sessionId: "s",
      sessionIncarnationId: "incarnation",
      configRevision: 4,
      sourceHash: "a".repeat(64),
      items: [{ id: "memory", nextAction: { kind: "review_change_plan", request } }],
    };
  const plans = new Map<string, any>(),
    keys = new Map<string, string>();
  let active: string | undefined;
  const owner = {
    findByIdempotencyKey: vi.fn(async (_actor: any, key: string) => plans.get(keys.get(key)!)),
    get: vi.fn(async (_actor: any, id: string) => plans.get(id)),
    cancel: vi.fn(async (_actor: any, id: string, revision: number) => {
      const plan = plans.get(id);
      if (plan.revision !== revision) throw new ConflictError({ message: "Changed" });
      plan.status = "cancelled";
      plan.revision++;
      plan.requiredAction = undefined;
      active = undefined;
      return plan;
    }),
    create: vi.fn(async (input: any) => {
      if (active)
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Target occupied",
          details: { resourceKind: "change_plan", resourceId: active },
        });
      const plan = {
        planId: `p${plans.size + 1}`,
        revision: 1,
        status: "awaiting_confirmation",
        origin: input.actor,
        request: input.request,
        adapter: { adapterId: "runtime-configuration", version: 2 },
        target: {
          ownerId: "runtime_settings",
          resourceId: "feature_flags",
          expectedRevision: input.expectedTargetRevision,
        },
        requiredAction: { kind: "confirmation", actionNonce: "nonce", purpose: "apply" },
      };
      plans.set(plan.planId, plan);
      keys.set(input.idempotencyKey, plan.planId);
      active = plan.planId;
      return plan;
    }),
  };
  const input = () => ({
    workspaceId: "A",
    sessionId: "s",
    itemId: "memory",
    expectedSourceHash: readiness.sourceHash,
    operationId: "operation-1234567890",
  });
  const prepare = (body = input(), actor = "operator") =>
    prepareAssistantSetupReview({ owner, readiness } as never, body as never, actor);
  return { owner, readiness, plans, input, prepare };
}
it("prepares one exact server-owned setup intent and returns the same operation after source changes", async () => {
  const f = fixture(),
    input = f.input(),
    first = await f.prepare(input);
  f.readiness.sourceHash = "b".repeat(64);
  expect((await f.prepare(input)).planId).toBe(first.planId);
  expect(f.owner.create).toHaveBeenCalledTimes(1);
  expect(f.owner.cancel).not.toHaveBeenCalled();
  expect(f.owner.create).toHaveBeenCalledWith(
    expect.objectContaining({
      actor: expect.objectContaining({ actorId: "operator", sessionId: "s", workspaceId: "A", surface: "chat" }),
      request: f.readiness.items[0]!.nextAction.request,
      expectedTargetRevision: 4,
    }),
  );
});
it("retires only its untouched outdated review and prepares a fresh confirmation against current settings", async () => {
  const f = fixture(),
    first = await f.prepare();
  f.readiness.configRevision = 5;
  f.readiness.sourceHash = "b".repeat(64);
  const fresh = await f.prepare({ ...f.input(), operationId: "operation-9876543210" });
  expect(fresh.planId).not.toBe(first.planId);
  expect(f.plans.get(first.planId).status).toBe("cancelled");
  expect(f.owner.cancel).toHaveBeenCalledWith(
    expect.objectContaining({ actorId: "operator" }),
    first.planId,
    1,
    "nonce",
  );
  expect(fresh).toMatchObject({ status: "awaiting_confirmation", target: { expectedRevision: 5 } });
});
it.each(["approval", "changed_revision", "foreign_actor", "different_intent", "new_incarnation"])(
  "never retires an existing %s review",
  async (kind) => {
    const f = fixture(),
      first = await f.prepare();
    f.readiness.configRevision = 5;
    f.readiness.sourceHash = "b".repeat(64);
    const plan = f.plans.get(first.planId);
    if (kind === "approval") {
      plan.status = "awaiting_approval";
      plan.requiredAction.kind = "approval";
    }
    if (kind === "changed_revision") plan.revision = 2;
    if (kind === "foreign_actor") plan.origin = { ...plan.origin, actorId: "other" };
    if (kind === "different_intent")
      plan.request = {
        ...plan.request,
        change: { operation: "feature_flag", flag: "backgroundSkillDraftsV1Enabled", enabled: true },
      };
    if (kind === "new_incarnation") f.readiness.sessionIncarnationId = "new-incarnation";
    await expect(f.prepare({ ...f.input(), operationId: "operation-9876543210" })).rejects.toThrow(/existing|review/i);
    expect(f.owner.cancel).not.toHaveBeenCalled();
    expect(plan.status).not.toBe("cancelled");
  },
);
it("foreign scope, stale source, missing identity and caller-selected effects cannot prepare work", async () => {
  const f = fixture();
  await expect(f.prepare({ ...f.input(), workspaceId: "B" })).rejects.toThrow();
  await expect(f.prepare({ ...f.input(), expectedSourceHash: "b".repeat(64) })).rejects.toThrow();
  await expect(f.prepare(f.input(), "")).rejects.toThrow();
  await expect(f.prepare({ ...f.input(), itemId: "arbitrary" })).rejects.toThrow();
  expect(f.owner.create).not.toHaveBeenCalled();
  expect(f.owner.cancel).not.toHaveBeenCalled();
});
