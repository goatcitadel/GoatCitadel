import type {
  PromptRetuneCampaignRecord,
  PromptRetuneCampaignStatus,
  PromptRetuneMetrics,
  PromptRetuneNoiseFloor,
  PromptRetunePassRecord,
  PromptRetuneSuccessBar,
} from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface PromptRetuneCampaignRow {
  campaign_id: string;
  pack_id: string;
  status: PromptRetuneCampaignStatus;
  baseline_content_sha256: string;
  policy_hash: string;
  scoring_snapshot_json: string;
  test_codes_json: string;
  providers_json: string;
  execution_style: PromptRetuneCampaignRecord["executionStyle"];
  repeat_count: number;
  max_benchmark_runs: number;
  success_bar_json: string;
  noise_floor_json: string | null;
  baseline_metrics_json: string | null;
  active_pass_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface PromptRetunePassRow {
  pass_id: string;
  campaign_id: string;
  kind: PromptRetunePassRecord["kind"];
  hypothesis: string;
  content_sha256: string;
  benchmark_run_ids_json: string;
  disposition: PromptRetunePassRecord["disposition"];
  metrics_json: string | null;
  eligibility: PromptRetunePassRecord["eligibility"] | null;
  notes: string | null;
  created_at: string;
  finished_at: string | null;
}

export class PromptRetuneRepository {
  private readonly createCampaignStmt: DbStatement;
  private readonly getCampaignStmt: DbStatement;
  private readonly listCampaignsStmt: DbStatement;
  private readonly listPassesStmt: DbStatement;
  private readonly createPassStmt: DbStatement;
  private readonly activatePassStmt: DbStatement;
  private readonly setPassRunsStmt: DbStatement;
  private readonly failPassStmt: DbStatement;
  private readonly failCampaignStmt: DbStatement;
  private readonly completeNoisePassStmt: DbStatement;
  private readonly completeNoiseCampaignStmt: DbStatement;
  private readonly completeCandidatePassStmt: DbStatement;
  private readonly completeCandidateCampaignStmt: DbStatement;
  private readonly dispositionPassStmt: DbStatement;
  private readonly dispositionCampaignStmt: DbStatement;
  private readonly cancelCampaignStmt: DbStatement;

  public constructor(private readonly db: DatabaseClient) {
    this.createCampaignStmt = db.prepare(`
      INSERT INTO prompt_retune_campaigns (
        campaign_id, pack_id, status, baseline_content_sha256, policy_hash, scoring_snapshot_json,
        test_codes_json, providers_json, execution_style, repeat_count, max_benchmark_runs,
        success_bar_json, created_at, updated_at
      ) VALUES (
        @campaignId, @packId, @status, @baselineContentSha256, @policyHash, @scoringSnapshotJson,
        @testCodesJson, @providersJson, @executionStyle, @repeatCount, @maxBenchmarkRuns,
        @successBarJson, @createdAt, @updatedAt
      )
    `);
    this.getCampaignStmt = db.prepare("SELECT * FROM prompt_retune_campaigns WHERE campaign_id = ?");
    this.listCampaignsStmt = db.prepare(
      "SELECT * FROM prompt_retune_campaigns WHERE pack_id = @packId ORDER BY updated_at DESC LIMIT @limit",
    );
    this.listPassesStmt = db.prepare(
      "SELECT * FROM prompt_retune_passes WHERE campaign_id = ? ORDER BY created_at ASC",
    );
    this.createPassStmt = db.prepare(`
      INSERT INTO prompt_retune_passes (
        pass_id, campaign_id, kind, hypothesis, content_sha256, benchmark_run_ids_json,
        disposition, created_at
      ) VALUES (
        @passId, @campaignId, @kind, @hypothesis, @contentSha256, '[]', 'pending', @createdAt
      )
    `);
    this.activatePassStmt = db.prepare(`
      UPDATE prompt_retune_campaigns
      SET status = @status, active_pass_id = @passId, updated_at = @updatedAt, error = NULL
      WHERE campaign_id = @campaignId AND active_pass_id IS NULL
    `);
    this.setPassRunsStmt = db.prepare(
      "UPDATE prompt_retune_passes SET benchmark_run_ids_json = @benchmarkRunIdsJson WHERE pass_id = @passId",
    );
    this.failPassStmt = db.prepare(`
      UPDATE prompt_retune_passes
      SET benchmark_run_ids_json = @benchmarkRunIdsJson, disposition = 'inconclusive', notes = @notes,
          finished_at = @finishedAt
      WHERE pass_id = @passId
    `);
    this.failCampaignStmt = db.prepare(`
      UPDATE prompt_retune_campaigns
      SET status = 'failed', active_pass_id = NULL, error = @error, updated_at = @updatedAt,
          finished_at = @finishedAt
      WHERE campaign_id = @campaignId
    `);
    this.completeNoisePassStmt = db.prepare(`
      UPDATE prompt_retune_passes
      SET disposition = 'kept', metrics_json = @metricsJson, eligibility = 'eligible', finished_at = @finishedAt
      WHERE pass_id = @passId
    `);
    this.completeNoiseCampaignStmt = db.prepare(`
      UPDATE prompt_retune_campaigns
      SET status = 'ready', noise_floor_json = @noiseFloorJson, baseline_metrics_json = @metricsJson,
          active_pass_id = NULL, updated_at = @updatedAt
      WHERE campaign_id = @campaignId
    `);
    this.completeCandidatePassStmt = db.prepare(`
      UPDATE prompt_retune_passes
      SET metrics_json = @metricsJson, eligibility = @eligibility, finished_at = @finishedAt
      WHERE pass_id = @passId
    `);
    this.completeCandidateCampaignStmt = db.prepare(`
      UPDATE prompt_retune_campaigns
      SET status = 'ready', active_pass_id = NULL, updated_at = @updatedAt
      WHERE campaign_id = @campaignId
    `);
    this.dispositionPassStmt = db.prepare(`
      UPDATE prompt_retune_passes
      SET disposition = @disposition, notes = @notes
      WHERE pass_id = @passId AND campaign_id = @campaignId
    `);
    this.dispositionCampaignStmt = db.prepare(`
      UPDATE prompt_retune_campaigns
      SET status = @status, updated_at = @updatedAt, finished_at = @finishedAt
      WHERE campaign_id = @campaignId
    `);
    this.cancelCampaignStmt = db.prepare(`
      UPDATE prompt_retune_campaigns
      SET status = 'cancelled', active_pass_id = NULL, updated_at = @now, finished_at = @now
      WHERE campaign_id = @campaignId
    `);
  }

  public createCampaign(record: PromptRetuneCampaignRecord): PromptRetuneCampaignRecord {
    this.createCampaignStmt.run({
      campaignId: record.campaignId,
      packId: record.packId,
      status: record.status,
      baselineContentSha256: record.baselineContentSha256,
      policyHash: record.policyHash,
      scoringSnapshotJson: JSON.stringify(record.scoringSnapshot),
      testCodesJson: JSON.stringify(record.testCodes),
      providersJson: JSON.stringify(record.providers),
      executionStyle: record.executionStyle,
      repeatCount: record.repeatCount,
      maxBenchmarkRuns: record.maxBenchmarkRuns,
      successBarJson: JSON.stringify(record.successBar),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return record;
  }

  public getCampaign(campaignId: string): PromptRetuneCampaignRecord | undefined {
    const row = this.getCampaignStmt.get(campaignId) as PromptRetuneCampaignRow | undefined;
    return row ? mapCampaign(row, this.listPasses(campaignId)) : undefined;
  }

  public listCampaigns(packId: string, limit = 100): PromptRetuneCampaignRecord[] {
    const rows = this.listCampaignsStmt.all({ packId, limit: boundedLimit(limit, 500) }) as PromptRetuneCampaignRow[];
    return rows.map((row) => mapCampaign(row, this.listPasses(row.campaign_id)));
  }

  public createPassAndActivate(pass: PromptRetunePassRecord, status: PromptRetuneCampaignStatus): void {
    this.db.transaction("immediate", () => {
      this.createPassStmt.run({
        passId: pass.passId,
        campaignId: pass.campaignId,
        kind: pass.kind,
        hypothesis: pass.hypothesis,
        contentSha256: pass.contentSha256,
        createdAt: pass.createdAt,
      });
      const activated = this.activatePassStmt.run({
        campaignId: pass.campaignId,
        status,
        passId: pass.passId,
        updatedAt: pass.createdAt,
      });
      if (activated.changes !== 1) throw new Error("Retune campaign already has an active pass.");
    });
  }

  public setPassBenchmarkRunIds(passId: string, benchmarkRunIds: string[]): void {
    this.setPassRunsStmt.run({ passId, benchmarkRunIdsJson: JSON.stringify(benchmarkRunIds) });
  }

  public failPassAndCampaign(input: {
    campaignId: string;
    passId: string;
    benchmarkRunIds: string[];
    error: string;
    finishedAt: string;
  }): void {
    this.db.transaction("immediate", () => {
      this.failPassStmt.run({
        passId: input.passId,
        benchmarkRunIdsJson: JSON.stringify(input.benchmarkRunIds),
        notes: input.error,
        finishedAt: input.finishedAt,
      });
      this.failCampaignStmt.run({
        campaignId: input.campaignId,
        error: input.error,
        updatedAt: input.finishedAt,
        finishedAt: input.finishedAt,
      });
    });
  }

  public completeNoise(input: {
    campaignId: string;
    passId: string;
    metrics: PromptRetuneMetrics;
    noiseFloor: PromptRetuneNoiseFloor;
    finishedAt: string;
  }): void {
    this.db.transaction("immediate", () => {
      this.completeNoisePassStmt.run({
        passId: input.passId,
        metricsJson: JSON.stringify(input.metrics),
        finishedAt: input.finishedAt,
      });
      this.completeNoiseCampaignStmt.run({
        campaignId: input.campaignId,
        noiseFloorJson: JSON.stringify(input.noiseFloor),
        metricsJson: JSON.stringify(input.metrics),
        updatedAt: input.finishedAt,
      });
    });
  }

  public completeCandidate(input: {
    campaignId: string;
    passId: string;
    metrics: PromptRetuneMetrics;
    eligibility: NonNullable<PromptRetunePassRecord["eligibility"]>;
    finishedAt: string;
  }): void {
    this.db.transaction("immediate", () => {
      this.completeCandidatePassStmt.run({
        passId: input.passId,
        metricsJson: JSON.stringify(input.metrics),
        eligibility: input.eligibility,
        finishedAt: input.finishedAt,
      });
      this.completeCandidateCampaignStmt.run({ campaignId: input.campaignId, updatedAt: input.finishedAt });
    });
  }

  public dispositionCandidate(input: {
    campaignId: string;
    passId: string;
    disposition: "kept" | "rejected" | "inconclusive";
    notes?: string;
    updatedAt: string;
  }): void {
    this.db.transaction("immediate", () => {
      this.dispositionPassStmt.run({
        campaignId: input.campaignId,
        passId: input.passId,
        disposition: input.disposition,
        notes: input.notes?.trim() || null,
      });
      this.dispositionCampaignStmt.run({
        campaignId: input.campaignId,
        status: input.disposition === "kept" ? "completed" : "ready",
        updatedAt: input.updatedAt,
        finishedAt: input.disposition === "kept" ? input.updatedAt : null,
      });
    });
  }

  public cancelCampaign(campaignId: string, now: string): void {
    this.cancelCampaignStmt.run({ campaignId, now });
  }

  private listPasses(campaignId: string): PromptRetunePassRecord[] {
    return (this.listPassesStmt.all(campaignId) as PromptRetunePassRow[]).map(mapPass);
  }
}

function mapCampaign(row: PromptRetuneCampaignRow, passes: PromptRetunePassRecord[]): PromptRetuneCampaignRecord {
  return {
    campaignId: row.campaign_id,
    packId: row.pack_id,
    status: row.status,
    baselineContentSha256: row.baseline_content_sha256,
    policyHash: row.policy_hash,
    scoringSnapshot: safeJsonParse(row.scoring_snapshot_json, {}),
    testCodes: safeJsonParse(row.test_codes_json, []),
    providers: safeJsonParse(row.providers_json, []),
    executionStyle: row.execution_style,
    repeatCount: Number(row.repeat_count),
    maxBenchmarkRuns: Number(row.max_benchmark_runs),
    successBar: safeJsonParse<PromptRetuneSuccessBar>(row.success_bar_json, {
      minWeightedScoreDelta: 0,
      requirePassRateNonRegression: true,
      maxFailureRateDelta: 0,
    }),
    noiseFloor: row.noise_floor_json ? safeJsonParse(row.noise_floor_json, undefined) : undefined,
    baselineMetrics: row.baseline_metrics_json ? safeJsonParse(row.baseline_metrics_json, undefined) : undefined,
    activePassId: row.active_pass_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? undefined,
    passes,
  };
}

function mapPass(row: PromptRetunePassRow): PromptRetunePassRecord {
  return {
    passId: row.pass_id,
    campaignId: row.campaign_id,
    kind: row.kind,
    hypothesis: row.hypothesis,
    contentSha256: row.content_sha256,
    benchmarkRunIds: safeJsonParse(row.benchmark_run_ids_json, []),
    disposition: row.disposition,
    metrics: row.metrics_json ? safeJsonParse(row.metrics_json, undefined) : undefined,
    eligibility: row.eligibility ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function boundedLimit(value: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}
