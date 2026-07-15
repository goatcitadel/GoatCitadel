import type {
  ApprovalCreateInput,
  ApprovalExplanation,
  ApprovalExplanationStatus,
  ApprovalListResponse,
  ApprovalRequest,
  ApprovalResolveInput,
  ShellCommandExplanation,
} from "@goatcitadel/contracts";
import {
  APPROVAL_EXPIRY_ACTOR_ID,
  ConflictError,
  MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND,
  NotFoundError,
  ValidationError,
  canonicalJsonString,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import { safeJsonParse } from "./safe-json.js";

const APPROVAL_LINKAGE_KEY = "__gcApprovalLinkage";

interface ApprovalRow {
  approval_id: string;
  kind: string;
  risk_level: ApprovalRequest["riskLevel"];
  status: ApprovalRequest["status"];
  linkage_json: string | null;
  payload_json: string;
  preview_json: string;
  explanation_status: ApprovalExplanationStatus;
  explanation_json: string | null;
  explanation_error: string | null;
  explanation_updated_at: string | null;
  created_at: string;
  expires_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  shell_explanations_json: string | null;
}

interface ApprovalPageCursor {
  createdAt: string;
  approvalId: string;
}

export interface DeterministicDetachedApprovalCreateInput extends Omit<
  ApprovalCreateInput,
  "expiresAt" | "rollbackNote"
> {
  approvalId: string;
}

export interface DeterministicDetachedApprovalCreateResult {
  approval: ApprovalRequest;
  created: boolean;
}

export class ApprovalRepository {
  private readonly createStmt;
  private readonly createDeterministicDetachedStmt;
  private readonly databaseTtlWindowStmt;
  private readonly listStmt;
  private readonly listByStatusStmt;
  private readonly listActivePendingStmt;
  private readonly listExpiredPendingStmt;
  private readonly listPageStmt;
  private readonly listPageAfterStmt;
  private readonly listPageByStatusStmt;
  private readonly listPageByStatusAfterStmt;
  private readonly listActivePendingPageStmt;
  private readonly listActivePendingPageAfterStmt;
  private readonly getStmt;
  private readonly getForUpdateStmt;
  private readonly isExpiredPendingStmt;
  private readonly resolveStmt;
  private readonly updatePayloadStmt;
  private readonly markExplanationPendingStmt;
  private readonly setExplanationStmt;
  private readonly setExplanationFailedStmt;
  private readonly setShellExplanationsStmt;

  public constructor(private readonly db: DatabaseClient) {
    const expiresAtValue = db.dialect === "postgres" ? "expires_at_ts" : "julianday(expires_at)";
    const databaseNowInstant = db.dialect === "postgres" ? "statement_timestamp()" : "julianday('now')";
    const databaseNowText =
      db.dialect === "postgres"
        ? `to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    const optionalExcludedKind = db.dialect === "postgres" ? "CAST(@excludedKind AS TEXT)" : "@excludedKind";
    this.createStmt = db.prepare(`
      INSERT INTO approvals (
        approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
        explanation_status, created_at, expires_at
      ) VALUES (
        @approvalId, @kind, @riskLevel, @status, @linkageJson, @payloadJson, @previewJson,
        @explanationStatus, @createdAt, @expiresAt
      )
    `);
    this.createDeterministicDetachedStmt = db.prepare(`
      INSERT INTO approvals (
        approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
        explanation_status, created_at, expires_at
      ) VALUES (
        @approvalId, @kind, @riskLevel, 'pending', @linkageJson, @payloadJson, @previewJson,
        'not_requested', @createdAt, @expiresAt
      )
      ON CONFLICT (approval_id) DO NOTHING
    `);
    const databaseExpiryText =
      db.dialect === "postgres"
        ? `to_char(
            (statement_timestamp() + (CAST(@ttlMs AS DOUBLE PRECISION) * INTERVAL '1 millisecond'))
              AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )`
        : "strftime('%Y-%m-%dT%H:%M:%fZ', julianday('now') + (CAST(@ttlMs AS REAL) / 86400000.0))";
    this.databaseTtlWindowStmt = db.prepare(`
      SELECT ${databaseNowText} AS created_at, ${databaseExpiryText} AS expires_at
    `);
    this.listStmt = db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT @limit");
    this.listByStatusStmt = db.prepare(
      "SELECT * FROM approvals WHERE status = @status ORDER BY created_at DESC LIMIT @limit",
    );
    this.listActivePendingStmt = db.prepare(`
      SELECT * FROM approvals
      WHERE status = 'pending'
        AND (
          expires_at IS NULL
          OR (${expiresAtValue} IS NOT NULL AND ${expiresAtValue} > ${databaseNowInstant})
        )
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listExpiredPendingStmt = db.prepare(`
      SELECT * FROM approvals
      WHERE status = 'pending'
        AND expires_at IS NOT NULL
        AND (${expiresAtValue} IS NULL OR ${expiresAtValue} <= ${databaseNowInstant})
        AND (${optionalExcludedKind} IS NULL OR kind <> ${optionalExcludedKind})
      ORDER BY ${expiresAtValue} ASC, approval_id ASC
      LIMIT @limit
    `);
    this.listPageStmt = db.prepare("SELECT * FROM approvals ORDER BY created_at DESC, approval_id DESC LIMIT @limit");
    this.listPageAfterStmt = db.prepare(`
      SELECT * FROM approvals
      WHERE created_at < @createdAt
         OR (created_at = @createdAt AND approval_id < @approvalId)
      ORDER BY created_at DESC, approval_id DESC
      LIMIT @limit
    `);
    this.listPageByStatusStmt = db.prepare(`
      SELECT * FROM approvals
      WHERE status = @status
      ORDER BY created_at DESC, approval_id DESC
      LIMIT @limit
    `);
    this.listPageByStatusAfterStmt = db.prepare(`
      SELECT * FROM approvals
      WHERE status = @status
        AND (
          created_at < @createdAt
          OR (created_at = @createdAt AND approval_id < @approvalId)
        )
      ORDER BY created_at DESC, approval_id DESC
      LIMIT @limit
    `);
    this.listActivePendingPageStmt = db.prepare(`
      SELECT * FROM approvals
      WHERE status = 'pending'
        AND (
          expires_at IS NULL
          OR (${expiresAtValue} IS NOT NULL AND ${expiresAtValue} > ${databaseNowInstant})
        )
      ORDER BY created_at DESC, approval_id DESC
      LIMIT @limit
    `);
    this.listActivePendingPageAfterStmt = db.prepare(`
      SELECT * FROM approvals
      WHERE status = 'pending'
        AND (
          expires_at IS NULL
          OR (${expiresAtValue} IS NOT NULL AND ${expiresAtValue} > ${databaseNowInstant})
        )
        AND (
          created_at < @createdAt
          OR (created_at = @createdAt AND approval_id < @approvalId)
        )
      ORDER BY created_at DESC, approval_id DESC
      LIMIT @limit
    `);
    this.getStmt = db.prepare("SELECT * FROM approvals WHERE approval_id = ?");
    this.getForUpdateStmt = db.prepare(
      `SELECT * FROM approvals WHERE approval_id = ?${db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
    );
    this.isExpiredPendingStmt = db.prepare(`
      SELECT approval_id
      FROM approvals
      WHERE approval_id = ?
        AND status = 'pending'
        AND expires_at IS NOT NULL
        AND (${expiresAtValue} IS NULL OR ${expiresAtValue} <= ${databaseNowInstant})
    `);
    this.resolveStmt = db.prepare(`
      UPDATE approvals SET
        status = @status,
        linkage_json = @linkageJson,
        payload_json = @payloadJson,
        resolved_at = ${databaseNowText},
        resolved_by = @resolvedBy,
        resolution_note = @resolutionNote
      WHERE approval_id = @approvalId
        AND status = 'pending'
        AND (
          @allowExpired = 1
          OR expires_at IS NULL
          OR (${expiresAtValue} IS NOT NULL AND ${expiresAtValue} > ${databaseNowInstant})
        )
    `);
    this.updatePayloadStmt = db.prepare(`
      UPDATE approvals SET
        linkage_json = @linkageJson,
        payload_json = @payloadJson
      WHERE approval_id = @approvalId
    `);
    this.markExplanationPendingStmt = db.prepare(`
      UPDATE approvals SET
        explanation_status = 'pending',
        explanation_error = NULL,
        explanation_updated_at = @updatedAt
      WHERE approval_id = @approvalId
        AND explanation_status = 'not_requested'
    `);
    this.setExplanationStmt = db.prepare(`
      UPDATE approvals SET
        explanation_status = 'completed',
        explanation_json = @explanationJson,
        explanation_error = NULL,
        explanation_updated_at = @updatedAt
      WHERE approval_id = @approvalId
    `);
    this.setExplanationFailedStmt = db.prepare(`
      UPDATE approvals SET
        explanation_status = 'failed',
        explanation_error = @explanationError,
        explanation_updated_at = @updatedAt
      WHERE approval_id = @approvalId
    `);
    this.setShellExplanationsStmt = db.prepare(`
      UPDATE approvals SET
        shell_explanations_json = @shellExplanationsJson
      WHERE approval_id = @approvalId
    `);
  }

  public setShellExplanations(approvalId: string, explanations: readonly ShellCommandExplanation[]): boolean {
    const result = this.setShellExplanationsStmt.run({
      approvalId,
      shellExplanationsJson: JSON.stringify(explanations),
    });
    return result.changes > 0;
  }

  public create(input: ApprovalCreateInput): ApprovalRequest {
    return this.createAt(input, new Date().toISOString());
  }

  public createWithTtlDuration(input: Omit<ApprovalCreateInput, "expiresAt">, ttlMs: number): ApprovalRequest {
    const normalizedTtlMs = normalizeApprovalTtlMs(ttlMs);
    return this.db.transaction("immediate", () => {
      const window = this.readDatabaseTtlWindow(normalizedTtlMs);
      return this.createAt({ ...input, expiresAt: window.expires_at }, window.created_at);
    });
  }

  /**
   * Creates one exact-ID approval without embedding linkage into payload bytes.
   * This intentionally bypasses the random-ID generic create path so a
   * higher-level owner can make exact request replay collide on one stable ID.
   */
  public createDeterministicDetachedWithTtlDuration(
    input: DeterministicDetachedApprovalCreateInput,
    ttlMs: number,
  ): DeterministicDetachedApprovalCreateResult {
    assertDeterministicDetachedApprovalInput(input);
    const normalizedTtlMs = normalizeApprovalTtlMs(ttlMs);
    const serialized = {
      linkageJson: input.linkage === undefined ? null : canonicalJsonString(input.linkage),
      payloadJson: canonicalJsonString(input.payload),
      previewJson: canonicalJsonString(input.preview),
    };

    return this.db.transaction("immediate", () => {
      const existing = toApprovalRow(this.getForUpdateStmt.get(input.approvalId));
      if (existing) {
        return {
          approval: mapExactDetachedReplay(existing, input, serialized),
          created: false,
        };
      }

      const window = this.readDatabaseTtlWindow(normalizedTtlMs);
      const inserted = this.createDeterministicDetachedStmt.run({
        approvalId: input.approvalId,
        kind: input.kind,
        riskLevel: input.riskLevel,
        linkageJson: serialized.linkageJson,
        payloadJson: serialized.payloadJson,
        previewJson: serialized.previewJson,
        createdAt: window.created_at,
        expiresAt: window.expires_at,
      });
      const stored = toApprovalRow(this.getForUpdateStmt.get(input.approvalId));
      if (!stored) {
        throw new Error(`Approval ${input.approvalId} was not readable after deterministic creation.`);
      }
      return {
        approval: mapExactDetachedReplay(stored, input, serialized),
        created: inserted.changes > 0,
      };
    });
  }

  private readDatabaseTtlWindow(ttlMs: number): { created_at: string; expires_at: string } {
    const window = this.databaseTtlWindowStmt.get({ ttlMs }) as { created_at: string; expires_at: string } | undefined;
    if (!window?.created_at || !window.expires_at) {
      throw new Error("Database did not return an approval TTL window.");
    }
    return window;
  }

  private createAt(input: ApprovalCreateInput, now: string): ApprovalRequest {
    const approvalId = randomUUID();
    this.createStmt.run({
      approvalId,
      kind: input.kind,
      riskLevel: input.riskLevel,
      status: "pending",
      linkageJson: serializeApprovalLinkage(input.linkage),
      payloadJson: JSON.stringify(
        input.kind === "skill_hub.lifecycle"
          ? stripApprovalLinkage(input.payload)
          : embedApprovalLinkage(
              input.rollbackNote ? { ...input.payload, rollbackNote: input.rollbackNote } : input.payload,
              input.linkage,
            ),
      ),
      previewJson: JSON.stringify(input.preview),
      explanationStatus: "not_requested",
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
    });

    return this.get(approvalId);
  }

  public get(approvalId: string): ApprovalRequest {
    const row = toApprovalRow(this.getStmt.get(approvalId));
    if (!row) {
      throw new NotFoundError({ entity: "Approval", id: approvalId });
    }

    return mapRow(row);
  }

  /**
   * Locks and returns a pending approval for a transaction-owned dependent
   * write, such as remote-token issuance. Callers must invoke this from an
   * immediate transaction and commit the dependent rows in that same owner.
   */
  public lockPendingForUpdate(approvalId: string): ApprovalRequest {
    const approval = this.getForUpdate(approvalId);
    if (approval.status !== "pending") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `Approval ${approvalId} is already resolved`,
      });
    }
    return approval;
  }

  public list(status?: ApprovalRequest["status"], limit = 100, workspaceId?: string): ApprovalRequest[] {
    const scopedWorkspaceId = workspaceId?.trim();
    // The workspace lives inside linkage_json, so a workspace-scoped list filters in memory.
    // Over-fetch when scoping so the post-filter `limit` still returns a full page where possible.
    const fetchLimit = scopedWorkspaceId ? Math.max(limit * 10, 1000) : limit;
    const rows = toApprovalRows(
      status === "pending"
        ? this.listActivePendingStmt.all({ limit: fetchLimit })
        : status
          ? this.listByStatusStmt.all({
              status,
              limit: fetchLimit,
            })
          : this.listStmt.all({
              limit: fetchLimit,
            }),
    );
    const mapped = rows.map(mapRow);
    if (!scopedWorkspaceId) {
      return mapped;
    }
    return mapped.filter((approval) => approval.linkage?.workspaceId === scopedWorkspaceId).slice(0, limit);
  }

  public listExpiredPending(now = new Date().toISOString(), limit = 100, excludedKind?: string): ApprovalRequest[] {
    // Keep the legacy `now` argument for API compatibility, but never let a
    // caller clock decide whether an approval has expired.
    void now;
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 100;
    return toApprovalRows(
      this.listExpiredPendingStmt.all({
        limit: boundedLimit,
        excludedKind: excludedKind?.trim() || null,
      }),
    ).map(mapRow);
  }

  public isExpiredPendingAtDatabaseNow(approvalId: string): boolean {
    return Boolean(this.isExpiredPendingStmt.get(approvalId));
  }

  public listPage(input: {
    status?: ApprovalRequest["status"];
    limit?: number;
    cursor?: string;
    workspaceId?: string;
  }): ApprovalListResponse {
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), 200));
    const scopedWorkspaceId = input.workspaceId?.trim();
    const output: ApprovalRequest[] = [];
    let cursor = decodeApprovalListCursor(input.cursor);
    let nextCursor: string | undefined;

    do {
      const remaining = limit - output.length;
      const fetchLimit = scopedWorkspaceId
        ? Math.max(Math.min(remaining * 10 + 1, 1000), remaining + 1)
        : remaining + 1;
      const mapped = this.readApprovalPage(input.status, fetchLimit, cursor);
      const accepted = scopedWorkspaceId
        ? mapped.filter((approval) => approval.linkage?.workspaceId === scopedWorkspaceId)
        : mapped;
      const acceptedCapacity = Math.max(0, limit - output.length);
      const appended = accepted.slice(0, acceptedCapacity);
      output.push(...appended);

      const lastReturned = appended.at(-1);
      const lastScanned = mapped.at(-1);
      const scannedMoreThanReturned = Boolean(
        lastReturned && lastScanned && lastReturned.approvalId !== lastScanned.approvalId,
      );
      const hasMoreScannedRows = mapped.length === fetchLimit;
      if (output.length >= limit) {
        nextCursor =
          lastReturned && (accepted.length > appended.length || scannedMoreThanReturned || hasMoreScannedRows)
            ? encodeApprovalListCursor(lastReturned)
            : undefined;
        break;
      }
      if (!lastScanned || !hasMoreScannedRows) {
        nextCursor = undefined;
        break;
      }
      nextCursor = encodeApprovalListCursor(lastScanned);
      cursor = decodeApprovalListCursor(nextCursor);
    } while (scopedWorkspaceId && output.length < limit && nextCursor);

    return {
      items: output,
      nextCursor,
    };
  }

  private readApprovalPage(
    status: ApprovalRequest["status"] | undefined,
    limit: number,
    cursor?: ApprovalPageCursor,
  ): ApprovalRequest[] {
    const rows = toApprovalRows(
      status === "pending"
        ? cursor
          ? this.listActivePendingPageAfterStmt.all({
              limit,
              createdAt: cursor.createdAt,
              approvalId: cursor.approvalId,
            })
          : this.listActivePendingPageStmt.all({ limit })
        : status
          ? cursor
            ? this.listPageByStatusAfterStmt.all({
                status,
                limit,
                createdAt: cursor.createdAt,
                approvalId: cursor.approvalId,
              })
            : this.listPageByStatusStmt.all({ status, limit })
          : cursor
            ? this.listPageAfterStmt.all({
                limit,
                createdAt: cursor.createdAt,
                approvalId: cursor.approvalId,
              })
            : this.listPageStmt.all({ limit }),
    );
    return rows.map(mapRow);
  }

  public resolve(
    approvalId: string,
    input: ApprovalResolveInput,
    options?: { resolvedAt?: string; allowExpired?: boolean },
  ): ApprovalRequest {
    if (options?.allowExpired && (input.decision !== "reject" || input.resolvedBy !== APPROVAL_EXPIRY_ACTOR_ID)) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "allowExpired",
        message: "Expired approvals may only be rejected by the system expiry reconciler.",
      });
    }
    return this.db.transaction("immediate", () => {
      const currentRow = this.getForUpdateRow(approvalId);
      const current = mapRow(currentRow);
      // Retain the option in the public shape for compatibility. Canonical
      // resolution time and expiry comparison are both owned by the database.
      void options?.resolvedAt;

      const exactDetachedActivation = current.kind === MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND;
      if (exactDetachedActivation && (input.decision === "edit" || input.editedPayload !== undefined)) {
        throw new ValidationError({
          code: "FIELD_INVALID",
          field: "editedPayload",
          message: "Mesh capability activation approvals are immutable; reject and create a new activation request.",
        });
      }

      const status: ApprovalRequest["status"] =
        input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "edited";

      const changed = this.resolveStmt.run({
        approvalId,
        status,
        linkageJson: exactDetachedActivation ? currentRow.linkage_json : serializeApprovalLinkage(current.linkage),
        payloadJson: exactDetachedActivation
          ? currentRow.payload_json
          : JSON.stringify(
              current.kind === "skill_hub.lifecycle"
                ? stripApprovalLinkage(input.editedPayload ?? current.payload)
                : embedApprovalLinkage(input.editedPayload ?? current.payload, current.linkage),
            ),
        resolvedBy: input.resolvedBy,
        resolutionNote: input.resolutionNote ?? null,
        allowExpired: options?.allowExpired ? 1 : 0,
      }).changes;

      if (changed < 1) {
        const latest = this.get(approvalId);
        if (latest.status === "pending" && !options?.allowExpired && this.isExpiredPendingAtDatabaseNow(approvalId)) {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: `Approval ${approvalId} has expired and can no longer be resolved`,
            details: { reason: "approval_expired", approvalId },
          });
        }
        throw new ConflictError({ code: "STATE_CONFLICT", message: `Approval ${approvalId} is already resolved` });
      }

      return this.get(approvalId);
    });
  }

  public mergeLinkage(approvalId: string, linkagePatch: NonNullable<ApprovalRequest["linkage"]>): ApprovalRequest {
    return this.db.transaction("immediate", () => {
      const row = this.getForUpdateRow(approvalId);
      if (row.kind === MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND) {
        throw new ValidationError({
          code: "FIELD_INVALID",
          field: "linkage",
          message: "Mesh capability activation approval linkage is immutable.",
        });
      }
      const payload = safeJsonParse<Record<string, unknown>>(row.payload_json, {});
      const currentLinkage = deserializeApprovalLinkage(row.linkage_json) ?? readApprovalLinkage(payload) ?? {};
      const nextLinkage = {
        ...currentLinkage,
        ...Object.fromEntries(
          Object.entries(linkagePatch).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
        ),
      };
      this.updatePayloadStmt.run({
        approvalId,
        linkageJson: serializeApprovalLinkage(nextLinkage),
        payloadJson: JSON.stringify(
          row.kind === "skill_hub.lifecycle"
            ? stripApprovalLinkage(payload)
            : embedApprovalLinkage(payload, nextLinkage),
        ),
      });
      return this.get(approvalId);
    });
  }

  private getForUpdate(approvalId: string): ApprovalRequest {
    return mapRow(this.getForUpdateRow(approvalId));
  }

  private getForUpdateRow(approvalId: string): ApprovalRow {
    const row = toApprovalRow(this.getForUpdateStmt.get(approvalId));
    if (!row) {
      throw new NotFoundError({ entity: "Approval", id: approvalId });
    }
    return row;
  }

  public markExplanationPending(approvalId: string): boolean {
    const changed = this.markExplanationPendingStmt.run({
      approvalId,
      updatedAt: new Date().toISOString(),
    }).changes;

    return changed > 0;
  }

  public setExplanation(approvalId: string, explanation: ApprovalExplanation): ApprovalRequest {
    this.setExplanationStmt.run({
      approvalId,
      explanationJson: JSON.stringify(explanation),
      updatedAt: new Date().toISOString(),
    });
    return this.get(approvalId);
  }

  public setExplanationFailed(approvalId: string, explanationError: string): ApprovalRequest {
    this.setExplanationFailedStmt.run({
      approvalId,
      explanationError,
      updatedAt: new Date().toISOString(),
    });
    return this.get(approvalId);
  }
}

function normalizeApprovalTtlMs(ttlMs: number): number {
  const normalizedTtlMs = Math.floor(ttlMs);
  if (!Number.isFinite(normalizedTtlMs) || normalizedTtlMs <= 0) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "ttlMs",
      message: "ttlMs must be a positive duration.",
    });
  }
  return normalizedTtlMs;
}

function assertDeterministicDetachedApprovalInput(input: DeterministicDetachedApprovalCreateInput): void {
  assertSafePlainApprovalRecord(input, "approval");
  const allowedKeys = new Set(["approvalId", "kind", "riskLevel", "payload", "preview", "linkage"]);
  const keys = Object.getOwnPropertyNames(input);
  if (
    keys.some((key) => !allowedKeys.has(key)) ||
    ["approvalId", "kind", "riskLevel", "payload", "preview"].some((key) => !keys.includes(key))
  ) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "approval",
      message: "Deterministic detached approval input has an invalid key set.",
    });
  }
  assertCanonicalApprovalIdentifier(input.approvalId, "approvalId");
  assertCanonicalApprovalIdentifier(input.kind, "kind");
  if (!(["safe", "caution", "danger", "nuclear"] as const).includes(input.riskLevel)) {
    throw new ValidationError({ code: "FIELD_INVALID", field: "riskLevel" });
  }
  assertSafePlainApprovalRecord(input.payload, "payload");
  assertSafePlainApprovalRecord(input.preview, "preview");
  if (input.linkage !== undefined) assertSafePlainApprovalRecord(input.linkage, "linkage");
}

function assertCanonicalApprovalIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
}

function assertSafePlainApprovalRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
  assertSafeApprovalJsonValue(value, field, new Set<object>());
}

function assertSafeApprovalJsonValue(value: unknown, field: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
  if (typeof value !== "object" || isProxy(value)) {
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype) || seen.has(value)) {
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new ValidationError({ code: "FIELD_INVALID", field });
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (isArray) {
      const length = descriptors.length?.value;
      const elementKeys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        elementKeys.length !== length ||
        elementKeys.some((key, index) => key !== String(index))
      ) {
        throw new ValidationError({ code: "FIELD_INVALID", field });
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (isArray && key === "length") continue;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new ValidationError({ code: "FIELD_INVALID", field });
      }
      assertSafeApprovalJsonValue(descriptor.value, field, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function mapExactDetachedReplay(
  row: ApprovalRow,
  input: DeterministicDetachedApprovalCreateInput,
  serialized: { linkageJson: string | null; payloadJson: string; previewJson: string },
): ApprovalRequest {
  if (
    row.kind !== input.kind ||
    row.risk_level !== input.riskLevel ||
    row.linkage_json !== serialized.linkageJson ||
    row.payload_json !== serialized.payloadJson ||
    row.preview_json !== serialized.previewJson
  ) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Approval ${input.approvalId} already exists with different immutable request bytes.`,
    });
  }
  return mapRow(row);
}

