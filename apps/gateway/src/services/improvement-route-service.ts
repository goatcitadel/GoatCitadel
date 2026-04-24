import type {
  CapabilityCatalogEntry,
  CapabilityProposalRecord,
  HarnessAuditReportRecord,
  SkillActivationPolicy,
  SkillImportHistoryRecord,
  SkillListItem,
} from "@goatcitadel/contracts";
import { buildHarnessAuditReport } from "./harness-audit.js";
import type { ImprovementService } from "./improvement-service.js";

type ImprovementOperationsPort = Pick<
  ImprovementService,
  | "approveDecisionAutoTune"
  | "createReplayOverrideDraft"
  | "executeReplayOverride"
  | "getDecisionReplayRun"
  | "getImprovementActivation"
  | "getImprovementCandidateDetail"
  | "getImprovementReport"
  | "getImprovementSignal"
  | "getReplayDiffSummary"
  | "listCapabilityGapEvents"
  | "listDecisionReplayRuns"
  | "listImprovementCandidates"
  | "listImprovementReports"
  | "listImprovementSignals"
  | "listRepairCandidates"
  | "pauseImprovementActivation"
  | "requestImprovementActivation"
  | "revertDecisionAutoTune"
  | "rollbackImprovementActivation"
  | "runImprovementReplayManually"
  | "updateRepairCandidateValidation"
>;

export interface ImprovementAuditPort {
  getSkillActivationPolicy(): SkillActivationPolicy;
  listCapabilityCatalog(scope: "inspectable"): CapabilityCatalogEntry[];
  listCapabilityProposals(limit: number): CapabilityProposalRecord[];
  listSkillImportHistory(limit: number): SkillImportHistoryRecord[];
  listSkills(): SkillListItem[];
}

export interface ImprovementRouteDependencies {
  audit: ImprovementAuditPort;
  improvement: ImprovementOperationsPort;
}

export class ImprovementRouteService {
  public constructor(private readonly deps: ImprovementRouteDependencies) {}

  public listCapabilityGapEvents(limit: number) {
    return this.deps.improvement.listCapabilityGapEvents(limit);
  }

  public listRepairCandidates(limit: number) {
    return this.deps.improvement.listRepairCandidates(limit);
  }

  public updateRepairCandidateValidation(
    candidateId: string,
    input: Parameters<ImprovementOperationsPort["updateRepairCandidateValidation"]>[1],
  ) {
    return this.deps.improvement.updateRepairCandidateValidation(candidateId, input);
  }

  public listImprovementSignals(limit: number, workspaceId?: string) {
    return this.deps.improvement.listImprovementSignals(limit, workspaceId);
  }

  public getImprovementSignal(signalId: string) {
    return this.deps.improvement.getImprovementSignal(signalId);
  }

  public listImprovementCandidates(limit: number, workspaceId?: string) {
    return this.deps.improvement.listImprovementCandidates(limit, workspaceId);
  }

  public getImprovementCandidate(candidateId: string) {
    return this.deps.improvement.getImprovementCandidateDetail(candidateId);
  }

  public requestImprovementActivation(candidateId: string) {
    return this.deps.improvement.requestImprovementActivation(candidateId);
  }

  public getImprovementActivation(activationId: string) {
    return this.deps.improvement.getImprovementActivation(activationId);
  }

  public pauseImprovementActivation(activationId: string) {
    return this.deps.improvement.pauseImprovementActivation(activationId);
  }

  public rollbackImprovementActivation(activationId: string) {
    return this.deps.improvement.rollbackImprovementActivation(activationId);
  }

  public listImprovementReports(limit: number) {
    return this.deps.improvement.listImprovementReports(limit);
  }

  public getHarnessAuditReport(): HarnessAuditReportRecord {
    return buildHarnessAuditReport({
      skills: this.deps.audit.listSkills(),
      policy: this.deps.audit.getSkillActivationPolicy(),
      inspectableCatalog: this.deps.audit.listCapabilityCatalog("inspectable"),
      proposals: this.deps.audit.listCapabilityProposals(100),
      importHistory: this.deps.audit.listSkillImportHistory(50),
      improvementReportCount: this.deps.improvement.listImprovementReports(24).length,
    });
  }

  public getImprovementReport(reportId: string) {
    return this.deps.improvement.getImprovementReport(reportId);
  }

  public runImprovementReplayManually(input: Parameters<ImprovementOperationsPort["runImprovementReplayManually"]>[0]) {
    return this.deps.improvement.runImprovementReplayManually(input);
  }

  public listDecisionReplayRuns(limit: number) {
    return this.deps.improvement.listDecisionReplayRuns(limit);
  }

  public getDecisionReplayRun(runId: string) {
    return this.deps.improvement.getDecisionReplayRun(runId);
  }

  public approveDecisionAutoTune(tuneId: string) {
    return this.deps.improvement.approveDecisionAutoTune(tuneId);
  }

  public revertDecisionAutoTune(tuneId: string) {
    return this.deps.improvement.revertDecisionAutoTune(tuneId);
  }

  public createReplayOverrideDraft(
    sourceRunId: string,
    overrides: Parameters<ImprovementOperationsPort["createReplayOverrideDraft"]>[1],
  ) {
    return this.deps.improvement.createReplayOverrideDraft(sourceRunId, overrides);
  }

  public executeReplayOverride(
    sourceRunId: string,
    overrides: Parameters<ImprovementOperationsPort["executeReplayOverride"]>[1],
  ) {
    return this.deps.improvement.executeReplayOverride(sourceRunId, overrides);
  }

  public getReplayDiffSummary(replayRunId: string) {
    return this.deps.improvement.getReplayDiffSummary(replayRunId);
  }
}
