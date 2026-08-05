import { createHash, randomUUID } from "node:crypto";
import {
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  canonicalJsonString,
  normalizeExternalSourceImportApplyInput,
  normalizeExternalSourceImportPlanInput,
  type ExternalSourceCatalogItem,
  type ExternalSourceImportApplyInput,
  type ExternalSourceImportApplyResponse,
  type ExternalSourceImportDetailResponse,
  type ExternalSourceImportIntent,
  type ExternalSourceImportItem,
  type ExternalSourceImportPlan,
  type ExternalSourceImportPlanInput,
  type ExternalSourceImportPlanResponse,
  type ExternalSourceImportSettlement,
  type ExternalSourceRecord,
} from "@goatcitadel/contracts";
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
  type AsyncStorage,
} from "@goatcitadel/storage";
import {
  ExternalSourceAdapterRegistryError,
  ExternalSourceAdapterRegistry,
  externalSourceAdapterPolicyView,
} from "./external-source-adapters/types.js";
import { ExternalSourceAdapterError } from "./external-source-adapters/internal.js";
import {
  ExternalSourceArtifactStoreError,
  type ExternalSourceArtifactStore,
} from "./external-source-artifact-store.js";
import {
  buildExternalSourceDryRunJourneyEvent,
  buildExternalSourceSettlementJourneyEvent,
} from "./external-source-journey-producer.js";
import {
  ExternalSourcePlanStagingStoreError,
  type ExternalSourcePlanStagingStore,
  type ExternalSourceStagedItemInput,
  type ExternalSourceStagedLease,
} from "./external-source-plan-staging-store.js";
import { ExternalSourceReaderError, type ExternalSourceReaderPort } from "./external-source-reader.js";
import { createFixedExternalSourceAdapterRegistry } from "./external-source-scan-service.js";
import type { ExternalSourceRequestActor } from "./external-source-service.js";

export type ExternalSourceImportServiceErrorCode =
  | "artifact_failure"
  | "cancelled"
  | "conflict"
  | "limit_exceeded"
  | "not_found"
  | "repository_failure"
  | "source_not_active"
  | "staging_unavailable"
  | "unsupported_item";

const ERROR_MESSAGES: Readonly<Record<ExternalSourceImportServiceErrorCode, string>> = Object.freeze({
  artifact_failure: "External source artifact publication failed.",
  cancelled: "External source import was cancelled.",
  conflict: "External source import conflicts with immutable evidence.",
  limit_exceeded: "External source import exceeds a fixed hard limit.",
  not_found: "External source import resource was not found.",
  repository_failure: "External source import persistence failed.",
  source_not_active: "External source is not active.",
  staging_unavailable: "External source private staging is unavailable.",
  unsupported_item: "External source selection contains unsupported material.",
});

export class ExternalSourceImportServiceError extends Error {
  public constructor(public readonly code: ExternalSourceImportServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ExternalSourceImportServiceError";
  }
}

interface ExternalSourceImportServiceClock {
  nowMs(): number;
}

interface ExternalSourceImportServiceIds {
  createPlanId(): string;
  createImportId(): string;
  createStagingLeaseId(): string;
}

interface ExternalSourceImportServiceDependencies {
  configs: Pick<AsyncStorage["externalSourceConfigs"], "find">;
  scans: Pick<AsyncStorage["externalSourceScans"], "get" | "getItem">;
  imports: Pick<
    AsyncStorage["externalSourceImports"],
    | "claimIntent"
    | "createPlanWithJourney"
    | "findIntentByIdempotencyKey"
    | "findSettlement"
    | "getIntent"
    | "getPlan"
    | "listItems"
    | "listUnsettledIntents"
    | "settleWithJourney"
  >;
  workspaces: Pick<AsyncStorage["workspaces"], "find">;
  reader: ExternalSourceReaderPort;
  staging: Pick<ExternalSourcePlanStagingStore, "cleanupExpired" | "discard" | "read" | "stage">;
  artifacts: Pick<ExternalSourceArtifactStore, "publish" | "read">;
  registry?: Pick<ExternalSourceAdapterRegistry, "requireForSource">;
  clock?: ExternalSourceImportServiceClock;
  ids?: ExternalSourceImportServiceIds;
}

