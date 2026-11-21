import {createHash} from "node:crypto";
import path from "node:path";
import {canonicalJsonString,ConflictError,type CapabilityArtifactRecord,type CandidateSkillVersionRecord,type LearningReviewSource} from "@goatcitadel/contracts";
import type {AsyncStorage} from "@goatcitadel/storage";
import {writeImmutableBundle} from "./candidate-skill-artifacts.js";
import {validateWorkflowSkillDraft} from "./workflow-skill-draft-validation.js";

type SourceStorage=Pick<AsyncStorage,"backgroundLearningJobs"|"chatTurnTraces"|"chatToolRuns">;
type DraftStorage=SourceStorage & Pick<AsyncStorage,"candidateSkillVersions"|"capabilityProposals"|"skillAggregateRevisions"|"runImmediateTransaction">;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export interface BackgroundSkillDraftInput {jobId:string;workspaceId:string;sessionId:string;sources:LearningReviewSource[];markdown:string}

/** Proposal rights only. Never calls authenticated workflow capture or changes a callable state. */
export class BackgroundSkillDraftService {
  public constructor(private readonly deps:{storage:DraftStorage;rootDir:string;candidateRoot:string}){}
  public async proposeBackgroundSkillDraft(input:BackgroundSkillDraftInput) {
    const validation=validateWorkflowSkillDraft(input.markdown);
    const sourceFingerprint=await assertBackgroundSkillSourcesCurrent(this.deps.storage,input);
    const frozenBatchFingerprint=hash(canonicalJsonString(input.sources));
    const candidateId=`background-${hash(`${input.jobId}\0${frozenBatchFingerprint}`).slice(0,24)}`;
    const versionId=`background-version-${hash(`${candidateId}\0${sourceFingerprint}\0${hash(input.markdown)}`).slice(0,32)}`;
    const proposalId=`background-proposal-${hash(versionId).slice(0,32)}`;
    const job=(await this.deps.storage.backgroundLearningJobs.get(input.jobId))!;
    const createdAt=job.frozenAt ?? job.firstQueuedAt;
    const root=path.resolve(this.deps.rootDir,this.deps.candidateRoot),bundlePath=path.join(root,candidateId,versionId);
    const manifest={manifestVersion:1,candidateId,versionId,sourceKind:"background_workflow",lineageStatus:"governed",workspaceId:input.workspaceId,sourceSessionId:input.sessionId,learningJobId:input.jobId,learningReviewSources:input.sources,frozenBatchFingerprint,sourceFingerprint,createdByActorId:"system:background-learning",instructionAuthority:"model",requestAuthority:"system_proposal_only",createdAt};
    const proof={validation,sourceFingerprint,instructionSha256:hash(input.markdown),evaluation:"structure_and_safety_passed",behavioralValidation:"not_run",callable:false,activationPerformed:false};
    const files={"manifest.json":JSON.stringify(manifest,null,2),"SKILL.md":input.markdown,"proof.json":JSON.stringify(proof,null,2)};
    const artifact=(filename:keyof typeof files,mimeType:string):CapabilityArtifactRecord=>({artifactId:`${versionId}-${filename}`,relPath:path.relative(this.deps.rootDir,path.join(bundlePath,filename)).replaceAll("\\","/"),sha256:hash(files[filename]),bytes:Buffer.byteLength(files[filename]),mimeType,createdAt});
    const candidate:CandidateSkillVersionRecord={candidateId,versionId,sourceKind:"background_workflow",lineageStatus:"governed",workspaceId:input.workspaceId,sourceFingerprint,createdByActorId:"system:background-learning",originatingRunId:job.runId,title:validation.inferredSkillName ?? candidateId,summary:"Draft from completed work. Evaluation and operator review are required before activation.",bundleRoot:path.relative(this.deps.rootDir,bundlePath).replaceAll("\\","/"),lifecycleState:"candidate",manifestArtifact:artifact("manifest.json","application/json"),instructionArtifact:artifact("SKILL.md","text/markdown"),proofArtifact:artifact("proof.json","application/json"),createdAt,updatedAt:createdAt};
    await writeImmutableBundle(root,bundlePath,files);
    const revision=await this.deps.storage.runImmediateTransaction(async()=>{
      if(await assertBackgroundSkillSourcesCurrent(this.deps.storage,input)!==sourceFingerprint) throw new ConflictError({message:"Background workflow evidence changed while staging."});
      const replay=await this.deps.storage.candidateSkillVersions.find(versionId);
      if(replay){
        const revision=await this.deps.storage.skillAggregateRevisions.get("candidate_skill",candidateId);
        if(replay.instructionArtifact.sha256!==candidate.instructionArtifact.sha256 || replay.sourceFingerprint!==sourceFingerprint || !revision || !await this.deps.storage.capabilityProposals.find(proposalId)) throw new ConflictError({message:"Background draft replay does not match its immutable evidence."});
        return revision.revision;
      }
      // A second response for one frozen job is a new review, never a silent edit.
      if(await this.deps.storage.candidateSkillVersions.findLatestByCandidateId(candidateId)) throw new ConflictError({message:"This review already produced a different skill draft."});
      const revision=await this.deps.storage.skillAggregateRevisions.createInitialRevisionFence("candidate_skill",candidateId,createdAt);
      await this.deps.storage.candidateSkillVersions.upsert(candidate);
      await this.deps.storage.capabilityProposals.upsert({proposalId,proposalKind:"skill",status:"proposed",title:`Review workflow draft: ${candidate.title}`,summary:candidate.summary!,candidateId,activationTargetId:candidateId,payload:{...manifest,...proof,versionId},createdAt,updatedAt:createdAt});
      return revision.revision;
    });
    return {candidateId,versionId,proposalId,revision,activationPerformed:false as const,evaluation:"structure_and_safety_passed" as const,behavioralValidation:"not_run" as const};
  }
}

