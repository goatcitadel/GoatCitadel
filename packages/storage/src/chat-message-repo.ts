/* eslint-disable max-lines -- This established owner exceeds the line limit; decomposition belongs in a separate behavior-preserving tranche. */
import { randomUUID } from "node:crypto";

import type { DatabaseClient } from "./db.js";
import type { ChatInputPart, ChatMessageRecord, ChatMessageRole } from "@goatcitadel/contracts";
import { loadAndSanitize, type QuarantineEntry } from "./load-and-sanitize.js";
import { parseJsonArray } from "./state-validators.js";

const MAX_SEARCH_QUERY_CHARS = 512;
const MAX_SEARCH_QUERY_TOKENS = 64;

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
  workspaceId: string;
  messageId: string;
  sessionId: string;
  sequence: number;
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
  sequence: number;
  role: ChatMessageRole;
  content: string;
  timestamp: string;
  /** True for the entry that actually matched the query. */
  isHit: boolean;
}

export interface SearchMessagesOptions {
  /** Authoritative workspace boundary. Cross-workspace search is never supported. */
  workspaceId: string;
  /** Restrict the search to a single session. Omit to search across this workspace. */
  sessionId?: string;
  /** Include sessions hidden from history. Defaults to false. */
  includeHidden?: boolean;
  /** Maximum number of ranked hits to return (clamped to [1, 50]). */
  limit?: number;
  /** Number of neighbouring messages to include on each side of a hit (clamped to [0, 10]). */
  contextRadius?: number;
}

interface ChatMessageSearchRow {
  seq: number;
  workspace_id: string;
  include_in_history: number;
  message_id: string;
  session_id: string;
  role: ChatMessageRole;
  content: string;
  timestamp: string;
  score: number;
}

export interface ChatMessagePage {
  items: ChatMessageRecord[];
  cursorState: "start" | "valid" | "offset" | "stale";
  nextCursor?: string;
  hasOlder: boolean;
  snapshotMaxSequence?: number;
  snapshotMessageCount?: number;
  offset?: number;
  nextOffset?: number;
}

export interface ChatMessageAnchorIdentity {
  workspaceId: string;
  sessionId: string;
  messageId: string;
  sequence: number;
}

export interface ChatMessageAnchoredWindowEntry {
  sequence: number;
  message: ChatMessageRecord;
  isAnchor: boolean;
}

