import type { MailDraftRecord } from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

type MailDraftStatus = MailDraftRecord["status"];

export interface MailDraftTransition {
  status: MailDraftStatus;
  approvalId?: string;
  failureReason?: string;
  /** Clears any stored failure reason (for example on a `failed` -> `sent` transition); excludes `failureReason`. */
  clearFailureReason?: boolean;
  sentAt?: string;
  updatedAt: string;
}

interface MailDraftRow {
  draft_id: string;
  workspace_id: string | null;
  account_id: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  body_text: string;
  approval_id: string | null;
  status: MailDraftStatus;
  failure_reason: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

const MAIL_DRAFT_STATUSES: readonly MailDraftStatus[] = [
  "draft",
  "approval_required",
  "sent",
  "failed",
  "send_unavailable",
];

type PreparedStatement = ReturnType<DatabaseClient["prepare"]>;

export class MailDraftRepository {
  private readonly getStmt: PreparedStatement;
  private readonly insertStmt: PreparedStatement;
  private readonly transitionStmts = new Map<string, PreparedStatement>();

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM mail_drafts WHERE draft_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO mail_drafts (
        draft_id, workspace_id, account_id, to_json, cc_json, bcc_json, subject, body_text,
        approval_id, status, failure_reason, sent_at, created_at, updated_at
      ) VALUES (
        @draftId, @workspaceId, @accountId, @toJson, @ccJson, @bccJson, @subject, @bodyText,
        @approvalId, @status, @failureReason, @sentAt, @createdAt, @updatedAt
      )
    `);
  }

  /** Inserts a new draft; a duplicate draftId throws the database's primary-key error. */
  public create(record: MailDraftRecord): MailDraftRecord {
    assertStatus(record.status);
    this.insertStmt.run({
      draftId: record.draftId,
      workspaceId: record.workspaceId ?? null,
      accountId: record.accountId,
      toJson: JSON.stringify(record.to),
      ccJson: JSON.stringify(record.cc),
      bccJson: JSON.stringify(record.bcc),
      subject: record.subject,
      bodyText: record.bodyText,
      approvalId: record.approvalId ?? null,
      status: record.status,
      failureReason: record.failureReason ?? null,
      sentAt: record.sentAt ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return this.get(record.draftId);
  }

  public find(draftId: string): MailDraftRecord | undefined {
    const row = this.getStmt.get(draftId);
    return row === undefined ? undefined : mapRow(assertMailDraftRow(row));
  }

  public get(draftId: string): MailDraftRecord {
    const record = this.find(draftId);
    if (!record) {
      throw new NotFoundError({ entity: "Mail draft", id: draftId });
    }
    return record;
  }

  /**
   * Compare-and-set: applies only while the current status is in `from`; returns undefined otherwise.
   * Omitted optional patch fields keep their stored values; `clearFailureReason` is the
   * only way to remove a stored failure reason.
   */
  public transition(
    draftId: string,
    from: readonly MailDraftStatus[],
    patch: MailDraftTransition,
  ): MailDraftRecord | undefined {
    if (from.length === 0) {
      throw new ValidationError({ message: "A mail draft transition needs at least one allowed current status." });
    }
    for (const status of from) assertStatus(status);
    assertStatus(patch.status);
    const clearFailureReason = patch.clearFailureReason === true;
    if (clearFailureReason && patch.failureReason !== undefined) {
      throw new ValidationError({ message: "A mail draft transition cannot both set and clear its failure reason." });
    }
    const allowed = [...new Set(from)].sort();
    const statement = this.transitionStatement(allowed.length, clearFailureReason);
    const params: Record<string, unknown> = {
      draftId,
      status: patch.status,
      approvalId: patch.approvalId ?? null,
      ...(clearFailureReason ? {} : { failureReason: patch.failureReason ?? null }),
      sentAt: patch.sentAt ?? null,
      updatedAt: patch.updatedAt,
    };
    allowed.forEach((status, index) => {
      params[`from${index}`] = status;
    });
    return this.db.transaction("immediate", () => {
      const result = statement.run(params);
      return Number(result.changes) === 1 ? this.get(draftId) : undefined;
    });
  }

  private transitionStatement(fromCount: number, clearFailureReason: boolean): PreparedStatement {
    const key = `${fromCount}:${clearFailureReason ? "clear" : "keep"}`;
    const cached = this.transitionStmts.get(key);
    if (cached) return cached;
    const placeholders = Array.from({ length: fromCount }, (_, index) => `@from${index}`).join(", ");
    const statement = this.db.prepare(`
      UPDATE mail_drafts
      SET
        status = @status,
        approval_id = COALESCE(@approvalId, approval_id),
        failure_reason = ${clearFailureReason ? "NULL" : "COALESCE(@failureReason, failure_reason)"},
        sent_at = COALESCE(@sentAt, sent_at),
        updated_at = @updatedAt
      WHERE draft_id = @draftId AND status IN (${placeholders})
    `);
    this.transitionStmts.set(key, statement);
    return statement;
  }
}

function assertStatus(status: unknown): asserts status is MailDraftStatus {
  if (!MAIL_DRAFT_STATUSES.includes(status as MailDraftStatus)) {
    throw new ValidationError({ message: `Unknown mail draft status: ${String(status)}` });
  }
}

function mapRow(row: MailDraftRow): MailDraftRecord {
  return {
    draftId: row.draft_id,
    ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
    accountId: row.account_id,
    to: parseAddresses(row.to_json),
    cc: parseAddresses(row.cc_json),
    bcc: parseAddresses(row.bcc_json),
    subject: row.subject,
    bodyText: row.body_text,
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    status: row.status,
    ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
    ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseAddresses(raw: string): string[] {
  const parsed = safeJsonParse<unknown>(raw, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function assertMailDraftRow(value: unknown): MailDraftRow {
  if (!isRecord(value)) throw new TypeError("Unexpected mail draft row shape");
  const text = ["draft_id", "account_id", "to_json", "cc_json", "bcc_json", "subject", "body_text", "status"];
  const nullableText = ["workspace_id", "approval_id", "failure_reason", "sent_at"];
  const valid =
    [...text, "created_at", "updated_at"].every((key) => typeof value[key] === "string") &&
    nullableText.every((key) => value[key] === null || typeof value[key] === "string") &&
    MAIL_DRAFT_STATUSES.includes(value.status as MailDraftStatus);
  if (!valid) throw new TypeError("Unexpected mail draft row shape");
  return value as unknown as MailDraftRow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
