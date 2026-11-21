import {ConflictError,ValidationError,memoryClaimKey,normalizeMemoryClaim,redactSecretText,type GovernedMemoryMaintenancePlan,type MemoryLearningRecord} from "@goatcitadel/contracts";
import {scanPromptwareContent} from "./assembled-prompt-injection-guard.js";

/** Prepares an inspectable proposal only. Full target bytes are rechecked on promotion. */
export function prepareGovernedMemoryPlan(input:Omit<GovernedMemoryMaintenancePlan,"version"|"operation"|"targets">,records:MemoryLearningRecord[]):GovernedMemoryMaintenancePlan {
  const base={...input,version:1 as const,operation:"add" as const,targets:[]};
  if(!input.claim)return base;
  const claim=normalizeMemoryClaim(input.claim),key=memoryClaimKey(input.workspaceId,claim);
  const targets=records.filter(record=>record.workspaceId===input.workspaceId && record.status==="trusted" &&
    ["operator","trusted_lifecycle"].includes(record.authority) && record.claim && /^[a-f0-9]{64}$/u.test(record.sourceHash ?? "") && memoryClaimKey(input.workspaceId,record.claim)===key);
  if(targets.length>1)return {...base,claim,clarificationRequired:"Which saved memory should this replace? Choose one exact target in Chat for a fresh review."};
  const target=targets[0];
  if(!target)return {...base,claim};
  const merge=JSON.stringify(target.claim!.value)===JSON.stringify(claim.value);
  const proposedInsight=merge && target.insight.trim()!==input.proposedInsight.trim() ? `${target.insight.trim()}\n${input.proposedInsight.trim()}`:input.proposedInsight;
  if(proposedInsight.length>2000)return {...base,claim,clarificationRequired:"The combined saved memory exceeds the review limit. Prepare a smaller combined memory in Chat before replacing it."};
  return {...base,claim,proposedInsight,operation:merge ? "merge":"supersede",targets:[{learningId:target.learningId,sourceHash:target.sourceHash!}]};
}

/** Pure validation only. The lifecycle re-reads canonical sources/targets in its
 * promotion transaction and alone supplies operator authority after review. */
export function validateGovernedMemoryPlan(plan:GovernedMemoryMaintenancePlan,targets:MemoryLearningRecord[]) {
  if(plan?.clarificationRequired)throw new ConflictError({message:plan.clarificationRequired});
  if(!plan || plan.version!==1 || !["add","merge","supersede"].includes(plan.operation) || !plan.workspaceId || !plan.jobId ||
    typeof plan.proposedInsight!=="string" || !plan.proposedInsight.trim() || plan.proposedInsight.length>2000 || !Array.isArray(plan.sources) || !plan.sources.length || plan.sources.length>50 ||
    plan.sources.some(source=>source.workspaceId!==plan.workspaceId || !/^[a-f0-9]{64}$/u.test(source.sourceHash)) || !Array.isArray(plan.targets) || plan.targets.length>1)
    throw new ValidationError({message:"Memory maintenance plan is incomplete or exceeds its review limits."});
  if(redactSecretText(plan.proposedInsight.normalize("NFKC"),{env:process.env}).redactionCount || scanPromptwareContent({source:"memory_context",content:plan.proposedInsight}).length)
    throw new ValidationError({message:"Memory maintenance plan contains unsafe source content."});
  const claim=plan.claim ? normalizeMemoryClaim(plan.claim):undefined;
  if(claim) memoryClaimKey(plan.workspaceId,claim);
  if(plan.operation === "add") {
    if(plan.targets.length || targets.length) throw new ConflictError({message:"An addition cannot replace prior memory."});
    return {...(claim ? {claim}:{})};
  }
  const requested=plan.targets[0],target=targets[0];
  if(!claim || !requested || targets.length!==1 || !target || target.learningId!==requested.learningId || target.sourceHash!==requested.sourceHash ||
    !/^[a-f0-9]{64}$/u.test(requested.sourceHash) || target.workspaceId!==plan.workspaceId || target.status!=="trusted" || !["operator","trusted_lifecycle"].includes(target.authority) || !target.claim ||
    memoryClaimKey(plan.workspaceId,target.claim)!==memoryClaimKey(plan.workspaceId,claim))
    throw new ConflictError({message:"Memory maintenance target or subject/project lineage changed. Review exact current evidence."});
  return {claim,supersedeTarget:{learningId:target.learningId,expectedSourceHash:requested.sourceHash}};
}
