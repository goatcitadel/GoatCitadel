import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ConflictError,
  REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
  REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  remoteWorkerProtectedAdmissionContextSha256,
  remoteWorkerProtectedAdmissionRemoteCallerBindingSha256,
  type ChatTurnCapabilityProfileDraft,
  type CreateRemoteWorkerBootstrapCommand,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerAssignmentManifest,
  type RemoteWorkerBootstrapRecord,
  type RemoteWorkerProtectedAdmissionSignerPin,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import {
  ChatTurnCapabilityProfileRepository,
  sealChatTurnCapabilityProfile,
} from "./chat-turn-capability-profile-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import {
  RemoteWorkerAdmissionRepository,
  type FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput,
} from "./remote-worker-admission-repo.js";
import { RemoteWorkerMeshNodeAdmissionRepository } from "./remote-worker-mesh-node-admission-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import type { RemoteWorkerNonceConsumeInput } from "./remote-worker-nonce-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
import { createDatabase } from "./sqlite.js";
import { TaskRepository } from "./task-repo.js";

const digest = (value: string | Uint8Array): string =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");

function taskBoundCapabilityProfileDraft(input: {
  profileId: string;
  turnId: string;
  sessionId: string;
  durableRunId: string;
  createdAt: string;
}): ChatTurnCapabilityProfileDraft {
  const emptyCatalogHash = digest(canonicalJsonString([]));
  return {
    profileId: input.profileId,
    schemaVersion: "chat.turn.capability-profile.v1",
    identity: {
      turnId: input.turnId,
      sessionId: input.sessionId,
      workspaceId: "default",
      citadelId: "default",
      durableRunId: input.durableRunId,
      operatorId: "operator-a",
      authActorId: "operator-a",
      authActorSource: "token",
    },
    source: { channel: "chat", account: "default" },
    catalog: {
      snapshotId: "assignment-snapshot",
      inspectableHash: emptyCatalogHash,
      callableHash: emptyCatalogHash,
      inspectableCount: 0,
      callableCount: 0,
    },
    selection: {
      contentHash: digest("assignment-content"),
      effectiveProviderId: "provider-a",
      effectiveModel: "model-a",
      allowedFallbacks: [],
      mode: "chat",
      webMode: "off",
      memory: {
        mode: "off",
        retrievalMode: "standard",
        workspaceId: "default",
        sessionId: input.sessionId,
        contextManifestRef: `chat-memory-scope:${digest("assignment-memory-scope")}`,
        writeApprovalRequired: true,
      },
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "auto_when_useful",
      toolAutonomy: "manual",
      tools: [],
      modelNameAllowMap: [],
      trustedSkills: [],
    },
    governance: {
      activeGrants: [],
      permission: {
        profileId: "safe",
        approvalMode: "approve_all",
        profileHash: digest("assignment-permission"),
      },
      policyDecisions: [],
      authReadiness: [
        { kind: "provider", ref: "provider-a", status: "ready", reasonCodes: [] },
        { kind: "channel", ref: "chat", status: "ready", reasonCodes: [] },
      ],
      approval: {
        mode: "approve_all",
        selectedToolCount: 0,
        toolsRequiringApproval: [],
        approvalGranted: false,
      },
    },
    preflightFingerprint: digest("assignment-preflight"),
    createdAt: input.createdAt,
  };
}

