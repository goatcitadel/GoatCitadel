/* eslint-disable max-lines -- This established immutable import owner now includes replay/recovery invariants; decomposition belongs in a behavior-preserving tranche. */
import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  assertExternalSourceImportIntent,
  assertExternalSourceImportItem,
  assertExternalSourceImportPlan,
  assertExternalSourceImportSettlement,
  canonicalJsonString,
  type ExternalSourceCatalogItem,
  type ExternalSourceImportIntent,
  type ExternalSourceImportItem,
  type ExternalSourceImportPlan,
  type ExternalSourceImportSettlement,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ExternalSourceScanRepository } from "./external-source-scan-repo.js";
import {
  GovernanceJourneyEventRepository,
  type GovernanceJourneyEventRecord,
} from "./governance-journey-event-repo.js";
import { safeJsonParse } from "./safe-json.js";

export type ExternalSourceImportPlanDraft = Omit<ExternalSourceImportPlan, "planSha256">;
export type ExternalSourceImportIntentDraft = Omit<ExternalSourceImportIntent, "requestSha256">;
export type ExternalSourceImportItemDraft = Omit<ExternalSourceImportItem, "provenanceSha256">;
export type ExternalSourceImportSettlementDraft = Omit<ExternalSourceImportSettlement, "resultSha256">;

interface ExternalSourceImportPlanRow {
  workspace_id: string;
  plan_id: string;
  source_id: string;
  scan_id: string;
  schema_version: string;
  config_revision: number | bigint | string;
  config_sha256: string;
  manifest_sha256: string;
  adapter_versions_json: string;
  selected_item_ids_json: string;
  selected_item_set_sha256: string;
  raw_set_sha256: string;
  raw_byte_count: number | bigint | string;
  normalized_set_sha256: string;
  normalized_byte_count: number | bigint | string;
  message_count: number | bigint | string;
  blocker_codes_json: string;
  staging_lease_id: string;
  staging_expires_at: string;
  plan_sha256: string;
  record_json: string;
  created_at: string;
}

interface ExternalSourceImportIntentRow {
  workspace_id: string;
  import_id: string;
  idempotency_key: string;
  source_id: string;
  scan_id: string;
  plan_id: string;
  schema_version: string;
  config_revision: number | bigint | string;
  config_sha256: string;
  manifest_sha256: string;
  plan_sha256: string;
  selected_item_set_sha256: string;
  adapter_versions_json: string;
  request_sha256: string;
  record_json: string;
  admitted_at: string;
}

interface ExternalSourceImportItemRow {
  workspace_id: string;
  import_id: string;
  scan_id: string;
  item_id: string;
  schema_version: string;
  ordinal: number | bigint | string;
  adapter_id: string;
  adapter_version: string;
  producer_version: string | null;
  raw_sha256: string;
  raw_byte_count: number | bigint | string;
  normalized_artifact_sha256: string;
  normalized_byte_count: number | bigint | string;
  artifact_relative_key: string;
  provenance_sha256: string;
  record_json: string;
  created_at: string;
}

interface ExternalSourceImportSettlementRow {
  workspace_id: string;
  settlement_id: string;
  import_id: string;
  schema_version: string;
  disposition: string;
  artifact_set_sha256: string | null;
  artifacts_verified_at: string | null;
  blocker_codes_json: string;
  result_sha256: string;
  journey_event_id: string | null;
  record_json: string;
  settled_at: string;
}

interface ExternalSourceAdmissionWorkspaceRow {
  lifecycle_status: string;
}

interface ExternalSourceAdmissionConfigRow {
  status: string;
  revision: number | bigint | string;
  config_sha256: string;
}

interface ExternalSourceAdmissionAuthority {
  workspace: ExternalSourceAdmissionWorkspaceRow | undefined;
  config: ExternalSourceAdmissionConfigRow | undefined;
}

