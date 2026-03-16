import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
}

export class ChatMessageRepository {
  private readonly upsertStmt;
  private readonly countStmt;
  private readonly listLatestStmt;
  private readonly listBeforeSeqStmt;
  private readonly getStmt;
  private readonly getCursorStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_messages (
        message_id, session_id, role, actor_type, actor_id, content, parts_json, attachments_json,
        timestamp, token_input, token_output, cost_usd, created_at
      ) VALUES (
        @messageId, @sessionId, @role, @actorType, @actorId, @content, @partsJson, @attachmentsJson,
        @timestamp, @tokenInput, @tokenOutput, @costUsd, @createdAt
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
        created_at = excluded.created_at
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
    });
  }

  public upsertMany(messages: ChatMessageRecord[], now = new Date().toISOString()): void {
    if (messages.length === 0) {
      return;
    }
    const BATCH_SIZE = 50;
    const columns = [
      "message_id", "session_id", "role", "actor_type", "actor_id",
      "content", "parts_json", "attachments_json",
      "timestamp", "token_input", "token_output", "cost_usd", "created_at",
    ];
    const savepointName = `chat_messages_upsert_many_${randomUUID().replaceAll("-", "_")}`;
    this.db.exec(`SAVEPOINT ${savepointName}`);
    try {
      for (let offset = 0; offset < messages.length; offset += BATCH_SIZE) {
        const chunk = messages.slice(offset, offset + BATCH_SIZE);
        const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
        const sql = `
          INSERT OR REPLACE INTO chat_messages (${columns.join(", ")})
          VALUES ${chunk.map(() => rowPlaceholder).join(", ")}
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
    const row = this.countStmt.get(sessionId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  public get(messageId: string): ChatMessageRecord | undefined {
    const row = this.getStmt.get(messageId) as ChatMessageRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public list(sessionId: string, limit = 200, cursor?: string): ChatMessageRecord[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    let rows: ChatMessageRow[] = [];
    if (cursor) {
      const cursorRow = this.getCursorStmt.get(sessionId, cursor) as { seq?: number } | undefined;
      if (typeof cursorRow?.seq === "number") {
        rows = this.listBeforeSeqStmt.all(sessionId, cursorRow.seq, safeLimit) as unknown as ChatMessageRow[];
      } else {
        rows = this.listLatestStmt.all(sessionId, safeLimit) as unknown as ChatMessageRow[];
      }
    } else {
      rows = this.listLatestStmt.all(sessionId, safeLimit) as unknown as ChatMessageRow[];
    }
    rows.reverse();
    return rows.map((row) => mapRow(row));
  }
}

function mapRow(row: ChatMessageRow): ChatMessageRecord {
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
  const parts = parsed.filter((item) => item && typeof item === "object") as ChatInputPart[];
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
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const value = item as Record<string, unknown>;
      const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
      const fileName = typeof value.fileName === "string" ? value.fileName : undefined;
      const mimeType = typeof value.mimeType === "string" ? value.mimeType : undefined;
      const sizeBytes = typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)
        ? value.sizeBytes
        : undefined;
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
