import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerProtectedAdmissionContextSha256,
  remoteWorkerProtectedAdmissionRemoteCallerBindingSha256,
  type CreateRemoteWorkerBootstrapCommand,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerBootstrapRecord,
  type RemoteWorkerProtectedAdmissionSignerPin,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import {
  RemoteWorkerAdmissionRepository,
  type FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput,
} from "./remote-worker-admission-repo.js";
import { RemoteWorkerMeshNodeAdmissionRepository } from "./remote-worker-mesh-node-admission-repo.js";
import type { RemoteWorkerNonceConsumeInput } from "./remote-worker-nonce-repo.js";
import { createDatabase } from "./sqlite.js";

const digest = (value: string | Uint8Array): string =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");

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

      db.close();
      db = createDatabase({ dbPath: join(tempRoot, "gateway.sqlite") });
      const restartedRepo = new RemoteWorkerMeshNodeAdmissionRepository(db);
      restartedRepo.assertAvailable();
      assert.equal(restartedRepo.resolveByRawMeshNodeCredential(rawMeshNodeCredential)?.disposition, "current");

      new RemoteWorkerAdmissionRepository(db).rotateRuntimeCredential({
        registryWorkspaceId: finalized.credential.registryWorkspaceId,
        workerId: finalized.credential.workerId,
        workerGeneration: finalized.credential.workerGeneration,
        expectedCredentialId: finalized.credential.credentialId,
        expectedCredentialGeneration: finalized.credential.credentialGeneration,
        verifiedTransportReceiptSha256: digest("mesh-rotation:transport"),
        verifiedProofOfPossessionReceiptSha256: digest("mesh-rotation:pop"),
        credentialIssuanceProofSha256: digest("mesh-rotation:issuance"),
        expiresInSeconds: 600,
        credentialTokenSha256: digest("mesh-rotation:token"),
        idempotencyKey: "mesh-rotation:2",
      });
      assert.equal(restartedRepo.resolveByRawMeshNodeCredential(rawMeshNodeCredential)?.disposition, "unavailable");
      const rotatedReplayNonce = credentialNonce(db, finalized, "rotated-replay");
      assert.throws(
        () => restartedRepo.admitWithNonce({ nonce: rotatedReplayNonce, command }),
        /credential_expired_or_rotated/u,
      );
      assertNonceWasNotConsumed(db, rotatedReplayNonce);

      restartedRepo.revokeJoinAuthority({
        registryWorkspaceId: issued.authority.registryWorkspaceId,
        workerId: issued.authority.workerId,
        workerGeneration: issued.authority.workerGeneration,
        workspaceId: issued.authority.workspaceId,
        joinAuthorityGeneration: issued.authority.joinAuthorityGeneration,
        reasonCode: "operator.revoked",
        reason: "test revocation",
        revokedByActorId: "operator-a",
        idempotencyKey: "mesh-authority-revoke:atomic",
      });
      assert.equal(restartedRepo.resolveByRawMeshNodeCredential(rawMeshNodeCredential)?.disposition, "unavailable");
      assert.throws(
        () => restartedRepo.issueJoinAuthority({ ...issueInput, rawMeshNodeCredential: "y".repeat(43) }),
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
