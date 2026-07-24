import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { GOVERNANCE_JOURNEY_EVENT_VERSION, canonicalJsonString } from "@goatcitadel/contracts";
import type { GovernanceJourneyEventRecord } from "@goatcitadel/contracts";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { ExternalSourceConfigRepository } from "./external-source-config-repo.js";
import { ExternalSourceImportRepository } from "./external-source-import-repo.js";
import { ExternalSourceScanRepository } from "./external-source-scan-repo.js";
import {
  ExternalSessionAttachmentRepository,
  ExternalSourceKnowledgeLinkRepository,
  sealExternalSourceKnowledgeLink,
  type ExternalSourceKnowledgeSnapshotMaterializationInput,
} from "./external-session-attachment-repo.js";
import {
  buildExternalSourceImportFixture,
  insertSyntheticChatSession,
  seedExternalSourceCatalog,
  type ExternalSourceCatalogFixture,
} from "./external-source-test-fixtures.js";

// HX-407 C4 live-PostgreSQL closure proof (closure packet row-completion item:
// "isolated-schema live PostgreSQL replay and concurrency proof"). The suite
// follows the repo's `.postgres.test.ts` conditional convention: it skips with
// a visible reason when GOATCITADEL_TEST_POSTGRES_URL is unset, and the named
// `verify:external-sources` lane provisions a hermetic cluster and runs it
// with the URL set — the packet calls an unset URL "an explicit C4 HOLD, not
// an accepted skip", so the LANE never lets this suite skip.
const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

