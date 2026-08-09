import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertMobileVisualGeometry,
  assertVisualTraceRetentionProbeScope,
  collectVisualBrowserConsoleEvidence,
  parseVisualTraceRetentionProbe,
  prepareVisualScenarioState,
  runVisualRegressionLane,
} from "./visual-regression-lane.mjs";

test("visual trace-retention probe is bounded to one update-disabled scenario", () => {
  assert.doesNotThrow(() =>
    assertVisualTraceRetentionProbeScope({
      enabled: true,
      updateBaselines: false,
      routeCount: 1,
      variantCount: 1,
    }),
  );
  assert.throws(
    () =>
      assertVisualTraceRetentionProbeScope({
        enabled: true,
        updateBaselines: true,
        routeCount: 1,
        variantCount: 1,
      }),
    /cannot run while updating baselines/u,
  );
  assert.throws(
    () =>
      assertVisualTraceRetentionProbeScope({
        enabled: true,
        updateBaselines: false,
        routeCount: 2,
        variantCount: 1,
      }),
    /requires exactly one filtered route and one filtered variant/u,
  );
});

test("visual trace-retention probe rejects malformed boolean input", () => {
  assert.equal(parseVisualTraceRetentionProbe(undefined), false);
  assert.equal(parseVisualTraceRetentionProbe(true), true);
  assert.equal(parseVisualTraceRetentionProbe("OFF"), false);
  assert.equal(parseVisualTraceRetentionProbe(" yes "), true);
  assert.throws(() => parseVisualTraceRetentionProbe(""), /must be an explicit true\/false boolean/u);
  assert.throws(() => parseVisualTraceRetentionProbe("tru"), /must be an explicit true\/false boolean/u);
});

