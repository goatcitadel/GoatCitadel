import assert from "node:assert/strict";
import { test } from "node:test";

import { runVisualRegressionLane } from "./visual-regression-lane.mjs";

test("visual regression returns failure evidence when a browser assertion throws", async () => {
  const results = [];
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
      startVerificationStack: async () => ({ gatewayUrl: "http://gateway", uiUrl: "http://ui" }),
      async stopVerificationStack() {},
      async waitForVerificationRouteReady() {},
      async writeMissionControlNextManualProofChecklist() {},
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error, /page errors: render crashed/);
  assert.deepEqual(results[0].artifacts.screenshots, ["screenshots/visual-regression-chat-desktop-dark-failure.png"]);
  assert.deepEqual(results[0].artifacts.traces, ["playwright/visual-regression-chat-desktop-dark-trace.zip"]);
});
