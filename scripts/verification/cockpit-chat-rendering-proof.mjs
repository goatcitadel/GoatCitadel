import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";
import { ensureOnboardingComplete } from "./lib/scenarios.mjs";
import { requestJson, startVerificationStack, stopVerificationStack } from "./lib/runtime.mjs";
import { createRunContext, finalizeRunContext, releaseRunContext, runScenario, repoRoot } from "./lib/shared.mjs";
import { auditPageAccessibility } from "./lib/scenarios/accessibility-smoke-lane.mjs";
import { runCockpitChatRenderingProof, renderingReplyRules, RENDER_MARKDOWN } from "./lib/scenarios/cockpit-chat-rendering-proof.mjs";
import { runCockpitChatProjectProof } from "./lib/scenarios/cockpit-chat-project-proof.mjs";
import { emptyBrowserEvidenceArtifacts } from "./lib/scenarios/usability-browser-evidence.mjs";
import { prepareUsabilityRuntime } from "./lib/scenarios/usability-runtime-fixture.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import { DETERMINISTIC_LLM_KEY_ENV, startDeterministicLlmStub } from "./lib/scenarios/deterministic-llm-stub.mjs";

// Uses the standard build lock and a fresh loopback-only fixture. No installed
// provider settings, user runtime files, or external provider keys are used.
const context = await createRunContext("ux-budgets", { commandSelection: "cockpit-chat-rendering-project" });
let stub, stack, browser;
try {
  stub = await startDeterministicLlmStub({ replyText: RENDER_MARKDOWN, promptReplyRules: renderingReplyRules(),
    expectedAuthorization: "Bearer verification-stub-key" });
  const runtimeRoot = await prepareUsabilityRuntime(context.runId, stub.baseUrl);
  const secretEnvKeys = await collectVerificationSecretEnvKeys(path.join(repoRoot, "config"));
  stack = await startVerificationStack(context, { runtimeRoot, includeUi: true, gatewayMode: "built", uiMode: "preview",
    processLogPrefix: "cockpit-chat-rendering", gatewayEnvOmit: secretEnvKeys, uiEnvOmit: secretEnvKeys,
    gatewayEnv: { GOATCITADEL_RATE_LIMIT_ENABLED: "false", [DETERMINISTIC_LLM_KEY_ENV]: "verification-stub-key" } });
  await ensureOnboardingComplete(stack.gatewayUrl, "verification-cockpit-rendering");
  browser = await chromium.launch({ headless: true });
  const input = { context, browser, stack,
    viewports: [{ variant: "desktop", viewport: { width: 1440, height: 1000 } }, { variant: "mobile", viewport: { width: 390, height: 844 } }],
    deps: { requestJson, runScenario, path, auditPageAccessibility,
      assertOk: (response, label) => assert.ok(response.ok, `${label} returned HTTP ${response.status}`),
      axeSourcePath: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
      buildVerificationUiUrl: (base, route) => new URL(route, base).href,
      relativeToRun: (run, file) => path.relative(run.artifactRoot, file).replaceAll("\\", "/"),
      emptyArtifacts: emptyBrowserEvidenceArtifacts,
      installMissionControlNextBrowserState: async (browserContext, workspaceId, citadelId) => {
        await browserContext.addInitScript(({ workspaceId, citadelId }) => {
          globalThis.window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", workspaceId);
          globalThis.window.localStorage.setItem("goatcitadel.ui.citadel_id.v1", citadelId);
          globalThis.window.localStorage.setItem("goatcitadel.ui.mode.v1", "simple");
          globalThis.window.localStorage.setItem("goatcitadel.ui.technical_details.v1", "false");
        }, { workspaceId, citadelId });
      },
    } };
  await runCockpitChatRenderingProof(input);
  await runCockpitChatProjectProof(input);
  const manifest = await finalizeRunContext(context);
  console.log(`Cockpit Chat rendering/project proof: ${context.artifactRoot}\nStatus: ${manifest.status}`);
  if (manifest.status !== "passed") process.exitCode = 1;
} catch (error) {
  await finalizeRunContext(context, "failed");
  throw error;
} finally {
  await browser?.close();
  if (stack) await stopVerificationStack(stack);
  await stub?.close();
  await releaseRunContext(context);
}
