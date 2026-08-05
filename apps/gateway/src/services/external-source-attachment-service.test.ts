import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
  canonicalJsonString,
  type ExternalSourceCatalogItem,
  type ExternalSourceRecord,
} from "@goatcitadel/contracts";
import {
  createSqliteAsyncStorage,
  Storage,
  type AsyncStorage,
  computeExternalSourceArtifactSetSha256,
  computeExternalSourceNormalizedSetSha256,
  computeExternalSourceRawSetSha256,
  computeExternalSourceSelectedItemSetSha256,
  deriveExternalSourceImportIdempotencyKey,
  sealExternalSourceCatalogItem,
  sealExternalSourceImportIntent,
  sealExternalSourceImportItem,
  sealExternalSourceImportPlan,
  sealExternalSourceImportSettlement,
  sealExternalSourceRecord,
  sealExternalSourceScanRecord,
  sealWorkspacePathBridgeSnapshot,
} from "@goatcitadel/storage";
import { ExternalSourceArtifactStore } from "./external-source-artifact-store.js";
import {
  ExternalSourceAttachmentService,
  ExternalSourceAttachmentServiceError,
  deriveExternalSessionAttachmentId,
} from "./external-source-attachment-service.js";

const WORKSPACE_ID = "default";
const SESSION_ID = "session-1";
const TS = "2026-07-14T08:00:00.000Z";
const NOW_MS = Date.parse("2026-07-14T09:00:00.000Z");
const ACTOR = { actorId: "operator-1", source: "token" as const };
const CANARY_TEXT = "external canary bytes: lobster-matrix-7f3a must never enter evidence records";
const SECOND_TEXT = "second external artifact body with distinct bytes";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestText(value: string): string {
  return sha256(Buffer.from(value, "utf8"));
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

interface Harness {
  storage: Storage;
  asyncStorage: AsyncStorage;
  artifacts: ExternalSourceArtifactStore;
  service: ExternalSourceAttachmentService;
  source: ExternalSourceRecord;
  scanId: string;
  importId: string;
  itemIds: string[];
  artifactShas: string[];
  sessionIncarnationId: string;
  attachInput: (overrides?: Record<string, unknown>) => Record<string, unknown>;
}

async function createHarness(): Promise<Harness> {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  const asyncStorage = createSqliteAsyncStorage(storage);
  cleanups.push(() => storage.close());
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-hx407-attachments-"));
  cleanups.push(() => fs.rmSync(artifactsDir, { recursive: true, force: true }));
  const artifacts = new ExternalSourceArtifactStore(artifactsDir);

  const sourceId = "source-1";
  const scanId = "scan-1";
  const importId = "import-1";
  const canonicalRootPath = "F:\\synthetic\\codex\\source-1";
  const allowedRootsSha256 = digestText("allowed-roots:source-1");
  const snapshot = sealWorkspacePathBridgeSnapshot({
    schemaVersion: WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
    snapshotId: "path-source-1",
    requestHash: digestText("request:source-1"),
    workspaceId: WORKSPACE_ID,
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    gitIdentityRequired: false,
    inputPathHash: digestText(canonicalRootPath),
    allowedRootsHash: allowedRootsSha256,
    canonicalHostPath: canonicalRootPath,
    canonicalTargetPath: canonicalRootPath,
    roundTrip: {
      attempted: true,
      converter: "native",
      inputHostPathSha256: digestText("input:source-1"),
      targetPathSha256: digestText("target:source-1"),
      roundTripHostPathSha256: digestText("input:source-1"),
      equal: true,
    },
    gitIdentity: { status: "not_repository" },
    status: "verified",
    callable: true,
    createdAt: TS,
  });
  storage.workspacePathBridgeSnapshots.create(snapshot);

  const source = sealExternalSourceRecord({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    sourceId,
    workspaceId: WORKSPACE_ID,
    kind: "codex_sessions",
    label: "Synthetic source-1",
    ownerActorId: ACTOR.actorId,
    authActorId: ACTOR.actorId,
    authActorSource: ACTOR.source,
    canonicalRootPath,
    rootIdentitySha256: digestText("root:source-1"),
    pathBridgeSnapshotId: snapshot.snapshotId,
    pathBridgeSnapshotSha256: snapshot.snapshotSha256,
    allowedRootsSha256,
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    requireGitIdentity: false,
    rootGrantApprovalId: "root-grant-source-1",
    ownershipAttestationSha256: digestText("attestation:source-1"),
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "codex-synthetic-v1",
    adapterPolicy: {
      unknownVariantDisposition: "block",
      followLinks: false,
      followMarkdownImports: false,
      retainRawBytes: false,
      acceptedProducerVersions: ["codex-synthetic-v1"],
    },
    revision: 1,
    status: "active",
    createdAt: TS,
    updatedAt: TS,
  });
  storage.externalSourceConfigs.create(source);

  const bodies = [CANARY_TEXT, SECOND_TEXT].map((text) => Buffer.from(text, "utf8"));
  const artifactShas = bodies.map((body) => sha256(body));
  const catalogItems: ExternalSourceCatalogItem[] = bodies.map((body, index) =>
    sealExternalSourceCatalogItem({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: WORKSPACE_ID,
      sourceId,
      scanId,
      itemId: `item-${index + 1}`,
      adapterId: source.adapterId,
      adapterVersion: source.adapterVersion,
      normalizedRelativePath: `sessions/2026/07/14/synthetic-${index + 1}.jsonl`,
      aliasRelativePaths: [],
      foreignIdSha256: digestText(`foreign:${index}`),
      producerVersion: "codex-synthetic-v1",
      observedMtimeNs: (1_720_800_000_000_000_000n + BigInt(index)).toString().padStart(20, "0"),
      fileIdentitySha256: digestText(`file:${index}`),
      statFingerprintSha256: digestText(`stat:${index}`),
      rawSha256: digestText(`raw:${index}`),
      rawByteCount: 96 + index,
      messageCount: 2,
      lineageNodeCount: 2,
      lineageDepth: 1,
      lineageSha256: digestText(`lineage:${index}`),
      disposition: "supported",
      reasonCodes: [],
    }),
  );
  const scan = sealExternalSourceScanRecord(
    {
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      scanId,
      workspaceId: WORKSPACE_ID,
      sourceId,
      configRevision: source.revision,
      configSha256: source.configSha256,
      rootIdentitySha256: source.rootIdentitySha256,
      pathBridgeSnapshotSha256: source.pathBridgeSnapshotSha256,
      adapterId: source.adapterId,
      adapterVersion: source.adapterVersion,
      examinedEntryCount: catalogItems.length,
      blockerCodes: [],
      status: "sealed",
      startedAt: "2026-07-14T08:01:00.000Z",
      completedAt: "2026-07-14T08:01:01.000Z",
    },
    catalogItems,
  );
  storage.externalSourceScans.seal(scan, catalogItems);

  const importItems = catalogItems.map((item, ordinal) =>
    sealExternalSourceImportItem({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: WORKSPACE_ID,
      importId,
      scanId,
      itemId: item.itemId,
      ordinal,
      adapterId: item.adapterId,
      adapterVersion: item.adapterVersion,
      producerVersion: item.producerVersion,
      rawSha256: item.rawSha256,
      rawByteCount: item.rawByteCount,
      normalizedArtifactSha256: artifactShas[ordinal]!,
      normalizedByteCount: bodies[ordinal]!.length,
      artifactRelativeKey: `external-sources/sha256/${artifactShas[ordinal]!}`,
      createdAt: "2026-07-14T08:03:00.000Z",
    }),
  );
  const plan = sealExternalSourceImportPlan({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    planId: "plan-1",
    workspaceId: WORKSPACE_ID,
    sourceId,
    scanId,
    configRevision: source.revision,
    configSha256: source.configSha256,
    manifestSha256: scan.manifestSha256,
    adapterVersions: [source.adapterVersion],
    selectedItemIds: catalogItems.map((item) => item.itemId),
    selectedItemSetSha256: computeExternalSourceSelectedItemSetSha256(catalogItems.map((item) => item.itemId)),
    rawSetSha256: computeExternalSourceRawSetSha256(catalogItems),
    rawByteCount: catalogItems.reduce((total, item) => total + item.rawByteCount, 0),
    normalizedSetSha256: computeExternalSourceNormalizedSetSha256(importItems),
    normalizedByteCount: importItems.reduce((total, item) => total + item.normalizedByteCount, 0),
    messageCount: catalogItems.reduce((total, item) => total + item.messageCount, 0),
    blockerCodes: [],
    stagingLeaseId: "staging-1",
    stagingExpiresAt: "2026-07-14T09:00:00.000Z",
    createdAt: "2026-07-14T08:02:00.000Z",
  });
  storage.externalSourceImports.createPlan(plan);
  storage.externalSourceImports.claimIntent(
    sealExternalSourceImportIntent({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      importId,
      idempotencyKey: deriveExternalSourceImportIdempotencyKey(plan),
      workspaceId: WORKSPACE_ID,
      sourceId,
      scanId,
      planId: plan.planId,
      configRevision: plan.configRevision,
      configSha256: plan.configSha256,
      manifestSha256: plan.manifestSha256,
      planSha256: plan.planSha256,
      selectedItemSetSha256: plan.selectedItemSetSha256,
      adapterVersions: plan.adapterVersions,
      requestedByActorId: ACTOR.actorId,
      admittedAt: "2026-07-14T08:04:00.000Z",
    }),
  );
  storage.externalSourceImports.settle(
    sealExternalSourceImportSettlement(
      {
        schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
        settlementId: "settlement-1",
        workspaceId: WORKSPACE_ID,
        importId,
        disposition: "applied",
        artifactSetSha256: computeExternalSourceArtifactSetSha256(importItems),
        artifactsVerifiedAt: "2026-07-14T08:05:00.000Z",
        blockerCodes: [],
        settledAt: "2026-07-14T08:05:01.000Z",
      },
      importItems,
    ),
    importItems,
  );
  for (const [index, body] of bodies.entries()) {
    await artifacts.publish({ bytes: body, expectedSha256: artifactShas[index]!, signal: signal() });
  }

  const sessionMeta = storage.chatSessionMeta.ensure(SESSION_ID, TS, WORKSPACE_ID);
  const sessionIncarnationId = sessionMeta.lifecycleIntentId ?? `legacy-session-incarnation:${SESSION_ID}`;

  const service = new ExternalSourceAttachmentService({
    configs: asyncStorage.externalSourceConfigs,
    scans: asyncStorage.externalSourceScans,
    imports: asyncStorage.externalSourceImports,
    attachments: asyncStorage.externalSessionAttachments,
    sessions: { get: (sessionId) => asyncStorage.chatSessionMeta.get(sessionId) },
    artifacts,
    runImmediateTransaction: asyncStorage.runImmediateTransaction,
    clock: { nowMs: () => NOW_MS },
  });
  return {
    storage,
    asyncStorage,
    artifacts,
    service,
    source,
    scanId,
    importId,
    itemIds: catalogItems.map((item) => item.itemId),
    artifactShas,
    sessionIncarnationId,
    attachInput: (overrides = {}) => ({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      expectedSessionIncarnationId: sessionIncarnationId,
      sourceId,
      importId,
      itemId: "item-1",
      ...overrides,
    }),
  };
}

async function expectServiceError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof ExternalSourceAttachmentServiceError && error.code === code,
    `expected ExternalSourceAttachmentServiceError(${code})`,
  );
}

