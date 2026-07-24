import { createHash } from "node:crypto";
import {
  ConflictError,
  EXTERNAL_SOURCE_CURSOR_VERSION,
  EXTERNAL_SOURCE_LIMITS,
  EXTERNAL_SOURCE_SCHEMA_VERSION,
  NotFoundError,
  assertExternalSourceCatalogItem,
  assertExternalSourcePage,
  assertExternalSourceScanRecord,
  canonicalExternalSourceFilterMaterial,
  canonicalJsonString,
  compareExternalSourcePositions,
  isExternalSourceCursorV1,
  type ExternalSourceCatalogDisposition,
  type ExternalSourceCatalogItem,
  type ExternalSourceCursorV1,
  type ExternalSourcePage,
  type ExternalSourceScanHighWater,
  type ExternalSourceScanRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ExternalSourceConfigRepository } from "./external-source-config-repo.js";
import { safeJsonParse } from "./safe-json.js";

export type ExternalSourceCatalogItemDraft = Omit<ExternalSourceCatalogItem, "catalogItemSha256">;
export type ExternalSourceScanDraft = Omit<
  ExternalSourceScanRecord,
  "manifestSha256" | "highWater" | "itemCount" | "supportedItemCount" | "quarantinedItemCount"
>;

export interface ExternalSourceCatalogPageInput {
  workspaceId: string;
  sourceId: string;
  scanId: string;
  dispositions?: readonly ExternalSourceCatalogDisposition[];
  limit?: number;
  cursor?: string;
}

interface ExternalSourceScanRow {
  workspace_id: string;
  scan_id: string;
  source_id: string;
  schema_version: string;
  config_revision: number | bigint | string;
  config_sha256: string;
  root_identity_sha256: string;
  path_bridge_snapshot_sha256: string;
  adapter_id: string;
  adapter_version: string;
  manifest_sha256: string;
  high_water_mtime_ns: string | null;
  high_water_item_id: string | null;
  examined_entry_count: number | bigint | string;
  item_count: number | bigint | string;
  supported_item_count: number | bigint | string;
  quarantined_item_count: number | bigint | string;
  blocker_codes_json: string;
  status: string;
  record_json: string;
  started_at: string;
  completed_at: string;
}

interface ExternalSourceCatalogItemRow {
  workspace_id: string;
  scan_id: string;
  source_id: string;
  item_id: string;
  schema_version: string;
  adapter_id: string;
  adapter_version: string;
  normalized_relative_path: string;
  alias_paths_json: string;
  foreign_id_sha256: string;
  producer_version: string | null;
  observed_mtime_ns: string;
  file_identity_sha256: string;
  stat_fingerprint_sha256: string;
  raw_sha256: string;
  raw_byte_count: number | bigint | string;
  message_count: number | bigint | string;
  lineage_node_count: number | bigint | string;
  lineage_depth: number | bigint | string;
  lineage_sha256: string;
  disposition: string;
  reason_codes_json: string;
  catalog_item_sha256: string;
  record_json: string;
}

interface ExternalSourceConfigLockRow {
  source_id: string;
}

export class ExternalSourceCursorError extends TypeError {
  public readonly code = "INVALID_EXTERNAL_SOURCE_CURSOR";

  public constructor(message = "External source cursor is invalid.") {
    super(message);
    this.name = "ExternalSourceCursorError";
  }
}

