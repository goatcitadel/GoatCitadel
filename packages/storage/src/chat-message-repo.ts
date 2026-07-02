import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "./db.js";
import type { ChatInputPart, ChatMessageRecord, ChatMessageRole } from "@goatcitadel/contracts";
import { loadAndSanitize, type QuarantineEntry } from "./load-and-sanitize.js";
import { parseJsonArray } from "./state-validators.js";

interface ChatMessageRow {
  seq: number;
  message_id: string;
  session_id: string;
  role: ChatMessageRole;
  actor_type: "user" | "agent" | "system";
  actor_id: string;
  content: string;
  parts_json: string | null;
  attachments_json: string | null;
  timestamp: string;
  token_input: number | null;
  token_output: number | null;
  cost_usd: number | null;
  created_at: string;
  steered: number | null;
  parent_delegation_step_id: string | null;
}

export interface ChatMessageRepositoryOptions {
  quarantine?: { record: (entry: QuarantineEntry) => unknown };
  logger?: { warn: (data: unknown, msg: string) => void };
}

/** A single ranked FTS hit plus a small surrounding context window. */
export interface ChatMessageSearchHit {
  messageId: string;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  timestamp: string;
  /** BM25 score (lower is a better match; surfaced for callers that rank further). */
  score: number;
  /** The ±contextRadius messages around the hit, in chronological order (includes the hit). */
  context: ChatMessageSearchContextEntry[];
}

export interface ChatMessageSearchContextEntry {
  messageId: string;
  role: ChatMessageRole;
  content: string;
  timestamp: string;
  /** True for the entry that actually matched the query. */
  isHit: boolean;
}

export interface SearchMessagesOptions {
  /** Restrict the search to a single session. Omit to search across all sessions. */
  sessionId?: string;
  /** Maximum number of ranked hits to return (clamped to [1, 50]). */
  limit?: number;
  /** Number of neighbouring messages to include on each side of a hit (clamped to [0, 10]). */
  contextRadius?: number;
}

interface ChatMessageSearchRow {
  seq: number;
  message_id: string;
  session_id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: string;
  score: number;
}

/**
 * Convert arbitrary user text into a safe FTS5 MATCH expression.
 *
 * FTS5 treats characters like `"`, `*`, `:`, `^`, `(`, `)`, `-`, and the bare
 * keywords AND/OR/NOT/NEAR as query operators; passing raw user input straight to
 * MATCH throws `fts5: syntax error near …` on perfectly ordinary punctuation. We
 * tokenise on non-alphanumeric runs and wrap each token in a double-quoted string
 * literal (doubling any embedded quote), then AND them together implicitly. Every
 * operator therefore degrades to a literal search term and the expression can never
 * be malformed. Returns `null` when the input contains no searchable tokens.
 */