describe("HX-407 external-source closure live PostgreSQL authority (skips without GOATCITADEL_TEST_POSTGRES_URL)", () => {
  postgresIt(
    "replays the approved knowledge-snapshot materialization exactly and races two applies to one materialization",
    { timeout: 300_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx407_external_closure_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const db = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx407-external-closure-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        db.exec(`SET search_path TO ${schemaName}`);
        assert.equal(
          db.prepare("SELECT current_schema() AS schema_name").get<{ schema_name: string }>()!.schema_name,
          schemaName,
        );
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);

        // --- Seed the immutable C1 evidence chain through the real repos ---
        // Seeding runs the raw repositories on the raw client, so this suite
        // also proves the config/path-bridge boolean binds (0/1, valid for
        // both the fresh-database blueprint's BIGINT columns and the
        // migration-104/108 BOOLEAN columns) against a fresh blueprint-typed
        // database.
        const catalog: ExternalSourceCatalogFixture = seedExternalSourceCatalog(db);
        new ExternalSourceConfigRepository(db).create(catalog.config);
        new ExternalSourceScanRepository(db).seal(catalog.scan, catalog.items);
        const fixture = buildExternalSourceImportFixture(catalog);
        const imports = new ExternalSourceImportRepository(db);
        imports.createPlan(fixture.plan);
        imports.claimIntent(fixture.intent);
        imports.settle(fixture.settlement, fixture.importItems);
        insertSyntheticChatSession(db);
        const attachment = new ExternalSessionAttachmentRepository(db).attach(fixture.attachment);
        const importItem = fixture.importItems[0]!;

        const approvalId = `approval-knowledge-${suffix}`;
        const payload = {
          workspaceId: fixture.config.workspaceId,
          sourceId: fixture.config.sourceId,
          importId: fixture.intent.importId,
          itemId: importItem.itemId,
          normalizedArtifactSha256: importItem.normalizedArtifactSha256,
          rawSha256: importItem.rawSha256,
          sessionId: attachment.sessionId,
          sessionIncarnationId: `legacy-session-incarnation:${attachment.sessionId}`,
          attachmentId: attachment.attachmentId,
          attachmentRevision: attachment.revision,
        };
        db.prepare(
          `INSERT INTO approvals (
             approval_id, kind, risk_level, status, payload_json, preview_json, explanation_status,
             created_at, expires_at, resolved_at, resolved_by
           ) VALUES (
             @approvalId, 'external_source.knowledge_snapshot', 'danger', 'approved', @payloadJson, '{}',
             'not_requested', '2026-07-14T08:07:00.000Z', '2126-07-15T08:07:00.000Z',
             '2026-07-14T08:08:00.000Z', 'operator-1'
           )`,
        ).run({ approvalId, payloadJson: canonicalJsonString(payload) });

        const link = sealExternalSourceKnowledgeLink({
          schemaVersion: fixture.config.schemaVersion,
          linkId: `knowledge-link-${suffix}`,
          workspaceId: fixture.config.workspaceId,
          sourceId: fixture.config.sourceId,
          importId: fixture.intent.importId,
          itemId: importItem.itemId,
          normalizedArtifactSha256: importItem.normalizedArtifactSha256,
          approvalId,
          knowledgeDocumentId: `knowledge-doc-${suffix}`,
          createdAt: "2026-07-14T08:09:00.000Z",
        });
        const journeyEvent = knowledgeSnapshotJourneyEvent(link, 2);
        const serializableInput = {
          link,
          documentTitle: `External source snapshot ${importItem.itemId}`,
          chunks: [
            { chunkId: `chunk-${suffix}-0`, seq: 0, content: "first deterministic chunk\n", tokenEstimate: 7 },
            { chunkId: `chunk-${suffix}-1`, seq: 1, content: "second deterministic chunk", tokenEstimate: 7 },
          ],
          effect: {
            effectId: `effect-${suffix}`,
            targetId: `${fixture.intent.importId}:${importItem.itemId}`,
            idempotencyKey: `${approvalId}:external_source_knowledge_snapshot_apply:external_source_import_item:${fixture.intent.importId}:${importItem.itemId}`,
            payload: { ...payload, linkId: link.linkId, knowledgeDocumentId: link.knowledgeDocumentId },
            result: { linkId: link.linkId, knowledgeDocumentId: link.knowledgeDocumentId, chunkCount: 2 },
          },
          approvalExpiryCutoffIso: "2026-07-14T09:00:00.000Z",
          createdAt: "2026-07-14T08:09:00.000Z",
        };
        const materializationInput: ExternalSourceKnowledgeSnapshotMaterializationInput = {
          ...serializableInput,
          evaluatePolicy: () => ({ decision: "allow" }),
          buildJourneyEvents: () => [journeyEvent],
        };

        const countRows = (table: string) =>
          Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: string | number }>()!.count);

        // --- Replay proof: exact materialization once, byte-exact replay ---
        const links = new ExternalSourceKnowledgeLinkRepository(db);
        const created = links.materializeApprovedSnapshotWithJourney(materializationInput);
        assert.equal(created.disposition, "created");
        assert.equal(created.chunkCount, 2);
        assert.deepEqual(created.link, link);
        const replayed = links.materializeApprovedSnapshotWithJourney(materializationInput);
        assert.equal(replayed.disposition, "replayed");
        assert.deepEqual(replayed.link, created.link);
        assert.equal(replayed.chunkCount, 2);
        assert.equal(countRows("external_source_knowledge_links"), 1);
        assert.equal(countRows("knowledge_documents"), 1);
        assert.equal(countRows("knowledge_chunks"), 2);
        assert.equal(countRows("governance_journey_events"), 1);
        const effectRow = db
          .prepare(
            `SELECT status, effect_kind, target_kind, payload_json FROM approval_effects
             WHERE idempotency_key = @idempotencyKey`,
          )
          .get<{
            status: string;
            effect_kind: string;
            target_kind: string;
            payload_json: string;
          }>({ idempotencyKey: serializableInput.effect.idempotencyKey });
        assert.deepEqual(
          {
            status: effectRow!.status,
            effect_kind: effectRow!.effect_kind,
            target_kind: effectRow!.target_kind,
          },
          {
            status: "completed",
            effect_kind: "external_source_knowledge_snapshot_apply",
            target_kind: "external_source_import_item",
          },
        );
        assert.equal(effectRow!.payload_json, canonicalJsonString(serializableInput.effect.payload));

        // --- Concurrency proof: two racing applies on one FRESH approval ---
        // Expected (C2-noted racing behavior): at most one worker materializes
        // ("created"); the other either fails closed with a conflict-class
        // error (typically the knowledge_documents primary-key violation when
        // both pass the pre-existing-link read before either commits) or —
        // when the scheduler fully serializes the transactions — observes the
        // committed link and replays ("replayed"). Partial state is impossible
        // either way. The assertions below pin both admissible outcomes and
        // fail on anything else; the observed outcome is printed for the lane
        // artifact.
        const secondItem = fixture.importItems[1]!;
        const raceApprovalId = `approval-knowledge-race-${suffix}`;
        const racePayload = {
          ...payload,
          itemId: secondItem.itemId,
          normalizedArtifactSha256: secondItem.normalizedArtifactSha256,
          rawSha256: secondItem.rawSha256,
          attachmentId: `external-attachment-race-${suffix}`,
        };
        const raceAttachment = new ExternalSessionAttachmentRepository(db).attach({
          ...fixture.attachment,
          attachmentId: racePayload.attachmentId,
          itemId: secondItem.itemId,
          normalizedArtifactSha256: secondItem.normalizedArtifactSha256,
        });
        assert.equal(raceAttachment.status, "attached");
        db.prepare(
          `INSERT INTO approvals (
             approval_id, kind, risk_level, status, payload_json, preview_json, explanation_status,
             created_at, expires_at, resolved_at, resolved_by
           ) VALUES (
             @approvalId, 'external_source.knowledge_snapshot', 'danger', 'approved', @payloadJson, '{}',
             'not_requested', '2026-07-14T08:07:00.000Z', '2126-07-15T08:07:00.000Z',
             '2026-07-14T08:08:00.000Z', 'operator-1'
           )`,
        ).run({ approvalId: raceApprovalId, payloadJson: canonicalJsonString(racePayload) });
        const raceLink = sealExternalSourceKnowledgeLink({
          schemaVersion: fixture.config.schemaVersion,
          linkId: `knowledge-link-race-${suffix}`,
          workspaceId: fixture.config.workspaceId,
          sourceId: fixture.config.sourceId,
          importId: fixture.intent.importId,
          itemId: secondItem.itemId,
          normalizedArtifactSha256: secondItem.normalizedArtifactSha256,
          approvalId: raceApprovalId,
          knowledgeDocumentId: `knowledge-doc-race-${suffix}`,
          createdAt: "2026-07-14T08:10:00.000Z",
        });
        const raceInput = {
          link: raceLink,
          documentTitle: `External source snapshot ${secondItem.itemId}`,
          chunks: [
            { chunkId: `chunk-race-${suffix}-0`, seq: 0, content: "raced deterministic chunk", tokenEstimate: 6 },
          ],
          effect: {
            effectId: `effect-race-${suffix}`,
            targetId: `${fixture.intent.importId}:${secondItem.itemId}`,
            idempotencyKey: `${raceApprovalId}:external_source_knowledge_snapshot_apply:external_source_import_item:${fixture.intent.importId}:${secondItem.itemId}`,
            payload: { ...racePayload, linkId: raceLink.linkId, knowledgeDocumentId: raceLink.knowledgeDocumentId },
            result: { linkId: raceLink.linkId, knowledgeDocumentId: raceLink.knowledgeDocumentId, chunkCount: 1 },
          },
          approvalExpiryCutoffIso: "2026-07-14T09:00:00.000Z",
          createdAt: "2026-07-14T08:10:00.000Z",
          journeyEvent: knowledgeSnapshotJourneyEvent(raceLink, 1),
        };

        const startSignal = new SharedArrayBuffer(4);
        const workers = [0, 1].map((index) =>
          spawnMaterializationWorker(
            scopedUrl.toString(),
            database,
            `hx407-closure-race-${index}-${suffix}`,
            schemaName,
            raceInput,
            startSignal,
          ),
        );
        await Promise.all(workers.map((worker) => worker.ready));
        const startState = new Int32Array(startSignal);
        Atomics.store(startState, 0, 1);
        Atomics.notify(startState, 0);
        const results = await Promise.all(workers.map((worker) => worker.result));

        const succeeded = results.filter((result): result is { ok: true; disposition: string } => result.ok === true);
        const failed = results.filter((result): result is { ok: false; error: string } => result.ok === false);
        console.log(`HX-407 PG racing-applies observed outcome: ${JSON.stringify(results)}`);
        assert.ok(succeeded.length >= 1, `at least one racing apply must materialize: ${JSON.stringify(results)}`);
        assert.deepEqual(
          succeeded.filter((result) => result.disposition === "created").length,
          1,
          `exactly one racing apply may report created: ${JSON.stringify(results)}`,
        );
        for (const result of succeeded) {
          assert.ok(["created", "replayed"].includes(result.disposition), JSON.stringify(result));
        }
        for (const result of failed) {
          assert.match(
            result.error,
            /duplicate key|unique|conflict|already exists/iu,
            `the losing apply must fail closed with a conflict-class error: ${result.error}`,
          );
        }

        // No partial state either way: exactly one materialization landed.
        assert.equal(countRows("external_source_knowledge_links"), 2);
        assert.equal(countRows("knowledge_documents"), 2);
        assert.equal(countRows("knowledge_chunks"), 3);
        assert.equal(
          Number(
            db
              .prepare(`SELECT COUNT(*) AS count FROM approval_effects WHERE idempotency_key = @idempotencyKey`)
              .get<{ count: string | number }>({ idempotencyKey: raceInput.effect.idempotencyKey })!.count,
          ),
          1,
        );

        // A post-race sequential retry converges on the stored materialization.
        const raceReplay = links.materializeApprovedSnapshotWithJourney({
          ...raceInput,
          evaluatePolicy: () => ({ decision: "allow" }),
          buildJourneyEvents: () => [raceInput.journeyEvent],
        });
        assert.equal(raceReplay.disposition, "replayed");
        assert.deepEqual(raceReplay.link, raceLink);
        assert.equal(countRows("external_source_knowledge_links"), 2);
        assert.equal(countRows("governance_journey_events"), 2);
      } finally {
        db.close();
        await migrations.close().catch(() => undefined);
        await scopedPool.end().catch(() => undefined);
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
        await adminPool.end().catch(() => undefined);
      }
    },
  );
});

