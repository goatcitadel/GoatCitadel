import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const files = new TempSqliteFiles();
afterEach(() => files.cleanup());

it("binds feature evidence once under the exact request lease and retains it after settlement", () => {
  const db = files.open({ dbPath: files.path("chat-feature-admission") });
  const lifecycle = new ChatSessionLifecycleRepository(db);
  lifecycle.initialize({
    workspaceId: "workspace-a",
    sessionId: "session-a",
    actorId: "operator-a",
    idempotencyKey: "initialize",
    correlationId: "initialize",
  });
  const repo = new SessionMutationAdmissionRepository(db);
  const admission = repo.admit({
    workspaceId: "workspace-a",
    sessionId: "session-a",
    turnId: "turn-a",
    runtimeOwnerId: "test-runtime",
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration: 1,
    actorKind: "system",
    actorId: "system:test",
    operation: "chat.turn.execute",
    materialSha256: "a".repeat(64),
    idempotencyKey: "admit",
    correlationId: "admit",
  }).admission;
  const identity = {
    admissionId: admission.admissionId,
    workspaceId: admission.workspaceId,
    sessionId: admission.sessionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    turnId: admission.turnId!,
  };
  const input = {
    ...identity,
    requestRuntimeClaim: { runtimeOwnerId: admission.runtimeOwnerId!, leaseRevision: admission.runtimeLeaseRevision! },
    references: {
      version: "chat.turn.feature-references.v1" as const,
      providerRoute: { primary: { providerId: "local", model: "test" }, fingerprint: "b".repeat(64) },
    },
  };
  assert.throws(() => repo.bindFeatureReferences({ ...input, requestRuntimeClaim: undefined }));
  assert.equal(repo.findFeatureReferences(identity), undefined);
  const first = repo.bindFeatureReferences(input);
  assert.deepEqual(repo.bindFeatureReferences(input), first);
  assert.deepEqual(new SessionMutationAdmissionRepository(db).findFeatureReferences(identity), first);
  assert.throws(() => repo.findFeatureReferences({ ...identity, sessionIncarnationId: "foreign" }));
  assert.throws(() =>
    repo.bindFeatureReferences({
      ...input,
      references: {
        ...input.references,
        providerRoute: { ...input.references.providerRoute, fingerprint: "c".repeat(64) },
      },
    }),
  );
  assert.throws(
    () => db.prepare("UPDATE chat_turn_feature_references SET reference_sha256 = ?").run("c".repeat(64)),
    /immutable/u,
  );
  repo.closeTurnWrite({
    ...identity,
    requestRuntimeClaim: input.requestRuntimeClaim,
    status: "completed",
    actorId: "system:test",
    idempotencyKey: "settle",
    correlationId: "settle",
  });
  assert.deepEqual(repo.findFeatureReferences(identity), first);
  assert.throws(() => repo.bindFeatureReferences(input), /closed/u);
});