export function buildSafeFtsMatchQuery(rawQuery: string): string | null {
  if (typeof rawQuery !== "string") {
    return null;
  }
  const tokens = extractSearchTokens(rawQuery);
  if (!tokens || tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

export function buildSafePostgresSearchQuery(rawQuery: string): string | null {
  const tokens = extractSearchTokens(rawQuery);
  return tokens && tokens.length > 0 ? tokens.join(" ") : null;
}

export class ChatMessageRepository {
  private readonly upsertStmt;
  private readonly countStmt;
  private readonly listLatestStmt;
  private readonly listBeforeSeqStmt;
  private readonly getStmt;
  private readonly getCursorStmt;
  private readonly searchStmt;
  private readonly searchScopedStmt;
  private readonly contextWindowStmt;
  private readonly deleteByMessageIdsStmtCache = new Map<number, ReturnType<DatabaseClient["prepare"]>>();
  private readonly listByMessageIdsStmtCache = new Map<number, ReturnType<DatabaseClient["prepare"]>>();

  public constructor(
    private readonly db: DatabaseClient,
    private readonly options: ChatMessageRepositoryOptions = {},
  ) {
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_messages (
        message_id, session_id, role, actor_type, actor_id, content, parts_json, attachments_json,
        timestamp, token_input, token_output, cost_usd, created_at, steered, parent_delegation_step_id
      ) VALUES (
        @messageId, @sessionId, @role, @actorType, @actorId, @content, @partsJson, @attachmentsJson,
        @timestamp, @tokenInput, @tokenOutput, @costUsd, @createdAt, @steered, @parentDelegationStepId
      )
      ON CONFLICT(message_id) DO UPDATE SET
        role = excluded.role,
        actor_type = excluded.actor_type,
        actor_id = excluded.actor_id,
        content = excluded.content,
        parts_json = excluded.parts_json,
        attachments_json = excluded.attachments_json,
        timestamp = excluded.timestamp,
        token_input = excluded.token_input,
        token_output = excluded.token_output,
        cost_usd = excluded.cost_usd,
        steered = excluded.steered,
        parent_delegation_step_id = excluded.parent_delegation_step_id
    `);
    this.countStmt = db.prepare(`
      SELECT COUNT(1) AS count
      FROM chat_messages
      WHERE session_id = ?
    `);
    this.listLatestStmt = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE session_id = ?
      ORDER BY seq DESC
      LIMIT ?
    `);
    this.listBeforeSeqStmt = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE session_id = ? AND seq < ?
      ORDER BY seq DESC
      LIMIT ?
    `);
    this.getStmt = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE message_id = ?
      LIMIT 1
    `);
    this.getCursorStmt = db.prepare(`
      SELECT seq
      FROM chat_messages
      WHERE session_id = ? AND message_id = ?
      LIMIT 1
    `);
    this.searchStmt = db.prepare(buildSearchSql(db.dialect, false));
    this.searchScopedStmt = db.prepare(buildSearchSql(db.dialect, true));
    this.contextWindowStmt = db.prepare(`
      SELECT message_id, role, content, timestamp, seq
      FROM chat_messages
      WHERE session_id = ? AND seq >= ? AND seq <= ?
      ORDER BY seq ASC
    `);
  }

  /**
   * Full-text recall over persisted chat messages (tier-2 memory).
   *
   * Ranks hits by BM25, optionally scoped to one session, and attaches a ±N-message
   * context window around each hit. The query text is sanitised via
   * {@link buildSafeFtsMatchQuery} so arbitrary punctuation/operators never raise an
   * FTS syntax error. Returns `[]` for an empty/no-token query or when nothing matches.
   */
  public searchMessages(query: string, options: SearchMessagesOptions = {}): ChatMessageSearchHit[] {
    const matchExpression =
      this.db.dialect === "postgres" ? buildSafePostgresSearchQuery(query) : buildSafeFtsMatchQuery(query);
    if (matchExpression === null) {
      return [];
    }
    const limit = clampSearchInt(options.limit, 10, 1, 50);
    const contextRadius = clampSearchInt(options.contextRadius, 2, 0, 10);
    const sessionId = options.sessionId?.trim();

    const rows = sessionId
      ? toSearchRows(this.searchScopedStmt.all(matchExpression, sessionId, limit))
      : toSearchRows(this.searchStmt.all(matchExpression, limit));

    return rows.map((row) => ({
      messageId: row.message_id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      score: row.score,
      context: this.loadContextWindow(row, contextRadius),
    }));
  }

  private loadContextWindow(row: ChatMessageSearchRow, contextRadius: number): ChatMessageSearchContextEntry[] {
    if (contextRadius <= 0) {
      return [
        {
          messageId: row.message_id,
          role: row.role,
          content: row.content,
          timestamp: row.timestamp,
          isHit: true,
        },
      ];
    }
    const windowRows = toContextRows(
      this.contextWindowStmt.all(row.session_id, row.seq - contextRadius, row.seq + contextRadius),
    );
    return windowRows.map((windowRow) => ({
      messageId: windowRow.message_id,
      role: windowRow.role,
      content: windowRow.content,
      timestamp: windowRow.timestamp,
      isHit: windowRow.message_id === row.message_id,
    }));
  }

  public upsert(message: ChatMessageRecord, now = new Date().toISOString()): void {
    this.upsertStmt.run({
      messageId: message.messageId,
      sessionId: message.sessionId,
      role: message.role,
      actorType: message.actorType,
      actorId: message.actorId,
      content: message.content,
      partsJson: message.parts ? JSON.stringify(message.parts) : null,
      attachmentsJson: message.attachments ? JSON.stringify(message.attachments) : null,
      timestamp: message.timestamp,
      tokenInput: message.tokenInput ?? null,
      tokenOutput: message.tokenOutput ?? null,
      costUsd: message.costUsd ?? null,
      createdAt: message.timestamp || now,
      steered: typeof message.steered === "boolean" ? (message.steered ? 1 : 0) : null,
      parentDelegationStepId: message.parentDelegationStepId ?? null,
    });
  }

  public upsertMany(messages: ChatMessageRecord[], now = new Date().toISOString()): void {
    if (messages.length === 0) {
      return;
    }
    const BATCH_SIZE = 50;
    const columns = [
      "message_id",
      "session_id",
      "role",
      "actor_type",
      "actor_id",
      "content",
      "parts_json",
      "attachments_json",
      "timestamp",
      "token_input",
      "token_output",
      "cost_usd",
      "created_at",
      "steered",
      "parent_delegation_step_id",
    ];
    this.withAtomicBatchWrite(() => {
      for (let offset = 0; offset < messages.length; offset += BATCH_SIZE) {
        const chunk = messages.slice(offset, offset + BATCH_SIZE);
        const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
        const sql = `
          INSERT INTO chat_messages (${columns.join(", ")})
          VALUES ${chunk.map(() => rowPlaceholder).join(", ")}
          ON CONFLICT(message_id) DO UPDATE SET
            session_id = excluded.session_id,
            role = excluded.role,
            actor_type = excluded.actor_type,
            actor_id = excluded.actor_id,
            content = excluded.content,
            parts_json = excluded.parts_json,
            attachments_json = excluded.attachments_json,
            timestamp = excluded.timestamp,
            token_input = excluded.token_input,
            token_output = excluded.token_output,
            cost_usd = excluded.cost_usd,
            steered = excluded.steered,
            parent_delegation_step_id = excluded.parent_delegation_step_id
        `;
        const params: (string | number | null)[] = [];
        for (const message of chunk) {
          params.push(
            message.messageId,
            message.sessionId,
            message.role,
            message.actorType,
            message.actorId,
            message.content,
            message.parts ? JSON.stringify(message.parts) : null,
            message.attachments ? JSON.stringify(message.attachments) : null,
            message.timestamp,
            message.tokenInput ?? null,
            message.tokenOutput ?? null,
            message.costUsd ?? null,
            message.timestamp || now,
            typeof message.steered === "boolean" ? (message.steered ? 1 : 0) : null,
            message.parentDelegationStepId ?? null,
          );
        }
        this.db.prepare(sql).run(...params);
      }
    });
  }

  private withAtomicBatchWrite<T>(work: () => T): T {
    if (this.db.dialect !== "sqlite") {
      return this.db.transaction("immediate", work);
    }

    const savepointName = `chat_messages_upsert_many_${randomUUID().replaceAll("-", "_")}`;
    this.db.exec(`SAVEPOINT ${savepointName}`);
    try {
      const result = work();
      this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      throw error;
    }
  }

  public countBySession(sessionId: string): number {
    const row = toCountRow(this.countStmt.get(sessionId));
    return Number(row?.count ?? 0);
  }

  public get(messageId: string): ChatMessageRecord | undefined {
    const row = toChatMessageRow(this.getStmt.get(messageId));
    return row ? this.mapRow(row) : undefined;
  }

  public listByMessageIds(messageIds: string[]): Map<string, ChatMessageRecord> {
    const uniqueMessageIds = [...new Set(messageIds.map((item) => item.trim()).filter(Boolean))];
    const messagesById = new Map<string, ChatMessageRecord>();
    if (uniqueMessageIds.length === 0) {
      return messagesById;
    }

    for (let index = 0; index < uniqueMessageIds.length; index += 400) {
      const batch = uniqueMessageIds.slice(index, index + 400);
      const stmt = this.getListByMessageIdsStmt(batch.length);
      const rows = toChatMessageRows(stmt.all(...batch));
      for (const row of rows) {
        const message = this.mapRow(row);
        messagesById.set(message.messageId, message);
      }
    }

    return messagesById;
  }

  public deleteByMessageIds(sessionId: string, messageIds: string[]): number {
    const uniqueMessageIds = [...new Set(messageIds.map((item) => item.trim()).filter(Boolean))];
    if (uniqueMessageIds.length === 0) {
      return 0;
    }

    let deleted = 0;
    for (let index = 0; index < uniqueMessageIds.length; index += 400) {
      const batch = uniqueMessageIds.slice(index, index + 400);
      const stmt = this.getDeleteByMessageIdsStmt(batch.length);
      const result = stmt.run(sessionId, ...batch);
      deleted += result.changes ?? 0;
    }
    return deleted;
  }

  public list(sessionId: string, limit = 200, cursor?: string): ChatMessageRecord[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = cursor
      ? (() => {
          const cursorRow = toCursorRow(this.getCursorStmt.get(sessionId, cursor));
          if (typeof cursorRow?.seq === "number") {
            return toChatMessageRows(this.listBeforeSeqStmt.all(sessionId, cursorRow.seq, safeLimit));
          }
          return toChatMessageRows(this.listLatestStmt.all(sessionId, safeLimit));
        })()
      : toChatMessageRows(this.listLatestStmt.all(sessionId, safeLimit));
    rows.reverse();
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: ChatMessageRow): ChatMessageRecord {
    const steered = typeof row.steered === "number" ? row.steered !== 0 : undefined;
    return {
      messageId: row.message_id,
      sessionId: row.session_id,
      role: row.role,
      actorType: row.actor_type,
      actorId: row.actor_id,
      content: row.content,
      timestamp: row.timestamp,
      tokenInput: row.token_input ?? undefined,
      tokenOutput: row.token_output ?? undefined,
      costUsd: row.cost_usd ?? undefined,
      parts: this.parseParts(row.parts_json, row.message_id),
      attachments: this.parseAttachments(row.attachments_json, row.message_id),
      ...(steered === undefined ? {} : { steered }),
      ...(row.parent_delegation_step_id === null || row.parent_delegation_step_id === undefined
        ? {}
        : { parentDelegationStepId: row.parent_delegation_step_id }),
    };
  }

  private parseParts(raw: string | null, messageId: string): ChatInputPart[] | undefined {
    if (!raw) {
      return undefined;
    }
    const parsed = loadAndSanitize(
      raw,
      {
        store: "chat_message.parts",
        rowId: messageId,
        parse: parseJsonArray,
        onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
        log: this.options.logger,
      },
      undefined,
    );
    if (!parsed) {
      return undefined;
    }
    const parts = parsed.filter(isChatInputPart);
    return parts.length > 0 ? parts : undefined;
  }

  private parseAttachments(raw: string | null, messageId: string): ChatMessageRecord["attachments"] | undefined {
    if (!raw) {
      return undefined;
    }
    const parsed = loadAndSanitize(
      raw,
      {
        store: "chat_message.attachments",
        rowId: messageId,
        parse: parseJsonArray,
        onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
        log: this.options.logger,
      },
      undefined,
    );
    if (!parsed) {
      return undefined;
    }
    const attachments = parsed
      .map((item) => {
        if (!isRecord(item)) {
          return undefined;
        }
        const attachmentId = typeof item.attachmentId === "string" ? item.attachmentId : undefined;
        const fileName = typeof item.fileName === "string" ? item.fileName : undefined;
        const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
        const sizeBytes =
          typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes) ? item.sizeBytes : undefined;
        if (!attachmentId || !fileName || !mimeType || sizeBytes === undefined) {
          return undefined;
        }
        return {
          attachmentId,
          fileName,
          mimeType,
          sizeBytes,
        };
      })
      .filter((item): item is NonNullable<ChatMessageRecord["attachments"]>[number] => Boolean(item));
    return attachments.length > 0 ? attachments : undefined;
  }

  private getListByMessageIdsStmt(size: number) {
    const cached = this.listByMessageIdsStmtCache.get(size);
    if (cached) {
      return cached;
    }
    const placeholders = new Array(size).fill("?").join(", ");
    const stmt = this.db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE message_id IN (${placeholders})
    `);
    this.listByMessageIdsStmtCache.set(size, stmt);
    return stmt;
  }

  private getDeleteByMessageIdsStmt(size: number) {
    const cached = this.deleteByMessageIdsStmtCache.get(size);
    if (cached) {
      return cached;
    }
    const placeholders = new Array(size).fill("?").join(", ");
    const stmt = this.db.prepare(`
      DELETE FROM chat_messages
      WHERE session_id = ?
        AND message_id IN (${placeholders})
    `);
    this.deleteByMessageIdsStmtCache.set(size, stmt);
    return stmt;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatMessageRow(value: unknown): value is ChatMessageRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.seq === "number" &&
    typeof value.message_id === "string" &&
    typeof value.session_id === "string" &&
    typeof value.role === "string" &&
    typeof value.actor_type === "string" &&
    typeof value.actor_id === "string" &&
    typeof value.content === "string" &&
    (typeof value.parts_json === "string" || value.parts_json === null) &&
    (typeof value.attachments_json === "string" || value.attachments_json === null) &&
    typeof value.timestamp === "string" &&
    (typeof value.token_input === "number" || value.token_input === null) &&
    (typeof value.token_output === "number" || value.token_output === null) &&
    (typeof value.cost_usd === "number" || value.cost_usd === null) &&
    typeof value.created_at === "string" &&
    (typeof value.steered === "number" || value.steered === null || value.steered === undefined) &&
    (typeof value.parent_delegation_step_id === "string" ||
      value.parent_delegation_step_id === null ||
      value.parent_delegation_step_id === undefined)
  );
}

function isChatInputPart(value: unknown): value is ChatInputPart {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image_ref":
      return (
        typeof value.attachmentId === "string" &&
        (value.mimeType === undefined || typeof value.mimeType === "string") &&
        (value.detail === undefined || value.detail === "low" || value.detail === "high" || value.detail === "auto")
      );
    case "audio_ref":
    case "video_ref":
    case "file_ref":
      return (
        typeof value.attachmentId === "string" && (value.mimeType === undefined || typeof value.mimeType === "string")
      );
    default:
      return false;
  }
}

function toChatMessageRow(value: unknown): ChatMessageRow | undefined {
  return isChatMessageRow(value) ? value : undefined;
}

function toChatMessageRows(value: unknown): ChatMessageRow[] {
  return Array.isArray(value) ? value.filter(isChatMessageRow) : [];
}

function toCountRow(value: unknown): { count?: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.count === undefined) {
    return { count: undefined };
  }
  const count = coerceNumber(value.count);
  return count === undefined ? undefined : { count };
}

function toCursorRow(value: unknown): { seq?: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.seq === undefined) {
    return { seq: undefined };
  }
  const seq = coerceNumber(value.seq);
  return seq === undefined ? undefined : { seq };
}

function clampSearchInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function toSearchRow(value: unknown): ChatMessageSearchRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const seq = coerceNumber(value.seq);
  const score = coerceNumber(value.score);
  if (
    seq === undefined ||
    score === undefined ||
    typeof value.message_id !== "string" ||
    typeof value.session_id !== "string" ||
    typeof value.role !== "string" ||
    typeof value.content !== "string" ||
    typeof value.timestamp !== "string"
  ) {
    return undefined;
  }
  return {
    seq,
    message_id: value.message_id,
    session_id: value.session_id,
    role: value.role as ChatMessageRole,
    content: value.content,
    timestamp: value.timestamp,
    score,
  };
}

function toSearchRows(value: unknown): ChatMessageSearchRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((row) => {
    const parsed = toSearchRow(row);
    return parsed ? [parsed] : [];
  });
}

interface ChatMessageContextRow {
  message_id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: string;
  seq: number;
}

function toContextRow(value: unknown): ChatMessageContextRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const seq = coerceNumber(value.seq);
  if (
    seq === undefined ||
    typeof value.message_id !== "string" ||
    typeof value.role !== "string" ||
    typeof value.content !== "string" ||
    typeof value.timestamp !== "string"
  ) {
    return undefined;
  }
  return {
    message_id: value.message_id,
    role: value.role as ChatMessageRole,
    content: value.content,
    timestamp: value.timestamp,
    seq,
  };
}

function toContextRows(value: unknown): ChatMessageContextRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((row) => {
    const parsed = toContextRow(row);
    return parsed ? [parsed] : [];
  });
}

function extractSearchTokens(rawQuery: string): string[] | null {
  if (typeof rawQuery !== "string") {
    return null;
  }
  return rawQuery.match(/[\p{L}\p{N}]+/gu);
}

function buildSearchSql(dialect: DatabaseClient["dialect"], scoped: boolean): string {
  if (dialect === "postgres") {
    return `
      WITH search_query AS (
        SELECT plainto_tsquery('simple', ?) AS query
      )
      SELECT
        m.seq AS seq,
        m.message_id AS message_id,
        m.session_id AS session_id,
        m.role AS role,
        m.content AS content,
        m.timestamp AS timestamp,
        -ts_rank_cd(m.content_search_vector, search_query.query) AS score
      FROM chat_messages AS m
      CROSS JOIN search_query
      WHERE m.content_search_vector @@ search_query.query${scoped ? " AND m.session_id = ?" : ""}
      ORDER BY score ASC, m.timestamp DESC, m.seq DESC
      LIMIT ?
    `;
  }

  // P2-S4a session.search: BM25-ranked full-text recall over persisted messages.
  // The join back to chat_messages resolves the canonical row (the FTS table is
  // contentless). `bm25(chat_messages_fts)` returns ascending rank (lower = better).
  return `
    SELECT
      m.seq AS seq,
      m.message_id AS message_id,
      m.session_id AS session_id,
      m.role AS role,
      m.content AS content,
      m.timestamp AS timestamp,
      bm25(chat_messages_fts) AS score
    FROM chat_messages_fts
    JOIN chat_messages AS m ON m.seq = chat_messages_fts.rowid
    WHERE chat_messages_fts MATCH ?${scoped ? " AND m.session_id = ?" : ""}
    ORDER BY score ASC
    LIMIT ?
  `;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