export class ExternalSourceScanRepository {
  private readonly configs: ExternalSourceConfigRepository;
  private readonly configLockStmt;
  private readonly insertScanStmt;
  private readonly insertItemStmt;
  private readonly getScanStmt;
  private readonly getItemStmt;
  private readonly listItemsStmt;
  private readonly listScansStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.configs = new ExternalSourceConfigRepository(db);
    this.configLockStmt = db.prepare(`
      SELECT source_id
      FROM external_source_configs
      WHERE workspace_id = @workspaceId AND source_id = @sourceId
      ${db.dialect === "postgres" ? "FOR UPDATE" : ""}
    `);
    this.insertScanStmt = db.prepare(`
      INSERT INTO external_source_scans (
        workspace_id, scan_id, source_id, schema_version, config_revision, config_sha256,
        root_identity_sha256, path_bridge_snapshot_sha256, adapter_id, adapter_version,
        manifest_sha256, high_water_mtime_ns, high_water_item_id, examined_entry_count,
        item_count, supported_item_count, quarantined_item_count, blocker_codes_json,
        status, record_json, started_at, completed_at
      ) VALUES (
        @workspaceId, @scanId, @sourceId, @schemaVersion, @configRevision, @configSha256,
        @rootIdentitySha256, @pathBridgeSnapshotSha256, @adapterId, @adapterVersion,
        @manifestSha256, @highWaterMtimeNs, @highWaterItemId, @examinedEntryCount,
        @itemCount, @supportedItemCount, @quarantinedItemCount, @blockerCodesJson,
        @status, @recordJson, @startedAt, @completedAt
      ) ON CONFLICT(workspace_id, scan_id) DO NOTHING
    `);
    this.insertItemStmt = db.prepare(`
      INSERT INTO external_source_catalog_items (
        workspace_id, scan_id, source_id, item_id, schema_version, adapter_id, adapter_version,
        normalized_relative_path, alias_paths_json, foreign_id_sha256, producer_version,
        observed_mtime_ns, file_identity_sha256, stat_fingerprint_sha256, raw_sha256,
        raw_byte_count, message_count, lineage_node_count, lineage_depth, lineage_sha256,
        disposition, reason_codes_json, catalog_item_sha256, record_json
      ) VALUES (
        @workspaceId, @scanId, @sourceId, @itemId, @schemaVersion, @adapterId, @adapterVersion,
        @normalizedRelativePath, @aliasPathsJson, @foreignIdSha256, @producerVersion,
        @observedMtimeNs, @fileIdentitySha256, @statFingerprintSha256, @rawSha256,
        @rawByteCount, @messageCount, @lineageNodeCount, @lineageDepth, @lineageSha256,
        @disposition, @reasonCodesJson, @catalogItemSha256, @recordJson
      ) ON CONFLICT(workspace_id, scan_id, item_id) DO NOTHING
    `);
    this.getScanStmt = db.prepare(`
      SELECT * FROM external_source_scans
      WHERE workspace_id = @workspaceId AND scan_id = @scanId
    `);
    this.getItemStmt = db.prepare(`
      SELECT * FROM external_source_catalog_items
      WHERE workspace_id = @workspaceId AND scan_id = @scanId AND item_id = @itemId
    `);
    this.listItemsStmt = db.prepare(`
      SELECT * FROM external_source_catalog_items
      WHERE workspace_id = @workspaceId AND scan_id = @scanId
      ORDER BY observed_mtime_ns DESC, item_id DESC
    `);
    this.listScansStmt = db.prepare(`
      SELECT * FROM external_source_scans
      WHERE workspace_id = @workspaceId AND source_id = @sourceId
      ORDER BY completed_at DESC, scan_id DESC
      LIMIT @limit
    `);
  }

  public seal(scan: ExternalSourceScanRecord, items: readonly ExternalSourceCatalogItem[]): ExternalSourceScanRecord {
    assertScanBundle(scan, items);
    return this.db.transaction("immediate", () => {
      const locked = this.configLockStmt.get({
        workspaceId: scan.workspaceId,
        sourceId: scan.sourceId,
      }) as ExternalSourceConfigLockRow | undefined;
      if (!locked || locked.source_id !== scan.sourceId) {
        throw new NotFoundError({ entity: "external source", id: scan.sourceId });
      }
      const config = this.configs.get(scan.workspaceId, scan.sourceId);
      assertCurrentConfigBinding(scan, config);
      for (const item of items) {
        if (
          item.disposition === "supported" &&
          (!item.producerVersion || !config.adapterPolicy.acceptedProducerVersions.includes(item.producerVersion))
        ) {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: `External source catalog item ${item.itemId} uses an unaccepted producer variant.`,
            details: { reason: "producer_version_conflict" },
          });
        }
      }
      this.insertScanStmt.run(toScanBindings(scan));
      for (const item of orderedCatalogItems(items)) this.insertItemStmt.run(toItemBindings(item));
      const stored = this.get(scan.workspaceId, scan.scanId);
      assertExactReplay(stored, scan, `External source scan ${scan.scanId}`);
      const storedItems = this.listItems(scan.workspaceId, scan.scanId);
      const expectedItems = orderedCatalogItems(items);
      if (canonicalJsonString(storedItems) !== canonicalJsonString(expectedItems)) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `External source scan ${scan.scanId} conflicts with an existing sealed catalog.`,
        });
      }
      if (computeExternalSourceManifestSha256(storedItems) !== stored.manifestSha256) {
        throw new Error(`External source scan ${scan.scanId} failed stored manifest verification.`);
      }
      return stored;
    });
  }

  public get(workspaceId: string, scanId: string): ExternalSourceScanRecord {
    const record = this.find(workspaceId, scanId);
    if (!record) throw new NotFoundError({ entity: "external source scan", id: scanId });
    return record;
  }

  public find(workspaceId: string, scanId: string): ExternalSourceScanRecord | undefined {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(scanId, "scanId");
    const row = this.getScanStmt.get({ workspaceId, scanId }) as ExternalSourceScanRow | undefined;
    return row ? mapAndVerifyScanRow(row) : undefined;
  }

  public getItem(workspaceId: string, scanId: string, itemId: string): ExternalSourceCatalogItem {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(scanId, "scanId");
    assertIdentifier(itemId, "itemId");
    const row = this.getItemStmt.get({ workspaceId, scanId, itemId }) as ExternalSourceCatalogItemRow | undefined;
    if (!row) throw new NotFoundError({ entity: "external source catalog item", id: itemId });
    return mapAndVerifyItemRow(row);
  }

  public listItems(workspaceId: string, scanId: string): ExternalSourceCatalogItem[] {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(scanId, "scanId");
    return (this.listItemsStmt.all({ workspaceId, scanId }) as ExternalSourceCatalogItemRow[]).map(mapAndVerifyItemRow);
  }

  public listScans(workspaceId: string, sourceId: string, limit = 100): ExternalSourceScanRecord[] {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(sourceId, "sourceId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("External source scan list limit must be an integer from 1 through 100.");
    }
    return (this.listScansStmt.all({ workspaceId, sourceId, limit }) as ExternalSourceScanRow[]).map(
      mapAndVerifyScanRow,
    );
  }

  public listPage(input: ExternalSourceCatalogPageInput): ExternalSourcePage {
    const limit = input.limit ?? EXTERNAL_SOURCE_LIMITS.defaultPageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > EXTERNAL_SOURCE_LIMITS.maxPageSize) {
      throw new TypeError(
        `External source page limit must be an integer from 1 through ${EXTERNAL_SOURCE_LIMITS.maxPageSize}.`,
      );
    }
    const scan = this.get(input.workspaceId, input.scanId);
    if (scan.sourceId !== input.sourceId) {
      throw new NotFoundError({ entity: "external source scan", id: input.scanId });
    }
    const normalizedDispositions = input.dispositions && input.dispositions.length > 0 ? input.dispositions : undefined;
    const filterMaterial = canonicalExternalSourceFilterMaterial(normalizedDispositions);
    const filterSha256 = canonicalHash(filterMaterial);
    const cursor = input.cursor ? decodeExternalSourceCursor(input.cursor) : undefined;
    if (cursor) assertCursorScope(cursor, scan, filterSha256);
    const dispositionSet = normalizedDispositions ? new Set(normalizedDispositions) : undefined;
    let items = this.listItems(input.workspaceId, input.scanId);
    if (dispositionSet) items = items.filter((item) => dispositionSet.has(item.disposition));
    if (cursor) items = items.filter((item) => isAfterDescendingPosition(item, cursor.position));
    const pageItems = items.slice(0, limit);
    const hasMore = items.length > pageItems.length;
    const highWater = scan.highWater;
    const nextCursor =
      hasMore && highWater && pageItems.length > 0
        ? encodeExternalSourceCursor({
            version: EXTERNAL_SOURCE_CURSOR_VERSION,
            workspaceId: scan.workspaceId,
            sourceId: scan.sourceId,
            scanId: scan.scanId,
            configRevision: scan.configRevision,
            adapterVersion: scan.adapterVersion,
            filterSha256,
            manifestSha256: scan.manifestSha256,
            highWater,
            position: toPosition(pageItems[pageItems.length - 1]!),
          })
        : undefined;
    const page: ExternalSourcePage = {
      schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
      workspaceId: scan.workspaceId,
      sourceId: scan.sourceId,
      scanId: scan.scanId,
      items: pageItems,
      ...(nextCursor ? { nextCursor } : {}),
    };
    assertExternalSourcePage(page);
    return page;
  }
}

