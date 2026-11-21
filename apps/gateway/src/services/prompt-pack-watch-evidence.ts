import {createHash} from "node:crypto";
import {readPromptPackImprovementWatchBindings,type PromptPackRunRecord} from "@goatcitadel/contracts";
/** Retrospective reports may consume saved pre-work eligibility, never create it. */
export function selectPromptPackWatchBinding(input:{current:PromptPackRunRecord;baseline:PromptPackRunRecord;workspaceId:string;fingerprint:string;capability:string}) {
  const {current,baseline}=input;
  if(current.runId===baseline.runId||current.packId!==baseline.packId||current.testId!==baseline.testId||!current.providerId||!current.model||current.providerId!==baseline.providerId||current.model!==baseline.model)return undefined;
  for(const run of [current,baseline]){
    if(run.status!=="completed"||run.error||run.trace?.status!=="completed"||run.trace.failure||run.trace.completion?.status!=="complete"||!(Number(run.trace.completion.providerCallCount)>0)||!run.responseText||run.integrity?.validationStatus!=="valid"||run.integrity.responseChecksumSha256!==createHash("sha256").update(run.responseText).digest("hex")||!run.finishedAt||!Number.isFinite(Date.parse(run.finishedAt))||Date.parse(run.finishedAt)<Date.parse(run.startedAt))return undefined;
    const route=run.trace.routing;
    if(route && (route.effectiveProviderId!==run.providerId||route.effectiveModel!==run.model))return undefined;
  }
  const bindings=readPromptPackImprovementWatchBindings(current.improvementWatchBindings,current.startedAt);
  const binding=bindings?.find(item=>item.workspaceId===input.workspaceId&&item.fingerprint===input.fingerprint&&item.capability===input.capability);
  return binding && Date.parse(baseline.finishedAt!)<=Date.parse(binding.capturedAt) ? binding:undefined;
}
