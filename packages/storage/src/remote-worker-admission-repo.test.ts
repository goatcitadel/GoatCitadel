import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  ConflictError,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerRuntimeCredentialClaims,
  canonicalJsonString,
  type CreateRemoteWorkerBootstrapCommand,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerRuntimeCredentialClaims,
  type RemoteWorkerRuntimeManifest,
  type RotateRemoteWorkerRuntimeCredentialCommand,
} from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerNonceRepository, type RemoteWorkerNonceConsumeInput } from "./remote-worker-nonce-repo.js";
import { createDatabase } from "./sqlite.js";

const clients: DatabaseClient[] = [];
const D = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

function manifest(seed = "a", platform = "windows", architecture = "x64"): RemoteWorkerRuntimeManifest {
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D(`${seed}:bundle`),
    dependencyLockSha256: D(`${seed}:lock`),
    vendorTreeSha256: D(`${seed}:vendor`),
    launcherSha256: D(`${seed}:launcher`),
    installedTreeManifestSha256: D(`${seed}:tree`),
    installedTreeFileCount: 42,
    platform,
    architecture,
  };
  return {
    payload,
    payloadSha256: D(canonicalJsonString(payload)),
    signatureAlgorithm: "ed25519",
    signerKeyId: `release-key-${seed}`,
    signatureBase64Url: "A".repeat(86),
  };
}

function bootstrapInput(seed = "a", overrides: Partial<CreateRemoteWorkerBootstrapCommand> = {}) {
  return {
    registryWorkspaceId: "default",
    workerLabel: `Worker ${seed}`,
    platform: "windows",
    architecture: "x64",
    runtimeManifest: manifest(seed),
    allowedWorkspaceIds: ["default"],
    capabilityClasses: [
      "durable_compute",
      "gateway_inference",
    ] as CreateRemoteWorkerBootstrapCommand["capabilityClasses"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${seed}`,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
    ...overrides,
  } satisfies CreateRemoteWorkerBootstrapCommand;
}

function finalizeInput(
  bootstrap: ReturnType<RemoteWorkerAdmissionRepository["createBootstrap"]>["record"],
  seed = "a",
  overrides: Partial<FinalizeRemoteWorkerBootstrapAdmissionCommand> = {},
) {
  return {
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: D(`${seed}:spki`),
    verifiedClientCertificateSha256: D(`${seed}:certificate`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: D(`${seed}:trust-anchor`),
    verifiedTransportReceiptSha256: D(`${seed}:transport-receipt`),
    verifiedProofOfPossessionReceiptSha256: D(`${seed}:pop-receipt`),
    verifiedDownloadReceiptSha256: D(`${seed}:download-receipt`),
    verifiedInstalledTreeAttestationSha256: D(`${seed}:installed-tree-attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${seed}:installed-tree-receipt`),
    credentialIssuanceProofSha256: D(`${seed}:issuance-proof`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${seed}:credential-token-1`),
    exchangeIdempotencyKey: `exchange:${seed}`,
    ...overrides,
  } satisfies FinalizeRemoteWorkerBootstrapAdmissionCommand;
}

function bootstrapNonceInput(
  db: DatabaseClient,
  bootstrap: ReturnType<RemoteWorkerAdmissionRepository["createBootstrap"]>["record"],
  seed: string,
): RemoteWorkerNonceConsumeInput {
  const clock = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS timestamp,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds') AS expires_at`,
    )
    .get() as { timestamp: string; expires_at: string };
  return {
    authority: {
      kind: "bootstrap",
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      bootstrapId: bootstrap.bootstrapId,
      workerId: bootstrap.workerId,
      targetWorkerGeneration: bootstrap.targetWorkerGeneration,
    },
    nonceSha256: D(`${seed}:nonce`),
    timestamp: clock.timestamp,
    expiresAt: clock.expires_at,
  };
}

function harness() {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  return { db, repo: new RemoteWorkerAdmissionRepository(db) };
}

