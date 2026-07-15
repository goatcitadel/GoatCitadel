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
  type RotateRemoteWorkerRuntimeCredentialCommand,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const D = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("RemoteWorkerAdmissionRepository live PostgreSQL concurrency", () => {
  postgresIt(
    "serializes exact/changed exchange replay and rotation versus controls under the 501 then 502 locks",
    { timeout: 120_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx501_${suffix}`;
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
        applicationName: `hx501-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        const setupRepo = new RemoteWorkerAdmissionRepository(setupDb);
        const bootstrapCommand = bootstrapInput("pg-a", { expiresInSeconds: 600 });
        const bootstrap = setupRepo.createBootstrap(bootstrapCommand).record;
        const bootstrapReplay = setupRepo.createBootstrap({
          ...bootstrapCommand,
          bootstrapSecretSha256: D("pg-a:replacement-generated-secret"),
        });
        assert.equal(bootstrapReplay.disposition, "replayed_without_secret");
        assert.deepEqual(bootstrapReplay.record, bootstrap);
        const exchange = finalizeInput(bootstrap, "pg-a", { credentialExpiresInSeconds: 900 });

        const [left, right] = await Promise.all([
          runRepositoryWorker(scopedUrl.toString(), database, `hx501-exchange-a-${suffix}`, {
            operation: "finalize",
            input: exchange,
          }),
          runRepositoryWorker(scopedUrl.toString(), database, `hx501-exchange-b-${suffix}`, {
            operation: "finalize",
            input: exchange,
          }),
        ]);
        assert.equal(left.ok, true, left.ok ? undefined : left.error);
        assert.equal(right.ok, true, right.ok ? undefined : right.error);
        if (!left.ok || !right.ok) assert.fail("exact exchange replay did not converge");
        assert.deepEqual(left.value.generation, right.value.generation);
        assert.deepEqual(left.value.credential, right.value.credential);
        assert.deepEqual(
          new Set([left.value.disposition, right.value.disposition]),
          new Set(["admitted", "replayed_without_credential_secret"]),
        );

        const changed = await runRepositoryWorker(scopedUrl.toString(), database, `hx501-changed-${suffix}`, {
          operation: "finalize",
          input: { ...exchange, verifiedTransportReceiptSha256: D("pg-a:changed-transport") },
        });
        assert.equal(changed.ok, false);
        if (changed.ok) assert.fail("changed exchange unexpectedly succeeded");
        assert.doesNotMatch(changed.error, /(?:23505|23514|SQLSTATE|bootstrap_secret|token_sha256)/iu);

        const wrongBinding = await runRepositoryWorker(
          scopedUrl.toString(),
          database,
          `hx501-wrong-binding-${suffix}`,
          {
            operation: "finalize",
            input: { ...exchange, expectedBootstrapId: "wrong-bootstrap" },
          },
        );
        assert.equal(wrongBinding.ok, false);
        if (wrongBinding.ok) assert.fail("wrong bootstrap binding unexpectedly succeeded");
        assert.match(wrongBinding.error, /durable admission authority/u);

        const contendedBootstrap = setupRepo.createBootstrap(
          bootstrapInput("pg-contended", { expiresInSeconds: 600 }),
        ).record;
        const contendedExchangeA = finalizeInput(contendedBootstrap, "pg-contended", {
          exchangeIdempotencyKey: "exchange:pg-contended:a",
        });
        const contendedExchangeB = finalizeInput(contendedBootstrap, "pg-contended", {
          verifiedTransportReceiptSha256: D("pg-contended:b:transport"),
          verifiedProofOfPossessionReceiptSha256: D("pg-contended:b:pop"),
          credentialIssuanceProofSha256: D("pg-contended:b:issuance"),
          credentialTokenSha256: D("pg-contended:b:token"),
          exchangeIdempotencyKey: "exchange:pg-contended:b",
        });
        const contendedResults = await Promise.all([
          runRepositoryWorker(scopedUrl.toString(), database, `hx501-contended-a-${suffix}`, {
            operation: "finalize",
            input: contendedExchangeA,
          }),
          runRepositoryWorker(scopedUrl.toString(), database, `hx501-contended-b-${suffix}`, {
            operation: "finalize",
            input: contendedExchangeB,
          }),
        ]);
        assert.equal(contendedResults.filter((result) => result.ok).length, 1);
        for (const result of contendedResults) {
          if (!result.ok) assert.match(result.error, /durable admission authority/u);
        }
        assert.equal(
          setupRepo.findCurrentGeneration("default", contendedBootstrap.workerId)?.workerGeneration,
          contendedBootstrap.targetWorkerGeneration,
        );

        const rotationBootstrap = setupRepo.createBootstrap(
          bootstrapInput("pg-rotation", { expiresInSeconds: 600 }),
        ).record;
        const rotationAdmission = setupRepo.finalizeBootstrapAdmission(finalizeInput(rotationBootstrap, "pg-rotation"));
        const rotationA = rotationInput(
          rotationBootstrap.workerId,
          "pg-rotation-a",
          rotationAdmission.credential.credentialId,
          rotationAdmission.credential.credentialGeneration,
        );
        const rotationB = rotationInput(
          rotationBootstrap.workerId,
          "pg-rotation-b",
          rotationAdmission.credential.credentialId,
          rotationAdmission.credential.credentialGeneration,
        );
        const rotationResults = await Promise.all([
          runRepositoryWorker(scopedUrl.toString(), database, `hx501-rotation-a-${suffix}`, {
            operation: "rotate",
            input: rotationA,
          }),
          runRepositoryWorker(scopedUrl.toString(), database, `hx501-rotation-b-${suffix}`, {
            operation: "rotate",
            input: rotationB,
          }),
        ]);
        assert.equal(rotationResults.filter((result) => result.ok).length, 1);
        for (const result of rotationResults) {
          if (!result.ok) assert.match(result.error, /durable admission authority/u);
        }
        const rotationWinner = rotationResults.find((result) => result.ok);
        if (!rotationWinner?.ok) assert.fail("credential N rotation race had no winner");
        assert.equal(rotationWinner.value.disposition, "created");
        assert.equal(rotationWinner.value.credential.credentialGeneration, 2);
        assert.equal("credentialTokenSha256" in rotationWinner.value, false);
        const winningRotation = rotationResults[0].ok ? rotationA : rotationB;
        const losingRotation = rotationResults[0].ok ? rotationB : rotationA;
        assert.equal(
          setupRepo.resolveRuntimeCredentialByHash(winningRotation.credentialTokenSha256)?.credential
            .credentialGeneration,
          2,
        );
        assert.equal(setupRepo.resolveRuntimeCredentialByHash(losingRotation.credentialTokenSha256), undefined);
        assert.equal(
          setupRepo.resolveRuntimeCredentialByHash(
            finalizeInput(rotationBootstrap, "pg-rotation").credentialTokenSha256,
          ),
          undefined,
        );

        const rotation = rotationInput(
          bootstrap.workerId,
          "pg-a",
          String(left.value.credential.credentialId),
          Number(left.value.credential.credentialGeneration),
        );
        const quarantine = controlInput(bootstrap.workerId, "pg-a", "quarantine");
        const [rotationRace, quarantineRace] = await Promise.all([
          runRepositoryWorker(scopedUrl.toString(), database, `hx501-rotate-${suffix}`, {
            operation: "rotate",
            input: rotation,
          }),
          runRepositoryWorker(scopedUrl.toString(), database, `hx501-quarantine-${suffix}`, {
            operation: "quarantine",
            input: quarantine,
          }),
        ]);
        assert.equal(quarantineRace.ok, true, quarantineRace.ok ? undefined : quarantineRace.error);
        assert.ok(rotationRace.ok || /durable admission authority/u.test(rotationRace.error));
        assert.equal(setupRepo.resolveRuntimeCredentialByHash(exchange.credentialTokenSha256), undefined);
        assert.equal(setupRepo.resolveRuntimeCredentialByHash(rotation.credentialTokenSha256), undefined);

        const revoke = await runRepositoryWorker(scopedUrl.toString(), database, `hx501-revoke-${suffix}`, {
          operation: "revoke",
          input: controlInput(bootstrap.workerId, "pg-a", "revoke"),
        });
        assert.equal(revoke.ok, true, revoke.ok ? undefined : revoke.error);
        const readmission = bootstrapInput("pg-b", {
          existingWorkerId: bootstrap.workerId,
          idempotencyKey: "bootstrap:pg-b:readmission",
        });
        const [readmitA, readmitB] = await Promise.all([
          runRepositoryWorker(scopedUrl.toString(), database, `hx501-readmit-a-${suffix}`, {
            operation: "create",
            input: readmission,
          }),
          runRepositoryWorker(scopedUrl.toString(), database, `hx501-readmit-b-${suffix}`, {
            operation: "create",
            input: readmission,
          }),
        ]);
        assert.equal(readmitA.ok, true, readmitA.ok ? undefined : readmitA.error);
        assert.equal(readmitB.ok, true, readmitB.ok ? undefined : readmitB.error);
        if (!readmitA.ok || !readmitB.ok) assert.fail("readmission replay did not converge");
        assert.equal(readmitA.value.record.targetWorkerGeneration, 2);
        assert.deepEqual(readmitA.value.record, readmitB.value.record);

        const coherenceBootstrap = setupRepo.createBootstrap(
          bootstrapInput("pg-registry-coherence", { expiresInSeconds: 600 }),
        ).record;
        setupRepo.finalizeBootstrapAdmission(finalizeInput(coherenceBootstrap, "pg-registry-coherence"));
        const [registrySnapshot, coherenceControl] = await Promise.all([
          runRepositoryWorker(scopedUrl.toString(), database, `hx507a-registry-read-${suffix}`, {
            operation: "registry-detail",
            input: { registryWorkspaceId: "default", workerId: coherenceBootstrap.workerId },
          }),
          runRepositoryWorker(scopedUrl.toString(), database, `hx507a-registry-control-${suffix}`, {
            operation: "quarantine",
            input: controlInput(coherenceBootstrap.workerId, "pg-registry-coherence", "quarantine"),
          }),
        ]);
        assert.equal(registrySnapshot.ok, true, registrySnapshot.ok ? undefined : registrySnapshot.error);
        assert.equal(coherenceControl.ok, true, coherenceControl.ok ? undefined : coherenceControl.error);
        if (!registrySnapshot.ok) assert.fail("coherent registry read did not return");
        assert.equal(registrySnapshot.value.admission.workerGeneration, 1);
        if (registrySnapshot.value.control !== undefined) {
          assert.equal(registrySnapshot.value.control.workerGeneration, 1);
          assert.equal(registrySnapshot.value.control.action, "quarantine");
        }
        const finalRegistry = setupRepo.findWorkerRegistryEntry("default", coherenceBootstrap.workerId);
        assert.equal(finalRegistry?.control?.action, "quarantine");
        assert.equal(
          setupRepo
            .listWorkerRegistry("default", { limit: 100 })
            .items.some((entry) => entry.admission.workerId === coherenceBootstrap.workerId),
          true,
        );
        assert.equal(setupRepo.findWorkerRegistryEntry("foreign-workspace", coherenceBootstrap.workerId), undefined);
      } finally {
        setupDb.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );
});

function runtimeManifest(seed: string) {
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

function bootstrapInput(
  seed: string,
  overrides: Partial<CreateRemoteWorkerBootstrapCommand> = {},
): CreateRemoteWorkerBootstrapCommand {
  return {
    registryWorkspaceId: "default",
    workerLabel: `Worker ${seed}`,
    platform: "linux",
    architecture: "x64",
    runtimeManifest: runtimeManifest(seed),
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${seed}`,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
    ...overrides,
  };
}

function finalizeInput(
  bootstrap: ReturnType<RemoteWorkerAdmissionRepository["createBootstrap"]>["record"],
  seed: string,
  overrides: Partial<FinalizeRemoteWorkerBootstrapAdmissionCommand> = {},
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
    ...overrides,
  };
}

function rotationInput(
  workerId: string,
  seed: string,
  expectedCredentialId: string,
  expectedCredentialGeneration: number,
): RotateRemoteWorkerRuntimeCredentialCommand {
  return {
    registryWorkspaceId: "default",
    workerId,
    workerGeneration: 1,
    expectedCredentialId,
    expectedCredentialGeneration,
    verifiedTransportReceiptSha256: D(`${seed}:rotation-transport`),
    verifiedProofOfPossessionReceiptSha256: D(`${seed}:rotation-pop`),
    credentialIssuanceProofSha256: D(`${seed}:rotation-issuance`),
    expiresInSeconds: 600,
    credentialTokenSha256: D(`${seed}:token-2`),
    idempotencyKey: `rotate:${seed}:2`,
  };
}

function controlInput(workerId: string, seed: string, action: "quarantine" | "revoke") {
  return {
    registryWorkspaceId: "default",
    workerId,
    workerGeneration: 1,
    reasonCode: `operator.${action}`,
    reasonSha256: D(`${seed}:${action}:private-reason`),
    actorId: "operator-a",
    idempotencyKey: `control:${seed}:${action}`,
  };
}

type WorkerRequest =
  | { operation: "create"; input: unknown }
  | { operation: "finalize"; input: unknown }
  | { operation: "rotate"; input: unknown }
  | { operation: "quarantine"; input: unknown }
  | { operation: "revoke"; input: unknown }
  | { operation: "registry-detail"; input: { registryWorkspaceId: string; workerId: string } };

type WorkerResult = { ok: true; value: Record<string, any> } | { ok: false; error: string };

function runRepositoryWorker(
  connectionString: string,
  database: string,
  applicationName: string,
  request: WorkerRequest,
): Promise<WorkerResult> {
  const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(REPOSITORY_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      request,
      repositoryModuleUrl: new URL(`./remote-worker-admission-repo${runtimeModuleExtension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${runtimeModuleExtension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  return new Promise((resolve, reject) => {
    let received = false;
    worker.once("message", (message: WorkerResult) => {
      received = true;
      resolve(message);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!received) reject(new Error(`HX-501 PostgreSQL worker exited before reporting (code ${code})`));
    });
  });
}

const REPOSITORY_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    let result;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { RemoteWorkerAdmissionRepository } = await tsImport(
        workerData.repositoryModuleUrl,
        workerData.repositoryModuleUrl,
      );
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      const repo = new RemoteWorkerAdmissionRepository(db);
      const { operation, input } = workerData.request;
      const value = operation === "create"
        ? repo.createBootstrap(input)
        : operation === "finalize"
          ? repo.finalizeBootstrapAdmission(input)
          : operation === "rotate"
            ? repo.rotateRuntimeCredential(input)
            : operation === "quarantine"
              ? repo.quarantineGeneration(input)
              : operation === "revoke"
                ? repo.revokeGeneration(input)
                : repo.findWorkerRegistryEntry(input.registryWorkspaceId, input.workerId);
      result = { ok: true, value };
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : "opaque remote worker failure" };
    } finally {
      if (db) db.close();
    }
    parentPort.postMessage(result);
  })();
`;