function assertCurrentConfigBinding(
  scan: ExternalSourceScanRecord,
  config: ReturnType<ExternalSourceConfigRepository["get"]>,
): void {
  if (
    config.status !== "active" ||
    config.revision !== scan.configRevision ||
    config.configSha256 !== scan.configSha256 ||
    config.rootIdentitySha256 !== scan.rootIdentitySha256 ||
    config.pathBridgeSnapshotSha256 !== scan.pathBridgeSnapshotSha256 ||
    config.adapterId !== scan.adapterId ||
    config.adapterVersion !== scan.adapterVersion
  ) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `External source scan ${scan.scanId} does not match the current active source configuration.`,
      details: { reason: "source_revision_conflict" },
    });
  }
}

export function sealExternalSourceCatalogItem(input: ExternalSourceCatalogItemDraft): ExternalSourceCatalogItem {
  const item = { ...input, catalogItemSha256: canonicalHash(input) };
  assertExternalSourceCatalogItem(item);
  return item;
}

export function verifyExternalSourceCatalogItem(input: ExternalSourceCatalogItem): void {
  assertExternalSourceCatalogItem(input);
  const { catalogItemSha256: _catalogItemSha256, ...draft } = input;
  if (canonicalHash(draft) !== input.catalogItemSha256) {
    throw new Error(`External source catalog item ${input.itemId} failed hash verification.`);
  }
}

