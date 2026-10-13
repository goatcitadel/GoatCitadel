import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, it } from "node:test";
import {
  canonicalJsonString,
  sealRemoteWorkerChatContextForTurn,
  type ChatCompletionMessage,
} from "@goatcitadel/contracts";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerChatContextRepository } from "./remote-worker-chat-context-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
const sha = (value: unknown) => createHash("sha256").update(canonicalJsonString(value)).digest("hex");

it("freezes profile-free worker history only from exact canonical feature and current admission authority", () => {
  const db = files.open({ dbPath: ":memory:" });
  new ChatSessionLifecycleRepository(db).initialize({
    workspaceId: "workspace",
    sessionId: "session",
    actorId: "operator",
    idempotencyKey: "initialize",
    correlationId: "initialize",
  });
  const request = { content: "Inspect the remote work item", memoryMode: "off" as const };
  const materialSha256 = sha({ version: 2, request });
  const admissions = new SessionMutationAdmissionRepository(db);
  const admission = admissions.admit({
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    runtimeOwnerId: "runtime",
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "operator",
    actorId: "operator",
    operation: "chat.turn.execute",
    materialSha256,
    idempotencyKey: "admit",
    correlationId: "admit",
  }).admission;
  const identity = {
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
  };
  const requestRuntimeClaim = {
    runtimeOwnerId: admission.runtimeOwnerId!,
    leaseRevision: admission.runtimeLeaseRevision!,
  };
  const scope = {
    ...identity,
    aggregateRevision: 1,
    controllerGeneration: 1,
    materialSha256,
    actorId: "operator",
    actorSource: "loopback" as const,
  };
  const binding = admissions.bindFeatureReferences({
    ...identity,
    requestRuntimeClaim,
    references: {
      version: "chat.turn.feature-references.v1",
      providerRoute: { primary: { providerId: "local", model: "fixture" }, fingerprint: sha("route") },
      remotePlacement: {
        version: "chat.remote-placement.admission.v1",
        scope,
        citadelId: "citadel",
        contentSha256: sha(request.content),
        memoryMode: "off",
        runtimeInterposition: { hash: sha([]), count: 0 },
        permission: { profileId: "safe", approvalMode: "approve_all", profileHash: sha("policy") },
        selectedTools: [],
      },
    },
  });
  const payload = {
    version: "chat.turn.execute.v2",
    ...identity,
    admissionMaterialSha256: materialSha256,
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    request,
    requestActor: { actorKind: "operator", actorId: "operator", authActorId: "operator", authActorSource: "loopback" },
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "run" },
    userMessageId: "user",
    assistantMessageId: "assistant",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    effectiveRequestMaterialSha256: sha({ version: 1, admissionMaterialSha256: materialSha256, request }),
    featureReferenceSha256: binding.referenceSha256,
  };
  const messages: ChatCompletionMessage[] = [
    { role: "system", content: "Use the supplied evidence." },
    { role: "user", content: request.content },
  ];
  const expected = sealRemoteWorkerChatContextForTurn("run", payload, messages);
  const runs = new DurableRunRepository(db);
  runs.createRun({
    runId: "run",
    workflowKey: "chat.turn.execute",
    status: "queued",
    payload,
    metadata: { remoteWorkerChatContextSha256: expected.contextSha256 },
  });
  const contexts = new RemoteWorkerChatContextRepository(db);
  assert.throws(() => contexts.freezeForAdmission({ durableRunId: "run", messages }), /claim|lease/u);
  assert.throws(
    () =>
      contexts.freezeForAdmission({
        durableRunId: "run",
        messages: [{ role: "user", content: "Foreign prompt" }],
        requestRuntimeClaim,
      }),
    /admitted user input/u,
  );
  const saved = contexts.freezeForAdmission({ durableRunId: "run", messages, requestRuntimeClaim });
  assert.deepEqual(saved, expected);
  assert.equal(saved.capabilityProfileId, undefined);
  assert.equal(saved.capabilityProfileSha256, undefined);
  assert.equal(saved.admissionReference?.featureReferenceSha256, binding.referenceSha256);
  assert.deepEqual(contexts.freezeForAdmission({ durableRunId: "run", messages, requestRuntimeClaim }), saved);
  assert.deepEqual(new RemoteWorkerChatContextRepository(db).findForRun("run"), saved);
  assert.throws(
    () =>
      contexts.freezeForAdmission({
        durableRunId: "run",
        messages: [...messages, { role: "assistant", content: "Changed history" }],
        requestRuntimeClaim,
      }),
    /frozen admission digest/u,
  );
  assert.throws(
    () => db.prepare("UPDATE remote_worker_chat_contexts SET admission_reference_json = '{}'").run(),
    /immutable/u,
  );
  const raw = db
    .prepare(
      "SELECT capability_profile_id, capability_profile_sha256, admission_reference_json FROM remote_worker_chat_contexts",
    )
    .get<{
      capability_profile_id: string | null;
      capability_profile_sha256: string | null;
      admission_reference_json: string;
    }>()!;
  assert.equal(raw.capability_profile_id, null);
  assert.equal(raw.capability_profile_sha256, null);
  assert.deepEqual(JSON.parse(raw.admission_reference_json), saved.admissionReference);
  admissions.bindDurableRun({ ...identity, durableRunId: "run", requestRuntimeClaim });
  const claimed = runs.tryClaimQueuedRunWithDatabaseClock({
    runId: "run",
    workerId: "worker",
    leaseDurationMs: 60_000,
  })!;
  assert.ok(claimed);
  const durableClaim = { durableRunId: "run", leaseOwnerId: "worker", attemptCount: claimed.attemptCount };
  assert.deepEqual(contexts.freezeForAdmission({ durableRunId: "run", messages, durableClaim }), saved);
  admissions.closeTurnWrite({
    ...identity,
    durableClaim,
    status: "completed",
    actorId: "operator",
    idempotencyKey: "close",
    correlationId: "close",
  });
  assert.throws(() => contexts.freezeForAdmission({ durableRunId: "run", messages, requestRuntimeClaim }), /closed/u);
  assert.deepEqual(contexts.findForRun("run"), saved);
});
