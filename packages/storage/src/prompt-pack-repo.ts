import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  PromptPackDiagnosticMetadata,
  PromptPackPolicySource,
  PromptPackPolicyV2,
  PromptPackRecord,
  PromptPackTestRecord,
  RunVariableSchema,
} from "@goatcitadel/contracts";
import {
  DEFAULT_PROMPT_PACK_POLICY_V2,
  hashRunVariableSchema,
  normalizeRunVariableSchema,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { hashPromptPackPolicyV2, parsePromptPackPolicyV2, stringifyPromptPackPolicyV2 } from "./prompt-pack-policy.js";

interface PromptPackRow {
  pack_id: string;
  name: string;
  source_label: string | null;
  test_count: number;
  policy_v2_json: string | null;
  policy_v2_hash: string | null;
  policy_v2_source: string | null;
  content_sha256?: string | null;
  run_variable_schema_json?: string | null;
  run_variable_schema_hash?: string | null;
  created_at: string;
  updated_at: string;
}

interface PromptPackTestRow {
  test_id: string;
  pack_id: string;
  code: string;
  title: string;
  prompt: string;
  order_index: number;
  mode: string | null;
  tool_tier: string | null;
  diagnostic_metadata_json: string | null;
  created_at: string;
}

export class PromptPackRepository {
  private readonly getPackStmt;
  private readonly listPacksStmt;
  private readonly upsertPackStmt;
  private readonly deleteTestsByPackStmt;
  private readonly insertTestStmt;
  private readonly listTestsStmt;
  private readonly getTestStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getPackStmt = db.prepare("SELECT * FROM prompt_packs WHERE pack_id = ?");
    this.listPacksStmt = db.prepare(`
      SELECT * FROM prompt_packs
      ORDER BY updated_at DESC
      LIMIT @limit
    `);
    this.upsertPackStmt = db.prepare(`
      INSERT INTO prompt_packs (
        pack_id, name, source_label, test_count,
        policy_v2_json, policy_v2_hash, policy_v2_source,
        content_sha256, run_variable_schema_json, run_variable_schema_hash,
        created_at, updated_at
      )
      VALUES (
        @packId, @name, @sourceLabel, @testCount,
        @policyV2Json, @policyV2Hash, @policyV2Source,
        @contentSha256, @runVariableSchemaJson, @runVariableSchemaHash,
        @createdAt, @updatedAt
      )
      ON CONFLICT(pack_id) DO UPDATE SET
        name = excluded.name,
        source_label = excluded.source_label,
        test_count = excluded.test_count,
        policy_v2_json = excluded.policy_v2_json,
        policy_v2_hash = excluded.policy_v2_hash,
        policy_v2_source = excluded.policy_v2_source,
        content_sha256 = COALESCE(excluded.content_sha256, prompt_packs.content_sha256),
        run_variable_schema_json = excluded.run_variable_schema_json,
        run_variable_schema_hash = excluded.run_variable_schema_hash,
        updated_at = excluded.updated_at
    `);
    this.deleteTestsByPackStmt = db.prepare("DELETE FROM prompt_pack_tests WHERE pack_id = ?");
    this.insertTestStmt = db.prepare(`
      INSERT INTO prompt_pack_tests (
        test_id, pack_id, code, title, prompt, order_index, mode, tool_tier, diagnostic_metadata_json, created_at
      )
      VALUES (
        @testId, @packId, @code, @title, @prompt, @orderIndex, @mode, @toolTier, @diagnosticMetadataJson, @createdAt
      )
    `);
    this.listTestsStmt = db.prepare(`
      SELECT * FROM prompt_pack_tests
      WHERE pack_id = @packId
      ORDER BY order_index ASC, created_at ASC
      LIMIT @limit
    `);
    this.getTestStmt = db.prepare("SELECT * FROM prompt_pack_tests WHERE test_id = ?");
  }

  public getPack(packId: string): PromptPackRecord {
    const row = toPromptPackRow(this.getPackStmt.get(packId));
    if (!row) {
      throw new NotFoundError({ entity: "Prompt pack", id: packId });
    }
    return mapPackRow(row);
  }

  public listPacks(limit = 100): PromptPackRecord[] {
    const rows = toPromptPackRows(
      this.listPacksStmt.all({
        limit: Math.max(1, Math.min(limit, 1000)),
      }),
    );
    return rows.map(mapPackRow);
  }

  public listTests(packId: string, limit = 1000): PromptPackTestRecord[] {
    const rows = toPromptPackTestRows(
      this.listTestsStmt.all({
        packId,
        limit: Math.max(1, Math.min(limit, 5000)),
      }),
    );
    return rows.map(mapTestRow);
  }

  public getTest(testId: string): PromptPackTestRecord {
    const row = toPromptPackTestRow(this.getTestStmt.get(testId));
    if (!row) {
      throw new NotFoundError({ entity: "Prompt pack test", id: testId });
    }
    return mapTestRow(row);
  }

  public replacePackTests(input: {
    packId?: string;
    name: string;
    sourceLabel?: string;
    contentSha256?: string;
    tests: Array<{
      code: string;
      title: string;
      prompt: string;
      orderIndex: number;
      mode?: string;
      toolTier?: string;
      diagnosticMetadata?: PromptPackDiagnosticMetadata;
    }>;
    policyV2?: PromptPackPolicyV2;
    policySource?: PromptPackPolicySource;
    runVariableSchema?: RunVariableSchema;
  }): {
    pack: PromptPackRecord;
    tests: PromptPackTestRecord[];
  } {
    const now = new Date().toISOString();
    const packId = input.packId ?? `pack-${randomUUID()}`;
    const existing = toPromptPackRow(this.getPackStmt.get(packId));
    const existingSource = normalizePolicySource(existing?.policy_v2_source);
    const existingPolicy = parsePromptPackPolicyV2(existing?.policy_v2_json);
    const resolvedSource = input.policySource ?? existingSource ?? "inherited_default";
    const resolvedPolicy =
      input.policyV2 ??
      (resolvedSource === "pack_override" ? existingPolicy : DEFAULT_PROMPT_PACK_POLICY_V2) ??
      DEFAULT_PROMPT_PACK_POLICY_V2;
    const runVariableSchema = input.runVariableSchema ? normalizeRunVariableSchema(input.runVariableSchema) : undefined;
    this.db.transaction("immediate", () => {
      this.upsertPackStmt.run({
        packId,
        name: input.name,
        sourceLabel: input.sourceLabel ?? null,
        testCount: input.tests.length,
        policyV2Json: stringifyPromptPackPolicyV2(resolvedPolicy),
        policyV2Hash: hashPromptPackPolicyV2(resolvedPolicy),
        policyV2Source: resolvedSource,
        contentSha256: input.contentSha256 ?? null,
        runVariableSchemaJson: runVariableSchema ? JSON.stringify(runVariableSchema) : null,
        runVariableSchemaHash: runVariableSchema ? hashRunVariableSchema(runVariableSchema) : null,
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
      });

      this.deleteTestsByPackStmt.run(packId);
      for (const test of input.tests) {
        this.insertTestStmt.run({
          testId: `ppt-${randomUUID()}`,
          packId,
          code: test.code,
          title: test.title,
          prompt: test.prompt,
          orderIndex: test.orderIndex,
          mode: test.mode ?? null,
          toolTier: test.toolTier ?? null,
          diagnosticMetadataJson: test.diagnosticMetadata ? JSON.stringify(test.diagnosticMetadata) : null,
          createdAt: now,
        });
      }
    });

    return {
      pack: this.getPack(packId),
      tests: this.listTests(packId, Math.max(1000, input.tests.length + 10)),
    };
  }
}

