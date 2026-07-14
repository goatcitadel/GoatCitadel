import type {
  SkillEvaluationListResponse,
  SkillEvaluationPreviewRequest,
  SkillEvaluationPreviewResponse,
  SkillEvaluationProposalResponse,
  SkillEvaluationRunRecord,
  SkillEvaluationRunRequest,
  SkillEvaluationRunResponse,
  SkillActivationDecision,
  SkillActivationPolicy,
  SkillImportHistoryRecord,
  SkillImportValidationResult,
  SkillExportPackageResponse,
  SkillExportPreviewResponse,
  SkillExportRequest,
  SkillExportTargetProfile,
  SkillListItem,
  SkillResolveInput,
  SkillRuntimeState,
  SkillSourceListResponse,
  SkillSourceLookupResponse,
  SkillSourceProvider,
  SkillStateRecord,
} from "@goatcitadel/contracts";
import type { EffectiveCapabilitySet } from "./capability-scope-resolver.js";
import type { CreateSkillHubOperatorApprovalInput, SkillHubOperatorService } from "./skill-hub-operator-service.js";
import type {
  SkillHubReviewService,
  SkillHubRollbackReviewInput,
  SkillHubSourceReviewInput,
} from "./skill-hub-review-service.js";

export interface SkillImportInstallResult {
  validation: SkillImportValidationResult;
  installedPath: string;
  sourceManifestPath: string;
  installedSkillId?: string;
}

export interface SkillsRoutePort {
  bulkSetSkillState(
    skillIds: string[],
    state: SkillRuntimeState,
    note: string | undefined,
    expectedRevisionsBySkillId: Record<string, number>,
  ): SkillStateRecord[];
  getSkillActivationPolicy(): SkillActivationPolicy;
  installSkillImport(input: {
    sourceRef: string;
    sourceType?: SkillImportValidationResult["candidate"]["sourceType"];
    sourceProvider?: SkillSourceProvider;
    force?: boolean;
    confirmHighRisk?: boolean;
  }): Promise<SkillImportInstallResult>;
  createSkillHubApproval(
    input: CreateSkillHubOperatorApprovalInput,
  ): ReturnType<SkillHubOperatorService["createApproval"]>;
  listSkillHub(input: { workspaceId: string; limit?: number }): ReturnType<SkillHubOperatorService["list"]>;
  prepareSkillHubRollbackReview(
    input: SkillHubRollbackReviewInput,
  ): ReturnType<SkillHubReviewService["prepareRollbackReview"]>;
  reviewSkillHubSource(input: SkillHubSourceReviewInput): ReturnType<SkillHubReviewService["reviewSource"]>;
  listSkillImportHistory(limit?: number): SkillImportHistoryRecord[];
  listSkillEvaluationRuns(skillId: string): SkillEvaluationListResponse;
  listSkillExportTargets(): SkillExportTargetProfile[];
  listSkillSources(query?: string, limit?: number): Promise<SkillSourceListResponse>;
  listSkills(effectiveSkills?: EffectiveCapabilitySet): SkillListItem[];
  lookupSkillSources(queryOrUrl: string, limit?: number): Promise<SkillSourceLookupResponse>;
  previewSkillEvaluation(skillId: string, input: SkillEvaluationPreviewRequest): SkillEvaluationPreviewResponse;
  previewSkillExport(input: SkillExportRequest): SkillExportPreviewResponse;
  packageSkillExport(input: SkillExportRequest): SkillExportPackageResponse;
  runSkillEvaluation(skillId: string, input: SkillEvaluationRunRequest): SkillEvaluationRunResponse;
  getSkillEvaluationRun(runId: string): SkillEvaluationRunRecord;
  createSkillEvaluationProposal(runId: string): SkillEvaluationProposalResponse;
  reloadSkills(): Promise<SkillListItem[]>;
  resolveSkillActivation(input: SkillResolveInput): SkillActivationDecision;
  setSkillState(
    skillId: string,
    state: SkillRuntimeState,
    note: string | undefined,
    expectedRevision: number,
  ): SkillStateRecord;
  updateSkillActivationPolicy(
    input: Partial<Omit<SkillActivationPolicy, "revision">>,
    expectedRevision: number,
  ): SkillActivationPolicy;
  validateSkillImport(input: {
    sourceRef: string;
    sourceType?: SkillImportValidationResult["candidate"]["sourceType"];
    sourceProvider?: SkillSourceProvider;
  }): Promise<SkillImportValidationResult>;
}

