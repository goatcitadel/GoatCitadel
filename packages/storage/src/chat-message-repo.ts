import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { ChatInputPart, ChatMessageRecord, ChatMessageRole } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

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

export class ChatMessageRepository {
  private readonly upsertStmt;
  private readonly countStmt;
  private readonly listLatestStmt;
  private readonly listBeforeSeqStmt;
  private readonly getStmt;
  private readonly getCursorStmt;

  public constructor(private readonly db: DatabaseClient) {
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
    const savepointName = `chat_messages_upsert_many_${randomUUID().replaceAll("-", "_")}`;
    this.db.exec(`SAVEPOINT ${savepointName}`);
    try {
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
      this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
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
    return row ? mapRow(row) : undefined;
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
    return rows.map((row) => mapRow(row));
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
  return typeof value.count === "number" || value.count === undefined
    ? { count: value.count as number | undefined }
    : undefined;
}

function toCursorRow(value: unknown): { seq?: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.seq === "number" || value.seq === undefined
    ? { seq: value.seq as number | undefined }
    : undefined;
}

function mapRow(row: ChatMessageRow): ChatMessageRecord {
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
    parts: parseParts(row.parts_json),
    attachments: parseAttachments(row.attachments_json),
    ...(steered === undefined ? {} : { steered }),
    ...(row.parent_delegation_step_id === null || row.parent_delegation_step_id === undefined
      ? {}
      : { parentDelegationStepId: row.parent_delegation_step_id }),
  };
}

function parseParts(raw: string | null): ChatInputPart[] | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = safeJsonParse<unknown>(raw, undefined);
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const parts = parsed.filter(isChatInputPart);
  return parts.length > 0 ? parts : undefined;
}

function parseAttachments(raw: string | null): ChatMessageRecord["attachments"] | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = safeJsonParse<unknown>(raw, undefined);
  if (!Array.isArray(parsed)) {
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
