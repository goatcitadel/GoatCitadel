import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
  type CreateRemoteWorkerBootstrapCommand,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerNonceAuthority,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerNonceRepository } from "./remote-worker-nonce-repo.js";
import { createDatabase } from "./sqlite.js";

const clients: DatabaseClient[] = [];
const createdFiles: string[] = [];
const D = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const file of createdFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(`${file}${suffix}`, { force: true });
      } catch {
        // ignore
      }
    }
  }
});

function manifest(seed: string): RemoteWorkerRuntimeManifest {
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D(`${seed}:bundle`),
    dependencyLockSha256: D(`${seed}:lock`),
    vendorTreeSha256: D(`${seed}:vendor`),
    launcherSha256: D(`${seed}:launcher`),
    installedTreeManifestSha256: D(`${seed}:tree`),
    installedTreeFileCount: 42,
    platform: "windows",
    architecture: "x64",
  };
  return {
    payload,
    payloadSha256: D(canonicalJsonString(payload)),
    signatureAlgorithm: "ed25519",
    signerKeyId: `release-key-${seed}`,
    signatureBase64Url: "A".repeat(86),
  };
}

function bootstrapInput(seed: string, overrides: Partial<CreateRemoteWorkerBootstrapCommand> = {}) {
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
  seed: string,
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

function insertWorkspace(db: DatabaseClient, workspaceId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (
       workspace_id, name, description, slug, lifecycle_status, archived_at,
       workspace_prefs_json, created_at, updated_at, citadel_id
     ) VALUES (@id, @id, NULL, @id, 'active', NULL, '{}',
       '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:00.000Z', 'personal')`,
  ).run({ id: workspaceId });
}

function seedBootstrapAuthority(
  admission: RemoteWorkerAdmissionRepository,
  seed: string,
  overrides: Partial<CreateRemoteWorkerBootstrapCommand> = {},
): Extract<RemoteWorkerNonceAuthority, { kind: "bootstrap" }> {
  const bootstrap = admission.createBootstrap(bootstrapInput(seed, overrides)).record;
  return {
    kind: "bootstrap",
    registryWorkspaceId: bootstrap.registryWorkspaceId,
    workerId: bootstrap.workerId,
    targetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapId: bootstrap.bootstrapId,
  };
}

function seedCredentialAuthority(
  admission: RemoteWorkerAdmissionRepository,
  seed: string,
): { authority: Extract<RemoteWorkerNonceAuthority, { kind: "credential" }>; workerId: string } {
  const bootstrap = admission.createBootstrap(bootstrapInput(seed)).record;
  const admitted = admission.finalizeBootstrapAdmission(finalizeInput(bootstrap, seed));
  return {
    workerId: bootstrap.workerId,
    authority: {
      kind: "credential",
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      workerId: bootstrap.workerId,
      workerGeneration: admitted.generation.workerGeneration,
      credentialGeneration: admitted.credential.credentialGeneration,
      credentialId: admitted.credential.credentialId,
    },
  };
}

function controlInput(workerId: string, seed: string) {
  return {
    registryWorkspaceId: "default",
    workerId,
    workerGeneration: 1,
    reasonCode: `operator.${seed}`,
    reasonSha256: D(`${seed}:reason`),
    actorId: "operator-a",
    idempotencyKey: `control:${seed}`,
  };
}

function freshNonce(
  seed: string,
  atMs: number = Date.now(),
): { nonceSha256: string; timestamp: string; expiresAt: string } {
  const timestamp = new Date(atMs).toISOString();
  return {
    nonceSha256: D(seed),
    timestamp,
    expiresAt: new Date(Date.parse(timestamp) + 60_000).toISOString(),
  };
}

function harness(dbPath = ":memory:") {
  const db = createDatabase({ dbPath });
  clients.push(db);
  return { db, admission: new RemoteWorkerAdmissionRepository(db), nonces: new RemoteWorkerNonceRepository(db) };
}

function liveCount(db: DatabaseClient, table: string): number {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
        .get() as { count: number | string }
    ).count,
  );
}

function expiredCount(db: DatabaseClient, table: string): number {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
        .get() as { count: number | string }
    ).count,
  );
}

describe("RemoteWorkerNonceRepository (SQLite)", () => {
  it("records a bootstrap nonce once, rejects the exact replay, and keeps distinct authorities independent", () => {
    const { admission, nonces } = harness();
    const authorityA = seedBootstrapAuthority(admission, "a");
    const authorityB = seedBootstrapAuthority(admission, "b");
    const nonce = freshNonce("shared-nonce");

    assert.equal(nonces.consume({ authority: authorityA, ...nonce }), true);
    assert.equal(
      nonces.consume({ authority: authorityA, ...nonce }),
      false,
      "exact replay under one authority is false",
    );
    assert.equal(nonces.consume({ authority: authorityA, ...freshNonce("second-nonce") }), true);
    // The same nonce digest under a distinct authority is independent.
    assert.equal(nonces.consume({ authority: authorityB, ...nonce }), true);
    assert.equal(nonces.consume({ authority: authorityB, ...nonce }), false);
  });

  it("keeps the same nonce independent across workspaces", () => {
    const { db, admission, nonces } = harness();
    insertWorkspace(db, "workspace-b");
    const defaultAuthority = seedBootstrapAuthority(admission, "cross-default");
    const otherAuthority = seedBootstrapAuthority(admission, "cross-other", {
      registryWorkspaceId: "workspace-b",
      allowedWorkspaceIds: ["workspace-b"],
    });
    assert.equal(otherAuthority.registryWorkspaceId, "workspace-b");
    const nonce = freshNonce("cross-workspace-nonce");
    assert.equal(nonces.consume({ authority: defaultAuthority, ...nonce }), true);
    assert.equal(nonces.consume({ authority: otherAuthority, ...nonce }), true);
  });

  it("rejects a request timestamp outside the database-clock window", () => {
    const { admission, nonces } = harness();
    const authority = seedBootstrapAuthority(admission, "window");
    assert.throws(
      () => nonces.consume({ authority, ...freshNonce("future", Date.now() + 5 * 60_000) }),
      /request window/u,
    );
    assert.throws(
      () => nonces.consume({ authority, ...freshNonce("stale", Date.now() - 5 * 60_000) }),
      /request window/u,
    );
  });

  it("requires expiry to be the request timestamp plus exactly 60 seconds", () => {
    const { admission, nonces } = harness();
    const authority = seedBootstrapAuthority(admission, "ttl");
    const timestamp = new Date().toISOString();
    assert.throws(
      () =>
        nonces.consume({
          authority,
          nonceSha256: D("ttl-nonce"),
          timestamp,
          expiresAt: new Date(Date.parse(timestamp) + 30_000).toISOString(),
        }),
      /plus 60 seconds/u,
    );
  });

  it("rejects consumption under an unknown or expired bootstrap authority", () => {
    const { nonces } = harness();
    const unknown: RemoteWorkerNonceAuthority = {
      kind: "bootstrap",
      registryWorkspaceId: "default",
      workerId: "ghost-worker",
      targetWorkerGeneration: 1,
      bootstrapId: "ghost-bootstrap",
    };
    assert.throws(() => nonces.consume({ authority: unknown, ...freshNonce("ghost") }), /stale, expired/u);
  });

  it("consumes a credential nonce only for the latest fresh credential and rejects its replay", () => {
    const { admission, nonces } = harness();
    const { authority } = seedCredentialAuthority(admission, "cred");
    const nonce = freshNonce("cred-nonce");
    assert.equal(nonces.consume({ authority, ...nonce }), true);
    assert.equal(nonces.consume({ authority, ...nonce }), false);
  });

  it("blocks a rotated (superseded) credential authority and admits the fresh one", () => {
    const { admission, nonces } = harness();
    const { authority, workerId } = seedCredentialAuthority(admission, "rot");
    const rotated = admission.rotateRuntimeCredential({
      registryWorkspaceId: "default",
      workerId,
      workerGeneration: authority.workerGeneration,
      expectedCredentialId: authority.credentialId,
      expectedCredentialGeneration: authority.credentialGeneration,
      verifiedTransportReceiptSha256: D("rot:transport-2"),
      verifiedProofOfPossessionReceiptSha256: D("rot:pop-2"),
      credentialIssuanceProofSha256: D("rot:issuance-2"),
      expiresInSeconds: 600,
      credentialTokenSha256: D("rot:token-2"),
      idempotencyKey: "rotate:rot:2",
    });
    // The superseded credential-generation authority is now stale.
    assert.throws(() => nonces.consume({ authority, ...freshNonce("rot-old") }), /stale, expired, revoked/u);
    const freshAuthority: RemoteWorkerNonceAuthority = {
      kind: "credential",
      registryWorkspaceId: "default",
      workerId,
      workerGeneration: authority.workerGeneration,
      credentialGeneration: rotated.credential.credentialGeneration,
      credentialId: rotated.credential.credentialId,
    };
    assert.equal(nonces.consume({ authority: freshAuthority, ...freshNonce("rot-new") }), true);
  });

  it("blocks a quarantined generation's credential authority", () => {
    const { admission, nonces } = harness();
    const { authority, workerId } = seedCredentialAuthority(admission, "quar");
    admission.quarantineGeneration(controlInput(workerId, "quar"));
    assert.throws(() => nonces.consume({ authority, ...freshNonce("quar-nonce") }), /stale, expired, revoked/u);
  });

  it("blocks a revoked generation's credential authority", () => {
    const { admission, nonces } = harness();
    const { authority, workerId } = seedCredentialAuthority(admission, "rev");
    admission.revokeGeneration(controlInput(workerId, "rev"));
    assert.throws(() => nonces.consume({ authority, ...freshNonce("rev-nonce") }), /stale, expired, revoked/u);
  });

  it("blocks stale authorities after an N+1 readmission", () => {
    const { admission, nonces } = harness();
    const bootstrap = admission.createBootstrap(bootstrapInput("nplus1")).record;
    const bootstrapAuthority: RemoteWorkerNonceAuthority = {
      kind: "bootstrap",
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      workerId: bootstrap.workerId,
      targetWorkerGeneration: bootstrap.targetWorkerGeneration,
      bootstrapId: bootstrap.bootstrapId,
    };
    const admitted = admission.finalizeBootstrapAdmission(finalizeInput(bootstrap, "nplus1"));
    // The now-consumed bootstrap authority is stale.
    assert.throws(() => nonces.consume({ authority: bootstrapAuthority, ...freshNonce("np-boot") }), /stale, expired/u);
    const gen1Credential: RemoteWorkerNonceAuthority = {
      kind: "credential",
      registryWorkspaceId: "default",
      workerId: bootstrap.workerId,
      workerGeneration: admitted.generation.workerGeneration,
      credentialGeneration: admitted.credential.credentialGeneration,
      credentialId: admitted.credential.credentialId,
    };
    // Readmit generation 2 (revoke the prior generation, then re-bootstrap N+1).
    admission.revokeGeneration(controlInput(bootstrap.workerId, "np-revoke"));
    const readmit = admission.createBootstrap(
      bootstrapInput("np-readmit", { existingWorkerId: bootstrap.workerId, idempotencyKey: "bootstrap:np-readmit" }),
    ).record;
    assert.equal(readmit.targetWorkerGeneration, 2);
    admission.finalizeBootstrapAdmission(finalizeInput(readmit, "np-readmit"));
    // The prior generation's credential authority is now stale (not latest + revoked).
    assert.throws(
      () => nonces.consume({ authority: gen1Credential, ...freshNonce("np-cred") }),
      /stale, expired, revoked/u,
    );
  });

  it("preserves replay rejection across a database restart", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-nonce-restart-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const nonce = freshNonce("restart-nonce");
    let authority: RemoteWorkerNonceAuthority;
    {
      const db = createDatabase({ dbPath });
      const admission = new RemoteWorkerAdmissionRepository(db);
      authority = seedBootstrapAuthority(admission, "restart");
      assert.equal(new RemoteWorkerNonceRepository(db).consume({ authority, ...nonce }), true);
      db.close();
    }
    const reopened = createDatabase({ dbPath });
    clients.push(reopened);
    assert.equal(new RemoteWorkerNonceRepository(reopened).consume({ authority, ...nonce }), false);
  });

  it("rejects direct malformed insert, update, and early delete", () => {
    const { db, admission, nonces } = harness();
    const authority = seedBootstrapAuthority(admission, "direct");
    const nonce = freshNonce("direct-live");
    assert.equal(nonces.consume({ authority, ...nonce }), true);

    // Direct stale-timestamp insert is rejected by the database guard.
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO remote_worker_bootstrap_request_nonces (
               registry_workspace_id, worker_id, target_worker_generation, bootstrap_id, nonce_sha256,
               request_timestamp, consumed_at, expires_at
             ) VALUES (@w, @wid, @gen, @bid, @nonce,
               '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:01:00.000Z')`,
          )
          .run({
            w: authority.registryWorkspaceId,
            wid: authority.workerId,
            gen: authority.targetWorkerGeneration,
            bid: authority.bootstrapId,
            nonce: D("direct-stale"),
          }),
      /request window/u,
    );
    // Live rows are immutable and undeletable.
    assert.throws(
      () =>
        db
          .prepare("UPDATE remote_worker_bootstrap_request_nonces SET nonce_sha256 = @n WHERE nonce_sha256 = @o")
          .run({ n: D("tampered"), o: nonce.nonceSha256 }),
      /immutable/u,
    );
    assert.throws(
      () =>
        db
          .prepare("DELETE FROM remote_worker_bootstrap_request_nonces WHERE nonce_sha256 = @n")
          .run({ n: nonce.nonceSha256 }),
      /undeletable/u,
    );
  });

  it("prunes at most 128 expired rows per consume and 1000 per maintenance while preserving live rows", () => {
    const { db, admission, nonces } = harness();
    const authority = seedBootstrapAuthority(admission, "prune");
    assert.equal(nonces.consume({ authority, ...freshNonce("prune-live-a") }), true);

    // Seed 200 already-expired rows directly (guard dropped so past timestamps
    // can be inserted; the repo prune path under test does not depend on it).
    db.exec("DROP TRIGGER IF EXISTS trg_remote_worker_bootstrap_request_nonces_insert_guard");
    const seed = db.prepare(
      `INSERT INTO remote_worker_bootstrap_request_nonces (
         registry_workspace_id, worker_id, target_worker_generation, bootstrap_id, nonce_sha256,
         request_timestamp, consumed_at, expires_at
       ) VALUES (@w, @wid, @gen, @bid, @nonce,
         '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:01:00.000Z')`,
    );
    for (let index = 0; index < 200; index += 1) {
      seed.run({
        w: authority.registryWorkspaceId,
        wid: authority.workerId,
        gen: authority.targetWorkerGeneration,
        bid: authority.bootstrapId,
        nonce: D(`prune-expired-${index}`),
      });
    }
    assert.equal(expiredCount(db, "remote_worker_bootstrap_request_nonces"), 200);
    assert.equal(liveCount(db, "remote_worker_bootstrap_request_nonces"), 1);

    // A single consume prunes at most 128 expired rows, then records the live one.
    assert.equal(nonces.consume({ authority, ...freshNonce("prune-live-b") }), true);
    assert.equal(expiredCount(db, "remote_worker_bootstrap_request_nonces"), 72);
    assert.equal(liveCount(db, "remote_worker_bootstrap_request_nonces"), 2);

    // Explicit maintenance removes the remainder (bounded at 1000) and keeps live rows.
    const pruned = nonces.pruneExpired();
    assert.equal(pruned.bootstrap, 72);
    assert.equal(pruned.credential, 0);
    assert.equal(expiredCount(db, "remote_worker_bootstrap_request_nonces"), 0);
    assert.equal(liveCount(db, "remote_worker_bootstrap_request_nonces"), 2);
  });
});
