import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChatConversationSummaryRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ChatConversationSummaryRow {
  summary_id: string;
  session_id: string;
  branch_head_turn_id: string;
  start_turn_id: string;
  end_turn_id: string;
  turn_ids_json: string;
  source_hash: string;
  token_estimate: number;
  summary_text: string;
  created_at: string;
  updated_at: string;
}

export interface ChatConversationSummaryUpsertInput {
  summaryId?: string;
  sessionId: string;
  branchHeadTurnId: string;
  startTurnId: string;
  endTurnId: string;
  turnIds: string[];
  sourceHash: string;
  tokenEstimate: number;
  summary: string;
  createdAt?: string;
  updatedAt?: string;
}

export class ChatConversationSummaryRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly listByBranchStmt;
  private readonly listBySessionStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT * FROM chat_conversation_summaries WHERE summary_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_conversation_summaries (
        summary_id, session_id, branch_head_turn_id, start_turn_id, end_turn_id, turn_ids_json,
        source_hash, token_estimate, summary_text, created_at, updated_at
      ) VALUES (
        @summaryId, @sessionId, @branchHeadTurnId, @startTurnId, @endTurnId, @turnIdsJson,
        @sourceHash, @tokenEstimate, @summary, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id, branch_head_turn_id, start_turn_id, end_turn_id) DO UPDATE SET
        turn_ids_json = excluded.turn_ids_json,
        source_hash = excluded.source_hash,
        token_estimate = excluded.token_estimate,
        summary_text = excluded.summary_text,
        updated_at = excluded.updated_at
    `);
    this.listByBranchStmt = db.prepare(`
      SELECT * FROM chat_conversation_summaries
      WHERE session_id = @sessionId
        AND branch_head_turn_id = @branchHeadTurnId
      ORDER BY created_at ASC
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM chat_conversation_summaries
      WHERE session_id = @sessionId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
  }

  public get(summaryId: string): ChatConversationSummaryRecord {
    const row = this.getStmt.get(summaryId) as ChatConversationSummaryRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Chat conversation summary", id: summaryId });
    }
    return mapRow(row);
  }

  public upsert(input: ChatConversationSummaryUpsertInput): ChatConversationSummaryRecord {
    const summaryId = input.summaryId ?? randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;
    this.upsertStmt.run({
      summaryId,
      sessionId: input.sessionId,
      branchHeadTurnId: input.branchHeadTurnId,
      startTurnId: input.startTurnId,
      endTurnId: input.endTurnId,
      turnIdsJson: JSON.stringify(input.turnIds),
      sourceHash: input.sourceHash,
      tokenEstimate: input.tokenEstimate,
      summary: input.summary,
      createdAt,
      updatedAt,
    });

    const rows = this.listByBranchStmt.all({
      sessionId: input.sessionId,
      branchHeadTurnId: input.branchHeadTurnId,
    }) as unknown as ChatConversationSummaryRow[];
    const match = rows.find((row) =>
      row.start_turn_id === input.startTurnId
      && row.end_turn_id === input.endTurnId
    );
    if (!match) {
      throw new NotFoundError("Failed to read chat conversation summary after upsert");
    }
    return mapRow(match);
  }

  public listByBranch(sessionId: string, branchHeadTurnId: string): ChatConversationSummaryRecord[] {
    const rows = this.listByBranchStmt.all({
      sessionId,
      branchHeadTurnId,
    }) as unknown as ChatConversationSummaryRow[];
    return rows.map(mapRow);
  }

  public listBySession(sessionId: string, limit = 50): ChatConversationSummaryRecord[] {
    const rows = this.listBySessionStmt.all({
      sessionId,
      limit: Math.max(1, Math.min(limit, 500)),
    }) as unknown as ChatConversationSummaryRow[];
    return rows.map(mapRow);
  }
}

function mapRow(row: ChatConversationSummaryRow): ChatConversationSummaryRecord {
  return {
    summaryId: row.summary_id,
    sessionId: row.session_id,
    branchHeadTurnId: row.branch_head_turn_id,
    startTurnId: row.start_turn_id,
    endTurnId: row.end_turn_id,
    turnIds: safeJsonParse<string[]>(row.turn_ids_json, []),
    sourceHash: row.source_hash,
    tokenEstimate: row.token_estimate,
    summary: row.summary_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
