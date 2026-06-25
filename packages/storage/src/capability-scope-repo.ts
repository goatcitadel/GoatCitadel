import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  CapabilityResourceType,
  CapabilityScopeAssignment,
  CapabilityScopeKind,
} from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";

interface CapabilityScopeRow {
  assignment_id: string;
  scope_kind: string;
  scope_id: string;
  resource_type: string;
  resource_ref: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CapabilityScopeItemInput {
  resourceRef: string;
  enabled: boolean;
}

function newAssignmentId(): string {
  return `csa_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export class CapabilityScopeRepository {
  private readonly listScopeStmt;
  private readonly listScopeTypeStmt;
  private readonly getStmt;
  private readonly findByKeyStmt;
  private readonly insertStmt;
  private readonly updateEnabledStmt;
  private readonly deleteStmt;
  private readonly deleteScopeTypeStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.listScopeStmt = db.prepare(`
      SELECT * FROM capability_scope_assignments
      WHERE scope_kind = @scopeKind AND scope_id = @scopeId
      ORDER BY resource_type ASC, resource_ref ASC
    `);
    this.listScopeTypeStmt = db.prepare(`
      SELECT * FROM capability_scope_assignments
      WHERE scope_kind = @scopeKind AND scope_id = @scopeId AND resource_type = @resourceType
      ORDER BY resource_ref ASC
    `);
    this.getStmt = db.prepare(`
      SELECT * FROM capability_scope_assignments WHERE assignment_id = @assignmentId
    `);
    this.findByKeyStmt = db.prepare(`
      SELECT * FROM capability_scope_assignments
      WHERE scope_kind = @scopeKind AND scope_id = @scopeId
        AND resource_type = @resourceType AND resource_ref = @resourceRef
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO capability_scope_assignments (
        assignment_id, scope_kind, scope_id, resource_type, resource_ref, enabled, created_at, updated_at
      ) VALUES (
        @assignmentId, @scopeKind, @scopeId, @resourceType, @resourceRef, @enabled, @createdAt, @updatedAt
      )
    `);
    this.updateEnabledStmt = db.prepare(`
      UPDATE capability_scope_assignments
      SET enabled = @enabled, updated_at = @updatedAt
      WHERE assignment_id = @assignmentId
    `);
    this.deleteStmt = db.prepare(`
      DELETE FROM capability_scope_assignments WHERE assignment_id = @assignmentId
    `);
    this.deleteScopeTypeStmt = db.prepare(`
      DELETE FROM capability_scope_assignments
      WHERE scope_kind = @scopeKind AND scope_id = @scopeId AND resource_type = @resourceType
    `);
  }

  public listForScope(scopeKind: CapabilityScopeKind, scopeId: string): CapabilityScopeAssignment[] {
    return toRows(this.listScopeStmt.all({ scopeKind, scopeId })).map(mapRow);
  }

  public list(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
  ): CapabilityScopeAssignment[] {
    return toRows(this.listScopeTypeStmt.all({ scopeKind, scopeId, resourceType })).map(mapRow);
  }

  public find(assignmentId: string): CapabilityScopeAssignment | undefined {
    const row = toRow(this.getStmt.get({ assignmentId }));
    return row ? mapRow(row) : undefined;
  }

  public setEnabled(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
    resourceRef: string,
    enabled: boolean,
    now = new Date().toISOString(),
  ): CapabilityScopeAssignment {
    const existing = toRow(this.findByKeyStmt.get({ scopeKind, scopeId, resourceType, resourceRef }));
    if (existing) {
      this.updateEnabledStmt.run({ assignmentId: existing.assignment_id, enabled: enabled ? 1 : 0, updatedAt: now });
      return mapRow({ ...existing, enabled: enabled ? 1 : 0, updated_at: now });
    }
    const assignmentId = newAssignmentId();
    this.insertStmt.run({
      assignmentId,
      scopeKind,
      scopeId,
      resourceType,
      resourceRef,
      enabled: enabled ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    });
    return mapRow({
      assignment_id: assignmentId,
      scope_kind: scopeKind,
      scope_id: scopeId,
      resource_type: resourceType,
      resource_ref: resourceRef,
      enabled: enabled ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
  }

  public replaceSet(
    scopeKind: CapabilityScopeKind,
    scopeId: string,
    resourceType: CapabilityResourceType,
    items: readonly CapabilityScopeItemInput[],
    now = new Date().toISOString(),
  ): CapabilityScopeAssignment[] {
    return this.db.transaction("immediate", () => {
      this.deleteScopeTypeStmt.run({ scopeKind, scopeId, resourceType });
      for (const item of items) {
        if (!item.resourceRef.trim()) {
          throw new ValidationError({ code: "FIELD_REQUIRED", field: "resourceRef" });
        }
        this.insertStmt.run({
          assignmentId: newAssignmentId(),
          scopeKind,
          scopeId,
          resourceType,
          resourceRef: item.resourceRef,
          enabled: item.enabled ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        });
      }
      return this.list(scopeKind, scopeId, resourceType);
    });
  }

  public clear(scopeKind: CapabilityScopeKind, scopeId: string, resourceType: CapabilityResourceType): number {
    return Number(this.deleteScopeTypeStmt.run({ scopeKind, scopeId, resourceType }).changes ?? 0);
  }

  public delete(assignmentId: string): boolean {
    return Number(this.deleteStmt.run({ assignmentId }).changes ?? 0) > 0;
  }
}

function mapRow(row: CapabilityScopeRow): CapabilityScopeAssignment {
  return {
    assignmentId: row.assignment_id,
    scopeKind: row.scope_kind as CapabilityScopeKind,
    scopeId: row.scope_id,
    resourceType: row.resource_type as CapabilityResourceType,
    resourceRef: row.resource_ref,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(value: unknown): CapabilityScopeRow | undefined {
  return isRow(value) ? value : undefined;
}

function toRows(value: unknown): CapabilityScopeRow[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

function isRow(value: unknown): value is CapabilityScopeRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.assignment_id === "string" &&
    typeof v.scope_kind === "string" &&
    typeof v.scope_id === "string" &&
    typeof v.resource_type === "string" &&
    typeof v.resource_ref === "string" &&
    typeof v.enabled === "number" &&
    typeof v.created_at === "string" &&
    typeof v.updated_at === "string"
  );
}