describe("RemoteWorkerMeshNodeAdmissionRepository", () => {
  it("issues a secret once and atomically admits/replays with one durable nonce per attempt", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "goatcitadel-m3-mesh-"));
    let db = createDatabase({ dbPath: join(tempRoot, "gateway.sqlite") });
    try {
      const m2 = new RemoteWorkerAdmissionRepository(db);
      const bootstrap = m2.createBootstrap(bootstrapInput("atomic")).record;
      const finalizedInput = protectedAdmissionInput(db, bootstrap, "atomic", "first");
      const finalized = m2.finalizeBootstrapAdmissionWithNonce(finalizedInput);

      const repo = new RemoteWorkerMeshNodeAdmissionRepository(db);
      repo.assertAvailable();
      const rawMeshNodeCredential = "a".repeat(43);
      const issueInput = {
        registryWorkspaceId: finalized.generation.registryWorkspaceId,
        bootstrapId: finalized.generation.bootstrapId,
        workerId: finalized.generation.workerId,
        workerGeneration: finalized.generation.workerGeneration,
        nodeId: finalized.generation.nodeId,
        clientCertificateSha256: finalized.generation.clientCertificateSha256,
        protectedAdmissionEnvelopeSha256: finalizedInput.command.verifiedProtectedAdmissionEvidence!.envelopeSha256,
        protectedAdmissionContextSha256: finalizedInput.command.verifiedProtectedAdmissionEvidence!.contextSha256,
        workspaceId: "default",
        expiresInSeconds: 120,
        issuedByActorId: "operator-a",
        idempotencyKey: "mesh-authority:atomic",
        rawMeshNodeCredential,
      } as const;
      const issued = repo.issueJoinAuthority(issueInput);
      assert.equal(issued.disposition, "created");
      assert.equal(issued.meshNodeCredential, rawMeshNodeCredential);
      assert.equal(issued.authority.joinCredentialSha256, digest(rawMeshNodeCredential));
      assert.equal(
        db.prepare("SELECT 1 FROM mesh_nodes WHERE node_id = ?").get(finalized.generation.nodeId),
        undefined,
      );

      const discardedRetryCredential = "z".repeat(43);
      const replayedIssue = repo.issueJoinAuthority({
        ...issueInput,
        rawMeshNodeCredential: discardedRetryCredential,
      });
      assert.equal(replayedIssue.disposition, "replayed_without_secret");
      assert.equal(replayedIssue.meshNodeCredential, undefined);
      assert.equal(replayedIssue.secretDisposition, "not_recoverable");
      assert.equal(replayedIssue.authority.joinCredentialSha256, digest(rawMeshNodeCredential));
      assert.equal(
        db.prepare("SELECT 1 FROM mesh_join_tokens WHERE token_hash = ?").get(digest(discardedRetryCredential)),
        undefined,
      );

      assert.throws(
        () =>
          db.transaction("immediate", () => {
            const now = databaseClock(db);
            db.prepare(
              `UPDATE mesh_join_tokens SET used_at = @now, used_by_node_id = @nodeId
               WHERE token_hash = @tokenSha256`,
            ).run({ now, nodeId: finalized.generation.nodeId, tokenSha256: issued.authority.joinCredentialSha256 });
            db.prepare(
              `INSERT INTO mesh_capability_node_admissions(
                 workspace_id,node_id,admission_generation,join_token_sha256,mtls_required,tls_fingerprint,
                 admitted_by_actor_id,idempotency_key,request_sha256,admitted_at
               ) VALUES ('default',@nodeId,1,@tokenSha256,1,@certificateSha256,
                 'operator-a','legacy-downgrade',@requestSha256,@now)`,
            ).run({
              nodeId: finalized.generation.nodeId,
              tokenSha256: issued.authority.joinCredentialSha256,
              certificateSha256: finalized.generation.clientCertificateSha256,
              requestSha256: digest("legacy-downgrade"),
              now,
            });
          }),
        /provenance/u,
      );
      assert.equal(
        db
          .prepare("SELECT used_at FROM mesh_join_tokens WHERE token_hash = ?")
          .get<{ used_at: string | null }>(issued.authority.joinCredentialSha256)?.used_at,
        null,
      );

      const nonce = credentialNonce(db, finalized, "admit-1");
      const command = {
        workspaceId: "default",
        rawMeshNodeCredential,
        clientCertificateSha256: finalized.generation.clientCertificateSha256,
        method: "POST" as const,
        rawPath: "/api/v1/remote-workers/mesh-node-admissions",
        operation: "mesh.node.admit",
        protocolBodySha256: digest("stable-body"),
        transportReceiptSha256: digest("transport-1"),
        proofOfPossessionReceiptSha256: digest("pop-1"),
        tlsExporterSha256: digest("exporter-1"),
        idempotencyKey: "mesh-admission:atomic",
      };
      const digestBearerNonce = credentialNonce(db, finalized, "digest-bearer");
      assert.throws(
        () =>
          repo.admitWithNonce({
            nonce: digestBearerNonce,
            command: {
              ...command,
              rawMeshNodeCredential: digest(rawMeshNodeCredential),
              idempotencyKey: "mesh-admission:digest-bearer",
            },
          }),
        /exact 256-bit base64url credential/u,
      );
      assertNonceWasNotConsumed(db, digestBearerNonce);

      const crossWorkspaceNonce = credentialNonce(db, finalized, "cross-workspace");
      assert.throws(
        () =>
          repo.admitWithNonce({
            nonce: crossWorkspaceNonce,
            command: { ...command, workspaceId: "other-workspace", idempotencyKey: "mesh-admission:other" },
          }),
        /join authority/u,
      );
      assertNonceWasNotConsumed(db, crossWorkspaceNonce);

      const crossGenerationNonce = credentialNonce(db, finalized, "cross-generation");
      const crossGenerationAuthority = crossGenerationNonce.authority;
      if (crossGenerationAuthority.kind !== "credential") throw new Error("credential nonce fixture drifted");
      assert.throws(
        () =>
          repo.admitWithNonce({
            nonce: {
              ...crossGenerationNonce,
              authority: {
                ...crossGenerationAuthority,
                workerGeneration: crossGenerationAuthority.workerGeneration + 1,
              },
            },
            command: { ...command, idempotencyKey: "mesh-admission:other-generation" },
          }),
        /nonce authority/u,
      );
      assertNonceWasNotConsumed(db, crossGenerationNonce);

      const admitted = repo.admitWithNonce({ nonce, command });
      assert.equal(admitted.disposition, "admitted");
      assert.equal(admitted.admission.provenance, "remote_worker");
      assert.equal(admitted.binding.joinAuthorityGeneration, issued.authority.joinAuthorityGeneration);
      const meshNode = db
        .prepare(
          `SELECT label, advertise_address, transport, status, capabilities_json, tls_fingerprint
           FROM mesh_nodes WHERE node_id = ?`,
        )
        .get(finalized.generation.nodeId);
      assert.deepEqual(meshNode === undefined ? undefined : { ...meshNode }, {
        label: "Remote worker",
        advertise_address: null,
        transport: "native_tls",
        status: "online",
        capabilities_json: "[]",
        tls_fingerprint: finalized.generation.clientCertificateSha256,
      });

      const replayNonce = credentialNonce(db, finalized, "admit-replay");
      const replayCommand = {
        ...command,
        transportReceiptSha256: digest("transport-retry"),
        proofOfPossessionReceiptSha256: digest("pop-retry"),
        tlsExporterSha256: digest("exporter-retry"),
      };
      const replay = repo.admitWithNonce({
        nonce: replayNonce,
        command: replayCommand,
      });
      assert.equal(replay.disposition, "replayed");
      assert.equal(replay.stableEffectSha256, admitted.stableEffectSha256);
      assertNonceWasConsumed(db, replayNonce);
      assert.throws(() => repo.admitWithNonce({ nonce: replayNonce, command: replayCommand }), /admission nonce/u);
      const attempts = db
        .prepare("SELECT COUNT(*) AS count FROM remote_worker_mesh_node_admission_attempts")
        .get<{ count: number | bigint }>();
      assert.equal(Number(attempts?.count), 2);

      const rollbackNonce = credentialNonce(db, finalized, "admit-replay-rollback");
      db.exec(`
        CREATE TRIGGER trg_test_remote_worker_mesh_replay_rollback
        BEFORE INSERT ON remote_worker_mesh_node_admission_attempts
        WHEN NEW.nonce_sha256 = '${rollbackNonce.nonceSha256}'
        BEGIN SELECT RAISE(ABORT, 'forced replay attempt rollback'); END;
      `);
      assert.throws(
        () => repo.admitWithNonce({ nonce: rollbackNonce, command: replayCommand }),
        /forced replay attempt rollback/u,
      );
      assertNonceWasNotConsumed(db, rollbackNonce);
      db.exec("DROP TRIGGER trg_test_remote_worker_mesh_replay_rollback");
      assert.equal(repo.admitWithNonce({ nonce: rollbackNonce, command: replayCommand }).disposition, "replayed");
      assertNonceWasConsumed(db, rollbackNonce);

      const driftNonce = credentialNonce(db, finalized, "admit-drift");
      assert.throws(
        () =>
          repo.admitWithNonce({
            nonce: driftNonce,
            command: { ...command, protocolBodySha256: digest("changed-stable-body") },
          }),
        /different request bytes/u,
      );
      assertNonceWasNotConsumed(db, driftNonce);

      const current = repo.resolveByRawMeshNodeCredential(rawMeshNodeCredential);
      assert.equal(current?.disposition, "current");
      if (current?.disposition !== "current") throw new Error("current remote admission missing");
      assert.deepEqual(
        repo.compareCurrentAuthorityFence({ ...current.admission, expected: current.fence }),
        current.fence,
      );

      const currentByCredential = repo.resolveCurrentForRuntimeCredential({
        registryWorkspaceId: finalized.generation.registryWorkspaceId,
        bootstrapId: finalized.generation.bootstrapId,
        workerId: finalized.generation.workerId,
        workerGeneration: finalized.generation.workerGeneration,
        nodeId: finalized.generation.nodeId,
        clientCertificateSha256: finalized.generation.clientCertificateSha256,
        protectedAdmissionEnvelopeSha256: finalizedInput.command.verifiedProtectedAdmissionEvidence!.envelopeSha256,
        protectedAdmissionContextSha256: finalizedInput.command.verifiedProtectedAdmissionEvidence!.contextSha256,
        workspaceId: "default",
        credentialId: finalized.credential.credentialId,
        credentialGeneration: finalized.credential.credentialGeneration,
        authorizationCredentialSha256: finalizedInput.command.credentialTokenSha256,
      });
      assert.deepEqual(currentByCredential, current.fence);
      assert.equal(
        repo.resolveCurrentForRuntimeCredential({
          registryWorkspaceId: finalized.generation.registryWorkspaceId,
          bootstrapId: finalized.generation.bootstrapId,
          workerId: finalized.generation.workerId,
          workerGeneration: finalized.generation.workerGeneration,
          nodeId: finalized.generation.nodeId,
          clientCertificateSha256: finalized.generation.clientCertificateSha256,
          protectedAdmissionEnvelopeSha256: finalizedInput.command.verifiedProtectedAdmissionEvidence!.envelopeSha256,
          protectedAdmissionContextSha256: finalizedInput.command.verifiedProtectedAdmissionEvidence!.contextSha256,
          workspaceId: "default",
          credentialId: finalized.credential.credentialId,
          credentialGeneration: finalized.credential.credentialGeneration,
          authorizationCredentialSha256: digest("wrong-runtime-credential"),
        }),
        undefined,
      );

      const now = databaseClock(db);
      const taskId = "task-assignment-claim";
      const sessionId = "session-assignment-claim";
      const turnId = "turn-assignment-claim";
      const durableRunId = "run-assignment-claim";
      new TaskRepository(db).create({ title: "Remote assignment", workspaceId: "default" }, now, { taskId });
      new ChatSessionLifecycleRepository(db).initialize({
        workspaceId: "default",
        sessionId,
        actorId: "operator-a",
        idempotencyKey: "lifecycle:assignment-claim",
        correlationId: "correlation:assignment-claim",
        metadataTimestamp: now,
      });
      new ChatTurnTraceRepository(db).create({
        turnId,
        sessionId,
        userMessageId: "message-assignment-claim",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        startedAt: now,
      });
      const profile = sealChatTurnCapabilityProfile(
        taskBoundCapabilityProfileDraft({
          profileId: "profile-assignment-claim",
          turnId,
          sessionId,
          durableRunId,
          createdAt: now,
        }),
      );
      const parentInput = {
        executionWorkspaceId: "default",
        durableRunId,
        taskId,
        sessionId,
        turnId,
      } as const;
      const parentContext = buildRemoteWorkerAssignmentParentContext(parentInput);
      const parentContextSha256 = remoteWorkerAssignmentParentContextSha256(parentInput);
      const durableRequest = { policyTaskId: taskId, content: "Execute the durable task." } as const;
      const admissionMaterialSha256 = digest(canonicalJsonString({ version: 2, request: durableRequest }));
      const mutationAdmissions = new SessionMutationAdmissionRepository(db);
      const profileAdmission = mutationAdmissions.admit({
        workspaceId: "default",
        sessionId,
        turnId,
        runtimeOwnerId: "runtime-assignment-claim",
        admissionKind: "turn_write",
        aggregateRevision: 1,
        controllerGeneration: 1,
        actorKind: "operator",
        actorId: "operator-a",
        operation: "chat.turn.execute",
        materialSha256: admissionMaterialSha256,
        idempotencyKey: "admission:assignment-claim",
        correlationId: "correlation:assignment-claim",
      }).admission;
      db.transaction("immediate", () => {
        mutationAdmissions.bindCapabilityProfile({
          admissionId: profileAdmission.admissionId,
          workspaceId: profileAdmission.workspaceId,
          sessionId: profileAdmission.sessionId,
          sessionIncarnationId: profileAdmission.sessionIncarnationId,
          turnId: profileAdmission.turnId!,
          profileId: profile.profileId,
          profileHash: profile.hashes.profileHash,
          createdAt: profile.createdAt,
          requestRuntimeClaim: {
            runtimeOwnerId: profileAdmission.runtimeOwnerId!,
            leaseRevision: profileAdmission.runtimeLeaseRevision!,
          },
        });
        new ChatTurnCapabilityProfileRepository(db).create(profile);
      });
      const durablePayload = {
        version: "chat.turn.execute.v2",
        admissionId: profileAdmission.admissionId,
        sessionIncarnationId: profileAdmission.sessionIncarnationId,
        admissionMaterialSha256,
        workspaceId: "default",
        admissionAggregateRevision: profileAdmission.aggregateRevision,
        admissionControllerGeneration: profileAdmission.controllerGeneration,
        effectiveRequestMaterialSha256: digest(
          canonicalJsonString({ version: 1, admissionMaterialSha256, request: durableRequest }),
        ),
        policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: durableRunId },
        requestActor: { actorKind: "operator", actorId: "operator-a" },
        sessionId,
        turnId,
        userMessageId: "message-assignment-claim",
        assistantMessageId: "assistant-assignment-claim",
        capabilityProfileId: profile.profileId,
        capabilityProfileHash: profile.hashes.profileHash,
        branchKind: "append",
        threadEventType: "chat_thread_turn_appended",
        request: durableRequest,
      } as const;
      new DurableRunRepository(db).createRun({
        runId: durableRunId,
        workflowKey: "chat.turn.execute",
        status: "running",
        attemptCount: 2,
        maxAttempts: 3,
        leaseOwnerId: "gateway-assignment-owner",
        leaseHeartbeatAt: now,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        version: 7,
        startedAt: now,
        now,
        payload: durablePayload,
        metadata: {
          remoteWorkerAssignmentParentContext: parentContext,
          remoteWorkerAssignmentParentContextSha256: parentContextSha256,
          capabilityProfileId: profile.profileId,
          capabilityProfileHash: profile.hashes.profileHash,
        },
      });
      mutationAdmissions.bindDurableRun({
        admissionId: profileAdmission.admissionId,
        workspaceId: profileAdmission.workspaceId,
        sessionId: profileAdmission.sessionId,
        sessionIncarnationId: profileAdmission.sessionIncarnationId,
        turnId: profileAdmission.turnId!,
        durableRunId,
        requestRuntimeClaim: {
          runtimeOwnerId: profileAdmission.runtimeOwnerId!,
          leaseRevision: profileAdmission.runtimeLeaseRevision!,
        },
      });
      const manifest: RemoteWorkerAssignmentManifest = {
        schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        registryWorkspaceId: "default",
        ...parentInput,
        capabilityProfileSha256: profile.hashes.profileHash,
        contextSnapshotSha256: digest("assignment-context-snapshot"),
        toolEffectPostureSha256: digest("assignment-tool-posture"),
        pathJailSha256: digest("assignment-path-jail"),
        parentContextSha256,
        requiredCapabilityClasses: ["durable_compute"],
        deadlineAt: "2099-01-01T00:00:00.000Z",
        leaseTtlSeconds: 300,
        maxEventCount: 100,
        maxEventBytes: 4_096,
        eventLowWatermark: 2,
        eventHighWatermark: 5,
        maxOutputBytes: 65_536,
        maxArtifactBytes: 1_048_576,
      };
      const assignments = new RemoteWorkerAssignmentRepository(db);
      const assignment = assignments.createAssignment({
        manifest,
        createdByActorId: "gateway-a",
        idempotencyKey: "assignment-claim:create",
      }).assignment;
      const claimAuthority = {
        registryWorkspaceId: finalized.generation.registryWorkspaceId,
        bootstrapId: finalized.generation.bootstrapId,
        workerId: finalized.generation.workerId,
        workerGeneration: finalized.generation.workerGeneration,
        credentialId: finalized.credential.credentialId,
        credentialGeneration: finalized.credential.credentialGeneration,
        authorizationCredentialSha256: finalizedInput.command.credentialTokenSha256,
        nodeId: finalized.generation.nodeId,
        clientCertificateSha256: finalized.generation.clientCertificateSha256,
        runtimeManifestSha256: finalized.generation.runtimeManifestSha256,
        workspaceCeilingSha256: finalized.generation.workspaceCeilingSha256,
        capabilityCeilingSha256: finalized.generation.capabilityCeilingSha256,
        protectedAdmissionEnvelopeSha256: finalizedInput.command.verifiedProtectedAdmissionEvidence!.envelopeSha256,
        protectedAdmissionContextSha256: finalizedInput.command.verifiedProtectedAdmissionEvidence!.contextSha256,
        claimsSha256: finalized.credential.claimsSha256,
      } as const;
      db.prepare("UPDATE durable_runs SET payload_json = @payloadJson WHERE run_id = @durableRunId").run({
        durableRunId,
        payloadJson: canonicalJsonString({
          version: "chat.turn.execute.v2",
          workspaceId: "default",
          sessionId,
          turnId,
          capabilityProfileId: profile.profileId,
          capabilityProfileHash: profile.hashes.profileHash,
          request: durableRequest,
        }),
      });
      assert.equal(assignments.listTaskBoundChatOffers({ authority: claimAuthority }).items.length, 0);
      db.prepare("UPDATE durable_runs SET payload_json = @payloadJson WHERE run_id = @durableRunId").run({
        durableRunId,
        payloadJson: canonicalJsonString(durablePayload),
      });
      const offers = assignments.listTaskBoundChatOffers({ authority: claimAuthority });
      assert.deepEqual(
        offers.items.map((offer) => offer.assignment.assignmentId),
        [assignment.assignmentId],
      );
      assert.equal(offers.items[0]?.workload.capabilityProfileSha256, profile.hashes.profileHash);
      assert.equal(offers.items[0]?.workload.durableRunVersion, 7);
      assert.equal(
        assignments.resolveTaskBoundChatOffer({
          authority: claimAuthority,
          meshAdmission: currentByCredential!,
          assignmentId: assignment.assignmentId,
          purpose: { kind: "poll" },
        })?.assignment.assignmentId,
        assignment.assignmentId,
      );
      db.prepare("UPDATE durable_runs SET lease_expires_at = @leaseExpiresAt WHERE run_id = @durableRunId").run({
        durableRunId,
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
      });
      assert.equal(
        assignments.resolveTaskBoundChatOffer({
          authority: claimAuthority,
          meshAdmission: currentByCredential!,
          assignmentId: assignment.assignmentId,
          purpose: { kind: "poll" },
        }),
        undefined,
      );
      db.prepare("UPDATE durable_runs SET lease_expires_at = @leaseExpiresAt WHERE run_id = @durableRunId").run({
        durableRunId,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      assert.equal(
        assignments.resolveTaskBoundChatOffer({
          authority: { ...claimAuthority, registryWorkspaceId: "other-workspace" },
          meshAdmission: currentByCredential!,
          assignmentId: assignment.assignmentId,
          purpose: { kind: "poll" },
        }),
        undefined,
      );
      assert.throws(
        () =>
          assignments.resolveTaskBoundChatOffer({
            authority: {
              ...claimAuthority,
              protectedAdmissionContextSha256: digest("assignment-claim:drifted-offer-protected-context"),
            },
            meshAdmission: currentByCredential!,
            assignmentId: assignment.assignmentId,
            purpose: { kind: "poll" },
          }),
        ConflictError,
      );
      assert.throws(
        () =>
          assignments.resolveTaskBoundChatOffer({
            authority: claimAuthority,
            meshAdmission: {
              ...currentByCredential!,
              joinCredentialSha256: digest("assignment-claim:drifted-offer-mesh-credential"),
            },
            assignmentId: assignment.assignmentId,
            purpose: { kind: "poll" },
          }),
        ConflictError,
      );

      const rawLeaseToken = "assignment-claim:worker-proposed-lease-secret";
      const leaseTokenSha256 = digest(rawLeaseToken);
      const claimInput = {
        authority: claimAuthority,
        meshAdmission: currentByCredential!,
        assignmentId: assignment.assignmentId,
        leaseTokenSha256,
        idempotencyKey: "assignment-claim:start",
      } as const;
      db.prepare("UPDATE durable_runs SET payload_json = @payloadJson WHERE run_id = @durableRunId").run({
        durableRunId,
        payloadJson: canonicalJsonString({
          ...durablePayload,
          requestActor: { actorKind: "operator", actorId: "operator-b" },
        }),
      });
      assert.throws(
        () => assignments.claimTaskBoundChatOffer(claimInput),
        /payload conflicts with its frozen admission/u,
      );
      db.prepare("UPDATE durable_runs SET payload_json = @payloadJson WHERE run_id = @durableRunId").run({
        durableRunId,
        payloadJson: canonicalJsonString(durablePayload),
      });
      const claimed = assignments.claimTaskBoundChatOffer(claimInput);
      assert.equal(claimed.disposition, "started");
      assert.equal(claimed.generation.workerId, finalized.generation.workerId);
      assert.equal(claimed.generation.dispatchAuthority.durableRunAttempt, 2);
      assert.equal(claimed.generation.dispatchAuthority.durableRunVersion, 7);
      assert.equal(canonicalJsonString(claimed.workload.payload), canonicalJsonString(durablePayload));
      assert.equal(JSON.stringify(claimed).includes(rawLeaseToken), false);
      const persistedLease = db
        .prepare(
          `SELECT lease_token_sha256
           FROM remote_worker_assignment_leases
           WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
        )
        .get<{ lease_token_sha256: string }>({ assignmentId: assignment.assignmentId });
      assert.equal(persistedLease?.lease_token_sha256, leaseTokenSha256);
      assert.notEqual(persistedLease?.lease_token_sha256, rawLeaseToken);
      assert.equal(assignments.claimTaskBoundChatOffer(claimInput).disposition, "replayed_without_lease_secret");
      assert.throws(
        () => assignments.claimTaskBoundChatOffer({ ...claimInput, leaseTokenSha256: digest("wrong-lease") }),
        /generation conflicts/u,
      );
      assert.equal(assignments.listTaskBoundChatOffers({ authority: claimAuthority }).items.length, 0);
      assert.equal(
        assignments.resolveTaskBoundChatOffer({
          authority: claimAuthority,
          meshAdmission: currentByCredential!,
          assignmentId: assignment.assignmentId,
          purpose: { kind: "poll" },
        }),
        undefined,
      );
      assert.equal(
        assignments.resolveTaskBoundChatOffer({
          authority: claimAuthority,
          meshAdmission: currentByCredential!,
          assignmentId: assignment.assignmentId,
          purpose: { kind: "claim" },
        })?.assignment.assignmentId,
        assignment.assignmentId,
      );
      assert.equal(
        assignments.resolveTaskBoundChatOffer({
          authority: claimAuthority,
          meshAdmission: currentByCredential!,
          assignmentId: assignment.assignmentId,
          purpose: {
            kind: "workload",
            expectedAssignmentGeneration: claimed.generation.assignmentGeneration,
            expectedLeaseRevision: claimed.lease.leaseRevision,
          },
        })?.assignment.assignmentId,
        assignment.assignmentId,
      );
      assert.equal(
        assignments.resolveTaskBoundChatOffer({
          authority: claimAuthority,
          meshAdmission: currentByCredential!,
          assignmentId: assignment.assignmentId,
          purpose: {
            kind: "workload",
            expectedAssignmentGeneration: claimed.generation.assignmentGeneration,
            expectedLeaseRevision: claimed.lease.leaseRevision + 1,
          },
        }),
        undefined,
      );
      assert.equal(
        assignments.resolveTaskBoundChatWorkload({
          authority: claimAuthority,
          meshAdmission: currentByCredential!,
          registryWorkspaceId: "default",
          assignmentId: assignment.assignmentId,
          expectedAssignmentGeneration: claimed.generation.assignmentGeneration,
          expectedLeaseRevision: claimed.lease.leaseRevision,
          leaseTokenSha256,
        })?.workloadSha256,
        claimed.workload.workloadSha256,
      );

      const protectedCommitFence = {
        credentialAuthority: claimAuthority,
        meshAdmission: currentByCredential!,
      } as const;
      assert.equal(
        assignments.resolveActiveAuthorityByLeaseTokenHash(leaseTokenSha256, protectedCommitFence)?.assignment
          .assignmentId,
        assignment.assignmentId,
      );
      const protectedControlInput = {
        registryWorkspaceId: "default",
        assignmentId: assignment.assignmentId,
        expectedAssignmentGeneration: claimed.generation.assignmentGeneration,
        expectedLeaseRevision: claimed.lease.leaseRevision,
        leaseTokenSha256,
      } as const;
      assert.equal(
        assignments.resolveControlReadAuthorityByLeaseTokenHash(protectedControlInput, protectedCommitFence)
          ?.disposition,
        "active",
      );
      const protectedAppendInput = {
        registryWorkspaceId: "default",
        assignmentId: assignment.assignmentId,
        expectedAssignmentGeneration: claimed.generation.assignmentGeneration,
        expectedLeaseRevision: claimed.lease.leaseRevision,
        leaseTokenSha256,
        events: [
          {
            sequence: 1,
            eventId: "assignment-claim:protected-event:1",
            eventType: "status" as const,
            payload: {
              schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
              phase: "running" as const,
              statusSha256: digest("assignment-claim:protected-status:1"),
            },
            previousEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
            workerSentThrough: 1,
          },
        ],
      } as const;
      const appended = assignments.appendEvents(protectedAppendInput, protectedCommitFence);
      assert.equal(appended.disposition, "appended");
      const nextLeaseTokenSha256 = digest("assignment-claim:protected-lease:2");
      const protectedRenewInput = {
        registryWorkspaceId: "default",
        assignmentId: assignment.assignmentId,
        expectedAssignmentGeneration: claimed.generation.assignmentGeneration,
        expectedLeaseRevision: claimed.lease.leaseRevision,
        expectedLeaseTokenSha256: leaseTokenSha256,
        leaseTokenSha256: nextLeaseTokenSha256,
        workerSentThrough: 1,
        idempotencyKey: "assignment-claim:protected-renew:2",
      } as const;
      const renewed = assignments.renewLease(protectedRenewInput, protectedCommitFence);
      assert.equal(renewed.disposition, "renewed");
      assert.throws(
        () =>
          assignments.resolveActiveAuthorityByLeaseTokenHash(nextLeaseTokenSha256, {
            ...protectedCommitFence,
            credentialAuthority: {
              ...protectedCommitFence.credentialAuthority,
              protectedAdmissionContextSha256: digest("assignment-claim:drifted-protected-context"),
            },
          }),
        ConflictError,
      );

      db.close();
      db = createDatabase({ dbPath: join(tempRoot, "gateway.sqlite") });
      const restartedRepo = new RemoteWorkerMeshNodeAdmissionRepository(db);
      restartedRepo.assertAvailable();
      assert.equal(restartedRepo.resolveByRawMeshNodeCredential(rawMeshNodeCredential)?.disposition, "current");

      const rotatedCredentialTokenSha256 = digest("mesh-rotation:token");
      const rotated = new RemoteWorkerAdmissionRepository(db).rotateRuntimeCredential({
        registryWorkspaceId: finalized.credential.registryWorkspaceId,
        workerId: finalized.credential.workerId,
        workerGeneration: finalized.credential.workerGeneration,
        expectedCredentialId: finalized.credential.credentialId,
        expectedCredentialGeneration: finalized.credential.credentialGeneration,
        verifiedTransportReceiptSha256: digest("mesh-rotation:transport"),
        verifiedProofOfPossessionReceiptSha256: digest("mesh-rotation:pop"),
        credentialIssuanceProofSha256: digest("mesh-rotation:issuance"),
        expiresInSeconds: 600,
        credentialTokenSha256: rotatedCredentialTokenSha256,
        idempotencyKey: "mesh-rotation:2",
      });
      const restartedAssignments = new RemoteWorkerAssignmentRepository(db);
      const protectedEventCount = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM remote_worker_assignment_events
             WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
          )
          .get<{ count: number | bigint }>({ assignmentId: assignment.assignmentId })?.count ?? 0,
      );
      const protectedLeaseCount = Number(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM remote_worker_assignment_leases
             WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
          )
          .get<{ count: number | bigint }>({ assignmentId: assignment.assignmentId })?.count ?? 0,
      );
      assert.throws(
        () => restartedAssignments.resolveActiveAuthorityByLeaseTokenHash(nextLeaseTokenSha256, protectedCommitFence),
        ConflictError,
      );
      assert.throws(
        () =>
          restartedAssignments.resolveTaskBoundChatOffer({
            authority: claimAuthority,
            meshAdmission: currentByCredential!,
            assignmentId: assignment.assignmentId,
            purpose: {
              kind: "workload",
              expectedAssignmentGeneration: 1,
              expectedLeaseRevision: 2,
            },
          }),
        ConflictError,
      );
      assert.throws(
        () =>
          restartedAssignments.resolveControlReadAuthorityByLeaseTokenHash(
            { ...protectedControlInput, expectedLeaseRevision: 2, leaseTokenSha256: nextLeaseTokenSha256 },
            protectedCommitFence,
          ),
        ConflictError,
      );
      assert.throws(() => restartedAssignments.appendEvents(protectedAppendInput, protectedCommitFence), ConflictError);
      assert.throws(() => restartedAssignments.renewLease(protectedRenewInput, protectedCommitFence), ConflictError);
      assert.throws(
        () =>
          restartedAssignments.settleAssignment(
            {
              registryWorkspaceId: "default",
              assignmentId: assignment.assignmentId,
              expectedAssignmentGeneration: 1,
              expectedLeaseRevision: 2,
              origin: "worker",
              leaseTokenSha256: nextLeaseTokenSha256,
              outcome: "failed",
              finalEventSequence: 1,
              finalEventSha256: appended.events[0]!.eventSha256,
              failureSha256: digest("assignment-claim:protected-failure"),
              idempotencyKey: "assignment-claim:protected-settle",
            },
            protectedCommitFence,
          ),
        ConflictError,
      );
      assert.equal(
        Number(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM remote_worker_assignment_events
               WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
            )
            .get<{ count: number | bigint }>({ assignmentId: assignment.assignmentId })?.count ?? 0,
        ),
        protectedEventCount,
      );
      assert.equal(
        Number(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM remote_worker_assignment_leases
               WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
            )
            .get<{ count: number | bigint }>({ assignmentId: assignment.assignmentId })?.count ?? 0,
        ),
        protectedLeaseCount,
      );
      assert.equal(
        Number(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements
               WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
            )
            .get<{ count: number | bigint }>({ assignmentId: assignment.assignmentId })?.count ?? 0,
        ),
        0,
      );
      assert.equal(restartedRepo.resolveByRawMeshNodeCredential(rawMeshNodeCredential)?.disposition, "unavailable");
      const rotatedReplayNonce = credentialNonce(db, finalized, "rotated-replay");
      assert.throws(
        () => restartedRepo.admitWithNonce({ nonce: rotatedReplayNonce, command }),
        /credential_expired_or_rotated/u,
      );
      assertNonceWasNotConsumed(db, rotatedReplayNonce);

      new MeshCapabilityNodeAdmissionRepository(db).revoke({
        workspaceId: currentByCredential!.workspaceId,
        nodeId: currentByCredential!.nodeId,
        admissionGeneration: currentByCredential!.admissionGeneration,
        reason: "credential rotated before replacement admission",
        revokedByActorId: "operator-a",
        idempotencyKey: "mesh-admission-revoke:before-rotated",
      });
      const secondRawMeshNodeCredential = "b".repeat(43);
      const secondIssued = restartedRepo.issueJoinAuthority({
        ...issueInput,
        idempotencyKey: "mesh-authority:atomic:rotated",
        rawMeshNodeCredential: secondRawMeshNodeCredential,
      });
      const secondNonceClock = nonceClock(db);
      const secondAdmission = restartedRepo.admitWithNonce({
        nonce: {
          authority: {
            kind: "credential",
            registryWorkspaceId: rotated.credential.registryWorkspaceId,
            workerId: rotated.credential.workerId,
            workerGeneration: rotated.credential.workerGeneration,
            credentialGeneration: rotated.credential.credentialGeneration,
            credentialId: rotated.credential.credentialId,
          },
          nonceSha256: digest("mesh-admission:rotated:nonce"),
          timestamp: secondNonceClock.timestamp,
          expiresAt: secondNonceClock.expiresAt,
        },
        command: {
          ...command,
          rawMeshNodeCredential: secondRawMeshNodeCredential,
          protocolBodySha256: digest("stable-body:rotated"),
          transportReceiptSha256: digest("transport:rotated"),
          proofOfPossessionReceiptSha256: digest("pop:rotated"),
          tlsExporterSha256: digest("exporter:rotated"),
          idempotencyKey: "mesh-admission:atomic:rotated",
        },
      });
      const rotatedMeshAuthority = restartedRepo.resolveCurrentForRuntimeCredential({
        registryWorkspaceId: finalized.generation.registryWorkspaceId,
        bootstrapId: finalized.generation.bootstrapId,
        workerId: finalized.generation.workerId,
        workerGeneration: finalized.generation.workerGeneration,
        nodeId: finalized.generation.nodeId,
        clientCertificateSha256: finalized.generation.clientCertificateSha256,
        protectedAdmissionEnvelopeSha256: finalizedInput.command.verifiedProtectedAdmissionEvidence!.envelopeSha256,
        protectedAdmissionContextSha256: finalizedInput.command.verifiedProtectedAdmissionEvidence!.contextSha256,
        workspaceId: "default",
        credentialId: rotated.credential.credentialId,
        credentialGeneration: rotated.credential.credentialGeneration,
        authorizationCredentialSha256: rotatedCredentialTokenSha256,
      });
      assert.ok(rotatedMeshAuthority);
      const revocationAssignment = restartedAssignments.createAssignment({
        manifest,
        createdByActorId: "gateway-a",
        idempotencyKey: "assignment-claim:mesh-revocation:create",
      }).assignment;
      const revocationLeaseTokenSha256 = digest("assignment-claim:mesh-revocation:lease");
      restartedAssignments.startGeneration({
        registryWorkspaceId: "default",
        assignmentId: revocationAssignment.assignmentId,
        workerId: finalized.generation.workerId,
        workerGeneration: finalized.generation.workerGeneration,
        nodeId: finalized.generation.nodeId,
        nodeAdmissionGeneration: secondAdmission.admission.admissionGeneration,
        dispatchOwnerId: "gateway-assignment-owner",
        durableRunAttempt: 2,
        leaseTokenSha256: revocationLeaseTokenSha256,
        idempotencyKey: "assignment-claim:mesh-revocation:start",
      });
      const rotatedProtectedCommitFence = {
        credentialAuthority: {
          ...claimAuthority,
          credentialId: rotated.credential.credentialId,
          credentialGeneration: rotated.credential.credentialGeneration,
          authorizationCredentialSha256: rotatedCredentialTokenSha256,
          claimsSha256: rotated.credential.claimsSha256,
        },
        meshAdmission: rotatedMeshAuthority!,
      } as const;
      assert.equal(
        restartedAssignments.resolveActiveAuthorityByLeaseTokenHash(
          revocationLeaseTokenSha256,
          rotatedProtectedCommitFence,
        )?.assignment.assignmentId,
        revocationAssignment.assignmentId,
      );
      assert.equal(
        restartedAssignments.resolveTaskBoundChatOffer({
          authority: rotatedProtectedCommitFence.credentialAuthority,
          meshAdmission: rotatedProtectedCommitFence.meshAdmission,
          assignmentId: revocationAssignment.assignmentId,
          purpose: { kind: "workload", expectedAssignmentGeneration: 1, expectedLeaseRevision: 1 },
        })?.assignment.assignmentId,
        revocationAssignment.assignmentId,
      );
      restartedRepo.revokeJoinAuthority({
        registryWorkspaceId: secondIssued.authority.registryWorkspaceId,
        workerId: secondIssued.authority.workerId,
        workerGeneration: secondIssued.authority.workerGeneration,
        workspaceId: secondIssued.authority.workspaceId,
        joinAuthorityGeneration: secondIssued.authority.joinAuthorityGeneration,
        reasonCode: "operator.revoked",
        reason: "test protected assignment commit revocation",
        revokedByActorId: "operator-a",
        idempotencyKey: "mesh-authority-revoke:rotated",
      });
      assert.throws(
        () =>
          restartedAssignments.resolveActiveAuthorityByLeaseTokenHash(
            revocationLeaseTokenSha256,
            rotatedProtectedCommitFence,
          ),
        ConflictError,
      );
      assert.throws(
        () =>
          restartedAssignments.resolveTaskBoundChatOffer({
            authority: rotatedProtectedCommitFence.credentialAuthority,
            meshAdmission: rotatedProtectedCommitFence.meshAdmission,
            assignmentId: revocationAssignment.assignmentId,
            purpose: { kind: "workload", expectedAssignmentGeneration: 1, expectedLeaseRevision: 1 },
          }),
        /current authority fence/u,
      );
      assert.throws(
        () =>
          restartedAssignments.appendEvents(
            {
              registryWorkspaceId: "default",
              assignmentId: revocationAssignment.assignmentId,
              expectedAssignmentGeneration: 1,
              expectedLeaseRevision: 1,
              leaseTokenSha256: revocationLeaseTokenSha256,
              events: [
                {
                  sequence: 1,
                  eventId: "assignment-claim:mesh-revocation:event",
                  eventType: "status",
                  payload: {
                    schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
                    phase: "running",
                    statusSha256: digest("assignment-claim:mesh-revocation:status"),
                  },
                  previousEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
                  workerSentThrough: 1,
                },
              ],
            },
            rotatedProtectedCommitFence,
          ),
        ConflictError,
      );
      assert.equal(
        Number(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM remote_worker_assignment_events
               WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
            )
            .get<{ count: number | bigint }>({ assignmentId: revocationAssignment.assignmentId })?.count ?? 0,
        ),
        0,
      );

      assert.equal(
        restartedRepo.resolveByRawMeshNodeCredential(secondRawMeshNodeCredential)?.disposition,
        "unavailable",
      );
      assert.throws(
        () =>
          restartedRepo.issueJoinAuthority({
            ...issueInput,
            idempotencyKey: "mesh-authority:atomic:rotated",
            rawMeshNodeCredential: "y".repeat(43),
          }),
        /authority_revoked/u,
      );
    } finally {
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("classifies legacy explicitly and fails closed when remote provenance lacks its binding", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const repo = new RemoteWorkerMeshNodeAdmissionRepository(db);
      seedOnlineMeshNode(db, "legacy-node", digest("legacy-cert"));
      const now = databaseClock(db);
      const rawLegacyToken = "join-node-a";
      const token = digest(rawLegacyToken);
      db.prepare(
        `INSERT INTO mesh_join_tokens(token_hash, created_at, expires_at, used_at, used_by_node_id)
         VALUES (@token, @now, @expiresAt, @now, 'legacy-node')`,
      ).run({ token, now, expiresAt: new Date(Date.parse(now) + 60_000).toISOString() });
      db.prepare(
        `INSERT INTO mesh_capability_node_admissions(
           workspace_id,node_id,admission_generation,join_token_sha256,mtls_required,tls_fingerprint,
           admitted_by_actor_id,idempotency_key,request_sha256,admitted_at
         ) VALUES ('default','legacy-node',1,@token,1,@cert,'operator-a','legacy-admit',@request,@now)`,
      ).run({ token, cert: digest("legacy-cert"), request: digest("legacy-request"), now });
      const legacy = repo.resolveExactAdmission({
        workspaceId: "default",
        nodeId: "legacy-node",
        admissionGeneration: 1,
      });
      assert.equal(legacy.disposition, "legacy");
      assert.equal(repo.resolveByRawMeshNodeCredential(rawLegacyToken)?.disposition, "legacy");
      assert.equal(repo.resolveByRawMeshNodeCredential(""), undefined);
      assert.equal(repo.resolveByRawMeshNodeCredential("join node a"), undefined);

      // Simulate detectable corruption without weakening the immutable row: a
      // remote provenance admission must never be treated as legacy merely
      // because its required binding is absent.
      db.exec("DROP TRIGGER trg_mesh_capability_node_admissions_no_update");
      db.prepare(
        "UPDATE mesh_capability_node_admissions SET provenance_kind = 'remote_worker' WHERE node_id = 'legacy-node'",
      ).run();
      const invalid = repo.resolveExactAdmission({
        workspaceId: "default",
        nodeId: "legacy-node",
        admissionGeneration: 1,
      });
      assert.equal(invalid.disposition, "unavailable");
      if (invalid.disposition !== "unavailable") throw new Error("remote corruption did not fail closed");
      assert.equal(invalid.reason, "missing_remote_binding");
    } finally {
      db.close();
    }
  });

  it("fails composition preflight when the reserved migration surface is incomplete", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const repo = new RemoteWorkerMeshNodeAdmissionRepository(db);
      repo.assertAvailable();
      db.exec("DROP TABLE remote_worker_mesh_node_admission_attempts");
      assert.throws(() => repo.assertAvailable(), /migration 194\/137 is unavailable/u);
    } finally {
      db.close();
    }
  });
});

function manifest(seed: string): RemoteWorkerRuntimeManifest {
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: digest(`${seed}:bundle`),
    dependencyLockSha256: digest(`${seed}:lock`),
    vendorTreeSha256: digest(`${seed}:vendor`),
    launcherSha256: digest(`${seed}:launcher`),
    installedTreeManifestSha256: digest(`${seed}:tree`),
    installedTreeFileCount: 5,
    platform: "windows",
    architecture: "x64",
  } as const;
  return {
    payload,
    payloadSha256: digest(canonicalJsonString(payload)),
    signatureAlgorithm: "ed25519",
    signerKeyId: `release-${seed}`,
    signatureBase64Url: Buffer.alloc(64, 0x11).toString("base64url"),
  };
}

function signerPin(): RemoteWorkerProtectedAdmissionSignerPin {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x22)]);
  return {
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
    signatureAlgorithm: "ed25519",
    keysetGeneration: 1,
    keysetReceiptSha256: digest("keyset:1"),
    signerSpkiSha256: digest(spki),
    signerSpkiBase64Url: spki.toString("base64url"),
  };
}

function bootstrapInput(seed: string): CreateRemoteWorkerBootstrapCommand {
  return {
    registryWorkspaceId: "default",
    workerLabel: `Mesh worker ${seed}`,
    platform: "windows",
    architecture: "x64",
    runtimeManifest: manifest(seed),
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute"],
    protectedAdmissionSignerPin: signerPin(),
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${seed}`,
    bootstrapSecretSha256: digest(`${seed}:bootstrap-secret`),
  };
}

function workerSpki(seed: string): Buffer {
  return Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(digest(`${seed}:key`), "hex")]);
}

