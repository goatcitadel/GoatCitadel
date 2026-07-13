import assert from "node:assert/strict";
import { test } from "node:test";

import { runSurfaceRegressionLane } from "./surface-regression-lane.mjs";

test("surface regression returns failure evidence when a browser assertion throws", async () => {
  const results = [];
  const trace = {
    async retain() {
      return "playwright/surface-regression-chat-trace.zip";
    },
    async discard() {},
  };
  const page = {
    async goto() {},
    async waitForTimeout() {},
  };
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
  const route = {
    slug: "chat",
    href: "/chat",
    interaction: "open-inspector",
  };

  await runSurfaceRegressionLane(
    { artifactRoot: "artifacts" },
    {},
    {
      appendTraceArtifact: (artifacts, traceArtifact) => ({
        ...artifacts,
        traces: traceArtifact ? [traceArtifact] : [],
        playwright: traceArtifact ? [...artifacts.playwright, traceArtifact] : artifacts.playwright,
      }),
      assertBrowserConsoleHealthy() {
        throw new Error("console errors: route crashed");
      },
      async assertLegacyRedirectResolution() {},
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
      chromium: { launch: async () => browser },
      async ensureOnboardingComplete() {},
      async installMissionControlNextBrowserState() {},
      async performVerificationInteraction() {},
      resolveVerificationTargetContext: () => ({
        isNext: false,
        packageName: "@goatcitadel/mission-control-next",
        surfaceRoutes: [route],
        redirectRoutes: [],
        routeByHref: new Map([[route.href, route]]),
      }),
      async runMissionControlNextMobileShellProof() {},
      runScenario: async (_context, _definition, fn) => {
        const result = await fn({ correlationId: "correlation-1" });
        results.push(result);
        return result;
      },
      async seedMissionControlNextFixture() {},
      async setBrowserCorrelation() {},
      startBrowserTrace: async () => trace,
      startVerificationStack: async () => ({ gatewayUrl: "http://gateway", uiUrl: "http://ui" }),
      async stopVerificationStack() {},
      async waitForMissionControlShell() {},
      async waitForVerificationRouteReady() {},
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error, /console errors: route crashed/);
  assert.deepEqual(results[0].artifacts.screenshots, ["screenshots/surface-regression-chat-failure.png"]);
  assert.deepEqual(results[0].artifacts.traces, ["playwright/surface-regression-chat-trace.zip"]);
  assert.deepEqual(results[0].artifacts.logs, ["playwright/surface-regression-chat-failure-console.json"]);
});
