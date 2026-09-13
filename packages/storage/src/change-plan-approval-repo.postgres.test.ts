import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictError } from "@goatcitadel/contracts";
import { ChangePlanRepository } from "./change-plan-repo.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL approval wait lookup and competing terminal CAS preserve exact parent binding", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "change_plan_approval");
  const secondUrl = new URL(connectionString!);
  secondUrl.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
  const second = new PostgresSyncDatabaseClient({ connectionString: secondUrl.toString(),
    database: decodeURIComponent(secondUrl.pathname.slice(1)) || "postgres", pool: { max: 1 } });
  try {
    const first = new ChangePlanRepository(scope.db), other = new ChangePlanRepository(second);
    const create = (id: string, approvalId: string) => {
      const plan = first.create({ origin: { workspaceId: "default", surface: "settings", actorId: "proof-operator" },
        request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode: "balanced" } },
        adapter: { adapterId: "proof", version: 1 }, target: { ownerId: "proof", resourceId: id },
        title: "Review bounded setting", summary: "Independent approval wait", impact: "Fixture state only", risk: "caution",
        status: "awaiting_confirmation", requiredAction: { kind: "confirmation", actionId: `${id}-confirm`,
          actionNonce: `${id}-nonce`, title: "Confirm", confirmationText: "Confirm this fixture" } });
      return first.transition(plan.planId, { expectedRevision: plan.revision, status: "awaiting_approval", internal: true,
        requiredAction: { kind: "approval", actionId: `${id}-approval`, actionNonce: `${id}-approval-nonce`,
          title: "Approve", risk: "caution", approvalId }, approvalRefs: ["historical-approval", approvalId] });
    };
    const target = create("target", "target-approval"), unrelated = create("unrelated", "other-approval");
    assert.deepEqual(first.listAwaitingApproval("historical-approval"), []);
    assert.deepEqual(first.listAwaitingApproval("target-approval").map(plan => plan.planId), [target.planId]);
    const competing = other.listAwaitingApproval("target-approval")[0]!;
    const settled = first.transition(target.planId, { expectedRevision: target.revision, status: "cancelled", internal: true,
      requiredAction: null, approvalRefs: ["target-approval"], result: { summary: "Approval was refused.", failureCode: "approval_denied" }, eventType: "approval_denied" });
    assert.throws(() => other.transition(target.planId, { expectedRevision: competing.revision, status: "failed", internal: true }), ConflictError);
    assert.equal(other.get(target.planId).revision, settled.revision);
    assert.deepEqual(other.listAwaitingApproval("target-approval"), []);
    assert.deepEqual(other.listAwaitingApproval("other-approval").map(plan => plan.planId), [unrelated.planId]);
    assert.equal(first.listEvents(target.planId).filter(event => event.eventType === "approval_denied").length, 1);
    assert.equal(first.listActive().length, 1);
  } finally { second.close(); await scope.teardown(); }
});
