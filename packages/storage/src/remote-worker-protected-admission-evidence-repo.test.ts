import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerProtectedAdmissionRemoteCallerBindingSha256,
  remoteWorkerProtectedAdmissionContextSha256,
  type CreateRemoteWorkerBootstrapCommand,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerBootstrapRecord,
  type RemoteWorkerProtectedAdmissionSignerPin,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import type { DatabaseClient, DbStatement } from "./db.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import {
  RemoteWorkerAdmissionRepository,
  type FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput,
} from "./remote-worker-admission-repo.js";
import type { RemoteWorkerNonceConsumeInput } from "./remote-worker-nonce-repo.js";
import { createDatabase } from "./sqlite.js";

const clients: DatabaseClient[] = [];
const tempDirectories: string[] = [];
const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const digest = (value: string | Uint8Array): string =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
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

function signerPin(generation = 1): RemoteWorkerProtectedAdmissionSignerPin {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x22)]);
  return {
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
    signatureAlgorithm: "ed25519",
    keysetGeneration: generation,
    keysetReceiptSha256: digest(`keyset:${String(generation)}`),
    signerSpkiSha256: digest(spki),
    signerSpkiBase64Url: spki.toString("base64url"),
  };
}

function workerSpki(seed: string): Buffer {
  return Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(digest(`${seed}:worker-key-bytes`), "hex"),
  ]);
}