describe("RemoteWorkerAdmissionRepository", () => {
  it("creates an immutable hash-only bootstrap and replays without returning secret material", () => {
    const { db, repo } = harness();
    const input = bootstrapInput();
    const mismatchedManifest = manifest("payload-mismatch");
    assert.throws(
      () =>
        repo.createBootstrap(
          bootstrapInput("payload-mismatch", {
            runtimeManifest: { ...mismatchedManifest, payloadSha256: D("wrong canonical payload bytes") },
          }),
        ),
      /payload digest/u,
    );
    const created = repo.createBootstrap(input);
    assert.equal(created.disposition, "created");
    assert.equal(created.record.state, "pending");
    assert.equal(created.record.targetWorkerGeneration, 1);
    assert.equal(created.record.allowedWorkspaceIds[0], "default");
    assert.equal("publicKeySpkiSha256" in created.record, false);
    assert.equal("clientCertificateSha256" in created.record, false);
    assert.equal("bootstrapSecretSha256" in created.record, false);
    assert.doesNotMatch(JSON.stringify(created), /bootstrapSecret|credentialToken|tokenSha256/u);

    const replay = repo.createBootstrap({ ...input, bootstrapSecretSha256: D("different-generated-secret") });
    assert.equal(replay.disposition, "replayed_without_secret");
    assert.deepEqual(replay.record, created.record);
    assert.throws(() => repo.createBootstrap({ ...input, workerLabel: "Changed worker" }), ConflictError);

    const stored = db
      .prepare("SELECT bootstrap_secret_sha256 FROM remote_worker_bootstrap_requests WHERE bootstrap_id = ?")
      .get(created.record.bootstrapId) as { bootstrap_secret_sha256: string };
    assert.equal(stored.bootstrap_secret_sha256, input.bootstrapSecretSha256);
    assert.throws(() =>
      db
        .prepare("UPDATE remote_worker_bootstrap_requests SET worker_label = 'tampered' WHERE bootstrap_id = ?")
        .run(created.record.bootstrapId),
    );
    assert.throws(() =>
      db.prepare("DELETE FROM remote_worker_bootstrap_requests WHERE bootstrap_id = ?").run(created.record.bootstrapId),
    );
  });

  it("requires the registry workspace as the first direct-SQL workspace ceiling row", () => {
    const { db, repo } = harness();
    db.prepare(
      `INSERT OR IGNORE INTO workspaces (
         workspace_id, name, description, slug, lifecycle_status, archived_at,
         workspace_prefs_json, created_at, updated_at, citadel_id
       ) VALUES ('research', 'Research', NULL, 'research', 'active', NULL, '{}',
         '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:00.000Z', 'personal')`,
    ).run();
    const source = repo.createBootstrap(bootstrapInput("direct-scope-source")).record;
    db.prepare(
      `INSERT INTO remote_worker_bootstrap_requests (
         registry_workspace_id, bootstrap_id, worker_id, node_id, target_worker_generation,
         worker_label, platform, architecture, runtime_manifest_json, runtime_manifest_sha256,
         allowed_workspace_count, workspace_ceiling_sha256, capability_class_count,
         capability_ceiling_sha256, bootstrap_secret_sha256, expires_at, created_by_actor_id,
         idempotency_key, request_sha256, created_at
       )
       SELECT registry_workspace_id, 'direct-scope-bootstrap', 'direct-scope-worker', 'direct-scope-node', 1,
         worker_label, platform, architecture, runtime_manifest_json, runtime_manifest_sha256,
         1, @workspaceCeilingSha256, capability_class_count,
         capability_ceiling_sha256, @bootstrapSecretSha256,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+300 seconds'), created_by_actor_id,
         'direct-scope-idempotency', @requestSha256, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       FROM remote_worker_bootstrap_requests
       WHERE registry_workspace_id = 'default' AND bootstrap_id = @sourceBootstrapId`,
    ).run({
      sourceBootstrapId: source.bootstrapId,
      workspaceCeilingSha256: D("direct-scope-ceiling"),
      bootstrapSecretSha256: D("direct-scope-secret"),
      requestSha256: D("direct-scope-request"),
    });

    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO remote_worker_bootstrap_allowed_workspaces (
             registry_workspace_id, bootstrap_id, allowed_workspace_id
           ) VALUES ('default', 'direct-scope-bootstrap', 'research')`,
        )
        .run(),
    );
    assert.doesNotThrow(() =>
      db
        .prepare(
          `INSERT INTO remote_worker_bootstrap_allowed_workspaces (
             registry_workspace_id, bootstrap_id, allowed_workspace_id
           ) VALUES ('default', 'direct-scope-bootstrap', 'default')`,
        )
        .run(),
    );
  });

  it("rejects malformed, wrong-typed, duplicate-key, and noncanonical SQLite manifest JSON", () => {
    const { db } = harness();
    const validManifestJson = canonicalJsonString(manifest("direct-json"));
    const validManifest = JSON.parse(validManifestJson) as RemoteWorkerRuntimeManifest;
    const payloadJson = canonicalJsonString(validManifest.payload);
    const duplicateRootKeyJson = `{"payload":${payloadJson},"payload":${payloadJson},"payloadSha256":"${validManifest.payloadSha256}","signatureAlgorithm":"ed25519","signatureBase64Url":"${validManifest.signatureBase64Url}","signerKeyId":"${validManifest.signerKeyId}"}`;
    const wrongPayloadTypeJson = canonicalJsonString({ ...validManifest, payload: [] });
    const wrongFileCountTypeJson = canonicalJsonString({
      ...validManifest,
      payload: { ...validManifest.payload, installedTreeFileCount: "42" },
    });

    for (const [index, rawJson] of [
      "{",
      "[]",
      duplicateRootKeyJson,
      ` ${validManifestJson}`,
      wrongPayloadTypeJson,
      wrongFileCountTypeJson,
    ].entries()) {
      assert.throws(() => insertDirectBootstrap(db, `invalid-json-${index}`, rawJson));
    }
    assert.equal(insertDirectBootstrap(db, "canonical-json", validManifestJson).changes, 1);
  });

  it("rejects malformed and noncanonical timestamps on every direct-SQL authority table", () => {
    const { db, repo } = harness();
    const pending = repo.createBootstrap(bootstrapInput("direct-time-generation")).record;
    const admittedBootstrap = repo.createBootstrap(bootstrapInput("direct-time-child")).record;
    const admitted = repo.finalizeBootstrapAdmission(finalizeInput(admittedBootstrap, "direct-time-child"));

    for (const [index, timestamp] of ["zzzz", "2999-01-01T00:00:00Z"].entries()) {
      assert.throws(() =>
        insertDirectBootstrap(db, `invalid-time-${index}`, canonicalJsonString(manifest(`time-${index}`)), timestamp),
      );
      assert.throws(() => insertDirectGeneration(db, pending, `invalid-generation-time-${index}`, timestamp));
      assert.throws(() => insertDirectCredential(db, admitted, `invalid-credential-time-${index}`, timestamp));
      assert.throws(() => insertDirectControl(db, admitted, `invalid-control-time-${index}`, timestamp));
    }
  });

  it("enforces SQLite bootstrap TTL and clock skew at millisecond precision", () => {
    const { db } = harness();
    const clock = readSqliteClock(db);
    const manifestJson = canonicalJsonString(manifest("ttl-precision"));

    assert.equal(
      insertDirectBootstrap(
        db,
        "ttl-exact-600",
        manifestJson,
        clock.now,
        new Date(Date.parse(clock.now) + 600_000).toISOString(),
      ).changes,
      1,
    );
    for (const [index, ttlMilliseconds] of [600_001, 600_999].entries()) {
      assert.throws(() =>
        insertDirectBootstrap(
          db,
          `ttl-over-${index}`,
          manifestJson,
          clock.now,
          new Date(Date.parse(clock.now) + ttlMilliseconds).toISOString(),
        ),
      );
    }

    const skewedCreatedAt = new Date(Date.parse(clock.now) - 1_001).toISOString();
    assert.throws(() =>
      insertDirectBootstrap(
        db,
        "clock-skew-over",
        manifestJson,
        skewedCreatedAt,
        new Date(Date.parse(skewedCreatedAt) + 300_000).toISOString(),
      ),
    );
    for (const [index, invalidTimestamp] of [
      "2026-02-30T12:00:00.000Z",
      "2026-02-29T12:00:00.000Z",
      "2999-01-01T00:00:00Z",
    ].entries()) {
      assert.throws(() =>
        insertDirectBootstrap(db, `invalid-calendar-${index}`, manifestJson, invalidTimestamp, invalidTimestamp),
      );
    }
  });

  it("rejects malformed, wrong-typed, duplicate-key, and noncanonical SQLite credential claims", () => {
    const { db, repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput("direct-claims")).record;
    const admitted = repo.finalizeBootstrapAdmission(finalizeInput(bootstrap, "direct-claims"));
    const validClaimsJson = canonicalJsonString(admitted.credential.claims);
    const duplicateClaimsKeyJson = `{"purpose":"worker_runtime",${validClaimsJson.slice(1)}`;
    const wrongWorkspaceTypeJson = canonicalJsonString({
      ...admitted.credential.claims,
      allowedWorkspaceIds: "default",
    });
    const extraClaimJson = canonicalJsonString({ ...admitted.credential.claims, elevated: true });

    for (const [index, claimsJson] of [
      "{",
      "[]",
      duplicateClaimsKeyJson,
      ` ${validClaimsJson}`,
      wrongWorkspaceTypeJson,
      extraClaimJson,
    ].entries()) {
      assert.throws(() => insertDirectCredential(db, admitted, `invalid-claims-${index}`, undefined, claimsJson));
    }
    assert.equal(insertDirectCredential(db, admitted, "canonical-claims", undefined, validClaimsJson).changes, 1);
  });

  it("atomically admits one generation and purpose-bound credential with verified identity bindings", () => {
    const { db, repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput()).record;
    assert.throws(
      () =>
        repo.finalizeBootstrapAdmission(
          finalizeInput(bootstrap, "a", { verifiedRuntimeManifestSha256: D("wrong-manifest") }),
        ),
      ConflictError,
    );
    const generationCount = db.prepare("SELECT COUNT(*) AS count FROM remote_worker_generations").get() as {
      count: number;
    };
    assert.equal(generationCount.count, 0);

    const verifiedAdmission = finalizeInput(bootstrap);
    const admitted = repo.finalizeBootstrapAdmission(verifiedAdmission);
    assert.equal(admitted.disposition, "admitted");
    assert.equal(admitted.generation.workerGeneration, 1);
    assert.equal(admitted.credential.credentialGeneration, 1);
    assert.equal(admitted.credential.purpose, "worker_runtime");
    assert.equal(admitted.generation.publicKeySpkiSha256, verifiedAdmission.verifiedPublicKeySpkiSha256);
    assert.equal(admitted.generation.clientCertificateSha256, verifiedAdmission.verifiedClientCertificateSha256);
    assert.equal(
      admitted.generation.installedTreeAttestationSha256,
      verifiedAdmission.verifiedInstalledTreeAttestationSha256,
    );
    assert.equal(repo.getBootstrap("default", bootstrap.bootstrapId).state, "consumed");
    assert.doesNotMatch(JSON.stringify(admitted), /credentialToken|tokenSha256|bootstrapSecret/u);

    const resolved = repo.resolveRuntimeCredentialByHash(D("a:credential-token-1"));
    assert.equal(resolved?.generation.workerId, bootstrap.workerId);
    assert.deepEqual(resolved?.allowedWorkspaceIds, ["default"]);
    assert.deepEqual(resolved?.capabilityClasses, ["durable_compute", "gateway_inference"]);
    assert.equal(repo.resolveRuntimeCredentialByHash(D("unknown-token")), undefined);

    const stored = db
      .prepare("SELECT claims_json, claims_sha256 FROM remote_worker_runtime_credentials WHERE credential_id = ?")
      .get(admitted.credential.credentialId) as { claims_json: string; claims_sha256: string };
    assert.equal(stored.claims_json, canonicalJsonString(admitted.credential.claims));
    assert.equal(stored.claims_sha256, D(stored.claims_json));
    assert.equal(admitted.credential.claims.workspaceCeilingSha256, bootstrap.workspaceCeilingSha256);
    assert.equal(admitted.credential.claims.capabilityCeilingSha256, bootstrap.capabilityCeilingSha256);
  });

  it("atomically consumes proof nonce with admission and resolves replay before consuming another nonce", () => {
    const { db, repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput("atomic-replay")).record;
    const command = finalizeInput(bootstrap, "atomic-replay");
    const admitted = repo.finalizeBootstrapAdmissionWithNonce({
      nonce: bootstrapNonceInput(db, bootstrap, "atomic-replay"),
      command,
    });
    assert.equal(admitted.disposition, "admitted");
    assert.equal(repo.findBootstrapBySecretSha256(command.bootstrapSecretSha256)?.bootstrapId, bootstrap.bootstrapId);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM remote_worker_bootstrap_request_nonces WHERE bootstrap_id = ?")
          .get(bootstrap.bootstrapId) as { count: number }
      ).count,
      1,
    );

    const replay = repo.finalizeBootstrapAdmissionWithNonce({
      nonce: bootstrapNonceInput(db, bootstrap, "atomic-replay-second"),
      command: { ...command, credentialTokenSha256: D("atomic-replay:replacement-token") },
    });
    assert.equal(replay.disposition, "replayed_without_credential_secret");
    assert.deepEqual(replay.generation, admitted.generation);
    assert.deepEqual(replay.credential, admitted.credential);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM remote_worker_bootstrap_request_nonces WHERE bootstrap_id = ?")
          .get(bootstrap.bootstrapId) as { count: number }
      ).count,
      1,
      "exact replay must not consume its replacement nonce",
    );

    assert.throws(
      () =>
        repo.finalizeBootstrapAdmissionWithNonce({
          nonce: bootstrapNonceInput(db, bootstrap, "atomic-replay-changed"),
          command: { ...command, verifiedTransportReceiptSha256: D("atomic-replay:changed-transport") },
        }),
      ConflictError,
    );
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM remote_worker_bootstrap_request_nonces WHERE bootstrap_id = ?")
          .get(bootstrap.bootstrapId) as { count: number }
      ).count,
      1,
      "changed replay must fail before nonce insertion",
    );
  });

  it("rolls nonce, generation, and credential writes back at atomic admission failure seams", () => {
    const { db, repo } = harness();
    const assertNoAdmission = (bootstrap: ReturnType<RemoteWorkerAdmissionRepository["createBootstrap"]>["record"]) => {
      const counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM remote_worker_bootstrap_request_nonces WHERE bootstrap_id = @bootstrapId) AS nonces,
             (SELECT COUNT(*) FROM remote_worker_generations WHERE bootstrap_id = @bootstrapId) AS generations,
             (SELECT COUNT(*) FROM remote_worker_runtime_credentials WHERE worker_id = @workerId) AS credentials`,
        )
        .get({ bootstrapId: bootstrap.bootstrapId, workerId: bootstrap.workerId }) as {
        nonces: number;
        generations: number;
        credentials: number;
      };
      assert.deepEqual({ ...counts }, { nonces: 0, generations: 0, credentials: 0 });
      assert.equal(repo.getBootstrap(bootstrap.registryWorkspaceId, bootstrap.bootstrapId).state, "pending");
    };

    const foreign = repo.createBootstrap(bootstrapInput("atomic-foreign")).record;
    const foreignNonce = bootstrapNonceInput(db, foreign, "atomic-foreign");
    assert.throws(
      () =>
        repo.finalizeBootstrapAdmissionWithNonce({
          nonce: {
            ...foreignNonce,
            authority: {
              kind: "bootstrap",
              registryWorkspaceId: foreign.registryWorkspaceId,
              bootstrapId: foreign.bootstrapId,
              workerId: "foreign-worker",
              targetWorkerGeneration: foreign.targetWorkerGeneration,
            },
          },
          command: finalizeInput(foreign, "atomic-foreign"),
        }),
      ConflictError,
    );
    assertNoAdmission(foreign);

    for (const [seed, prefix] of [
      ["atomic-after-nonce", "INSERT INTO remote_worker_generations"],
      ["atomic-after-generation", "INSERT INTO remote_worker_runtime_credentials"],
    ] as const) {
      const bootstrap = repo.createBootstrap(bootstrapInput(seed)).record;
      const failingRepo = new RemoteWorkerAdmissionRepository(
        prepareFacade(db, (statement) =>
          statement.startsWith(prefix) ? throwingStatement(`injected ${seed} failure`) : undefined,
        ),
      );
      assert.throws(
        () =>
          failingRepo.finalizeBootstrapAdmissionWithNonce({
            nonce: bootstrapNonceInput(db, bootstrap, seed),
            command: finalizeInput(bootstrap, seed),
          }),
        ConflictError,
      );
      assertNoAdmission(bootstrap);
    }

    const duplicate = repo.createBootstrap(bootstrapInput("atomic-duplicate")).record;
    const duplicateNonce = bootstrapNonceInput(db, duplicate, "atomic-duplicate");
    assert.equal(new RemoteWorkerNonceRepository(db).consume(duplicateNonce), true);
    assert.throws(
      () =>
        repo.finalizeBootstrapAdmissionWithNonce({
          nonce: duplicateNonce,
          command: finalizeInput(duplicate, "atomic-duplicate"),
        }),
      ConflictError,
    );
    const duplicateCounts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM remote_worker_bootstrap_request_nonces WHERE bootstrap_id = @bootstrapId) AS nonces,
           (SELECT COUNT(*) FROM remote_worker_generations WHERE bootstrap_id = @bootstrapId) AS generations`,
      )
      .get({ bootstrapId: duplicate.bootstrapId }) as { nonces: number; generations: number };
    assert.deepEqual({ ...duplicateCounts }, { nonces: 1, generations: 0 });
  });

  it("binds generation-1 credential evidence to its generation in direct SQLite writes", () => {
    const { db, repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput("direct-initial-credential")).record;
    const generationSeed = "direct-initial-credential";
    insertDirectGeneration(db, bootstrap, generationSeed, readSqliteClock(db).now);
    const generation = db
      .prepare("SELECT * FROM remote_worker_generations WHERE worker_id = ?")
      .get(bootstrap.workerId) as Record<string, unknown>;
    const claims = buildRemoteWorkerRuntimeCredentialClaims({
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      workerId: bootstrap.workerId,
      workerGeneration: 1,
      allowedWorkspaceIds: bootstrap.allowedWorkspaceIds,
      capabilityClasses: bootstrap.capabilityClasses,
    });

    for (const [index, mismatch] of [
      { idempotencyKey: "changed-initial-idempotency" },
      { requestSha256: D("changed-initial-request") },
      { transportReceiptSha256: D("changed-initial-transport") },
      { proofOfPossessionReceiptSha256: D("changed-initial-pop") },
    ].entries()) {
      assert.throws(() => insertInitialDirectCredential(db, generation, claims, `mismatch-${index}`, mismatch));
    }
    assert.equal(insertInitialDirectCredential(db, generation, claims, "valid").changes, 1);
  });

  it("rejects every mismatched verified bootstrap binding before consuming the bootstrap", () => {
    const { db, repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput()).record;
    const mismatches: Array<Partial<FinalizeRemoteWorkerBootstrapAdmissionCommand>> = [
      { expectedRegistryWorkspaceId: "other" },
      { expectedBootstrapId: "other-bootstrap" },
      { expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration + 1 },
      { verifiedRuntimeManifestSha256: D("wrong-manifest") },
      { verifiedWorkspaceCeilingSha256: D("wrong-workspace-ceiling") },
      { verifiedCapabilityCeilingSha256: D("wrong-capability-ceiling") },
    ];

    for (const mismatch of mismatches) {
      assert.throws(() => repo.finalizeBootstrapAdmission(finalizeInput(bootstrap, "a", mismatch)), ConflictError);
    }

    const generationCount = db.prepare("SELECT COUNT(*) AS count FROM remote_worker_generations").get() as {
      count: number;
    };
    assert.equal(generationCount.count, 0);
    assert.equal(repo.finalizeBootstrapAdmission(finalizeInput(bootstrap)).disposition, "admitted");
  });

  it("rejects an expired bootstrap but keeps an already committed exact exchange replay durable", () => {
    const { db, repo } = harness();
    const expiredBootstrap = repo.createBootstrap(bootstrapInput("expired")).record;
    const staleRepo = new RemoteWorkerAdmissionRepository(freshnessFacade(db, false));
    assert.throws(
      () => staleRepo.finalizeBootstrapAdmission(finalizeInput(expiredBootstrap, "expired")),
      ConflictError,
    );

    const liveBootstrap = repo.createBootstrap(bootstrapInput("live")).record;
    const input = finalizeInput(liveBootstrap, "live");
    const admitted = repo.finalizeBootstrapAdmission(input);
    const replay = staleRepo.finalizeBootstrapAdmission({
      ...input,
      credentialTokenSha256: D("live:replacement-generated-token"),
    });
    assert.equal(replay.disposition, "replayed_without_credential_secret");
    assert.deepEqual(replay.generation, admitted.generation);
    assert.deepEqual(replay.credential, admitted.credential);
  });

  it("replays an exact exchange without credential secret and rejects a changed second consumer", () => {
    const { repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput()).record;
    const input = finalizeInput(bootstrap);
    const first = repo.finalizeBootstrapAdmission(input);
    const replay = repo.finalizeBootstrapAdmission({ ...input, credentialTokenSha256: D("different-generated-token") });
    assert.equal(replay.disposition, "replayed_without_credential_secret");
    assert.deepEqual(replay.generation, first.generation);
    assert.deepEqual(replay.credential, first.credential);
    assert.equal("credentialTokenSha256" in replay, false);
    assert.equal("bootstrapSecretSha256" in replay, false);
    assert.throws(
      () =>
        repo.finalizeBootstrapAdmission({
          ...input,
          verifiedTransportReceiptSha256: D("changed-transport-receipt"),
        }),
      ConflictError,
    );
    assert.throws(
      () => repo.finalizeBootstrapAdmission({ ...input, exchangeIdempotencyKey: "exchange:second-consumer" }),
      ConflictError,
    );
    assert.throws(
      () => repo.finalizeBootstrapAdmission({ ...input, expectedBootstrapId: "other-bootstrap" }),
      ConflictError,
    );
    assert.throws(
      () =>
        repo.finalizeBootstrapAdmission({
          ...input,
          verifiedPublicKeySpkiSha256: D("changed-verified-key"),
        }),
      ConflictError,
    );
  });

  it("fails replay and resolution closed when generation-1 credential evidence drifts", () => {
    const { db, repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput("credential-evidence")).record;
    const input = finalizeInput(bootstrap, "credential-evidence");
    repo.finalizeBootstrapAdmission(input);
    const credentialRow = db
      .prepare("SELECT * FROM remote_worker_runtime_credentials WHERE token_sha256 = ?")
      .get(D("credential-evidence:credential-token-1")) as Record<string, unknown>;

    for (const [name, mutate] of [
      ["idempotency", { idempotency_key: "changed-initial-idempotency" }],
      ["request", { request_sha256: D("changed-initial-request") }],
      ["transport", { transport_verification_receipt_sha256: D("changed-initial-transport") }],
      ["proof-of-possession", { proof_of_possession_receipt_sha256: D("changed-initial-pop") }],
    ] as const) {
      const tampered = new RemoteWorkerAdmissionRepository(
        tamperedCredentialFacade(db, { ...credentialRow, ...mutate }),
      );
      assert.throws(
        () => tampered.finalizeBootstrapAdmission(input),
        /Remote worker admission state is invalid/u,
        `${name} drift must fail replay closed`,
      );
      assert.throws(
        () => tampered.resolveRuntimeCredentialByHash(D("credential-evidence:credential-token-1")),
        /Remote worker admission state is invalid/u,
        `${name} drift must fail resolution closed`,
      );
    }
  });

  it("rolls back generation creation if the initial credential cannot be committed", () => {
    const { db, repo } = harness();
    const firstBootstrap = repo.createBootstrap(bootstrapInput("a")).record;
    repo.finalizeBootstrapAdmission(finalizeInput(firstBootstrap, "a"));
    const secondBootstrap = repo.createBootstrap(bootstrapInput("b")).record;
    assert.throws(
      () =>
        repo.finalizeBootstrapAdmission(
          finalizeInput(secondBootstrap, "b", { credentialTokenSha256: D("a:credential-token-1") }),
        ),
      ConflictError,
    );
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM remote_worker_generations WHERE worker_id = ?")
      .get(secondBootstrap.workerId) as { count: number };
    assert.equal(count.count, 0);
    assert.equal(repo.getBootstrap("default", secondBootstrap.bootstrapId).state, "pending");
  });

  it("rotates only the current fresh claims ceiling and invalidates older credentials", () => {
    const { repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput()).record;
    const admitted = repo.finalizeBootstrapAdmission(finalizeInput(bootstrap));
    const rotation = {
      registryWorkspaceId: "default",
      workerId: bootstrap.workerId,
      workerGeneration: 1,
      expectedCredentialId: admitted.credential.credentialId,
      expectedCredentialGeneration: admitted.credential.credentialGeneration,
      verifiedTransportReceiptSha256: D("rotate:transport"),
      verifiedProofOfPossessionReceiptSha256: D("rotate:pop"),
      credentialIssuanceProofSha256: D("rotate:issuance"),
      expiresInSeconds: 600,
      credentialTokenSha256: D("credential-token-2"),
      idempotencyKey: "rotate:2",
    };
    assert.throws(
      () =>
        repo.rotateRuntimeCredential({
          ...rotation,
          expectedCredentialId: "wrong-credential",
          idempotencyKey: "rotate:wrong-credential",
        }),
      ConflictError,
    );
    assert.throws(
      () =>
        repo.rotateRuntimeCredential({
          ...rotation,
          expectedCredentialGeneration: admitted.credential.credentialGeneration + 1,
          idempotencyKey: "rotate:wrong-generation",
        }),
      ConflictError,
    );
    assert.throws(
      () =>
        repo.rotateRuntimeCredential({
          ...rotation,
          verifiedTransportReceiptSha256: D("a:transport-receipt"),
          idempotencyKey: "rotate:reused-transport-receipt",
        }),
      ConflictError,
    );
    assert.throws(
      () =>
        repo.rotateRuntimeCredential({
          ...rotation,
          verifiedProofOfPossessionReceiptSha256: D("a:pop-receipt"),
          idempotencyKey: "rotate:reused-pop-receipt",
        }),
      ConflictError,
    );
    const rotated = repo.rotateRuntimeCredential(rotation);
    assert.equal(rotated.disposition, "created");
    assert.equal(rotated.credential.credentialGeneration, 2);
    assert.equal(repo.resolveRuntimeCredentialByHash(D("a:credential-token-1")), undefined);
    assert.equal(repo.resolveRuntimeCredentialByHash(D("credential-token-2"))?.credential.credentialGeneration, 2);
    assert.equal(
      repo.rotateRuntimeCredential({ ...rotation, credentialTokenSha256: D("changed-generated-token") }).disposition,
      "replayed_without_credential_secret",
    );
    assert.equal(
      "credentialTokenSha256" in
        repo.rotateRuntimeCredential({ ...rotation, credentialTokenSha256: D("another-generated-token") }),
      false,
    );
    assert.throws(
      () =>
        repo.rotateRuntimeCredential({
          ...rotation,
          expectedCredentialGeneration: admitted.credential.credentialGeneration + 1,
        }),
      ConflictError,
    );
    const staleSecondRotation = {
      ...rotation,
      verifiedTransportReceiptSha256: D("rotate:stale-second-transport"),
      verifiedProofOfPossessionReceiptSha256: D("rotate:stale-second-pop"),
      credentialIssuanceProofSha256: D("rotate:stale-second-issuance"),
      credentialTokenSha256: D("rotate:stale-second-token"),
      idempotencyKey: "rotate:stale-second",
    };
    assert.throws(() => repo.rotateRuntimeCredential(staleSecondRotation), ConflictError);
    assert.equal(repo.resolveRuntimeCredentialByHash(staleSecondRotation.credentialTokenSha256), undefined);
    assert.throws(() => repo.rotateRuntimeCredential({ ...rotation, expiresInSeconds: 601 }), ConflictError);
    assert.deepEqual(rotated.credential.claims, admitted.credential.claims);
    assert.throws(
      () =>
        repo.rotateRuntimeCredential({
          ...rotation,
          credentialClaimsSha256: D("caller-widened-claims"),
        } as RotateRemoteWorkerRuntimeCredentialCommand),
      /unknown fields/u,
    );
  });

  it("rejects rotation after credential expiry, generation control, or N+1 admission", () => {
    const { db, repo } = harness();
    const firstBootstrap = repo.createBootstrap(bootstrapInput("rotate-fences")).record;
    const admitted = repo.finalizeBootstrapAdmission(finalizeInput(firstBootstrap, "rotate-fences"));
    const rotation = {
      registryWorkspaceId: "default",
      workerId: firstBootstrap.workerId,
      workerGeneration: 1,
      expectedCredentialId: admitted.credential.credentialId,
      expectedCredentialGeneration: admitted.credential.credentialGeneration,
      verifiedTransportReceiptSha256: D("rotate-fences:rotation-transport"),
      verifiedProofOfPossessionReceiptSha256: D("rotate-fences:rotation-pop"),
      credentialIssuanceProofSha256: D("rotate-fences:rotation-issuance"),
      expiresInSeconds: 600,
      credentialTokenSha256: D("rotate-fences:rotation-token"),
      idempotencyKey: "rotate-fences:expired",
    };
    assert.throws(
      () => new RemoteWorkerAdmissionRepository(freshnessFacade(db, false)).rotateRuntimeCredential(rotation),
      ConflictError,
    );

    const control = {
      registryWorkspaceId: "default",
      workerId: firstBootstrap.workerId,
      workerGeneration: 1,
      reasonCode: "operator.quarantine",
      reasonSha256: D("rotate fences quarantine"),
      actorId: "operator-a",
      idempotencyKey: "rotate-fences:quarantine",
    };
    repo.quarantineGeneration(control);
    assert.throws(
      () => repo.rotateRuntimeCredential({ ...rotation, idempotencyKey: "rotate-fences:quarantined" }),
      ConflictError,
    );
    repo.revokeGeneration({
      ...control,
      reasonCode: "operator.revoke",
      reasonSha256: D("rotate fences revoke"),
      idempotencyKey: "rotate-fences:revoke",
    });
    assert.throws(
      () => repo.rotateRuntimeCredential({ ...rotation, idempotencyKey: "rotate-fences:revoked" }),
      ConflictError,
    );

    const secondBootstrap = repo.createBootstrap(
      bootstrapInput("rotate-fences-next", {
        existingWorkerId: firstBootstrap.workerId,
        idempotencyKey: "rotate-fences:n-plus-one",
      }),
    ).record;
    repo.finalizeBootstrapAdmission(finalizeInput(secondBootstrap, "rotate-fences-next"));
    assert.throws(
      () => repo.rotateRuntimeCredential({ ...rotation, idempotencyKey: "rotate-fences:stale-generation" }),
      ConflictError,
    );
  });

  it("quarantines and revokes immediately, with revoke as the only terminal transition", () => {
    const { db, repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput()).record;
    repo.finalizeBootstrapAdmission(finalizeInput(bootstrap));
    const control = {
      registryWorkspaceId: "default",
      workerId: bootstrap.workerId,
      workerGeneration: 1,
      reasonCode: "operator.quarantine",
      reasonSha256: D("private quarantine reason"),
      actorId: "operator-a",
      idempotencyKey: "control:quarantine",
    };
    assert.throws(() =>
      db
        .prepare(
          `INSERT INTO remote_worker_generation_controls (
             registry_workspace_id, worker_id, worker_generation, control_revision, action,
             reason_code, reason_sha256, actor_id, idempotency_key, request_sha256, created_at
           ) VALUES (
             'default', @workerId, 1, 1, 'quarantine', 'not canonical!', @reasonSha256,
             'operator-a', 'direct-invalid-reason', @requestSha256,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           )`,
        )
        .run({
          workerId: bootstrap.workerId,
          reasonSha256: D("direct invalid reason"),
          requestSha256: D("direct invalid reason request"),
        }),
    );
    const quarantined = repo.quarantineGeneration(control);
    assert.equal(quarantined.controlRevision, 1);
    assert.equal(repo.resolveRuntimeCredentialByHash(D("a:credential-token-1")), undefined);
    assert.throws(
      () => repo.quarantineGeneration({ ...control, idempotencyKey: "control:quarantine-again" }),
      ConflictError,
    );

    const revoked = repo.revokeGeneration({
      ...control,
      reasonCode: "operator.revoke",
      reasonSha256: D("private revoke reason"),
      idempotencyKey: "control:revoke",
    });
    assert.equal(revoked.controlRevision, 2);
    assert.equal(revoked.action, "revoke");
    assert.throws(
      () =>
        repo.revokeGeneration({
          ...control,
          reasonCode: "operator.revoke",
          reasonSha256: D("another reason"),
          idempotencyKey: "control:revoke-again",
        }),
      ConflictError,
    );

    const directBootstrap = repo.createBootstrap(bootstrapInput("direct-revoke")).record;
    repo.finalizeBootstrapAdmission(finalizeInput(directBootstrap, "direct-revoke"));
    const directRevoke = {
      registryWorkspaceId: "default",
      workerId: directBootstrap.workerId,
      workerGeneration: 1,
      reasonCode: "operator.revoke",
      reasonSha256: D("direct revoke reason"),
      actorId: "operator-a",
      idempotencyKey: "control:direct-revoke",
    };
    assert.equal(repo.revokeGeneration(directRevoke).controlRevision, 1);
    assert.throws(
      () => repo.quarantineGeneration({ ...directRevoke, idempotencyKey: "control:quarantine-after-revoke" }),
      ConflictError,
    );
    assert.throws(
      () => repo.revokeGeneration({ ...directRevoke, idempotencyKey: "control:duplicate-direct-revoke" }),
      ConflictError,
    );
  });

  it("permits N+1 re-admission only after revoke and with new key, certificate, and attestation", () => {
    const { repo } = harness();
    const firstBootstrap = repo.createBootstrap(bootstrapInput("a")).record;
    const firstAdmission = repo.finalizeBootstrapAdmission(finalizeInput(firstBootstrap, "a"));
    assert.throws(
      () =>
        repo.createBootstrap(
          bootstrapInput("b", {
            existingWorkerId: firstBootstrap.workerId,
            idempotencyKey: "bootstrap:n-plus-one-before-revoke",
          }),
        ),
      ConflictError,
    );
    repo.revokeGeneration({
      registryWorkspaceId: "default",
      workerId: firstBootstrap.workerId,
      workerGeneration: 1,
      reasonCode: "operator.revoke",
      reasonSha256: D("revoke for readmission"),
      actorId: "operator-a",
      idempotencyKey: "control:revoke-for-readmission",
    });
    const secondBootstrap = repo.createBootstrap(
      bootstrapInput("b", {
        existingWorkerId: firstBootstrap.workerId,
        idempotencyKey: "bootstrap:n-plus-one",
      }),
    ).record;
    assert.equal(secondBootstrap.targetWorkerGeneration, 2);
    assert.equal(secondBootstrap.nodeId, firstBootstrap.nodeId);
    for (const reusedEvidence of [
      { verifiedPublicKeySpkiSha256: firstAdmission.generation.publicKeySpkiSha256 },
      { verifiedClientCertificateSha256: firstAdmission.generation.clientCertificateSha256 },
      { verifiedInstalledTreeAttestationSha256: firstAdmission.generation.installedTreeAttestationSha256 },
    ]) {
      assert.throws(
        () => repo.finalizeBootstrapAdmission(finalizeInput(secondBootstrap, "b", reusedEvidence)),
        ConflictError,
      );
    }
    const admitted = repo.finalizeBootstrapAdmission(finalizeInput(secondBootstrap, "b"));
    assert.equal(admitted.generation.workerGeneration, 2);
    assert.equal(repo.findCurrentGeneration("default", firstBootstrap.workerId)?.workerGeneration, 2);
  });

  it("keeps workspace identity in every read and bounds stable worker pagination", () => {
    const { db, repo } = harness();
    db.prepare(
      `INSERT INTO workspaces (
         workspace_id, name, description, slug, lifecycle_status, archived_at,
         workspace_prefs_json, created_at, updated_at, citadel_id
       ) VALUES ('registry-b', 'Registry B', NULL, 'registry-b', 'active', NULL, '{}',
         '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:00.000Z', 'personal')`,
    ).run();
    const first = repo.createBootstrap(bootstrapInput("a")).record;
    repo.finalizeBootstrapAdmission(finalizeInput(first, "a"));
    const secondInput = bootstrapInput("b", {
      registryWorkspaceId: "registry-b",
      allowedWorkspaceIds: ["default", "registry-b"],
    });
    const second = repo.createBootstrap(secondInput).record;
    repo.finalizeBootstrapAdmission(finalizeInput(second, "b"));

    assert.equal(repo.listWorkers("default", { limit: 1 }).items.length, 1);
    assert.equal(repo.listWorkers("registry-b").items[0]?.workerId, second.workerId);
    assert.deepEqual(repo.getBootstrap("registry-b", second.bootstrapId).allowedWorkspaceIds, [
      "default",
      "registry-b",
    ]);
    assert.throws(() => repo.getBootstrap("registry-b", first.bootstrapId), /unavailable/u);
    assert.throws(() => repo.listWorkers("default", { limit: 201 }), /between 1 and 200/u);
  });

  it("projects the coherent latest registry generation and control with stable secret-free paging", () => {
    const { db, repo } = harness();
    const firstBootstrap = repo.createBootstrap(bootstrapInput("registry-a")).record;
    repo.finalizeBootstrapAdmission(finalizeInput(firstBootstrap, "registry-a"));
    repo.quarantineGeneration({
      registryWorkspaceId: "default",
      workerId: firstBootstrap.workerId,
      workerGeneration: 1,
      reasonCode: "operator.quarantine",
      reasonSha256: D("registry-a:private-quarantine-reason"),
      actorId: "operator-private",
      idempotencyKey: "registry-a:quarantine",
    });
    repo.revokeGeneration({
      registryWorkspaceId: "default",
      workerId: firstBootstrap.workerId,
      workerGeneration: 1,
      reasonCode: "operator.revoke",
      reasonSha256: D("registry-a:private-revoke-reason"),
      actorId: "operator-private",
      idempotencyKey: "registry-a:revoke",
    });
    const readmission = repo.createBootstrap(
      bootstrapInput("registry-a-2", {
        existingWorkerId: firstBootstrap.workerId,
        idempotencyKey: "registry-a:readmission",
      }),
    ).record;
    repo.finalizeBootstrapAdmission(finalizeInput(readmission, "registry-a-2"));

    const secondBootstrap = repo.createBootstrap(bootstrapInput("registry-b")).record;
    repo.finalizeBootstrapAdmission(finalizeInput(secondBootstrap, "registry-b"));
    repo.quarantineGeneration({
      registryWorkspaceId: "default",
      workerId: secondBootstrap.workerId,
      workerGeneration: 1,
      reasonCode: "operator.quarantine",
      reasonSha256: D("registry-b:private-reason"),
      actorId: "operator-private",
      idempotencyKey: "registry-b:quarantine",
    });

    const statements: string[] = [];
    const registryRepo = new RemoteWorkerAdmissionRepository(
      prepareFacade(db, (statement) => {
        if (statement.includes("AS bootstrap_worker_label")) statements.push(statement);
        return undefined;
      }),
    );
    const all = registryRepo.listWorkerRegistry("default", { limit: 2 });
    const firstPage = registryRepo.listWorkerRegistry("default", { limit: 1 });
    assert.ok(firstPage.nextCursor);
    const secondPage = registryRepo.listWorkerRegistry("default", { limit: 1, cursor: firstPage.nextCursor });
    assert.deepEqual(
      [...firstPage.items, ...secondPage.items].map((entry) => entry.admission.workerId),
      all.items.map((entry) => entry.admission.workerId),
    );

    const readmitted = registryRepo.findWorkerRegistryEntry("default", firstBootstrap.workerId);
    assert.equal(readmitted?.admission.workerGeneration, 2);
    assert.equal(readmitted?.control, undefined);
    const quarantined = registryRepo.findWorkerRegistryEntry("default", secondBootstrap.workerId);
    assert.equal(quarantined?.control?.action, "quarantine");
    assert.equal(registryRepo.findWorkerRegistryEntry("foreign-workspace", secondBootstrap.workerId), undefined);
    assert.equal(Object.isFrozen(all), true);
    assert.equal(Object.isFrozen(all.items), true);
    assert.doesNotMatch(
      JSON.stringify({ all, readmitted, quarantined }),
      /bootstrapSecret|credentialToken|reasonCode|reasonSha256|actorId|idempotency|requestSha256|runtimeManifestJson/u,
    );
    assert.ok(
      statements.every(
        (statement) => !/bootstrap_secret|token_sha256|reason_code|actor_id|request_sha256/u.test(statement),
      ),
    );
    assert.throws(() => registryRepo.listWorkerRegistry("default", { limit: 101 }), /between 1 and 100/u);
  });

  it("fails registry reads closed when joined bootstrap authority diverges", () => {
    const { db, repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput("registry-corrupt")).record;
    repo.finalizeBootstrapAdmission(finalizeInput(bootstrap, "registry-corrupt"));
    db.exec("DROP TRIGGER trg_remote_worker_bootstraps_no_update");
    db.prepare("UPDATE remote_worker_bootstrap_requests SET runtime_manifest_sha256 = ? WHERE bootstrap_id = ?").run(
      D("registry-corrupt:mismatched-runtime"),
      bootstrap.bootstrapId,
    );
    assert.throws(
      () => repo.findWorkerRegistryEntry("default", bootstrap.workerId),
      /Remote worker admission state is invalid/u,
    );
    assert.throws(() => repo.listWorkerRegistry("default"), /Remote worker admission state is invalid/u);
  });

  it("hashes and projects Unicode workspace ceilings with the contract's JS canonical comparator", () => {
    const { db, repo } = harness();
    const supplementaryWorkspaceId = "😀";
    const bmpWorkspaceId = "\uE000";
    const insertWorkspace = db.prepare(
      `INSERT INTO workspaces (
         workspace_id, name, description, slug, lifecycle_status, archived_at,
         workspace_prefs_json, created_at, updated_at, citadel_id
       ) VALUES (@workspaceId, @name, NULL, @slug, 'active', NULL, '{}',
         '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:00.000Z', 'personal')`,
    );
    insertWorkspace.run({ workspaceId: supplementaryWorkspaceId, name: "Supplementary", slug: "supplementary" });
    insertWorkspace.run({ workspaceId: bmpWorkspaceId, name: "BMP", slug: "bmp-private" });

    const canonicalWorkspaceIds = ["default", supplementaryWorkspaceId, bmpWorkspaceId];
    const bootstrap = repo.createBootstrap(
      bootstrapInput("unicode-order", { allowedWorkspaceIds: canonicalWorkspaceIds }),
    ).record;
    assert.deepEqual(bootstrap.allowedWorkspaceIds, canonicalWorkspaceIds);
    assert.deepEqual(repo.getBootstrap("default", bootstrap.bootstrapId).allowedWorkspaceIds, canonicalWorkspaceIds);
  });

  it("acquires PostgreSQL workspace and worker locks before idempotency replay reads", () => {
    const { db } = harness();
    const sql: string[] = [];
    const facade: DatabaseClient = {
      dialect: "postgres",
      prepare(statement: string): DbStatement {
        const normalized = statement.replace(/\s+/gu, " ").trim();
        sql.push(normalized);
        if (normalized.includes("pg_advisory_xact_lock")) {
          return staticStatement({ locked: null });
        }
        if (normalized.includes("clock_timestamp()")) {
          const now = new Date();
          return staticStatement({
            now: now.toISOString(),
            expires_at: new Date(now.getTime() + 300_000).toISOString(),
          });
        }
        return db.prepare(statement);
      },
      exec: (statement) => db.exec(statement),
      close: () => undefined,
      transaction: (mode, callback) => db.transaction(mode, callback),
    };
    new RemoteWorkerAdmissionRepository(facade).createBootstrap(bootstrapInput("locks"));
    const workspaceLock = sql.findIndex((statement) =>
      statement.includes("hashtextextended(@registryWorkspaceId, 501)"),
    );
    const workerLock = sql.findIndex((statement) =>
      statement.includes("@registryWorkspaceId || ':' || @workerId, 502"),
    );
    const replayRead = sql.findIndex(
      (statement) =>
        statement.includes("FROM remote_worker_bootstrap_requests") && statement.includes("idempotency_key"),
    );
    assert.ok(workspaceLock >= 0 && workspaceLock < workerLock && workerLock < replayRead);
  });

  it("fails closed on malformed private hash state", () => {
    const { db, repo } = harness();
    const bootstrap = repo.createBootstrap(bootstrapInput("malformed")).record;
    const bootstrapRow = db
      .prepare("SELECT * FROM remote_worker_bootstrap_requests WHERE bootstrap_id = ?")
      .get(bootstrap.bootstrapId) as Record<string, unknown>;
    const malformedBootstrapRepo = new RemoteWorkerAdmissionRepository(
      prepareFacade(db, (statement) => {
        if (
          statement.includes("SELECT * FROM remote_worker_bootstrap_requests") &&
          statement.includes("bootstrap_id = @bootstrapId")
        ) {
          return staticStatement({ ...bootstrapRow, bootstrap_secret_sha256: "not-a-digest" });
        }
        return undefined;
      }),
    );
    assert.throws(
      () => malformedBootstrapRepo.getBootstrap("default", bootstrap.bootstrapId),
      /Remote worker admission state is invalid/u,
    );

    repo.finalizeBootstrapAdmission(finalizeInput(bootstrap, "malformed"));
    const credentialRow = db
      .prepare("SELECT * FROM remote_worker_runtime_credentials WHERE token_sha256 = ?")
      .get(D("malformed:credential-token-1")) as Record<string, unknown>;
    const malformedCredentialRepo = new RemoteWorkerAdmissionRepository(
      prepareFacade(db, (statement) =>
        statement.includes("SELECT credential.* FROM remote_worker_runtime_credentials credential")
          ? staticStatement({ ...credentialRow, proof_of_possession_receipt_sha256: "not-a-digest" })
          : undefined,
      ),
    );
    assert.throws(
      () => malformedCredentialRepo.resolveRuntimeCredentialByHash(D("malformed:credential-token-1")),
      /Remote worker admission state is invalid/u,
    );
  });

  it("fails finalization and credential resolution closed on malformed durable admission authority", () => {
    const { db, repo } = harness();
    const pending = repo.createBootstrap(bootstrapInput("tamper-pending")).record;
    const admittedBootstrap = repo.createBootstrap(bootstrapInput("tamper-admitted")).record;
    repo.finalizeBootstrapAdmission(finalizeInput(admittedBootstrap, "tamper-admitted"));
    const pendingRow = readBootstrapRow(db, pending.bootstrapId);
    const admittedRow = readBootstrapRow(db, admittedBootstrap.bootstrapId);

    const cases: BootstrapTamperCase[] = [
      { name: "header", mutateRow: (row) => ({ ...row, platform: "solaris" }) },
      { name: "malformed manifest", mutateRow: (row) => ({ ...row, runtime_manifest_json: "{" }) },
      {
        name: "payload type",
        mutateRow: (row) => withRuntimeManifest(row, { ...(manifest("tamper") as object), payload: [] }),
      },
      {
        name: "payload digest",
        mutateRow: (row) => {
          const parsed = JSON.parse(String(row.runtime_manifest_json)) as RemoteWorkerRuntimeManifest;
          return withRuntimeManifest(row, { ...parsed, payloadSha256: D("incorrect-payload-digest") });
        },
      },
      { name: "full manifest digest", mutateRow: (row) => ({ ...row, runtime_manifest_sha256: D("wrong-full") }) },
      { name: "expiry timestamp", mutateRow: (row) => ({ ...row, expires_at: "zzzz" }) },
      { name: "created timestamp", mutateRow: (row) => ({ ...row, created_at: "2999-01-01T00:00:00Z" }) },
      { name: "workspace count", mutateRow: (row) => ({ ...row, allowed_workspace_count: 2 }) },
      { name: "capability count", mutateRow: (row) => ({ ...row, capability_class_count: 3 }) },
      { name: "workspace digest", mutateRow: (row) => ({ ...row, workspace_ceiling_sha256: D("wrong-workspaces") }) },
      {
        name: "capability digest",
        mutateRow: (row) => ({ ...row, capability_ceiling_sha256: D("wrong-capabilities") }),
      },
      { name: "request digest", mutateRow: (row) => ({ ...row, request_sha256: "not-a-digest" }) },
      {
        name: "registry membership",
        mutateRow: (row) => ({ ...row, workspace_ceiling_sha256: D(canonicalJsonString(["other"])) }),
        allowedWorkspaceRows: [{ allowed_workspace_id: "other" }],
      },
      {
        name: "unsupported capability",
        mutateRow: (row) => ({
          ...row,
          capability_class_count: 2,
          capability_ceiling_sha256: D(canonicalJsonString(["durable_compute", "root_shell"])),
        }),
        capabilityRows: [{ capability_class: "durable_compute" }, { capability_class: "root_shell" }],
      },
    ];

    for (const tamper of cases) {
      const finalizer = new RemoteWorkerAdmissionRepository(tamperedBootstrapFacade(db, pendingRow, tamper));
      assert.throws(
        () => finalizer.finalizeBootstrapAdmission(finalizeInput(pending, "tamper-pending")),
        /Remote worker admission state is invalid/u,
        `${tamper.name} must fail finalization closed`,
      );
      const resolver = new RemoteWorkerAdmissionRepository(tamperedBootstrapFacade(db, admittedRow, tamper));
      assert.throws(
        () => resolver.resolveRuntimeCredentialByHash(D("tamper-admitted:credential-token-1")),
        /Remote worker admission state is invalid/u,
        `${tamper.name} must fail credential resolution closed`,
      );
    }
  });

  it("fails current-generation and worker-list reads closed on malformed associated bootstrap authority", () => {
    for (const [index, corruption] of ["manifest", "full-hash"].entries()) {
      const { db, repo } = harness();
      const seed = `worker-read-${index}`;
      const bootstrap = repo.createBootstrap(bootstrapInput(seed)).record;
      repo.finalizeBootstrapAdmission(finalizeInput(bootstrap, seed));
      db.exec("DROP TRIGGER trg_remote_worker_bootstraps_no_update");
      if (corruption === "manifest") {
        const stored = readBootstrapRow(db, bootstrap.bootstrapId);
        const runtimeManifest = JSON.parse(String(stored.runtime_manifest_json)) as RemoteWorkerRuntimeManifest;
        const malformedManifestJson = canonicalJsonString({
          ...runtimeManifest,
          payloadSha256: D("worker-read-wrong-payload"),
        });
        db.prepare(
          `UPDATE remote_worker_bootstrap_requests
           SET runtime_manifest_json = ?, runtime_manifest_sha256 = ?
           WHERE bootstrap_id = ?`,
        ).run(malformedManifestJson, D(malformedManifestJson), bootstrap.bootstrapId);
      } else {
        db.prepare(
          "UPDATE remote_worker_bootstrap_requests SET runtime_manifest_sha256 = ? WHERE bootstrap_id = ?",
        ).run(D("worker-read-wrong-full-hash"), bootstrap.bootstrapId);
      }

      assert.throws(
        () => repo.findCurrentGeneration("default", bootstrap.workerId),
        /Remote worker admission state is invalid/u,
      );
      assert.throws(() => repo.listWorkers("default"), /Remote worker admission state is invalid/u);
    }
  });

  it("normalizes database write diagnostics without echoing secret hashes", () => {
    const { db } = harness();
    const secret = D("diagnostic-secret");
    const repo = new RemoteWorkerAdmissionRepository(
      prepareFacade(db, (statement) => {
        if (statement.startsWith("INSERT INTO remote_worker_bootstrap_requests")) {
          return throwingStatement(`SQLSTATE 23505 leaked ${secret}`);
        }
        return undefined;
      }),
    );
    assert.throws(
      () => repo.createBootstrap(bootstrapInput("diagnostic", { bootstrapSecretSha256: secret })),
      (error: unknown) => {
        assert.ok(error instanceof ConflictError);
        const output = JSON.stringify(error);
        assert.doesNotMatch(output, /23505/u);
        assert.doesNotMatch(output, new RegExp(secret, "u"));
        return true;
      },
    );
  });
});

function prepareFacade(
  db: DatabaseClient,
  intercept: (normalizedStatement: string) => DbStatement | undefined,
): DatabaseClient {
  return {
    dialect: db.dialect,
    prepare(statement: string): DbStatement {
      const normalized = statement.replace(/\s+/gu, " ").trim();
      return intercept(normalized) ?? db.prepare(statement);
    },
    exec: (statement) => db.exec(statement),
    close: () => undefined,
    transaction: (mode, callback) => db.transaction(mode, callback),
  };
}

interface BootstrapTamperCase {
  name: string;
  mutateRow: (row: Record<string, unknown>) => Record<string, unknown>;
  allowedWorkspaceRows?: Array<{ allowed_workspace_id: string }>;
  capabilityRows?: Array<{ capability_class: string }>;
}

function readBootstrapRow(db: DatabaseClient, bootstrapId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM remote_worker_bootstrap_requests WHERE bootstrap_id = ?").get(bootstrapId) as Record<
    string,
    unknown
  >;
}

function withRuntimeManifest(row: Record<string, unknown>, runtimeManifest: unknown): Record<string, unknown> {
  const runtimeManifestJson = canonicalJsonString(runtimeManifest);
  return { ...row, runtime_manifest_json: runtimeManifestJson, runtime_manifest_sha256: D(runtimeManifestJson) };
}

function tamperedBootstrapFacade(
  db: DatabaseClient,
  bootstrapRow: Record<string, unknown>,
  tamper: BootstrapTamperCase,
): DatabaseClient {
  return prepareFacade(db, (statement) => {
    if (statement.startsWith("SELECT * FROM remote_worker_bootstrap_requests")) {
      return staticStatement(tamper.mutateRow(bootstrapRow));
    }
    if (
      tamper.allowedWorkspaceRows &&
      statement.startsWith("SELECT allowed_workspace_id FROM remote_worker_bootstrap_allowed_workspaces")
    ) {
      return rowsStatement(tamper.allowedWorkspaceRows);
    }
    if (
      tamper.capabilityRows &&
      statement.startsWith("SELECT capability_class FROM remote_worker_bootstrap_capability_classes")
    ) {
      return rowsStatement(tamper.capabilityRows);
    }
    return undefined;
  });
}

function tamperedCredentialFacade(db: DatabaseClient, credentialRow: Record<string, unknown>): DatabaseClient {
  return prepareFacade(db, (statement) =>
    statement.startsWith("SELECT * FROM remote_worker_runtime_credentials") ||
    statement.startsWith("SELECT credential.* FROM remote_worker_runtime_credentials")
      ? staticStatement(credentialRow)
      : undefined,
  );
}

function insertDirectBootstrap(
  db: DatabaseClient,
  seed: string,
  runtimeManifestJson: string,
  createdAt?: string,
  expiresAt?: string,
) {
  const clock = readSqliteClock(db);
  return db
    .prepare(
      `INSERT INTO remote_worker_bootstrap_requests (
         registry_workspace_id, bootstrap_id, worker_id, node_id, target_worker_generation,
         worker_label, platform, architecture, runtime_manifest_json, runtime_manifest_sha256,
         allowed_workspace_count, workspace_ceiling_sha256, capability_class_count,
         capability_ceiling_sha256, bootstrap_secret_sha256, expires_at, created_by_actor_id,
         idempotency_key, request_sha256, created_at
       ) VALUES (
         'default', @bootstrapId, @workerId, @nodeId, 1,
         @workerLabel, 'windows', 'x64', @runtimeManifestJson, @runtimeManifestSha256,
         1, @workspaceCeilingSha256, 1,
         @capabilityCeilingSha256, @bootstrapSecretSha256, @expiresAt, 'operator-a',
         @idempotencyKey, @requestSha256, @createdAt
       )`,
    )
    .run({
      bootstrapId: `direct-${seed}`,
      workerId: `direct-worker-${seed}`,
      nodeId: `direct-node-${seed}`,
      workerLabel: `Direct worker ${seed}`,
      runtimeManifestJson,
      runtimeManifestSha256: D(runtimeManifestJson),
      workspaceCeilingSha256: D(canonicalJsonString(["default"])),
      capabilityCeilingSha256: D(canonicalJsonString(["durable_compute"])),
      bootstrapSecretSha256: D(`${seed}:direct-bootstrap-secret`),
      expiresAt: expiresAt ?? createdAt ?? clock.expires_at,
      idempotencyKey: `direct-bootstrap:${seed}`,
      requestSha256: D(`${seed}:direct-request`),
      createdAt: createdAt ?? clock.now,
    });
}

function readSqliteClock(db: DatabaseClient): { now: string; expires_at: string } {
  return db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+300 seconds') AS expires_at`,
    )
    .get() as { now: string; expires_at: string };
}

