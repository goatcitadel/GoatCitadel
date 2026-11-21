import path from "node:path";
import { runUxBudgetsLane } from "./lib/scenarios.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import { createRunContext,finalizeRunContext,releaseRunContext,repoRoot } from "./lib/shared.mjs";
const startupDiagnosticOnly=process.argv.includes("--startup-diagnostic-only");
const startupOnly = process.argv.includes("--startup-only");
if (startupOnly && startupDiagnosticOnly) throw new Error("Choose either --startup-only or --startup-diagnostic-only.");
const commandSelection = startupDiagnosticOnly ? "cockpit-startup-diagnostic-only"
  : startupOnly ? "cockpit-startup-budget" : "cockpit-performance-matched-cold";
const context=await createRunContext("ux-budgets",{commandSelection});
try {
 await runUxBudgetsLane(context,{performanceOnly:true,startupDiagnosticOnly,startupOnly,secretEnvKeys:await collectVerificationSecretEnvKeys(path.join(repoRoot,"config"))});
 const manifest=await finalizeRunContext(context);
 console.log(`Cockpit performance proof: ${context.artifactRoot}\nStatus: ${manifest.status}`);
 if(manifest.status!=="passed")process.exitCode=1;
} catch(error){await finalizeRunContext(context,"failed");throw error;}
finally {await releaseRunContext(context);}
