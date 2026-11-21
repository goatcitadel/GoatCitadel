import {expect,it} from "vitest";
import {evaluateImprovementWatch} from "@goatcitadel/contracts";
it("ends with insufficient evidence after zero or neutral traffic and requires a positive target",()=>{
  expect(evaluateImprovementWatch({deadlineReached:true,positiveSignalCount:0,requiredPositiveSignals:5,regressionCount:0})).toBe("insufficient_evidence");
  expect(evaluateImprovementWatch({deadlineReached:false,positiveSignalCount:4,requiredPositiveSignals:5,regressionCount:0})).toBe("watching");
  expect(()=>evaluateImprovementWatch({deadlineReached:true,positiveSignalCount:0,requiredPositiveSignals:0,regressionCount:0})).toThrow();
});
it("uses relevant positives for stability and gives regressions priority",()=>{
  expect(evaluateImprovementWatch({deadlineReached:false,positiveSignalCount:5,requiredPositiveSignals:5,regressionCount:0})).toBe("stable");
  expect(evaluateImprovementWatch({deadlineReached:true,positiveSignalCount:5,requiredPositiveSignals:5,regressionCount:1})).toBe("alerting");
});