export function sealExternalSourceScanRecord(
  draft: ExternalSourceScanDraft,
  items: readonly ExternalSourceCatalogItem[],
): ExternalSourceScanRecord {
  const ordered = orderedCatalogItems(items);
  const highWater = ordered[0] ? toPosition(ordered[0]) : undefined;
  const scan: ExternalSourceScanRecord = {
    ...draft,
    manifestSha256: computeExternalSourceManifestSha256(ordered),
    ...(highWater ? { highWater } : {}),
    itemCount: ordered.length,
    supportedItemCount: ordered.filter((item) => item.disposition === "supported").length,
    quarantinedItemCount: ordered.filter((item) => item.disposition !== "supported").length,
  };
  assertExternalSourceScanRecord(scan);
  return scan;
}

export function computeExternalSourceManifestSha256(items: readonly ExternalSourceCatalogItem[]): string {
  const ordered = orderedCatalogItems(items);
  return canonicalHash(
    ordered.map((item) => ({
      itemId: item.itemId,
      catalogItemSha256: item.catalogItemSha256,
    })),
  );
}

export function encodeExternalSourceCursor(cursor: ExternalSourceCursorV1): string {
  if (!isExternalSourceCursorV1(cursor)) throw new TypeError("External source cursor is invalid.");
  const encoded = Buffer.from(canonicalJsonString(cursor), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > EXTERNAL_SOURCE_LIMITS.encodedCursorBytes) {
    throw new TypeError("External source cursor exceeds its encoded hard limit.");
  }
  return encoded;
}

export function decodeExternalSourceCursor(encoded: string): ExternalSourceCursorV1 {
  if (
    typeof encoded !== "string" ||
    !encoded ||
    Buffer.byteLength(encoded, "utf8") > EXTERNAL_SOURCE_LIMITS.encodedCursorBytes ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    throw new ExternalSourceCursorError();
  }
  let parsed: unknown;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) throw new Error("non-canonical");
    parsed = JSON.parse(decoded);
  } catch {
    throw new ExternalSourceCursorError();
  }
  if (!isExternalSourceCursorV1(parsed)) throw new ExternalSourceCursorError();
  return parsed;
}