export class ExternalSourceImportRepository {
  private readonly insertPlanStmt;
  private readonly admissionWorkspaceStmt;
  private readonly admissionConfigStmt;
  private readonly getPlanStmt;
  private readonly insertIntentStmt;
  private readonly getIntentStmt;
  private readonly getIntentByKeyStmt;
  private readonly listUnsettledIntentsStmt;
  private readonly insertItemStmt;
  private readonly listItemsStmt;
  private readonly insertSettlementStmt;
  private readonly getSettlementStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.admissionWorkspaceStmt = db.prepare(`
      SELECT lifecycle_status
      FROM workspaces
      WHERE workspace_id = @workspaceId
      ${db.dialect === "postgres" ? "FOR UPDATE" : ""}
    `);
    this.admissionConfigStmt = db.prepare(`
      SELECT status, revision, config_sha256
      FROM external_source_configs
      WHERE workspace_id = @workspaceId AND source_id = @sourceId
      ${db.dialect === "postgres" ? "FOR UPDATE" : ""}
    `);
    this.insertPlanStmt = db.prepare(`
      INSERT INTO external_source_import_plans (
        workspace_id, plan_id, source_id, scan_id, schema_version, config_revision, config_sha256,
        manifest_sha256, adapter_versions_json, selected_item_ids_json, selected_item_set_sha256,
        raw_set_sha256, raw_byte_count, normalized_set_sha256, normalized_byte_count, message_count,
        blocker_codes_json, staging_lease_id, staging_expires_at, plan_sha256, record_json, created_at
      ) VALUES (
        @workspaceId, @planId, @sourceId, @scanId, @schemaVersion, @configRevision, @configSha256,
        @manifestSha256, @adapterVersionsJson, @selectedItemIdsJson, @selectedItemSetSha256,
        @rawSetSha256, @rawByteCount, @normalizedSetSha256, @normalizedByteCount, @messageCount,
        @blockerCodesJson, @stagingLeaseId, @stagingExpiresAt, @planSha256, @recordJson, @createdAt
      ) ON CONFLICT(workspace_id, plan_id) DO NOTHING
    `);
    this.getPlanStmt = db.prepare(`
      SELECT * FROM external_source_import_plans
      WHERE workspace_id = @workspaceId AND plan_id = @planId
    `);
    this.insertIntentStmt = db.prepare(`
      INSERT INTO external_source_import_intents (
        workspace_id, import_id, idempotency_key, source_id, scan_id, plan_id, schema_version,
        config_revision, config_sha256, manifest_sha256, plan_sha256, selected_item_set_sha256,
        adapter_versions_json, request_sha256, record_json, admitted_at
      ) VALUES (
        @workspaceId, @importId, @idempotencyKey, @sourceId, @scanId, @planId, @schemaVersion,
        @configRevision, @configSha256, @manifestSha256, @planSha256, @selectedItemSetSha256,
        @adapterVersionsJson, @requestSha256, @recordJson, @admittedAt
      ) ON CONFLICT DO NOTHING
    `);
    this.getIntentStmt = db.prepare(`
      SELECT * FROM external_source_import_intents
      WHERE workspace_id = @workspaceId AND import_id = @importId
    `);
    this.getIntentByKeyStmt = db.prepare(`
      SELECT * FROM external_source_import_intents
      WHERE workspace_id = @workspaceId AND idempotency_key = @idempotencyKey
    `);
    this.listUnsettledIntentsStmt = db.prepare(`
      SELECT intent.*
      FROM external_source_import_intents AS intent
      LEFT JOIN external_source_import_settlements AS settlement
        ON settlement.workspace_id = intent.workspace_id
        AND settlement.import_id = intent.import_id
      WHERE settlement.import_id IS NULL
      ORDER BY intent.admitted_at ASC, intent.import_id ASC
      LIMIT @limit
    `);
    this.insertItemStmt = db.prepare(`
      INSERT INTO external_source_import_items (
        workspace_id, import_id, scan_id, item_id, schema_version, ordinal, adapter_id,
        adapter_version, producer_version, raw_sha256, raw_byte_count, normalized_artifact_sha256,
        normalized_byte_count, artifact_relative_key, provenance_sha256, record_json, created_at
      ) VALUES (
        @workspaceId, @importId, @scanId, @itemId, @schemaVersion, @ordinal, @adapterId,
        @adapterVersion, @producerVersion, @rawSha256, @rawByteCount, @normalizedArtifactSha256,
        @normalizedByteCount, @artifactRelativeKey, @provenanceSha256, @recordJson, @createdAt
      ) ON CONFLICT(workspace_id, import_id, item_id) DO NOTHING
    `);
    this.listItemsStmt = db.prepare(`
      SELECT * FROM external_source_import_items
      WHERE workspace_id = @workspaceId AND import_id = @importId
      ORDER BY ordinal ASC, item_id ASC
    `);
    this.insertSettlementStmt = db.prepare(`
      INSERT INTO external_source_import_settlements (
        workspace_id, settlement_id, import_id, schema_version, disposition, artifact_set_sha256,
        artifacts_verified_at, blocker_codes_json, result_sha256, journey_event_id, record_json, settled_at
      ) VALUES (
        @workspaceId, @settlementId, @importId, @schemaVersion, @disposition, @artifactSetSha256,
        @artifactsVerifiedAt, @blockerCodesJson, @resultSha256, @journeyEventId, @recordJson, @settledAt
      ) ON CONFLICT(workspace_id, import_id) DO NOTHING
    `);
    this.getSettlementStmt = db.prepare(`
      SELECT * FROM external_source_import_settlements
      WHERE workspace_id = @workspaceId AND import_id = @importId
    `);
  }

  public createPlan(input: ExternalSourceImportPlan): ExternalSourceImportPlan {
    verifyExternalSourceImportPlan(input);
    return this.db.transaction("immediate", () => this.createPlanInTransaction(input));
  }

  private createPlanInTransaction(input: ExternalSourceImportPlan): ExternalSourceImportPlan {
    verifyExternalSourceImportPlan(input);
    const { scan, selectedItems } = this.assertPlanBinding(input);
    if (Date.parse(input.stagingExpiresAt) <= Date.parse(input.createdAt)) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source import plan ${input.planId} has no usable staging lease.`,
      });
    }
    if (input.selectedItemSetSha256 !== computeExternalSourceSelectedItemSetSha256(input.selectedItemIds)) {
      throw new Error(`External source import plan ${input.planId} failed selected-set verification.`);
    }
    if (input.rawSetSha256 !== computeExternalSourceRawSetSha256(selectedItems)) {
      throw new Error(`External source import plan ${input.planId} failed raw-set verification.`);
    }
    if (input.rawByteCount !== sum(selectedItems.map((item) => item.rawByteCount))) {
      throw new Error(`External source import plan ${input.planId} failed raw-byte verification.`);
    }
    if (input.messageCount !== sum(selectedItems.map((item) => item.messageCount))) {
      throw new Error(`External source import plan ${input.planId} failed message-count verification.`);
    }
    const expectedAdapterVersions = sortedUnique(selectedItems.map((item) => item.adapterVersion));
    if (canonicalJsonString(input.adapterVersions) !== canonicalJsonString(expectedAdapterVersions)) {
      throw new Error(`External source import plan ${input.planId} failed adapter-version verification.`);
    }
    if (selectedItems.some((item) => item.disposition !== "supported") && input.blockerCodes.length === 0) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source import plan ${input.planId} selected unsupported or quarantined material without blockers.`,
      });
    }
    if (scan.status !== "sealed") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source import plan ${input.planId} cannot use a blocked scan.`,
      });
    }
    this.insertPlanStmt.run(toPlanBindings(input));
    const stored = this.getPlan(input.workspaceId, input.planId);
    assertExactReplay(stored, input, `External source import plan ${input.planId}`);
    return stored;
  }

  public createPlanWithJourney(
    input: ExternalSourceImportPlan,
    journeyEvent: GovernanceJourneyEventRecord,
  ): { plan: ExternalSourceImportPlan; journeyEvent: GovernanceJourneyEventRecord } {
    assertJourneyWorkspaceBinding(journeyEvent, input.workspaceId, input.planId);
    return this.db.transaction("immediate", () => {
      const plan = this.createPlanInTransaction(input);
      const event = new GovernanceJourneyEventRepository(this.db).create(journeyEvent);
      return { plan, journeyEvent: event };
    });
  }

  public claimIntent(input: ExternalSourceImportIntent): ExternalSourceImportIntent {
    verifyExternalSourceImportIntent(input);
    return this.db.transaction("immediate", () => {
      const plan = this.getPlan(input.workspaceId, input.planId);
      assertIntentPlanBinding(input, plan);
      const expectedKey = deriveExternalSourceImportIdempotencyKey(plan);
      if (input.idempotencyKey !== expectedKey) {
        throw new Error(`External source import ${input.importId} has a non-canonical idempotency key.`);
      }
      const authority = this.lockAdmissionAuthority(input.workspaceId, input.sourceId);
      const existing = this.findIntentByIdempotencyKey(input.workspaceId, input.idempotencyKey);
      if (existing) return this.assertIntentRequestReplay(existing, input);
      if (plan.blockerCodes.length > 0) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `External source import plan ${plan.planId} is blocked.`,
        });
      }
      if (Date.parse(input.admittedAt) > Date.parse(plan.stagingExpiresAt)) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `External source import plan ${plan.planId} staging lease expired before admission.`,
        });
      }
      this.assertActiveAdmissionAuthority(authority, input.workspaceId, input.configRevision, input.configSha256);
      this.insertIntentStmt.run(toIntentBindings(input));
      const stored = this.findIntentByIdempotencyKey(input.workspaceId, input.idempotencyKey);
      if (!stored) {
        const occupied = this.findIntent(input.workspaceId, input.importId);
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: occupied
            ? `External source import ID ${input.importId} is already bound to different material.`
            : `External source import ${input.importId} could not claim its idempotency key.`,
        });
      }
      return this.assertIntentRequestReplay(stored, input);
    });
  }

  public settle(
    settlement: ExternalSourceImportSettlement,
    items: readonly ExternalSourceImportItem[],
  ): ExternalSourceImportSettlement {
    verifyExternalSourceImportSettlement(settlement, items);
    const intent = this.getIntent(settlement.workspaceId, settlement.importId);
    const plan = this.getPlan(settlement.workspaceId, intent.planId);
    this.assertSettlementBinding(settlement, items, intent, plan);
    return this.db.transaction("immediate", () => {
      const existing = this.findSettlement(settlement.workspaceId, settlement.importId);
      if (existing) return this.assertSettlementReplay(existing, settlement, items);
      for (const item of orderedImportItems(items)) this.insertItemStmt.run(toImportItemBindings(item));
      this.insertSettlementStmt.run(toSettlementBindings(settlement));
      const stored = this.getSettlement(settlement.workspaceId, settlement.importId);
      return this.assertSettlementReplay(stored, settlement, items);
    });
  }

  public settleWithJourney(
    settlement: ExternalSourceImportSettlement,
    items: readonly ExternalSourceImportItem[],
    journeyEvent: GovernanceJourneyEventRecord,
  ): { settlement: ExternalSourceImportSettlement; journeyEvent: GovernanceJourneyEventRecord } {
    verifyExternalSourceImportSettlement(settlement, items);
    const intent = this.getIntent(settlement.workspaceId, settlement.importId);
    const plan = this.getPlan(settlement.workspaceId, intent.planId);
    this.assertSettlementBinding(settlement, items, intent, plan);
    if (settlement.journeyEventId !== journeyEvent.eventId) {
      throw new Error("External source settlement does not bind its Journey event.");
    }
    assertJourneyWorkspaceBinding(journeyEvent, settlement.workspaceId, settlement.importId);
    return this.db.transaction("immediate", () => {
      const journeys = new GovernanceJourneyEventRepository(this.db);
      const existing = this.findSettlement(settlement.workspaceId, settlement.importId);
      if (existing) {
        this.assertSettlementOutcomeReplay(existing, settlement, items);
        if (!existing.journeyEventId) {
          throw new Error(`External source settlement ${existing.settlementId} lost its Journey binding.`);
        }
        const event = journeys.get(existing.journeyEventId);
        assertJourneyWorkspaceBinding(event, existing.workspaceId, existing.importId);
        return { settlement: existing, journeyEvent: event };
      }
      const event = journeys.create(journeyEvent);
      const stored = this.settle(settlement, items);
      return { settlement: stored, journeyEvent: event };
    });
  }

  public getPlan(workspaceId: string, planId: string): ExternalSourceImportPlan {
    const plan = this.findPlan(workspaceId, planId);
    if (!plan) throw new NotFoundError({ entity: "external source import plan", id: planId });
    return plan;
  }

  public findPlan(workspaceId: string, planId: string): ExternalSourceImportPlan | undefined {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(planId, "planId");
    const row = this.getPlanStmt.get({ workspaceId, planId }) as ExternalSourceImportPlanRow | undefined;
    return row ? mapAndVerifyPlanRow(row) : undefined;
  }

  public getIntent(workspaceId: string, importId: string): ExternalSourceImportIntent {
    const intent = this.findIntent(workspaceId, importId);
    if (!intent) throw new NotFoundError({ entity: "external source import", id: importId });
    return intent;
  }

  public findIntent(workspaceId: string, importId: string): ExternalSourceImportIntent | undefined {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(importId, "importId");
    const row = this.getIntentStmt.get({ workspaceId, importId }) as ExternalSourceImportIntentRow | undefined;
    return row ? mapAndVerifyIntentRow(row) : undefined;
  }

  public findIntentByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): ExternalSourceImportIntent | undefined {
    assertIdentifier(workspaceId, "workspaceId");
    if (!idempotencyKey || idempotencyKey !== idempotencyKey.trim() || idempotencyKey.length > 512) {
      throw new TypeError("External source idempotency key is invalid.");
    }
    const row = this.getIntentByKeyStmt.get({ workspaceId, idempotencyKey }) as
      | ExternalSourceImportIntentRow
      | undefined;
    return row ? mapAndVerifyIntentRow(row) : undefined;
  }

  public listUnsettledIntents(limit = 100): ExternalSourceImportIntent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("External source unsettled import limit must be an integer from 1 through 1000.");
    }
    return (this.listUnsettledIntentsStmt.all({ limit }) as ExternalSourceImportIntentRow[]).map(mapAndVerifyIntentRow);
  }

  public listItems(workspaceId: string, importId: string): ExternalSourceImportItem[] {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(importId, "importId");
    return (this.listItemsStmt.all({ workspaceId, importId }) as ExternalSourceImportItemRow[]).map(
      mapAndVerifyImportItemRow,
    );
  }

  public getItem(workspaceId: string, importId: string, itemId: string): ExternalSourceImportItem {
    assertIdentifier(itemId, "itemId");
    const item = this.listItems(workspaceId, importId).find((candidate) => candidate.itemId === itemId);
    if (!item) throw new NotFoundError({ entity: "external source import item", id: itemId });
    return item;
  }

  public getSettlement(workspaceId: string, importId: string): ExternalSourceImportSettlement {
    const settlement = this.findSettlement(workspaceId, importId);
    if (!settlement) throw new NotFoundError({ entity: "external source import settlement", id: importId });
    return settlement;
  }

  public findSettlement(workspaceId: string, importId: string): ExternalSourceImportSettlement | undefined {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(importId, "importId");
    const row = this.getSettlementStmt.get({ workspaceId, importId }) as ExternalSourceImportSettlementRow | undefined;
    return row ? mapAndVerifySettlementRow(row) : undefined;
  }

  private assertPlanBinding(input: ExternalSourceImportPlan): {
    scan: ReturnType<ExternalSourceScanRepository["get"]>;
    selectedItems: ExternalSourceCatalogItem[];
  } {
    this.assertAdmissionAuthority(input.workspaceId, input.sourceId, input.configRevision, input.configSha256);
    const scans = new ExternalSourceScanRepository(this.db);
    const scan = scans.get(input.workspaceId, input.scanId);
    if (
      scan.sourceId !== input.sourceId ||
      scan.configRevision !== input.configRevision ||
      scan.configSha256 !== input.configSha256 ||
      scan.manifestSha256 !== input.manifestSha256
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source import plan ${input.planId} does not match its sealed scan.`,
      });
    }
    const selectedItems = input.selectedItemIds.map((itemId) => scans.getItem(input.workspaceId, input.scanId, itemId));
    return { scan, selectedItems };
  }

  private assertAdmissionAuthority(
    workspaceId: string,
    sourceId: string,
    expectedRevision: number,
    expectedConfigSha256: string,
  ): void {
    const authority = this.lockAdmissionAuthority(workspaceId, sourceId);
    this.assertActiveAdmissionAuthority(authority, workspaceId, expectedRevision, expectedConfigSha256);
  }

  private lockAdmissionAuthority(workspaceId: string, sourceId: string): ExternalSourceAdmissionAuthority {
    const workspace = this.admissionWorkspaceStmt.get({ workspaceId }) as
      | ExternalSourceAdmissionWorkspaceRow
      | undefined;
    const config = this.admissionConfigStmt.get({ workspaceId, sourceId }) as
      | ExternalSourceAdmissionConfigRow
      | undefined;
    return { workspace, config };
  }

  private assertActiveAdmissionAuthority(
    authority: ExternalSourceAdmissionAuthority,
    workspaceId: string,
    expectedRevision: number,
    expectedConfigSha256: string,
  ): void {
    const { workspace, config } = authority;
    if (!workspace) throw new NotFoundError({ entity: "workspace", id: workspaceId });
    if (workspace.lifecycle_status !== "active") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source admission is blocked outside an active workspace.`,
      });
    }
    if (
      !config ||
      config.status !== "active" ||
      Number(config.revision) !== expectedRevision ||
      config.config_sha256 !== expectedConfigSha256
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source admission does not match the current active configuration.`,
      });
    }
  }

  private assertIntentRequestReplay(
    stored: ExternalSourceImportIntent,
    requested: ExternalSourceImportIntent,
  ): ExternalSourceImportIntent {
    if (stored.requestSha256 !== requested.requestSha256) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source import idempotency key was reused with different immutable material.`,
      });
    }
    return stored;
  }

  private assertSettlementBinding(
    settlement: ExternalSourceImportSettlement,
    items: readonly ExternalSourceImportItem[],
    intent: ExternalSourceImportIntent,
    plan: ExternalSourceImportPlan,
  ): void {
    if (intent.workspaceId !== settlement.workspaceId || intent.importId !== settlement.importId) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source settlement ${settlement.settlementId} does not match its import intent.`,
      });
    }
    if (settlement.disposition !== "applied") {
      if (items.length > 0) throw new Error("Blocked external source settlements cannot publish import items.");
      return;
    }
    const ordered = orderedImportItems(items);
    if (ordered.length !== plan.selectedItemIds.length) {
      throw new Error(`External source import ${intent.importId} did not publish its exact selected item count.`);
    }
    const scans = new ExternalSourceScanRepository(this.db);
    for (let ordinal = 0; ordinal < ordered.length; ordinal += 1) {
      const item = ordered[ordinal]!;
      const selectedItemId = plan.selectedItemIds[ordinal];
      if (
        item.workspaceId !== intent.workspaceId ||
        item.importId !== intent.importId ||
        item.scanId !== intent.scanId ||
        item.itemId !== selectedItemId ||
        item.ordinal !== ordinal
      ) {
        throw new Error(`External source import ${intent.importId} changed its atomic selected-item order.`);
      }
      const catalog = scans.getItem(intent.workspaceId, intent.scanId, item.itemId);
      if (
        catalog.disposition !== "supported" ||
        catalog.adapterId !== item.adapterId ||
        catalog.adapterVersion !== item.adapterVersion ||
        catalog.producerVersion !== item.producerVersion ||
        catalog.rawSha256 !== item.rawSha256 ||
        catalog.rawByteCount !== item.rawByteCount
      ) {
        throw new Error(`External source import item ${item.itemId} drifted from its sealed catalog evidence.`);
      }
      if (!item.artifactRelativeKey.endsWith(`/${item.normalizedArtifactSha256}`)) {
        throw new Error(`External source import item ${item.itemId} is not addressed by its normalized hash.`);
      }
    }
    if (computeExternalSourceRawSetSha256(ordered) !== plan.rawSetSha256) {
      throw new Error(`External source import ${intent.importId} failed raw-set replay verification.`);
    }
    if (sum(ordered.map((item) => item.rawByteCount)) !== plan.rawByteCount) {
      throw new Error(`External source import ${intent.importId} failed raw-byte replay verification.`);
    }
    if (computeExternalSourceNormalizedSetSha256(ordered) !== plan.normalizedSetSha256) {
      throw new Error(`External source import ${intent.importId} failed normalized-set replay verification.`);
    }
    if (sum(ordered.map((item) => item.normalizedByteCount)) !== plan.normalizedByteCount) {
      throw new Error(`External source import ${intent.importId} failed normalized-byte replay verification.`);
    }
    if (computeExternalSourceArtifactSetSha256(ordered) !== settlement.artifactSetSha256) {
      throw new Error(`External source import ${intent.importId} failed artifact-set verification.`);
    }
  }

  private assertSettlementReplay(
    stored: ExternalSourceImportSettlement,
    requested: ExternalSourceImportSettlement,
    items: readonly ExternalSourceImportItem[],
  ): ExternalSourceImportSettlement {
    if (stored.resultSha256 !== requested.resultSha256) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source import ${requested.importId} already has a different terminal settlement.`,
      });
    }
    const storedItems = this.listItems(requested.workspaceId, requested.importId);
    if (canonicalJsonString(storedItems) !== canonicalJsonString(orderedImportItems(items))) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source import ${requested.importId} terminal replay changed artifact evidence.`,
      });
    }
    verifyExternalSourceImportSettlement(stored, storedItems);
    return stored;
  }

  private assertSettlementOutcomeReplay(
    stored: ExternalSourceImportSettlement,
    requested: ExternalSourceImportSettlement,
    items: readonly ExternalSourceImportItem[],
  ): void {
    const outcome = (settlement: ExternalSourceImportSettlement) => ({
      schemaVersion: settlement.schemaVersion,
      settlementId: settlement.settlementId,
      workspaceId: settlement.workspaceId,
      importId: settlement.importId,
      disposition: settlement.disposition,
      artifactSetSha256: settlement.artifactSetSha256,
      blockerCodes: settlement.blockerCodes,
    });
    if (canonicalJsonString(outcome(stored)) !== canonicalJsonString(outcome(requested))) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source import ${requested.importId} already has a different terminal outcome.`,
      });
    }
    const storedItems = this.listItems(requested.workspaceId, requested.importId);
    if (canonicalJsonString(storedItems) !== canonicalJsonString(orderedImportItems(items))) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source import ${requested.importId} terminal replay changed artifact evidence.`,
      });
    }
    verifyExternalSourceImportSettlement(stored, storedItems);
  }
}