/**
 * Test-local mirror of the Gateway knowledge-snapshot Journey producer: every
 * field derives from the immutable link record so replays rebuild identically.
 */
function knowledgeSnapshotJourneyEvent(
  link: ReturnType<typeof sealExternalSourceKnowledgeLink>,
  chunkCount: number,
): GovernanceJourneyEventRecord {
  const fingerprint = D(
    canonicalJsonString({
      action: "snapshot_created",
      approvalId: link.approvalId,
      linkId: link.linkId,
      knowledgeDocumentId: link.knowledgeDocumentId,
      normalizedArtifactSha256: link.normalizedArtifactSha256,
      chunkCount,
    }),
  );
  return {
    schemaVersion: GOVERNANCE_JOURNEY_EVENT_VERSION,
    eventId: `journey-external-source-snapshot-created-${fingerprint.slice(0, 40)}`,
    idempotencyKey: `knowledge-snapshot-lifecycle:v1:snapshot_created:${fingerprint}`,
    scopeKind: "workspace",
    workspaceId: link.workspaceId,
    eventType: "knowledge_snapshot_lifecycle",
    subjectKind: "external_source_knowledge_snapshot",
    subjectId: link.linkId,
    action: "snapshot_created",
    actorId: "operator-1",
    actorType: "operator",
    approvalId: link.approvalId,
    fingerprint,
    sourceKind: "external_source",
    sourceId: link.sourceId,
    trustDisposition: "approved_snapshot",
    poisoningStatus: "clean",
    evidenceRefs: [
      { owner: "approval", refId: link.approvalId },
      { owner: "external_source", refId: link.importId },
    ],
    provenance: { sourceRequired: true, approvalRequired: true },
    summary: {
      approvalId: link.approvalId,
      linkId: link.linkId,
      knowledgeDocumentId: link.knowledgeDocumentId,
      chunkCount,
    },
    occurredAt: link.createdAt,
    recordedAt: link.createdAt,
  };
}

