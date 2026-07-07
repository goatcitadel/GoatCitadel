import type { DatabaseClient } from "./db.js";

/**
 * A user message that is the newest message in its session but has no
 * chat_turn_traces row referencing it — the runtime-truth signature of a turn
 * that vanished when the gateway process died between persisting the user
 * message and creating the turn trace.
 */
export interface OrphanedLatestUserMessageRecord {
  sessionId: string;
  messageId: string;
  timestamp: string;
}

interface OrphanedLatestUserMessageRow {
  session_id: string;
  message_id: string;
  timestamp: string;
}

/**
 * Cross-table queries backing the boot-time chat-turn interruption reconciler.
 * Kept as its own repository so chat_messages/chat_turn_traces stay owned by
 * their dedicated repos while this recovery join lives in one focused place.
 */
export class ChatTurnRecoveryRepository {
  private readonly listOrphanedLatestUserMessagesStmt;

  public constructor(db: DatabaseClient) {
    // Latest message per session (by insertion order) that is a real operator
    // message (role + actor "user") with no turn trace pointing at it.
    // Autonomous seeds (heartbeats etc.) persist with a non-user actor_type and
    // are excluded so silent background turns never resurface as visible failures.
    this.listOrphanedLatestUserMessagesStmt = db.prepare(`
      SELECT m.session_id, m.message_id, m.timestamp
      FROM chat_messages AS m
      INNER JOIN (
        SELECT session_id, MAX(seq) AS max_seq
        FROM chat_messages
        GROUP BY session_id
      ) AS latest
        ON latest.session_id = m.session_id AND latest.max_seq = m.seq
      LEFT JOIN chat_turn_traces AS trace
        ON trace.user_message_id = m.message_id
      WHERE m.role = 'user'
        AND m.actor_type = 'user'
        AND trace.turn_id IS NULL
      ORDER BY m.timestamp ASC, m.message_id ASC
      LIMIT @limit
    `);
  }

  public listOrphanedLatestUserMessages(limit = 500): OrphanedLatestUserMessageRecord[] {
    const rows = this.listOrphanedLatestUserMessagesStmt.all({
      limit: Math.max(1, Math.min(limit, 1000)),
    });
    return (Array.isArray(rows) ? rows : []).filter(isOrphanedLatestUserMessageRow).map((row) => ({
      sessionId: row.session_id,
      messageId: row.message_id,
      timestamp: row.timestamp,
    }));
  }
}

function isOrphanedLatestUserMessageRow(value: unknown): value is OrphanedLatestUserMessageRow {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OrphanedLatestUserMessageRow).session_id === "string" &&
    typeof (value as OrphanedLatestUserMessageRow).message_id === "string" &&
    typeof (value as OrphanedLatestUserMessageRow).timestamp === "string"
  );
}