test("visual trace-retention probe forces one successful comparison to retain failure evidence", async () => {
  const results = [];
  let retainCount = 0;
  const route = { slug: "chat", href: "/chat" };
  const variant = { slug: "desktop-dark", viewport: { width: 1440, height: 1024 }, colorScheme: "dark" };
  const trace = {
    async retain() {
      retainCount += 1;
      return "playwright/visual-regression-chat-desktop-dark-trace.zip";
    },
    async discard() {},
  };
  const page = {
    async goto() {},
    async evaluate() {},
    async waitForTimeout() {},
  };
  const browserContext = {
    async newPage() {
      return page;
    },
    async close() {},
  };

  await runVisualRegressionLane(
    { artifactRoot: "artifacts" },
    { traceRetentionProbe: "true" },
    {
      VISUAL_DIFF_RATIO_THRESHOLD: 0.04,
      VISUAL_ROUTE_READY_TIMEOUT_MS: 100,
      appendTraceArtifact: (artifacts, traceArtifact) => ({
        ...artifacts,
        traces: traceArtifact ? [traceArtifact] : [],
        playwright: traceArtifact ? [...artifacts.playwright, traceArtifact] : artifacts.playwright,
      }),
      assertBrowserConsoleHealthy: () => ({ consoleErrors: [], pageErrors: [] }),
      async assertNextVisualScenarioChrome() {},
      async assertNoFooterStatusCollision() {},
      async assertVisualBaselineCoverage() {},
      attachBrowserLogging: () => ({
        mark: () => ({ consoleMessages: 0, pageErrors: 0 }),
        getSnapshot: () => ({ consoleMessages: [], pageErrors: [] }),
      }),
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
      chromium: {
        launch: async () => ({
          async newContext() {
            return browserContext;
          },
          async close() {},
        }),
      },
      async compareVisualBaseline() {
        return { diffRatio: 0, changedPixels: 0, screenshots: [], diagnostics: [] };
      },
      async ensureOnboardingComplete() {},
      filterVisualItemsBySlug: (items) => items,
      filterExpectedBrowserConsoleMessages: (snapshot, _steps, options) => ({
        snapshot,
        acknowledgedSseRecoveryCount: options.sseRecovery?.acknowledged ? 1 : 0,
      }),
      async installMissionControlNextBrowserState() {},
      maybeParseBool: () => false,
      async pinVisualRegressionProvider() {},
      pollSseConnectionRecoveryEvidence: async (input) => ({
        snapshot: input.snapshot,
        clientSseDiagnostics: input.clientSseDiagnostics,
        recovery: { acknowledged: false },
        pollCount: 0,
      }),
      async readBrowserSseDiagnostics() {
        return { available: false, records: [] };
      },
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
  assert.equal(results[0].metrics.traceRetentionProbe, true);
  assert.match(results[0].error, /forced a controlled failure/u);
  assert.deepEqual(results[0].artifacts.traces, ["playwright/visual-regression-chat-desktop-dark-trace.zip"]);
  assert.equal(retainCount, 1);
});

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
    { secretEnvKeys: ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"] },
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
      attachBrowserLogging: () => ({
        mark: () => ({ consoleMessages: 0, pageErrors: 0 }),
        getSnapshot: () => ({ consoleMessages: [], pageErrors: [] }),
      }),
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
      filterExpectedBrowserConsoleMessages: (snapshot, _steps, options) => ({
        snapshot,
        acknowledgedSseRecoveryCount: options.sseRecovery?.acknowledged ? 1 : 0,
      }),
      async installMissionControlNextBrowserState() {},
      maybeParseBool: () => false,
      async pinVisualRegressionProvider() {},
      pollSseConnectionRecoveryEvidence: async (input) => ({
        snapshot: input.snapshot,
        clientSseDiagnostics: input.clientSseDiagnostics,
        recovery: { acknowledged: false },
        pollCount: 0,
      }),
      async readBrowserSseDiagnostics() {
        return { available: false, records: [] };
      },
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
  assert.equal(stackOptions.gatewayEnv.OPENAI_API_KEY, "sk-visual-regression");
  assert.deepEqual(stackOptions.gatewayEnvOmit, ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"]);
  assert.deepEqual(stackOptions.uiEnvOmit, ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"]);
  assert.notEqual(stackOptions.gatewayEnv.GOATCITADEL_AUTH_MODE, "none");
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error, /page errors: render crashed/);
  assert.deepEqual(results[0].artifacts.screenshots, ["screenshots/visual-regression-chat-desktop-dark-failure.png"]);
  assert.deepEqual(results[0].artifacts.traces, ["playwright/visual-regression-chat-desktop-dark-trace.zip"]);
});

test("visual console validation reuses acknowledged event-stream recovery evidence", async () => {
  const snapshot = {
    consoleMessages: [{ type: "error", text: "net::ERR_CONNECTION_FAILED" }],
    pageErrors: [],
    eventStreamRequestFailures: [],
    eventStreamResponses: [],
  };
  let assertedSnapshot;
  const result = await collectVisualBrowserConsoleEvidence({
    page: {},
    browserLogCursor: {},
    packageName: "@goatcitadel/mission-control-next",
    browserLog: { getSnapshot: () => snapshot },
    deps: {
      async readBrowserSseDiagnostics() {
        return { available: true, records: [] };
      },
      async pollSseConnectionRecoveryEvidence(input) {
        return {
          snapshot: input.snapshot,
          clientSseDiagnostics: input.clientSseDiagnostics,
          recovery: { acknowledged: true, recoveryMs: 1500 },
          pollCount: 1,
        };
      },
      filterExpectedBrowserConsoleMessages(input, _steps, options) {
        assert.equal(options.sseRecovery.acknowledged, true);
        return {
          snapshot: { ...input, consoleMessages: [] },
          acknowledgedSseRecoveryCount: 1,
        };
      },
      assertBrowserConsoleHealthy(log) {
        assertedSnapshot = log.getSnapshot();
        return { consoleErrors: [], pageErrors: [] };
      },
    },
  });

  assert.deepEqual(assertedSnapshot.consoleMessages, []);
  assert.equal(result.filteredConsole.acknowledgedSseRecoveryCount, 1);
  assert.equal(result.recoveryEvidence.recovery.recoveryMs, 1500);
});
