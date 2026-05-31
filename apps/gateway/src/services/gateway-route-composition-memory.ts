import { KnowledgeFacadeService } from "./memory-facade-service.js";
import { SkillEvaluationService } from "./skill-evaluation-service.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";

export function composeMemoryKnowledgeRouteDependencies(
  gateway: GatewayRouteCompositionPort,
): RouteDependencyDomain<
  "capabilities" | "capabilityPacks" | "curator" | "evidence" | "improvement" | "knowledge" | "memory" | "skills"
> {
  const knowledgeFacade = new KnowledgeFacadeService({
    invokeAndUnwrap: (request, realtimeType) => gateway.invokeAndUnwrap(request, realtimeType),
  });
  const skillEvaluation = new SkillEvaluationService({
    storage: gateway.storage,
    listSkills: () => gateway.listSkills(),
    createCapabilityProposal: (input) => gateway.capabilitySystemService.createProposal(input),
    recordSkillEvaluationSignal: (input) => gateway.improvementService.recordSkillEvaluationSignal(input),
  });

  return {
    capabilities: gateway.capabilitySystemService,
    capabilityPacks: {
      installLocalPack: (input) => gateway.capabilityPackService.installLocalPack(input),
      installPack: (packId, input) => gateway.capabilityPackService.installPack(packId, input),
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
    improvement: {
      audit: {
        getSkillActivationPolicy: () => gateway.getSkillActivationPolicy(),
        listCapabilityCatalog: (scope) => gateway.capabilitySystemService.listCatalog(scope),
        listCapabilityProposals: (limit) => gateway.capabilitySystemService.listProposals(limit),
        listSkillImportHistory: (limit) => gateway.listSkillImportHistory(limit),
        listSkills: () => gateway.listSkills(),
      },
      improvement: gateway.improvementService,
    },
    knowledge: knowledgeFacade,
    memory: gateway.memoryLifecycleService,
    skills: {
      bulkSetSkillState: (skillIds, state, note) => gateway.bulkSetSkillState(skillIds, state, note),
      getSkillActivationPolicy: () => gateway.getSkillActivationPolicy(),
      installSkillImport: (input) => gateway.installSkillImport(input),
      listSkillEvaluationRuns: (skillId) => ({ items: skillEvaluation.listSkillEvaluationRuns(skillId) }),
      listSkillImportHistory: (limit) => gateway.listSkillImportHistory(limit),
      listSkillSources: (query, limit) => gateway.listSkillSources(query, limit),
      listSkills: () => gateway.listSkills(),
      listSkillExportTargets: () => gateway.listSkillExportTargets(),
      lookupSkillSources: (queryOrUrl, limit) => gateway.lookupSkillSources(queryOrUrl, limit),
      packageSkillExport: (input) => gateway.packageSkillExport(input),
      previewSkillExport: (input) => gateway.previewSkillExport(input),
      previewSkillEvaluation: (skillId, input) => ({ run: skillEvaluation.previewSkillEvaluation(skillId, input) }),
      runSkillEvaluation: (skillId, input) => skillEvaluation.runSkillEvaluation(skillId, input),
      getSkillEvaluationRun: (runId) => skillEvaluation.getSkillEvaluationRun(runId),
      createSkillEvaluationProposal: (runId) => skillEvaluation.createSkillEvaluationProposal(runId),
      reloadSkills: () => gateway.reloadSkills(),
      resolveSkillActivation: (input) => gateway.resolveSkillActivation(input),
      setSkillState: (skillId, state, note) => gateway.setSkillState(skillId, state, note),
      updateSkillActivationPolicy: (input) => gateway.updateSkillActivationPolicy(input),
      validateSkillImport: (input) => gateway.validateSkillImport(input),
    },
  };
}
