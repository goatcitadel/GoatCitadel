import { NotFoundError } from "@goatcitadel/contracts";
import type { ChatSessionForkManifest, ChatSessionForkRelationship } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface ForkRow {
  fork_id: string;
  source_session_id: string;
  source_turn_id: string;
  new_session_id: string;
  workspace_id: string;
  transcript_path_hash: string;
  manifest_json: string;
  created_at: string;
}

export class ChatSessionForkRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO chat_session_fork_manifests (
        fork_id, source_session_id, source_turn_id, new_session_id, workspace_id,
        transcript_path_hash, manifest_json, created_at
      ) VALUES (
        @forkId, @sourceSessionId, @sourceTurnId, @newSessionId, @workspaceId,
        @transcriptPathHash, @manifestJson, @createdAt
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM chat_session_fork_manifests WHERE fork_id = ?");
    this.listStmt = db.prepare(`
      SELECT * FROM chat_session_fork_manifests
      WHERE source_session_id = @sessionId OR new_session_id = @sessionId
      ORDER BY created_at DESC, fork_id DESC
    `);
  }

  public create(manifest: ChatSessionForkManifest): ChatSessionForkManifest {
    this.insertStmt.run({
      forkId: manifest.forkId,
      sourceSessionId: manifest.sourceSessionId,
      sourceTurnId: manifest.sourceTurnId,
      newSessionId: manifest.newSessionId,
      workspaceId: manifest.workspaceId,
      transcriptPathHash: manifest.transcriptPathHash,
      manifestJson: JSON.stringify(manifest),
      createdAt: manifest.createdAt,
    });
    return this.get(manifest.forkId);
  }

  public get(forkId: string): ChatSessionForkManifest {
    const row = this.getStmt.get(forkId) as ForkRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Chat session fork", id: forkId });
    }
    return JSON.parse(row.manifest_json) as ChatSessionForkManifest;
  }

  public listRelationships(sessionId: string, workspaceId?: string): ChatSessionForkRelationship[] {
    const rows = this.listStmt.all({ sessionId }) as ForkRow[];
    return rows.flatMap((row) => {
      if (workspaceId && row.workspace_id !== workspaceId) {
        return [];
      }
      const direction = row.new_session_id === sessionId ? "forked_from" : "forked_to";
      return [
        {
          forkId: row.fork_id,
          direction,
          relatedSessionId: direction === "forked_from" ? row.source_session_id : row.new_session_id,
          sourceTurnId: row.source_turn_id,
          transcriptPathHash: row.transcript_path_hash,
          createdAt: row.created_at,
        } satisfies ChatSessionForkRelationship,
      ];
    });
  }
}
