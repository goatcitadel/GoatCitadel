import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertMobileVisualGeometry,
  prepareVisualScenarioState,
  runVisualRegressionLane,
} from "./visual-regression-lane.mjs";

test("composer palette visual state opens through the keyboard contract", async () => {
  const calls = [];
  const visibleTarget = {
    async waitFor(options) {
      calls.push(options);
    },
  };
  await prepareVisualScenarioState(
    {
      keyboard: {
        async press(value) {
          calls.push(value);
        },
      },
      locator(value) {
        calls.push(value);
        return visibleTarget;
      },
      getByRole(role, options) {
        calls.push([role, options]);
        return visibleTarget;
      },
    },
    { visualState: "composer-palette" },
  );

  assert.equal(calls[0], "Control+K");
  assert.equal(calls[1], ".mc-next-command-popover.palette-sheet");
  assert.deepEqual(calls[3], ["searchbox", { name: "Search commands and context" }]);
});

test("mobile pending-input geometry checks overflow and every operator control", async () => {
  let selectors = [];
  const page = {
    async evaluate(_callback, input) {
      selectors = input;
      return {
        viewportWidth: 390,
        documentOverflow: 0,
        bodyOverflow: 0,
        targets: input.map((selector) => ({ selector, missing: false, left: 24, right: 366, width: 342 })),
      };
    },
  };

  await assertMobileVisualGeometry(
    page,
    { slug: "chat-pending-user-input" },
    { slug: "mobile-dark", viewport: { width: 390, height: 844 } },
  );

  assert.deepEqual(selectors, [
    '.mc-next-composer-blocking-prompt[data-blocker-kind="user-input"] .chat-user-input-card',
    ".mc-next-composer-blocked-actions",
    ".mc-next-composer-primary",
  ]);
});

test("mobile visual geometry rejects horizontal document overflow and clipped pending-input controls", async () => {
  await assert.rejects(
    assertMobileVisualGeometry(
      {
        async evaluate() {
          return { viewportWidth: 390, documentOverflow: 24, bodyOverflow: 0, targets: [] };
        },
      },
      { slug: "chat" },
      { slug: "mobile-dark", viewport: { width: 390, height: 844 } },
    ),
    /overflowed horizontally.*document=24/u,
  );

  await assert.rejects(
    assertMobileVisualGeometry(
      {
        async evaluate(_callback, selectors) {
          return {
            viewportWidth: 390,
            documentOverflow: 0,
            bodyOverflow: 0,
            targets: selectors.map((selector, index) => ({
              selector,
              missing: false,
              left: 24,
              right: index === 2 ? 406 : 366,
              width: index === 2 ? 382 : 342,
            })),
          };
        },
      },
      { slug: "chat-pending-user-input" },
      { slug: "mobile-light", viewport: { width: 390, height: 844 } },
    ),
    /clipped \.mc-next-composer-primary horizontally/u,
  );
});

test("visual regression returns failure evidence when a browser assertion throws", async () => {
  const results = [];
  let stackOptions;
  const trace = {
    async retain() {
      return "playwright/visual-regression-chat-desktop-dark-trace.zip";
    },
    async discard() {},
  };
  const page = { async goto() {} };
  const browserContext = {
    async newPage() {
      return page;
    },
    async close() {},
  };
  const browser = {
    async newContext() {
      return browserContext;
    },
    async close() {},
  };
  const route = { slug: "chat", href: "/chat" };
  const variant = { slug: "desktop-dark", viewport: { width: 1440, height: 1024 }, colorScheme: "dark" };

  await runVisualRegressionLane(
    { artifactRoot: "artifacts" },
    {},
    {
      VISUAL_DIFF_RATIO_THRESHOLD: 0.04,
      VISUAL_ROUTE_READY_TIMEOUT_MS: 100,
      appendTraceArtifact: (artifacts, traceArtifact) => ({
        ...artifacts,
        traces: traceArtifact ? [traceArtifact] : [],
        playwright: traceArtifact ? [...artifacts.playwright, traceArtifact] : artifacts.playwright,
      }),
      assertBrowserConsoleHealthy() {
        throw new Error("page errors: render crashed");
      },
      async assertNextVisualScenarioChrome() {},
      async assertNoFooterStatusCollision() {},
      async assertVisualBaselineCoverage() {},
      attachBrowserLogging: () => ({ mark: () => ({ consoleMessages: 0, pageErrors: 0 }) }),
      buildVerificationUiUrl: (base, href) => `${base}${href}`,
      captureBrowserArtifacts: async (_context, input) => ({
        diagnostics: [`diagnostics/${input.slug}.json`],
        screenshots: [`screenshots/${input.slug}.png`],
        traces: [],
        logs: [`playwright/${input.slug}-console.json`],
        perf: [],
        playwright: [`playwright/${input.slug}-console.json`],
      }),
      async captureRouteReadyFailure() {
        throw new Error("route-ready failure was not expected");
      },
      chromium: { launch: async () => browser },
      async compareVisualBaseline() {
        throw new Error("comparison should not run after browser assertion failure");
      },
      async ensureOnboardingComplete() {},
      filterVisualItemsBySlug: (items) => items,
      async installMissionControlNextBrowserState() {},
      maybeParseBool: () => false,
      async pinVisualRegressionProvider() {},
      resolveVerificationTargetContext: () => ({
        isNext: false,
        packageName: "@goatcitadel/mission-control-next",
        visualRoutes: [route],
        visualVariants: [variant],
      }),
      resolveVisualRouteHref: (item) => item.href,
      runScenario: async (_context, _definition, fn) => {
        const result = await fn({ correlationId: "correlation-1" });
        results.push(result);
        return result;
      },
      async seedMissionControlNextFixture() {},
      async setBrowserCorrelation() {},
      async stabilizeVisualRegressionSnapshot() {},
      startBrowserTrace: async () => trace,
      startVerificationStack: async (_context, options) => {
        stackOptions = options;
        return { gatewayUrl: "http://gateway", uiUrl: "http://ui" };
      },
      async stopVerificationStack() {},
      async waitForVerificationRouteReady() {},
      async writeMissionControlNextManualProofChecklist() {},
    },
  );

  assert.equal(results.length, 1);
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_MODE, "token");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_TOKEN, "verification-visual-regression-operator-token");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS, "true");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER, "true");
  assert.notEqual(stackOptions.gatewayEnv.GOATCITADEL_AUTH_MODE, "none");
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error, /page errors: render crashed/);
  assert.deepEqual(results[0].artifacts.screenshots, ["screenshots/visual-regression-chat-desktop-dark-failure.png"]);
  assert.deepEqual(results[0].artifacts.traces, ["playwright/visual-regression-chat-desktop-dark-trace.zip"]);
});