function assertJourneyWorkspaceBinding(
  event: GovernanceJourneyEventRecord,
  workspaceId: string,
  subjectId: string,
): void {
  if (
    event.scopeKind !== "workspace" ||
    event.workspaceId !== workspaceId ||
    event.eventType !== "external_session_import" ||
    event.subjectId !== subjectId ||
    event.sourceKind !== "external_source"
  ) {
    throw new Error("External source Journey event is not bound to its immutable import record.");
  }
}

export function sealExternalSourceImportPlan(input: ExternalSourceImportPlanDraft): ExternalSourceImportPlan {
  const plan = { ...input, planSha256: canonicalHash(input) };
  assertExternalSourceImportPlan(plan);
  return plan;
}

export function verifyExternalSourceImportPlan(input: ExternalSourceImportPlan): void {
  assertExternalSourceImportPlan(input);
  const { planSha256: _planSha256, ...draft } = input;
  if (canonicalHash(draft) !== input.planSha256) {
    throw new Error(`External source import plan ${input.planId} failed hash verification.`);
  }
}

export function sealExternalSourceImportIntent(input: ExternalSourceImportIntentDraft): ExternalSourceImportIntent {
  const intent = { ...input, requestSha256: computeExternalSourceImportRequestSha256(input) };
  assertExternalSourceImportIntent(intent);
  return intent;
}