export class SkillsRouteService {
  public constructor(private readonly skills: SkillsRoutePort) {}

  public listSkills(effectiveSkills?: EffectiveCapabilitySet) {
    // Forward faithfully: omit the arg entirely when unscoped so the port's own
    // default ("ALL") applies and the pass-through stays argument-identical.
    return effectiveSkills === undefined ? this.skills.listSkills() : this.skills.listSkills(effectiveSkills);
  }

  public listSkillHub(input: { workspaceId: string; limit?: number }) {
    return this.skills.listSkillHub(input);
  }

  public createSkillHubApproval(input: CreateSkillHubOperatorApprovalInput) {
    return this.skills.createSkillHubApproval(input);
  }

  public reviewSkillHubSource(input: SkillHubSourceReviewInput) {
    return this.skills.reviewSkillHubSource(input);
  }

  public prepareSkillHubRollbackReview(input: SkillHubRollbackReviewInput) {
    return this.skills.prepareSkillHubRollbackReview(input);
  }

  public reloadSkills() {
    return this.skills.reloadSkills();
  }

  public listSkillSources(query?: string, limit?: number) {
    return this.skills.listSkillSources(query, limit);
  }

  public listSkillExportTargets() {
    return this.skills.listSkillExportTargets();
  }

  public previewSkillExport(input: SkillExportRequest) {
    return this.skills.previewSkillExport(input);
  }

  public packageSkillExport(input: SkillExportRequest) {
    return this.skills.packageSkillExport(input);
  }

  public lookupSkillSources(queryOrUrl: string, limit?: number) {
    return this.skills.lookupSkillSources(queryOrUrl, limit);
  }

  public validateSkillImport(input: Parameters<SkillsRoutePort["validateSkillImport"]>[0]) {
    return this.skills.validateSkillImport(input);
  }

  public installSkillImport(input: Parameters<SkillsRoutePort["installSkillImport"]>[0]) {
    return this.skills.installSkillImport(input);
  }

  public listSkillImportHistory(limit?: number) {
    return this.skills.listSkillImportHistory(limit);
  }

  public previewSkillEvaluation(skillId: string, input: SkillEvaluationPreviewRequest) {
    return this.skills.previewSkillEvaluation(skillId, input);
  }

  public runSkillEvaluation(skillId: string, input: SkillEvaluationRunRequest) {
    return this.skills.runSkillEvaluation(skillId, input);
  }

  public listSkillEvaluationRuns(skillId: string) {
    return this.skills.listSkillEvaluationRuns(skillId);
  }

  public getSkillEvaluationRun(runId: string) {
    return this.skills.getSkillEvaluationRun(runId);
  }

  public createSkillEvaluationProposal(runId: string) {
    return this.skills.createSkillEvaluationProposal(runId);
  }

  public resolveSkillActivation(input: SkillResolveInput) {
    return this.skills.resolveSkillActivation(input);
  }

  public setSkillState(skillId: string, state: SkillRuntimeState, note: string | undefined, expectedRevision: number) {
    return this.skills.setSkillState(skillId, state, note, expectedRevision);
  }

  public bulkSetSkillState(
    skillIds: string[],
    state: SkillRuntimeState,
    note: string | undefined,
    expectedRevisionsBySkillId: Record<string, number>,
  ) {
    return this.skills.bulkSetSkillState(skillIds, state, note, expectedRevisionsBySkillId);
  }

  public getSkillActivationPolicy() {
    return this.skills.getSkillActivationPolicy();
  }

  public updateSkillActivationPolicy(
    input: Partial<Omit<SkillActivationPolicy, "revision">>,
    expectedRevision: number,
  ) {
    return this.skills.updateSkillActivationPolicy(input, expectedRevision);
  }
}
