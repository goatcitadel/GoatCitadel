import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLocalAiIntentAgreement } from "./cockpit-local-ai-proof.mjs";
const fixture = () => {
  const selected = { modelId: "model", backend: "llama_cpp" };
  const receipt = { ...selected, jobId: "job", approvalId: "approval", status: "requires_approval" };
  const common = { approvalId: "approval", kind: "local_ai.download", riskLevel: "caution", status: "pending" };
  const timestamp = "2026-09-30T15:36:40.643Z";
  const metadata = { approvalId: "approval", status: "completed", version: 3, attemptCount: 1,
    createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp };
  const signals = ["audit", "realtime"].map((kind, index) => {
    const operationId = `approval.create.${kind}`, deliveryId = `approval-observability:approval:${operationId}`;
    return { ...metadata, effectId: `signal-${kind}`, effectKind: "approval_observability", targetKind: "approval", targetId: operationId,
      idempotencyKey: deliveryId, payload: { schemaVersion: "approval_observability.v1", deliveryId, operationId,
        occurredAt: timestamp, orderIndex: index + 1, ...(index ? { predecessorDeliveryId: "approval-observability:approval:approval.create.audit" } : {}),
        delivery: kind === "audit" ? { kind, stream: "approvals", payload: { event: "approval.create", ...common } }
          : { kind, eventType: "approval_created", source: "approvals", payload: { ...common }, options: {
            correlationId: "approval", eventAuthority: "retained_stream", eventClass: "domain_fact", links: { approvalId: "approval", runId: "wait-run" } } } },
      result: { delivered: true, deliveryId, deliveryKind: kind, deliveryState: "delivered", occurredAt: timestamp, operationId } };
  });
  return { kind: "download", selected, request: { ...selected, approvalMode: "request" }, receipt,
    owner: { downloads: [{ ...receipt }], serveJobs: [] }, replay: { approval: { ...common,
      linkage: { actionType: "local_ai.download", durableRunId: "wait-run" }, payload: { action: "download", jobId: "job", ...selected, approvalMode: "request" } },
      durableRunId: "wait-run", effects: [{ ...metadata, effectId: "wait-effect", effectKind: "approval_wait_materialize", targetKind: "durable_run",
        targetId: "wait-run", idempotencyKey: "approval:approval_wait_materialize:durable_run:wait-run", payload: { approvalId: "approval", runId: "wait-run" },
        result: { approvalId: "approval", runId: "wait-run", materialized: true, status: "waiting" } }, ...signals] } };
};
test("requires exact request, retained job and canonical approval intent agreement", () => {
  assertLocalAiIntentAgreement(fixture());
  for (const patch of [{ modelId: "foreign" }, { backend: "ollama" }, { approvalMode: "dry_run" }, { port: 8000 }]) {
    const value = fixture(); Object.assign(value.request, patch); assert.throws(() => assertLocalAiIntentAgreement(value));
  }
});
test("allows only bound approval-create infrastructure for a serve intent as well", () => {
  const value = fixture(); value.kind = "serve";
  value.owner.serveJobs = value.owner.downloads; value.owner.downloads = [];
  value.replay.approval.kind = "local_ai.serve"; value.replay.approval.riskLevel = "danger";
  value.replay.approval.linkage.actionType = "local_ai.serve"; value.replay.approval.payload.action = "serve";
  for (const effect of value.replay.effects.slice(1)) {
    effect.payload.delivery.payload.kind = "local_ai.serve"; effect.payload.delivery.payload.riskLevel = "danger";
  }
  assertLocalAiIntentAgreement(value);
});
test("rejects absent or duplicate owner records, wrong approval binding and execution claims", () => {
  const absent = fixture(); absent.owner.downloads = []; assert.throws(() => assertLocalAiIntentAgreement(absent));
  const duplicate = fixture(); duplicate.owner.downloads.push(duplicate.receipt); assert.throws(() => assertLocalAiIntentAgreement(duplicate));
  for (const patch of [{ approvalId: "other" }, { kind: "local_ai.serve" }, { status: "approved" }]) {
    const value = fixture(); Object.assign(value.replay.approval, patch); assert.throws(() => assertLocalAiIntentAgreement(value));
  }
  const effect = fixture(); effect.replay.effects.push({ status: "completed" }); assert.throws(() => assertLocalAiIntentAgreement(effect));
  const executed = fixture(); executed.receipt.artifactPath = "model.gguf"; executed.owner.downloads[0].artifactPath = "model.gguf";
  assert.throws(() => assertLocalAiIntentAgreement(executed));
});
test("rejects foreign, duplicate, incomplete or settled approval infrastructure", () => {
  const changes = [
    (value) => { value.replay.durableRunId = "foreign-run"; },
    (value) => { value.replay.pendingAction = { status: "pending" }; },
    (value) => { value.replay.effects[0].approvalId = "foreign-approval"; },
    (value) => { value.replay.effects[0].targetId = "foreign-run"; },
    (value) => { value.replay.effects[0].result.status = "completed"; },
    (value) => { value.replay.effects[0].effectKind = "pending_action_execute"; },
    (value) => { value.replay.effects[0].result.processId = 100; },
    (value) => { value.replay.effects[1].effectId = value.replay.effects[0].effectId; },
    (value) => { value.replay.effects[1].idempotencyKey = "foreign-key"; },
    (value) => { value.replay.effects[1].payload.delivery.payload.status = "approved"; },
    (value) => { value.replay.effects[1].payload.operationId = "approval.resolve.audit"; },
    (value) => { value.replay.effects[2].payload.delivery.options.links.runId = "foreign-run"; },
    (value) => { value.replay.effects[2].result.deliveryId = "foreign-delivery"; },
    (value) => { value.replay.effects[2].status = "running"; },
    (value) => { value.replay.effects = []; },
  ];
  for (const change of changes) {
    const value = fixture(); change(value); assert.throws(() => assertLocalAiIntentAgreement(value));
  }
});