function insertDirectGeneration(
  db: DatabaseClient,
  bootstrap: ReturnType<RemoteWorkerAdmissionRepository["createBootstrap"]>["record"],
  seed: string,
  admittedAt: string,
) {
  return db
    .prepare(
      `INSERT INTO remote_worker_generations (
         registry_workspace_id, worker_id, node_id, worker_generation, bootstrap_id,
         public_key_spki_sha256, client_certificate_sha256, transport_identity_source,
         transport_trust_anchor_sha256, transport_verification_receipt_sha256,
         proof_of_possession_receipt_sha256, download_verification_receipt_sha256,
         installed_tree_attestation_sha256, installed_tree_verification_receipt_sha256,
         runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
         exchange_idempotency_key, exchange_request_sha256, admitted_at
       ) VALUES (
         @registryWorkspaceId, @workerId, @nodeId, 1, @bootstrapId,
         @publicKeySpkiSha256, @clientCertificateSha256, 'native_mtls',
         @transportTrustAnchorSha256, @transportVerificationReceiptSha256,
         @proofOfPossessionReceiptSha256, @downloadVerificationReceiptSha256,
         @installedTreeAttestationSha256, @installedTreeVerificationReceiptSha256,
         @runtimeManifestSha256, @workspaceCeilingSha256, @capabilityCeilingSha256,
         @exchangeIdempotencyKey, @exchangeRequestSha256, @admittedAt
       )`,
    )
    .run({
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      workerId: bootstrap.workerId,
      nodeId: bootstrap.nodeId,
      bootstrapId: bootstrap.bootstrapId,
      publicKeySpkiSha256: D(`${seed}:spki`),
      clientCertificateSha256: D(`${seed}:certificate`),
      transportTrustAnchorSha256: D(`${seed}:trust-anchor`),
      transportVerificationReceiptSha256: D(`${seed}:transport`),
      proofOfPossessionReceiptSha256: D(`${seed}:pop`),
      downloadVerificationReceiptSha256: D(`${seed}:download`),
      installedTreeAttestationSha256: D(`${seed}:tree-attestation`),
      installedTreeVerificationReceiptSha256: D(`${seed}:tree-receipt`),
      runtimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
      workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
      capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
      exchangeIdempotencyKey: `direct-exchange:${seed}`,
      exchangeRequestSha256: D(`${seed}:exchange-request`),
      admittedAt,
    });
}