describe("ExternalSourceAttachmentService", () => {
  it("attaches read-only with same-transaction content-free Journey evidence and exact replay", async () => {
    const harness = await createHarness();
    const attached = await harness.service.attach(harness.attachInput(), ACTOR, signal());
    expect(attached.disposition).toBe("created");
    expect(attached.attachment).toMatchObject({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sourceId: harness.source.sourceId,
      importId: harness.importId,
      itemId: "item-1",
      normalizedArtifactSha256: harness.artifactShas[0],
      mode: "read_only_external",
      status: "attached",
      revision: 1,
      attachedByActorId: ACTOR.actorId,
    });
    expect(attached.attachment.attachmentId).toBe(
      deriveExternalSessionAttachmentId({
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        importId: harness.importId,
        itemId: "item-1",
      }),
    );

    const events = harness.storage.db
      .prepare("SELECT * FROM governance_journey_events WHERE subject_id = ? ORDER BY recorded_at")
      .all(attached.attachment.attachmentId) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "external_session_import",
      action: "attached_read_only",
      actor_id: ACTOR.actorId,
      source_kind: "external_source",
      source_id: harness.source.sourceId,
      trust_disposition: "read_only_external",
    });
    const serializedEvent = JSON.stringify(events[0]);
    expect(serializedEvent).not.toContain("lobster-matrix-7f3a");
    expect(serializedEvent).not.toContain(CANARY_TEXT);
    expect(JSON.parse(String(events[0]!.provenance_json))).toMatchObject({
      sourceRequired: true,
      approvalRequired: false,
      sessionIncarnationId: harness.sessionIncarnationId,
    });

    const replay = await harness.service.attach(harness.attachInput(), ACTOR, signal());
    expect(replay.disposition).toBe("replayed");
    expect(replay.attachment).toEqual(attached.attachment);
    const replayEvents = harness.storage.db
      .prepare("SELECT COUNT(*) AS count FROM governance_journey_events WHERE subject_id = ?")
      .get(attached.attachment.attachmentId) as { count: number };
    expect(Number(replayEvents.count)).toBe(1);

    const listed = await harness.service.list({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID }, ACTOR);
    expect(listed.items).toEqual([attached.attachment]);
    expect(JSON.stringify(listed)).not.toContain("lobster-matrix-7f3a");
  });

  it("denies cross-workspace attach without leaking existence", async () => {
    const harness = await createHarness();
    await expectServiceError(
      harness.service.attach(harness.attachInput({ workspaceId: "workspace-other" }), ACTOR, signal()),
      "not_found",
    );
    await expectServiceError(
      harness.service.attach(harness.attachInput({ sessionId: "session-foreign" }), ACTOR, signal()),
      "not_found",
    );
    await expect(
      harness.service.list({ workspaceId: "workspace-other", sessionId: SESSION_ID }, ACTOR),
    ).rejects.toThrowError(ExternalSourceAttachmentServiceError);
    const rows = harness.storage.db.prepare("SELECT COUNT(*) AS count FROM chat_external_source_attachments").get() as {
      count: number;
    };
    expect(Number(rows.count)).toBe(0);
  });

  it("denies a stale session incarnation on attach, detach, and knowledge requests", async () => {
    const harness = await createHarness();
    await expectServiceError(
      harness.service.attach(
        harness.attachInput({ expectedSessionIncarnationId: `legacy-session-incarnation:${SESSION_ID}` }),
        ACTOR,
        signal(),
      ),
      "session_incarnation_stale",
    );
    const attached = await harness.service.attach(harness.attachInput(), ACTOR, signal());
    await expectServiceError(
      harness.service.detach(
        {
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          attachmentId: attached.attachment.attachmentId,
          expectedRevision: 1,
          expectedSessionIncarnationId: "stale-incarnation",
        },
        ACTOR,
        signal(),
      ),
      "session_incarnation_stale",
    );
    await expectServiceError(
      harness.service.buildKnowledgeSnapshotRequest(
        {
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          expectedSessionIncarnationId: "stale-incarnation",
          attachmentId: attached.attachment.attachmentId,
          importId: harness.importId,
          itemId: "item-1",
          expectedAttachmentRevision: 1,
        },
        ACTOR,
        signal(),
      ),
      "session_incarnation_stale",
    );
  });

  it("enforces the attachment revision CAS and keeps detach idempotent", async () => {
    const harness = await createHarness();
    const attached = await harness.service.attach(harness.attachInput(), ACTOR, signal());
    const detachInput = {
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      attachmentId: attached.attachment.attachmentId,
      expectedRevision: 1,
      expectedSessionIncarnationId: harness.sessionIncarnationId,
    };
    await expectServiceError(
      harness.service.detach({ ...detachInput, expectedRevision: 2 }, ACTOR, signal()),
      "conflict",
    );

    const detached = await harness.service.detach(detachInput, ACTOR, signal());
    expect(detached.disposition).toBe("detached");
    expect(detached.attachment).toMatchObject({ status: "detached", revision: 2, detachedByActorId: ACTOR.actorId });

    const replay = await harness.service.detach(detachInput, ACTOR, signal());
    expect(replay.disposition).toBe("replayed");
    expect(replay.attachment).toEqual(detached.attachment);
    const events = harness.storage.db
      .prepare("SELECT action, COUNT(*) AS count FROM governance_journey_events WHERE subject_id = ? GROUP BY action")
      .all(attached.attachment.attachmentId) as Array<{ action: string; count: number }>;
    expect(events.map((row) => `${row.action}:${Number(row.count)}`).sort()).toEqual([
      "attached_read_only:1",
      "detached:1",
    ]);

    await expectServiceError(harness.service.attach(harness.attachInput(), ACTOR, signal()), "conflict");
  });

  it("fails closed on identity drift while leaving immutable imports untouched", async () => {
    const harness = await createHarness();
    const { configSha256: _configSha256, ...sourceDraft } = harness.source;
    const drifted = sealExternalSourceRecord({
      ...sourceDraft,
      rootIdentitySha256: digestText("root:drifted-generation"),
    });
    const driftedService = new ExternalSourceAttachmentService({
      configs: { find: async () => drifted },
      scans: harness.asyncStorage.externalSourceScans,
      imports: harness.asyncStorage.externalSourceImports,
      attachments: harness.asyncStorage.externalSessionAttachments,
      sessions: { get: (sessionId) => harness.asyncStorage.chatSessionMeta.get(sessionId) },
      artifacts: harness.artifacts,
      runImmediateTransaction: harness.asyncStorage.runImmediateTransaction,
      clock: { nowMs: () => NOW_MS },
    });
    await expectServiceError(driftedService.attach(harness.attachInput(), ACTOR, signal()), "identity_drift");
    const settlement = harness.storage.externalSourceImports.getSettlement(WORKSPACE_ID, harness.importId);
    expect(settlement.disposition).toBe("applied");
    expect(harness.storage.externalSourceImports.listItems(WORKSPACE_ID, harness.importId)).toHaveLength(2);
  });

  it("fails closed for tombstoned sources on attach, live read, and knowledge requests but not detach", async () => {
    const harness = await createHarness();
    const attached = await harness.service.attach(harness.attachInput(), ACTOR, signal());
    const { configSha256: _configSha256, ...sourceDraft } = harness.source;
    harness.storage.externalSourceConfigs.updateCas(
      sealExternalSourceRecord({
        ...sourceDraft,
        status: "revoked",
        revision: 2,
        updatedAt: "2026-07-14T08:30:00.000Z",
      }),
      1,
      16,
    );

    await expectServiceError(
      harness.service.attach(harness.attachInput({ itemId: "item-2" }), ACTOR, signal()),
      "source_not_active",
    );
    await expectServiceError(
      harness.service.readAttachedExternalContext(
        { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, attachmentId: attached.attachment.attachmentId },
        signal(),
      ),
      "source_not_active",
    );
    await expectServiceError(
      harness.service.buildKnowledgeSnapshotRequest(
        {
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          expectedSessionIncarnationId: harness.sessionIncarnationId,
          attachmentId: attached.attachment.attachmentId,
          importId: harness.importId,
          itemId: "item-1",
          expectedAttachmentRevision: 1,
        },
        ACTOR,
        signal(),
      ),
      "source_not_active",
    );

    const detached = await harness.service.detach(
      {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        attachmentId: attached.attachment.attachmentId,
        expectedRevision: 1,
        expectedSessionIncarnationId: harness.sessionIncarnationId,
      },
      ACTOR,
      signal(),
    );
    expect(detached.disposition).toBe("detached");
    expect(harness.storage.externalSourceImports.listItems(WORKSPACE_ID, harness.importId)).toHaveLength(2);
  });

  it("reads byte-exact live context with complete provenance and fails closed on artifact tamper", async () => {
    const harness = await createHarness();
    const attached = await harness.service.attach(harness.attachInput(), ACTOR, signal());
    const read = await harness.service.readAttachedExternalContext(
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, attachmentId: attached.attachment.attachmentId },
      signal(),
    );
    expect(read.bytes.toString("utf8")).toBe(CANARY_TEXT);
    expect(sha256(read.bytes)).toBe(harness.artifactShas[0]);
    expect(read.provenance).toEqual({
      sourceId: harness.source.sourceId,
      importId: harness.importId,
      itemId: "item-1",
      attachmentId: attached.attachment.attachmentId,
      attachmentRevision: 1,
      normalizedArtifactSha256: harness.artifactShas[0],
    });

    const detachedTarget = await harness.service.attach(harness.attachInput({ itemId: "item-2" }), ACTOR, signal());
    await harness.service.detach(
      {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        attachmentId: detachedTarget.attachment.attachmentId,
        expectedRevision: 1,
        expectedSessionIncarnationId: harness.sessionIncarnationId,
      },
      ACTOR,
      signal(),
    );
    await expectServiceError(
      harness.service.readAttachedExternalContext(
        { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, attachmentId: detachedTarget.attachment.attachmentId },
        signal(),
      ),
      "conflict",
    );

    const artifactPath = path.join(
      (harness.artifacts as unknown as { rootDir: string }).rootDir,
      "external-sources",
      "sha256",
      harness.artifactShas[0]!,
    );
    fs.chmodSync(artifactPath, 0o600);
    fs.writeFileSync(artifactPath, "tampered bytes that no longer hash to the immutable address");
    await expectServiceError(
      harness.service.readAttachedExternalContext(
        { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, attachmentId: attached.attachment.attachmentId },
        signal(),
      ),
      "artifact_failure",
    );
  });

  it("builds deterministic server-derived knowledge-request material and rejects client hashes", async () => {
    const harness = await createHarness();
    const attached = await harness.service.attach(harness.attachInput(), ACTOR, signal());
    const requestInput = {
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      expectedSessionIncarnationId: harness.sessionIncarnationId,
      attachmentId: attached.attachment.attachmentId,
      importId: harness.importId,
      itemId: "item-1",
      expectedAttachmentRevision: 1,
    };
    const material = await harness.service.buildKnowledgeSnapshotRequest(requestInput, ACTOR, signal());
    expect(material.approvalKind).toBe("external_source.knowledge_snapshot");
    expect(material.effectKind).toBe("external_source_knowledge_snapshot_apply");
    expect(material.effectTargetKind).toBe("external_source_import_item");
    expect(material.payload).toEqual({
      workspaceId: WORKSPACE_ID,
      sourceId: harness.source.sourceId,
      importId: harness.importId,
      itemId: "item-1",
      normalizedArtifactSha256: harness.artifactShas[0],
      rawSha256: digestText("raw:0"),
      sessionId: SESSION_ID,
      sessionIncarnationId: harness.sessionIncarnationId,
      attachmentId: attached.attachment.attachmentId,
      attachmentRevision: 1,
    });
    const replay = await harness.service.buildKnowledgeSnapshotRequest(requestInput, ACTOR, signal());
    expect(canonicalJsonString(replay)).toBe(canonicalJsonString(material));
    expect(JSON.stringify(material)).not.toContain("lobster-matrix-7f3a");

    await expect(
      harness.service.buildKnowledgeSnapshotRequest(
        { ...requestInput, normalizedArtifactSha256: "f".repeat(64) },
        ACTOR,
        signal(),
      ),
    ).rejects.toThrow(/unsupported or missing/u);
    await expectServiceError(
      harness.service.buildKnowledgeSnapshotRequest(
        { ...requestInput, expectedAttachmentRevision: 2 },
        ACTOR,
        signal(),
      ),
      "conflict",
    );
  });

  it("never promotes external content into knowledge, memory, skills, or callable capabilities", async () => {
    const harness = await createHarness();
    const countRows = () =>
      Object.fromEntries(
        [
          "knowledge_documents",
          "knowledge_chunks",
          "learned_memory_items",
          "candidate_skill_versions",
          "skill_lifecycle",
          "external_source_knowledge_links",
        ].map((table) => [
          table,
          Number(
            (harness.storage.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
          ),
        ]),
      );
    const before = countRows();
    const attached = await harness.service.attach(harness.attachInput(), ACTOR, signal());
    await harness.service.readAttachedExternalContext(
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, attachmentId: attached.attachment.attachmentId },
      signal(),
    );
    await harness.service.buildKnowledgeSnapshotRequest(
      {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        expectedSessionIncarnationId: harness.sessionIncarnationId,
        attachmentId: attached.attachment.attachmentId,
        importId: harness.importId,
        itemId: "item-1",
        expectedAttachmentRevision: 1,
      },
      ACTOR,
      signal(),
    );
    await harness.service.detach(
      {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        attachmentId: attached.attachment.attachmentId,
        expectedRevision: 1,
        expectedSessionIncarnationId: harness.sessionIncarnationId,
      },
      ACTOR,
      signal(),
    );
    expect(countRows()).toEqual(before);
    const approvals = harness.storage.db.prepare("SELECT COUNT(*) AS count FROM approvals").get() as {
      count: number;
    };
    expect(Number(approvals.count)).toBe(0);
  });
});