export function verifyExternalSourceImportIntent(input: ExternalSourceImportIntent): void {
  assertExternalSourceImportIntent(input);
  if (computeExternalSourceImportRequestSha256(input) !== input.requestSha256) {
    throw new Error(`External source import ${input.importId} failed request hash verification.`);
  }
}

export function sealExternalSourceImportItem(input: ExternalSourceImportItemDraft): ExternalSourceImportItem {
  const item = { ...input, provenanceSha256: canonicalHash(input) };
  assertExternalSourceImportItem(item);
  return item;
}

export function verifyExternalSourceImportItem(input: ExternalSourceImportItem): void {
  assertExternalSourceImportItem(input);
  const { provenanceSha256: _provenanceSha256, ...draft } = input;
  if (canonicalHash(draft) !== input.provenanceSha256) {
    throw new Error(`External source import item ${input.itemId} failed provenance verification.`);
  }
}

export function sealExternalSourceImportSettlement(
  input: ExternalSourceImportSettlementDraft,
  items: readonly ExternalSourceImportItem[],
): ExternalSourceImportSettlement {
  const settlement = { ...input, resultSha256: computeExternalSourceSettlementResultSha256(input, items) };
  assertExternalSourceImportSettlement(settlement);
  return settlement;
}

export function verifyExternalSourceImportSettlement(
  input: ExternalSourceImportSettlement,
  items: readonly ExternalSourceImportItem[],
): void {
  assertExternalSourceImportSettlement(input);
  items.forEach(verifyExternalSourceImportItem);
  if (computeExternalSourceSettlementResultSha256(input, items) !== input.resultSha256) {
    throw new Error(`External source import settlement ${input.settlementId} failed result verification.`);
  }
}

