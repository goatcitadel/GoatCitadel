import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";
import { ensureOnboardingComplete, runUxBudgetsLane } from "./lib/scenarios.mjs";
import { selectCockpitOwnerProofs } from "./lib/scenarios/ux-budgets-lane.mjs";
import { requestJson, startVerificationStack, stopVerificationStack } from "./lib/runtime.mjs";
import { createRunContext, finalizeRunContext, releaseRunContext, runScenario, repoRoot } from "./lib/shared.mjs";
import { auditPageAccessibility } from "./lib/scenarios/accessibility-smoke-lane.mjs";
import { runCockpitChatComposerProof } from "./lib/scenarios/cockpit-chat-composer-proof.mjs";
import { renderingReplyRules, runCockpitChatRenderingProof } from "./lib/scenarios/cockpit-chat-rendering-proof.mjs";
import { runCockpitChatProjectProof } from "./lib/scenarios/cockpit-chat-project-proof.mjs";
import { prepareUsabilityRuntime } from "./lib/scenarios/usability-runtime-fixture.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import { DETERMINISTIC_LLM_CAPABILITIES, DETERMINISTIC_LLM_KEY_ENV, startDeterministicLlmStub } from "./lib/scenarios/deterministic-llm-stub.mjs";

// This runner acquires the standard output lock and builds its own snapshot.
// Run only after other agents release build/browser checkpoint ownership.
const selected = process.argv.slice(2);
assert.ok(selected.every((argument) => argument === "--with-rendering" || argument.startsWith("--with-owners=")), "Unsupported composer proof argument");
const ownerArguments = selected.filter(argument => argument.startsWith("--with-owners="));
assert.ok(ownerArguments.length <= 1, "Provide at most one owner proof selection");
const ownerSelection = ownerArguments[0]?.slice("--with-owners=".length).split(",");
if (ownerSelection) selectCockpitOwnerProofs(ownerSelection);
const includeRendering = selected.includes("--with-rendering");
const context = await createRunContext("ux-budgets", {
  commandSelection: `${includeRendering ? "cockpit-chat-composer,rendering,projects" : "cockpit-chat-composer"}${ownerSelection ? `;owners:${ownerSelection.join(",")}` : ""}`,
});
let primary, alternate, stack, browser;
try {
  primary = await startDeterministicLlmStub({ replyText: "COMPOSER_PROOF_OK", promptReplyRules: renderingReplyRules(), expectedAuthorization: "Bearer verification-stub-key" });
  alternate = await startDeterministicLlmStub({ providerId: "verification-composer-alternate", model: "verification-composer-alt",
    replyText: "COMPOSER_PROOF_OK", promptReplyRules: renderingReplyRules(), expectedAuthorization: "Bearer verification-stub-key" });
  const runtimeRoot = await prepareUsabilityRuntime(context.runId, primary.baseUrl);
  // Configure only the not-yet-started disposable runtime. Both catalogs and
  // completions are served by owned loopback stubs, with no copied user keys.
  const configPath = path.join(runtimeRoot, "config", "goatcitadel.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.llm.providers.push({ providerId: "verification-composer-alternate", label: "Composer alternate (loopback)",
    baseUrl: alternate.baseUrl, apiStyle: "openai-chat-completions", defaultModel: "verification-composer-alt", apiKeyEnv: DETERMINISTIC_LLM_KEY_ENV,
    capabilities: DETERMINISTIC_LLM_CAPABILITIES });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(runtimeRoot, "config", "llm-providers.json"), `${JSON.stringify(config.llm, null, 2)}\n`);
  const metadataPath = path.join(runtimeRoot, "config", "llm-model-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.entries["verification-composer-alternate/verification-composer-alt"] = {
    contextWindow: 128000, outputTokenLimit: 16000, reasoning: { supportedEfforts: ["none", "low", "medium", "high"] },
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const secretEnvKeys = await collectVerificationSecretEnvKeys(path.join(repoRoot, "config"));
  stack = await startVerificationStack(context, { runtimeRoot, includeUi: true, gatewayMode: "built", uiMode: "preview",
    processLogPrefix: "cockpit-chat-composer", gatewayEnvOmit: secretEnvKeys, uiEnvOmit: secretEnvKeys,
    gatewayEnv: { GOATCITADEL_RATE_LIMIT_ENABLED: "false", [DETERMINISTIC_LLM_KEY_ENV]: "verification-stub-key" } });
  console.log(`Built Gateway/UI snapshot ready: ${context.runId}`);
  await ensureOnboardingComplete(stack.gatewayUrl, "verification-cockpit-composer");
  browser = await chromium.launch({ headless: true });
  const input = { context, browser, stack,
    viewports: [{ variant: "desktop", viewport: { width: 1440, height: 1000 } }, { variant: "mobile", viewport: { width: 390, height: 844 } }],
    deps: { requestJson, runScenario, path, auditPageAccessibility,
      assertOk: (response, label) => assert.ok(response.ok, `${label} returned HTTP ${response.status}`),
      axeSourcePath: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
      buildVerificationUiUrl: (base, route) => new URL(route, base).href,
      relativeToRun: (run, file) => path.relative(run.artifactRoot, file).replaceAll("\\", "/"),
      emptyArtifacts: (overrides = {}) => ({ screenshots: [], traces: [], logs: [], diagnostics: [], perf: [], playwright: [], ...overrides }),
      installMissionControlNextBrowserState: async (browserContext, workspaceId, citadelId) => {
        await browserContext.addInitScript(({ workspaceId, citadelId }) => {
          globalThis.window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", workspaceId);
          globalThis.window.localStorage.setItem("goatcitadel.ui.citadel_id.v1", citadelId);
          globalThis.window.localStorage.setItem("goatcitadel.ui.mode.v1", "simple");
          globalThis.window.localStorage.setItem("goatcitadel.ui.technical_details.v1", "false");
        }, { workspaceId, citadelId });
      },
    } };
  await runCockpitChatComposerProof(input);
  if (includeRendering) {
    await runCockpitChatRenderingProof(input);
    await runCockpitChatProjectProof(input);
  }
  if (ownerSelection) {
    // The standard runtime caches the Gateway build within this process. Every
    // journey below uses that same compiled Gateway snapshot and a fresh runtime.
    await browser.close(); browser = undefined;
    await stopVerificationStack(stack); stack = undefined;
    await runUxBudgetsLane(context, { ownerControlsOnly: true, ownerControlSubset: ownerSelection,
      secretEnvKeys, processLogPrefix: "cockpit-owner-controls" });
  }
  const manifest = await finalizeRunContext(context);
  console.log(`Cockpit Chat composer proof: ${context.artifactRoot}\nStatus: ${manifest.status}`);
  if (manifest.status !== "passed") process.exitCode = 1;
} catch (error) {
  await finalizeRunContext(context, "failed");
  throw error;
} finally {
  await browser?.close();
  if (stack) await stopVerificationStack(stack);
  await alternate?.close();
  await primary?.close();
  await releaseRunContext(context);
}