const DEFAULT_CLOCK: ExternalSourceImportServiceClock = { nowMs: () => Date.now() };
const DEFAULT_IDS: ExternalSourceImportServiceIds = {
  createPlanId: () => `external-plan-${randomUUID()}`,
  createImportId: () => `external-import-${randomUUID()}`,
  createStagingLeaseId: () => `external-stage-${randomUUID()}`,
};

export interface ExternalSourceImportRecoverySummary {
  examined: number;
  applied: number;
  terminalBlocked: number;
  retryableFailures: number;
  cleanedExpiredLeases: number;
}

export class ExternalSourceImportService {
  private readonly registry: Pick<ExternalSourceAdapterRegistry, "requireForSource">;
  private readonly clock: ExternalSourceImportServiceClock;
  private readonly ids: ExternalSourceImportServiceIds;

  public constructor(private readonly dependencies: ExternalSourceImportServiceDependencies) {
    if (
      !dependencies.configs ||
      !dependencies.scans ||
      !dependencies.imports ||
      !dependencies.workspaces ||
      !dependencies.reader ||
      !dependencies.staging ||
      !dependencies.artifacts
    ) {
      throw new TypeError("External source import service dependencies are required.");
    }
    this.registry = dependencies.registry ?? createFixedExternalSourceAdapterRegistry();
    this.clock = dependencies.clock ?? DEFAULT_CLOCK;
    this.ids = dependencies.ids ?? DEFAULT_IDS;
  }

