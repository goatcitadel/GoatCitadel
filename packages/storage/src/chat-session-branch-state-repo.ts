import type { DatabaseClient } from "./db.js";
import { NotFoundError } from "@goatcitadel/contracts";

export interface ChatSessionBranchStateRecord {
  sessionId: string;
  activeLeafTurnId: string;
  updatedAt: string;
}

interface ChatSessionBranchStateRow {
  session_id: string;
  active_leaf_turn_id: string;
  updated_at: string;
}

export class ChatSessionBranchStateRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly compareAndSetStmt;
  private readonly insertIfMissingStmt;
  private readonly deleteStmt;
  private readonly clearIfCurrentStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare(`
      SELECT *
      FROM chat_session_branch_state
      WHERE session_id = ?
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_session_branch_state (session_id, active_leaf_turn_id, updated_at)
      VALUES (@sessionId, @activeLeafTurnId, @updatedAt)
      ON CONFLICT(session_id) DO UPDATE SET
        active_leaf_turn_id = excluded.active_leaf_turn_id,
        updated_at = excluded.updated_at
    `);
    this.compareAndSetStmt = db.prepare(`
      UPDATE chat_session_branch_state
      SET
        active_leaf_turn_id = @nextActiveLeafTurnId,
        updated_at = @updatedAt
      WHERE session_id = @sessionId
        AND active_leaf_turn_id = @expectedActiveLeafTurnId
    `);
    this.insertIfMissingStmt = db.prepare(`
      INSERT INTO chat_session_branch_state (session_id, active_leaf_turn_id, updated_at)
      VALUES (@sessionId, @nextActiveLeafTurnId, @updatedAt)
      ON CONFLICT(session_id) DO NOTHING
    `);
    this.deleteStmt = db.prepare(`
      DELETE FROM chat_session_branch_state
      WHERE session_id = ?
    `);
    this.clearIfCurrentStmt = db.prepare(`
      DELETE FROM chat_session_branch_state
      WHERE session_id = @sessionId AND active_leaf_turn_id = @expectedActiveLeafTurnId
    `);
  }

  public get(sessionId: string): ChatSessionBranchStateRecord | undefined {
    const row = this.getStmt.get(sessionId) as ChatSessionBranchStateRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public setActiveLeaf(
    sessionId: string,
    activeLeafTurnId: string,
    now = new Date().toISOString(),
  ): ChatSessionBranchStateRecord {
    this.upsertStmt.run({
      sessionId,
      activeLeafTurnId,
      updatedAt: now,
    });
    const row = this.getStmt.get(sessionId) as ChatSessionBranchStateRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "chat session branch state", id: sessionId });
    }
    return mapRow(row);
  }

  public setActiveLeafIfCurrent(
    sessionId: string,
    expectedActiveLeafTurnId: string | undefined,
    nextActiveLeafTurnId: string,
    now = new Date().toISOString(),
  ): boolean {
    const current = this.get(sessionId);
    if (current?.activeLeafTurnId === nextActiveLeafTurnId) {
      if (current.updatedAt === now) return true;
      // A same-leaf timestamp refresh may race a different selection.
      expectedActiveLeafTurnId = nextActiveLeafTurnId;
    }

    if (!expectedActiveLeafTurnId) {
      const result = this.insertIfMissingStmt.run({
        sessionId,
        nextActiveLeafTurnId,
        updatedAt: now,
      }) as { changes?: number };
      return (result.changes ?? 0) > 0;
    }

    const result = this.compareAndSetStmt.run({
      sessionId,
      expectedActiveLeafTurnId,
      nextActiveLeafTurnId,
      updatedAt: now,
    }) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  public clearIfCurrent(sessionId: string, expectedActiveLeafTurnId: string): boolean {
    const result = this.clearIfCurrentStmt.run({ sessionId, expectedActiveLeafTurnId });
    return (result.changes ?? 0) > 0;
  }

  public clear(sessionId: string): boolean {
    const result = this.deleteStmt.run(sessionId) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }
}

function mapRow(row: ChatSessionBranchStateRow): ChatSessionBranchStateRecord {
  return {
    sessionId: row.session_id,
    activeLeafTurnId: row.active_leaf_turn_id,
    updatedAt: row.updated_at,
  };
}