export function computeExternalSourceSelectedItemSetSha256(itemIds: readonly string[]): string {
  return canonicalHash([...itemIds]);
}

export function computeExternalSourceRawSetSha256(
  items: readonly Pick<ExternalSourceCatalogItem | ExternalSourceImportItem, "itemId" | "rawSha256" | "rawByteCount">[],
): string {
  return canonicalHash(
    items.map((item) => ({ itemId: item.itemId, rawSha256: item.rawSha256, rawByteCount: item.rawByteCount })),
  );
}

export function computeExternalSourceNormalizedSetSha256(
  items: readonly Pick<ExternalSourceImportItem, "itemId" | "normalizedArtifactSha256" | "normalizedByteCount">[],
): string {
  return canonicalHash(
    items.map((item) => ({
      itemId: item.itemId,
      normalizedArtifactSha256: item.normalizedArtifactSha256,
      normalizedByteCount: item.normalizedByteCount,
    })),
  );
}

export function computeExternalSourceArtifactSetSha256(items: readonly ExternalSourceImportItem[]): string {
  return canonicalHash(
    orderedImportItems(items).map((item) => ({
      itemId: item.itemId,
      ordinal: item.ordinal,
      normalizedArtifactSha256: item.normalizedArtifactSha256,
      normalizedByteCount: item.normalizedByteCount,
      artifactRelativeKey: item.artifactRelativeKey,
      provenanceSha256: item.provenanceSha256,
    })),
  );
}

