import type { DatabaseSync } from "node:sqlite";
import type {
  AdversarialReview,
  AssemblyArtifactRecord,
  AssemblyArtifactType,
  AssemblyResult,
  AssemblyRound,
  AssemblyRunRecord,
  AssemblyRunStatus,
  AssemblyStage,
  ConvergenceScore,
  DefenseResponse,
  AssemblyUsageSummary,
  ModelReputation,
  PeerReview,
} from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface AssemblyRunRow {
  run_id: string;
  workspace_id: string | null;
  source_session_id: string | null;
  source_task_id: string | null;
  title: string;
  status: AssemblyRunStatus;
  current_stage: AssemblyStage;
  current_round_index: number;
  problem_json: string;
  settings_json: string;
  adversarial_settings_json: string;
  result_json: string | null;
  stop_reason: string | null;
  usage_json: string | null;
  error_text: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface AssemblyRoundRow {
  round_id: string;
  run_id: string;
  round_index: number;
  stage: AssemblyStage;
  status: AssemblyRound["status"];
  participant_ids_json: string;
  artifact_ids_json: string;
  convergence_snapshot_json: string | null;
  stop_check_json: string | null;
  started_at: string;
  finished_at: string | null;
}

interface AssemblyArtifactRow {
  artifact_id: string;
  run_id: string;
  round_index: number;
  stage: AssemblyStage;
  artifact_type: AssemblyArtifactType;
  participant_model_ref: string | null;
  blinded_author_token: string | null;
  payload_json: string;
  created_at: string;
}

interface AssemblyReputationRow {
  model_ref: string;
  provider_id: string;
  model_id: string;
  overall: number;
  by_domain_json: string;
  accuracy: number;
  reasoning_strength: number;
  critique_quality: number;
  consensus_leadership: number;
  stability: number;
  adversarial_usefulness: number;
  sample_count: number;
  updated_at: string;
}

export class AssemblyRepository {
  private readonly getRunStmt;
  private readonly createRunStmt;
  private readonly updateRunStmt;
  private readonly listRunsStmt;
  private readonly createRoundStmt;
  private readonly updateRoundArtifactsStmt;
  private readonly updateRoundResultStmt;
  private readonly listRoundsStmt;
  private readonly createArtifactStmt;
  private readonly listArtifactsStmt;
  private readonly upsertReputationStmt;
  private readonly listReputationsStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getRunStmt = db.prepare("SELECT * FROM assembly_runs WHERE run_id = ?");
    this.createRunStmt = db.prepare(`
      INSERT INTO assembly_runs (
        run_id,
        workspace_id,
        source_session_id,
        source_task_id,
        title,
        status,
        current_stage,
        current_round_index,
        problem_json,
        settings_json,
        adversarial_settings_json,
        result_json,
        stop_reason,
        usage_json,
        error_text,
        created_at,
        started_at,
        finished_at,
        updated_at
      ) VALUES (
        @runId,
        @workspaceId,
        @sourceSessionId,
        @sourceTaskId,
        @title,
        @status,
        @currentStage,
        @currentRoundIndex,
        @problemJson,
        @settingsJson,
        @adversarialSettingsJson,
        @resultJson,
        @stopReason,
        @usageJson,
        @errorText,
        @createdAt,
        @startedAt,
        @finishedAt,
        @updatedAt
      )
    `);
    this.updateRunStmt = db.prepare(`
      UPDATE assembly_runs
      SET
        title = @title,
        status = @status,
        current_stage = @currentStage,
        current_round_index = @currentRoundIndex,
        result_json = @resultJson,
        stop_reason = @stopReason,
        usage_json = @usageJson,
        error_text = @errorText,
        started_at = @startedAt,
        finished_at = @finishedAt,
        updated_at = @updatedAt
      WHERE run_id = @runId
    `);
    this.listRunsStmt = db.prepare(`
      SELECT * FROM assembly_runs
      ORDER BY updated_at DESC, created_at DESC
      LIMIT @limit
    `);
    this.createRoundStmt = db.prepare(`
      INSERT INTO assembly_rounds (
        round_id,
        run_id,
        round_index,
        stage,
        status,
        participant_ids_json,
        artifact_ids_json,
        convergence_snapshot_json,
        stop_check_json,
        started_at,
        finished_at
      ) VALUES (
        @roundId,
        @runId,
        @roundIndex,
        @stage,
        @status,
        @participantIdsJson,
        @artifactIdsJson,
        @convergenceSnapshotJson,
        @stopCheckJson,
        @startedAt,
        @finishedAt
      )
      ON CONFLICT(round_id) DO UPDATE SET
        stage = excluded.stage,
        status = excluded.status,
        participant_ids_json = excluded.participant_ids_json,
        artifact_ids_json = excluded.artifact_ids_json,
        convergence_snapshot_json = excluded.convergence_snapshot_json,
        stop_check_json = excluded.stop_check_json,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at
    `);
    this.updateRoundArtifactsStmt = db.prepare(`
      UPDATE assembly_rounds
      SET artifact_ids_json = @artifactIdsJson
      WHERE round_id = @roundId
    `);
    this.updateRoundResultStmt = db.prepare(`
      UPDATE assembly_rounds
      SET
        status = @status,
        convergence_snapshot_json = @convergenceSnapshotJson,
        stop_check_json = @stopCheckJson,
        finished_at = @finishedAt
      WHERE round_id = @roundId
    `);
    this.listRoundsStmt = db.prepare(`
      SELECT * FROM assembly_rounds
      WHERE run_id = @runId
      ORDER BY round_index ASC, started_at ASC
    `);
    this.createArtifactStmt = db.prepare(`
      INSERT OR REPLACE INTO assembly_artifacts (
        artifact_id,
        run_id,
        round_index,
        stage,
        artifact_type,
        participant_model_ref,
        blinded_author_token,
        payload_json,
        created_at
      ) VALUES (
        @artifactId,
        @runId,
        @roundIndex,
        @stage,
        @artifactType,
        @participantModelRef,
        @blindedAuthorToken,
        @payloadJson,
        @createdAt
      )
    `);
    this.listArtifactsStmt = db.prepare(`
      SELECT * FROM assembly_artifacts
      WHERE run_id = @runId
        AND (@artifactType IS NULL OR artifact_type = @artifactType)
      ORDER BY round_index ASC, created_at ASC, artifact_id ASC
    `);
    this.upsertReputationStmt = db.prepare(`
      INSERT INTO assembly_reputation (
        model_ref,
        provider_id,
        model_id,
        overall,
        by_domain_json,
        accuracy,
        reasoning_strength,
        critique_quality,
        consensus_leadership,
        stability,
        adversarial_usefulness,
        sample_count,
        updated_at
      ) VALUES (
        @modelRef,
        @providerId,
        @modelId,
        @overall,
        @byDomainJson,
        @accuracy,
        @reasoningStrength,
        @critiqueQuality,
        @consensusLeadership,
        @stability,
        @adversarialUsefulness,
        @sampleCount,
        @updatedAt
      )
      ON CONFLICT(model_ref) DO UPDATE SET
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        overall = excluded.overall,
        by_domain_json = excluded.by_domain_json,
        accuracy = excluded.accuracy,
        reasoning_strength = excluded.reasoning_strength,
        critique_quality = excluded.critique_quality,
        consensus_leadership = excluded.consensus_leadership,
        stability = excluded.stability,
        adversarial_usefulness = excluded.adversarial_usefulness,
        sample_count = excluded.sample_count,
        updated_at = excluded.updated_at
    `);
    this.listReputationsStmt = db.prepare(`
      SELECT * FROM assembly_reputation
      ORDER BY overall DESC, sample_count DESC, updated_at DESC
      LIMIT @limit
    `);
  }

  public createRun(run: AssemblyRunRecord): AssemblyRunRecord {
    this.createRunStmt.run(serializeRun(run));
    return this.getRun(run.runId);
  }

  public getRun(runId: string): AssemblyRunRecord {
    const row = toAssemblyRunRow(this.getRunStmt.get(runId));
    if (!row) {
      throw new Error(`Assembly run ${runId} not found`);
    }
    return mapRunRow(row);
  }

  public updateRun(runId: string, patch: Partial<AssemblyRunRecord>): AssemblyRunRecord {
    const current = this.getRun(runId);
    const next: AssemblyRunRecord = {
      ...current,
      ...patch,
      runId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.updateRunStmt.run(serializeRunUpdate(next));
    return this.getRun(runId);
  }

  public listRuns(limit = 50): AssemblyRunRecord[] {
    const rows = toAssemblyRunRows(this.listRunsStmt.all({
      limit: clampLimit(limit, 1, 250),
    }));
    return rows.map(mapRunRow);
  }

  public saveRound(round: AssemblyRound): AssemblyRound {
    this.createRoundStmt.run(serializeRound(round));
    return this.listRounds(round.runId).find((candidate) => candidate.roundId === round.roundId) ?? round;
  }

  public updateRoundArtifacts(roundId: string, artifactIds: string[]): void {
    this.updateRoundArtifactsStmt.run({
      roundId,
      artifactIdsJson: JSON.stringify(artifactIds),
    });
  }

  public completeRound(roundId: string, input: {
    status: AssemblyRound["status"];
    convergenceSnapshot?: AssemblyRound["convergenceSnapshot"];
    stopCheck?: AssemblyRound["stopCheck"];
    finishedAt?: string;
  }): void {
    this.updateRoundResultStmt.run({
      roundId,
      status: input.status,
      convergenceSnapshotJson: input.convergenceSnapshot ? JSON.stringify(input.convergenceSnapshot) : null,
      stopCheckJson: input.stopCheck ? JSON.stringify(input.stopCheck) : null,
      finishedAt: input.finishedAt ?? new Date().toISOString(),
    });
  }

  public listRounds(runId: string): AssemblyRound[] {
    const rows = toAssemblyRoundRows(this.listRoundsStmt.all({ runId }));
    return rows.map(mapRoundRow);
  }

  public saveArtifacts(records: AssemblyArtifactRecord[]): AssemblyArtifactRecord[] {
    for (const record of records) {
      this.createArtifactStmt.run({
        artifactId: record.artifactId,
        runId: record.runId,
        roundIndex: record.roundIndex,
        stage: record.stage,
        artifactType: record.artifactType,
        participantModelRef: record.participantModelRef ?? null,
        blindedAuthorToken: record.blindedAuthorToken ?? null,
        payloadJson: JSON.stringify(record.payload),
        createdAt: record.createdAt,
      });
    }
    if (records.length === 0) {
      return [];
    }
    const first = records[0];
    if (!first) {
      return [];
    }
    return this.listArtifacts(first.runId);
  }

  public listArtifacts(runId: string, artifactType?: AssemblyArtifactType): AssemblyArtifactRecord[] {
    const rows = toAssemblyArtifactRows(this.listArtifactsStmt.all({
      runId,
      artifactType: artifactType ?? null,
    }));
    return rows.map(mapArtifactRow);
  }

  public upsertReputation(record: ModelReputation): ModelReputation {
    this.upsertReputationStmt.run({
      modelRef: record.modelRef,
      providerId: record.providerId,
      modelId: record.modelId,
      overall: record.overall,
      byDomainJson: JSON.stringify(record.byDomain),
      accuracy: record.accuracy,
      reasoningStrength: record.reasoningStrength,
      critiqueQuality: record.critiqueQuality,
      consensusLeadership: record.consensusLeadership,
      stability: record.stability,
      adversarialUsefulness: record.adversarialUsefulness,
      sampleCount: record.sampleCount,
      updatedAt: record.updatedAt,
    });
    return this.listReputations(250).find((candidate) => candidate.modelRef === record.modelRef) ?? record;
  }

  public listReputations(limit = 100): ModelReputation[] {
    const rows = toAssemblyReputationRows(this.listReputationsStmt.all({
      limit: clampLimit(limit, 1, 500),
    }));
    return rows.map(mapReputationRow);
  }
}

function serializeRun(run: AssemblyRunRecord) {
  return {
    runId: run.runId,
    workspaceId: run.workspaceId ?? null,
    sourceSessionId: run.sourceSessionId ?? null,
    sourceTaskId: run.sourceTaskId ?? null,
    title: run.title,
    status: run.status,
    currentStage: run.currentStage,
    currentRoundIndex: run.currentRoundIndex,
    problemJson: JSON.stringify(run.problem),
    settingsJson: JSON.stringify(run.settings),
    adversarialSettingsJson: JSON.stringify(run.adversarialSettings),
    resultJson: run.result ? JSON.stringify(run.result) : null,
    stopReason: run.stopReason ?? null,
    usageJson: run.usage ? JSON.stringify(run.usage) : null,
    errorText: run.error ?? null,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    updatedAt: run.updatedAt,
  };
}

function serializeRunUpdate(run: AssemblyRunRecord) {
  return {
    runId: run.runId,
    title: run.title,
    status: run.status,
    currentStage: run.currentStage,
    currentRoundIndex: run.currentRoundIndex,
    resultJson: run.result ? JSON.stringify(run.result) : null,
    stopReason: run.stopReason ?? null,
    usageJson: run.usage ? JSON.stringify(run.usage) : null,
    errorText: run.error ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    updatedAt: run.updatedAt,
  };
}

function serializeRound(round: AssemblyRound) {
  return {
    roundId: round.roundId,
    runId: round.runId,
    roundIndex: round.roundIndex,
    stage: round.stage,
    status: round.status,
    participantIdsJson: JSON.stringify(round.participantIds),
    artifactIdsJson: JSON.stringify(round.artifactIds),
    convergenceSnapshotJson: round.convergenceSnapshot ? JSON.stringify(round.convergenceSnapshot) : null,
    stopCheckJson: round.stopCheck ? JSON.stringify(round.stopCheck) : null,
    startedAt: round.startedAt,
    finishedAt: round.finishedAt ?? null,
  };
}

function mapRunRow(row: AssemblyRunRow): AssemblyRunRecord {
  return {
    runId: row.run_id,
    workspaceId: row.workspace_id ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceTaskId: row.source_task_id ?? undefined,
    title: row.title,
    status: row.status,
    currentStage: row.current_stage,
    currentRoundIndex: row.current_round_index,
    problem: parseAssemblyObject(row.problem_json, createFallbackAssemblyProblem(row)),
    settings: parseAssemblyObject(row.settings_json, createFallbackAssemblySettings()),
    adversarialSettings: parseAssemblyObject(row.adversarial_settings_json, createFallbackAdversarialSettings()),
    result: row.result_json
      ? parseAssemblyOptionalObject(row.result_json)
      : undefined,
    stopReason: row.stop_reason ?? undefined,
    usage: row.usage_json
      ? safeJsonParse<AssemblyUsageSummary | undefined>(row.usage_json, undefined)
      : undefined,
    error: row.error_text ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function mapRoundRow(row: AssemblyRoundRow): AssemblyRound {
  return {
    roundId: row.round_id,
    runId: row.run_id,
    roundIndex: row.round_index,
    stage: row.stage,
    status: row.status,
    participantIds: safeJsonParse<string[]>(row.participant_ids_json, []),
    artifactIds: safeJsonParse<string[]>(row.artifact_ids_json, []),
    convergenceSnapshot: row.convergence_snapshot_json
      ? parseAssemblyOptionalObject<AssemblyRound["convergenceSnapshot"]>(row.convergence_snapshot_json)
      : undefined,
    stopCheck: row.stop_check_json
      ? parseAssemblyOptionalObject<AssemblyRound["stopCheck"]>(row.stop_check_json)
      : undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function mapArtifactRow(row: AssemblyArtifactRow): AssemblyArtifactRecord {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    roundIndex: row.round_index,
    stage: row.stage,
    artifactType: row.artifact_type,
    participantModelRef: row.participant_model_ref ?? undefined,
    blindedAuthorToken: row.blinded_author_token ?? undefined,
    payload: parseAssemblyArtifactPayload(row),
    createdAt: row.created_at,
  };
}

function mapReputationRow(row: AssemblyReputationRow): ModelReputation {
  return {
    modelRef: row.model_ref,
    providerId: row.provider_id,
    modelId: row.model_id,
    overall: row.overall,
    byDomain: safeJsonParse(row.by_domain_json, {}),
    accuracy: row.accuracy,
    reasoningStrength: row.reasoning_strength,
    critiqueQuality: row.critique_quality,
    consensusLeadership: row.consensus_leadership,
    stability: row.stability,
    adversarialUsefulness: row.adversarial_usefulness,
    sampleCount: row.sample_count,
    updatedAt: row.updated_at,
  };
}

function clampLimit(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function createFallbackAssemblyProblem(row: AssemblyRunRow): AssemblyRunRecord["problem"] {
  return {
    runId: row.run_id,
    domain: "analysis",
    title: row.title,
    originalPrompt: "",
    normalizedStatement: "",
    objectives: [],
    constraints: [],
    evaluationCriteria: [],
    contextRefs: [],
    createdAt: row.created_at,
  };
}

function createFallbackAssemblySettings(): AssemblyRunRecord["settings"] {
  return {
    mode: "consensus",
    participantModels: [],
    maxRounds: 0,
    maxCritiquePasses: 0,
    maxInterModelExchanges: 0,
    convergenceThreshold: 0,
    stagnationWindow: 0,
    timeBudgetMs: 0,
    tokenBudget: 0,
    costBudgetUsd: 0,
    domainPreset: "analysis",
    synthesisStyle: "balanced",
    exportTargets: [],
  };
}

function createFallbackAdversarialSettings(): AssemblyRunRecord["adversarialSettings"] {
  return {
    enabled: false,
    reviewerCount: 0,
    selectionStrategy: "auto_selected_by_reputation",
    strictness: "balanced",
    requireMitigations: false,
    requireEvidenceTags: false,
    defenseRoundEnabled: false,
    repetitiveObjectionCutoff: false,
    minorityReportRequired: false,
  };
}

function parseAssemblyArtifactPayload(row: AssemblyArtifactRow): AssemblyArtifactRecord["payload"] {
  switch (row.artifact_type) {
    case "problem":
      return parseAssemblyObject(row.payload_json, {
        runId: row.run_id,
        domain: "analysis",
        title: "",
        originalPrompt: "",
        normalizedStatement: "",
        objectives: [],
        constraints: [],
        evaluationCriteria: [],
        contextRefs: [],
        createdAt: row.created_at,
      } as AssemblyArtifactRecord["payload"]);
    case "convergence_score":
      return parseAssemblyObject<ConvergenceScore>(row.payload_json, {
        runId: row.run_id,
        roundIndex: row.round_index,
        dimensionScores: {
          rootCause: 0,
          solutionDesign: 0,
          riskAnalysis: 0,
          implementationScope: 0,
          evidenceStrength: 0,
          confidenceStability: 0,
          testPlanAlignment: 0,
        },
        proposalSupportScores: {},
        compositeScore: 0,
        stagnationDelta: 0,
        disagreementClusters: [],
        minorityFlags: [],
        createdAt: row.created_at,
      });
    case "result":
      return parseAssemblyObject<AssemblyResult>(row.payload_json, {
        runId: row.run_id,
        recommendation: "",
        disagreements: [],
        riskAnalysis: [],
        implementationPlan: [],
        modelContributionSummary: [],
        exports: [],
        createdAt: row.created_at,
      });
    case "proposal":
      return parseAssemblyObject(row.payload_json, {
        runId: row.run_id,
        roundIndex: row.round_index,
        proposalId: row.artifact_id,
        authorModelRef: row.participant_model_ref ?? "",
        blindedAuthorToken: row.blinded_author_token ?? "",
        abstract: "",
        diagnosis: "",
        proposedSolution: "",
        reasoning: "",
        risks: [],
        assumptions: [],
        confidence: 0,
        evidence: [],
        testPlan: [],
        schemaVersion: 1,
        createdAt: row.created_at,
        updatedAt: row.created_at,
      } as AssemblyArtifactRecord["payload"]);
    case "peer_review":
      return parseAssemblyObject<PeerReview>(row.payload_json, {
        runId: row.run_id,
        roundIndex: row.round_index,
        reviewId: row.artifact_id,
        proposalId: "",
        blindedReviewerToken: row.blinded_author_token ?? "",
        strengths: [],
        weaknesses: [],
        missingAssumptions: [],
        failureScenarios: [],
        scores: {
          correctness: 0,
          reasoningStrength: 0,
          practicality: 0,
          evidenceQuality: 0,
          riskAwareness: 0,
          testability: 0,
          clarity: 0,
        },
        verdict: "revise",
        confidence: 0,
        createdAt: row.created_at,
      });
    case "adversarial_review":
      return parseAssemblyObject<AdversarialReview>(row.payload_json, {
        runId: row.run_id,
        roundIndex: row.round_index,
        reviewId: row.artifact_id,
        proposalId: "",
        blindedReviewerToken: row.blinded_author_token ?? "",
        strengthsFirst: [],
        objections: [],
        overallAssessment: "",
        usefulnessPending: true,
        createdAt: row.created_at,
      });
    case "defense_response":
    default:
      return parseAssemblyObject<DefenseResponse>(row.payload_json, {
        runId: row.run_id,
        roundIndex: row.round_index,
        responseId: row.artifact_id,
        proposalId: "",
        challengedReviewIds: [],
        acceptedPoints: [],
        rejectedPoints: [],
        revisionsMade: [],
        unresolvedDisputes: [],
        updatedConfidence: 0,
        createdAt: row.created_at,
      });
  }
}

function parseAssemblyObject<T>(value: string, fallback: T): T {
  const parsed = safeJsonParse<unknown>(value, {});
  return isRecord(parsed) ? parsed as T : fallback;
}

function parseAssemblyOptionalObject<T>(value: string): T | undefined {
  const parsed = safeJsonParse<unknown>(value, undefined);
  return isRecord(parsed) ? parsed as T : undefined;
}

function toAssemblyRunRow(value: unknown): AssemblyRunRow | undefined {
  return isAssemblyRunRow(value) ? value : undefined;
}

function toAssemblyRunRows(value: unknown): AssemblyRunRow[] {
  return Array.isArray(value) ? value.filter(isAssemblyRunRow) : [];
}

function toAssemblyRoundRows(value: unknown): AssemblyRoundRow[] {
  return Array.isArray(value) ? value.filter(isAssemblyRoundRow) : [];
}

function toAssemblyArtifactRows(value: unknown): AssemblyArtifactRow[] {
  return Array.isArray(value) ? value.filter(isAssemblyArtifactRow) : [];
}

function toAssemblyReputationRows(value: unknown): AssemblyReputationRow[] {
  return Array.isArray(value) ? value.filter(isAssemblyReputationRow) : [];
}

function isAssemblyRunRow(value: unknown): value is AssemblyRunRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.run_id === "string"
    && (typeof value.workspace_id === "string" || value.workspace_id === null)
    && (typeof value.source_session_id === "string" || value.source_session_id === null)
    && (typeof value.source_task_id === "string" || value.source_task_id === null)
    && typeof value.title === "string"
    && typeof value.status === "string"
    && typeof value.current_stage === "string"
    && typeof value.current_round_index === "number"
    && typeof value.problem_json === "string"
    && typeof value.settings_json === "string"
    && typeof value.adversarial_settings_json === "string"
    && (typeof value.result_json === "string" || value.result_json === null)
    && (typeof value.stop_reason === "string" || value.stop_reason === null)
    && (typeof value.usage_json === "string" || value.usage_json === null)
    && (typeof value.error_text === "string" || value.error_text === null)
    && typeof value.created_at === "string"
    && (typeof value.started_at === "string" || value.started_at === null)
    && (typeof value.finished_at === "string" || value.finished_at === null)
    && typeof value.updated_at === "string";
}

function isAssemblyRoundRow(value: unknown): value is AssemblyRoundRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.round_id === "string"
    && typeof value.run_id === "string"
    && typeof value.round_index === "number"
    && typeof value.stage === "string"
    && typeof value.status === "string"
    && typeof value.participant_ids_json === "string"
    && typeof value.artifact_ids_json === "string"
    && (typeof value.convergence_snapshot_json === "string" || value.convergence_snapshot_json === null)
    && (typeof value.stop_check_json === "string" || value.stop_check_json === null)
    && typeof value.started_at === "string"
    && (typeof value.finished_at === "string" || value.finished_at === null);
}

function isAssemblyArtifactRow(value: unknown): value is AssemblyArtifactRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.artifact_id === "string"
    && typeof value.run_id === "string"
    && typeof value.round_index === "number"
    && typeof value.stage === "string"
    && typeof value.artifact_type === "string"
    && (typeof value.participant_model_ref === "string" || value.participant_model_ref === null)
    && (typeof value.blinded_author_token === "string" || value.blinded_author_token === null)
    && typeof value.payload_json === "string"
    && typeof value.created_at === "string";
}

function isAssemblyReputationRow(value: unknown): value is AssemblyReputationRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.model_ref === "string"
    && typeof value.provider_id === "string"
    && typeof value.model_id === "string"
    && typeof value.overall === "number"
    && typeof value.by_domain_json === "string"
    && typeof value.accuracy === "number"
    && typeof value.reasoning_strength === "number"
    && typeof value.critique_quality === "number"
    && typeof value.consensus_leadership === "number"
    && typeof value.stability === "number"
    && typeof value.adversarial_usefulness === "number"
    && typeof value.sample_count === "number"
    && typeof value.updated_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
