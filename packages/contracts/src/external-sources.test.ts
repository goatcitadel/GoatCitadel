import { describe, expect, it } from "vitest";
import {
  EXTERNAL_SOURCE_CURSOR_VERSION,
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  assertExternalSessionAttachment,
  assertExternalSourceCatalogItem,
  assertExternalSourceImportPlan,
  assertExternalSourceImportSettlement,
  assertExternalSourceRecord,
  assertExternalSourceSummary,
  canonicalExternalSourceFilterMaterial,
  isExternalSourceCursorV1,
  normalizeExternalSourceCatalogListInput,
  normalizeExternalSourceCreateInput,
  normalizeExternalSourceImportApplyInput,
  normalizeExternalSourceImportPlanInput,
  normalizeExternalSourceScanInput,
  normalizeExternalSourceUpdateInput,
  projectExternalSourceSummary,
  type ExternalSessionAttachmentRecord,
  type ExternalSourceCatalogItem,
  type ExternalSourceImportPlan,
  type ExternalSourceImportSettlement,
  type ExternalSourceRecord,
} from "./external-sources.js";

const timestamp = "2026-07-14T08:00:00.000Z";
const hash = (value: string): string => value.repeat(64).slice(0, 64);

describe("external source contracts", () => {
  it("accepts an exact request-owned config and rejects adapter, root, Git, and extra-field drift", () => {
    const config = sourceRecord();
    expect(() => assertExternalSourceRecord(config)).not.toThrow();
    expect(() => assertExternalSourceRecord({ ...config, adapterId: "claude.project-jsonl.v1" })).toThrow(
      /kind\/adapter/u,
    );
    expect(() => assertExternalSourceRecord({ ...config, canonicalRootPath: "/" })).toThrow(/filesystem root/u);
    expect(() => assertExternalSourceRecord({ ...config, gitIdentitySha256: hash("b") })).toThrow(/Git identity/u);
    expect(() => assertExternalSourceRecord({ ...config, rawTranscript: "forbidden" } as never)).toThrow(
      /unsupported or missing/u,
    );
  });

  it("enforces content-free catalog hard caps and fixed-width stable paging positions", () => {
    const item = catalogItem();
    expect(() => assertExternalSourceCatalogItem(item)).not.toThrow();
    expect(() =>
      assertExternalSourceCatalogItem({ ...item, rawByteCount: EXTERNAL_SOURCE_LIMITS.sourceFileBytes + 1 }),
    ).toThrow(/hard limit/u);
    expect(() => assertExternalSourceCatalogItem({ ...item, observedMtimeNs: "123" })).toThrow(/20-digit/u);
    expect(Object.keys(item)).not.toContain("content");
    expect(Object.keys(item)).not.toContain("rawBytes");
  });

  it("binds plans to at most 100 unique selected items without silent truncation", () => {
    const plan = importPlan();
    expect(() => assertExternalSourceImportPlan(plan)).not.toThrow();
    expect(() =>
      assertExternalSourceImportPlan({
        ...plan,
        selectedItemIds: Array.from(
          { length: EXTERNAL_SOURCE_LIMITS.selectedItemsPerImport + 1 },
          (_, index) => `item-${index}`,
        ),
      }),
    ).toThrow(/invalid/u);
    expect(() => assertExternalSourceImportPlan({ ...plan, selectedItemIds: ["item-1", "item-1"] })).toThrow(/unique/u);
    expect(() =>
      assertExternalSourceImportPlan({
        ...plan,
        normalizedByteCount: EXTERNAL_SOURCE_LIMITS.normalizedBytesPerImport + 1,
      }),
    ).toThrow(/hard limit/u);
  });

  it("requires verified artifacts for applied settlements and immutable read-only attachment semantics", () => {
    const settlement = importSettlement();
    expect(() => assertExternalSourceImportSettlement(settlement)).not.toThrow();
    expect(() => assertExternalSourceImportSettlement({ ...settlement, artifactsVerifiedAt: undefined })).toThrow(
      /verified artifacts/u,
    );
    expect(() =>
      assertExternalSourceImportSettlement({
        ...settlement,
        disposition: "blocked",
        artifactSetSha256: undefined,
        artifactsVerifiedAt: undefined,
      }),
    ).toThrow(/requires a blocker/u);

    const attachment = externalAttachment();
    expect(() => assertExternalSessionAttachment(attachment)).not.toThrow();
    expect(() => assertExternalSessionAttachment({ ...attachment, mode: "editable" } as never)).toThrow(/mode/u);
    expect(() => assertExternalSessionAttachment({ ...attachment, status: "detached" })).toThrow(/lacks actor/u);
  });

  it("validates a sealed-scan cursor scope and canonical disposition filter", () => {
    const cursor = {
      version: EXTERNAL_SOURCE_CURSOR_VERSION,
      workspaceId: "workspace-1",
      sourceId: "source-1",
      scanId: "scan-1",
      configRevision: 1,
      adapterVersion: "codex-fixture-1",
      filterSha256: hash("a"),
      manifestSha256: hash("b"),
      highWater: { observedMtimeNs: "01720800000000000000", itemId: "item-2" },
      position: { observedMtimeNs: "01720800000000000000", itemId: "item-1" },
    };
    expect(isExternalSourceCursorV1(cursor)).toBe(true);
    expect(isExternalSourceCursorV1({ ...cursor, workspaceId: undefined })).toBe(false);
    expect(canonicalExternalSourceFilterMaterial(["quarantined", "supported", "supported"])).toBe(
      '{"dispositions":["quarantined","supported"]}',
    );
  });

  it("normalizes exact actor-free lifecycle inputs and rejects identity or field smuggling", () => {
    const create = normalizeExternalSourceCreateInput({
      workspaceId: "workspace-1",
      expectedWorkspaceRevision: 1,
      kind: "codex_sessions",
      label: "Synthetic source",
      canonicalRootPath: "/srv/synthetic/codex/sessions",
      pathBridgeSnapshotId: "snapshot-1",
      pathBridgeSnapshotSha256: hash("1"),
      inputFlavor: "windows_native",
      targetFlavor: "windows_native",
      requireGitIdentity: false,
      acceptedProducerVersions: ["v2", "v1"],
    });
    expect(create.acceptedProducerVersions).toEqual(["v1", "v2"]);
    expect(create).not.toHaveProperty("ownerActorId");
    expect(() => normalizeExternalSourceCreateInput({ ...create, ownerActorId: "forged" })).toThrow(
      /unsupported or missing/u,
    );
    expect(() => normalizeExternalSourceCreateInput({ ...create, requireGitIdentity: true })).toThrow(/Git identity/u);
    expect(() => normalizeExternalSourceCreateInput({ ...create, rootGrantApprovalId: "fabricated" })).toThrow(
      /unsupported or missing/u,
    );
    expect(() => normalizeExternalSourceCreateInput({ ...create, ownershipAttestationSha256: hash("9") })).toThrow(
      /unsupported or missing/u,
    );

    expect(
      normalizeExternalSourceUpdateInput({ workspaceId: "workspace-1", status: "disabled", expectedRevision: 1 }),
    ).toEqual({
      workspaceId: "workspace-1",
      status: "disabled",
      expectedRevision: 1,
    });
    expect(() => normalizeExternalSourceUpdateInput({ workspaceId: "workspace-1", expectedRevision: 1 })).toThrow(
      /mutable field/u,
    );
    expect(normalizeExternalSourceScanInput({ workspaceId: "workspace-1", expectedRevision: 2 })).toEqual({
      workspaceId: "workspace-1",
      expectedRevision: 2,
    });
  });

  it("normalizes sealed catalog filters without accepting cursor or disposition scope drift", () => {
    expect(
      normalizeExternalSourceCatalogListInput({
        workspaceId: "workspace-1",
        scanId: "scan-1",
        dispositions: ["supported", "quarantined", "supported"],
        limit: 25,
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      scanId: "scan-1",
      dispositions: ["quarantined", "supported"],
      limit: 25,
    });
    expect(() =>
      normalizeExternalSourceCatalogListInput({ workspaceId: "workspace-1", scanId: "scan-1", limit: 101 }),
    ).toThrow(/limit/u);
    expect(() =>
      normalizeExternalSourceCatalogListInput({
        workspaceId: "workspace-1",
        scanId: "scan-1",
        dispositions: ["supported", "unknown"],
      }),
    ).toThrow(/dispositions/u);
  });

  it("normalizes exact dry-run and retry-safe apply inputs without identity smuggling", () => {
    expect(
      normalizeExternalSourceImportPlanInput({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        scanId: "scan-1",
        selectedItemIds: ["item-2", "item-1"],
        expectedRevision: 3,
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      scanId: "scan-1",
      selectedItemIds: ["item-2", "item-1"],
      expectedRevision: 3,
    });
    expect(() =>
      normalizeExternalSourceImportPlanInput({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        scanId: "scan-1",
        selectedItemIds: ["item-1", "item-1"],
        expectedRevision: 3,
      }),
    ).toThrow(/selection/u);
    expect(
      normalizeExternalSourceImportApplyInput({
        workspaceId: "workspace-1",
        planId: "plan-1",
        expectedPlanSha256: hash("a"),
        idempotencyKey: "external-source-import:v1:fixture",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      planId: "plan-1",
      expectedPlanSha256: hash("a"),
      idempotencyKey: "external-source-import:v1:fixture",
    });
  });

  it("projects content-free list summaries while reserving the exact root for detail", () => {
    const source = sourceRecord();
    const summary = projectExternalSourceSummary(source);
    expect(() => assertExternalSourceSummary(summary)).not.toThrow();
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(source.canonicalRootPath);
    expect(serialized).not.toContain(source.ownerActorId);
    expect(serialized).not.toContain(source.pathBridgeSnapshotId);
    expect(serialized).not.toContain(source.ownershipAttestationSha256);
  });
});

function sourceRecord(): ExternalSourceRecord {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    sourceId: "source-1",
    workspaceId: "workspace-1",
    kind: "codex_sessions",
    label: "Synthetic Codex source",
    ownerActorId: "operator-1",
    authActorId: "operator-1",
    authActorSource: "token",
    canonicalRootPath: "/srv/synthetic/codex/sessions",
    rootIdentitySha256: hash("1"),
    pathBridgeSnapshotId: "path-bridge-1",
    pathBridgeSnapshotSha256: hash("2"),
    allowedRootsSha256: hash("3"),
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    requireGitIdentity: false,
    ownershipAttestationSha256: hash("4"),
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "codex-fixture-1",
    adapterPolicy: {
      unknownVariantDisposition: "block",
      followLinks: false,
      followMarkdownImports: false,
      retainRawBytes: false,
      acceptedProducerVersions: ["codex-synthetic-1"],
    },
    revision: 1,
    configSha256: hash("5"),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function catalogItem(): ExternalSourceCatalogItem {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scanId: "scan-1",
    itemId: "item-1",
    adapterId: "codex.rollout-jsonl.v1",
    adapterVersion: "codex-fixture-1",
    normalizedRelativePath: "sessions/2026/07/14/synthetic.jsonl",
    aliasRelativePaths: [],
    foreignIdSha256: hash("1"),
    producerVersion: "codex-synthetic-1",
    observedMtimeNs: "01720800000000000000",
    fileIdentitySha256: hash("2"),
    statFingerprintSha256: hash("3"),
    rawSha256: hash("4"),
    rawByteCount: 256,
    messageCount: 2,
    lineageNodeCount: 2,
    lineageDepth: 1,
    lineageSha256: hash("5"),
    disposition: "supported",
    reasonCodes: [],
    catalogItemSha256: hash("6"),
  };
}

function importPlan(): ExternalSourceImportPlan {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    planId: "plan-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scanId: "scan-1",
    configRevision: 1,
    configSha256: hash("1"),
    manifestSha256: hash("2"),
    adapterVersions: ["codex-fixture-1"],
    selectedItemIds: ["item-1"],
    selectedItemSetSha256: hash("3"),
    rawSetSha256: hash("4"),
    rawByteCount: 256,
    normalizedSetSha256: hash("5"),
    normalizedByteCount: 128,
    messageCount: 2,
    blockerCodes: [],
    stagingLeaseId: "staging-1",
    stagingExpiresAt: "2026-07-14T08:30:00.000Z",
    planSha256: hash("6"),
    createdAt: timestamp,
  };
}

function importSettlement(): ExternalSourceImportSettlement {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    settlementId: "settlement-1",
    workspaceId: "workspace-1",
    importId: "import-1",
    disposition: "applied",
    artifactSetSha256: hash("1"),
    artifactsVerifiedAt: timestamp,
    blockerCodes: [],
    resultSha256: hash("2"),
    settledAt: timestamp,
  };
}

function externalAttachment(): ExternalSessionAttachmentRecord {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    attachmentId: "attachment-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sourceId: "source-1",
    importId: "import-1",
    itemId: "item-1",
    normalizedArtifactSha256: hash("1"),
    mode: "read_only_external",
    status: "attached",
    revision: 1,
    attachedByActorId: "operator-1",
    attachedAt: timestamp,
  };
}
