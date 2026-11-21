import { createHash, randomUUID } from "node:crypto";
import {
  ConflictError,
  ValidationError,
  redactSecretText,
  redactStructuredSecrets,
  type MemoryToolWriteBinding,
  type ToolExecutionTrustLevel,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { KnowledgeRepository } from "./knowledge-repo.js";
import { MEMORY_ITEM_ORIGIN_COLUMNS, memoryItemSourceHash } from "./memory-item-source.js";

interface PrepareNoteInput {
  sessionId: string;
  workspaceId?: string;
  namespace: string;
  title: string;
  upsert: boolean;
  trustLevel: ToolExecutionTrustLevel;
  expectedItemId?: string;
  expectedSourceHash?: string;
}
export interface WriteMemoryNoteInput {
  binding: MemoryToolWriteBinding;
  namespace: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  chunks: Array<{ content: string; embedding?: number[]; embeddingMetadata?: Record<string, unknown> }>;
  actorId: string;
  upsert: boolean;
}
/** Canonical note, scope, history and immutable write artifact share one transaction. */
export class MemoryNoteRepository {
  public constructor(private readonly db: DatabaseClient) {}
  public prepareWrite(input: PrepareNoteInput): MemoryToolWriteBinding {
    return this.db.transaction("immediate", () => {
      const scope = this.scope(input.sessionId, input.workspaceId);
      const upsertKey = createHash("sha256")
        .update(
          JSON.stringify([
            scope.workspaceId,
            scope.visibility === "session" ? [scope.sessionId, scope.sessionIncarnation] : null,
            input.namespace,
            input.title,
          ]),
        )
        .digest("hex");
      const binding: MemoryToolWriteBinding = { ...scope, trustLevel: input.trustLevel, upsertKey };
      if (!input.upsert) return binding;
      const matches = this.db
        .prepare(
          `SELECT s.*, ${MEMORY_ITEM_ORIGIN_COLUMNS} 0 AS unused FROM memory_items s JOIN memory_item_origins o ON o.item_id=s.item_id
        WHERE o.workspace_id=? AND s.namespace=? AND s.title=? AND ((?='workspace' AND o.owner_session_id IS NULL) OR
          (?='session' AND o.owner_session_id=? AND o.source_incarnation=?)) AND s.status='active' AND (s.expires_at IS NULL OR s.expires_at>?)
        ORDER BY s.item_id LIMIT 2`,
        )
        .all<Record<string, unknown>>(
          scope.workspaceId,
          input.namespace,
          input.title,
          scope.visibility,
          scope.visibility,
          scope.sessionId,
          scope.sessionIncarnation,
          new Date().toISOString(),
        );
      const current = matches[0];
      if (
        matches.length > 1 ||
        (current &&
          (input.expectedItemId !== current.item_id || input.expectedSourceHash !== memoryItemSourceHash(current))) ||
        (!current && (input.expectedItemId || input.expectedSourceHash))
      ) {
        throw new ConflictError({
          message: "Review the current memory target and its source hash before replacing it.",
        });
      }
      return current
        ? { ...binding, expectedItemId: String(current.item_id), expectedSourceHash: memoryItemSourceHash(current) }
        : binding;
    });
  }
  public write(input: WriteMemoryNoteInput) {
    if (
      input.content.length > 65_536 ||
      !input.content.trim() ||
      input.namespace.length > 200 ||
      input.title.length > 500 ||
      redactSecretText(input.content.normalize("NFKC"), { env: process.env }).redactionCount ||
      redactStructuredSecrets(
        { namespace: input.namespace, title: input.title, metadata: input.metadata },
        { env: process.env },
      ).redactionCount ||
      redactSecretText(JSON.stringify([input.namespace, input.title, input.metadata]).normalize("NFKC"), {
        env: process.env,
      }).redactionCount
    ) {
      throw new ValidationError({ message: "Memory must be bounded and cannot store credential values." });
    }
    return this.db.transaction("immediate", () => {
      const workspace = this.db
        .prepare(
          `SELECT workspace_id FROM workspaces WHERE workspace_id=? AND lifecycle_status='active'${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
        )
        .get(input.binding.workspaceId);
      if (!workspace) throw new ConflictError({ message: "Memory workspace is unavailable." });
      const current = this.prepareWrite({
        ...input.binding,
        namespace: input.namespace,
        title: input.title,
        upsert: input.upsert,
      });
      if (JSON.stringify(current) !== JSON.stringify(input.binding))
        throw new ConflictError({ message: "Memory write scope or incarnation changed after review." });
      const meta = this.db
        .prepare("SELECT created_at,lifecycle_intent_id FROM chat_session_meta WHERE session_id=?")
        .get<{ created_at: string; lifecycle_intent_id: string | null }>(current.sessionId)!;
      const itemId = current.expectedItemId ?? randomUUID(),
        now = new Date().toISOString();
      const metadata = {
        ...input.metadata,
        ingestion: { ...object(input.metadata.ingestion), trustLevel: current.trustLevel },
      };
      if (current.expectedItemId) {
        // The source hash is rechecked under the canonical item lock, after model work and before any write.
        const row = this.db
          .prepare(
            `SELECT s.*, ${MEMORY_ITEM_ORIGIN_COLUMNS} 0 AS unused FROM memory_items s JOIN memory_item_origins o ON o.item_id=s.item_id WHERE s.item_id=?${this.db.dialect === "postgres" ? " FOR UPDATE OF s,o" : ""}`,
          )
          .get<Record<string, unknown>>(itemId);
        if (!row || memoryItemSourceHash(row) !== current.expectedSourceHash || row.status !== "active")
          throw new ConflictError({ message: "Memory target changed after review." });
        this.db
          .prepare("UPDATE memory_items SET title=?,content=?,metadata_json=?,updated_at=? WHERE item_id=?")
          .run(input.title, input.content, JSON.stringify(metadata), now, itemId);
      } else {
        this.db
          .prepare(
            `INSERT INTO memory_items(item_id,workspace_id,namespace,title,content,metadata_json,pinned,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,0,'active',?,?)`,
          )
          .run(
            itemId,
            current.workspaceId,
            input.namespace,
            input.title,
            input.content,
            JSON.stringify(metadata),
            now,
            now,
          );
      }
      const artifact = new KnowledgeRepository(this.db).createDocumentWithChunks(
        {
          namespace: input.namespace,
          workspaceId: current.workspaceId,
          ...(current.visibility === "session" ? { sessionId: current.sessionId } : {}),
          sourceType: "memory",
          sourceRef: `memory-item:${itemId}`,
          title: input.title,
          metadata: {
            ...metadata,
            memoryItemId: itemId,
            memoryItemContentSha256: createHash("sha256").update(input.content).digest("hex"),
            writeArtifact: true,
          },
        },
        input.chunks,
      );
      this.db
        .prepare(
          `INSERT INTO memory_item_origins(item_id,workspace_id,source_session_id,source_created_at,source_lifecycle_id,source_incarnation,owner_session_id,trust_level,upsert_key,artifact_doc_id)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET trust_level=excluded.trust_level,upsert_key=excluded.upsert_key,artifact_doc_id=excluded.artifact_doc_id`,
        )
        .run(
          itemId,
          current.workspaceId,
          current.sessionId,
          meta.created_at,
          meta.lifecycle_intent_id ?? "",
          current.sessionIncarnation,
          current.visibility === "session" ? current.sessionId : null,
          current.trustLevel,
          current.upsertKey,
          artifact.document.docId,
        );
      this.db
        .prepare(
          "INSERT INTO memory_change_history(change_id,item_id,change_type,actor_id,payload_json,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          itemId,
          current.expectedItemId ? "updated" : "created",
          input.actorId,
          JSON.stringify({ artifactDocId: artifact.document.docId, visibility: current.visibility }),
          now,
        );
      const row = this.db
        .prepare(
          `SELECT s.*, ${MEMORY_ITEM_ORIGIN_COLUMNS} 0 AS unused FROM memory_items s JOIN memory_item_origins o ON o.item_id=s.item_id WHERE s.item_id=?`,
        )
        .get<Record<string, unknown>>(itemId)!;
      return { ...artifact, itemId, sourceHash: memoryItemSourceHash(row) };
    });
  }
  private scope(
    sessionId: string,
    expectedWorkspace?: string,
  ): Omit<MemoryToolWriteBinding, "trustLevel" | "upsertKey"> {
    const row = this.db
      .prepare(
        `SELECT m.workspace_id,m.created_at,m.lifecycle_intent_id,m.origin,s.kind FROM chat_session_meta m JOIN sessions s ON s.session_id=m.session_id
      WHERE m.session_id=? AND m.lifecycle_status='active' AND m.deletion_intent_id IS NULL${this.db.dialect === "postgres" ? " FOR SHARE OF m,s" : ""}`,
      )
      .get<{
        workspace_id: string;
        created_at: string;
        lifecycle_intent_id: string | null;
        origin: string;
        kind: string;
      }>(sessionId);
    if (!row || (expectedWorkspace !== undefined && expectedWorkspace !== row.workspace_id))
      throw new ConflictError({ message: "Canonical memory session scope is unavailable or changed." });
    const sessionIncarnation = createHash("sha256")
      .update(
        JSON.stringify([sessionId, row.workspace_id, row.created_at, row.lifecycle_intent_id, row.origin, row.kind]),
      )
      .digest("hex");
    return {
      workspaceId: row.workspace_id,
      sessionId,
      sessionIncarnation,
      visibility: row.kind === "dm" && row.origin === "operator" ? "workspace" : "session",
    };
  }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
