import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  type ExternalSourceCatalogItem,
  type ExternalSourceImportIntent,
  type ExternalSourceImportItem,
  type ExternalSourceImportPlan,
  type ExternalSourceImportSettlement,
  type ExternalSourceRecord,
} from "@goatcitadel/contracts";
import { sealExternalSourceImportIntent } from "@goatcitadel/storage";
import { ExternalSourceImportService } from "./external-source-import-service.js";
import { ExternalSourcePlanStagingStoreError } from "./external-source-plan-staging-store.js";

const NOW = Date.parse("2026-07-14T08:00:00.000Z");
const ACTOR = { actorId: "operator-1", source: "token" as const };

describe("ExternalSourceImportService", () => {
  it("reads selected foreign bytes once during dry run and applies only durable staged bytes", async () => {
    const harness = createHarness();
    const planResponse = await harness.service.createPlan(
      {
        workspaceId: harness.source.workspaceId,
        sourceId: harness.source.sourceId,
        scanId: harness.scan.scanId,
        selectedItemIds: [harness.catalog.itemId],
        expectedRevision: harness.source.revision,
      },
      ACTOR,
      signal(),
    );

    expect(harness.reader.readFiles).toHaveBeenCalledTimes(1);
    expect(harness.imports.createPlanWithJourney).toHaveBeenCalledTimes(1);
    expect(harness.staging.stage).toHaveBeenCalledTimes(1);
    const dryRunJourney = harness.imports.createPlanWithJourney.mock.calls[0]![1];
    expect(dryRunJourney).toMatchObject({
      eventType: "external_session_import",
      action: "dry_run_completed",
      actorId: ACTOR.actorId,
      evidenceRefs: [{ owner: "external_source", refId: planResponse.plan.planId }],
    });

    const applied = await harness.service.apply(
      {
        workspaceId: planResponse.plan.workspaceId,
        planId: planResponse.plan.planId,
        expectedPlanSha256: planResponse.plan.planSha256,
        idempotencyKey: planResponse.idempotencyKey,
      },
      ACTOR,
      signal(),
    );
    expect(harness.reader.readFiles).toHaveBeenCalledTimes(1);
    expect(harness.artifacts.publish).toHaveBeenCalledTimes(1);
    expect(harness.artifacts.read).toHaveBeenCalledTimes(1);
    expect(applied.applyDisposition).toBe("created");
    expect(applied.settlement).toMatchObject({ disposition: "applied", blockerCodes: [] });
    expect(harness.imports.settleWithJourney).toHaveBeenCalledTimes(1);
    expect(harness.imports.settleWithJourney.mock.calls[0]![2]).toMatchObject({
      action: "imported_read_only",
      actorId: ACTOR.actorId,
      provenance: { sourceRequired: true, approvalRequired: false },
    });

    const replay = await harness.service.apply(
      {
        workspaceId: planResponse.plan.workspaceId,
        planId: planResponse.plan.planId,
        expectedPlanSha256: planResponse.plan.planSha256,
        idempotencyKey: planResponse.idempotencyKey,
      },
      ACTOR,
      signal(),
    );
    expect(replay).toEqual({ ...applied, applyDisposition: "replayed" });
    expect(harness.reader.readFiles).toHaveBeenCalledTimes(1);
    expect(harness.imports.settleWithJourney).toHaveBeenCalledTimes(1);
  });

  it("gives duplicate identical dry runs distinct immutable plans and Journey identities", async () => {
    const harness = createHarness();
    const input = {
      workspaceId: harness.source.workspaceId,
      sourceId: harness.source.sourceId,
      scanId: harness.scan.scanId,
      selectedItemIds: [harness.catalog.itemId],
      expectedRevision: harness.source.revision,
    };

    const first = await harness.service.createPlan(input, ACTOR, signal());
    const second = await harness.service.createPlan(input, ACTOR, signal());

    expect(second.plan.planId).not.toBe(first.plan.planId);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    const [firstJourney, secondJourney] = harness.imports.createPlanWithJourney.mock.calls.map((call) => call[1]);
    expect(secondJourney.fingerprint).toBe(firstJourney.fingerprint);
    expect(secondJourney.idempotencyKey).not.toBe(firstJourney.idempotencyKey);
    expect(harness.reader.readFiles).toHaveBeenCalledTimes(2);
  });

  it("converges when one apply commits and discards staging after a concurrent apply's initial check", async () => {
    const harness = createHarness();
    const planned = await harness.service.createPlan(
      {
        workspaceId: harness.source.workspaceId,
        sourceId: harness.source.sourceId,
        scanId: harness.scan.scanId,
        selectedItemIds: [harness.catalog.itemId],
        expectedRevision: harness.source.revision,
      },
      ACTOR,
      signal(),
    );
    const request = {
      workspaceId: planned.plan.workspaceId,
      planId: planned.plan.planId,
      expectedPlanSha256: planned.plan.planSha256,
      idempotencyKey: planned.idempotencyKey,
    };
    const winner = await harness.service.apply(request, ACTOR, signal());
    harness.imports.findSettlement.mockReturnValueOnce(undefined);
    harness.staging.read.mockRejectedValueOnce(new ExternalSourcePlanStagingStoreError("missing"));

    const concurrent = await harness.service.apply(request, ACTOR, signal());

    expect(concurrent).toEqual({ ...winner, applyDisposition: "replayed" });
    expect(harness.imports.settleWithJourney).toHaveBeenCalledTimes(1);
    expect(harness.reader.readFiles).toHaveBeenCalledTimes(1);
  });

  it("returns exact durable replay after source revoke and workspace archive", async () => {
    const harness = createHarness();
    const planned = await harness.service.createPlan(
      {
        workspaceId: harness.source.workspaceId,
        sourceId: harness.source.sourceId,
        scanId: harness.scan.scanId,
        selectedItemIds: [harness.catalog.itemId],
        expectedRevision: harness.source.revision,
      },
      ACTOR,
      signal(),
    );
    const request = {
      workspaceId: planned.plan.workspaceId,
      planId: planned.plan.planId,
      expectedPlanSha256: planned.plan.planSha256,
      idempotencyKey: planned.idempotencyKey,
    };
    const applied = await harness.service.apply(request, ACTOR, signal());
    harness.source.status = "revoked";
    harness.workspace.setLifecycle("archived");

    const replay = await harness.service.apply(request, ACTOR, signal());

    expect(replay).toEqual({ ...applied, applyDisposition: "replayed" });
    expect(harness.imports.claimIntent).toHaveBeenCalledTimes(1);
    expect(harness.imports.settleWithJourney).toHaveBeenCalledTimes(1);
  });

  it("returns the first terminal winner when a staged applied attempt settles later", async () => {
    const harness = createHarness();
    const planned = await harness.service.createPlan(
      {
        workspaceId: harness.source.workspaceId,
        sourceId: harness.source.sourceId,
        scanId: harness.scan.scanId,
        selectedItemIds: [harness.catalog.itemId],
        expectedRevision: harness.source.revision,
      },
      ACTOR,
      signal(),
    );
    const request = {
      workspaceId: planned.plan.workspaceId,
      planId: planned.plan.planId,
      expectedPlanSha256: planned.plan.planSha256,
      idempotencyKey: planned.idempotencyKey,
    };
    const stagedLease = await harness.staging.read();
    harness.staging.read.mockRejectedValueOnce(new ExternalSourcePlanStagingStoreError("tampered"));
    const terminal = await harness.service.apply(request, ACTOR, signal());
    expect(terminal.settlement).toMatchObject({
      disposition: "manual_reconciliation",
      blockerCodes: ["staging_tampered"],
    });

    harness.imports.findSettlement.mockReturnValueOnce(undefined);
    harness.staging.read.mockResolvedValueOnce(stagedLease);
    const appliedLoser = await harness.service.apply(request, ACTOR, signal());

    expect(appliedLoser).toEqual({ ...terminal, applyDisposition: "replayed" });
    expect(harness.imports.settleWithJourney).toHaveBeenCalledTimes(2);
    expect(harness.artifacts.publish).toHaveBeenCalledTimes(1);
  });

  it("records the actual recovery verification time and preserves it on replay", async () => {
    const harness = createHarness();
    const planned = await harness.service.createPlan(
      {
        workspaceId: harness.source.workspaceId,
        sourceId: harness.source.sourceId,
        scanId: harness.scan.scanId,
        selectedItemIds: [harness.catalog.itemId],
        expectedRevision: harness.source.revision,
      },
      ACTOR,
      signal(),
    );
    const intent = recoveryIntent(planned.plan, planned.idempotencyKey, "external-import-recovery-applied");
    harness.imports.claimIntent(intent);
    const recoveredAt = NOW + 10 * 60_000;
    harness.clock.setNowMs(recoveredAt);

    await expect(harness.service.recover(signal())).resolves.toEqual({
      examined: 1,
      applied: 1,
      terminalBlocked: 0,
      retryableFailures: 0,
      cleanedExpiredLeases: 0,
    });
    const settlement = harness.imports.findSettlement(intent.workspaceId, intent.importId);
    expect(settlement).toMatchObject({
      disposition: "applied",
      artifactsVerifiedAt: new Date(recoveredAt).toISOString(),
      settledAt: new Date(recoveredAt).toISOString(),
    });
    await expect(harness.service.recover(signal())).resolves.toMatchObject({ examined: 0, applied: 0 });
    expect(harness.imports.findSettlement(intent.workspaceId, intent.importId)).toEqual(settlement);
    expect(harness.reader.readFiles).toHaveBeenCalledTimes(1);
  });

  it("recovers admitted unsettled intents without a foreign reread and terminally reconciles missing staging", async () => {
    const harness = createHarness();
    const planned = await harness.service.createPlan(
      {
        workspaceId: harness.source.workspaceId,
        sourceId: harness.source.sourceId,
        scanId: harness.scan.scanId,
        selectedItemIds: [harness.catalog.itemId],
        expectedRevision: harness.source.revision,
      },
      ACTOR,
      signal(),
    );
    const intent = recoveryIntent(planned.plan, planned.idempotencyKey, "external-import-recovery-missing");
    harness.imports.claimIntent(intent);
    harness.staging.read.mockRejectedValueOnce(new ExternalSourcePlanStagingStoreError("missing"));

    await expect(harness.service.recover(signal())).resolves.toEqual({
      examined: 1,
      applied: 0,
      terminalBlocked: 1,
      retryableFailures: 0,
      cleanedExpiredLeases: 0,
    });
    expect(harness.reader.readFiles).toHaveBeenCalledTimes(1);
    expect(harness.imports.settleWithJourney).toHaveBeenCalledTimes(1);
    expect(harness.imports.settleWithJourney.mock.calls[0]![0]).toMatchObject({
      disposition: "manual_reconciliation",
      blockerCodes: ["staging_missing"],
    });
  });

  it("terminally reconciles immutable staged/catalog binding drift", async () => {
    const harness = createHarness();
    const planned = await harness.service.createPlan(
      {
        workspaceId: harness.source.workspaceId,
        sourceId: harness.source.sourceId,
        scanId: harness.scan.scanId,
        selectedItemIds: [harness.catalog.itemId],
        expectedRevision: harness.source.revision,
      },
      ACTOR,
      signal(),
    );
    harness.catalog.rawSha256 = "f".repeat(64);

    const result = await harness.service.apply(
      {
        workspaceId: planned.plan.workspaceId,
        planId: planned.plan.planId,
        expectedPlanSha256: planned.plan.planSha256,
        idempotencyKey: planned.idempotencyKey,
      },
      ACTOR,
      signal(),
    );

    expect(result.settlement).toMatchObject({
      disposition: "manual_reconciliation",
      blockerCodes: ["staging_binding_conflict"],
    });
    expect(harness.artifacts.publish).not.toHaveBeenCalled();
  });

  it("terminally reconciles catalog disposition drift before artifact publication", async () => {
    const harness = createHarness();
    const planned = await harness.service.createPlan(
      {
        workspaceId: harness.source.workspaceId,
        sourceId: harness.source.sourceId,
        scanId: harness.scan.scanId,
        selectedItemIds: [harness.catalog.itemId],
        expectedRevision: harness.source.revision,
      },
      ACTOR,
      signal(),
    );
    harness.catalog.disposition = "quarantined";
    harness.catalog.reasonCodes = ["catalog_policy_changed"];

    const result = await harness.service.apply(
      {
        workspaceId: planned.plan.workspaceId,
        planId: planned.plan.planId,
        expectedPlanSha256: planned.plan.planSha256,
        idempotencyKey: planned.idempotencyKey,
      },
      ACTOR,
      signal(),
    );

    expect(result.settlement).toMatchObject({
      disposition: "manual_reconciliation",
      blockerCodes: ["staging_binding_conflict"],
    });
    expect(harness.artifacts.publish).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const source = sourceRecord();
  const scan = {
    workspaceId: source.workspaceId,
    sourceId: source.sourceId,
    scanId: "scan-1",
    configRevision: source.revision,
    configSha256: source.configSha256,
    manifestSha256: "6".repeat(64),
    adapterId: source.adapterId,
    adapterVersion: source.adapterVersion,
    status: "sealed" as const,
  };
  const rawBytes = new Uint8Array(Buffer.from("foreign bytes are read once", "utf8"));
  const catalog = catalogItem(source, scan.scanId, rawBytes);
  const normalizedBytes = new Uint8Array(Buffer.from("normalized private artifact", "utf8"));
  const normalizedArtifactSha256 = sha256(normalizedBytes);
  const plans = new Map<string, ExternalSourceImportPlan>();
  const intents = new Map<string, ExternalSourceImportIntent>();
  const settlements = new Map<string, ExternalSourceImportSettlement>();
  const items = new Map<string, ExternalSourceImportItem[]>();
  const journeyEvents = new Map<string, unknown>();
  let nowMs = NOW;
  let workspaceLifecycle = "active";
  let planSequence = 0;
  let importSequence = 0;
  let stagingSequence = 0;
  let staged:
    | {
        plan: ExternalSourceImportPlan;
        items: Array<Record<string, unknown> & { normalizedBytes: Uint8Array }>;
      }
    | undefined;

  const imports = {
    createPlanWithJourney: vi.fn((plan: ExternalSourceImportPlan, journeyEvent: { idempotencyKey: string }) => {
      const replay = journeyEvents.get(journeyEvent.idempotencyKey);
      if (replay && JSON.stringify(replay) !== JSON.stringify(journeyEvent)) {
        throw new Error("Journey idempotency conflict");
      }
      journeyEvents.set(journeyEvent.idempotencyKey, journeyEvent);
      plans.set(plan.planId, plan);
      return { plan, journeyEvent };
    }),
    getPlan: vi.fn((_workspaceId: string, planId: string) => plans.get(planId)!),
    findIntentByIdempotencyKey: vi.fn((_workspaceId: string, key: string) =>
      [...intents.values()].find((intent) => intent.idempotencyKey === key),
    ),
    claimIntent: vi.fn((intent: ExternalSourceImportIntent) => {
      const replay = [...intents.values()].find((candidate) => candidate.idempotencyKey === intent.idempotencyKey);
      if (replay) return replay;
      intents.set(intent.importId, intent);
      return intent;
    }),
    getIntent: vi.fn((_workspaceId: string, importId: string) => intents.get(importId)!),
    findSettlement: vi.fn((_workspaceId: string, importId: string) => settlements.get(importId)),
    listItems: vi.fn((_workspaceId: string, importId: string) => items.get(importId) ?? []),
    listUnsettledIntents: vi.fn(() => [...intents.values()].filter((intent) => !settlements.has(intent.importId))),
    settleWithJourney: vi.fn(
      (
        settlement: ExternalSourceImportSettlement,
        importedItems: ExternalSourceImportItem[],
        journeyEvent: unknown,
      ) => {
        const existing = settlements.get(settlement.importId);
        if (existing && existing.resultSha256 !== settlement.resultSha256) {
          const error = new Error("terminal outcome conflict") as Error & { code: string };
          error.code = "STATE_CONFLICT";
          throw error;
        }
        if (existing) return { settlement: existing, journeyEvent };
        settlements.set(settlement.importId, settlement);
        items.set(settlement.importId, importedItems);
        return { settlement, journeyEvent };
      },
    ),
  };
  const reader = {
    enumerate: vi.fn(),
    readFile: vi.fn(),
    readFiles: vi.fn(async () => [
      {
        relativePath: catalog.normalizedRelativePath,
        byteCount: rawBytes.byteLength,
        observedMtimeNs: catalog.observedMtimeNs,
        filesystemIdentitySha256: catalog.fileIdentitySha256,
        statFingerprintSha256: catalog.statFingerprintSha256,
        bytes: rawBytes,
        rawSha256: catalog.rawSha256,
      },
    ]),
  };
  const staging = {
    stage: vi.fn(async ({ plan, items: stagedItems }: { plan: ExternalSourceImportPlan; items: typeof staged }) => {
      staged = { plan, items: (stagedItems as never) ?? [] } as never;
      return {} as never;
    }),
    read: vi.fn(async () => ({
      manifest: {} as never,
      items: staged!.items,
    })),
    discard: vi.fn(async () => undefined),
    cleanupExpired: vi.fn(async () => 0),
  };
  const artifacts = {
    publish: vi.fn(async ({ bytes, expectedSha256 }: { bytes: Uint8Array; expectedSha256: string }) => ({
      artifactRelPath: `external-sources/sha256/${expectedSha256}`,
      artifactSha256: expectedSha256,
      byteCount: bytes.byteLength,
      reused: false,
    })),
    read: vi.fn(async ({ artifactRelPath, expectedSha256 }: { artifactRelPath: string; expectedSha256: string }) => ({
      artifactRelPath,
      artifactSha256: expectedSha256,
      byteCount: normalizedBytes.byteLength,
      bytes: normalizedBytes,
    })),
  };
  const adapter = {
    adapterId: source.adapterId,
    sourceKind: source.kind,
    adapterVersion: source.adapterVersion,
    recognizes: () => true,
    inspect: vi.fn(),
    normalize: vi.fn(async () => ({
      normalizedBytes,
      normalizedArtifactSha256,
      normalizedByteCount: normalizedBytes.byteLength,
      messageCount: catalog.messageCount,
      lineageNodeCount: catalog.lineageNodeCount,
      lineageDepth: catalog.lineageDepth,
      lineageSha256: catalog.lineageSha256,
    })),
  };
  const service = new ExternalSourceImportService({
    configs: { find: () => source },
    scans: {
      get: () => scan,
      getItem: () => catalog,
    },
    imports: imports as never,
    workspaces: { find: () => ({ lifecycleStatus: workspaceLifecycle }) },
    reader: reader as never,
    staging: staging as never,
    artifacts: artifacts as never,
    registry: { requireForSource: () => adapter as never },
    clock: { nowMs: () => nowMs },
    ids: {
      createPlanId: () => `external-plan-${++planSequence}`,
      createImportId: () => `external-import-${++importSequence}`,
      createStagingLeaseId: () => `external-stage-${++stagingSequence}`,
    },
  });
  return {
    service,
    source,
    scan,
    catalog,
    imports,
    reader,
    staging,
    artifacts,
    clock: { setNowMs: (value: number) => (nowMs = value) },
    workspace: { setLifecycle: (value: string) => (workspaceLifecycle = value) },
  };
}

function recoveryIntent(
  plan: ExternalSourceImportPlan,
  idempotencyKey: string,
  importId: string,
): ExternalSourceImportIntent {
  return sealExternalSourceImportIntent({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    importId,
    idempotencyKey,
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
    requestedByActorId: ACTOR.actorId,
    admittedAt: "2026-07-14T08:01:00.000Z",
  });
}

function sourceRecord(): ExternalSourceRecord {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    sourceId: "source-1",
    workspaceId: "workspace-1",
    kind: "codex_memory",
    label: "Synthetic memory",
    ownerActorId: ACTOR.actorId,
    authActorId: ACTOR.actorId,
    authActorSource: ACTOR.source,
    canonicalRootPath: "F:\\synthetic\\codex-memory",
    rootIdentitySha256: "1".repeat(64),
    pathBridgeSnapshotId: "snapshot-1",
    pathBridgeSnapshotSha256: "2".repeat(64),
    allowedRootsSha256: "3".repeat(64),
    inputFlavor: "windows_native",
    targetFlavor: "windows_native",
    requireGitIdentity: false,
    ownershipAttestationSha256: "4".repeat(64),
    adapterId: "codex.memory-markdown.v1",
    adapterVersion: "1.0.0",
    adapterPolicy: {
      unknownVariantDisposition: "block",
      followLinks: false,
      followMarkdownImports: false,
      retainRawBytes: false,
      acceptedProducerVersions: ["unversioned-markdown.v1"],
    },
    revision: 1,
    configSha256: "5".repeat(64),
    status: "active",
    createdAt: "2026-07-14T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
  };
}

function catalogItem(source: ExternalSourceRecord, scanId: string, rawBytes: Uint8Array): ExternalSourceCatalogItem {
  return {
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    workspaceId: source.workspaceId,
    sourceId: source.sourceId,
    scanId,
    itemId: "item-1",
    adapterId: source.adapterId,
    adapterVersion: source.adapterVersion,
    normalizedRelativePath: "memories/MEMORY.md",
    aliasRelativePaths: [],
    foreignIdSha256: "6".repeat(64),
    producerVersion: "unversioned-markdown.v1",
    observedMtimeNs: "01720800000000000000",
    fileIdentitySha256: "7".repeat(64),
    statFingerprintSha256: "8".repeat(64),
    rawSha256: sha256(rawBytes),
    rawByteCount: rawBytes.byteLength,
    messageCount: 1,
    lineageNodeCount: 1,
    lineageDepth: 1,
    lineageSha256: "9".repeat(64),
    disposition: "supported",
    reasonCodes: [],
    catalogItemSha256: "a".repeat(64),
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