  public async createPlan(
    rawInput: ExternalSourceImportPlanInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportPlanResponse> {
    assertSignal(signal);
    const input = normalizeExternalSourceImportPlanInput(rawInput);
    const source = await this.requireOwnedSource(input.workspaceId, input.sourceId, actor, true, true);
    if (source.revision !== input.expectedRevision) throw new ExternalSourceImportServiceError("conflict");
    const scan = await this.readScan(input.workspaceId, input.scanId);
    if (
      scan.sourceId !== source.sourceId ||
      scan.status !== "sealed" ||
      scan.configRevision !== source.revision ||
      scan.configSha256 !== source.configSha256 ||
      scan.adapterId !== source.adapterId ||
      scan.adapterVersion !== source.adapterVersion
    ) {
      throw new ExternalSourceImportServiceError("conflict");
    }
    const catalogItems = await Promise.all(
      input.selectedItemIds.map(async (itemId) => await this.readCatalogItem(input.workspaceId, input.scanId, itemId)),
    );
    if (
      catalogItems.some(
        (item, ordinal) =>
          item.itemId !== input.selectedItemIds[ordinal] ||
          item.sourceId !== source.sourceId ||
          item.scanId !== scan.scanId ||
          item.disposition !== "supported" ||
          item.adapterId !== source.adapterId ||
          item.adapterVersion !== source.adapterVersion,
      )
    ) {
      throw new ExternalSourceImportServiceError("unsupported_item");
    }
    const rawByteCount = sum(catalogItems.map((item) => item.rawByteCount));
    const messageCount = sum(catalogItems.map((item) => item.messageCount));
    if (
      rawByteCount > EXTERNAL_SOURCE_LIMITS.rawBytesPerPlan ||
      messageCount > EXTERNAL_SOURCE_LIMITS.messagesPerImport
    ) {
      throw new ExternalSourceImportServiceError("limit_exceeded");
    }
    throwIfAborted(signal);
    let files;
    try {
      files = await this.dependencies.reader.readFiles({
        source,
        relativePaths: catalogItems.map((item) => item.normalizedRelativePath),
        signal,
      });
    } catch (error) {
      throw normalizeImportFailure(error, signal, "conflict");
    }
    if (files.length !== catalogItems.length) throw new ExternalSourceImportServiceError("conflict");
    const adapter = this.registry.requireForSource(source);
    const policy = externalSourceAdapterPolicyView(source);
    const stagedItems: ExternalSourceStagedItemInput[] = [];
    for (let ordinal = 0; ordinal < catalogItems.length; ordinal += 1) {
      throwIfAborted(signal);
      const catalogItem = catalogItems[ordinal]!;
      const file = files[ordinal]!;
      let normalized;
      try {
        normalized = await adapter.normalize({ policy, catalogItem, file, signal });
      } catch (error) {
        throw normalizeImportFailure(error, signal, "conflict");
      }
      stagedItems.push({
        itemId: catalogItem.itemId,
        ordinal,
        adapterId: catalogItem.adapterId,
        adapterVersion: catalogItem.adapterVersion,
        ...(catalogItem.producerVersion ? { producerVersion: catalogItem.producerVersion } : {}),
        rawSha256: catalogItem.rawSha256,
        rawByteCount: catalogItem.rawByteCount,
        normalizedArtifactSha256: normalized.normalizedArtifactSha256,
        normalizedByteCount: normalized.normalizedByteCount,
        normalizedBytes: normalized.normalizedBytes,
      });
    }
    const normalizedByteCount = sum(stagedItems.map((item) => item.normalizedByteCount));
    if (normalizedByteCount > EXTERNAL_SOURCE_LIMITS.normalizedBytesPerImport) {
      throw new ExternalSourceImportServiceError("limit_exceeded");
    }
    const nowMs = this.clock.nowMs();
    const createdAt = toIso(nowMs);
    const plan = sealExternalSourceImportPlan({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      planId: checkedId(this.ids.createPlanId()),
      workspaceId: source.workspaceId,
      sourceId: source.sourceId,
      scanId: scan.scanId,
      configRevision: source.revision,
      configSha256: source.configSha256,
      manifestSha256: scan.manifestSha256,
      adapterVersions: sortedUnique(catalogItems.map((item) => item.adapterVersion)),
      selectedItemIds: [...input.selectedItemIds],
      selectedItemSetSha256: computeExternalSourceSelectedItemSetSha256(input.selectedItemIds),
      rawSetSha256: computeExternalSourceRawSetSha256(catalogItems),
      rawByteCount,
      normalizedSetSha256: computeExternalSourceNormalizedSetSha256(stagedItems),
      normalizedByteCount,
      messageCount,
      blockerCodes: [],
      stagingLeaseId: checkedId(this.ids.createStagingLeaseId()),
      stagingExpiresAt: toIso(nowMs + EXTERNAL_SOURCE_LIMITS.stagingLeaseMs),
      createdAt,
    });
    try {
      await this.dependencies.staging.stage({ plan, items: stagedItems, signal });
      const journeyEvent = buildExternalSourceDryRunJourneyEvent({ plan, actorId: actor.actorId });
      const stored = (await this.dependencies.imports.createPlanWithJourney(plan, journeyEvent)).plan;
      return {
        schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
        plan: stored,
        idempotencyKey: deriveExternalSourceImportIdempotencyKey(stored),
      };
    } catch (error) {
      await this.dependencies.staging.discard(plan.stagingLeaseId).catch(() => undefined);
      throw normalizeImportFailure(error, signal, "repository_failure");
    }
  }

  public async apply(
    rawInput: ExternalSourceImportApplyInput,
    actor: ExternalSourceRequestActor,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportApplyResponse> {
    assertSignal(signal);
    const input = normalizeExternalSourceImportApplyInput(rawInput);
    const plan = await this.readPlan(input.workspaceId, input.planId);
    if (
      plan.planSha256 !== input.expectedPlanSha256 ||
      deriveExternalSourceImportIdempotencyKey(plan) !== input.idempotencyKey
    ) {
      throw new ExternalSourceImportServiceError("conflict");
    }
    await this.requireOwnedSource(plan.workspaceId, plan.sourceId, actor, false, false);
    const replay = await this.dependencies.imports.findIntentByIdempotencyKey(plan.workspaceId, input.idempotencyKey);
    if (replay) {
      await this.resumeIntent(replay, signal);
      return { ...(await this.getDetail(replay.workspaceId, replay.importId)), applyDisposition: "replayed" };
    }
    await this.requireOwnedSource(plan.workspaceId, plan.sourceId, actor, true, true);
    const admittedAt = toIso(this.clock.nowMs());
    const intent = sealExternalSourceImportIntent({
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      importId: checkedId(this.ids.createImportId()),
      idempotencyKey: input.idempotencyKey,
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
      requestedByActorId: actor.actorId,
      admittedAt,
    });
    let claimed: ExternalSourceImportIntent;
    try {
      claimed = await this.dependencies.imports.claimIntent(intent);
    } catch (error) {
      throw normalizeImportFailure(error, signal, "conflict");
    }
    const created = claimed.importId === intent.importId;
    await this.resumeIntent(claimed, signal);
    return {
      ...(await this.getDetail(claimed.workspaceId, claimed.importId)),
      applyDisposition: created ? "created" : "replayed",
    };
  }

  public async get(
    workspaceId: string,
    importId: string,
    actor: ExternalSourceRequestActor,
  ): Promise<ExternalSourceImportDetailResponse> {
    const intent = await this.readIntent(workspaceId, importId);
    await this.requireOwnedSource(intent.workspaceId, intent.sourceId, actor, false, false);
    return await this.getDetail(workspaceId, importId);
  }

  public async recover(signal: AbortSignal, limit = 100): Promise<ExternalSourceImportRecoverySummary> {
    assertSignal(signal);
    const intents = await this.dependencies.imports.listUnsettledIntents(limit);
    const summary: ExternalSourceImportRecoverySummary = {
      examined: intents.length,
      applied: 0,
      terminalBlocked: 0,
      retryableFailures: 0,
      cleanedExpiredLeases: 0,
    };
    for (const intent of intents) {
      throwIfAborted(signal);
      try {
        const settlement = await this.resumeIntent(intent, signal);
        if (settlement.disposition === "applied") summary.applied += 1;
        else summary.terminalBlocked += 1;
      } catch {
        if (signal.aborted) throw new ExternalSourceImportServiceError("cancelled");
        summary.retryableFailures += 1;
      }
    }
    summary.cleanedExpiredLeases = await this.dependencies.staging.cleanupExpired({ nowMs: this.clock.nowMs() });
    return summary;
  }

  private async resumeIntent(
    intent: ExternalSourceImportIntent,
    signal: AbortSignal,
  ): Promise<ExternalSourceImportSettlement> {
    const existing = await this.dependencies.imports.findSettlement(intent.workspaceId, intent.importId);
    if (existing) return existing;
    const plan = await this.readPlan(intent.workspaceId, intent.planId);
    let staged: ExternalSourceStagedLease;
    try {
      staged = await this.dependencies.staging.read({ plan, signal });
    } catch (error) {
      if (error instanceof ExternalSourcePlanStagingStoreError) {
        const terminal = stagingTerminal(error.code);
        if (terminal) return await this.settleTerminal(plan, intent, terminal.disposition, terminal.blockerCode);
      }
      throw normalizeImportFailure(error, signal, "staging_unavailable");
    }
    let catalogItems: ExternalSourceCatalogItem[];
    try {
      catalogItems = await Promise.all(
        plan.selectedItemIds.map(async (itemId) => await this.readCatalogItem(plan.workspaceId, plan.scanId, itemId)),
      );
      assertStagedBinding(plan, staged, catalogItems);
    } catch (error) {
      if (
        error instanceof ExternalSourceImportServiceError &&
        (error.code === "conflict" || error.code === "not_found")
      ) {
        return await this.settleTerminal(plan, intent, "manual_reconciliation", "staging_binding_conflict");
      }
      throw error;
    }
    const importItems: ExternalSourceImportItem[] = [];
    try {
      for (let ordinal = 0; ordinal < staged.items.length; ordinal += 1) {
        throwIfAborted(signal);
        const stagedItem = staged.items[ordinal]!;
        const published = await this.dependencies.artifacts.publish({
          bytes: stagedItem.normalizedBytes,
          expectedSha256: stagedItem.normalizedArtifactSha256,
          signal,
        });
        const verified = await this.dependencies.artifacts.read({
          artifactRelPath: published.artifactRelPath,
          expectedSha256: stagedItem.normalizedArtifactSha256,
          signal,
        });
        if (verified.byteCount !== stagedItem.normalizedByteCount) {
          return await this.settleTerminal(plan, intent, "manual_reconciliation", "artifact_rehash_mismatch");
        }
        importItems.push(
          sealExternalSourceImportItem({
            schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
            workspaceId: intent.workspaceId,
            importId: intent.importId,
            scanId: intent.scanId,
            itemId: stagedItem.itemId,
            ordinal,
            adapterId: stagedItem.adapterId,
            adapterVersion: stagedItem.adapterVersion,
            ...(stagedItem.producerVersion ? { producerVersion: stagedItem.producerVersion } : {}),
            rawSha256: stagedItem.rawSha256,
            rawByteCount: stagedItem.rawByteCount,
            normalizedArtifactSha256: stagedItem.normalizedArtifactSha256,
            normalizedByteCount: stagedItem.normalizedByteCount,
            artifactRelativeKey: published.artifactRelPath,
            createdAt: intent.admittedAt,
          }),
        );
      }
    } catch (error) {
      if (
        error instanceof ExternalSourceArtifactStoreError &&
        ["digest_mismatch", "invalid_address", "tampered", "unsafe_path"].includes(error.code)
      ) {
        return await this.settleTerminal(plan, intent, "manual_reconciliation", "artifact_integrity_failure");
      }
      throw normalizeImportFailure(error, signal, "artifact_failure");
    }
    const settlement = this.buildSettlement({
      intent,
      items: importItems,
      disposition: "applied",
      blockerCodes: [],
      settledAt: this.settlementTimestamp(intent),
    });
    const journeyEvent = buildExternalSourceSettlementJourneyEvent({ plan, intent, settlement, items: importItems });
    const finalSettlement = sealExternalSourceImportSettlement(
      { ...withoutResult(settlement), journeyEventId: journeyEvent.eventId },
      importItems,
    );
    const stored = await this.persistSettlement(finalSettlement, importItems, journeyEvent);
    await this.dependencies.staging.discard(plan.stagingLeaseId).catch(() => undefined);
    return stored;
  }

  private async settleTerminal(
    plan: ExternalSourceImportPlan,
    intent: ExternalSourceImportIntent,
    disposition: "blocked" | "manual_reconciliation",
    blockerCode: string,
  ): Promise<ExternalSourceImportSettlement> {
    const existing = await this.dependencies.imports.findSettlement(intent.workspaceId, intent.importId);
    if (existing) return existing;
    const settlement = this.buildSettlement({
      intent,
      items: [],
      disposition,
      blockerCodes: [blockerCode],
      settledAt: this.settlementTimestamp(intent),
    });
    const journeyEvent = buildExternalSourceSettlementJourneyEvent({ plan, intent, settlement, items: [] });
    const finalSettlement = sealExternalSourceImportSettlement(
      { ...withoutResult(settlement), journeyEventId: journeyEvent.eventId },
      [],
    );
    return await this.persistSettlement(finalSettlement, [], journeyEvent);
  }

  private async persistSettlement(
    settlement: ExternalSourceImportSettlement,
    items: readonly ExternalSourceImportItem[],
    journeyEvent: ReturnType<typeof buildExternalSourceSettlementJourneyEvent>,
  ): Promise<ExternalSourceImportSettlement> {
    try {
      return (await this.dependencies.imports.settleWithJourney(settlement, items, journeyEvent)).settlement;
    } catch (error) {
      if (hasCode(error, "STATE_CONFLICT") || hasCode(error, "WRITE_CONFLICT")) {
        const concurrent = await this.dependencies.imports.findSettlement(settlement.workspaceId, settlement.importId);
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  private buildSettlement(input: {
    intent: ExternalSourceImportIntent;
    items: readonly ExternalSourceImportItem[];
    disposition: ExternalSourceImportSettlement["disposition"];
    blockerCodes: string[];
    settledAt: string;
  }): ExternalSourceImportSettlement {
    return sealExternalSourceImportSettlement(
      {
        schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
        settlementId: `external-settlement-${digest({ workspaceId: input.intent.workspaceId, importId: input.intent.importId })}`,
        workspaceId: input.intent.workspaceId,
        importId: input.intent.importId,
        disposition: input.disposition,
        ...(input.disposition === "applied"
          ? {
              artifactSetSha256: computeExternalSourceArtifactSetSha256(input.items),
              artifactsVerifiedAt: input.settledAt,
            }
          : {}),
        blockerCodes: input.blockerCodes,
        settledAt: input.settledAt,
      },
      input.items,
    );
  }

  private settlementTimestamp(intent: ExternalSourceImportIntent): string {
    const admittedAtMs = Date.parse(intent.admittedAt);
    const nowMs = this.clock.nowMs();
    if (!Number.isFinite(admittedAtMs) || !Number.isFinite(nowMs)) {
      throw new ExternalSourceImportServiceError("repository_failure");
    }
    return toIso(Math.max(admittedAtMs, nowMs));
  }

  private async getDetail(workspaceId: string, importId: string): Promise<ExternalSourceImportDetailResponse> {
    const intent = await this.readIntent(workspaceId, importId);
    const settlement = await this.dependencies.imports.findSettlement(workspaceId, importId);
    return {
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      plan: await this.readPlan(workspaceId, intent.planId),
      intent,
      items: await this.dependencies.imports.listItems(workspaceId, importId),
      ...(settlement ? { settlement } : {}),
    };
  }

  private async requireOwnedSource(
    workspaceId: string,
    sourceId: string,
    actor: ExternalSourceRequestActor,
    requireActiveSource: boolean,
    requireActiveWorkspace: boolean,
  ): Promise<ExternalSourceRecord> {
    assertActor(actor);
    const workspace = await this.dependencies.workspaces.find(workspaceId);
    if (!workspace || (requireActiveWorkspace && workspace.lifecycleStatus !== "active")) {
      throw new ExternalSourceImportServiceError("not_found");
    }
    const source = await this.dependencies.configs.find(workspaceId, sourceId);
    if (
      !source ||
      source.ownerActorId !== actor.actorId ||
      source.authActorId !== actor.actorId ||
      source.authActorSource !== actor.source
    ) {
      throw new ExternalSourceImportServiceError("not_found");
    }
    if (requireActiveSource && source.status !== "active") {
      throw new ExternalSourceImportServiceError("source_not_active");
    }
    return source;
  }

  private async readScan(workspaceId: string, scanId: string) {
    try {
      return await this.dependencies.scans.get(workspaceId, scanId);
    } catch (error) {
      throw normalizeImportFailure(error, undefined, "not_found");
    }
  }

  private async readCatalogItem(
    workspaceId: string,
    scanId: string,
    itemId: string,
  ): Promise<ExternalSourceCatalogItem> {
    try {
      return await this.dependencies.scans.getItem(workspaceId, scanId, itemId);
    } catch (error) {
      throw normalizeImportFailure(error, undefined, "not_found");
    }
  }

  private async readPlan(workspaceId: string, planId: string): Promise<ExternalSourceImportPlan> {
    try {
      return await this.dependencies.imports.getPlan(workspaceId, planId);
    } catch (error) {
      throw normalizeImportFailure(error, undefined, "not_found");
    }
  }

  private async readIntent(workspaceId: string, importId: string): Promise<ExternalSourceImportIntent> {
    try {
      return await this.dependencies.imports.getIntent(workspaceId, importId);
    } catch (error) {
      throw normalizeImportFailure(error, undefined, "not_found");
    }
  }
}

function assertStagedBinding(
  plan: ExternalSourceImportPlan,
  staged: ExternalSourceStagedLease,
  catalogItems: readonly ExternalSourceCatalogItem[],
): void {
  if (staged.items.length !== catalogItems.length) throw new ExternalSourceImportServiceError("conflict");
  for (let ordinal = 0; ordinal < staged.items.length; ordinal += 1) {
    const item = staged.items[ordinal]!;
    const catalog = catalogItems[ordinal]!;
    if (
      item.ordinal !== ordinal ||
      item.itemId !== plan.selectedItemIds[ordinal] ||
      item.itemId !== catalog.itemId ||
      catalog.sourceId !== plan.sourceId ||
      catalog.scanId !== plan.scanId ||
      catalog.disposition !== "supported" ||
      item.adapterId !== catalog.adapterId ||
      item.adapterVersion !== catalog.adapterVersion ||
      item.producerVersion !== catalog.producerVersion ||
      item.rawSha256 !== catalog.rawSha256 ||
      item.rawByteCount !== catalog.rawByteCount
    ) {
      throw new ExternalSourceImportServiceError("conflict");
    }
  }
  if (
    computeExternalSourceRawSetSha256(staged.items) !== plan.rawSetSha256 ||
    computeExternalSourceNormalizedSetSha256(staged.items) !== plan.normalizedSetSha256 ||
    sum(staged.items.map((item) => item.normalizedByteCount)) !== plan.normalizedByteCount
  ) {
    throw new ExternalSourceImportServiceError("conflict");
  }
}

function stagingTerminal(
  code: ExternalSourcePlanStagingStoreError["code"],
): { disposition: "blocked" | "manual_reconciliation"; blockerCode: string } | undefined {
  if (code === "expired") return { disposition: "blocked", blockerCode: "staging_expired" };
  if (code === "missing") return { disposition: "manual_reconciliation", blockerCode: "staging_missing" };
  if (code === "tampered") return { disposition: "manual_reconciliation", blockerCode: "staging_tampered" };
  if (code === "conflict" || code === "invalid_lease") {
    return { disposition: "manual_reconciliation", blockerCode: "staging_conflict" };
  }
  return undefined;
}

function withoutResult(settlement: ExternalSourceImportSettlement) {
  const { resultSha256: _resultSha256, journeyEventId: _journeyEventId, ...draft } = settlement;
  return draft;
}

function normalizeImportFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  fallback: ExternalSourceImportServiceErrorCode,
): ExternalSourceImportServiceError {
  if (error instanceof ExternalSourceImportServiceError) return error;
  if (signal?.aborted) return new ExternalSourceImportServiceError("cancelled");
  if (
    (error instanceof ExternalSourceReaderError && error.code === "cancelled") ||
    (error instanceof ExternalSourceAdapterError && error.code === "cancelled") ||
    (error instanceof ExternalSourceArtifactStoreError && error.code === "cancelled") ||
    (error instanceof ExternalSourcePlanStagingStoreError && error.code === "cancelled")
  ) {
    return new ExternalSourceImportServiceError("cancelled");
  }
  if (error instanceof ExternalSourceAdapterRegistryError || error instanceof ExternalSourceAdapterError) {
    return new ExternalSourceImportServiceError("unsupported_item");
  }
  if (hasCode(error, "STATE_CONFLICT") || hasCode(error, "WRITE_CONFLICT")) {
    return new ExternalSourceImportServiceError("conflict");
  }
  if (hasCode(error, "NOT_FOUND")) return new ExternalSourceImportServiceError("not_found");
  return new ExternalSourceImportServiceError(fallback);
}

function assertActor(actor: ExternalSourceRequestActor): void {
  if (
    !actor ||
    !["token", "basic", "loopback"].includes(actor.source) ||
    typeof actor.actorId !== "string" ||
    actor.actorId.length < 1 ||
    actor.actorId.length > 256 ||
    actor.actorId !== actor.actorId.normalize("NFKC").trim() ||
    hasControlCharacter(actor.actorId)
  ) {
    throw new ExternalSourceImportServiceError("not_found");
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function assertSignal(signal: AbortSignal): void {
  if (!signal || typeof signal.aborted !== "boolean") throw new TypeError("External source import requires a signal.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalSourceImportServiceError("cancelled");
}

function checkedId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.normalize("NFKC").trim() ||
    !/^[a-zA-Z0-9_-]+$/u.test(value)
  ) {
    throw new ExternalSourceImportServiceError("repository_failure");
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function toIso(value: number): string {
  if (!Number.isFinite(value)) throw new ExternalSourceImportServiceError("repository_failure");
  return new Date(value).toISOString();
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
