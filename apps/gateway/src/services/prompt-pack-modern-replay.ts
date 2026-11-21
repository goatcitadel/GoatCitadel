import {createHash} from "node:crypto";
import {canonicalJsonString,PROMPT_PACK_WATCH_CAPABILITIES,type PromptPackAutoScoreRecord,type PromptPackComparisonEvidence,type PromptPackRunRecord} from "@goatcitadel/contracts";
/** Compare native dimensions under the same scoring generation and actual model.
 * A newer judge pass on older work never makes that work the latest run. */
export function selectModernPromptPackReplay(input:{runs:PromptPackRunRecord[];scores:PromptPackAutoScoreRecord[];testId:string;packId:string;baselineRef?:string;baselineRunIds?:string[]}) {
  const byRun=new Map<string,PromptPackAutoScoreRecord>();
  for(const score of [...input.scores].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)))
    if(score.packId===input.packId&&score.testId===input.testId&&!byRun.has(score.runId))byRun.set(score.runId,score);
  const runs=input.runs.filter(run=>run.packId===input.packId&&run.testId===input.testId&&byRun.has(run.runId)).sort((a,b)=>Date.parse(b.finishedAt ?? b.startedAt)-Date.parse(a.finishedAt ?? a.startedAt));
  const current=runs[0],currentScore=current && byRun.get(current.runId);
  const valid=(score:PromptPackAutoScoreRecord)=>score.scoreState==="auto_valid"&&score.autoVerdict!=="review";
  if(!current||!currentScore||!valid(currentScore)||current.status!=="completed"||!current.providerId||!current.model)return undefined;
  const generation=(score:PromptPackAutoScoreRecord)=>canonicalJsonString([score.scoringSchemaVersion,score.scorerVersion,score.judgeRubricVersion,score.policyHash,score.assertionSetVersion ?? null,score.judgeProviderId ?? null,score.judgeModel ?? null]);
  const eligible=runs.slice(1).filter(run=>run.status==="completed"&&run.providerId===current.providerId&&run.model===current.model&&run.finishedAt&&Date.parse(run.finishedAt)<=Date.parse(current.startedAt)&&(!input.baselineRef||Date.parse(run.finishedAt)<=Date.parse(input.baselineRef))&&(!input.baselineRunIds||input.baselineRunIds.includes(run.runId))&&valid(byRun.get(run.runId)!)&&generation(byRun.get(run.runId)!)===generation(currentScore));
  if(input.baselineRunIds&&eligible.length!==1)return undefined;
  const baseline=eligible[0],baselineScore=baseline && byRun.get(baseline.runId);if(!baseline||!baselineScore)return undefined;
  const metrics:PROMPT_PACK_METRIC[]=[];
  for(const capability of PROMPT_PACK_WATCH_CAPABILITIES){
    const key=capability,a=(currentScore.finalScores as Record<string,number|undefined>)[key],b=(baselineScore.finalScores as Record<string,number|undefined>)[key];
    if((currentScore.applicability as Record<string,boolean|undefined>)[key]!==true||(baselineScore.applicability as Record<string,boolean|undefined>)[key]!==true||typeof a!=="number"||typeof b!=="number"||!Number.isFinite(a)||!Number.isFinite(b)||a<0||a>4||b<0||b>4)continue;
    metrics.push({capability,scoreDelta:a-b});
  }
  if(!metrics.length)return undefined;
  const digest=(score:PromptPackAutoScoreRecord)=>createHash("sha256").update(canonicalJsonString(score)).digest("hex");
  const comparison:PromptPackComparisonEvidence={kind:"auto_scored",currentScoreId:currentScore.autoScoreId,baselineScoreId:baselineScore.autoScoreId,currentScoreHash:digest(currentScore),baselineScoreHash:digest(baselineScore),scoringSchemaVersion:currentScore.scoringSchemaVersion,scorerVersion:currentScore.scorerVersion,judgeRubricVersion:currentScore.judgeRubricVersion,policyHash:currentScore.policyHash};
  return {current,baseline,currentScore,baselineScore,metrics,comparison,passDelta:Number(currentScore.autoVerdict==="pass")-Number(baselineScore.autoVerdict==="pass")};
}
type PROMPT_PACK_METRIC={capability:typeof PROMPT_PACK_WATCH_CAPABILITIES[number];scoreDelta:number};
