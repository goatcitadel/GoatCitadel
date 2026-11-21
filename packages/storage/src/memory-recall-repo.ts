import { createHash } from "node:crypto";
import type {
  MemoryCorpusSearchRequest,
  MemoryCorpusSearchResult,
  MemoryRecallSourceType,
  RecallCoverage,
  RecallHit,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { buildMemoryWorkspaceScopeSql } from "./memory-maintenance-repo.js";
import { mapLearning, type LearningRow } from "./memory-learning-repo.js";
import { safeJsonParse } from "./safe-json.js";
import type { MemoryVectorEntry } from "./memory-recall-vector-index.js";
import { MEMORY_ITEM_ORIGIN_COLUMNS, memoryItemSourceHash } from "./memory-item-source.js";

const definitions = {
  memory_item: { table: "memory_items", id: "item_id", text: "COALESCE(s.title, '') || ' ' || s.content" },
  memory_learning: { table: "memory_learnings", id: "learning_id", text: "s.learning_key || ' ' || s.insight" },
  knowledge_chunk: { table: "knowledge_chunks", id: "chunk_id", text: "s.content" },
} as const;
const sourceTypes = Object.keys(definitions) as MemoryRecallSourceType[];
type SourceRow = Record<string, unknown>;

/** Query syntax is generated from bounded Unicode words, never model-supplied FTS operators. */
export function memoryRecallQueryTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .slice(0, 8000)
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}_]+/gu) ?? [],
    ),
  ]
    .filter((token) => token.length > 1)
    .slice(0, 32);
}