function insertDirectCredential(
  db: DatabaseClient,
  admitted: ReturnType<RemoteWorkerAdmissionRepository["finalizeBootstrapAdmission"]>,
  seed: string,
  timestamp?: string,
  claimsJson = canonicalJsonString(admitted.credential.claims),
) {
  const clock = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+300 seconds') AS expires_at`,
    )
    .get() as { now: string; expires_at: string };
  return db
    .prepare(
      `INSERT INTO remote_worker_runtime_credentials (
         registry_workspace_id, worker_id, worker_generation, credential_generation,
         credential_id, purpose, token_sha256, transport_verification_receipt_sha256,
         proof_of_possession_receipt_sha256, claims_json, claims_sha256, issuance_proof_sha256,
         idempotency_key, request_sha256, issued_at, expires_at
       ) VALUES (
         @registryWorkspaceId, @workerId, @workerGeneration, 2,
         @credentialId, 'worker_runtime', @tokenSha256, @transportVerificationReceiptSha256,
         @proofOfPossessionReceiptSha256, @claimsJson, @claimsSha256, @issuanceProofSha256,
         @idempotencyKey, @requestSha256, @issuedAt, @expiresAt
       )`,
    )
    .run({
      registryWorkspaceId: admitted.generation.registryWorkspaceId,
      workerId: admitted.generation.workerId,
      workerGeneration: admitted.generation.workerGeneration,
      credentialId: `direct-credential-${seed}`,
      tokenSha256: D(`${seed}:credential-token`),
      transportVerificationReceiptSha256: D(`${seed}:transport`),
      proofOfPossessionReceiptSha256: D(`${seed}:pop`),
      claimsJson,
      claimsSha256: D(claimsJson),
      issuanceProofSha256: D(`${seed}:issuance`),
      idempotencyKey: `direct-credential:${seed}`,
      requestSha256: D(`${seed}:credential-request`),
      issuedAt: timestamp ?? clock.now,
      expiresAt: timestamp ?? clock.expires_at,
    });
}

