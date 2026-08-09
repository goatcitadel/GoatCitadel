import type { CapabilityCatalogScope } from "@goatcitadel/contracts";
import type { CapabilitySystemService } from "./capability-system-service.js";
import type { EffectiveCapabilitySet } from "./capability-scope-resolver.js";

export type CapabilitiesRoutePort = Pick<
  CapabilitySystemService,
  | "createCodeModeRun"
  | "createProposal"
  | "getCandidateDetail"
  | "getCapabilityAuditExport"
  | "getCatalogDriftMetrics"
  | "getCatalogSnapshot"
  | "getCompactToolDirectorySnapshot"
  | "getCodeModeRun"
  | "getCodeModeRunArtifactPreview"
  | "getCodeModeRunInScope"
  | "getProposalDetail"
  | "getToolSchema"
  | "listCatalog"
  | "listCodeModeExecutionBackends"
  | "listCodeModeRuns"
  | "listCodeModeRunVerificationEvidence"
  | "verifyCodeModeRun"
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

  public listCapabilityCatalog(scope: CapabilityCatalogScope, effectiveSkills?: EffectiveCapabilitySet) {
    // Forward faithfully: omit the arg when unscoped so listCatalog's own default ("ALL") applies.
    return effectiveSkills === undefined
      ? this.capabilities.listCatalog(scope)
      : this.capabilities.listCatalog(scope, effectiveSkills);
  }

  public getCapabilityCatalogSnapshot(snapshotId: string) {
    return this.capabilities.getCatalogSnapshot(snapshotId);
  }

  public getCapabilityCatalogDriftMetrics(effectiveSkills?: EffectiveCapabilitySet) {
    return effectiveSkills === undefined
      ? this.capabilities.getCatalogDriftMetrics()
      : this.capabilities.getCatalogDriftMetrics(effectiveSkills);
  }

  public getCapabilityAuditExport(
    snapshotId: string,
    input?: Parameters<CapabilitiesRoutePort["getCapabilityAuditExport"]>[1],
  ) {
    return this.capabilities.getCapabilityAuditExport(snapshotId, input);
  }

  public getCompactToolDirectorySnapshot(ttlMs?: number) {
    return this.capabilities.getCompactToolDirectorySnapshot(ttlMs);
  }

  public getToolSchema(toolName: string) {
    return this.capabilities.getToolSchema(toolName);
  }

  public listCapabilityProposals(limit = 100) {
    return this.capabilities.listProposals(limit);
  }

  public createCapabilityProposal(input: Parameters<CapabilitiesRoutePort["createProposal"]>[0], actorId?: string) {
    return this.capabilities.createProposal(input, actorId);
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

  /**
   * HX-402 P2: direct candidate lifecycle verbs are approval-first. Each verb
   * commits one canonical `capability.lifecycle` approval and never mutates;
   * the recovered approval effect is the sole executor.
   */
  public promoteCapabilityCandidate(
    candidateId: string,
    expectedRevision: number,
    versionId?: string,
    requesterId?: string,
  ) {
    return this.capabilities.promoteCandidate(candidateId, expectedRevision, versionId, requesterId);
  }

  public revokeCapabilityCandidate(
    candidateId: string,
    expectedRevision: number,
    versionId?: string,
    requesterId?: string,
  ) {
    return this.capabilities.revokeCandidate(candidateId, expectedRevision, versionId, requesterId);
  }

  public rollbackCapabilityCandidate(
    candidateId: string,
    targetVersionId: string,
    expectedRevision: number,
    requesterId?: string,
  ) {
    return this.capabilities.rollbackCandidate(candidateId, targetVersionId, expectedRevision, requesterId);
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

  public verifyCodeModeRun(
    runId: string,
    input: Parameters<CapabilitiesRoutePort["verifyCodeModeRun"]>[1],
    scope: Parameters<CapabilitiesRoutePort["verifyCodeModeRun"]>[2],
    operatorId?: string,
  ) {
    return this.capabilities.verifyCodeModeRun(runId, input, scope, operatorId);
  }

  public listCodeModeRunVerificationEvidence(
    runId: string,
    scope: Parameters<CapabilitiesRoutePort["listCodeModeRunVerificationEvidence"]>[1],
    limit?: number,
  ) {
    return this.capabilities.listCodeModeRunVerificationEvidence(runId, scope, limit);
  }
}
