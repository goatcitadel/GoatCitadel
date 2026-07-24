import assert from "node:assert/strict";
import { test } from "node:test";

import { navigateSurfaceRoute, runSurfaceRegressionLane } from "./surface-regression-lane.mjs";

test("first surface navigation retries once after a bounded cold-start readiness timeout", async () => {
  let gotoCalls = 0;
  let readinessCalls = 0;
  const timeoutError = () => Object.assign(new Error("page.goto: Timeout 30000ms exceeded."), { name: "TimeoutError" });
  const page = {
    async goto() {
      gotoCalls += 1;
      if (gotoCalls === 1) {
        throw timeoutError();
      }
    },
    async waitForLoadState() {
      readinessCalls += 1;
      throw timeoutError();
    },
  };

  const evidence = await navigateSurfaceRoute(page, "http://ui/chat", {
    allowInitialColdStartRecovery: true,
  });

  assert.equal(gotoCalls, 2);
  assert.equal(readinessCalls, 1);
  assert.deepEqual(evidence, {
    attempts: 2,
    recoveryReason: "initial_navigation_timeout",
    recoveryDisposition: "retried",
  });
});

test("later surface navigation failures remain single-attempt failures", async () => {
  let gotoCalls = 0;
  const timeoutError = Object.assign(new Error("page.goto: Timeout 30000ms exceeded."), {
    name: "TimeoutError",
  });
  const page = {
    async goto() {
      gotoCalls += 1;
      throw timeoutError;
    },
  };

  await assert.rejects(navigateSurfaceRoute(page, "http://ui/projects"), (error) => {
    assert.deepEqual(error.navigationEvidence, {
      attempts: 1,
      recoveryReason: null,
      recoveryDisposition: "failed_without_retry",
    });
    return true;
  });
  assert.equal(gotoCalls, 1);
});

test("surface regression returns failure evidence when a browser assertion throws", async () => {
  const results = [];
  let stackOptions;
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
      startVerificationStack: async (_context, options) => {
        stackOptions = options;
        return { gatewayUrl: "http://gateway", uiUrl: "http://ui" };
      },
      async stopVerificationStack() {},
      async waitForMissionControlShell() {},
      async waitForVerificationRouteReady() {},
    },
  );

  assert.equal(results.length, 1);
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_MODE, "token");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_TOKEN, "verification-surface-regression-operator-token");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS, "true");
  assert.notEqual(stackOptions.gatewayEnv.GOATCITADEL_AUTH_MODE, "none");
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error, /console errors: route crashed/);
  assert.deepEqual(results[0].metrics, {
    route: "/chat",
    navigationAttempts: 1,
    navigationRecoveryReason: null,
    navigationRecoveryDisposition: "not_needed",
  });
  assert.deepEqual(results[0].artifacts.screenshots, ["screenshots/surface-regression-chat-failure.png"]);
  assert.deepEqual(results[0].artifacts.traces, ["playwright/surface-regression-chat-trace.zip"]);
  assert.deepEqual(results[0].artifacts.logs, ["playwright/surface-regression-chat-failure-console.json"]);
});
