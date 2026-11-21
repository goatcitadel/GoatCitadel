import {createHash,randomUUID} from "node:crypto";
import type {Storage} from "@goatcitadel/storage";
import type {ImprovementActivationRecord,PromptPackRunRecord} from "@goatcitadel/contracts";
import type {ImprovementService} from "./improvement-service.js";
/** Component evidence fixture: canonical synthetic runs, not live model proof. */
export async function recordBoundPromptLabRegression(harness:{storage:Storage;service:ImprovementService},activation:ImprovementActivationRecord,input:Parameters<ImprovementService["recordPromptLabRegressionCompletionSignal"]>[0]) {
  const active=await harness.service.getImprovementActivation(activation.activationId),detail=await harness.service.getImprovementCandidateDetail(active.candidateId);
  const capturedAt=new Date().toISOString(),bindings=harness.storage.improvementWatchEvidence.captureForWork({workspaceId:detail.candidate.workspaceId,fingerprint:detail.candidate.fingerprint,capability:input.capability,capturedAt});
  if(bindings.length!==1)throw new Error("Fixture requires exactly one active current watch before work");
  const text="Synthetic verified result",responseChecksumSha256=createHash("sha256").update(text).digest("hex"),stamp=Date.parse(capturedAt);
  const base={packId:input.packId,testId:`test:${input.capability}`,status:"completed" as const,providerId:"synthetic",model:"fixture-model",responseText:text,trace:{status:"completed",completion:{status:"complete",providerCallCount:1,repaired:false}} as PromptPackRunRecord["trace"],integrity:{validationStatus:"valid" as const,signals:[],responseChecksumSha256}};
  const baseline=harness.storage.promptPackRuns.create({...base,runId:randomUUID(),startedAt:new Date(stamp-10).toISOString(),finishedAt:new Date(stamp-5).toISOString()});
  const current=harness.storage.promptPackRuns.create({...base,runId:randomUUID(),startedAt:capturedAt,finishedAt:new Date().toISOString(),improvementWatchBindings:bindings});
  return harness.service.recordPromptLabRegressionCompletionSignal({...input,currentRunId:current.runId,baselineRunId:baseline.runId});
}
