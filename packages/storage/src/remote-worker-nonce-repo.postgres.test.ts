import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
  type CreateRemoteWorkerBootstrapCommand,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerNonceAuthority,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerNonceRepository } from "./remote-worker-nonce-repo.js";

// HX-501B1 live-PostgreSQL durable-nonce proof. Follows the repo's
// `.postgres.test.ts` convention: it skips with a visible reason when
// GOATCITADEL_TEST_POSTGRES_URL is unset; the named lane provisions a hermetic
// cluster and runs it with the URL set, where an unset URL is a HOLD, not an
// accepted skip.
const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const D = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function manifest(seed: string) {
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D(`${seed}:bundle`),
    dependencyLockSha256: D(`${seed}:lock`),
    vendorTreeSha256: D(`${seed}:vendor`),
    launcherSha256: D(`${seed}:launcher`),
    installedTreeManifestSha256: D(`${seed}:tree`),
    installedTreeFileCount: 24,
    platform: "linux",
    architecture: "x64",
  } as const;
  return {
    payload,
    payloadSha256: D(canonicalJsonString(payload)),
    signatureAlgorithm: "ed25519" as const,
    signerKeyId: `key-${seed}`,
    signatureBase64Url: "A".repeat(86),
  };
}

function bootstrapInput(seed: string): CreateRemoteWorkerBootstrapCommand {
  return {
    registryWorkspaceId: "default",
    workerLabel: `Worker ${seed}`,
    platform: "linux",
    architecture: "x64",
    runtimeManifest: manifest(seed),
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${seed}`,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
  };
}

function finalizeInput(
  bootstrap: ReturnType<RemoteWorkerAdmissionRepository["createBootstrap"]>["record"],
  seed: string,
): FinalizeRemoteWorkerBootstrapAdmissionCommand {
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
    verifiedTransportTrustAnchorSha256: D(`${seed}:anchor`),
    verifiedTransportReceiptSha256: D(`${seed}:transport`),
    verifiedProofOfPossessionReceiptSha256: D(`${seed}:pop`),
    verifiedDownloadReceiptSha256: D(`${seed}:download`),
    verifiedInstalledTreeAttestationSha256: D(`${seed}:attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${seed}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${seed}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${seed}:token-1`),
    exchangeIdempotencyKey: `exchange:${seed}`,
  };
}

function freshNonce(seed: string): { nonceSha256: string; timestamp: string; expiresAt: string } {
  const timestamp = new Date().toISOString();
  return {
    nonceSha256: D(seed),
    timestamp,
    expiresAt: new Date(Date.parse(timestamp) + 60_000).toISOString(),
  };
}

describe("RemoteWorkerNonceRepository live PostgreSQL (skips without GOATCITADEL_TEST_POSTGRES_URL)", () => {
  postgresIt(
    "races two connections on one nonce, serializes revoke-vs-consume, and bounds cleanup",
    { timeout: 300_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx501b1_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const setupDb = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx501b1-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        setupDb.exec(`SET search_path TO ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        const admission = new RemoteWorkerAdmissionRepository(setupDb);
        const nonces = new RemoteWorkerNonceRepository(setupDb);

        // --- Two-connection same-nonce race -> exactly one winner ---
        const raceBootstrap = admission.createBootstrap(bootstrapInput("race")).record;
        const raceAuthority: RemoteWorkerNonceAuthority = {
          kind: "bootstrap",
          registryWorkspaceId: raceBootstrap.registryWorkspaceId,
          workerId: raceBootstrap.workerId,
          targetWorkerGeneration: raceBootstrap.targetWorkerGeneration,
          bootstrapId: raceBootstrap.bootstrapId,
        };
        const raceNonce = freshNonce("race-nonce");
        const startSignal = new SharedArrayBuffer(4);
        const workers = [0, 1].map((index) =>
          spawnConsumeWorker(
            scopedUrl.toString(),
            database,
            `hx501b1-race-${index}-${suffix}`,
            schemaName,
            {
              authority: raceAuthority,
              ...raceNonce,
            },
            startSignal,
          ),
        );
        await Promise.all(workers.map((worker) => worker.ready));
        const startState = new Int32Array(startSignal);
        Atomics.store(startState, 0, 1);
        Atomics.notify(startState, 0);
        const results = await Promise.all(workers.map((worker) => worker.result));
        console.log(`HX-501B1 PG same-nonce race observed: ${JSON.stringify(results)}`);
        const succeeded = results.filter((result): result is { ok: true; consumed: boolean } => result.ok === true);
        assert.equal(
          succeeded.length,
          2,
          `both consumers must return a boolean without error: ${JSON.stringify(results)}`,
        );
        assert.equal(
          succeeded.filter((result) => result.consumed === true).length,
          1,
          `exactly one connection may win the nonce: ${JSON.stringify(results)}`,
        );
        assert.equal(succeeded.filter((result) => result.consumed === false).length, 1);
        assert.equal(countRows(setupDb, "remote_worker_bootstrap_request_nonces"), 1);

        // --- Rotation/revoke vs consume: serial outcome, no post-revoke admission ---
        const bootstrap = admission.createBootstrap(bootstrapInput("serial")).record;
        const admitted = admission.finalizeBootstrapAdmission(finalizeInput(bootstrap, "serial"));
        const credentialAuthority: RemoteWorkerNonceAuthority = {
          kind: "credential",
          registryWorkspaceId: "default",
          workerId: bootstrap.workerId,
          workerGeneration: admitted.generation.workerGeneration,
          credentialGeneration: admitted.credential.credentialGeneration,
          credentialId: admitted.credential.credentialId,
        };
        assert.equal(nonces.consume({ authority: credentialAuthority, ...freshNonce("serial-pre") }), true);
        admission.revokeGeneration({
          registryWorkspaceId: "default",
          workerId: bootstrap.workerId,
          workerGeneration: 1,
          reasonCode: "operator.revoke",
          reasonSha256: D("serial:revoke"),
          actorId: "operator-a",
          idempotencyKey: "control:serial:revoke",
        });
        // No consume admits under the revoked authority afterwards.
        assert.throws(
          () => nonces.consume({ authority: credentialAuthority, ...freshNonce("serial-post") }),
          /revoked|stale/u,
        );

        // --- Bounded cleanup on the live cluster ---
        const pruneBootstrap = admission.createBootstrap(bootstrapInput("prune")).record;
        const pruneAuthority: RemoteWorkerNonceAuthority = {
          kind: "bootstrap",
          registryWorkspaceId: pruneBootstrap.registryWorkspaceId,
          workerId: pruneBootstrap.workerId,
          targetWorkerGeneration: pruneBootstrap.targetWorkerGeneration,
          bootstrapId: pruneBootstrap.bootstrapId,
        };
        assert.equal(nonces.consume({ authority: pruneAuthority, ...freshNonce("prune-live") }), true);
        setupDb.exec(
          "DROP TRIGGER IF EXISTS trg_remote_worker_bootstrap_request_nonces_insert_guard ON remote_worker_bootstrap_request_nonces",
        );
        const seedExpired = setupDb.prepare(
          `INSERT INTO remote_worker_bootstrap_request_nonces (
           registry_workspace_id, worker_id, target_worker_generation, bootstrap_id, nonce_sha256,
           request_timestamp, consumed_at, expires_at
         ) VALUES (@w, @wid, @gen, @bid, @nonce,
           '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-01-01T00:01:00.000Z')`,
        );
        for (let index = 0; index < 200; index += 1) {
          seedExpired.run({
            w: pruneAuthority.registryWorkspaceId,
            wid: pruneAuthority.workerId,
            gen: pruneAuthority.targetWorkerGeneration,
            bid: pruneAuthority.bootstrapId,
            nonce: D(`prune-expired-${index}`),
          });
        }
        const liveBaseline = liveBootstrapNonces(setupDb);
        assert.equal(expiredBootstrapNonces(setupDb), 200);
        const pruned = nonces.pruneExpired();
        assert.equal(pruned.bootstrap, 200, "maintenance removes all 200 expired rows (bounded at 1000)");
        assert.equal(pruned.credential, 0);
        assert.equal(expiredBootstrapNonces(setupDb), 0);
        assert.equal(liveBootstrapNonces(setupDb), liveBaseline, "live rows are preserved");

        // --- Direct malformed / immutable / early-delete guards ---
        const guardBootstrap = admission.createBootstrap(bootstrapInput("guard")).record;
        const guardNonce = freshNonce("guard-live");
        assert.equal(
          nonces.consume({
            authority: {
              kind: "bootstrap",
              registryWorkspaceId: guardBootstrap.registryWorkspaceId,
              workerId: guardBootstrap.workerId,
              targetWorkerGeneration: guardBootstrap.targetWorkerGeneration,
              bootstrapId: guardBootstrap.bootstrapId,
            },
            ...guardNonce,
          }),
          true,
        );
        assert.throws(
          () =>
            setupDb
              .prepare("UPDATE remote_worker_bootstrap_request_nonces SET nonce_sha256 = @n WHERE nonce_sha256 = @o")
              .run({ n: D("tampered"), o: guardNonce.nonceSha256 }),
          /immutable/u,
        );
        assert.throws(
          () =>
            setupDb
              .prepare("DELETE FROM remote_worker_bootstrap_request_nonces WHERE nonce_sha256 = @n")
              .run({ n: guardNonce.nonceSha256 }),
          /undeletable/u,
        );
      } finally {
        setupDb.close();
        await migrations.close().catch(() => undefined);
        await scopedPool.end().catch(() => undefined);
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
        await adminPool.end().catch(() => undefined);
      }
    },
  );
});

