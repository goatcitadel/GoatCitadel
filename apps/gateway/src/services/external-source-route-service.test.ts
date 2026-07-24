import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CITADEL_ID,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
  type ExternalSourceCatalogItem,
} from "@goatcitadel/contracts";
import {
  Storage,
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
import { ExternalSourceKnowledgeEffectServiceError } from "./external-source-knowledge-effect-service.js";
import {
  ExternalSourceRouteService,
  buildExternalSourceKnowledgeSnapshotWardAction,
  createExternalSourceRouteService,
} from "./external-source-route-service.js";
import type { ExternalSourcePathVerifierPort } from "./external-source-service.js";

const WORKSPACE_ID = "default";
const SESSION_ID = "session-1";
const TS = "2026-07-14T08:00:00.000Z";
const ACTOR = { actorId: "operator-1", source: "token" as const };
const CANARY_TEXT = "external canary bytes: lobster-matrix-7f3a must never enter evidence records";

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

const stubPathVerifier: ExternalSourcePathVerifierPort = {
  resolve: async () => {
    throw new Error("Path verification is not exercised by this suite.");
  },
};

interface Harness {
  storage: Storage;
  service: ExternalSourceRouteService;
  sourceId: string;
  importId: string;
  itemIds: string[];
  artifactShas: string[];
  sessionIncarnationId: string;
  countRows: (table: string) => number;
}

/**
 * Seeds the immutable C1 evidence chain (verified path snapshot, active
 * source, sealed scan, applied import with published managed artifacts, live
 * chat session) directly through the storage owners, then composes the REAL
 * production factory (`createExternalSourceRouteService`) over the same
 * storage — the exact composition `gateway-service.buildRouteServices` uses.
 */
async function createHarness(): Promise<Harness> {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  cleanups.push(() => storage.close());
  const managedRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-hx407-route-service-"));
  cleanups.push(() => fs.rmSync(managedRootDir, { recursive: true, force: true }));
  const artifacts = new ExternalSourceArtifactStore(path.join(managedRootDir, "artifacts"));

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

  const bodies = [CANARY_TEXT, "second external artifact body with distinct bytes"].map((text) =>
    Buffer.from(text, "utf8"),
  );
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

  const service = createExternalSourceRouteService(storage, stubPathVerifier, managedRootDir);
  const countRows = (table: string) =>
    Number((storage.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  return {
    storage,
    service,
    sourceId,
    importId,
    itemIds: catalogItems.map((item) => item.itemId),
    artifactShas,
    sessionIncarnationId,
    countRows,
  };
}

function attachInput(harness: Harness, itemId = "item-1") {
  return {
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    expectedSessionIncarnationId: harness.sessionIncarnationId,
    sourceId: harness.sourceId,
    importId: harness.importId,
    itemId,
  };
}

describe("HX-407 C4 external source route-service composition", () => {
  it("composes attach, durable incarnation-bearing reload, exact-byte reads, and CAS detach over the production factory", async () => {
    const harness = await createHarness();
    expect(harness.service.supportsChatAttachments()).toBe(true);

    const empty = harness.service.listSessionAttachments({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID }, ACTOR);
    expect(empty.items).toEqual([]);
    // The durable reload surface carries the exact incarnation the mutation
    // contracts demand — the C4b client consumes this value.
    expect(empty.sessionIncarnationId).toBe(harness.sessionIncarnationId);

    const attached = await harness.service.attachToSession(attachInput(harness), ACTOR, signal());
    expect(attached.disposition).toBe("created");
    expect(attached.attachment).toMatchObject({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      itemId: "item-1",
      mode: "read_only_external",
      status: "attached",
      revision: 1,
      normalizedArtifactSha256: harness.artifactShas[0],
    });

    const listed = harness.service.listSessionAttachments({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID }, ACTOR);
    expect(listed.items).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("lobster-matrix-7f3a");

    const read = await harness.service.readAttachedExternalContext(
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, attachmentId: attached.attachment.attachmentId },
      signal(),
    );
    expect(read.bytes.toString("utf8")).toBe(CANARY_TEXT);
    expect(read.provenance).toMatchObject({
      sourceId: harness.sourceId,
      importId: harness.importId,
      itemId: "item-1",
      attachmentId: attached.attachment.attachmentId,
      attachmentRevision: 1,
      normalizedArtifactSha256: harness.artifactShas[0],
    });

    const detachInput = {
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      attachmentId: attached.attachment.attachmentId,
      expectedRevision: 1,
      expectedSessionIncarnationId: harness.sessionIncarnationId,
    };
    await expect(
      harness.service.detachFromSession({ ...detachInput, expectedRevision: 5 }, ACTOR, signal()),
    ).rejects.toMatchObject({ code: "conflict" });
    const detached = await harness.service.detachFromSession(detachInput, ACTOR, signal());
    expect(detached.disposition).toBe("detached");
    expect(detached.attachment.status).toBe("detached");
    const replayedDetach = await harness.service.detachFromSession(detachInput, ACTOR, signal());
    expect(replayedDetach.disposition).toBe("replayed");
  });

  it("creates the real deterministic approval with exactly one composed inbox created event and applies the approved snapshot", async () => {
    const harness = await createHarness();
    const attached = await harness.service.attachToSession(attachInput(harness), ACTOR, signal());
    const requestInput = {
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      expectedSessionIncarnationId: harness.sessionIncarnationId,
      attachmentId: attached.attachment.attachmentId,
      importId: harness.importId,
      itemId: "item-1",
      expectedAttachmentRevision: 1,
    };

    const receipt = await harness.service.createKnowledgeSnapshotRequest(requestInput, ACTOR, signal());
    expect(receipt.disposition).toBe("created");
    expect(receipt.status).toBe("pending");
    expect(receipt.approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(typeof receipt.expiresAt).toBe("string");
    expect(receipt.preview).toMatchObject({ importId: harness.importId, itemId: "item-1" });
    expect(JSON.stringify(receipt)).not.toContain("lobster-matrix-7f3a");

    const approval = harness.storage.approvals.get(receipt.approvalId);
    expect(approval.kind).toBe("external_source.knowledge_snapshot");
    expect(approval.linkage).toMatchObject({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      authActorId: ACTOR.actorId,
      authActorSource: ACTOR.source,
    });
    const createdEvents = () =>
      harness.storage.approvalEvents
        .listByApprovalId(receipt.approvalId)
        .filter((event) => event.eventType === "created");
    expect(createdEvents()).toHaveLength(1);

    // Exact replay converges on the stored approval and appends no second
    // inbox created event.
    const replayed = await harness.service.createKnowledgeSnapshotRequest(requestInput, ACTOR, signal());
    expect(replayed.disposition).toBe("replayed");
    expect(replayed.approvalId).toBe(receipt.approvalId);
    expect(createdEvents()).toHaveLength(1);

    harness.storage.approvals.resolve(receipt.approvalId, { decision: "approve", resolvedBy: ACTOR.actorId });
    const applied = await harness.service.applyApprovedKnowledgeSnapshot(
      { workspaceId: WORKSPACE_ID, approvalId: receipt.approvalId },
      ACTOR,
      signal(),
    );
    expect(applied.disposition).toBe("created");
    expect(applied.chunkCount).toBeGreaterThan(0);
    expect(harness.countRows("external_source_knowledge_links")).toBe(1);
    expect(harness.countRows("knowledge_documents")).toBe(1);
    expect(
      harness.storage.db.prepare("SELECT status, effect_kind, target_kind FROM approval_effects").all() as Array<
        Record<string, unknown>
      >,
    ).toEqual([
      {
        status: "completed",
        effect_kind: "external_source_knowledge_snapshot_apply",
        target_kind: "external_source_import_item",
      },
    ]);
  });

  it("re-evaluates deny-wins Citadel Wards inside the apply and fails closed on a policy flip", async () => {
    const harness = await createHarness();
    const attached = await harness.service.attachToSession(attachInput(harness), ACTOR, signal());
    const receipt = await harness.service.createKnowledgeSnapshotRequest(
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
    harness.storage.approvals.resolve(receipt.approvalId, { decision: "approve", resolvedBy: ACTOR.actorId });

    // Policy flip AFTER approval: a deny ward lands on the workspace's citadel
    // through the same workspace→citadel chain the tool-invoke path uses.
    const citadelId = harness.storage.workspaces?.find(WORKSPACE_ID)?.citadelId ?? DEFAULT_CITADEL_ID;
    expect(buildExternalSourceKnowledgeSnapshotWardAction(harness.sourceId)).toBe(
      `external_source.knowledge_snapshot.${harness.sourceId}`,
    );
    const ward = harness.storage.citadels.addWard({
      citadelId,
      name: "Block external knowledge snapshots",
      actionPattern: "external_source.knowledge_snapshot.*",
      effect: "deny",
    });
    const before = harness.countRows("external_source_knowledge_links");
    const denied = await harness.service
      .applyApprovedKnowledgeSnapshot({ workspaceId: WORKSPACE_ID, approvalId: receipt.approvalId }, ACTOR, signal())
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(denied).toBeInstanceOf(ExternalSourceKnowledgeEffectServiceError);
    expect(denied).toMatchObject({ code: "policy_denied", reasonCode: "ward_deny" });
    expect(harness.countRows("external_source_knowledge_links")).toBe(before);
    expect(harness.countRows("knowledge_documents")).toBe(0);

    // Non-allow ward effects that cannot be satisfied at this boundary also
    // fail closed (require_approval cannot be satisfied by the already-spent
    // dedicated approval).
    harness.storage.citadels.removeWard(citadelId, ward.wardId);
    const requireApproval = harness.storage.citadels.addWard({
      citadelId,
      name: "Escalate external knowledge snapshots",
      actionPattern: "external_source.*",
      effect: "require_approval",
    });
    await expect(
      harness.service.applyApprovedKnowledgeSnapshot(
        { workspaceId: WORKSPACE_ID, approvalId: receipt.approvalId },
        ACTOR,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "policy_denied", reasonCode: "ward_require_approval" });

    // Clearing the ward restores the allow path and the apply materializes.
    harness.storage.citadels.removeWard(citadelId, requireApproval.wardId);
    const applied = await harness.service.applyApprovedKnowledgeSnapshot(
      { workspaceId: WORKSPACE_ID, approvalId: receipt.approvalId },
      ACTOR,
      signal(),
    );
    expect(applied.disposition).toBe("created");
    expect(harness.countRows("external_source_knowledge_links")).toBe(1);
  });

  it("keeps the chat composition dark when the managed root is not composed", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
    cleanups.push(() => storage.close());
    const service = createExternalSourceRouteService(storage, stubPathVerifier);
    expect(service.supportsChatAttachments()).toBe(false);
    expect(() => service.listSessionAttachments({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID }, ACTOR)).toThrow(
      /not composed/u,
    );
  });
});
