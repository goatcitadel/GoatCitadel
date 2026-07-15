import { describe, expect, it } from "vitest";
import { EXTERNAL_SOURCE_SCHEMA_VERSION, isGovernanceJourneyEventRecord } from "@goatcitadel/contracts";
import {
  computeExternalSourceArtifactSetSha256,
  computeExternalSourceNormalizedSetSha256,
  computeExternalSourceRawSetSha256,
  computeExternalSourceSelectedItemSetSha256,
  deriveExternalSourceImportIdempotencyKey,
  sealExternalSourceImportIntent,
  sealExternalSourceImportItem,
  sealExternalSourceImportPlan,
  sealExternalSourceImportSettlement,
} from "@goatcitadel/storage";
import {
  buildExternalSourceDryRunJourneyEvent,
  buildExternalSourceSettlementJourneyEvent,
} from "./external-source-journey-producer.js";

describe("external source Journey producer", () => {
  it("produces deterministic content-free source evidence for dry-run and settlement", () => {
    const fixture = buildFixture();
    const dryRun = buildExternalSourceDryRunJourneyEvent({ plan: fixture.plan, actorId: "operator-1" });
    const imported = buildExternalSourceSettlementJourneyEvent({
      plan: fixture.plan,
      intent: fixture.intent,
      settlement: fixture.settlement,
      items: [fixture.item],
    });

    expect(isGovernanceJourneyEventRecord(dryRun)).toBe(true);
    expect(isGovernanceJourneyEventRecord(imported)).toBe(true);
    expect(dryRun.evidenceRefs).toEqual([{ owner: "external_source", refId: fixture.plan.planId }]);
    expect(imported).toMatchObject({
      action: "imported_read_only",
      actorId: "operator-1",
      sourceKind: "external_source",
      sourceId: fixture.plan.sourceId,
      provenance: { sourceRequired: true, approvalRequired: false },
    });
    expect(
      buildExternalSourceSettlementJourneyEvent({
        plan: fixture.plan,
        intent: fixture.intent,
        settlement: fixture.settlement,
        items: [fixture.item],
      }),
    ).toEqual(imported);
    expect(JSON.stringify({ dryRun, imported })).not.toContain("private transcript text");

    const { planSha256: _planSha256, ...duplicateDraft } = fixture.plan;
    const duplicate = sealExternalSourceImportPlan({
      ...duplicateDraft,
      planId: "plan-2",
      stagingLeaseId: "stage-2",
    });
    const duplicateDryRun = buildExternalSourceDryRunJourneyEvent({ plan: duplicate, actorId: "operator-1" });
    expect(duplicateDryRun.fingerprint).toBe(dryRun.fingerprint);
    expect(duplicateDryRun.idempotencyKey).not.toBe(dryRun.idempotencyKey);
    expect(duplicateDryRun.eventId).not.toBe(dryRun.eventId);

    const duplicateImport = rebindImport(duplicate, fixture, "import-2", "2026-07-14T08:10:00.000Z");
    const duplicateImported = buildExternalSourceSettlementJourneyEvent({
      plan: duplicate,
      intent: duplicateImport.intent,
      settlement: duplicateImport.settlement,
      items: [duplicateImport.item],
    });
    expect(duplicateImported.fingerprint).toBe(imported.fingerprint);
    expect(duplicateImported.idempotencyKey).not.toBe(imported.idempotencyKey);
    expect(duplicateImported.eventId).not.toBe(imported.eventId);

    const policyDrift = sealExternalSourceImportPlan({
      ...duplicateDraft,
      planId: "plan-policy-drift",
      configSha256: "f".repeat(64),
      stagingLeaseId: "stage-policy-drift",
    });
    const manifestDrift = sealExternalSourceImportPlan({
      ...duplicateDraft,
      planId: "plan-manifest-drift",
      manifestSha256: "9".repeat(64),
      stagingLeaseId: "stage-manifest-drift",
    });
    expect(buildExternalSourceDryRunJourneyEvent({ plan: policyDrift, actorId: "operator-1" }).fingerprint).not.toBe(
      dryRun.fingerprint,
    );
    expect(buildExternalSourceDryRunJourneyEvent({ plan: manifestDrift, actorId: "operator-1" }).fingerprint).not.toBe(
      dryRun.fingerprint,
    );
    for (const [driftPlan, importId] of [
      [policyDrift, "import-policy-drift"],
      [manifestDrift, "import-manifest-drift"],
    ] as const) {
      const driftImport = rebindImport(driftPlan, fixture, importId, "2026-07-14T08:15:00.000Z");
      const driftEvent = buildExternalSourceSettlementJourneyEvent({
        plan: driftPlan,
        intent: driftImport.intent,
        settlement: driftImport.settlement,
        items: [driftImport.item],
      });
      expect(driftEvent.fingerprint).not.toBe(imported.fingerprint);
    }

    const { resultSha256: _resultSha256, ...laterSettlementDraft } = fixture.settlement;
    const laterSettlement = sealExternalSourceImportSettlement(
      {
        ...laterSettlementDraft,
        artifactsVerifiedAt: "2026-07-14T08:20:00.000Z",
        settledAt: "2026-07-14T08:20:00.000Z",
      },
      [fixture.item],
    );
    const laterImported = buildExternalSourceSettlementJourneyEvent({
      plan: fixture.plan,
      intent: fixture.intent,
      settlement: laterSettlement,
      items: [fixture.item],
    });
    expect(laterImported.fingerprint).toBe(imported.fingerprint);
    expect(laterImported.idempotencyKey).toBe(imported.idempotencyKey);
    expect(laterImported.eventId).not.toBe(imported.eventId);
  });
});