function countRows(db: PostgresSyncDatabaseClient, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | string }).count);
}

const PG_NOW_SQL = `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function liveBootstrapNonces(db: PostgresSyncDatabaseClient): number {
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM remote_worker_bootstrap_request_nonces WHERE expires_at > ${PG_NOW_SQL}`,
        )
        .get() as { count: number | string }
    ).count,
  );
}

function expiredBootstrapNonces(db: PostgresSyncDatabaseClient): number {
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM remote_worker_bootstrap_request_nonces WHERE expires_at <= ${PG_NOW_SQL}`,
        )
        .get() as { count: number | string }
    ).count,
  );
}

type ConsumeWorkerResult = { ok: true; consumed: boolean } | { ok: false; error: string };

function spawnConsumeWorker(
  connectionString: string,
  database: string,
  applicationName: string,
  schemaName: string,
  input: Record<string, unknown>,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<ConsumeWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(CONSUME_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: { connectionString, database, applicationName, pool: { max: 1, connectionTimeoutMs: 10_000 } },
      input,
      schemaName,
      startSignal,
      repositoryModuleUrl: new URL(`./remote-worker-nonce-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (result: ConsumeWorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<ConsumeWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: ConsumeWorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`HX-501B1 PostgreSQL consume worker exited with code ${code}.`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const CONSUME_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { RemoteWorkerNonceRepository } = await tsImport(workerData.repositoryModuleUrl, workerData.repositoryModuleUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(workerData.postgresModuleUrl, workerData.postgresModuleUrl);
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      db.exec("SET search_path TO " + workerData.schemaName);
      parentPort.postMessage({ kind: "ready" });
      const startState = new Int32Array(workerData.startSignal);
      Atomics.wait(startState, 0, 0);
      try {
        const consumed = new RemoteWorkerNonceRepository(db).consume(workerData.input);
        parentPort.postMessage({ kind: "result", result: { ok: true, consumed } });
      } catch (error) {
        parentPort.postMessage({
          kind: "result",
          result: { ok: false, error: error instanceof Error ? error.message : String(error) },
        });
      }
    } catch (error) {
      parentPort.postMessage({
        kind: "result",
        result: { ok: false, error: "worker bootstrap failed: " + (error instanceof Error ? error.message : String(error)) },
      });
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  })();
`;