export class MemoryRecallRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public searchEligibleCorpus(input: MemoryCorpusSearchRequest): MemoryCorpusSearchResult {
    if (!this.privateScope(input)) return { hits: [], coverage: unavailableCoverage("private_session_unavailable") };
    const tokens = memoryRecallQueryTokens(input.query);
    const kinds = sourceTypes.filter((kind) => !input.sourceTypes || input.sourceTypes.includes(kind));
    const limit = Math.max(1, Math.min(300, Math.floor(input.limit ?? 40)));
    const params = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      now: new Date().toISOString(),
      limit,
      query: tokens
        .map((token) => (this.db.dialect === "sqlite" ? `"${token}"` : token))
        .join(this.db.dialect === "sqlite" ? " OR " : " | "),
    };
    const hits: RecallHit[] = [];
    let indexedCount = 0;
    let unindexedCount = 0;
    for (const kind of kinds) {
      const definition = definitions[kind];
      const canonicalJoin = this.canonicalJoin(kind);
      const namespaceFilter = input.namespace
        ? kind === "knowledge_chunk"
          ? " AND kd.namespace = @namespace"
          : kind === "memory_item"
            ? " AND s.namespace = @namespace"
            : " AND @namespace = 'learnings'"
        : "";
      const eligibility = this.eligibility(kind) + namespaceFilter;
      const queryParams = { ...params, namespace: input.namespace };
      const countSql = `SELECT
        COUNT(d.source_ref) AS indexed,
        COALESCE(SUM(CASE WHEN d.source_ref IS NULL THEN 1 ELSE 0 END), 0) AS unindexed
        FROM ${definition.table} s ${canonicalJoin}
        LEFT JOIN memory_recall_documents d ON d.source_kind = '${kind}' AND d.source_ref = s.${definition.id}
        WHERE ${eligibility}`;
      const counts = this.db
        .prepare(countSql)
        .get<{ indexed: number; unindexed: number }>(bindReferenced(countSql, queryParams));
      indexedCount += Number(counts?.indexed ?? 0);
      unindexedCount += Number(counts?.unindexed ?? 0);
      if (!tokens.length) {
        const recentSql = `SELECT s.*, ${this.documentColumns(kind)} 0 AS recall_score FROM ${definition.table} s ${canonicalJoin}
          WHERE ${eligibility} ORDER BY s.${kind === "knowledge_chunk" ? "created_at" : "updated_at"} DESC, s.${definition.id} ASC LIMIT @limit`;
        hits.push(
          ...this.db
            .prepare(recentSql)
            .all<SourceRow>(bindReferenced(recentSql, queryParams))
            .map((row) => this.hit(kind, row, input.workspaceId, [])),
        );
        continue;
      }
      const ftsJoin = this.db.dialect === "sqlite" ? "JOIN memory_recall_fts ON memory_recall_fts.rowid = d.rowid" : "";
      const match =
        this.db.dialect === "sqlite"
          ? "memory_recall_fts MATCH @query"
          : "to_tsvector('simple', d.search_text) @@ to_tsquery('simple', @query)";
      const score =
        this.db.dialect === "sqlite"
          ? "-bm25(memory_recall_fts)"
          : "ts_rank_cd(to_tsvector('simple', d.search_text), to_tsquery('simple', @query))";
      const searchSql = `SELECT s.*, ${this.documentColumns(kind)} ${score} AS recall_score
        FROM memory_recall_documents d ${ftsJoin}
        JOIN ${definition.table} s ON s.${definition.id} = d.source_ref ${canonicalJoin}
        WHERE d.source_kind = '${kind}' AND ${match} AND ${eligibility}
        ORDER BY recall_score DESC, s.${definition.id} ASC LIMIT @limit`;
      const rows = this.db.prepare(searchSql).all<SourceRow>(bindReferenced(searchSql, queryParams));
      hits.push(...rows.map((row) => this.hit(kind, row, input.workspaceId, tokens)));
    }
    const generation = Number(
      this.db.prepare("SELECT generation FROM memory_recall_state WHERE singleton = 1").get<{ generation: number }>()
        ?.generation ?? 0,
    );
    return {
      hits: hits
        .sort((a, b) => b.lexicalScore - a.lexicalScore || a.sourceRef.localeCompare(b.sourceRef))
        .slice(0, limit),
      coverage: {
        generation,
        lexicalStatus: unindexedCount ? "building" : "ready",
        semanticStatus: "unavailable",
        indexedCount,
        unindexedCount,
        reason: unindexedCount
          ? "Historical sources are being indexed in bounded pages."
          : "Lexical retrieval; semantic index is not bound.",
      },
    };
  }

  /** Re-admission checks do not consult the search index or a cached eligibility projection. */
  public getEligibleSources(input: {
    workspaceId: string;
    sessionId: string;
    sources: Array<{ sourceType: MemoryRecallSourceType; sourceRef: string }>;
  }): RecallHit[] {
    if (!this.privateScope(input)) return [];
    const result: RecallHit[] = [];
    for (const source of input.sources.slice(0, 300)) {
      const definition = definitions[source.sourceType];
      if (!definition) continue;
      const sql = `SELECT s.*, ${this.documentColumns(source.sourceType)} 0 AS recall_score
        FROM ${definition.table} s ${this.canonicalJoin(source.sourceType)}
        WHERE s.${definition.id} = @sourceRef AND ${this.eligibility(source.sourceType)}`;
      const row = this.db.prepare(sql).get<SourceRow>(
        bindReferenced(sql, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sourceRef: source.sourceRef,
          now: new Date().toISOString(),
        }),
      );
      if (row) result.push(this.hit(source.sourceType, row, input.workspaceId, []));
    }
    return result;
  }

  /** Default recall reads complete bytes and their hash together, independently of the optional index. */
  public listEligibleMemoryItemSources(input: {
    workspaceId: string;
    sessionId: string;
    limit?: number;
  }): Array<RecallHit & { metadata: Record<string, unknown>; pinned: boolean }> {
    if (!this.privateScope(input)) return [];
    const sql = `SELECT s.*, ${this.documentColumns("memory_item")} 0 AS recall_score FROM memory_items s ${this.canonicalJoin("memory_item")}
      WHERE ${this.eligibility("memory_item")} ORDER BY s.pinned DESC,s.updated_at DESC,s.item_id LIMIT @limit`;
    return this.db
      .prepare(sql)
      .all<SourceRow>(
        bindReferenced(sql, {
          ...input,
          now: new Date().toISOString(),
          limit: Math.max(1, Math.min(300, input.limit ?? 300)),
        }),
      )
      .map((row) => ({
        ...this.hit("memory_item", row, input.workspaceId, []),
        snippet: String(row.content),
        metadata: safeJsonParse<Record<string, unknown>>(String(row.metadata_json), {}),
        pinned: row.pinned === 1,
      }));
  }

  public backfillPage(input: { limit?: number } = {}): { indexed: number; hasMore: boolean } {
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 200)));
    return this.db.transaction("immediate", () => {
      let indexed = 0;
      for (const kind of sourceTypes) {
        if (indexed >= limit) break;
        const definition = definitions[kind];
        const rows = this.db
          .prepare(
            `SELECT s.${definition.id} AS source_ref, ${definition.text} AS search_text
          FROM ${definition.table} s WHERE NOT EXISTS (SELECT 1 FROM memory_recall_documents d
            WHERE d.source_kind = '${kind}' AND d.source_ref = s.${definition.id})
          ORDER BY s.${definition.id} LIMIT @limit ${this.db.dialect === "postgres" ? "FOR SHARE OF s" : ""}`,
          )
          .all<{ source_ref: string; search_text: string }>({ limit: limit - indexed });
        for (const row of rows) {
          this.db
            .prepare(
              `INSERT INTO memory_recall_documents(source_kind, source_ref, search_text) VALUES (?, ?, ?)
            ON CONFLICT(source_kind, source_ref) DO UPDATE SET search_text = excluded.search_text`,
            )
            .run(kind, row.source_ref, row.search_text);
          indexed++;
        }
      }
      if (indexed)
        this.db.prepare("UPDATE memory_recall_state SET generation = generation + 1 WHERE singleton = 1").run();
      const hasMore = sourceTypes.some((kind) => {
        const definition = definitions[kind];
        return Boolean(
          this.db
            .prepare(
              `SELECT 1 AS found FROM ${definition.table} s WHERE NOT EXISTS
          (SELECT 1 FROM memory_recall_documents d WHERE d.source_kind = '${kind}' AND d.source_ref = s.${definition.id}) LIMIT 1`,
            )
            .get(),
        );
      });
      return { indexed, hasMore };
    });
  }

  public readGeneration(): number {
    return Number(
      this.db.prepare("SELECT generation FROM memory_recall_state WHERE singleton = 1").get<{ generation: number }>()
        ?.generation ?? 0,
    );
  }

  public listVectorPage(input: { workspaceId: string; sessionId: string; after?: string; limit?: number }): {
    entries: MemoryVectorEntry[];
    hasMore: boolean;
    after?: string;
  } {
    if (!this.privateScope(input)) return { entries: [], hasMore: false };
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 200)));
    const rows = this.db
      .prepare(
        `SELECT s.chunk_id,s.embedding_json,s.embedding_metadata_json,'knowledge_chunk' AS source_kind,s.chunk_id AS source_ref,NULL AS note_content,NULL AS note_metadata FROM knowledge_chunks s
      JOIN knowledge_documents kd ON kd.doc_id = s.doc_id WHERE ${this.eligibility("knowledge_chunk")}
      AND s.chunk_id > @after AND s.embedding_json IS NOT NULL
      UNION ALL
      SELECT c.chunk_id,c.embedding_json,c.embedding_metadata_json,'memory_item' AS source_kind,s.item_id AS source_ref,s.content AS note_content,kd.metadata_json AS note_metadata
      FROM memory_items s JOIN memory_item_origins o ON o.item_id=s.item_id JOIN knowledge_documents kd ON kd.doc_id=o.artifact_doc_id JOIN knowledge_chunks c ON c.doc_id=kd.doc_id
      WHERE ${this.eligibility("memory_item")} AND LENGTH(s.content)<=65536 AND c.chunk_id>@after AND c.embedding_json IS NOT NULL
      ORDER BY chunk_id LIMIT @limit`,
      )
      .all<{
        chunk_id: string;
        source_kind: "knowledge_chunk" | "memory_item";
        source_ref: string;
        note_content: string | null;
        note_metadata: string | null;
        embedding_json: string;
        embedding_metadata_json: string | null;
      }>({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        after: input.after ?? "",
        limit: limit + 1,
        now: new Date().toISOString(),
      });
    const page = rows.slice(0, limit);
    const current = page.filter(
      (row) =>
        row.source_kind !== "memory_item" ||
        (row.note_metadata &&
          row.note_metadata.length <= 200_000 &&
          safeJsonParse<Record<string, unknown>>(row.note_metadata, {}).memoryItemContentSha256 ===
            createHash("sha256")
              .update(row.note_content ?? "")
              .digest("hex")),
    );
    return {
      entries: current.map((row) => ({
        sourceType: row.source_kind,
        sourceRef: row.source_ref,
        vectorRef: row.chunk_id,
        vector: row.embedding_json.length <= 200_000 ? safeJsonParse<number[]>(row.embedding_json, []) : [],
        metadata:
          row.embedding_metadata_json && row.embedding_metadata_json.length <= 8000
            ? safeJsonParse<Record<string, unknown>>(row.embedding_metadata_json, {})
            : {},
      })),
      hasMore: rows.length > limit,
      after: page.at(-1)?.chunk_id,
    };
  }

  private privateScope(input: { workspaceId: string; sessionId: string }): boolean {
    if (!input.workspaceId?.trim() || !input.sessionId?.trim()) return false;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 AS allowed FROM sessions s JOIN chat_session_meta m ON m.session_id = s.session_id
      WHERE s.session_id = ? AND s.kind = 'dm' AND m.origin='operator' AND m.workspace_id = ? AND m.lifecycle_status = 'active' AND m.deletion_intent_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM chat_session_prefs p WHERE p.session_id=s.session_id AND p.memory_mode='off')`,
        )
        .get(input.sessionId, input.workspaceId),
    );
  }

  private canonicalJoin(kind: MemoryRecallSourceType): string {
    return kind === "knowledge_chunk"
      ? "JOIN knowledge_documents kd ON kd.doc_id = s.doc_id"
      : kind === "memory_item"
        ? "LEFT JOIN memory_item_origins o ON o.item_id=s.item_id"
        : "";
  }

  private documentColumns(kind: MemoryRecallSourceType): string {
    return kind === "knowledge_chunk"
      ? "kd.workspace_id AS doc_workspace_id, kd.session_id AS doc_session_id, kd.source_type AS doc_source_type, kd.source_ref AS doc_source_ref, kd.namespace AS doc_namespace, kd.title AS doc_title, kd.metadata_json AS doc_metadata_json, kd.created_at AS doc_created_at,"
      : kind === "memory_item"
        ? MEMORY_ITEM_ORIGIN_COLUMNS
        : "";
  }

  private eligibility(kind: MemoryRecallSourceType): string {
    if (kind === "memory_item")
      return `s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > @now) AND ${buildMemoryWorkspaceScopeSql(this.db.dialect).replace(/\b(workspace_id|metadata_json|metadata_doc)\b/g, "s.$1")}
      AND (o.item_id IS NULL OR (o.workspace_id=@workspaceId AND (o.owner_session_id IS NULL OR (o.owner_session_id=@sessionId AND EXISTS (
        SELECT 1 FROM chat_session_meta om WHERE om.session_id=@sessionId AND om.created_at=o.source_created_at AND COALESCE(om.lifecycle_intent_id,'')=o.source_lifecycle_id)))))`;
    if (kind === "knowledge_chunk")
      return "kd.workspace_id = @workspaceId AND kd.source_type = 'memory' AND kd.source_ref NOT LIKE 'memory-item:%' AND (kd.session_id IS NULL OR kd.session_id = @sessionId)";
    return `s.workspace_id = @workspaceId AND s.status = 'trusted' AND s.authority IN ('operator', 'trusted_lifecycle') AND
      (s.claim_scope_kind IS NULL OR (s.claim_scope_kind = 'workspace' AND s.claim_scope_id = @workspaceId)
       OR (s.claim_scope_kind = 'session' AND s.claim_scope_id = @sessionId)
       OR (s.claim_scope_kind = 'project' AND EXISTS (SELECT 1 FROM chat_session_projects a JOIN chat_projects p ON p.project_id = a.project_id
         WHERE a.session_id = @sessionId AND p.project_id = s.claim_scope_id AND p.workspace_id = @workspaceId AND p.lifecycle_status = 'active')))`;
  }

  private hit(kind: MemoryRecallSourceType, row: SourceRow, workspaceId: string, tokens: string[]): RecallHit {
    const definition = definitions[kind];
    const content = String(kind === "memory_learning" ? row.insight : row.content);
    const title = String(
      kind === "memory_learning" ? row.learning_key : kind === "knowledge_chunk" ? row.doc_title : row.title,
    );
    const sourceHash =
      kind === "memory_learning"
        ? mapLearning(row as unknown as LearningRow).sourceHash!
        : kind === "memory_item"
          ? memoryItemSourceHash(row)
          : createHash("sha256")
              .update(
                JSON.stringify([
                  1,
                  kind,
                  row.chunk_id,
                  row.doc_id,
                  row.seq,
                  row.content,
                  row.created_at,
                  row.doc_workspace_id,
                  row.doc_session_id,
                  row.doc_source_type,
                  row.doc_source_ref,
                  row.doc_title,
                  row.doc_metadata_json,
                ]),
              )
              .digest("hex");
    const lower = content.toLowerCase();
    const positions = tokens.map((token) => lower.indexOf(token)).filter((position) => position >= 0);
    const offset = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 160);
    return {
      sourceType: kind,
      sourceRef: String(row[definition.id]),
      sourceHash,
      workspaceId,
      title,
      namespace:
        kind === "knowledge_chunk"
          ? String(row.doc_namespace)
          : kind === "memory_item"
            ? String(row.namespace)
            : "learnings",
      ...(kind === "knowledge_chunk" ? { docId: String(row.doc_id) } : {}),
      ...(kind === "knowledge_chunk"
        ? { documentSourceRef: String(row.doc_source_ref), trustLevel: knowledgeTrustLevel(row.doc_metadata_json) }
        : {}),
      ...(kind === "memory_item"
        ? { trustLevel: (row.note_trust_level as RecallHit["trustLevel"]) ?? knowledgeTrustLevel(row.metadata_json) }
        : {}),
      snippet: content.slice(offset, offset + 1600),
      updatedAt: String(row.updated_at ?? row.created_at),
      lexicalScore: Number(row.recall_score ?? 0),
    };
  }
}

function unavailableCoverage(reason: string): RecallCoverage {
  return {
    generation: 0,
    indexedCount: 0,
    unindexedCount: 0,
    lexicalStatus: "unavailable",
    semanticStatus: "unavailable",
    reason,
  };
}

function bindReferenced(sql: string, values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [...new Set([...sql.matchAll(/@([a-zA-Z_][a-zA-Z_0-9]*)/g)].map((match) => match[1]!))].map((name) => [
      name,
      values[name],
    ]),
  );
}

function knowledgeTrustLevel(raw: unknown): NonNullable<RecallHit["trustLevel"]> {
  const metadata = typeof raw === "string" ? safeJsonParse<Record<string, unknown> | null>(raw, null) : null;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "untrusted_external";
  const levels = ["trusted_operator", "trusted_workspace", "mixed_untrusted", "untrusted_external"] as const;
  const ingestion = metadata.ingestion as { trustLevel?: unknown } | undefined;
  const carried = Array.isArray(metadata.sourceAttribution)
    ? metadata.sourceAttribution.map((value) => value?.trustLevel)
    : [];
  const index = [ingestion?.trustLevel, ...carried].reduce<number>(
    (current, value) => Math.max(current, levels.indexOf(value as (typeof levels)[number])),
    1,
  );
  return levels[index]!;
}