function encodeApprovalListCursor(approval: Pick<ApprovalRequest, "approvalId" | "createdAt">): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: approval.createdAt,
      approvalId: approval.approvalId,
    } satisfies ApprovalPageCursor),
    "utf8",
  ).toString("base64url");
}

function decodeApprovalListCursor(cursor?: string): ApprovalPageCursor | undefined {
  if (!cursor?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ApprovalPageCursor>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.approvalId !== "string") {
      return undefined;
    }
    return {
      createdAt: parsed.createdAt,
      approvalId: parsed.approvalId,
    };
  } catch {
    return undefined;
  }
}

function mapRow(row: ApprovalRow): ApprovalRequest {
  const explanation = safeJsonParse<ApprovalExplanation | undefined>(row.explanation_json, undefined);
  const rawPayload = safeJsonParse<Record<string, unknown>>(row.payload_json, {});
  const rawPreview = safeJsonParse<Record<string, unknown>>(row.preview_json, {});
  const linkage =
    deserializeApprovalLinkage(row.linkage_json) ?? readApprovalLinkage(rawPayload) ?? readApprovalLinkage(rawPreview);
  const shellExplanations = safeJsonParse<readonly ShellCommandExplanation[] | undefined>(
    row.shell_explanations_json,
    undefined,
  );

  return {
    approvalId: row.approval_id,
    kind: row.kind,
    riskLevel: row.risk_level,
    status: row.status,
    payload: stripApprovalLinkage(rawPayload),
    preview: stripApprovalLinkage(rawPreview),
    rollbackNote: readApprovalString(rawPayload.rollbackNote ?? rawPreview.rollbackNote),
    linkage,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    resolutionNote: row.resolution_note ?? undefined,
    explanationStatus: row.explanation_status,
    explanation,
    explanationError: row.explanation_error ?? undefined,
    shellExplanations,
  };
}

function readApprovalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toApprovalRow(row: unknown): ApprovalRow | undefined {
  if (row !== undefined && !isApprovalRow(row)) {
    throw new TypeError("Unexpected approvals row shape");
  }
  return row;
}

function toApprovalRows(rows: unknown): ApprovalRow[] {
  if (!Array.isArray(rows) || rows.some((row) => !isApprovalRow(row))) {
    throw new TypeError("Unexpected approvals row shape");
  }
  return rows;
}

function isApprovalRow(value: unknown): value is ApprovalRow {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.approval_id === "string" &&
    typeof value.kind === "string" &&
    typeof value.risk_level === "string" &&
    typeof value.status === "string" &&
    (typeof value.linkage_json === "string" || value.linkage_json === null) &&
    typeof value.payload_json === "string" &&
    typeof value.preview_json === "string" &&
    typeof value.explanation_status === "string" &&
    (typeof value.explanation_json === "string" || value.explanation_json === null) &&
    (typeof value.explanation_error === "string" || value.explanation_error === null) &&
    (typeof value.explanation_updated_at === "string" || value.explanation_updated_at === null) &&
    typeof value.created_at === "string" &&
    (typeof value.expires_at === "string" || value.expires_at === null) &&
    (typeof value.resolved_at === "string" || value.resolved_at === null) &&
    (typeof value.resolved_by === "string" || value.resolved_by === null) &&
    (typeof value.resolution_note === "string" || value.resolution_note === null) &&
    (typeof value.shell_explanations_json === "string" ||
      value.shell_explanations_json === null ||
      value.shell_explanations_json === undefined)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function embedApprovalLinkage(
  payload: Record<string, unknown>,
  linkage?: ApprovalRequest["linkage"],
): Record<string, unknown> {
  if (!linkage) {
    return stripApprovalLinkage(payload);
  }
  const normalizedLinkage = Object.fromEntries(
    Object.entries(linkage).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  );
  if (Object.keys(normalizedLinkage).length === 0) {
    return stripApprovalLinkage(payload);
  }
  return {
    ...stripApprovalLinkage(payload),
    [APPROVAL_LINKAGE_KEY]: normalizedLinkage,
  };
}

function readApprovalLinkage(payload: Record<string, unknown>): ApprovalRequest["linkage"] | undefined {
  const candidate = payload[APPROVAL_LINKAGE_KEY];
  return normalizeApprovalLinkage(candidate);
}

function stripApprovalLinkage(payload: Record<string, unknown>): Record<string, unknown> {
  if (!(APPROVAL_LINKAGE_KEY in payload)) {
    return payload;
  }
  const next = { ...payload };
  delete next[APPROVAL_LINKAGE_KEY];
  return next;
}

function serializeApprovalLinkage(linkage?: ApprovalRequest["linkage"]): string | null {
  const normalized = normalizeApprovalLinkage(linkage);
  return normalized ? JSON.stringify(normalized) : null;
}

function deserializeApprovalLinkage(raw: string | null): ApprovalRequest["linkage"] | undefined {
  if (!raw) {
    return undefined;
  }
  return normalizeApprovalLinkage(safeJsonParse<unknown>(raw, undefined));
}

function normalizeApprovalLinkage(candidate: unknown): ApprovalRequest["linkage"] | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  const normalized = Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
