import type { CapabilityCatalogSnapshotRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface CapabilityCatalogSnapshotRow {
  snapshot_id: string;
  inspectable_json: string;
  callable_json: string;
  created_at: string;
}

export class CapabilityCatalogSnapshotRepository {
  private readonly insertStmt;
  private readonly getStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO capability_catalog_snapshots (
        snapshot_id, inspectable_json, callable_json, created_at
      ) VALUES (
        @snapshotId, @inspectableJson, @callableJson, @createdAt
      )
      ON CONFLICT(snapshot_id) DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM capability_catalog_snapshots WHERE snapshot_id = ?");
  }

  public create(input: CapabilityCatalogSnapshotRecord): CapabilityCatalogSnapshotRecord {
    this.insertStmt.run({
      snapshotId: input.snapshotId,
      inspectableJson: JSON.stringify(input.inspectableEntries),
      callableJson: JSON.stringify(input.callableEntries),
      createdAt: input.createdAt,
    });
    return this.get(input.snapshotId);
  }

  public get(snapshotId: string): CapabilityCatalogSnapshotRecord {
    const row = toSnapshotRow(this.getStmt.get(snapshotId));
    if (!row) {
      throw new NotFoundError({ entity: "capability catalog snapshot", id: snapshotId });
    }
    return mapSnapshotRow(row);
  }

  public find(snapshotId: string): CapabilityCatalogSnapshotRecord | undefined {
    const row = toSnapshotRow(this.getStmt.get(snapshotId));
    return row ? mapSnapshotRow(row) : undefined;
  }
}

function mapSnapshotRow(row: CapabilityCatalogSnapshotRow): CapabilityCatalogSnapshotRecord {
  return {
    snapshotId: row.snapshot_id,
    inspectableEntries: parseEntries(row.inspectable_json),
    callableEntries: parseEntries(row.callable_json),
    createdAt: row.created_at,
  };
}

function parseEntries(raw: string): CapabilityCatalogSnapshotRecord["inspectableEntries"] {
  const parsed = safeJsonParse<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

function toSnapshotRow(value: unknown): CapabilityCatalogSnapshotRow | undefined {
  return isSnapshotRow(value) ? value : undefined;
}

function isSnapshotRow(value: unknown): value is CapabilityCatalogSnapshotRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.snapshot_id === "string" &&
    typeof value.inspectable_json === "string" &&
    typeof value.callable_json === "string" &&
    typeof value.created_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