function protectedAdmissionInput(
  db: DatabaseClient,
  bootstrap: RemoteWorkerBootstrapRecord,
  bootstrapSeed: string,
  connectionSeed: string,
): FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput {
  const nonce = bootstrapNonce(db, bootstrap, connectionSeed);
  const admittedWorkerSpki = workerSpki(bootstrapSeed);
  const base = {
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: digest(`${bootstrapSeed}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: digest(admittedWorkerSpki),
    verifiedClientCertificateSha256: digest(`${bootstrapSeed}:client-certificate`),
    verifiedRuntimeManifestSha256: digest(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls" as const,
    verifiedTransportTrustAnchorSha256: digest(`${bootstrapSeed}:trust-anchor`),
    verifiedTransportReceiptSha256: digest(`${connectionSeed}:transport-receipt`),
    verifiedProofOfPossessionReceiptSha256: digest(`${connectionSeed}:pop-receipt`),
    verifiedDownloadReceiptSha256: digest(`${bootstrapSeed}:download-receipt`),
    verifiedInstalledTreeAttestationSha256: digest(`${bootstrapSeed}:installed-tree-attestation`),
    verifiedInstalledTreeReceiptSha256: digest(`${bootstrapSeed}:installed-tree-receipt`),
    credentialIssuanceProofSha256: digest(`${connectionSeed}:issuance-proof`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: digest(`${connectionSeed}:credential-token`),
    exchangeIdempotencyKey: `exchange:${bootstrapSeed}`,
  };
  const tlsExporterSha256 = digest(`${connectionSeed}:tls-exporter`);
  const contextSha256 = remoteWorkerProtectedAdmissionContextSha256({
    registryWorkspaceId: bootstrap.registryWorkspaceId,
    bootstrapId: bootstrap.bootstrapId,
    workerId: bootstrap.workerId,
    nodeId: bootstrap.nodeId,
    targetWorkerGeneration: bootstrap.targetWorkerGeneration,
    platform: bootstrap.platform,
    architecture: bootstrap.architecture,
    runtimeManifestSha256: base.verifiedRuntimeManifestSha256,
    runtimeManifestPayloadSha256: bootstrap.runtimeManifest.payloadSha256,
    workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    workerPublicKeySpkiSha256: base.verifiedPublicKeySpkiSha256,
    clientCertificateSha256: base.verifiedClientCertificateSha256,
    transportTrustAnchorSha256: base.verifiedTransportTrustAnchorSha256,
    tlsExporterSha256,
    evidenceNonceSha256: nonce.nonceSha256,
    downloadVerificationReceiptSha256: base.verifiedDownloadReceiptSha256,
    installedTreeAttestationSha256: base.verifiedInstalledTreeAttestationSha256,
    installedTreeVerificationReceiptSha256: base.verifiedInstalledTreeReceiptSha256,
  });
  const operationId = Buffer.from(digest(`${connectionSeed}:operation`), "hex").subarray(0, 16);
  const envelope = Buffer.alloc(288);
  envelope.write("GCAE", 0, "ascii");
  envelope.writeUInt16LE(1, 4);
  envelope.writeUInt8(1, 6);
  envelope.writeUInt32LE(288, 8);
  operationId.copy(envelope, 16);
  Buffer.from(nonce.nonceSha256, "hex").copy(envelope, 32);
  envelope.writeBigUInt64LE(BigInt(bootstrap.targetWorkerGeneration), 64);
  Buffer.from(contextSha256, "hex").copy(envelope, 96);
  Buffer.from(base.verifiedRuntimeManifestSha256, "hex").copy(envelope, 128);
  Buffer.from(base.verifiedPublicKeySpkiSha256, "hex").copy(envelope, 160);
  Buffer.from(base.verifiedDownloadReceiptSha256, "hex").copy(envelope, 192);
  Buffer.from(base.verifiedInstalledTreeAttestationSha256, "hex").copy(envelope, 224);
  Buffer.from(base.verifiedInstalledTreeReceiptSha256, "hex").copy(envelope, 256);
  const caller = {
    workerPublicKeySpkiSha256: base.verifiedPublicKeySpkiSha256,
    clientCertificateSha256: base.verifiedClientCertificateSha256,
    transportTrustAnchorSha256: base.verifiedTransportTrustAnchorSha256,
    tlsExporterSha256,
  };
  const pin = bootstrap.protectedAdmissionSignerPin;
  if (!pin) throw new Error("protected signer pin missing");
  const command: FinalizeRemoteWorkerBootstrapAdmissionCommand = {
    ...base,
    verifiedProtectedAdmissionEvidence: {
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
      operationIdBase64Url: operationId.toString("base64url"),
      evidenceNonceSha256: nonce.nonceSha256,
      workerGeneration: bootstrap.targetWorkerGeneration,
      envelopeSha256: digest(envelope),
      envelopeBase64Url: envelope.toString("base64url"),
      keysetReceiptSha256: pin.keysetReceiptSha256,
      signerSpkiSha256: pin.signerSpkiSha256,
      signerSpkiBase64Url: pin.signerSpkiBase64Url,
      signatureBase64Url: Buffer.alloc(64, 0x33).toString("base64url"),
      contextSha256,
      runtimeManifestSha256: base.verifiedRuntimeManifestSha256,
      runtimeManifestPayloadSha256: bootstrap.runtimeManifest.payloadSha256,
      workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
      capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
      ...caller,
      workerPublicKeySpkiBase64Url: admittedWorkerSpki.toString("base64url"),
      authenticatedRemoteCallerBindingSha256: remoteWorkerProtectedAdmissionRemoteCallerBindingSha256(caller),
      downloadVerificationReceiptSha256: base.verifiedDownloadReceiptSha256,
      installedTreeAttestationSha256: base.verifiedInstalledTreeAttestationSha256,
      installedTreeVerificationReceiptSha256: base.verifiedInstalledTreeReceiptSha256,
    },
  };
  return { nonce, command };
}

function bootstrapNonce(
  db: DatabaseClient,
  bootstrap: RemoteWorkerBootstrapRecord,
  seed: string,
): RemoteWorkerNonceConsumeInput {
  const clock = nonceClock(db);
  return {
    authority: {
      kind: "bootstrap",
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      bootstrapId: bootstrap.bootstrapId,
      workerId: bootstrap.workerId,
      targetWorkerGeneration: bootstrap.targetWorkerGeneration,
    },
    nonceSha256: digest(`${seed}:nonce`),
    timestamp: clock.timestamp,
    expiresAt: clock.expiresAt,
  };
}

function credentialNonce(
  db: DatabaseClient,
  finalized: ReturnType<RemoteWorkerAdmissionRepository["finalizeBootstrapAdmissionWithNonce"]>,
  seed: string,
): RemoteWorkerNonceConsumeInput {
  const clock = nonceClock(db);
  return {
    authority: {
      kind: "credential",
      registryWorkspaceId: finalized.credential.registryWorkspaceId,
      workerId: finalized.credential.workerId,
      workerGeneration: finalized.credential.workerGeneration,
      credentialGeneration: finalized.credential.credentialGeneration,
      credentialId: finalized.credential.credentialId,
    },
    nonceSha256: digest(`${seed}:nonce`),
    timestamp: clock.timestamp,
    expiresAt: clock.expiresAt,
  };
}

function nonceClock(db: DatabaseClient): { timestamp: string; expiresAt: string } {
  const row = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS timestamp,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds') AS expires_at`,
    )
    .get<{ timestamp: string; expires_at: string }>();
  if (!row) throw new Error("database clock unavailable");
  return { timestamp: row.timestamp, expiresAt: row.expires_at };
}

function databaseClock(db: DatabaseClient): string {
  const row = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get<{ now: string }>();
  if (!row) throw new Error("database clock unavailable");
  return row.now;
}

function assertNonceWasNotConsumed(db: DatabaseClient, nonce: RemoteWorkerNonceConsumeInput): void {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM remote_worker_credential_request_nonces WHERE nonce_sha256 = @nonce")
    .get<{ count: number | bigint }>({ nonce: nonce.nonceSha256 });
  assert.equal(Number(row?.count), 0);
}

function assertNonceWasConsumed(db: DatabaseClient, nonce: RemoteWorkerNonceConsumeInput): void {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM remote_worker_credential_request_nonces WHERE nonce_sha256 = @nonce")
    .get<{ count: number | bigint }>({ nonce: nonce.nonceSha256 });
  assert.equal(Number(row?.count), 1);
}

function seedOnlineMeshNode(db: DatabaseClient, nodeId: string, tlsFingerprint: string): void {
  const now = databaseClock(db);
  db.prepare(
    `INSERT INTO mesh_nodes(
       node_id,label,advertise_address,transport,status,capabilities_json,tls_fingerprint,joined_at,last_seen_at
     ) VALUES (@nodeId,'Remote worker',NULL,'native_tls','online','[]',@tlsFingerprint,@now,@now)`,
  ).run({ nodeId, tlsFingerprint, now });
}
