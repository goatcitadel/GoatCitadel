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

export interface SkillImportInstallResult {
  validation: SkillImportValidationResult;
  installedPath: string;
  sourceManifestPath: string;
  installedSkillId?: string;
}

export interface SkillsRoutePort {
  bulkSetSkillState(skillIds: string[], state: SkillRuntimeState, note?: string): SkillStateRecord[];
  getSkillActivationPolicy(): SkillActivationPolicy;
  installSkillImport(input: {
    sourceRef: string;
    sourceType?: SkillImportValidationResult["candidate"]["sourceType"];
    sourceProvider?: SkillSourceProvider;
    force?: boolean;
    confirmHighRisk?: boolean;
  }): Promise<SkillImportInstallResult>;
  listSkillImportHistory(limit?: number): SkillImportHistoryRecord[];
  listSkillEvaluationRuns(skillId: string): SkillEvaluationListResponse;
  listSkillExportTargets(): SkillExportTargetProfile[];
  listSkillSources(query?: string, limit?: number): Promise<SkillSourceListResponse>;
  listSkills(): SkillListItem[];
  lookupSkillSources(queryOrUrl: string, limit?: number): Promise<SkillSourceLookupResponse>;
  previewSkillEvaluation(skillId: string, input: SkillEvaluationPreviewRequest): SkillEvaluationPreviewResponse;
  previewSkillExport(input: SkillExportRequest): SkillExportPreviewResponse;
  packageSkillExport(input: SkillExportRequest): SkillExportPackageResponse;
  runSkillEvaluation(skillId: string, input: SkillEvaluationRunRequest): SkillEvaluationRunResponse;
  getSkillEvaluationRun(runId: string): SkillEvaluationRunRecord;
  createSkillEvaluationProposal(runId: string): SkillEvaluationProposalResponse;
  reloadSkills(): Promise<SkillListItem[]>;
  resolveSkillActivation(input: SkillResolveInput): SkillActivationDecision;
  setSkillState(skillId: string, state: SkillRuntimeState, note?: string): SkillStateRecord;
  updateSkillActivationPolicy(input: Partial<SkillActivationPolicy>): SkillActivationPolicy;
  validateSkillImport(input: {
    sourceRef: string;
    sourceType?: SkillImportValidationResult["candidate"]["sourceType"];
    sourceProvider?: SkillSourceProvider;
  }): Promise<SkillImportValidationResult>;
}

export class SkillsRouteService {
  public constructor(private readonly skills: SkillsRoutePort) {}

  public listSkills() {
    return this.skills.listSkills();
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

  public setSkillState(skillId: string, state: SkillRuntimeState, note?: string) {
    return this.skills.setSkillState(skillId, state, note);
  }

  public bulkSetSkillState(skillIds: string[], state: SkillRuntimeState, note?: string) {
    return this.skills.bulkSetSkillState(skillIds, state, note);
  }

  public getSkillActivationPolicy() {
    return this.skills.getSkillActivationPolicy();
  }

  public updateSkillActivationPolicy(input: Partial<SkillActivationPolicy>) {
    return this.skills.updateSkillActivationPolicy(input);
  }
}