export function deriveExternalSourceImportIdempotencyKey(plan: ExternalSourceImportPlan): string {
  return `external-source-import:v1:${canonicalHash(importRequestMaterial(plan))}`;
}

export function computeExternalSourceImportRequestSha256(
  input: ExternalSourceImportIntent | ExternalSourceImportIntentDraft | ExternalSourceImportPlan,
): string {
  return canonicalHash(importRequestMaterial(input));
}

export function computeExternalSourceSettlementResultSha256(
  settlement: ExternalSourceImportSettlement | ExternalSourceImportSettlementDraft,
  items: readonly ExternalSourceImportItem[],
): string {
  return canonicalHash({
    schemaVersion: settlement.schemaVersion,
    workspaceId: settlement.workspaceId,
    importId: settlement.importId,
    disposition: settlement.disposition,
    artifactSetSha256: settlement.artifactSetSha256,
    artifactsVerifiedAt: settlement.artifactsVerifiedAt,
    blockerCodes: settlement.blockerCodes,
    items: orderedImportItems(items).map((item) => ({
      itemId: item.itemId,
      ordinal: item.ordinal,
      normalizedArtifactSha256: item.normalizedArtifactSha256,
      normalizedByteCount: item.normalizedByteCount,
      artifactRelativeKey: item.artifactRelativeKey,
      provenanceSha256: item.provenanceSha256,
    })),
  });
}

