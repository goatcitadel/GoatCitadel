import type { DatabaseSync } from "node:sqlite";
import { NotFoundError } from "@goatcitadel/contracts";

export interface ChatToolArtifactRecord {
  artifactId: string;
  sessionId: string;
  turnId: string;
  toolRunId: string;
  toolName: string;
  contentType?: string;
  byteLength: number;
  snippet?: string;
  storageRelPath: string;
  createdAt: string;
}

interface ChatToolArtifactRow {
  artifact_id: string;
  session_id: string;
  turn_id: string;
  tool_run_id: string;
  tool_name: string;
  content_type: string | null;
  byte_length: number;
  snippet: string | null;
  storage_rel_path: string;
  created_at: string;
}

export class ChatToolArtifactRepository {
  private readonly insertStmt;
  private readonly listByTurnStmt;
  private readonly listBySessionStmt;
  private readonly getStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.insertStmt = db.prepare(`
      INSERT INTO chat_tool_artifacts (
        artifact_id, session_id, turn_id, tool_run_id, tool_name, content_type, byte_length, snippet, storage_rel_path, created_at
      ) VALUES (
        @artifactId, @sessionId, @turnId, @toolRunId, @toolName, @contentType, @byteLength, @snippet, @storageRelPath, @createdAt
      )
    `);
    this.listByTurnStmt = db.prepare(`
      SELECT *
      FROM chat_tool_artifacts
      WHERE turn_id = ?
      ORDER BY created_at ASC
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT *
      FROM chat_tool_artifacts
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this.getStmt = db.prepare(`
      SELECT *
      FROM chat_tool_artifacts
      WHERE artifact_id = ?
      LIMIT 1
    `);
  }

  public create(input: ChatToolArtifactRecord): ChatToolArtifactRecord {
    this.insertStmt.run({
      artifactId: input.artifactId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolRunId: input.toolRunId,
      toolName: input.toolName,
      contentType: input.contentType ?? null,
      byteLength: input.byteLength,
      snippet: input.snippet ?? null,
      storageRelPath: input.storageRelPath,
      createdAt: input.createdAt,
    });
    return this.get(input.artifactId);
  }

  public get(artifactId: string): ChatToolArtifactRecord {
    const row = this.getStmt.get(artifactId) as ChatToolArtifactRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Chat tool artifact", id: artifactId });
    }
    return mapRow(row);
  }

  public listByTurn(turnId: string): ChatToolArtifactRecord[] {
    const rows = this.listByTurnStmt.all(turnId) as unknown as ChatToolArtifactRow[];
    return rows.map(mapRow);
  }

  public listBySession(sessionId: string, limit = 500): ChatToolArtifactRecord[] {
    const rows = this.listBySessionStmt.all(sessionId, Math.max(1, Math.min(limit, 5_000))) as unknown as ChatToolArtifactRow[];
    return rows.map(mapRow);
  }
}

function mapRow(row: ChatToolArtifactRow): ChatToolArtifactRecord {
  return {
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    toolRunId: row.tool_run_id,
    toolName: row.tool_name,
    contentType: row.content_type ?? undefined,
    byteLength: row.byte_length,
    snippet: row.snippet ?? undefined,
    storageRelPath: row.storage_rel_path,
    createdAt: row.created_at,
  };
}