export interface ChatMessageAnchoredWindow {
  anchor: ChatMessageAnchorIdentity & {
    state: "found" | "unavailable" | "identity_mismatch";
    unavailableReason?: "missing_deleted_or_compacted";
  };
  items: ChatMessageAnchoredWindowEntry[];
  snapshotMaxSequence?: number;
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface ChatMessageHistoryContinuationPage {
  direction: "older" | "newer";
  cursorState: "valid" | "stale";
  items: ChatMessageAnchoredWindowEntry[];
  snapshotMaxSequence: number;
  nextCursor?: { messageId: string; sequence: number; snapshotMaxSequence: number };
  hasMore: boolean;
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
  private readonly listAtOrBeforeSeqStmt;
  private readonly listAtOrBeforeSeqOffsetStmt;
  private readonly listBeforeSeqStmt;
  private readonly getStmt;
  private readonly getCursorStmt;
  private readonly searchStmt;
  private readonly searchScopedStmt;
  private readonly contextBeforeStmt;
  private readonly contextAfterStmt;
  private readonly sessionWorkspaceStmt;
  private readonly anchorExactStmt;
  private readonly anchorMessageIdentityStmt;
  private readonly anchorSequenceIdentityStmt;
  private readonly sessionHighWaterStmt;
  private readonly sessionSnapshotCountStmt;
  private readonly authorizedCursorStmt;
  private readonly authorizedListAtOrBeforeSeqStmt;
  private readonly authorizedListAtOrBeforeSeqOffsetStmt;
  private readonly authorizedListBeforeSeqStmt;
  private readonly authorizedListAfterSeqStmt;
  private readonly authorizedSessionHighWaterStmt;
  private readonly authorizedSessionSnapshotCountStmt;
  private readonly anchoredBeforeStmt;
  private readonly anchoredAfterStmt;
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
    this.listAtOrBeforeSeqStmt = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE session_id = ? AND seq <= ?
      ORDER BY seq DESC
      LIMIT ?
    `);
    this.listAtOrBeforeSeqOffsetStmt = db.prepare(`
      SELECT *
      FROM chat_messages
      WHERE session_id = ? AND seq <= ?
      ORDER BY seq DESC
      LIMIT ? OFFSET ?
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
    this.contextBeforeStmt = db.prepare(`
      SELECT m.message_id, m.role, m.content, m.timestamp, m.seq
      FROM chat_messages AS m
      INNER JOIN chat_session_meta AS meta ON meta.session_id = m.session_id
      WHERE meta.workspace_id = ?
        AND (? <> 0 OR meta.include_in_history <> 0)
        AND m.session_id = ?
        AND m.seq < ?
      ORDER BY m.seq DESC
      LIMIT ?
    `);
    this.contextAfterStmt = db.prepare(`
      SELECT m.message_id, m.role, m.content, m.timestamp, m.seq
      FROM chat_messages AS m
      INNER JOIN chat_session_meta AS meta ON meta.session_id = m.session_id
      WHERE meta.workspace_id = ?
        AND (? <> 0 OR meta.include_in_history <> 0)
        AND m.session_id = ?
        AND m.seq > ?
      ORDER BY m.seq ASC
      LIMIT ?
    `);
    this.sessionWorkspaceStmt = db.prepare(`
      SELECT workspace_id
      FROM chat_session_meta
      WHERE session_id = ?
      LIMIT 1
    `);
    this.anchorExactStmt = db.prepare(`
      SELECT cm.*
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ?
        AND cm.session_id = ?
        AND cm.message_id = ?
        AND cm.seq = ?
      LIMIT 1
    `);
    this.anchorMessageIdentityStmt = db.prepare(`
      SELECT cm.seq
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ? AND cm.session_id = ? AND cm.message_id = ?
      LIMIT 1
    `);
    this.anchorSequenceIdentityStmt = db.prepare(`
      SELECT cm.message_id
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ? AND cm.session_id = ? AND cm.seq = ?
      LIMIT 1
    `);
    this.sessionHighWaterStmt = db.prepare(`
      SELECT MAX(seq) AS seq
      FROM chat_messages
      WHERE session_id = ?
    `);
    this.sessionSnapshotCountStmt = db.prepare(`
      SELECT COUNT(1) AS count
      FROM chat_messages
      WHERE session_id = ? AND seq <= ?
    `);
    this.anchoredBeforeStmt = db.prepare(`
      SELECT cm.*
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ? AND cm.session_id = ? AND cm.seq < ?
      ORDER BY cm.seq DESC
      LIMIT ?
    `);
    this.anchoredAfterStmt = db.prepare(`
      SELECT cm.*
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ? AND cm.session_id = ? AND cm.seq > ? AND cm.seq <= ?
      ORDER BY cm.seq ASC
      LIMIT ?
    `);
    this.authorizedCursorStmt = db.prepare(`
      SELECT cm.seq
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ? AND cm.session_id = ? AND cm.message_id = ?
      LIMIT 1
    `);
    this.authorizedListAtOrBeforeSeqStmt = db.prepare(`
      SELECT cm.*
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ? AND cm.session_id = ? AND cm.seq <= ?
      ORDER BY cm.seq DESC
      LIMIT ?
    `);
    this.authorizedListAtOrBeforeSeqOffsetStmt = db.prepare(`
      SELECT cm.*
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ? AND cm.session_id = ? AND cm.seq <= ?
      ORDER BY cm.seq DESC
      LIMIT ? OFFSET ?
    `);
    this.authorizedListBeforeSeqStmt = db.prepare(`
      SELECT cm.*
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ? AND cm.session_id = ? AND cm.seq < ?
      ORDER BY cm.seq DESC
      LIMIT ?
    `);
    this.authorizedListAfterSeqStmt = db.prepare(`
      SELECT cm.*
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ?
        AND cm.session_id = ?
        AND cm.seq > ?
        AND cm.seq <= ?
      ORDER BY cm.seq ASC
      LIMIT ?
    `);
    this.authorizedSessionHighWaterStmt = db.prepare(`
      SELECT MAX(cm.seq) AS seq
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ? AND cm.session_id = ?
    `);
    this.authorizedSessionSnapshotCountStmt = db.prepare(`
      SELECT COUNT(1) AS count
      FROM chat_messages AS cm
      INNER JOIN chat_session_meta AS meta ON meta.session_id = cm.session_id
      WHERE meta.workspace_id = ? AND cm.session_id = ? AND cm.seq <= ?
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
  public searchMessages(query: string, options: SearchMessagesOptions): ChatMessageSearchHit[] {
    const matchExpression =
      this.db.dialect === "postgres" ? buildSafePostgresSearchQuery(query) : buildSafeFtsMatchQuery(query);
    if (matchExpression === null) {
      return [];
    }
    const limit = clampSearchInt(options.limit, 10, 1, 50);
    const contextRadius = clampSearchInt(options.contextRadius, 2, 0, 10);
    const workspaceId = options.workspaceId.trim();
    if (!workspaceId) {
      return [];
    }
    const sessionId = options.sessionId?.trim();
    const includeHidden = options.includeHidden === true ? 1 : 0;

    const rows = sessionId
      ? toSearchRows(this.searchScopedStmt.all(matchExpression, workspaceId, includeHidden, sessionId, limit))
      : toSearchRows(this.searchStmt.all(matchExpression, workspaceId, includeHidden, limit));

    return rows
      .filter(
        (row) =>
          row.workspace_id === workspaceId &&
          (!sessionId || row.session_id === sessionId) &&
          (includeHidden !== 0 || row.include_in_history !== 0),
      )
      .map((row) => ({
        workspaceId: row.workspace_id,
        messageId: row.message_id,
        sessionId: row.session_id,
        sequence: row.seq,
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        score: row.score,
        context: this.loadContextWindow(row, contextRadius, workspaceId, includeHidden),
      }));
  }

  private loadContextWindow(
    row: ChatMessageSearchRow,
    contextRadius: number,
    workspaceId: string,
    includeHidden: number,
  ): ChatMessageSearchContextEntry[] {
    if (contextRadius <= 0) {
      return [
        {
          messageId: row.message_id,
          sequence: row.seq,
          role: row.role,
          content: row.content,
          timestamp: row.timestamp,
          isHit: true,
        },
      ];
    }
    const beforeRows = toContextRows(
      this.contextBeforeStmt.all(workspaceId, includeHidden, row.session_id, row.seq, contextRadius),
    ).reverse();
    const afterRows = toContextRows(
      this.contextAfterStmt.all(workspaceId, includeHidden, row.session_id, row.seq, contextRadius),
    );
    const windowRows: ChatMessageContextRow[] = [
      ...beforeRows,
      {
        message_id: row.message_id,
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        seq: row.seq,
      },
      ...afterRows,
    ];
    return windowRows.map((windowRow) => ({
      messageId: windowRow.message_id,
      sequence: windowRow.seq,
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
          return [];
        })()
      : toChatMessageRows(this.listLatestStmt.all(sessionId, safeLimit));
    rows.reverse();
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Stable keyset page bounded by an authoritative workspace/session identity.
   * A stale cursor is explicit and never degrades to the newest page.
   */
  public listPage(input: { workspaceId: string; sessionId: string; limit?: number; cursor?: string }): ChatMessagePage {
    const workspaceId = input.workspaceId.trim();
    const sessionId = input.sessionId.trim();
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(input.limit ?? 200)));
    if (!workspaceId || !sessionId || this.resolveSessionWorkspace(sessionId) !== workspaceId) {
      return { items: [], cursorState: input.cursor ? "stale" : "start", hasOlder: false };
    }

    return this.db.transaction("deferred", () => {
      const snapshotMaxSequence = toCursorRow(this.authorizedSessionHighWaterStmt.get(workspaceId, sessionId))?.seq;
      if (input.cursor) {
        const cursorRow = toCursorRow(this.authorizedCursorStmt.get(workspaceId, sessionId, input.cursor));
        if (cursorRow?.seq === undefined) {
          return {
            items: [],
            cursorState: "stale" as const,
            hasOlder: false,
            snapshotMaxSequence,
          };
        }
        const rows = toChatMessageRows(
          this.authorizedListBeforeSeqStmt.all(workspaceId, sessionId, cursorRow.seq, safeLimit + 1),
        );
        return this.buildPage(rows, safeLimit, "valid", snapshotMaxSequence);
      }
      const rows =
        snapshotMaxSequence === undefined
          ? []
          : toChatMessageRows(
              this.authorizedListAtOrBeforeSeqStmt.all(workspaceId, sessionId, snapshotMaxSequence, safeLimit + 1),
            );
      return this.buildPage(rows, safeLimit, "start", snapshotMaxSequence);
    });
  }

  /**
   * Legacy numeric paging frozen to an explicit sequence high-water mark.
   * Page zero captures the mark. Every later offset must replay it, otherwise
   * the request is stale rather than silently shifting under concurrent appends.
   */
  public listOffsetPage(input: {
    workspaceId: string;
    sessionId: string;
    limit?: number;
    offset?: number;
    snapshotMaxSequence?: number;
    snapshotMessageCount?: number;
  }): ChatMessagePage {
    const workspaceId = input.workspaceId.trim();
    const sessionId = input.sessionId.trim();
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(input.limit ?? 200)));
    const offset = Math.max(0, Math.min(1_000_000, Math.floor(input.offset ?? 0)));
    if (!workspaceId || !sessionId || this.resolveSessionWorkspace(sessionId) !== workspaceId) {
      return { items: [], cursorState: "stale", hasOlder: false, offset };
    }
    const requestedSnapshot = input.snapshotMaxSequence;
    if (requestedSnapshot !== undefined && (!Number.isSafeInteger(requestedSnapshot) || requestedSnapshot < 1)) {
      return { items: [], cursorState: "stale", hasOlder: false, offset };
    }
    if (offset > 0 && (requestedSnapshot === undefined || input.snapshotMessageCount === undefined)) {
      return { items: [], cursorState: "stale", hasOlder: false, offset };
    }

    return this.db.transaction("deferred", () => {
      const observedHighWater = toCursorRow(this.authorizedSessionHighWaterStmt.get(workspaceId, sessionId))?.seq;
      if (
        observedHighWater === undefined ||
        (requestedSnapshot !== undefined && requestedSnapshot > observedHighWater)
      ) {
        return { items: [], cursorState: "stale" as const, hasOlder: false, offset };
      }
      const snapshotMaxSequence = requestedSnapshot ?? observedHighWater;
      const observedSnapshotCount = Number(
        toCountRow(this.authorizedSessionSnapshotCountStmt.get(workspaceId, sessionId, snapshotMaxSequence))?.count ??
          0,
      );
      if (
        input.snapshotMessageCount !== undefined &&
        (!Number.isSafeInteger(input.snapshotMessageCount) ||
          input.snapshotMessageCount < 0 ||
          input.snapshotMessageCount !== observedSnapshotCount)
      ) {
        return {
          items: [],
          cursorState: "stale" as const,
          hasOlder: false,
          offset,
          snapshotMaxSequence,
          snapshotMessageCount: observedSnapshotCount,
        };
      }
      const snapshotMessageCount = input.snapshotMessageCount ?? observedSnapshotCount;
      const rows = toChatMessageRows(
        this.authorizedListAtOrBeforeSeqOffsetStmt.all(
          workspaceId,
          sessionId,
          snapshotMaxSequence,
          safeLimit + 1,
          offset,
        ),
      );
      const hasOlder = rows.length > safeLimit;
      const selected = rows.slice(0, safeLimit);
      const nextOffset = hasOlder ? offset + selected.length : undefined;
      selected.reverse();
      return {
        items: selected.map((row) => this.mapRow(row)),
        cursorState: "offset" as const,
        hasOlder,
        snapshotMaxSequence,
        snapshotMessageCount,
        offset,
        nextOffset,
      };
    });
  }

  /**
   * Resolve an exact historical anchor and a balanced, bounded context window.
   * Global sequence gaps are intentionally ignored: neighbours are selected by
   * per-session ordering, so messages interleaved from other sessions cannot
   * under-fill the result.
   */
  public readAnchoredWindow(anchor: ChatMessageAnchorIdentity, limit = 21): ChatMessageAnchoredWindow {
    const normalized = {
      workspaceId: anchor.workspaceId.trim(),
      sessionId: anchor.sessionId.trim(),
      messageId: anchor.messageId.trim(),
      sequence: Math.floor(anchor.sequence),
    };
    const empty = (state: "unavailable" | "identity_mismatch"): ChatMessageAnchoredWindow => ({
      anchor: {
        ...normalized,
        state,
        ...(state === "unavailable" ? { unavailableReason: "missing_deleted_or_compacted" as const } : {}),
      },
      items: [],
      hasOlder: false,
      hasNewer: false,
    });
    if (
      !normalized.workspaceId ||
      !normalized.sessionId ||
      !normalized.messageId ||
      !Number.isSafeInteger(normalized.sequence) ||
      normalized.sequence < 1
    ) {
      return empty("identity_mismatch");
    }
    if (this.resolveSessionWorkspace(normalized.sessionId) !== normalized.workspaceId) {
      return empty("identity_mismatch");
    }

    return this.db.transaction("deferred", () => {
      const anchorRow = toChatMessageRow(
        this.anchorExactStmt.get(
          normalized.workspaceId,
          normalized.sessionId,
          normalized.messageId,
          normalized.sequence,
        ),
      );
      if (!anchorRow) {
        const messageIdentity = toCursorRow(
          this.anchorMessageIdentityStmt.get(normalized.workspaceId, normalized.sessionId, normalized.messageId),
        )?.seq;
        const sequenceIdentity = toMessageIdentityRow(
          this.anchorSequenceIdentityStmt.get(normalized.workspaceId, normalized.sessionId, normalized.sequence),
        )?.messageId;
        return empty(
          messageIdentity !== undefined || sequenceIdentity !== undefined ? "identity_mismatch" : "unavailable",
        );
      }

      const snapshotMaxSequence =
        toCursorRow(this.authorizedSessionHighWaterStmt.get(normalized.workspaceId, normalized.sessionId))?.seq ??
        normalized.sequence;
      const safeLimit = Math.max(1, Math.min(101, Math.floor(limit)));
      const neighborBudget = safeLimit - 1;
      const rawBefore = toChatMessageRows(
        this.anchoredBeforeStmt.all(
          normalized.workspaceId,
          normalized.sessionId,
          normalized.sequence,
          neighborBudget + 1,
        ),
      );
      const rawAfter = toChatMessageRows(
        this.anchoredAfterStmt.all(
          normalized.workspaceId,
          normalized.sessionId,
          normalized.sequence,
          snapshotMaxSequence,
          neighborBudget + 1,
        ),
      );
      let beforeCount = Math.floor(neighborBudget / 2);
      let afterCount = neighborBudget - beforeCount;
      beforeCount = Math.min(beforeCount, rawBefore.length);
      afterCount = Math.min(afterCount, rawAfter.length);
      let remaining = neighborBudget - beforeCount - afterCount;
      if (remaining > 0) {
        const beforeExtra = Math.min(remaining, rawBefore.length - beforeCount);
        beforeCount += beforeExtra;
        remaining -= beforeExtra;
      }
      if (remaining > 0) {
        afterCount += Math.min(remaining, rawAfter.length - afterCount);
      }
      const before = rawBefore.slice(0, beforeCount).reverse();
      const after = rawAfter.slice(0, afterCount);
      return {
        anchor: { ...normalized, state: "found" as const },
        items: [
          ...before.map((row) => ({ sequence: row.seq, message: this.mapRow(row), isAnchor: false })),
          { sequence: anchorRow.seq, message: this.mapRow(anchorRow), isAnchor: true },
          ...after.map((row) => ({ sequence: row.seq, message: this.mapRow(row), isAnchor: false })),
        ],
        snapshotMaxSequence,
        hasOlder: rawBefore.length > beforeCount,
        hasNewer: rawAfter.length > afterCount,
      };
    });
  }

  /**
   * Page away from an exact anchored-window boundary using an immutable sequence
   * high-water mark. The boundary row must still exist with the same identity;
   * otherwise the cursor is stale and no latest-page fallback is attempted.
   */
  public readHistoryContinuation(input: {
    workspaceId: string;
    sessionId: string;
    direction: "older" | "newer";
    cursorMessageId: string;
    cursorSequence: number;
    snapshotMaxSequence: number;
    limit?: number;
  }): ChatMessageHistoryContinuationPage {
    const workspaceId = input.workspaceId.trim();
    const sessionId = input.sessionId.trim();
    const cursorMessageId = input.cursorMessageId.trim();
    const cursorSequence = Math.floor(input.cursorSequence);
    const snapshotMaxSequence = Math.floor(input.snapshotMaxSequence);
    const safeLimit = Math.max(1, Math.min(101, Math.floor(input.limit ?? 21)));
    const stale = (): ChatMessageHistoryContinuationPage => ({
      direction: input.direction,
      cursorState: "stale",
      items: [],
      snapshotMaxSequence,
      hasMore: false,
    });
    if (
      !workspaceId ||
      !sessionId ||
      !cursorMessageId ||
      !Number.isSafeInteger(cursorSequence) ||
      cursorSequence < 1 ||
      !Number.isSafeInteger(snapshotMaxSequence) ||
      snapshotMaxSequence < cursorSequence ||
      this.resolveSessionWorkspace(sessionId) !== workspaceId
    ) {
      return stale();
    }

    return this.db.transaction("deferred", () => {
      const cursor = toCursorRow(this.authorizedCursorStmt.get(workspaceId, sessionId, cursorMessageId))?.seq;
      if (cursor !== cursorSequence) {
        return stale();
      }
      const rows = toChatMessageRows(
        input.direction === "older"
          ? this.authorizedListBeforeSeqStmt.all(workspaceId, sessionId, cursorSequence, safeLimit + 1)
          : this.authorizedListAfterSeqStmt.all(
              workspaceId,
              sessionId,
              cursorSequence,
              snapshotMaxSequence,
              safeLimit + 1,
            ),
      );
      const hasMore = rows.length > safeLimit;
      const selected = rows.slice(0, safeLimit);
      if (input.direction === "older") {
        selected.reverse();
      }
      const boundary = input.direction === "older" ? selected.at(0) : selected.at(-1);
      return {
        direction: input.direction,
        cursorState: "valid" as const,
        items: selected.map((row) => ({
          sequence: row.seq,
          message: this.mapRow(row),
          isAnchor: false,
        })),
        snapshotMaxSequence,
        ...(hasMore && boundary
          ? {
              nextCursor: {
                messageId: boundary.message_id,
                sequence: boundary.seq,
                snapshotMaxSequence,
              },
            }
          : {}),
        hasMore,
      };
    });
  }

  private resolveSessionWorkspace(sessionId: string): string | undefined {
    return toWorkspaceRow(this.sessionWorkspaceStmt.get(sessionId))?.workspaceId;
  }

  private buildPage(
    rowsDescending: ChatMessageRow[],
    limit: number,
    cursorState: "start" | "valid",
    snapshotMaxSequence?: number,
  ): ChatMessagePage {
    const hasOlder = rowsDescending.length > limit;
    const selected = rowsDescending.slice(0, limit);
    const nextCursor = hasOlder ? selected.at(-1)?.message_id : undefined;
    selected.reverse();
    return {
      items: selected.map((row) => this.mapRow(row)),
      cursorState,
      nextCursor,
      hasOlder,
      snapshotMaxSequence,
    };
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

function toWorkspaceRow(value: unknown): { workspaceId: string } | undefined {
  return isRecord(value) && typeof value.workspace_id === "string" ? { workspaceId: value.workspace_id } : undefined;
}

function toMessageIdentityRow(value: unknown): { messageId: string } | undefined {
  return isRecord(value) && typeof value.message_id === "string" ? { messageId: value.message_id } : undefined;
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
  const includeInHistory = coerceNumber(value.include_in_history);
  if (
    seq === undefined ||
    score === undefined ||
    includeInHistory === undefined ||
    typeof value.workspace_id !== "string" ||
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
    workspace_id: value.workspace_id,
    include_in_history: includeInHistory,
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
  if (typeof rawQuery !== "string" || rawQuery.length > MAX_SEARCH_QUERY_CHARS) {
    return null;
  }
  const tokens = rawQuery.match(/[\p{L}\p{N}]+/gu);
  return tokens && tokens.length <= MAX_SEARCH_QUERY_TOKENS ? tokens : null;
}

function buildSearchSql(dialect: DatabaseClient["dialect"], scoped: boolean): string {
  if (dialect === "postgres") {
    return `
      WITH search_query AS (
        SELECT plainto_tsquery('simple', ?) AS query
      )
      SELECT
        m.seq AS seq,
        meta.workspace_id AS workspace_id,
        meta.include_in_history AS include_in_history,
        m.message_id AS message_id,
        m.session_id AS session_id,
        m.role AS role,
        m.content AS content,
        m.timestamp AS timestamp,
        -ts_rank_cd(m.content_search_vector, search_query.query) AS score
      FROM chat_messages AS m
      INNER JOIN chat_session_meta AS meta
        ON meta.session_id = m.session_id
      CROSS JOIN search_query
      WHERE m.content_search_vector @@ search_query.query
        AND meta.workspace_id = ?
        AND (? <> 0 OR meta.include_in_history <> 0)${scoped ? " AND m.session_id = ?" : ""}
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
      meta.workspace_id AS workspace_id,
      meta.include_in_history AS include_in_history,
      m.message_id AS message_id,
      m.session_id AS session_id,
      m.role AS role,
      m.content AS content,
      m.timestamp AS timestamp,
      bm25(chat_messages_fts) AS score
    FROM chat_messages_fts
    JOIN chat_messages AS m ON m.seq = chat_messages_fts.rowid
    INNER JOIN chat_session_meta AS meta ON meta.session_id = m.session_id
    WHERE chat_messages_fts MATCH ?
      AND meta.workspace_id = ?
      AND (? <> 0 OR meta.include_in_history <> 0)${scoped ? " AND m.session_id = ?" : ""}
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
