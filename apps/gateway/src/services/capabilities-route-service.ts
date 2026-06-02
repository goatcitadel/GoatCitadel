import type { CapabilityCatalogScope } from "@goatcitadel/contracts";
import type { CapabilitySystemService } from "./capability-system-service.js";

export type CapabilitiesRoutePort = Pick<
  CapabilitySystemService,
  | "createCodeModeRun"
  | "createProposal"
  | "getCandidateDetail"
  | "getCatalogSnapshot"
  | "getCodeModeRun"
  | "getCodeModeRunArtifactPreview"
  | "getCodeModeRunInScope"
  | "getProposalDetail"
  | "listCatalog"
  | "listCodeModeExecutionBackends"
  | "listCodeModeRuns"
  | "compareCodeModeRuns"
  | "createAutonomousActivationGrant"
  | "listProposals"
  | "evaluateAutonomousActivationGrant"
  | "listAutonomousActivationGrants"
  | "promoteCandidate"
  | "revokeCandidate"
  | "revokeAutonomousActivationGrant"
  | "rollbackCandidate"
>;

export class CapabilitiesRouteService {
  public constructor(private readonly capabilities: CapabilitiesRoutePort) {}

  public listCapabilityCatalog(scope: CapabilityCatalogScope) {
    return this.capabilities.listCatalog(scope);
  }

  public getCapabilityCatalogSnapshot(snapshotId: string) {
    return this.capabilities.getCatalogSnapshot(snapshotId);
  }

  public listCapabilityProposals(limit = 100) {
    return this.capabilities.listProposals(limit);
  }

  public createCapabilityProposal(input: Parameters<CapabilitiesRoutePort["createProposal"]>[0]) {
    return this.capabilities.createProposal(input);
  }

  public listAutonomousActivationGrants(includeExpired = false) {
    return this.capabilities.listAutonomousActivationGrants(includeExpired);
  }

  public createAutonomousActivationGrant(
    input: Parameters<CapabilitiesRoutePort["createAutonomousActivationGrant"]>[0],
  ) {
    return this.capabilities.createAutonomousActivationGrant(input);
  }

  public revokeAutonomousActivationGrant(
    grantId: string,
    input: Parameters<CapabilitiesRoutePort["revokeAutonomousActivationGrant"]>[1],
  ) {
    return this.capabilities.revokeAutonomousActivationGrant(grantId, input);
  }

  public evaluateAutonomousActivationGrant(
    input: Parameters<CapabilitiesRoutePort["evaluateAutonomousActivationGrant"]>[0],
  ) {
    return this.capabilities.evaluateAutonomousActivationGrant(input);
  }

  public getCapabilityProposalDetail(proposalId: string) {
    return this.capabilities.getProposalDetail(proposalId);
  }

  public getCapabilityCandidateDetail(candidateId: string) {
    return this.capabilities.getCandidateDetail(candidateId);
  }

  public promoteCapabilityCandidate(candidateId: string, versionId?: string) {
    return this.capabilities.promoteCandidate(candidateId, versionId);
  }

  public revokeCapabilityCandidate(candidateId: string, versionId?: string) {
    return this.capabilities.revokeCandidate(candidateId, versionId);
  }

  public rollbackCapabilityCandidate(candidateId: string, targetVersionId: string) {
    return this.capabilities.rollbackCandidate(candidateId, targetVersionId);
  }

  public listCodeModeRuns(input: Parameters<CapabilitiesRoutePort["listCodeModeRuns"]>[0] = 100) {
    return this.capabilities.listCodeModeRuns(input);
  }

  public listCodeModeExecutionBackends() {
    return this.capabilities.listCodeModeExecutionBackends();
  }

  public getCodeModeRun(runId: string) {
    return this.capabilities.getCodeModeRun(runId);
  }

  public getCodeModeRunInScope(runId: string, scope: Parameters<CapabilitiesRoutePort["getCodeModeRunInScope"]>[1]) {
    return this.capabilities.getCodeModeRunInScope(runId, scope);
  }

  public getCodeModeRunArtifactPreview(
    runId: string,
    artifactKind: Parameters<CapabilitiesRoutePort["getCodeModeRunArtifactPreview"]>[1],
    scope?: Parameters<CapabilitiesRoutePort["getCodeModeRunArtifactPreview"]>[2],
  ) {
    return this.capabilities.getCodeModeRunArtifactPreview(runId, artifactKind, scope);
  }

  public compareCodeModeRuns(
    runId: string,
    baselineRunId: string,
    scope?: Parameters<CapabilitiesRoutePort["compareCodeModeRuns"]>[2],
  ) {
    return this.capabilities.compareCodeModeRuns(runId, baselineRunId, scope);
  }

  public createCodeModeRun(input: Parameters<CapabilitiesRoutePort["createCodeModeRun"]>[0]) {
    return this.capabilities.createCodeModeRun(input);
  }
}
