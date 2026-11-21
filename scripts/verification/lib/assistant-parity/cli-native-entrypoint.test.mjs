import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareComparison, COMPARISON_VERSION, sha256 } from "../agent-comparison.mjs";
import { ASSISTANT_PARITY_SUITE } from "./native-tasks.mjs";

for (const rejectRelabel of [true, false])
  test(
    rejectRelabel
      ? "ordinary live CLI reaches a supervised case and refuses to relabel controlled evidence as native"
      : "ordinary live CLI opens fresh sessions for consecutive cases under one canonical campaign budget",
    { timeout: 120000 },
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-parity-cli-"));
      try {
        const products = Object.fromEntries(
          ["goatcitadel", "openclaw", "hermes"].map((product) => [
            product,
            {
              revision: "a".repeat(40),
              provider: "controlled-fixture",
              model: "fixture-text",
              reasoning: "none",
              contextTokens: 4096,
              outputTokens: 128,
              maxTaskMs: 30000,
              tools: ["files"],
              grants: ["test-workspace"],
            },
          ]),
        );
        const pricing = {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 2,
          requestUsd: 0,
          observedAt: "2026-11-19T00:00:00.000Z",
          sourceSha256: sha256("controlled fixture rates"),
        };
        const transportProfile = {
          upstreamUrl: "https://provider.invalid/v1/chat/completions",
          outputField: "max_completion_tokens",
          pricing,
        };
        const campaign = prepareComparison({
          schemaVersion: COMPARISON_VERSION,
          suite: ASSISTANT_PARITY_SUITE,
          products,
          trials: 3,
          maxRequests: 2,
          maxCostUsd: 1,
          transportProfile,
        });
        const moduleFile = path.join(root, "controlled-sessions.mjs"),
          marker = path.join(root, "dispatched.json"),
          report = path.join(root, "report");
        const comparisonUrl = pathToFileURL(path.resolve("scripts/verification/lib/agent-comparison.mjs")).href;
        const sessionUrl = pathToFileURL(path.resolve("scripts/verification/lib/agent-comparison-session.mjs")).href;
        const code =
          `import {prepareComparison} from ${JSON.stringify(comparisonUrl)};\nimport {startComparisonSession} from ${JSON.stringify(sessionUrl)};\n` +
          String.raw`
import fs from 'node:fs/promises';import path from 'node:path';
export async function createReviewedNativeSessions({providerConfig,root}){
 return {goatcitadel:{productRef:providerConfig.products.goatcitadel.productRef,maxCostUsd:1,
  async openCase({task,binding}){
   const parent=path.join(root,'controlled-campaign');await fs.mkdir(parent,{recursive:true});
   const session=await startComparisonSession({manifest:prepareComparison(providerConfig.controlledCampaign),campaignDirectory:parent,outputDirectory:path.join(parent,task.id),
    options:{schemaVersion:'goatcitadel.agent-comparison.supervised.v1',cellId:'goatcitadel:'+task.nativeTaskId+':1',checkoutRoot:parent,apiKeyEnv:'CONTROLLED_ONLY_TEST_KEY',upstreamUrl:providerConfig.controlledCampaign.transportProfile.upstreamUrl,outputField:'max_completion_tokens',pricing:providerConfig.controlledCampaign.transportProfile.pricing},
    upstreamApiKey:'synthetic-only-no-network-key',checkout:{revision:'a'.repeat(40),clean:true},evidenceSource:'controlled_fixture',fetchUpstream:async()=>{throw Error('This plumbing test must make zero provider requests');}});
   return {session,source:'controlled_fixture',actions:{async run_assistant_case({task:nativeTask}){
    if(nativeTask.assistantCase.id!==binding.caseId || nativeTask.id!==task.nativeTaskId)throw Error('Case binding mismatch');
    await fs.appendFile(providerConfig.markerPath,JSON.stringify({...binding,nativeTaskId:nativeTask.id,source:'controlled_fixture'})+'\n');
    return {records:[{kind:'controlled_case_boundary',caseId:binding.caseId,model:binding.model,configurationHash:binding.configurationHash}]};
   }},async project({result}){
    if(result.finish.requests!==0 || result.finish.costUsd!==0)throw Error('The control fixture spent provider budget');
    return {...binding,status:providerConfig.rejectRelabel?'passed':'not_run',reason:'controlled_plumbing_only',source:providerConfig.rejectRelabel?'native_receipts':'unavailable',costUsd:0,usage:{inputTokens:0,outputTokens:0},timings:{providerMs:0,operatorMs:0,localMs:0,totalMs:0}};
   }};
  }
 }};
}
`;
        await fs.writeFile(moduleFile, code);
        const configurationHash = campaign.cells.find((cell) => cell.product === "goatcitadel").effectiveConfigSha256;
        const config = {
          markerPath: marker,
          rejectRelabel,
          controlledCampaign: {
            schemaVersion: COMPARISON_VERSION,
            suite: ASSISTANT_PARITY_SUITE,
            products,
            trials: 3,
            maxRequests: 2,
            maxCostUsd: 1,
            transportProfile,
          },
          products: { goatcitadel: { productRef: "a".repeat(40), model: "fixture-text", configurationHash } },
          nativeSessionsModule: { path: moduleFile, sha256: sha256(code) },
        };
        const configFile = path.join(root, "provider.json");
        await fs.writeFile(configFile, JSON.stringify(config));
        let failure;
        try {
          await promisify(execFile)(
            process.execPath,
            [
              "scripts/verification/assistant-parity-proof.mjs",
              "--mode",
              "live",
              "--split",
              "adversarial",
              "--products",
              "goatcitadel",
              "--case-ids",
              rejectRelabel ? "adversarial-01" : "adversarial-01,adversarial-02",
              "--provider-config",
              configFile,
              "--max-cost-usd",
              "1",
              "--output-root",
              report,
            ],
            { cwd: process.cwd(), windowsHide: true, timeout: 100000, maxBuffer: 1024 * 1024 },
          );
        } catch (error) {
          failure = error;
        }
        if (rejectRelabel) assert.ok(failure, "Controlled component evidence must never pass a live native comparison");
        else assert.equal(failure, undefined, failure?.stderr);
        const dispatchedRows = (
          await fs.readFile(marker, "utf8").catch((error) => {
            throw new Error(`The supervised action did not run: ${failure?.stderr ?? failure?.message}`, {
              cause: error,
            });
          })
        )
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.equal(dispatchedRows.length, rejectRelabel ? 1 : 2);
        const dispatched = dispatchedRows[0];
        assert.equal(dispatched.caseId, "adversarial-01");
        assert.equal(dispatched.nativeTaskId, "assistant-adversarial-01");
        assert.equal(dispatched.model, "fixture-text");
        assert.equal(dispatched.configurationHash, configurationHash);
        assert.equal(dispatched.source, "controlled_fixture");
        if (rejectRelabel) assert.match(failure.stderr, /Fixture and native evidence cannot be relabeled/);
        const execution = JSON.parse(
          await fs.readFile(
            path.join(report, "controlled-campaign", "adversarial-01", "evidence", "execution.json"),
            "utf8",
          ),
        );
        assert.equal(execution.source, "controlled_fixture");
        if (!rejectRelabel) {
          const second = JSON.parse(
            await fs.readFile(
              path.join(report, "controlled-campaign", "adversarial-02", "evidence", "execution.json"),
              "utf8",
            ),
          );
          assert.notEqual(execution.cellId, second.cellId);
          const result = JSON.parse(await fs.readFile(path.join(report, "report.json"), "utf8"));
          assert.deepEqual(result.counts.goatcitadel, { passed: 0, failed: 0, not_run: 2 });
          assert.equal(result.productRefs.goatcitadel, "a".repeat(40));
        }
      } finally {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith("gc-parity-cli-"));
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