interface InitialCredentialEvidenceOverrides {
  idempotencyKey?: string;
  requestSha256?: string;
  transportReceiptSha256?: string;
  proofOfPossessionReceiptSha256?: string;
}

function insertInitialDirectCredential(
  db: DatabaseClient,
  generation: Record<string, unknown>,
  claims: RemoteWorkerRuntimeCredentialClaims,
  seed: string,
  overrides: InitialCredentialEvidenceOverrides = {},
) {
  const clock = readSqliteClock(db);
  const claimsJson = canonicalJsonString(claims);
  return db
    .prepare(
      `INSERT INTO remote_worker_runtime_credentials (
         registry_workspace_id, worker_id, worker_generation, credential_generation,
         credential_id, purpose, token_sha256, transport_verification_receipt_sha256,
         proof_of_possession_receipt_sha256, claims_json, claims_sha256, issuance_proof_sha256,
         idempotency_key, request_sha256, issued_at, expires_at
       ) VALUES (
         @registryWorkspaceId, @workerId, 1, 1,
         @credentialId, 'worker_runtime', @tokenSha256, @transportVerificationReceiptSha256,
         @proofOfPossessionReceiptSha256, @claimsJson, @claimsSha256, @issuanceProofSha256,
         @idempotencyKey, @requestSha256, @issuedAt, @expiresAt
       )`,
    )
    .run({
      registryWorkspaceId: String(generation.registry_workspace_id),
      workerId: String(generation.worker_id),
      credentialId: `direct-initial-credential-${seed}`,
      tokenSha256: D(`${seed}:direct-initial-token`),
      transportVerificationReceiptSha256:
        overrides.transportReceiptSha256 ?? String(generation.transport_verification_receipt_sha256),
      proofOfPossessionReceiptSha256:
        overrides.proofOfPossessionReceiptSha256 ?? String(generation.proof_of_possession_receipt_sha256),
      claimsJson,
      claimsSha256: D(claimsJson),
      issuanceProofSha256: D(`${seed}:direct-initial-issuance`),
      idempotencyKey: overrides.idempotencyKey ?? String(generation.exchange_idempotency_key),
      requestSha256: overrides.requestSha256 ?? String(generation.exchange_request_sha256),
      issuedAt: clock.now,
      expiresAt: clock.expires_at,
    });
}