export async function assertBackgroundSkillSourcesCurrent(storage:SourceStorage,input:Pick<BackgroundSkillDraftInput,"jobId"|"workspaceId"|"sessionId"|"sources">):Promise<string>{
  const job=await storage.backgroundLearningJobs.get(input.jobId);
  if(!job?.frozenAt)throw new ConflictError({message:"Background skill sources must be frozen before review."});
  if(!job || job.kind!=="review" || job.workspaceId!==input.workspaceId || job.sessionId!==input.sessionId || !job.destinations?.includes("skill") || !input.sources.length || input.sources.length>50) throw new ConflictError({message:"Background skill source scope changed."});
  const evidence:unknown[]=[];
  const positions=input.sources.map(source=>job.sources.findIndex(item=>canonicalJsonString(item)===canonicalJsonString(source)));
  if(positions.some((position,index)=>position<0 || (index>0 && position!==positions[index-1]!+1)))throw new ConflictError({message:"Background skill requires the canonical frozen source order."});
  for(const source of input.sources){
    if(!job.sources.some(item=>canonicalJsonString(item)===canonicalJsonString(source))) throw new ConflictError({message:"Background skill source is outside the frozen review."});
    const {sourceHash,...identity}=source,current=await storage.backgroundLearningJobs.readEligibleSource(identity);
    const trace=await storage.chatTurnTraces.get(source.sourceTurnId);
    if(current?.source.sourceHash!==sourceHash || trace.sessionId!==input.sessionId || trace.status!=="completed" || trace.completion?.status!=="complete" || !(Number(trace.completion.providerCallCount)>0) || trace.failure || trace.completion.failedFileMutations?.length) throw new ConflictError({message:"Background skill requires current successful source work."});
    const tools=[];
    let after:{startedAt:string;toolRunId:string}|undefined;
    for(let page=0;page<4;page++) {
      const rows=await storage.chatToolRuns.listByTurnPage(source.sourceTurnId,after,32);
      tools.push(...rows);if(rows.length<32) break;
      const last=rows.at(-1)!;after={startedAt:last.startedAt,toolRunId:last.toolRunId};
    }
    if(tools.length>100 || tools.some(tool=>tool.sessionId!==input.sessionId || tool.status!=="executed" || !tool.finishedAt || tool.error || tool.effectDisposition==="unknown" || !["none","concrete"].includes(tool.effectOutcomeKind ?? ""))) throw new ConflictError({message:"Background skill requires settled tool evidence."});
    evidence.push({source,completion:trace.completion,tools:tools.map(tool=>({id:tool.toolRunId,resultHash:hash(canonicalJsonString(tool.result ?? null)),effectHash:hash(canonicalJsonString(tool.effectEvidence ?? null)),finishedAt:tool.finishedAt}))});
  }
  return hash(canonicalJsonString(evidence));
}