function bootstrapInput(seed: string): CreateRemoteWorkerBootstrapCommand {
  return {
    registryWorkspaceId: "default",
    workerLabel: `Protected worker ${seed}`,
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

function nonceInput(
  db: DatabaseClient,
  bootstrap: RemoteWorkerBootstrapRecord,
  seed: string,
): RemoteWorkerNonceConsumeInput {
  const clockSql =
    db.dialect === "postgres"
      ? `SELECT
           to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp,
           to_char((clock_timestamp() + interval '60 seconds') AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`
      : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS timestamp,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds') AS expires_at`;
  const clock = db.prepare(clockSql).get() as { timestamp: string; expires_at: string };
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
    expiresAt: clock.expires_at,
  };
}

function admissionInput(
  db: DatabaseClient,
  bootstrap: RemoteWorkerBootstrapRecord,
  bootstrapSeed: string,
  connectionSeed: string,
  nonceSha256Override?: string,
): FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput {
  const generatedNonce = nonceInput(db, bootstrap, connectionSeed);
  const nonce =
    nonceSha256Override === undefined ? generatedNonce : { ...generatedNonce, nonceSha256: nonceSha256Override };
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
  if (pin === undefined) throw new Error("protected signer pin missing");
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

function openFileHarness(): {
  readonly dbPath: string;
  readonly db: DatabaseClient;
  readonly repo: RemoteWorkerAdmissionRepository;
} {
  const directory = mkdtempSync(join(tmpdir(), "gc-protected-admission-"));
  tempDirectories.push(directory);
  const dbPath = join(directory, "gateway.sqlite");
  const db = createDatabase({ dbPath });
  clients.push(db);
  return { dbPath, db, repo: new RemoteWorkerAdmissionRepository(db) };
}

describe("RemoteWorkerAdmissionRepository protected evidence", () => {
  it("settles pin, nonce, generation, credential, and evidence atomically and replays after restart without a secret", () => {
    const first = openFileHarness();
    const bootstrap = first.repo.createBootstrap(bootstrapInput("restart")).record;
    assert.deepEqual(bootstrap.protectedAdmissionSignerPin, signerPin());
    const initial = admissionInput(first.db, bootstrap, "restart", "connection-1");
    const admitted = first.repo.finalizeBootstrapAdmissionWithNonce(initial);
    assert.equal(admitted.disposition, "admitted");
    const evidence = first.repo.findProtectedAdmissionEvidenceRecord("default", bootstrap.workerId, 1);
    assert.ok(evidence);
    assert.equal(evidence.authenticatedOperatorActorId, "operator-a");
    assert.equal(evidence.clientCertificateSha256, initial.command.verifiedClientCertificateSha256);
    assert.equal(JSON.stringify(evidence).includes("credential-token"), false);

    first.db.close();
    clients.splice(clients.indexOf(first.db), 1);
    const reopened = createDatabase({ dbPath: first.dbPath });
    clients.push(reopened);
    const repo = new RemoteWorkerAdmissionRepository(reopened);
    const canonicalBootstrap = repo.getBootstrap("default", bootstrap.bootstrapId);
    const replayInput = admissionInput(reopened, canonicalBootstrap, "restart", "connection-2");
    const replay = repo.finalizeBootstrapAdmissionWithNonce(replayInput);
    assert.equal(replay.disposition, "replayed_without_credential_secret");
    assert.deepEqual(replay.generation, admitted.generation);
    assert.deepEqual(replay.credential, admitted.credential);
    assert.equal("credentialSecret" in replay, false);
    const counts = reopened
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM remote_worker_bootstrap_request_nonces WHERE bootstrap_id = @bootstrapId) AS nonces,
           (SELECT COUNT(*) FROM remote_worker_generations WHERE bootstrap_id = @bootstrapId) AS generations,
           (SELECT COUNT(*) FROM remote_worker_runtime_credentials WHERE worker_id = @workerId) AS credentials,
           (SELECT COUNT(*) FROM remote_worker_protected_admission_evidence WHERE bootstrap_id = @bootstrapId) AS evidence`,
      )
      .get({ bootstrapId: bootstrap.bootstrapId, workerId: bootstrap.workerId }) as Record<string, number>;
    assert.deepEqual({ ...counts }, { nonces: 1, generations: 1, credentials: 1, evidence: 1 });
    assert.deepEqual(repo.findProtectedAdmissionEvidenceRecord("default", bootstrap.workerId, 1), evidence);
  });

  it("rejects signer drift before nonce consumption and rolls every authority back if evidence cannot persist", () => {
    const { db, repo } = openFileHarness();
    const bootstrap = repo.createBootstrap(bootstrapInput("rollback")).record;
    const drift = admissionInput(db, bootstrap, "rollback", "drift");
    assert.throws(
      () =>
        repo.finalizeBootstrapAdmissionWithNonce({
          ...drift,
          command: {
            ...drift.command,
            verifiedProtectedAdmissionEvidence: {
              ...drift.command.verifiedProtectedAdmissionEvidence!,
              signerSpkiSha256: digest("drifted-signer"),
            },
          },
        }),
      /protected admission evidence/u,
    );

    const facade: DatabaseClient = {
      dialect: db.dialect,
      prepare(sql: string): DbStatement {
        if (sql.replace(/\s+/gu, " ").trim().startsWith("INSERT INTO remote_worker_protected_admission_evidence")) {
          return throwingStatement();
        }
        return db.prepare(sql);
      },
      exec: (sql) => db.exec(sql),
      close: () => undefined,
      transaction: (mode, callback) => db.transaction(mode, callback),
    };
    const failing = new RemoteWorkerAdmissionRepository(facade);
    assert.throws(() => failing.finalizeBootstrapAdmissionWithNonce(admissionInput(db, bootstrap, "rollback", "fail")));
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM remote_worker_bootstrap_request_nonces WHERE bootstrap_id = @bootstrapId) AS nonces,
           (SELECT COUNT(*) FROM remote_worker_generations WHERE bootstrap_id = @bootstrapId) AS generations,
           (SELECT COUNT(*) FROM remote_worker_runtime_credentials WHERE worker_id = @workerId) AS credentials,
           (SELECT COUNT(*) FROM remote_worker_protected_admission_evidence WHERE bootstrap_id = @bootstrapId) AS evidence`,
      )
      .get({ bootstrapId: bootstrap.bootstrapId, workerId: bootstrap.workerId }) as Record<string, number>;
    assert.deepEqual({ ...counts }, { nonces: 0, generations: 0, credentials: 0, evidence: 0 });
  });

  it("enforces durable operation uniqueness and records immutable revocation lineage", () => {
    const { db, repo } = openFileHarness();
    const firstBootstrap = repo.createBootstrap(bootstrapInput("unique-a")).record;
    const firstInput = admissionInput(db, firstBootstrap, "unique-a", "unique-a");
    repo.finalizeBootstrapAdmissionWithNonce(firstInput);

    const firstEvidence = firstInput.command.verifiedProtectedAdmissionEvidence!;
    for (const duplicate of ["operation", "nonce", "envelope"] as const) {
      const seed = `unique-${duplicate}`;
      const duplicateBootstrap = repo.createBootstrap(bootstrapInput(seed)).record;
      const candidate = admissionInput(
        db,
        duplicateBootstrap,
        seed,
        seed,
        duplicate === "nonce" ? firstEvidence.evidenceNonceSha256 : undefined,
      );
      const candidateEvidence = candidate.command.verifiedProtectedAdmissionEvidence!;
      const evidence = {
        ...candidateEvidence,
        ...(duplicate === "operation" ? { operationIdBase64Url: firstEvidence.operationIdBase64Url } : {}),
        ...(duplicate === "envelope"
          ? { envelopeSha256: firstEvidence.envelopeSha256, envelopeBase64Url: firstEvidence.envelopeBase64Url }
          : {}),
      };
      assert.throws(() =>
        repo.finalizeBootstrapAdmissionWithNonce({
          ...candidate,
          command: { ...candidate.command, verifiedProtectedAdmissionEvidence: evidence },
        }),
      );
      assert.equal(repo.findCurrentGeneration("default", duplicateBootstrap.workerId), undefined);
    }

    const control = repo.revokeGeneration({
      registryWorkspaceId: "default",
      workerId: firstBootstrap.workerId,
      workerGeneration: 1,
      reasonCode: "operator.revoked",
      reasonSha256: digest("operator revoked protected worker"),
      actorId: "operator-a",
      idempotencyKey: "revoke:unique-a",
    });
    const evidence = repo.findProtectedAdmissionEvidenceRecord("default", firstBootstrap.workerId, 1);
    assert.equal(evidence?.revokedAt, control.createdAt);
    assert.throws(() =>
      db
        .prepare(
          `UPDATE remote_worker_protected_admission_evidence
           SET context_sha256 = @contextSha256 WHERE worker_id = @workerId`,
        )
        .run({ contextSha256: digest("tampered-context"), workerId: firstBootstrap.workerId }),
    );
    assert.throws(() =>
      db
        .prepare("DELETE FROM remote_worker_protected_admission_revocations WHERE worker_id = @workerId")
        .run({ workerId: firstBootstrap.workerId }),
    );
  });

  postgresIt(
    "keeps PostgreSQL 136 at parity through protected settlement and restart replay",
    { timeout: 120_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = digest(`${Date.now().toString()}:${Math.random().toString()}`).slice(0, 24);
      const schemaName = `protected_admission_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 1 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const migrationPool = new Pool({ connectionString: scopedUrl.toString(), max: 2 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: migrationPool },
      );
      let first: PostgresSyncDatabaseClient | undefined;
      let second: PostgresSyncDatabaseClient | undefined;
      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        first = new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database,
          applicationName: `protected-admission-first-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        const firstRepo = new RemoteWorkerAdmissionRepository(first);
        const bootstrap = firstRepo.createBootstrap(bootstrapInput("postgres-restart")).record;
        const admitted = firstRepo.finalizeBootstrapAdmissionWithNonce(
          admissionInput(first, bootstrap, "postgres-restart", "postgres-connection-1"),
        );
        assert.equal(admitted.disposition, "admitted");
        const evidence = firstRepo.findProtectedAdmissionEvidenceRecord("default", bootstrap.workerId, 1);
        assert.ok(evidence);
        assert.equal(Buffer.from(evidence.workerPublicKeySpkiBase64Url, "base64url").byteLength, 44);
        first.close();
        first = undefined;

        second = new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database,
          applicationName: `protected-admission-second-${suffix}`,
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        const secondRepo = new RemoteWorkerAdmissionRepository(second);
        const replay = secondRepo.finalizeBootstrapAdmissionWithNonce(
          admissionInput(
            second,
            secondRepo.getBootstrap("default", bootstrap.bootstrapId),
            "postgres-restart",
            "postgres-connection-2",
          ),
        );
        assert.equal(replay.disposition, "replayed_without_credential_secret");
        assert.deepEqual(replay.generation, admitted.generation);
        assert.deepEqual(replay.credential, admitted.credential);
        assert.deepEqual(secondRepo.findProtectedAdmissionEvidenceRecord("default", bootstrap.workerId, 1), evidence);
      } finally {
        first?.close();
        second?.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );
});

function throwingStatement(): DbStatement {
  const fail = (): never => {
    throw new Error("injected protected evidence persistence failure");
  };
  return { run: fail, get: fail, all: fail };
}