function assertScanBundle(scan: ExternalSourceScanRecord, items: readonly ExternalSourceCatalogItem[]): void {
  assertExternalSourceScanRecord(scan);
  if (!Array.isArray(items) || items.length > EXTERNAL_SOURCE_LIMITS.catalogItemsPerScan) {
    throw new TypeError("External source scan catalog exceeds its hard limit.");
  }
  const seen = new Set<string>();
  for (const item of items) {
    verifyExternalSourceCatalogItem(item);
    if (seen.has(item.itemId)) throw new TypeError("External source scan contains duplicate item IDs.");
    seen.add(item.itemId);
    if (
      item.workspaceId !== scan.workspaceId ||
      item.sourceId !== scan.sourceId ||
      item.scanId !== scan.scanId ||
      item.adapterId !== scan.adapterId ||
      item.adapterVersion !== scan.adapterVersion
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source catalog item ${item.itemId} does not match scan ${scan.scanId}.`,
      });
    }
  }
  const expected = sealExternalSourceScanRecord(
    {
      schemaVersion: scan.schemaVersion,
      scanId: scan.scanId,
      workspaceId: scan.workspaceId,
      sourceId: scan.sourceId,
      configRevision: scan.configRevision,
      configSha256: scan.configSha256,
      rootIdentitySha256: scan.rootIdentitySha256,
      pathBridgeSnapshotSha256: scan.pathBridgeSnapshotSha256,
      adapterId: scan.adapterId,
      adapterVersion: scan.adapterVersion,
      examinedEntryCount: scan.examinedEntryCount,
      blockerCodes: scan.blockerCodes,
      status: scan.status,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt,
    },
    items,
  );
  assertExactReplay(expected, scan, `External source scan ${scan.scanId}`);
}

function assertCursorScope(cursor: ExternalSourceCursorV1, scan: ExternalSourceScanRecord, filterSha256: string): void {
  if (
    cursor.workspaceId !== scan.workspaceId ||
    cursor.sourceId !== scan.sourceId ||
    cursor.scanId !== scan.scanId ||
    cursor.configRevision !== scan.configRevision ||
    cursor.adapterVersion !== scan.adapterVersion ||
    cursor.filterSha256 !== filterSha256 ||
    cursor.manifestSha256 !== scan.manifestSha256 ||
    !scan.highWater ||
    canonicalJsonString(cursor.highWater) !== canonicalJsonString(scan.highWater)
  ) {
    throw new ExternalSourceCursorError("External source cursor does not match the sealed catalog scope.");
  }
}

function isAfterDescendingPosition(item: ExternalSourceCatalogItem, position: ExternalSourceScanHighWater): boolean {
  return compareExternalSourcePositions(toPosition(item), position) < 0;
}

function toPosition(item: ExternalSourceCatalogItem): ExternalSourceScanHighWater {
  return { observedMtimeNs: item.observedMtimeNs, itemId: item.itemId };
}

function orderedCatalogItems(items: readonly ExternalSourceCatalogItem[]): ExternalSourceCatalogItem[] {
  return [...items].sort((left, right) => -compareExternalSourcePositions(toPosition(left), toPosition(right)));
}

function toScanBindings(scan: ExternalSourceScanRecord): Record<string, unknown> {
  return {
    workspaceId: scan.workspaceId,
    scanId: scan.scanId,
    sourceId: scan.sourceId,
    schemaVersion: scan.schemaVersion,
    configRevision: scan.configRevision,
    configSha256: scan.configSha256,
    rootIdentitySha256: scan.rootIdentitySha256,
    pathBridgeSnapshotSha256: scan.pathBridgeSnapshotSha256,
    adapterId: scan.adapterId,
    adapterVersion: scan.adapterVersion,
    manifestSha256: scan.manifestSha256,
    highWaterMtimeNs: scan.highWater?.observedMtimeNs ?? null,
    highWaterItemId: scan.highWater?.itemId ?? null,
    examinedEntryCount: scan.examinedEntryCount,
    itemCount: scan.itemCount,
    supportedItemCount: scan.supportedItemCount,
    quarantinedItemCount: scan.quarantinedItemCount,
    blockerCodesJson: canonicalJsonString(scan.blockerCodes),
    status: scan.status,
    recordJson: canonicalJsonString(scan),
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
  };
}

function toItemBindings(item: ExternalSourceCatalogItem): Record<string, unknown> {
  return {
    workspaceId: item.workspaceId,
    scanId: item.scanId,
    sourceId: item.sourceId,
    itemId: item.itemId,
    schemaVersion: item.schemaVersion,
    adapterId: item.adapterId,
    adapterVersion: item.adapterVersion,
    normalizedRelativePath: item.normalizedRelativePath,
    aliasPathsJson: canonicalJsonString(item.aliasRelativePaths),
    foreignIdSha256: item.foreignIdSha256,
    producerVersion: item.producerVersion ?? null,
    observedMtimeNs: item.observedMtimeNs,
    fileIdentitySha256: item.fileIdentitySha256,
    statFingerprintSha256: item.statFingerprintSha256,
    rawSha256: item.rawSha256,
    rawByteCount: item.rawByteCount,
    messageCount: item.messageCount,
    lineageNodeCount: item.lineageNodeCount,
    lineageDepth: item.lineageDepth,
    lineageSha256: item.lineageSha256,
    disposition: item.disposition,
    reasonCodesJson: canonicalJsonString(item.reasonCodes),
    catalogItemSha256: item.catalogItemSha256,
    recordJson: canonicalJsonString(item),
  };
}

function mapAndVerifyScanRow(row: ExternalSourceScanRow): ExternalSourceScanRecord {
  const scan = safeJsonParse<ExternalSourceScanRecord | undefined>(row.record_json, undefined);
  if (!scan) throw new Error(`External source scan ${row.scan_id} contains invalid JSON.`);
  assertExternalSourceScanRecord(scan);
  const expected: Record<string, unknown> = {
    workspace_id: scan.workspaceId,
    scan_id: scan.scanId,
    source_id: scan.sourceId,
    schema_version: scan.schemaVersion,
    config_revision: scan.configRevision,
    config_sha256: scan.configSha256,
    root_identity_sha256: scan.rootIdentitySha256,
    path_bridge_snapshot_sha256: scan.pathBridgeSnapshotSha256,
    adapter_id: scan.adapterId,
    adapter_version: scan.adapterVersion,
    manifest_sha256: scan.manifestSha256,
    high_water_mtime_ns: scan.highWater?.observedMtimeNs ?? null,
    high_water_item_id: scan.highWater?.itemId ?? null,
    examined_entry_count: scan.examinedEntryCount,
    item_count: scan.itemCount,
    supported_item_count: scan.supportedItemCount,
    quarantined_item_count: scan.quarantinedItemCount,
    blocker_codes_json: canonicalJsonString(scan.blockerCodes),
    status: scan.status,
    started_at: scan.startedAt,
    completed_at: scan.completedAt,
  };
  assertIndexedColumns(row, expected, `External source scan ${row.scan_id}`);
  assertCanonicalRecordJson(row.record_json, scan, `External source scan ${row.scan_id}`);
  return scan;
}

function mapAndVerifyItemRow(row: ExternalSourceCatalogItemRow): ExternalSourceCatalogItem {
  const item = safeJsonParse<ExternalSourceCatalogItem | undefined>(row.record_json, undefined);
  if (!item) throw new Error(`External source catalog item ${row.item_id} contains invalid JSON.`);
  verifyExternalSourceCatalogItem(item);
  const expected: Record<string, unknown> = {
    workspace_id: item.workspaceId,
    scan_id: item.scanId,
    source_id: item.sourceId,
    item_id: item.itemId,
    schema_version: item.schemaVersion,
    adapter_id: item.adapterId,
    adapter_version: item.adapterVersion,
    normalized_relative_path: item.normalizedRelativePath,
    alias_paths_json: canonicalJsonString(item.aliasRelativePaths),
    foreign_id_sha256: item.foreignIdSha256,
    producer_version: item.producerVersion ?? null,
    observed_mtime_ns: item.observedMtimeNs,
    file_identity_sha256: item.fileIdentitySha256,
    stat_fingerprint_sha256: item.statFingerprintSha256,
    raw_sha256: item.rawSha256,
    raw_byte_count: item.rawByteCount,
    message_count: item.messageCount,
    lineage_node_count: item.lineageNodeCount,
    lineage_depth: item.lineageDepth,
    lineage_sha256: item.lineageSha256,
    disposition: item.disposition,
    reason_codes_json: canonicalJsonString(item.reasonCodes),
    catalog_item_sha256: item.catalogItemSha256,
  };
  assertIndexedColumns(row, expected, `External source catalog item ${row.item_id}`);
  assertCanonicalRecordJson(row.record_json, item, `External source catalog item ${row.item_id}`);
  return item;
}

function assertIndexedColumns(row: object, expected: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(expected)) {
    const raw = (row as Record<string, unknown>)[key];
    const actual = typeof value === "number" ? Number(raw) : raw;
    if (actual !== value) throw new Error(`${label} failed indexed-column verification at ${key}.`);
  }
}

function assertCanonicalRecordJson(raw: string, record: unknown, label: string): void {
  if (raw !== canonicalJsonString(record)) throw new Error(`${label} is not stored as canonical JSON.`);
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
  const material = typeof value === "string" ? value : canonicalJsonString(value);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 256) {
    throw new TypeError(`External source ${field} is invalid.`);
  }
}
