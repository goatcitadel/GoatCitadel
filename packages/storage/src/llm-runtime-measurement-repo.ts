import type {
  LlmRuntimeMeasurementRecord,
  LlmRuntimeMeasurementsQuery,
  LlmRuntimeMeasurementStatus,
  LlmRuntimeMeasurementSource,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface LlmRuntimeMeasurementRow {
  measurement_id: string;
  provider_id: string;
  model: string;
  engine_kind: LlmRuntimeMeasurementRecord["engineKind"];
  source: LlmRuntimeMeasurementSource;
  status: LlmRuntimeMeasurementStatus;
  stream: boolean | number;
  session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  metrics_json: string;
  provenance_json: string;
  error_text: string | null;
  collected_at: string;
}

export class LlmRuntimeMeasurementRepository {
  private readonly insertStmt;
  private readonly listStmt;
  private readonly latestStmt;

  public constructor(private readonly db: DatabaseClient) {
    const optionalTextFilter = (column: string, param: string) =>
      this.db.dialect === "postgres"
        ? `(${param}::text IS NULL OR ${column} = ${param}::text)`
        : `(${param} IS NULL OR ${column} = ${param})`;
    this.insertStmt = db.prepare(`
      INSERT INTO llm_runtime_measurements (
        measurement_id, provider_id, model, engine_kind, source, status, stream,
        session_id, task_id, run_id, metrics_json, provenance_json, error_text, collected_at
      ) VALUES (
        @measurementId, @providerId, @model, @engineKind, @source, @status, @stream,
        @sessionId, @taskId, @runId, @metricsJson, @provenanceJson, @errorText, @collectedAt
      )
    `);
    this.listStmt = db.prepare(`
      SELECT *
      FROM llm_runtime_measurements
      WHERE ${optionalTextFilter("provider_id", "@providerId")}
        AND ${optionalTextFilter("model", "@model")}
        AND ${optionalTextFilter("source", "@source")}
        AND ${optionalTextFilter("status", "@status")}
      ORDER BY collected_at DESC, measurement_id DESC
      LIMIT @limit
    `);
    this.latestStmt = db.prepare(`
      SELECT *
      FROM llm_runtime_measurements
      WHERE provider_id = @providerId
        AND model = @model
      ORDER BY collected_at DESC, measurement_id DESC
      LIMIT 1
    `);
  }

  public insert(record: LlmRuntimeMeasurementRecord): LlmRuntimeMeasurementRecord {
    this.insertStmt.run({
      measurementId: record.measurementId,
      providerId: record.providerId,
      model: record.model,
      engineKind: record.engineKind,
      source: record.source,
      status: record.status,
      stream: this.db.dialect === "postgres" ? record.stream : record.stream ? 1 : 0,
      sessionId: record.sessionId ?? null,
      taskId: record.taskId ?? null,
      runId: record.runId ?? null,
      metricsJson: JSON.stringify(record.metrics),
      provenanceJson: JSON.stringify(record.provenance),
      errorText: record.error ?? null,
      collectedAt: record.collectedAt,
    });
    return record;
  }

  public list(query: LlmRuntimeMeasurementsQuery = {}): LlmRuntimeMeasurementRecord[] {
    const rows = this.listStmt.all({
      providerId: normalizeOptional(query.providerId),
      model: normalizeOptional(query.model),
      source: normalizeOptional(query.source),
      status: normalizeOptional(query.status),
      limit: Math.max(1, Math.min(query.limit ?? 50, 500)),
    }) as LlmRuntimeMeasurementRow[];
    return rows.map(mapRow);
  }

  public latest(providerId: string, model: string): LlmRuntimeMeasurementRecord | undefined {
    const row = this.latestStmt.get({
      providerId: providerId.trim(),
      model: model.trim(),
    }) as LlmRuntimeMeasurementRow | undefined;
    return row ? mapRow(row) : undefined;
  }
}

function normalizeOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mapRow(row: LlmRuntimeMeasurementRow): LlmRuntimeMeasurementRecord {
  return {
    measurementId: row.measurement_id,
    providerId: row.provider_id,
    model: row.model,
    engineKind: row.engine_kind,
    source: row.source,
    status: row.status,
    stream: Boolean(row.stream),
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    runId: row.run_id ?? undefined,
    collectedAt: row.collected_at,
    metrics: safeJsonParse<LlmRuntimeMeasurementRecord["metrics"]>(row.metrics_json, {}),
    provenance: safeJsonParse<LlmRuntimeMeasurementRecord["provenance"]>(row.provenance_json, {
      collector: "gateway",
      path: "runtime_probe",
    }),
    error: row.error_text ?? undefined,
  };
}
