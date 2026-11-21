import { expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { ChatContinuationService, type ChatContinuationSource } from "./chat-continuation-service.js";

function fixture() {
  const plan = {
    planId: "old",
    origin: { surface: "chat", actorId: "operator", workspaceId: "w", sessionId: "s" },
    adapter: { adapterId: "runtime-configuration", version: 2 },
    kind: "runtime_configuration",
    request: {
      kind: "runtime_configuration",
      change: { operation: "feature_flag", flag: "memoryLifecycleAdminV1Enabled", enabled: true },
    },
    intentHash: "a".repeat(64),
    target: { ownerId: "runtime_settings", resourceId: "feature_flags", expectedRevision: 4 },
    status: "failed",
    revision: 4,
    approvalRefs: ["expired"],
    evidenceRefs: [],
    rollbackRefs: [],
    result: { failureCode: "approval_expired" },
  } as unknown as ChangePlanRecord;
  const source: ChatContinuationSource = {
    workspaceId: "w",
    sessionId: "s",
    sessionIncarnationId: "incarnation",
    active: true,
    privateOperator: true,
    approvalId: "expired",
    outcome: "expired",
    effectsKnownNotExecuted: true,
    plan,
    currentSettingsRevision: 4,
  };
  let prepared: ChangePlanRecord | undefined;
  const renew = vi.fn(
    async () =>
      (prepared ??= { ...plan, planId: "fresh", revision: 1, status: "awaiting_confirmation", result: undefined }),
  );
  const read = vi.fn(async () => source);
  return { source, renew, read, service: new ChatContinuationService({ readSource: read, renewPlan: renew }) };
}
const input = {
  workspaceId: "w",
  sessionId: "s",
  approvalId: "expired",
  reason: "approval_expired" as const,
  actorId: "operator",
};
it("viewing a recovery does not reissue; explicit renewal retains the exact request without model planning", async () => {
  const f = fixture(),
    read = await f.service.inspect(input);
  expect(read.status).toBe("review_required");
  expect(f.renew).not.toHaveBeenCalled();
  const result = await f.service.prepare({ ...input, expectedSourceHash: read.sourceHash });
  expect(result.plan?.planId).toBe("fresh");
  expect(result.status).toBe("review_required");
  expect(f.renew).toHaveBeenCalledWith(
    expect.objectContaining({
      request: f.source.plan!.request,
      expectedTargetRevision: 4,
      idempotencyKey: expect.stringMatching(/^chat-renewal:/u),
    }),
  );
});
it("two tabs request the same owner idempotency identity", async () => {
  const f = fixture(),
    read = await f.service.inspect(input);
  const [a, b] = await Promise.all([
    f.service.prepare({ ...input, expectedSourceHash: read.sourceHash }),
    f.service.prepare({ ...input, expectedSourceHash: read.sourceHash }),
  ]);
  expect(a.plan?.planId).toBe(b.plan?.planId);
  expect(f.renew.mock.calls[0]?.[0].idempotencyKey).toBe(f.renew.mock.calls[1]?.[0].idempotencyKey);
});
it("new policy, request, session incarnation or foreign scope blocks an old recovery", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.source.currentSettingsRevision = 5;
    },
    (f: ReturnType<typeof fixture>) => {
      f.source.plan = { ...f.source.plan!, request: { kind: "session_model", model: "changed" } };
    },
    (f: ReturnType<typeof fixture>) => {
      f.source.sessionIncarnationId = "new";
    },
    (f: ReturnType<typeof fixture>) => {
      f.source.workspaceId = "foreign";
    },
  ]) {
    const f = fixture(),
      read = await f.service.inspect(input);
    mutate(f);
    await expect(f.service.prepare({ ...input, expectedSourceHash: read.sourceHash })).rejects.toThrow();
    expect(f.renew).not.toHaveBeenCalled();
  }
});
it("unknown effects, denial, unsupported owner and setup without a persisted continuation never retry", async () => {
  const f = fixture();
  f.source.effectsKnownNotExecuted = false;
  expect((await f.service.inspect(input)).status).toBe("unknown_effect");
  const read = await f.service.inspect(input);
  await expect(f.service.prepare({ ...input, expectedSourceHash: read.sourceHash })).rejects.toThrow();
  f.source.effectsKnownNotExecuted = true;
  f.source.outcome = "denied";
  expect((await f.service.inspect(input)).status).toBe("blocked");
  f.source.outcome = "expired";
  f.source.plan = undefined;
  expect((await f.service.inspect(input)).nextAction?.kind).toBe("ask_again");
  expect((await f.service.inspect({ ...input, reason: "setup_complete" })).status).toBe("blocked");
  expect(f.renew).not.toHaveBeenCalled();
});