function importRequestMaterial(
  input: ExternalSourceImportIntent | ExternalSourceImportIntentDraft | ExternalSourceImportPlan,
): Record<string, unknown> {
  const binding = importPlanBindingMaterial(input);
  return "requestedByActorId" in input ? { ...binding, requestedByActorId: input.requestedByActorId } : binding;
}

function importPlanBindingMaterial(
  input: ExternalSourceImportIntent | ExternalSourceImportIntentDraft | ExternalSourceImportPlan,
): Record<string, unknown> {
  return {
    schemaVersion: input.schemaVersion,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    scanId: input.scanId,
    planId: "planId" in input ? input.planId : undefined,
    configRevision: input.configRevision,
    configSha256: input.configSha256,
    manifestSha256: input.manifestSha256,
    planSha256: "planSha256" in input ? input.planSha256 : undefined,
    selectedItemSetSha256: input.selectedItemSetSha256,
    adapterVersions: input.adapterVersions,
  };
}

function assertIntentPlanBinding(input: ExternalSourceImportIntent, plan: ExternalSourceImportPlan): void {
  const expected = importPlanBindingMaterial(plan);
  const actual = importPlanBindingMaterial(input);
  if (canonicalJsonString(actual) !== canonicalJsonString(expected)) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `External source import ${input.importId} does not match plan ${input.planId}.`,
    });
  }
}

function toPlanBindings(plan: ExternalSourceImportPlan): Record<string, unknown> {
  return {
    workspaceId: plan.workspaceId,
    planId: plan.planId,
    sourceId: plan.sourceId,
    scanId: plan.scanId,
    schemaVersion: plan.schemaVersion,
    configRevision: plan.configRevision,
    configSha256: plan.configSha256,
    manifestSha256: plan.manifestSha256,
    adapterVersionsJson: canonicalJsonString(plan.adapterVersions),
    selectedItemIdsJson: canonicalJsonString(plan.selectedItemIds),
    selectedItemSetSha256: plan.selectedItemSetSha256,
    rawSetSha256: plan.rawSetSha256,
    rawByteCount: plan.rawByteCount,
    normalizedSetSha256: plan.normalizedSetSha256,
    normalizedByteCount: plan.normalizedByteCount,
    messageCount: plan.messageCount,
    blockerCodesJson: canonicalJsonString(plan.blockerCodes),
    stagingLeaseId: plan.stagingLeaseId,
    stagingExpiresAt: plan.stagingExpiresAt,
    planSha256: plan.planSha256,
    recordJson: canonicalJsonString(plan),
    createdAt: plan.createdAt,
  };
}

function toIntentBindings(intent: ExternalSourceImportIntent): Record<string, unknown> {
  return {
    workspaceId: intent.workspaceId,
    importId: intent.importId,
    idempotencyKey: intent.idempotencyKey,
    sourceId: intent.sourceId,
    scanId: intent.scanId,
    planId: intent.planId,
    schemaVersion: intent.schemaVersion,
    configRevision: intent.configRevision,
    configSha256: intent.configSha256,
    manifestSha256: intent.manifestSha256,
    planSha256: intent.planSha256,
    selectedItemSetSha256: intent.selectedItemSetSha256,
    adapterVersionsJson: canonicalJsonString(intent.adapterVersions),
    requestSha256: intent.requestSha256,
    recordJson: canonicalJsonString(intent),
    admittedAt: intent.admittedAt,
  };
}

function toImportItemBindings(item: ExternalSourceImportItem): Record<string, unknown> {
  return {
    workspaceId: item.workspaceId,
    importId: item.importId,
    scanId: item.scanId,
    itemId: item.itemId,
    schemaVersion: item.schemaVersion,
    ordinal: item.ordinal,
    adapterId: item.adapterId,
    adapterVersion: item.adapterVersion,
    producerVersion: item.producerVersion ?? null,
    rawSha256: item.rawSha256,
    rawByteCount: item.rawByteCount,
    normalizedArtifactSha256: item.normalizedArtifactSha256,
    normalizedByteCount: item.normalizedByteCount,
    artifactRelativeKey: item.artifactRelativeKey,
    provenanceSha256: item.provenanceSha256,
    recordJson: canonicalJsonString(item),
    createdAt: item.createdAt,
  };
}

function toSettlementBindings(settlement: ExternalSourceImportSettlement): Record<string, unknown> {
  return {
    workspaceId: settlement.workspaceId,
    settlementId: settlement.settlementId,
    importId: settlement.importId,
    schemaVersion: settlement.schemaVersion,
    disposition: settlement.disposition,
    artifactSetSha256: settlement.artifactSetSha256 ?? null,
    artifactsVerifiedAt: settlement.artifactsVerifiedAt ?? null,
    blockerCodesJson: canonicalJsonString(settlement.blockerCodes),
    resultSha256: settlement.resultSha256,
    journeyEventId: settlement.journeyEventId ?? null,
    recordJson: canonicalJsonString(settlement),
    settledAt: settlement.settledAt,
  };
}