type MaterializationWorkerResult = { ok: true; disposition: string } | { ok: false; error: string };

function spawnMaterializationWorker(
  connectionString: string,
  database: string,
  applicationName: string,
  schemaName: string,
  input: Record<string, unknown>,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<MaterializationWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(MATERIALIZATION_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      input,
      schemaName,
      startSignal,
      repositoryModuleUrl: new URL(`./external-session-attachment-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (result: MaterializationWorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<MaterializationWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: MaterializationWorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`HX-407 PostgreSQL closure worker exited with code ${code}.`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const MATERIALIZATION_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { ExternalSourceKnowledgeLinkRepository } = await tsImport(
        workerData.repositoryModuleUrl,
        workerData.repositoryModuleUrl,
      );
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      db.exec("SET search_path TO " + workerData.schemaName);
      parentPort.postMessage({ kind: "ready" });
      const startState = new Int32Array(workerData.startSignal);
      Atomics.wait(startState, 0, 0);
      const { journeyEvent, ...rest } = workerData.input;
      try {
        const value = new ExternalSourceKnowledgeLinkRepository(db).materializeApprovedSnapshotWithJourney({
          ...rest,
          evaluatePolicy: () => ({ decision: "allow" }),
          buildJourneyEvents: () => [journeyEvent],
        });
        parentPort.postMessage({ kind: "result", result: { ok: true, disposition: value.disposition } });
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
          /* best-effort cleanup on worker exit */
        }
      }
    }
  })();
`;
