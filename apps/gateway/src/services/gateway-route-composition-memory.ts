import { KnowledgeFacadeService } from "./memory-facade-service.js";
import { SkillEvaluationService } from "./skill-evaluation-service.js";
import { SkillHubOperatorService } from "./skill-hub-operator-service.js";
import { KeychainEvidenceReceiptSigningKeyProvider } from "./evidence-receipt-signing-key.js";
import type { EvidenceReceiptDataPort } from "./evidence-receipt-service.js";
import type { ComplianceExportDataPort } from "./compliance-export-service.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";

export function composeMemoryKnowledgeRouteDependencies(
  gateway: GatewayRouteCompositionPort,
): RouteDependencyDomain<
  | "capabilities"
  | "capabilityPacks"
  | "compliance"
  | "curator"
  | "evidence"
  | "evidenceReceipts"
  | "improvement"
  | "knowledge"
  | "memory"
  | "skills"
> {
  // Evidence Receipt data port: read-only lineage sources, all from storage repos.
  const evidenceReceiptData: EvidenceReceiptDataPort = {
    getDurableRun: (runId) => gateway.storage.durableRuns.getRun(runId),
    findCodeModeRun: (runId) => gateway.storage.codeModeRuns.find(runId),
    listApprovalEffects: (approvalId) => gateway.storage.approvalEffects.listByApproval(approvalId),
    listSideEffectsForWorkspace: (workspaceId) => gateway.storage.externalSideEffectRuns.listByWorkspace(workspaceId),
  };
  // Signing key lives in the OS keychain (same store the Vault master key uses). Generated lazily
  // on first receipt; the public key is derived and embedded in each receipt for offline verify.
  const evidenceReceiptSigningKeys = new KeychainEvidenceReceiptSigningKeyProvider({
    secretStore: gateway.secretStore,
  });
  // C3 Compliance Export reuses the B1 receipt data port + signing key, adding only a range-listing
  // source. durable_runs has no time/workspace index, so we list recent runs (newest first) and the
  // service filters in-memory by range/workspace; see ComplianceExportService for the bound.
  const complianceData: ComplianceExportDataPort = {
    ...evidenceReceiptData,
    listDurableRunsForExport: (scanLimit) => gateway.storage.durableRuns.listRuns(scanLimit),
  };
  const knowledgeFacade = new KnowledgeFacadeService({
    invokeAndUnwrap: (request, realtimeType) => gateway.invokeAndUnwrap(request, realtimeType),
  });
  const skillEvaluation = new SkillEvaluationService({
    storage: gateway.storage,
    listSkills: async () => gateway.listSkills(),
    createCapabilityProposal: (input) => gateway.capabilitySystemService.createProposal(input),
    recordSkillEvaluationSignal: (input) => gateway.improvementService.recordSkillEvaluationSignal(input),
  });
  const skillHubOperator = new SkillHubOperatorService({
    storage: gateway.storage,
    createApproval: (input) => gateway.createApproval(input),
    listInspectableCatalog: async () => await gateway.capabilitySystemService.listCatalog("inspectable"),
  });

  return {
    capabilities: gateway.capabilitySystemService,
    capabilityPacks: {
      installLocalPack: (input) => gateway.capabilityPackService.installLocalPack(input),
      installPack: (packId, input) => gateway.capabilityPackService.installPack(packId, input),
      materializeStagedPack: (evidenceEnvelopeId, input) =>
        gateway.capabilityPackService.materializeStagedPack(evidenceEnvelopeId, input),
      exportPack: (packId) => gateway.capabilityPackService.exportPack(packId),
      listPacks: () => gateway.capabilityPackService.listPacks(),
      listStagedPacks: () => gateway.capabilityPackService.listStagedPacks(),
      previewLocalPack: (manifest) => gateway.capabilityPackService.previewLocalPack(manifest),
      previewPack: (packId) => gateway.capabilityPackService.previewPack(packId),
    },
    curator: {
      listCuratorStatus: () => gateway.listCuratorStatus(),
      archiveCuratorSkill: (input) => gateway.archiveCuratorSkill(input),
      pruneCuratorSkill: (input) => gateway.pruneCuratorSkill(input),
      listCuratorArchived: () => gateway.listCuratorArchived(),
      runCurator: (input) => gateway.runCurator(input),
    },
    evidence: {
      listEnvelopes: (input) => gateway.evidenceEnvelopeService.listEnvelopes(input),
    },
    evidenceReceipts: {
      data: evidenceReceiptData,
      signingKeys: evidenceReceiptSigningKeys,
    },
    compliance: {
      data: complianceData,
      signingKeys: evidenceReceiptSigningKeys,
    },
    improvement: {
      audit: {
        getSkillActivationPolicy: async () => await gateway.getSkillActivationPolicy(),
        listCapabilityCatalog: async (scope) => await gateway.capabilitySystemService.listCatalog(scope),
        listCapabilityProposals: async (limit) => await gateway.capabilitySystemService.listProposals(limit),
        listSkillImportHistory: async (limit) => await gateway.listSkillImportHistory(limit),
        listSkills: async () => gateway.listSkills(),
      },
      improvement: gateway.improvementService,
    },
    knowledge: knowledgeFacade,
    memory: gateway.memoryLifecycleService,
    skills: {
      bulkSetSkillState: (skillIds, state, note, expectedRevisionsBySkillId) =>
        gateway.bulkSetSkillState(skillIds, state, note, expectedRevisionsBySkillId),
      getSkillActivationPolicy: () => gateway.getSkillActivationPolicy(),
      installSkillImport: (input) => gateway.installSkillImport(input),
      createSkillHubApproval: (input) => skillHubOperator.createApproval(input),
      listSkillHub: (input) => skillHubOperator.list(input),
      prepareSkillHubRollbackReview: (input) => gateway.prepareSkillHubRollbackReview(input),
      reviewSkillHubSource: (input) => gateway.reviewSkillHubSource(input),
      listSkillEvaluationRuns: async (skillId) => ({ items: await skillEvaluation.listSkillEvaluationRuns(skillId) }),
      listSkillImportHistory: (limit) => gateway.listSkillImportHistory(limit),
      listSkillSources: (query, limit) => gateway.listSkillSources(query, limit),
      listSkills: () => gateway.listSkills(),
      listSkillExportTargets: () => gateway.listSkillExportTargets(),
      lookupSkillSources: (queryOrUrl, limit) => gateway.lookupSkillSources(queryOrUrl, limit),
      packageSkillExport: (input) => gateway.packageSkillExport(input),
      previewSkillExport: (input) => gateway.previewSkillExport(input),
      previewSkillEvaluation: async (skillId, input) => ({
        run: await skillEvaluation.previewSkillEvaluation(skillId, input),
      }),
      runSkillEvaluation: (skillId, input) => skillEvaluation.runSkillEvaluation(skillId, input),
      getSkillEvaluationRun: (runId) => skillEvaluation.getSkillEvaluationRun(runId),
      createSkillEvaluationProposal: (runId) => skillEvaluation.createSkillEvaluationProposal(runId),
      reloadSkills: () => gateway.reloadSkills(),
      resolveSkillActivation: (input) => gateway.resolveSkillActivation(input),
      setSkillState: (skillId, state, note, expectedRevision) =>
        gateway.setSkillState(skillId, state, note, expectedRevision),
      updateSkillActivationPolicy: (input, expectedRevision) =>
        gateway.updateSkillActivationPolicy(input, expectedRevision),
      validateSkillImport: (input) => gateway.validateSkillImport(input),
    },
  };
}