function mapAndVerifyPlanRow(row: ExternalSourceImportPlanRow): ExternalSourceImportPlan {
  const plan = parseCanonicalRecord<ExternalSourceImportPlan>(
    row.record_json,
    `External source import plan ${row.plan_id}`,
  );
  verifyExternalSourceImportPlan(plan);
  assertIndexedColumns(
    row,
    {
      workspace_id: plan.workspaceId,
      plan_id: plan.planId,
      source_id: plan.sourceId,
      scan_id: plan.scanId,
      schema_version: plan.schemaVersion,
      config_revision: plan.configRevision,
      config_sha256: plan.configSha256,
      manifest_sha256: plan.manifestSha256,
      adapter_versions_json: canonicalJsonString(plan.adapterVersions),
      selected_item_ids_json: canonicalJsonString(plan.selectedItemIds),
      selected_item_set_sha256: plan.selectedItemSetSha256,
      raw_set_sha256: plan.rawSetSha256,
      raw_byte_count: plan.rawByteCount,
      normalized_set_sha256: plan.normalizedSetSha256,
      normalized_byte_count: plan.normalizedByteCount,
      message_count: plan.messageCount,
      blocker_codes_json: canonicalJsonString(plan.blockerCodes),
      staging_lease_id: plan.stagingLeaseId,
      staging_expires_at: plan.stagingExpiresAt,
      plan_sha256: plan.planSha256,
      created_at: plan.createdAt,
    },
    `External source import plan ${row.plan_id}`,
  );
  return plan;
}

function mapAndVerifyIntentRow(row: ExternalSourceImportIntentRow): ExternalSourceImportIntent {
  const intent = parseCanonicalRecord<ExternalSourceImportIntent>(
    row.record_json,
    `External source import ${row.import_id}`,
  );
  verifyExternalSourceImportIntent(intent);
  assertIndexedColumns(
    row,
    {
      workspace_id: intent.workspaceId,
      import_id: intent.importId,
      idempotency_key: intent.idempotencyKey,
      source_id: intent.sourceId,
      scan_id: intent.scanId,
      plan_id: intent.planId,
      schema_version: intent.schemaVersion,
      config_revision: intent.configRevision,
      config_sha256: intent.configSha256,
      manifest_sha256: intent.manifestSha256,
      plan_sha256: intent.planSha256,
      selected_item_set_sha256: intent.selectedItemSetSha256,
      adapter_versions_json: canonicalJsonString(intent.adapterVersions),
      request_sha256: intent.requestSha256,
      admitted_at: intent.admittedAt,
    },
    `External source import ${row.import_id}`,
  );
  return intent;
}

function mapAndVerifyImportItemRow(row: ExternalSourceImportItemRow): ExternalSourceImportItem {
  const item = parseCanonicalRecord<ExternalSourceImportItem>(
    row.record_json,
    `External source import item ${row.item_id}`,
  );
  verifyExternalSourceImportItem(item);
  assertIndexedColumns(
    row,
    {
      workspace_id: item.workspaceId,
      import_id: item.importId,
      scan_id: item.scanId,
      item_id: item.itemId,
      schema_version: item.schemaVersion,
      ordinal: item.ordinal,
      adapter_id: item.adapterId,
      adapter_version: item.adapterVersion,
      producer_version: item.producerVersion ?? null,
      raw_sha256: item.rawSha256,
      raw_byte_count: item.rawByteCount,
      normalized_artifact_sha256: item.normalizedArtifactSha256,
      normalized_byte_count: item.normalizedByteCount,
      artifact_relative_key: item.artifactRelativeKey,
      provenance_sha256: item.provenanceSha256,
      created_at: item.createdAt,
    },
    `External source import item ${row.item_id}`,
  );
  return item;
}

function mapAndVerifySettlementRow(row: ExternalSourceImportSettlementRow): ExternalSourceImportSettlement {
  const settlement = parseCanonicalRecord<ExternalSourceImportSettlement>(
    row.record_json,
    `External source settlement ${row.settlement_id}`,
  );
  assertExternalSourceImportSettlement(settlement);
  assertIndexedColumns(
    row,
    {
      workspace_id: settlement.workspaceId,
      settlement_id: settlement.settlementId,
      import_id: settlement.importId,
      schema_version: settlement.schemaVersion,
      disposition: settlement.disposition,
      artifact_set_sha256: settlement.artifactSetSha256 ?? null,
      artifacts_verified_at: settlement.artifactsVerifiedAt ?? null,
      blocker_codes_json: canonicalJsonString(settlement.blockerCodes),
      result_sha256: settlement.resultSha256,
      journey_event_id: settlement.journeyEventId ?? null,
      settled_at: settlement.settledAt,
    },
    `External source settlement ${row.settlement_id}`,
  );
  return settlement;
}

function parseCanonicalRecord<T>(raw: string, label: string): T {
  const value = safeJsonParse<T | undefined>(raw, undefined);
  if (!value) throw new Error(`${label} contains invalid JSON.`);
  if (raw !== canonicalJsonString(value)) throw new Error(`${label} is not stored as canonical JSON.`);
  return value;
}

function assertIndexedColumns(row: object, expected: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(expected)) {
    const raw = (row as Record<string, unknown>)[key];
    const actual = typeof value === "number" ? Number(raw) : raw;
    if (actual !== value) throw new Error(`${label} failed indexed-column verification at ${key}.`);
  }
}

function orderedImportItems(items: readonly ExternalSourceImportItem[]): ExternalSourceImportItem[] {
  return [...items].sort((left, right) => left.ordinal - right.ordinal || left.itemId.localeCompare(right.itemId));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function assertExactReplay(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJsonString(actual) !== canonicalJsonString(expected)) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `${label} conflicts with existing immutable material.`,
    });
  }
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 256) {
    throw new TypeError(`External source ${field} is invalid.`);
  }
}