function buildFixture() {
  const normalizedArtifactSha256 = "e".repeat(64);
  const raw = { itemId: "item-1", rawSha256: "d".repeat(64), rawByteCount: 32 };
  const normalized = { itemId: raw.itemId, normalizedArtifactSha256, normalizedByteCount: 64 };
  const plan = sealExternalSourceImportPlan({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    planId: "plan-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scanId: "scan-1",
    configRevision: 1,
    configSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    adapterVersions: ["1.0.0"],
    selectedItemIds: [raw.itemId],
    selectedItemSetSha256: computeExternalSourceSelectedItemSetSha256([raw.itemId]),
    rawSetSha256: computeExternalSourceRawSetSha256([raw]),
    rawByteCount: raw.rawByteCount,
    normalizedSetSha256: computeExternalSourceNormalizedSetSha256([normalized]),
    normalizedByteCount: normalized.normalizedByteCount,
    messageCount: 1,
    blockerCodes: [],
    stagingLeaseId: "stage-1",
    stagingExpiresAt: "2026-07-14T08:30:00.000Z",
    createdAt: "2026-07-14T08:00:00.000Z",
  });
  const intent = sealExternalSourceImportIntent({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    importId: "import-1",
    idempotencyKey: deriveExternalSourceImportIdempotencyKey(plan),
    workspaceId: plan.workspaceId,
    sourceId: plan.sourceId,
    scanId: plan.scanId,
    planId: plan.planId,
    configRevision: plan.configRevision,
    configSha256: plan.configSha256,
    manifestSha256: plan.manifestSha256,
    planSha256: plan.planSha256,
    selectedItemSetSha256: plan.selectedItemSetSha256,
    adapterVersions: plan.adapterVersions,
    requestedByActorId: "operator-1",
    admittedAt: "2026-07-14T08:05:00.000Z",
  });
  const item = sealExternalSourceImportItem({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    workspaceId: intent.workspaceId,
    importId: intent.importId,
    scanId: intent.scanId,
    itemId: raw.itemId,
    ordinal: 0,
    adapterId: "codex.memory-markdown.v1",
    adapterVersion: "1.0.0",
    producerVersion: "unversioned-markdown.v1",
    rawSha256: raw.rawSha256,
    rawByteCount: raw.rawByteCount,
    normalizedArtifactSha256,
    normalizedByteCount: normalized.normalizedByteCount,
    artifactRelativeKey: `external-sources/sha256/${normalizedArtifactSha256}`,
    createdAt: intent.admittedAt,
  });
  const settlement = sealExternalSourceImportSettlement(
    {
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      settlementId: "settlement-1",
      workspaceId: intent.workspaceId,
      importId: intent.importId,
      disposition: "applied",
      artifactSetSha256: computeExternalSourceArtifactSetSha256([item]),
      artifactsVerifiedAt: intent.admittedAt,
      blockerCodes: [],
      settledAt: intent.admittedAt,
    },
    [item],
  );
  return { plan, intent, item, settlement };
}

function rebindImport(
  plan: ReturnType<typeof sealExternalSourceImportPlan>,
  fixture: ReturnType<typeof buildFixture>,
  importId: string,
  occurredAt: string,
) {
  const intent = sealExternalSourceImportIntent({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    importId,
    idempotencyKey: deriveExternalSourceImportIdempotencyKey(plan),
    workspaceId: plan.workspaceId,
    sourceId: plan.sourceId,
    scanId: plan.scanId,
    planId: plan.planId,
    configRevision: plan.configRevision,
    configSha256: plan.configSha256,
    manifestSha256: plan.manifestSha256,
    planSha256: plan.planSha256,
    selectedItemSetSha256: plan.selectedItemSetSha256,
    adapterVersions: plan.adapterVersions,
    requestedByActorId: fixture.intent.requestedByActorId,
    admittedAt: occurredAt,
  });
  const { provenanceSha256: _provenanceSha256, ...itemDraft } = fixture.item;
  const item = sealExternalSourceImportItem({
    ...itemDraft,
    workspaceId: plan.workspaceId,
    importId,
    scanId: plan.scanId,
    createdAt: occurredAt,
  });
  const settlement = sealExternalSourceImportSettlement(
    {
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      settlementId: `settlement-${importId}`,
      workspaceId: plan.workspaceId,
      importId,
      disposition: "applied",
      artifactSetSha256: computeExternalSourceArtifactSetSha256([item]),
      artifactsVerifiedAt: occurredAt,
      blockerCodes: [],
      settledAt: occurredAt,
    },
    [item],
  );
  return { intent, item, settlement };
}
