import {expect,it} from "vitest";
import type {PromptPackAutoScoreRecord,PromptPackRunRecord} from "@goatcitadel/contracts";
import {selectModernPromptPackReplay} from "./prompt-pack-modern-replay.js";
function fixture(){
  const baseline={runId:"baseline",packId:"pack",testId:"test",status:"completed",providerId:"p",model:"m",startedAt:"2026-11-19T00:00:00.000Z",finishedAt:"2026-11-19T00:00:01.000Z"} as PromptPackRunRecord,current={...baseline,runId:"current",startedAt:"2026-11-19T00:00:03.000Z",finishedAt:"2026-11-19T00:00:04.000Z"};
  const score=(id:string,runId:string,value:number)=>({autoScoreId:id,runId,packId:"pack",testId:"test",scoringSchemaVersion:"v3",scorerVersion:"scorer",judgeRubricVersion:"rubric",policyHash:"policy",scoreState:"auto_valid",judgeStatus:"valid",judgeProviderId:"judge",judgeModel:"judge-model",autoVerdict:value>1?"pass":"fail",finalScores:{truthfulness:value,taskSuccess:value},applicability:{truthfulness:true,taskSuccess:true},createdAt:runId==="current"?"2026-11-19T00:00:05.000Z":"2026-11-19T00:00:02.000Z"} as PromptPackAutoScoreRecord);
  return {runs:[current,baseline],scores:[score("new","current",3),score("old","baseline",1)],testId:"test",packId:"pack"};
}
it("compares current native score dimensions without requiring retired v1 scores",()=>{
  const result=selectModernPromptPackReplay(fixture());expect(result?.currentScore.autoScoreId).toBe("new");expect(result?.baselineScore.autoScoreId).toBe("old");expect(result?.metrics).toEqual([{capability:"taskSuccess",scoreDelta:2},{capability:"truthfulness",scoreDelta:2}]);expect(result?.passDelta).toBe(1);
});
it.each(["policy","schema","rubric","judge","provider","model","foreign_test","degraded","late_baseline","not_applicable"])("refuses non-comparable %s observations",reason=>{
  const f=fixture(),baseline=f.scores[1]!;
  if(reason==="policy")baseline.policyHash="other";
  if(reason==="schema")baseline.scoringSchemaVersion="v2";
  if(reason==="rubric")baseline.judgeRubricVersion="other";
  if(reason==="judge")baseline.judgeModel="other";
  if(reason==="provider")f.runs[1]!.providerId="other";
  if(reason==="model")f.runs[1]!.model="other";
  if(reason==="foreign_test")f.scores[1]!.testId="foreign";
  if(reason==="degraded")baseline.scoreState="auto_degraded";
  if(reason==="late_baseline")f.runs[1]!.finishedAt="2026-11-19T00:00:03.500Z";
  if(reason==="not_applicable"){baseline.applicability={};}
  expect(selectModernPromptPackReplay(f)).toBeUndefined();
});
