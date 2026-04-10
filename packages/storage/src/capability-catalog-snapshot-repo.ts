import type { CapabilityCatalogSnapshotRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseSync } from "node:sqlite";
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

  public constructor(private readonly db: DatabaseSync) {
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
    const row = this.getStmt.get(snapshotId) as CapabilityCatalogSnapshotRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "capability catalog snapshot", id: snapshotId });
    }
    return mapSnapshotRow(row);
  }

  public find(snapshotId: string): CapabilityCatalogSnapshotRecord | undefined {
    const row = this.getStmt.get(snapshotId) as CapabilityCatalogSnapshotRow | undefined;
    return row ? mapSnapshotRow(row) : undefined;
  }
}

function mapSnapshotRow(row: CapabilityCatalogSnapshotRow): CapabilityCatalogSnapshotRecord {
  return {
    snapshotId: row.snapshot_id,
    inspectableEntries: safeJsonParse(row.inspectable_json, []),
    callableEntries: safeJsonParse(row.callable_json, []),
    createdAt: row.created_at,
  };
}
