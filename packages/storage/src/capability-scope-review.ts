import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  DEFAULT_CITADEL_ID,
  NotFoundError,
  ValidationError,
  type CapabilityResourceType,
  type CapabilityScopeAssignment,
  type CapabilityScopeKind,
  type CapabilityScopeSelectionReview,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface WorkspaceBinding {
  workspace_id: string;
  citadel_id: string | null;
  revision: number;
  lifecycle_status: "active" | "archived";
}
interface CitadelBinding {
  citadel_id: string;
  lifecycle_status: "active" | "archived";
  updated_at: string;
  name: string;
  slug: string;
  description: string | null;
  kind: string;
  default_workspace_id: string | null;
  created_at: string;
  archived_at: string | null;
}
type ReadRows = (kind: CapabilityScopeKind, id: string, type: CapabilityResourceType) => CapabilityScopeAssignment[];
const conflict = (reason = "CAPABILITY_SCOPE_REVISION_CONFLICT") =>
  new ConflictError({
    code: "WRITE_CONFLICT",
    message: "The capability scope or its parent changed. Refresh and review the saved selection.",
    details: { reason },
  });

/** Selection authority only. Registry availability and runtime policy remain live owners. */
export class CapabilityScopeReviewStore {
  public constructor(
    private readonly db: DatabaseClient,
    private readonly readRows: ReadRows,
  ) {}

  public withLock<T>(kind: CapabilityScopeKind, id: string, action: () => T): T {
    return this.db.transaction("immediate", () => {
      const originalParent = kind === "citadel" ? id : this.workspace(id)?.citadel_id || DEFAULT_CITADEL_ID;
      if (this.db.dialect === "postgres") {
        // Same ordering as Citadel metadata/lifecycle: structure advisory, record row,
        // then Workspace row. Workspace lifecycle/reparent writers only lock that row.
        this.db
          .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@lockKey, 541)) AS locked")
          .get({ lockKey: `citadel-structure:${originalParent}` });
      }
      this.citadel(originalParent, true);
      if (kind === "workspace") {
        const locked = this.workspace(id, true);
        if ((locked?.citadel_id || DEFAULT_CITADEL_ID) !== originalParent) throw conflict();
      }
      if (this.db.dialect === "postgres") {
        // Also serialize legacy, unregistered scopes where there is no row to lock.
        this.db
          .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@lockKey, 542)) AS locked")
          .get({ lockKey: JSON.stringify(["capability-scope", kind, id]) });
      }
      return action();
    });
  }

  public read(
    kind: CapabilityScopeKind,
    id: string,
    type: CapabilityResourceType,
  ): CapabilityScopeSelectionReview | undefined {
    const workspace = kind === "workspace" ? this.workspace(id) : undefined;
    if (kind === "workspace" && !workspace) return undefined;
    const citadelId = kind === "citadel" ? id : workspace!.citadel_id || DEFAULT_CITADEL_ID;
    const citadel = this.citadel(citadelId);
    if (!citadel) return undefined;
    // PostgreSQL locale collation need not match SQLite. Reviewed receipts use
    // one deterministic ordering across dialects and clients; legacy lists stay unchanged.
    const order = (rows: CapabilityScopeAssignment[]) =>
      rows.sort((a, b) => (a.resourceRef < b.resourceRef ? -1 : a.resourceRef > b.resourceRef ? 1 : 0));
    const rows = order(this.readRows(kind, id, type));
    const parentRows = kind === "workspace" ? order(this.readRows("citadel", citadelId, type)) : undefined;
    const revision = createHash("sha256")
      .update(
        canonicalJsonString({
          version: "capability_scope_selection.v1",
          kind,
          id,
          type,
          citadel,
          workspace: workspace ?? null,
          rows,
          nonce: this.nonce(kind, id, type),
          parentRows: parentRows ?? null,
          parentNonce: kind === "workspace" ? this.nonce("citadel", citadelId, type) : null,
        }),
      )
      .digest("hex");
    const assignments = (records: CapabilityScopeAssignment[]) =>
      records.map(({ resourceRef, enabled }) => ({ resourceRef, enabled }));
    return {
      version: "capability_scope_selection.v1",
      revision,
      scopeKind: kind,
      scopeId: id,
      resourceType: type,
      citadelId,
      scopeLifecycleStatus: workspace?.lifecycle_status ?? citadel.lifecycle_status,
      citadelLifecycleStatus: citadel.lifecycle_status,
      assignments: assignments(rows),
      ...(parentRows ? { parentAssignments: assignments(parentRows) } : {}),
    };
  }

  public assertCurrent(
    kind: CapabilityScopeKind,
    id: string,
    type: CapabilityResourceType,
    expectedRevision: string,
  ): CapabilityScopeSelectionReview {
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))
      throw new ValidationError({ field: "expectedRevision" });
    const current = this.read(kind, id, type);
    if (!current) throw new NotFoundError({ entity: "Capability scope or Citadel parent" });
    if (current.revision !== expectedRevision) throw conflict();
    if (current.scopeLifecycleStatus !== "active" || current.citadelLifecycleStatus !== "active")
      throw conflict("CAPABILITY_SCOPE_ARCHIVED");
    return current;
  }

  public advance(kind: CapabilityScopeKind, id: string, type: CapabilityResourceType): void {
    // Private repository key, never part of exported runtime settings. Every assignment
    // writer rotates it in the same transaction, including clearing an already empty set.
    // This prevents empty -> curated -> empty ABA without creating state during reads.
    this.db
      .prepare(
        `INSERT INTO system_settings (setting_key, value_json, updated_at)
      VALUES (@key, @value, @now) ON CONFLICT(setting_key) DO UPDATE SET
      value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run({ key: this.key(kind, id, type), value: JSON.stringify(randomUUID()), now: new Date().toISOString() });
  }

  private key(kind: CapabilityScopeKind, id: string, type: CapabilityResourceType): string {
    return `capability_scope.selection_nonce.v1:${JSON.stringify([kind, id, type])}`;
  }
  private nonce(kind: CapabilityScopeKind, id: string, type: CapabilityResourceType): string | null {
    return (
      this.db
        .prepare("SELECT value_json FROM system_settings WHERE setting_key = @key")
        .get<{ value_json: string }>({ key: this.key(kind, id, type) })?.value_json ?? null
    );
  }
  private workspace(id: string, lock = false): WorkspaceBinding | undefined {
    return this.db
      .prepare(
        `SELECT workspace_id, citadel_id, revision, lifecycle_status FROM workspaces
      WHERE workspace_id = @id${lock && this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
      .get<WorkspaceBinding>({ id });
  }
  private citadel(id: string, lock = false): CitadelBinding | undefined {
    return this.db
      .prepare(
        `SELECT citadel_id, lifecycle_status, updated_at, name, slug, description, kind,
      default_workspace_id, created_at, archived_at FROM citadel_records
      WHERE citadel_id = @id${lock && this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      )
      .get<CitadelBinding>({ id });
  }
}
