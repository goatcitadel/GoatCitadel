import { prepareUsabilityRuntime } from "./usability-runtime-fixture.mjs";
import { selectCockpitOwnerProofs } from "./ux-budget-owner-proofs.mjs";
import { CHAT_VIEWPORTS, UX_BUDGET_ENFORCEMENT_DEFAULTS } from "./ux-budget-measurements.mjs";
import { createUxBudgetBrowserFixtures } from "./ux-budget-browser-fixtures.mjs";
import { runUxBudgetRoutes } from "./ux-budget-routes.mjs";
import { runUxBudgetInboxProposals } from "./ux-budget-inbox-proposals.mjs";
import { runUxBudgetInboxChanges } from "./ux-budget-inbox-changes.mjs";
import { runUxBudgetInboxWaits } from "./ux-budget-inbox-waits.mjs";
import { runUxBudgetChat } from "./ux-budget-chat.mjs";
import { runUxBudgetOwnerExtensions } from "./ux-budget-owner-extensions.mjs";
import { runUxBudgetWork } from "./ux-budget-work.mjs";
import { runUxBudgetBoards } from "./ux-budget-boards.mjs";
import { runCockpitWorkArtifactProof } from "./cockpit-work-artifact-proof.mjs";
import { runCockpitLibraryLinkProof } from "./cockpit-library-link-proof.mjs";
import { runCockpitWorkContextProof } from "./cockpit-work-context-proof.mjs";
export { selectCockpitOwnerProofs } from "./ux-budget-owner-proofs.mjs";
export { UX_BUDGET_ROUTE_SLUGS, COCKPIT_ROUTES, UX_BUDGET_ENFORCEMENT_DEFAULTS } from "./ux-budget-measurements.mjs";

const STUB_KEY = "verification-ux-budgets-stub-key";

export async function runUxBudgetsLane(context, options = {}, deps) {
  const {
    NEXT_UI_PACKAGE,
    chromium,
    ensureOnboardingComplete,
    forceVerificationUiPackage,
    seedMissionControlNextFixture,
    startDeterministicLlmStub,
    startVerificationStack,
    stopVerificationStack,
  } = deps;
  const enforcement = { ...UX_BUDGET_ENFORCEMENT_DEFAULTS, ...options.enforce };
  const restoreUiPackage = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  let stack;
  let runtimeRoot;
  let stub;
  let browser;
  try {
    stub = await startDeterministicLlmStub({
      replyText: "UX_BUDGET_OK",
      expectedAuthorization: `Bearer ${STUB_KEY}`,
    });
    runtimeRoot = await (options.prepareCleanRuntime ?? prepareUsabilityRuntime)(
      `${context.runId}-ux-budgets`,
      stub.baseUrl,
    );
    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: true,
      gatewayMode: "built",
      uiMode: "preview",
      processLogPrefix: options.processLogPrefix,
      gatewayEnvOmit: options.secretEnvKeys,
      uiEnvOmit: options.secretEnvKeys,
      gatewayEnv: {
        GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
        GOATCITADEL_AUTH_MODE: "token",
        GOATCITADEL_AUTH_TOKEN: "verification-ux-budgets-operator-token",
        GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
        GOATCITADEL_VERIFY_STUB_LLM_KEY: STUB_KEY,
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-ux-budgets");
    const fixture = await seedMissionControlNextFixture(stack.gatewayUrl, { runtimeRoot: stack.runtimeRoot });
    browser = await chromium.launch({ headless: true });

    if (options.ownerControlsOnly) {
      const proof = {
        context,
        browser,
        stack,
        workspaceId: fixture.workspaceId,
        citadelId: fixture.citadelId,
        viewports: CHAT_VIEWPORTS,
        deps,
        providerStub: stub,
      };
      for (const runProof of selectCockpitOwnerProofs(options.ownerControlSubset)) await runProof(proof);
      return;
    }
    if (options.workArtifactOnly) {
      await runCockpitWorkArtifactProof({
        context,
        browser,
        stack,
        citadelId: fixture.citadelId,
        viewports: CHAT_VIEWPORTS,
        deps,
      });
      return;
    }
    if (options.libraryLinksOnly) {
      await runCockpitLibraryLinkProof({
        context,
        browser,
        stack,
        citadelId: fixture.citadelId,
        viewports: CHAT_VIEWPORTS,
        deps,
      });
      return;
    }
    if (options.workContextOnly) {
      await runCockpitWorkContextProof({
        context,
        browser,
        stack,
        citadelId: fixture.citadelId,
        viewports: CHAT_VIEWPORTS,
        deps,
      });
      return;
    }

    const environment = {
      context,
      options,
      enforcement,
      browser,
      stack,
      fixture,
      stub,
      deps,
      ...createUxBudgetBrowserFixtures({ browser, stack, fixture, deps }),
    };
    await runUxBudgetRoutes(environment);
    await runUxBudgetInboxProposals(environment);
    await runUxBudgetInboxChanges(environment);
    await runUxBudgetInboxWaits(environment);
    await runUxBudgetChat(environment);
    await runUxBudgetOwnerExtensions(environment);
    await runUxBudgetWork(environment);
    await runUxBudgetBoards(environment);
  } finally {
    await browser?.close();
    if (stack || runtimeRoot) await stopVerificationStack(stack ?? { runtimeRoot });
    await stub?.close();
    restoreUiPackage();
  }
}
