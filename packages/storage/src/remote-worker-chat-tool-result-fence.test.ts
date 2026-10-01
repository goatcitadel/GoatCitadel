import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, it } from "node:test";
import { REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION, remoteWorkerInferenceCanonicalSha256, type CapabilityCatalogEntry, type RemoteWorkerEffectTransitionState } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient } from "./db.js";
import { seedProtectedFenceHarness } from "./remote-worker-protected-fence-fixture.js";
import { prepareChatOfferFixture } from "./remote-worker-chat-offer-fixture.js";
import { RemoteWorkerEffectRepository } from "./remote-worker-effect-repo.js";

const D = (text: string) => createHash("sha256").update(text).digest("hex");
const clients: DatabaseClient[] = [];
afterEach(() => { for (const db of clients.splice(0)) db.close(); });

function fixture(seed: string, state: "waiting" | "completed" | "unsettled" = "completed") {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  const h = seedProtectedFenceHarness(db, seed, true);
  const entry: CapabilityCatalogEntry = { capabilityId: "tool:fs.read", kind: "tool", category: "built_in",
    title: "Read file", summary: "Read an admitted file", callable: true, trustLabel: "Builtin", toolName: "fs.read",
    effectPotential: { version: "goatcitadel.tool-effect.v1", potential: "none", sourceKind: "builtin", reason: "trusted_builtin_safe_read" } };
  const definition = { type: "function", function: { name: "fs_read", description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } };
  const prepared = prepareChatOfferFixture(db, true, `-${seed}`, { subagentPolicy: "off", callableEntries: [entry],
    tools: [{ canonicalName: "fs.read", modelName: "fs_read", providerDefinition: definition, definitionHash: remoteWorkerInferenceCanonicalSha256(definition),
      runtimeOwner: { kind: "builtin", bindingHash: D("tool-result-owner") }, effectPotential: entry.effectPotential }] });
  const assignment = h.assignments.scheduleTaskBoundChatOffer(prepared.offerInput).assignment;
  const token = D(`${seed}:lease`);
  const started = h.assignments.startGeneration({ registryWorkspaceId: "default", assignmentId: assignment.assignmentId,
    workerId: h.finalized.generation.workerId, workerGeneration: h.finalized.generation.workerGeneration,
    nodeId: h.finalized.generation.nodeId, nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
    dispatchOwnerId: prepared.offerInput.dispatchOwnerId, durableRunAttempt: prepared.offerInput.durableRunAttempt,
    leaseTokenSha256: token, idempotencyKey: `${seed}:generation` });
  const ref = { registryWorkspaceId: "default", assignmentId: assignment.assignmentId, assignmentGeneration: started.generation.assignmentGeneration };
  const exact = { ...ref, leaseTokenSha256: token };
  const execution = h.assignments.resolveActiveChatExecution(exact, h.fence);
  assert.ok(assignment.manifest.requiredCapabilityClasses.includes("governed_tool"));
  const effects = new RemoteWorkerEffectRepository(db);
  const intent = effects.recordNextIntent({ ...ref, effectSelector: "fs.read", canonicalArgs: { path: "note.txt" },
    workerIdempotencyKey: `${seed}:tool`, idempotencyKey: `${seed}:tool` });
  function transition(transitionState: RemoteWorkerEffectTransitionState) {
    return effects.appendTransition({ ...ref, intentId: intent.intentId, idempotencyKey: `${seed}:${transitionState}`,
      correlation: { schemaVersion: REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION, transitionState,
        externalSideEffectRunId: transitionState === "completed_no_effect" ? "canonical-effect" : null,
        approvalRecordSha256: transitionState === "approval_wait" ? D("canonical-approval") : null,
        boundaryReceiptSha256: transitionState === "completed_no_effect" ? D("canonical-boundary") : null,
        hx305OutcomeSha256: null, reconciliationRecordSha256: null, sanitizedError: null } });
  }
  transition("recorded");
  if (state === "waiting") transition("approval_wait");
  if (state === "completed") {
    transition("dispatch_claimed");
    const terminal = transition("completed_no_effect");
    effects.recordReceipt({ ...ref, intentId: intent.intentId, receiptState: "completed_no_effect",
      finalTransitionSequence: terminal.transitionSequence, finalTransitionSha256: terminal.transitionSha256,
      hx305OutcomeSha256: null, idempotencyKey: `${seed}:receipt` });
  }
  const continuation = { intentId: intent.intentId, intentSha256: intent.intentSha256,
    leaseRevision: execution.authority.lease.leaseRevision,
    parentDispatchAuthority: execution.authority.lease.parentDispatchAuthority,
    durableRunPayloadSha256: execution.workload.durableRunPayloadSha256 };
  const resultInput = { ...ref, continuingToolResult: continuation };
  const beat = () => {
    const run = h.durableRuns.getRun(prepared.durableRunId);
    const next = h.durableRuns.renewLeaseWithDatabaseClock({ runId: run.runId, workerId: run.leaseOwnerId!, leaseDurationMs: 120_000 });
    assert.equal(next?.version, run.version + 1);
    return next!;
  };
  return { db, h, prepared, ref, exact, resultInput, continuation, beat, effects, intent, started };
}

