import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";
import type {
  ImportedAgentCatalogListInput,
  ImportedAgentCatalogRecord,
  ImportedAgentCatalogStatePatchInput,
  ImportedAgentCatalogLifecycleStatus,
  RichAgentDefinitionRecord,
  RichAgentFrontmatter,
  RichAgentParseSupportStatus,
  RichAgentSectionMap,
  RichAgentSourceProvider,
  RichAgentSourceProvenance,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";

interface ImportedAgentCatalogRow {
  entry_id: string;
  workspace_id: string;
  division: string;
  state: ImportedAgentCatalogLifecycleStatus;
  definition_id: string;
  slug: string;
  frontmatter_json: string;
  raw_markdown: string;
  body_markdown: string;
  section_order_json: string;
  section_map_json: string;
  parse_status: RichAgentParseSupportStatus;
  parse_warnings_json: string;
  provenance_provider: RichAgentSourceProvider;
  provenance_repo_url: string | null;
  provenance_ref: string | null;
  provenance_commit: string | null;
  provenance_path: string;
  provenance_sha256: string;
  imported_at: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  retired_at: string | null;
  search_text: string;
}

export class ImportedAgentCatalogRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly patchStateStmt;
  private readonly listDivisionsStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM imported_agent_catalog WHERE entry_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO imported_agent_catalog (
        entry_id, workspace_id, division, state, definition_id, slug, frontmatter_json, raw_markdown, body_markdown,
        section_order_json, section_map_json, parse_status, parse_warnings_json, provenance_provider,
        provenance_repo_url, provenance_ref, provenance_commit, provenance_path, provenance_sha256, imported_at,
        created_at, updated_at, activated_at, retired_at, search_text
      ) VALUES (
        @entryId, @workspaceId, @division, @state, @definitionId, @slug, @frontmatterJson, @rawMarkdown, @bodyMarkdown,
        @sectionOrderJson, @sectionMapJson, @parseStatus, @parseWarningsJson, @provenanceProvider,
        @provenanceRepoUrl, @provenanceRef, @provenanceCommit, @provenancePath, @provenanceSha256, @importedAt,
        @createdAt, @updatedAt, @activatedAt, @retiredAt, @searchText
      )
      ON CONFLICT(entry_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        division = excluded.division,
        state = excluded.state,
        definition_id = excluded.definition_id,
        slug = excluded.slug,
        frontmatter_json = excluded.frontmatter_json,
        raw_markdown = excluded.raw_markdown,
        body_markdown = excluded.body_markdown,
        section_order_json = excluded.section_order_json,
        section_map_json = excluded.section_map_json,
        parse_status = excluded.parse_status,
        parse_warnings_json = excluded.parse_warnings_json,
        provenance_provider = excluded.provenance_provider,
        provenance_repo_url = excluded.provenance_repo_url,
        provenance_ref = excluded.provenance_ref,
        provenance_commit = excluded.provenance_commit,
        provenance_path = excluded.provenance_path,
        provenance_sha256 = excluded.provenance_sha256,
        imported_at = excluded.imported_at,
        updated_at = excluded.updated_at,
        activated_at = excluded.activated_at,
        retired_at = excluded.retired_at,
        search_text = excluded.search_text
    `);
    this.patchStateStmt = db.prepare(`
      UPDATE imported_agent_catalog
      SET
        state = @state,
        updated_at = @updatedAt,
        activated_at = @activatedAt,
        retired_at = @retiredAt
      WHERE entry_id = @entryId
    `);
    this.listDivisionsStmt = db.prepare(`
      SELECT DISTINCT division
      FROM imported_agent_catalog
      WHERE workspace_id = @workspaceId
      ORDER BY division ASC
    `);
  }

  public get(entryId: string): ImportedAgentCatalogRecord {
    const row = toImportedAgentCatalogRow(this.getStmt.get(sanitizeRequired(entryId, "entryId")));
    if (!row) {
      throw new NotFoundError({ entity: "Imported agent catalog entry", id: entryId });
    }
    return mapRow(row);
  }

  public list(input: ImportedAgentCatalogListInput = {}): ImportedAgentCatalogRecord[] {
    const params: Record<string, unknown> = {
      workspaceId: sanitizeWorkspaceId(input.workspaceId),
      limit: clampLimit(input.limit),
    };
    const clauses = ["workspace_id = @workspaceId"];

    if (input.division?.trim()) {
      params.division = input.division.trim();
      clauses.push("division = @division");
    }
    if (input.state && input.state !== "all") {
      params.state = input.state;
      clauses.push("state = @state");
    }
    if (input.parseStatus && input.parseStatus !== "all") {
      params.parseStatus = input.parseStatus;
      clauses.push("parse_status = @parseStatus");
    }
    if (input.search?.trim()) {
      const searchTerms = input.search.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      searchTerms.forEach((term, index) => {
        const paramKey = `search${index}`;
        params[paramKey] = `%${term}%`;
        clauses.push(`search_text LIKE @${paramKey}`);
      });
    }

    const sql = `
      SELECT *
      FROM imported_agent_catalog
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC, division ASC, slug ASC
      LIMIT @limit
    `;
    const rows = toImportedAgentCatalogRows(this.db.prepare(sql).all(params));
    return rows.map(mapRow);
  }

  public listDivisions(workspaceId?: string): string[] {
    const rows = this.listDivisionsStmt.all({
      workspaceId: sanitizeWorkspaceId(workspaceId),
    }) as Array<{ division?: unknown }>;
    return rows.map((row) => (typeof row.division === "string" ? row.division.trim() : "")).filter(Boolean);
  }

  public upsertMany(records: ImportedAgentCatalogRecord[]): ImportedAgentCatalogRecord[] {
    this.db.transaction("immediate", () => {
      for (const record of records) {
        this.upsertStmt.run(serializeRecord(record));
      }
    });
    return records.map((record) => this.get(record.entryId));
  }

  public patchState(
    entryId: string,
    input: ImportedAgentCatalogStatePatchInput,
    now = new Date().toISOString(),
  ): ImportedAgentCatalogRecord {
    const current = this.get(entryId);
    const nextState = input.state;
    this.patchStateStmt.run({
      entryId,
      state: nextState,
      updatedAt: now,
      activatedAt: nextState === "active" ? (current.activatedAt ?? now) : null,
      retiredAt: nextState === "retired" ? (current.retiredAt ?? now) : null,
    });
    return this.get(entryId);
  }
}

function mapRow(row: ImportedAgentCatalogRow): ImportedAgentCatalogRecord {
  const provenance: RichAgentSourceProvenance = {
    provider: row.provenance_provider,
    repoUrl: row.provenance_repo_url ?? undefined,
    ref: row.provenance_ref ?? undefined,
    commit: row.provenance_commit ?? undefined,
    path: row.provenance_path,
    sha256: row.provenance_sha256,
    importedAt: row.imported_at,
  };
  const definition: RichAgentDefinitionRecord = {
    definitionId: row.definition_id,
    slug: row.slug,
    frontmatter: safeJsonParse<RichAgentFrontmatter>(row.frontmatter_json, {
      name: row.slug,
      description: "",
    }),
    rawMarkdown: row.raw_markdown,
    bodyMarkdown: row.body_markdown,
    sectionOrder: safeJsonParse<string[]>(row.section_order_json, []),
    sectionMap: safeJsonParse<RichAgentSectionMap>(row.section_map_json, {}),
    parseStatus: row.parse_status,
    parseWarnings: safeJsonParse<string[]>(row.parse_warnings_json, []),
    provenance,
  };
  return {
    entryId: row.entry_id,
    workspaceId: row.workspace_id,
    division: row.division,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at ?? undefined,
    retiredAt: row.retired_at ?? undefined,
    definition,
  };
}

function serializeRecord(record: ImportedAgentCatalogRecord): Record<string, unknown> {
  return {
    entryId: sanitizeRequired(record.entryId, "entryId"),
    workspaceId: sanitizeWorkspaceId(record.workspaceId),
    division: sanitizeRequired(record.division, "division"),
    state: record.state,
    definitionId: sanitizeRequired(record.definition.definitionId, "definitionId"),
    slug: sanitizeRequired(record.definition.slug, "slug"),
    frontmatterJson: JSON.stringify(record.definition.frontmatter),
    rawMarkdown: record.definition.rawMarkdown,
    bodyMarkdown: record.definition.bodyMarkdown,
    sectionOrderJson: JSON.stringify(record.definition.sectionOrder),
    sectionMapJson: JSON.stringify(record.definition.sectionMap),
    parseStatus: record.definition.parseStatus,
    parseWarningsJson: JSON.stringify(record.definition.parseWarnings),
    provenanceProvider: record.definition.provenance.provider,
    provenanceRepoUrl: record.definition.provenance.repoUrl ?? null,
    provenanceRef: record.definition.provenance.ref ?? null,
    provenanceCommit: record.definition.provenance.commit ?? null,
    provenancePath: sanitizeRequired(record.definition.provenance.path, "path"),
    provenanceSha256: sanitizeRequired(record.definition.provenance.sha256, "sha256"),
    importedAt: record.definition.provenance.importedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    activatedAt: record.activatedAt ?? null,
    retiredAt: record.retiredAt ?? null,
    searchText: buildSearchText(record),
  };
}

function buildSearchText(record: ImportedAgentCatalogRecord): string {
  const sections = record.definition.sectionOrder.map((key) => {
    const section = record.definition.sectionMap[key];
    return section ? `${section.heading} ${section.content}` : "";
  });
  return [
    record.division,
    record.definition.slug,
    record.definition.frontmatter.name,
    record.definition.frontmatter.description,
    ...(record.definition.frontmatter.services ?? []),
    ...sections,
  ]
    .join(" ")
    .toLowerCase();
}

function sanitizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return normalized;
}

function sanitizeWorkspaceId(value?: string): string {
  const normalized = value?.trim() || "default";
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(normalized)) {
    throw new ValidationError({ message: "workspaceId contains unsupported characters" });
  }
  return normalized;
}

function clampLimit(value?: number): number {
  const normalized = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 200;
  return Math.max(1, Math.min(1000, normalized));
}

function toImportedAgentCatalogRow(value: unknown): ImportedAgentCatalogRow | undefined {
  return isImportedAgentCatalogRow(value) ? value : undefined;
}

function toImportedAgentCatalogRows(value: unknown): ImportedAgentCatalogRow[] {
  return Array.isArray(value) ? value.filter(isImportedAgentCatalogRow) : [];
}

function isImportedAgentCatalogRow(value: unknown): value is ImportedAgentCatalogRow {
  return (
    isRecord(value) &&
    typeof value.entry_id === "string" &&
    typeof value.workspace_id === "string" &&
    typeof value.division === "string" &&
    typeof value.state === "string" &&
    typeof value.definition_id === "string" &&
    typeof value.slug === "string" &&
    typeof value.frontmatter_json === "string" &&
    typeof value.raw_markdown === "string" &&
    typeof value.body_markdown === "string" &&
    typeof value.section_order_json === "string" &&
    typeof value.section_map_json === "string" &&
    typeof value.parse_status === "string" &&
    typeof value.parse_warnings_json === "string" &&
    typeof value.provenance_provider === "string" &&
    (typeof value.provenance_repo_url === "string" || value.provenance_repo_url === null) &&
    (typeof value.provenance_ref === "string" || value.provenance_ref === null) &&
    (typeof value.provenance_commit === "string" || value.provenance_commit === null) &&
    typeof value.provenance_path === "string" &&
    typeof value.provenance_sha256 === "string" &&
    typeof value.imported_at === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    (typeof value.activated_at === "string" || value.activated_at === null) &&
    (typeof value.retired_at === "string" || value.retired_at === null) &&
    typeof value.search_text === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