function mapPackRow(row: PromptPackRow): PromptPackRecord {
  const policySource = normalizePolicySource(row.policy_v2_source) ?? "inherited_default";
  const storedPolicy = parsePromptPackPolicyV2(row.policy_v2_json);
  const policy =
    policySource === "pack_override" ? (storedPolicy ?? DEFAULT_PROMPT_PACK_POLICY_V2) : DEFAULT_PROMPT_PACK_POLICY_V2;
  const storedPolicyHash =
    typeof row.policy_v2_hash === "string" && row.policy_v2_hash.trim().length > 0 ? row.policy_v2_hash : undefined;
  const policyHash =
    policySource === "pack_override"
      ? (storedPolicyHash ?? hashPromptPackPolicyV2(storedPolicy ?? policy))
      : hashPromptPackPolicyV2(policy);
  return {
    packId: row.pack_id,
    name: row.name,
    sourceLabel: row.source_label ?? undefined,
    testCount: row.test_count,
    policyV2: policy,
    policyHash,
    policySource,
    contentSha256: row.content_sha256 ?? undefined,
    runVariableSchema: row.run_variable_schema_json
      ? safeJsonParse<RunVariableSchema | undefined>(row.run_variable_schema_json, undefined)
      : undefined,
    runVariableSchemaHash: row.run_variable_schema_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTestRow(row: PromptPackTestRow): PromptPackTestRecord {
  return {
    testId: row.test_id,
    packId: row.pack_id,
    code: row.code,
    title: row.title,
    prompt: row.prompt,
    orderIndex: row.order_index,
    mode: (row.mode as PromptPackTestRecord["mode"]) ?? undefined,
    toolTier: (row.tool_tier as PromptPackTestRecord["toolTier"]) ?? undefined,
    diagnosticMetadata: row.diagnostic_metadata_json
      ? safeJsonParse<PromptPackDiagnosticMetadata | undefined>(row.diagnostic_metadata_json, undefined)
      : undefined,
    createdAt: row.created_at,
  };
}

function toPromptPackRow(value: unknown): PromptPackRow | undefined {
  return isPromptPackRow(value) ? value : undefined;
}

function toPromptPackRows(value: unknown): PromptPackRow[] {
  return Array.isArray(value) ? value.filter(isPromptPackRow) : [];
}

function toPromptPackTestRow(value: unknown): PromptPackTestRow | undefined {
  return isPromptPackTestRow(value) ? value : undefined;
}

function toPromptPackTestRows(value: unknown): PromptPackTestRow[] {
  return Array.isArray(value) ? value.filter(isPromptPackTestRow) : [];
}

function isPromptPackRow(value: unknown): value is PromptPackRow {
  return (
    isRecord(value) &&
    typeof value.pack_id === "string" &&
    typeof value.name === "string" &&
    (typeof value.source_label === "string" || value.source_label === null) &&
    typeof value.test_count === "number" &&
    (typeof value.policy_v2_json === "string" || value.policy_v2_json === null) &&
    (typeof value.policy_v2_hash === "string" || value.policy_v2_hash === null) &&
    (typeof value.policy_v2_source === "string" || value.policy_v2_source === null) &&
    // Tolerate a missing column (pre-migration DB) but reject wrong types.
    (typeof value.content_sha256 === "string" || value.content_sha256 === null || value.content_sha256 === undefined) &&
    (typeof value.run_variable_schema_json === "string" ||
      value.run_variable_schema_json === null ||
      value.run_variable_schema_json === undefined) &&
    (typeof value.run_variable_schema_hash === "string" ||
      value.run_variable_schema_hash === null ||
      value.run_variable_schema_hash === undefined) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isPromptPackTestRow(value: unknown): value is PromptPackTestRow {
  return (
    isRecord(value) &&
    typeof value.test_id === "string" &&
    typeof value.pack_id === "string" &&
    typeof value.code === "string" &&
    typeof value.title === "string" &&
    typeof value.prompt === "string" &&
    typeof value.order_index === "number" &&
    (typeof value.mode === "string" || value.mode === null) &&
    (typeof value.tool_tier === "string" || value.tool_tier === null) &&
    (typeof value.diagnostic_metadata_json === "string" || value.diagnostic_metadata_json === null) &&
    typeof value.created_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizePolicySource(value?: string | null): PromptPackPolicySource | undefined {
  return value === "pack_override" || value === "inherited_default" ? value : undefined;
}
