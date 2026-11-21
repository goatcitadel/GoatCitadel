import {readDurableChatTurnExecutionPayloadAuthority,type ChatCompletionRequest,type ChatTurnCapabilityProfileRecord,type ChatTurnFeatureReferences} from "@goatcitadel/contracts";
import type {AsyncStorage} from "@goatcitadel/storage";
export async function resolveChatLearningSkillManifest(deps:{storage:Pick<AsyncStorage,"chatTurnTraces"|"durableRuns"|"sessionMutationAdmissions"|"chatTurnCapabilityProfiles">;renderAdmitted:(refs:ChatTurnFeatureReferences,workspaceId:string)=>Promise<string|undefined>;renderProfile:(profile:ChatTurnCapabilityProfileRecord)=>Promise<string|undefined>},request:ChatCompletionRequest){
  if(!request.memory?.sessionId || !request.memory.turnId || !request.messages.some(message=>message.role==="system" && typeof message.content==="string" && message.content.startsWith("Server-owned governed runtime skill instructions follow.")))return undefined;
  const trace=await deps.storage.chatTurnTraces.get(request.memory.turnId);
  if(trace.sessionId!==request.memory.sessionId)return undefined;
  if(trace.durable?.runId){
    const run=await deps.storage.durableRuns.getRun(trace.durable.runId),payload=readDurableChatTurnExecutionPayloadAuthority({workflowKey:run.workflowKey,durableRunId:run.runId,payload:run.payload});
    if(payload && payload.sessionId===trace.sessionId && payload.turnId===trace.turnId){
      const frozen=await deps.storage.sessionMutationAdmissions.findFeatureReferences({admissionId:payload.admissionId,workspaceId:payload.workspaceId,sessionId:payload.sessionId,sessionIncarnationId:payload.sessionIncarnationId,turnId:payload.turnId});
      const skills=frozen?.references.selectedSkills?.activatedSkills;
      if(skills?.length){const instruction=await deps.renderAdmitted(frozen!.references,payload.workspaceId);if(instruction)return {instruction,sources:skills.map(skill=>({skillId:skill.skillId,instructionSha256:skill.instructionSha256,treeSha256:skill.treeSha256}))};}
    }
  }
  if(trace.capabilityProfileId && trace.capabilityProfileHash){
    const profile=await deps.storage.chatTurnCapabilityProfiles.get(trace.capabilityProfileId);
    if(profile.identity.sessionId!==trace.sessionId || profile.identity.turnId!==trace.turnId || profile.hashes.profileHash!==trace.capabilityProfileHash)return undefined;
    const skills=profile.selection.activatedSkills;
    if(skills?.length){const instruction=await deps.renderProfile(profile);if(instruction)return {instruction,sources:skills.map(skill=>({skillId:skill.skillId,instructionSha256:skill.instructionSha256,treeSha256:skill.treeSha256}))};}
  }
  return undefined;
}