function insertDirectControl(
  db: DatabaseClient,
  admitted: ReturnType<RemoteWorkerAdmissionRepository["finalizeBootstrapAdmission"]>,
  seed: string,
  createdAt: string,
) {
  return db
    .prepare(
      `INSERT INTO remote_worker_generation_controls (
         registry_workspace_id, worker_id, worker_generation, control_revision, action,
         reason_code, reason_sha256, actor_id, idempotency_key, request_sha256, created_at
       ) VALUES (
         @registryWorkspaceId, @workerId, @workerGeneration, 1, 'quarantine',
         'operator.quarantine', @reasonSha256, 'operator-a', @idempotencyKey, @requestSha256, @createdAt
       )`,
    )
    .run({
      registryWorkspaceId: admitted.generation.registryWorkspaceId,
      workerId: admitted.generation.workerId,
      workerGeneration: admitted.generation.workerGeneration,
      reasonSha256: D(`${seed}:reason`),
      idempotencyKey: `direct-control:${seed}`,
      requestSha256: D(`${seed}:control-request`),
      createdAt,
    });
}

function freshnessFacade(db: DatabaseClient, fresh: boolean): DatabaseClient {
  return prepareFacade(db, (statement) =>
    statement.startsWith("SELECT CASE WHEN") && statement.endsWith("AS fresh")
      ? staticStatement({ fresh: fresh ? 1 : 0 })
      : undefined,
  );
}

function staticStatement(row: unknown): DbStatement {
  return {
    run: () => ({ changes: 0 }),
    get: () => row,
    all: () => (row === undefined ? [] : [row]),
  } as unknown as DbStatement;
}

function rowsStatement(rows: unknown[]): DbStatement {
  return {
    run: () => ({ changes: 0 }),
    get: () => rows[0],
    all: () => rows,
  } as unknown as DbStatement;
}

function throwingStatement(message: string): DbStatement {
  return {
    run: () => {
      throw new Error(message);
    },
    get: () => undefined,
    all: () => [],
  } as unknown as DbStatement;
}
