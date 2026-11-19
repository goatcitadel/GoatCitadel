import { createHash } from "node:crypto";
import type { ScriptInventoryItem } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { CodeModeRunRepository } from "./code-mode-run-repo.js";

type Reference = Omit<ScriptInventoryItem, "retention" | "retentionVersion" | "expiresAt">;
/** Read projection only: no file discovery, content copying, or execution-record mutation. */
export class ScriptInventoryRepository {
  constructor(private readonly db: DatabaseClient) {}

  public list(workspaceId: string): Reference[] {
    const items: Reference[] = [];
    const add = (item: Omit<Reference, "id" | "workspaceId">) => {
      items.push({
        ...item,
        workspaceId,
        id: createHash("sha256")
          .update(JSON.stringify([workspaceId, item.kind, item.sourceId, item.runId ?? null]))
          .digest("hex"),
      });
    };
    const generated = this.db
      .prepare(
        `SELECT a.artifact_id, a.title, a.session_id, a.turn_id, a.project_id, a.created_at
      FROM chat_generated_artifacts a JOIN chat_session_meta m ON m.session_id = a.session_id
      WHERE a.workspace_id = ? AND m.workspace_id = a.workspace_id
      ORDER BY a.created_at DESC, a.artifact_id LIMIT 1000`,
      )
      .all<{
        artifact_id: string;
        title: string;
        session_id: string;
        turn_id: string;
        project_id: string | null;
        created_at: string;
      }>(workspaceId);
    for (const artifact of generated) {
      add({
        kind: "generated",
        sourceId: artifact.artifact_id,
        title: artifact.title,
        sessionId: artifact.session_id,
        turnId: artifact.turn_id,
        projectId: artifact.project_id ?? undefined,
        createdAt: artifact.created_at,
      });
    }
    const files = this.db
      .prepare(
        `SELECT r.project_id, r.path, r.path_key, r.revision_id
      FROM managed_project_file_heads h JOIN managed_project_file_revisions r
      USING (workspace_id, project_id, path_key, revision_id)
      JOIN chat_projects p ON p.project_id = r.project_id AND p.workspace_id = r.workspace_id
      WHERE r.workspace_id = ? AND r.content_sha256 IS NOT NULL AND p.lifecycle_status = 'active'
      ORDER BY r.project_id, r.path_key LIMIT 1000`,
      )
      .all<{ project_id: string; path: string; path_key: string; revision_id: string }>(workspaceId);
    for (const file of files)
      add({
        kind: "managed",
        sourceId: JSON.stringify([file.project_id, file.path_key]),
        title: file.path,
        path: file.path,
        projectId: file.project_id,
        revision: file.revision_id,
      });
    const toolArtifacts = this.db
      .prepare(
        `SELECT a.artifact_id, a.session_id, a.turn_id, a.tool_name, a.created_at, m.title
      FROM chat_tool_artifacts a JOIN chat_session_meta m ON m.session_id = a.session_id
      WHERE m.workspace_id = ? ORDER BY a.created_at DESC, a.artifact_id LIMIT 1000`,
      )
      .all<{
        artifact_id: string;
        session_id: string;
        turn_id: string;
        tool_name: string;
        created_at: string;
        title: string | null;
      }>(workspaceId);
    for (const artifact of toolArtifacts)
      add({
        kind: "tool",
        sourceId: artifact.artifact_id,
        title: `${artifact.title || "Conversation"} · tool output`,
        sessionId: artifact.session_id,
        turnId: artifact.turn_id,
        createdAt: artifact.created_at,
      });
    const writes = this.db
      .prepare(
        `SELECT t.tool_run_id, t.session_id, t.turn_id, t.tool_name, t.result_json, t.finished_at
      FROM chat_tool_runs t JOIN chat_session_meta m ON m.session_id = t.session_id
      WHERE m.workspace_id = ? AND t.status = 'executed'
      AND t.tool_name IN ('fs.write', 'artifacts.create', 'documents.create', 'presentations.create', 'project.files.save')
      ORDER BY t.started_at DESC, t.tool_run_id LIMIT 1000`,
      )
      .all<{
        tool_run_id: string;
        session_id: string;
        turn_id: string;
        tool_name: string;
        result_json: string | null;
        finished_at: string;
      }>(workspaceId);
    const seen = new Set<string>();
    for (const write of writes) {
      let result: { path?: unknown; revisionId?: unknown; projectId?: unknown };
      try {
        result = JSON.parse(write.result_json || "{}");
      } catch {
        continue;
      }
      if (write.tool_name === "project.files.save") {
        const managed = items.find(
          (item) =>
            item.kind === "managed" &&
            item.sessionId === undefined &&
            item.revision === result?.revisionId &&
            item.projectId === result?.projectId,
        );
        if (managed) {
          managed.sessionId = write.session_id;
          managed.turnId = write.turn_id;
          managed.createdAt = write.finished_at;
        }
        continue;
      }
      if (typeof result?.path !== "string" || !result.path || seen.has(result.path)) continue;
      seen.add(result.path);
      add({
        kind: "workspace",
        sourceId: result.path,
        title: result.path.replaceAll("\\", "/").split("/").pop() || "Created file",
        path: result.path,
        sessionId: write.session_id,
        turnId: write.turn_id,
        createdAt: write.finished_at,
      });
    }
    const runs = new CodeModeRunRepository(this.db).listFiltered({ workspaceId, limit: 1000 });
    const sessionIds = [...new Set(runs.flatMap((run) => (run.sessionId ? [run.sessionId] : [])))];
    const workspaceSessions = new Set<string>();
    const batchSize = 200;
    for (let offset = 0; offset < sessionIds.length; offset += batchSize) {
      const batch = sessionIds.slice(offset, offset + batchSize);
      const sessions = this.db
        .prepare(
          `SELECT session_id FROM chat_session_meta WHERE workspace_id = ? AND session_id IN (${batch.map(() => "?").join(", ")})`,
        )
        .all<{ session_id: string }>(workspaceId, ...batch);
      for (const session of sessions) workspaceSessions.add(session.session_id);
    }
    for (const run of runs) {
      if (run.workspaceId !== workspaceId) continue;
      if (run.sessionId && !workspaceSessions.has(run.sessionId)) continue;
      // The run's code artifact is immutable evidence; retention is separate operator metadata.
      add({
        kind: "code",
        sourceId: run.codeArtifact.artifactId,
        title: `Code · ${run.language === "typescript" ? "TypeScript" : "JavaScript"}`,
        runId: run.runId,
        sessionId: run.sessionId,
        turnId: run.turnId,
        createdAt: run.createdAt,
      });
    }
    return items;
  }
}
