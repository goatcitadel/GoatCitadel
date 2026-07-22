import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_TTL_MS,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
  canonicalJsonString,
  type ExternalSourceCatalogItem,
  type ExternalSourceKnowledgeSnapshotApprovalPayload,
  type ExternalSourceRecord,
} from "@goatcitadel/contracts";
import {
  Storage,
  buildExternalSourceKnowledgeDocumentBinding,
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
import { ExternalSourceAttachmentService } from "./external-source-attachment-service.js";
import { buildExternalSourceKnowledgeSnapshotJourneyEvent } from "./external-source-journey-producer.js";
import {
  ExternalSourceKnowledgeEffectService,
  ExternalSourceKnowledgeEffectServiceError,
  chunkExternalSourceKnowledgeText,
  deriveExternalSourceKnowledgeSnapshotApprovalId,
  deriveExternalSourceKnowledgeSnapshotMaterializedIdentities,
  type ExternalSourceKnowledgeSnapshotPolicyDecision,
} from "./external-source-knowledge-effect-service.js";

const WORKSPACE_ID = "default";
const SESSION_ID = "session-1";
const TS = "2026-07-14T08:00:00.000Z";
const NOW_MS = Date.parse("2026-07-14T09:00:00.000Z");
const ACTOR = { actorId: "operator-1", source: "token" as const };
const CANARY_TEXT = "external canary bytes: lobster-matrix-7f3a must never enter evidence records";
const SECOND_TEXT = "second external artifact body with distinct bytes";
const EVIDENCE_TABLES = [
  "knowledge_documents",
  "knowledge_chunks",
  "external_source_knowledge_links",
  "chat_thread_knowledge_attachments",
  "approval_effects",
  "governance_journey_events",
  "learned_memory_items",
  "candidate_skill_versions",
  "skill_lifecycle",
] as const;

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
  artifacts: ExternalSourceArtifactStore;
  attachmentService: ExternalSourceAttachmentService;
  service: ExternalSourceKnowledgeEffectService;
  source: ExternalSourceRecord;
  scanId: string;
  importId: string;
  artifactShas: string[];
  sessionIncarnationId: string;
  policy: { decision: ExternalSourceKnowledgeSnapshotPolicyDecision };
  clock: { nowMs: number };
  countRows: () => Record<string, number>;
  attach: (itemId?: string) => Promise<{ attachmentId: string }>;
  requestInput: (attachmentId: string, overrides?: Record<string, unknown>) => Record<string, unknown>;
}

async function createHarness(): Promise<Harness> {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  cleanups.push(() => storage.close());
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-hx407-knowledge-effect-"));
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

  const clock = { nowMs: NOW_MS };
  const policy: Harness["policy"] = { decision: { decision: "allow" } };
  const attachmentService = new ExternalSourceAttachmentService({
    configs: storage.externalSourceConfigs,
    scans: storage.externalSourceScans,
    imports: storage.externalSourceImports,
    attachments: storage.externalSessionAttachments,
    sessions: { get: (sessionId) => storage.chatSessionMeta.get(sessionId) },
    artifacts,
    clock: { nowMs: () => clock.nowMs },
  });
  const service = new ExternalSourceKnowledgeEffectService({
    requests: attachmentService,
    approvals: storage.approvals,
    links: storage.externalSourceKnowledgeLinks,
    journeys: storage.governanceJourneyEvents,
    policy: { evaluateKnowledgeSnapshotApply: () => policy.decision },
    runImmediateTransaction: (callback) => storage.runImmediateTransaction(callback),
    clock: { nowMs: () => clock.nowMs },
  });
  const countRows = () =>
    Object.fromEntries(
      EVIDENCE_TABLES.map((table) => [
        table,
        Number((storage.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count),
      ]),
    );
  const attach = async (itemId = "item-1") => {
    const attached = await attachmentService.attach(
      {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        expectedSessionIncarnationId: sessionIncarnationId,
        sourceId,
        importId,
        itemId,
      },
      ACTOR,
      signal(),
    );
    return { attachmentId: attached.attachment.attachmentId };
  };
  return {
    storage,
    artifacts,
    attachmentService,
    service,
    source,
    scanId,
    importId,
    artifactShas,
    sessionIncarnationId,
    policy,
    clock,
    countRows,
    attach,
    requestInput: (attachmentId, overrides = {}) => ({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      expectedSessionIncarnationId: sessionIncarnationId,
      attachmentId,
      importId,
      itemId: "item-1",
      expectedAttachmentRevision: 1,
      ...overrides,
    }),
  };
}

async function expectEffectError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof ExternalSourceKnowledgeEffectServiceError && error.code === code,
    `expected ExternalSourceKnowledgeEffectServiceError(${code})`,
  );
}