for (const state of ["completed", "waiting"] as const) {
  it(`reads only the canonical ${state} tool result across a real parent heartbeat`, () => {
    const f = fixture(`result-${state}`, state);
    f.beat();
    assert.throws(() => f.h.assignments.resolveActiveChatExecution(f.exact, f.h.fence));
    const result = f.h.assignments.resolveActiveChatExecution(f.resultInput, f.h.fence);
    assert.equal(result.authority.assignment.assignmentId, f.ref.assignmentId);
    assert.equal(result.workload.durableRunPayloadSha256, f.continuation.durableRunPayloadSha256);
    assert.equal(f.effects.listIntents("default", f.ref.assignmentId, 1).length, 1);
  });
}

it("withholds an unsettled intent and changed result or lease bindings", () => {
  const pending = fixture("result-unsettled", "unsettled");
  pending.beat();
  assert.throws(() => pending.h.assignments.resolveActiveChatExecution(pending.resultInput, pending.h.fence));
  const f = fixture("result-bindings");
  f.beat();
  for (const patch of [{ intentId: "foreign" }, { intentSha256: D("changed") }, { leaseRevision: 2 },
    { durableRunPayloadSha256: D("changed") },
    { parentDispatchAuthority: { ...f.continuation.parentDispatchAuthority, durableRunVersion: 1 } }]) {
    const input = { ...f.resultInput, continuingToolResult: { ...f.continuation, ...patch } };
    assert.throws(() => f.h.assignments.resolveActiveChatExecution(input, f.h.fence));
  }
});

it("reads the same result after an owned lease rotation without accepting the obsolete execution token", () => {
  const f = fixture("result-rotation");
  f.beat();
  const renewed = f.h.assignments.renewLease({ registryWorkspaceId: f.ref.registryWorkspaceId, assignmentId: f.ref.assignmentId,
    expectedAssignmentGeneration: f.ref.assignmentGeneration, expectedLeaseRevision: f.started.lease.leaseRevision,
    expectedLeaseTokenSha256: f.exact.leaseTokenSha256, leaseTokenSha256: D("rotated-result-token"),
    workerSentThrough: 0, idempotencyKey: "result-rotation:renew" }, f.h.fence);
  assert.equal(renewed.lease.leaseRevision, f.started.lease.leaseRevision + 1);
  assert.throws(() => f.h.assignments.resolveActiveChatExecution(f.exact, f.h.fence));
  assert.equal(f.h.assignments.resolveActiveChatExecution(f.resultInput, f.h.fence).authority.lease.leaseRevision,
    renewed.lease.leaseRevision);
});

it("retains parent ownership, cancellation, payload and credential fences for result reads", () => {
  for (const drift of ["owner", "attempt", "expiry", "payload", "cancel", "credential"] as const) {
    const f = fixture(`result-${drift}`);
    f.beat();
    const run = f.h.durableRuns.getRun(f.prepared.durableRunId);
    if (drift === "owner") f.h.durableRuns.updateRun({ runId: run.runId, status: "running", expectedVersion: run.version, leaseOwnerId: "foreign-owner" });
    if (drift === "attempt") f.h.durableRuns.updateRun({ runId: run.runId, status: "running", expectedVersion: run.version, attemptCount: run.attemptCount + 1 });
    if (drift === "expiry") f.h.durableRuns.updateRun({ runId: run.runId, status: "running", expectedVersion: run.version, leaseExpiresAt: "2000-01-01T00:00:00.000Z" });
    if (drift === "payload") f.h.durableRuns.updateRun({ runId: run.runId, status: "running", expectedVersion: run.version, payload: { ...run.payload, extra: "changed" } });
    if (drift === "cancel") f.h.assignments.requestCancellation({ registryWorkspaceId: f.ref.registryWorkspaceId,
      assignmentId: f.ref.assignmentId, expectedAssignmentGeneration: 1,
      expectedLeaseRevision: f.started.lease.leaseRevision, reasonCode: "operator.cancelled", reasonSha256: D("cancel"), actorId: "operator-a", idempotencyKey: "cancel" });
    const fence = drift === "credential" ? { ...f.h.fence, credentialAuthority: { ...f.h.fence.credentialAuthority,
      authorizationCredentialSha256: D("revoked") } } : f.h.fence;
    assert.throws(() => f.h.assignments.resolveActiveChatExecution(f.resultInput, fence));
  }
});
