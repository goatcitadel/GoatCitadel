import path from "node:path";
import { runUxBudgetsLane } from "./lib/scenarios.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import { createRunContext,finalizeRunContext,releaseRunContext,repoRoot } from "./lib/shared.mjs";
const startupDiagnosticOnly=process.argv.includes("--startup-diagnostic-only");
const context=await createRunContext("ux-budgets",{commandSelection:startupDiagnosticOnly?"cockpit-startup-diagnostic-only":"cockpit-performance-matched-cold"});
try {
 await runUxBudgetsLane(context,{performanceOnly:true,startupDiagnosticOnly,secretEnvKeys:await collectVerificationSecretEnvKeys(path.join(repoRoot,"config"))});
 const manifest=await finalizeRunContext(context);
 console.log(`Cockpit performance proof: ${context.artifactRoot}\nStatus: ${manifest.status}`);
 if(manifest.status!=="passed")process.exitCode=1;
} catch(error){await finalizeRunContext(context,"failed");throw error;}
finally {await releaseRunContext(context);}