async function createApprovedSnapshotApproval(
  harness: Harness,
  itemId = "item-1",
): Promise<{ approvalId: string; attachmentId: string }> {
  const { attachmentId } = await harness.attach(itemId);
  const created = await harness.service.createApprovalRequest(
    harness.requestInput(attachmentId, { itemId }),
    ACTOR,
    signal(),
  );
  harness.storage.approvals.resolve(created.approval.approvalId, { decision: "approve", resolvedBy: ACTOR.actorId });
  return { approvalId: created.approval.approvalId, attachmentId };
}

describe("ExternalSourceKnowledgeEffectService", () => {
  it("creates one deterministic bounded-expiry approval with request Journey evidence and exact replay", async () => {
    const harness = await createHarness();
    const { attachmentId } = await harness.attach();
    const created = await harness.service.createApprovalRequest(harness.requestInput(attachmentId), ACTOR, signal());
    expect(created.disposition).toBe("created");
    expect(created.approval.status).toBe("pending");
    expect(created.approval.kind).toBe("external_source.knowledge_snapshot");
    expect(created.approval.riskLevel).toBe("danger");
    expect(created.approval.approvalId).toBe(
      deriveExternalSourceKnowledgeSnapshotApprovalId(
        created.material.payload as ExternalSourceKnowledgeSnapshotApprovalPayload,
      ),
    );
    expect(created.approval.payload).toEqual(created.material.payload);
    expect(created.approval.linkage).toMatchObject({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      operatorId: ACTOR.actorId,
    });
    const windowMs = Date.parse(created.approval.expiresAt!) - Date.parse(created.approval.createdAt);
    expect(Math.abs(windowMs - EXTERNAL_SOURCE_KNOWLEDGE_SNAPSHOT_APPROVAL_TTL_MS)).toBeLessThan(2_000);

    const requestEvents = harness.storage.db
      .prepare("SELECT * FROM governance_journey_events WHERE event_type = 'knowledge_snapshot_lifecycle'")
      .all() as Array<Record<string, unknown>>;
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]).toMatchObject({
      action: "approval_requested",
      subject_id: created.approval.approvalId,
      approval_id: created.approval.approvalId,
      source_kind: "external_source",
      source_id: harness.source.sourceId,
    });
    expect(JSON.stringify(requestEvents[0])).not.toContain("lobster-matrix-7f3a");

    const replay = await harness.service.createApprovalRequest(harness.requestInput(attachmentId), ACTOR, signal());
    expect(replay.disposition).toBe("replayed");
    expect(replay.approval.approvalId).toBe(created.approval.approvalId);

    harness.storage.approvals.resolve(created.approval.approvalId, { decision: "approve", resolvedBy: ACTOR.actorId });
    const postResolveReplay = await harness.service.createApprovalRequest(
      harness.requestInput(attachmentId),
      ACTOR,
      signal(),
    );
    expect(postResolveReplay.disposition).toBe("replayed");
    expect(postResolveReplay.approval.status).toBe("approved");

    const approvalsCount = harness.storage.db.prepare("SELECT COUNT(*) AS count FROM approvals").get() as {
      count: number;
    };
    expect(Number(approvalsCount.count)).toBe(1);
    const journeyCount = harness.storage.db
      .prepare(
        "SELECT COUNT(*) AS count FROM governance_journey_events WHERE event_type = 'knowledge_snapshot_lifecycle'",
      )
      .get() as { count: number };
    expect(Number(journeyCount.count)).toBe(1);
  });

  it("applies one approved snapshot atomically with the deterministic document, byte-exact chunks, link, and frozen effect vocabulary", async () => {
    const harness = await createHarness();
    const { approvalId } = await createApprovedSnapshotApproval(harness);
    const applied = await harness.service.applyApprovedSnapshot(
      { workspaceId: WORKSPACE_ID, approvalId },
      ACTOR,
      signal(),
    );
    expect(applied.disposition).toBe("created");
    const payload = harness.storage.approvals.get(approvalId).payload as unknown as {
      itemId: string;
    } & ExternalSourceKnowledgeSnapshotApprovalPayload;
    const identities = deriveExternalSourceKnowledgeSnapshotMaterializedIdentities(payload);
    expect(applied.link.linkId).toBe(identities.linkId);
    expect(applied.knowledgeDocumentId).toBe(identities.knowledgeDocumentId);
    expect(applied.link.threadKnowledgeAttachmentId).toBeUndefined();
    expect(applied.chunkCount).toBe(chunkExternalSourceKnowledgeText(CANARY_TEXT).length);

    const binding = buildExternalSourceKnowledgeDocumentBinding(applied.link);
    const documentRow = harness.storage.db
      .prepare(
        "SELECT namespace, source_type, source_ref, title, metadata_json FROM knowledge_documents WHERE doc_id = ?",
      )
      .get(applied.knowledgeDocumentId) as Record<string, unknown>;
    expect({ ...documentRow }).toEqual({
      namespace: binding.namespace,
      source_type: binding.sourceType,
      source_ref: binding.sourceRef,
      title: `External source snapshot ${payload.itemId}`,
      metadata_json: binding.metadataJson,
    });
    const chunkRows = harness.storage.db
      .prepare("SELECT content FROM knowledge_chunks WHERE doc_id = ? ORDER BY seq ASC")
      .all(applied.knowledgeDocumentId) as Array<{ content: string }>;
    expect(chunkRows.map((row) => row.content).join("")).toBe(CANARY_TEXT);

    const storedLink = harness.storage.externalSourceKnowledgeLinks.get(WORKSPACE_ID, applied.link.linkId);
    expect(storedLink).toEqual(applied.link);

    const effectRow = harness.storage.db
      .prepare("SELECT approval_id, effect_kind, target_kind, target_id, status FROM approval_effects")
      .get() as Record<string, unknown>;
    expect({ ...effectRow }).toEqual({
      approval_id: approvalId,
      effect_kind: "external_source_knowledge_snapshot_apply",
      target_kind: "external_source_import_item",
      target_id: `${harness.importId}:item-1`,
      status: "completed",
    });

    const applyEvents = harness.storage.db
      .prepare(
        "SELECT action, approval_id, provenance_json FROM governance_journey_events WHERE event_type = 'knowledge_snapshot_lifecycle' AND subject_id = ?",
      )
      .all(applied.link.linkId) as Array<Record<string, unknown>>;
    expect(applyEvents).toHaveLength(1);
    expect(applyEvents[0]).toMatchObject({ action: "snapshot_created", approval_id: approvalId });
    expect(JSON.parse(String(applyEvents[0]!.provenance_json))).toMatchObject({
      sourceRequired: true,
      approvalRequired: true,
    });
  });

  it("replays idempotently and survives a concurrency race with exactly one materialization", async () => {
    const harness = await createHarness();
    const { approvalId } = await createApprovedSnapshotApproval(harness);
    const before = harness.countRows();
    const [first, second] = await Promise.all([
      harness.service.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
      harness.service.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
    ]);
    expect([first.disposition, second.disposition].sort()).toEqual(["created", "replayed"]);
    expect(canonicalJsonString(first.link)).toBe(canonicalJsonString(second.link));

    const replay = await harness.service.applyApprovedSnapshot(
      { workspaceId: WORKSPACE_ID, approvalId },
      ACTOR,
      signal(),
    );
    expect(replay.disposition).toBe("replayed");
    expect(replay.chunkCount).toBe(first.chunkCount);
    const after = harness.countRows();
    expect(after).toEqual({
      ...before,
      knowledge_documents: before.knowledge_documents! + 1,
      knowledge_chunks: before.knowledge_chunks! + first.chunkCount,
      external_source_knowledge_links: before.external_source_knowledge_links! + 1,
      approval_effects: before.approval_effects! + 1,
      governance_journey_events: before.governance_journey_events! + 1,
    });
  });

  it("materializes the optional ordinary thread knowledge attachment with attached Journey evidence", async () => {
    const harness = await createHarness();
    const { approvalId } = await createApprovedSnapshotApproval(harness);
    const applied = await harness.service.applyApprovedSnapshot(
      { workspaceId: WORKSPACE_ID, approvalId, includeThreadAttachment: true },
      ACTOR,
      signal(),
    );
    expect(applied.disposition).toBe("created");
    expect(applied.threadKnowledgeAttachmentId).toBeDefined();
    expect(applied.link.threadKnowledgeAttachmentId).toBe(applied.threadKnowledgeAttachmentId);
    const attachment = harness.storage.chatThreadKnowledgeAttachments.get(applied.threadKnowledgeAttachmentId!);
    expect(attachment).toMatchObject({
      sessionId: SESSION_ID,
      documentId: applied.knowledgeDocumentId,
      ingestStatus: "ready",
      retrievalMode: "retrieval",
      chunkCount: applied.chunkCount,
    });
    const actions = (
      harness.storage.db
        .prepare(
          "SELECT action FROM governance_journey_events WHERE event_type = 'knowledge_snapshot_lifecycle' AND subject_id = ? ORDER BY action",
        )
        .all(applied.link.linkId) as Array<{ action: string }>
    ).map((row) => row.action);
    expect(actions).toEqual(["attached", "snapshot_created"]);

    // A replay without the option converges on the stored materialized truth.
    const replay = await harness.service.applyApprovedSnapshot(
      { workspaceId: WORKSPACE_ID, approvalId },
      ACTOR,
      signal(),
    );
    expect(replay.disposition).toBe("replayed");
    expect(replay.threadKnowledgeAttachmentId).toBe(applied.threadKnowledgeAttachmentId);
  });

  it("fails closed on missing, foreign, pending, rejected, and expired approvals with zero storage delta", async () => {
    const harness = await createHarness();
    const { attachmentId } = await harness.attach();
    const created = await harness.service.createApprovalRequest(harness.requestInput(attachmentId), ACTOR, signal());
    const approvalId = created.approval.approvalId;
    const before = harness.countRows();

    await expectEffectError(
      harness.service.applyApprovedSnapshot(
        { workspaceId: WORKSPACE_ID, approvalId: "approval-missing" },
        ACTOR,
        signal(),
      ),
      "not_found",
    );
    await expectEffectError(
      harness.service.applyApprovedSnapshot({ workspaceId: "workspace-other", approvalId }, ACTOR, signal()),
      "not_found",
    );
    await expectEffectError(
      harness.service.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
      "approval_not_approved",
    );

    harness.storage.approvals.resolve(approvalId, { decision: "reject", resolvedBy: ACTOR.actorId });
    await expectEffectError(
      harness.service.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
      "approval_not_approved",
    );
    expect(harness.countRows()).toEqual(before);

    const second = await createApprovedSnapshotApproval(harness, "item-2");
    const beforeExpiry = harness.countRows();
    harness.clock.nowMs = Date.parse("2036-01-01T00:00:00.000Z");
    await expectEffectError(
      harness.service.applyApprovedSnapshot(
        { workspaceId: WORKSPACE_ID, approvalId: second.approvalId },
        ACTOR,
        signal(),
      ),
      "approval_expired",
    );
    harness.clock.nowMs = NOW_MS;
    expect(harness.countRows()).toEqual(beforeExpiry);
    const settlement = harness.storage.externalSourceImports.getSettlement(WORKSPACE_ID, harness.importId);
    expect(settlement.disposition).toBe("applied");
  });

  it("fails closed when deny-wins policy flips between approval and apply", async () => {
    const harness = await createHarness();
    const { approvalId } = await createApprovedSnapshotApproval(harness);
    const before = harness.countRows();
    harness.policy.decision = { decision: "deny", reasonCode: "workspace_policy_flip" };
    await expect(
      harness.service.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ExternalSourceKnowledgeEffectServiceError &&
        error.code === "policy_denied" &&
        error.reasonCode === "workspace_policy_flip",
    );
    expect(harness.countRows()).toEqual(before);

    harness.policy.decision = { decision: "allow" };
    const applied = await harness.service.applyApprovedSnapshot(
      { workspaceId: WORKSPACE_ID, approvalId },
      ACTOR,
      signal(),
    );
    expect(applied.disposition).toBe("created");
  });

  it("fails closed on attachment drift: revision bump via detach and stale session incarnation", async () => {
    const harness = await createHarness();
    const { approvalId, attachmentId } = await createApprovedSnapshotApproval(harness);
    const before = harness.countRows();

    const rotatedAttachmentService = new ExternalSourceAttachmentService({
      configs: harness.storage.externalSourceConfigs,
      scans: harness.storage.externalSourceScans,
      imports: harness.storage.externalSourceImports,
      attachments: harness.storage.externalSessionAttachments,
      sessions: {
        get: (sessionId) => {
          const meta = harness.storage.chatSessionMeta.get(sessionId);
          return meta ? { ...meta, lifecycleIntentId: "rotated-incarnation-1" } : undefined;
        },
      },
      artifacts: harness.artifacts,
      clock: { nowMs: () => harness.clock.nowMs },
    });
    const rotatedService = new ExternalSourceKnowledgeEffectService({
      requests: rotatedAttachmentService,
      approvals: harness.storage.approvals,
      links: harness.storage.externalSourceKnowledgeLinks,
      journeys: harness.storage.governanceJourneyEvents,
      policy: { evaluateKnowledgeSnapshotApply: () => harness.policy.decision },
      runImmediateTransaction: (callback) => harness.storage.runImmediateTransaction(callback),
      clock: { nowMs: () => harness.clock.nowMs },
    });
    await expectEffectError(
      rotatedService.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
      "session_incarnation_stale",
    );
    expect(harness.countRows()).toEqual(before);

    // The detach itself is a legitimate C1 lifecycle transition (with its own
    // Journey record); the apply after it must add nothing on top.
    await harness.attachmentService.detach(
      {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        attachmentId,
        expectedRevision: 1,
        expectedSessionIncarnationId: harness.sessionIncarnationId,
      },
      ACTOR,
      signal(),
    );
    const afterDetach = harness.countRows();
    await expectEffectError(
      harness.service.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
      "conflict",
    );
    expect(harness.countRows()).toEqual(afterDetach);
    expect(harness.storage.externalSourceImports.listItems(WORKSPACE_ID, harness.importId)).toHaveLength(2);
  });

  it("fails closed on source tombstone, identity drift, and artifact tamper while imports stay untouched", async () => {
    const harness = await createHarness();
    const { approvalId } = await createApprovedSnapshotApproval(harness);
    const before = harness.countRows();

    const artifactPath = path.join(
      (harness.artifacts as unknown as { rootDir: string }).rootDir,
      "external-sources",
      "sha256",
      harness.artifactShas[0]!,
    );
    const originalBytes = fs.readFileSync(artifactPath);
    fs.chmodSync(artifactPath, 0o600);
    fs.writeFileSync(artifactPath, "tampered bytes that no longer hash to the immutable address");
    await expectEffectError(
      harness.service.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
      "artifact_failure",
    );
    fs.writeFileSync(artifactPath, originalBytes);

    const { configSha256: _configSha256, ...sourceDraft } = harness.source;
    const drifted = sealExternalSourceRecord({
      ...sourceDraft,
      rootIdentitySha256: digestText("root:drifted-generation"),
    });
    const driftedAttachmentService = new ExternalSourceAttachmentService({
      configs: { find: () => drifted },
      scans: harness.storage.externalSourceScans,
      imports: harness.storage.externalSourceImports,
      attachments: harness.storage.externalSessionAttachments,
      sessions: { get: (sessionId) => harness.storage.chatSessionMeta.get(sessionId) },
      artifacts: harness.artifacts,
      clock: { nowMs: () => harness.clock.nowMs },
    });
    const driftedService = new ExternalSourceKnowledgeEffectService({
      requests: driftedAttachmentService,
      approvals: harness.storage.approvals,
      links: harness.storage.externalSourceKnowledgeLinks,
      journeys: harness.storage.governanceJourneyEvents,
      policy: { evaluateKnowledgeSnapshotApply: () => harness.policy.decision },
      runImmediateTransaction: (callback) => harness.storage.runImmediateTransaction(callback),
      clock: { nowMs: () => harness.clock.nowMs },
    });
    await expectEffectError(
      driftedService.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
      "identity_drift",
    );

    const { configSha256: _tombstoneConfigSha256, ...tombstoneDraft } = harness.source;
    harness.storage.externalSourceConfigs.updateCas(
      sealExternalSourceRecord({
        ...tombstoneDraft,
        status: "revoked",
        revision: 2,
        updatedAt: "2026-07-14T08:30:00.000Z",
      }),
      1,
      16,
    );
    await expectEffectError(
      harness.service.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
      "source_not_active",
    );
    expect(harness.countRows()).toEqual(before);
    const settlement = harness.storage.externalSourceImports.getSettlement(WORKSPACE_ID, harness.importId);
    expect(settlement.disposition).toBe("applied");
    expect(harness.storage.externalSourceImports.listItems(WORKSPACE_ID, harness.importId)).toHaveLength(2);
  });

  it("rolls the whole apply back when Journey evidence cannot commit", async () => {
    const harness = await createHarness();
    const { approvalId } = await createApprovedSnapshotApproval(harness);
    const payload = harness.storage.approvals.get(approvalId)
      .payload as unknown as ExternalSourceKnowledgeSnapshotApprovalPayload;
    const identities = deriveExternalSourceKnowledgeSnapshotMaterializedIdentities(payload);
    const canonical = buildExternalSourceKnowledgeSnapshotJourneyEvent({
      action: "snapshot_created",
      payload,
      approvalId,
      actorId: ACTOR.actorId,
      occurredAt: new Date(NOW_MS).toISOString(),
      materialized: {
        linkId: identities.linkId,
        knowledgeDocumentId: identities.knowledgeDocumentId,
        chunkCount: chunkExternalSourceKnowledgeText(CANARY_TEXT).length,
      },
    });
    harness.storage.db
      .prepare(
        `
        INSERT INTO governance_journey_events (
          schema_version, event_id, idempotency_key, scope_kind, workspace_id, event_type,
          subject_kind, subject_id, action, actor_id, actor_type, session_id, approval_id,
          fingerprint, source_kind, source_id, trust_disposition, poisoning_status,
          evidence_refs_json, provenance_json, summary_json, occurred_at, recorded_at
        ) VALUES (
          @schemaVersion, 'journey-occupied-event', @idempotencyKey, 'workspace', @workspaceId,
          'knowledge_snapshot_lifecycle', 'external_source_knowledge_snapshot', @subjectId, 'snapshot_created',
          'operator-1', 'operator', @sessionId, @approvalId, @fingerprint, 'external_source', @sourceId,
          'approved_snapshot', 'clean', '[]', '{"sourceRequired":true,"approvalRequired":true}',
          '{"conflicting":"material"}', @occurredAt, @occurredAt
        )
      `,
      )
      .run({
        schemaVersion: canonical.schemaVersion,
        idempotencyKey: canonical.idempotencyKey,
        workspaceId: canonical.workspaceId,
        subjectId: canonical.subjectId,
        sessionId: payload.sessionId,
        approvalId,
        fingerprint: canonical.fingerprint,
        sourceId: payload.sourceId,
        occurredAt: canonical.occurredAt,
      });
    const before = harness.countRows();
    await expect(
      harness.service.applyApprovedSnapshot({ workspaceId: WORKSPACE_ID, approvalId }, ACTOR, signal()),
    ).rejects.toThrow();
    expect(harness.countRows()).toEqual(before);
    expect(harness.storage.externalSourceKnowledgeLinks.find(WORKSPACE_ID, identities.linkId)).toBeUndefined();
  });

  it("keeps evidence content-free and never promotes beyond the deterministic knowledge scope", async () => {
    const harness = await createHarness();
    const { approvalId } = await createApprovedSnapshotApproval(harness);
    const before = harness.countRows();
    const applied = await harness.service.applyApprovedSnapshot(
      { workspaceId: WORKSPACE_ID, approvalId, includeThreadAttachment: true },
      ACTOR,
      signal(),
    );

    for (const table of [
      "governance_journey_events",
      "approvals",
      "approval_effects",
      "external_source_knowledge_links",
    ]) {
      const rows = harness.storage.db.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(rows), `${table} must stay content-free`).not.toContain("lobster-matrix-7f3a");
    }
    const chunkBytes = harness.storage.db
      .prepare("SELECT content FROM knowledge_chunks WHERE doc_id = ? ORDER BY seq ASC")
      .all(applied.knowledgeDocumentId) as Array<{ content: string }>;
    expect(chunkBytes.map((row) => row.content).join("")).toContain("lobster-matrix-7f3a");

    const after = harness.countRows();
    expect(after.learned_memory_items).toBe(before.learned_memory_items);
    expect(after.candidate_skill_versions).toBe(before.candidate_skill_versions);
    expect(after.skill_lifecycle).toBe(before.skill_lifecycle);
    expect(after.knowledge_documents).toBe(before.knowledge_documents! + 1);
    expect(after.external_source_knowledge_links).toBe(before.external_source_knowledge_links! + 1);
    expect(after.chat_thread_knowledge_attachments).toBe(before.chat_thread_knowledge_attachments! + 1);
  });

  it("materializes byte-identical deterministic identities and content on independent stores", async () => {
    const [left, right] = [await createHarness(), await createHarness()];
    const results = [] as Array<{
      approvalId: string;
      documentRow: Record<string, unknown>;
      chunkRows: Array<Record<string, unknown>>;
      linkJson: string;
      effectRow: Record<string, unknown>;
      journeyEventIds: string[];
    }>;
    for (const harness of [left, right]) {
      const { approvalId } = await createApprovedSnapshotApproval(harness);
      const applied = await harness.service.applyApprovedSnapshot(
        { workspaceId: WORKSPACE_ID, approvalId, includeThreadAttachment: true },
        ACTOR,
        signal(),
      );
      results.push({
        approvalId,
        documentRow: {
          ...(harness.storage.db
            .prepare(
              "SELECT doc_id, namespace, source_type, source_ref, title, metadata_json, created_at FROM knowledge_documents WHERE doc_id = ?",
            )
            .get(applied.knowledgeDocumentId) as Record<string, unknown>),
        },
        chunkRows: (
          harness.storage.db
            .prepare(
              "SELECT chunk_id, seq, content, token_estimate, created_at FROM knowledge_chunks WHERE doc_id = ? ORDER BY seq ASC",
            )
            .all(applied.knowledgeDocumentId) as Array<Record<string, unknown>>
        ).map((row) => ({ ...row })),
        linkJson: canonicalJsonString(applied.link),
        effectRow: {
          ...(harness.storage.db
            .prepare(
              "SELECT effect_id, approval_id, effect_kind, target_kind, target_id, idempotency_key FROM approval_effects",
            )
            .get() as Record<string, unknown>),
        },
        journeyEventIds: (
          harness.storage.db
            .prepare(
              "SELECT event_id FROM governance_journey_events WHERE event_type = 'knowledge_snapshot_lifecycle' AND subject_id = ? ORDER BY event_id",
            )
            .all(applied.link.linkId) as Array<{ event_id: string }>
        ).map((row) => row.event_id),
      });
    }
    expect(results[0]!.approvalId).toBe(results[1]!.approvalId);
    expect(results[0]!.documentRow).toEqual(results[1]!.documentRow);
    expect(results[0]!.chunkRows).toEqual(results[1]!.chunkRows);
    expect(results[0]!.linkJson).toBe(results[1]!.linkJson);
    expect(results[0]!.effectRow).toEqual(results[1]!.effectRow);
    expect(results[0]!.journeyEventIds).toEqual(results[1]!.journeyEventIds);
    expect(results[0]!.journeyEventIds.length).toBe(2);
  });
});
