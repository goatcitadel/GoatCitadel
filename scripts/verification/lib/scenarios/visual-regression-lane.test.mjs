import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertMobileBlockingActionsReachable,
  assertMobileVisualGeometry,
  assertVisualTraceRetentionProbeScope,
  collectVisualBrowserConsoleEvidence,
  createVisualCodeModeReadiness,
  installVisualCodeModeReadinessFixture,
  isCodeModeCardVisualState,
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
      async prepareCleanRuntime(_runId, baseUrl) {
        assert.ok(baseUrl.startsWith("http://"));
        return "runtime-root";
      },
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
      async startDeterministicLlmStub() {
        return {
          providerId: "verification-stub",
          baseUrl: "http://127.0.0.1:4321/v1",
          async close() {},
        };
      },
      startVerificationStack: async () => ({ gatewayUrl: "http://gateway", uiUrl: "http://ui" }),
      async stopVerificationStack() {},
      async waitForVerificationRouteReady() {},
      async writeDeterministicLlmProviderConfig() {},
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

test("Code Mode card states wait on the card's own control", async () => {
  for (const [visualState, name] of [
    ["code-mode-pending", "Run it"],
    ["code-mode-enable", "Turn on Code Mode and run"],
    ["code-mode-done", "Keep as a tool"],
  ]) {
    const calls = [];
    const page = {
      locator(selector) {
        calls.push(selector);
        return {
          getByRole(role, options) {
            calls.push([role, options]);
            return {
              async waitFor(options) {
                calls.push(options);
              },
            };
          },
        };
      },
    };
    await prepareVisualScenarioState(page, { visualState });
    assert.deepEqual(calls, [
      '[role="group"][aria-label="Code Mode request"]',
      ["button", { name, exact: true }],
      { state: "visible", timeout: 15000 },
    ]);
  }
});

test("Code Mode readiness is pinned only for the pending and Code-Mode-off captures", () => {
  assert.deepEqual(createVisualCodeModeReadiness("code-mode-pending"), {
    enabled: true,
    sandboxEnabled: true,
    sandboxSupported: true,
    canRun: true,
  });
  assert.equal(createVisualCodeModeReadiness("code-mode-enable").reason, "code_mode_off");
  assert.equal(createVisualCodeModeReadiness("code-mode-enable").canRun, false);
  assert.equal(createVisualCodeModeReadiness("code-mode-done"), null);
  assert.equal(createVisualCodeModeReadiness("composer-palette"), null);
  assert.equal(createVisualCodeModeReadiness(undefined), null);
  assert.equal(isCodeModeCardVisualState("code-mode-done"), true);
  assert.equal(isCodeModeCardVisualState("toString"), false);
});

function codeModeReadinessRoute({ method = "GET", ok = true, body }) {
  const calls = [];
  return {
    calls,
    route: {
      request: () => ({ method: () => method }),
      async continue() {
        calls.push("continue");
      },
      async fetch() {
        calls.push("fetch");
        return { ok: () => ok, json: async () => body };
      },
      async fulfill(options) {
        calls.push(["fulfill", options.json]);
      },
    },
  };
}

test("Code Mode readiness fixture keeps the Gateway's answer outside the pinned states", async () => {
  let handler;
  const fixture = await installVisualCodeModeReadinessFixture({
    async route(pattern, callback) {
      assert.equal(pattern, "**/api/v1/code-mode/readiness");
      handler = callback;
    },
  });
  const gateway = {
    enabled: true,
    sandboxEnabled: false,
    sandboxSupported: false,
    canRun: false,
    reason: "sandbox_off",
  };

  const untouched = codeModeReadinessRoute({ body: gateway });
  await handler(untouched.route);
  assert.deepEqual(untouched.calls, ["continue"]);

  fixture.setVisualState("code-mode-enable");
  const pinned = codeModeReadinessRoute({ body: gateway });
  await handler(pinned.route);
  assert.deepEqual(pinned.calls, ["fetch", ["fulfill", createVisualCodeModeReadiness("code-mode-enable")]]);

  const enveloped = codeModeReadinessRoute({ body: { success: true, data: gateway } });
  await handler(enveloped.route);
  assert.deepEqual(enveloped.calls[1], [
    "fulfill",
    { success: true, data: createVisualCodeModeReadiness("code-mode-enable") },
  ]);

  const failed = codeModeReadinessRoute({ ok: false, body: { error: "unavailable" } });
  await handler(failed.route);
  assert.deepEqual(failed.calls, ["fetch", ["fulfill", undefined]]);

  const write = codeModeReadinessRoute({ method: "POST", body: gateway });
  await handler(write.route);
  assert.deepEqual(write.calls, ["continue"]);

  fixture.setVisualState("code-mode-done");
  const done = codeModeReadinessRoute({ body: gateway });
  await handler(done.route);
  assert.deepEqual(done.calls, ["continue"]);
});

test("mobile Code Mode decisions must both be reachable", async () => {
  const selectors = [];
  const page = {
    locator(selector) {
      selectors.push(selector);
      return { count: async () => 1 };
    },
  };
  await assert.rejects(
    assertMobileBlockingActionsReachable(
      page,
      { slug: "cockpit-chat-code-mode-card-enable", visualState: "code-mode-enable" },
      { slug: "mobile-light", viewport: { width: 390, height: 844 } },
    ),
    /did not render blocking decision buttons/,
  );
  assert.deepEqual(selectors, [
    '[role="group"][aria-label="Code Mode request"] [role="group"][aria-label="Approval decisions"] button',
  ]);
  await assertMobileBlockingActionsReachable(
    page,
    { slug: "cockpit-chat-code-mode-card-done", visualState: "code-mode-done" },
    { slug: "mobile-light", viewport: { width: 390, height: 844 } },
  );
  assert.equal(selectors.length, 1, "the done state has no decision to reach");
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
    '.mc-next-thread-blocking-prompt[data-blocker-kind="user-input"] .chat-user-input-card',
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
              right: index === 1 ? 406 : 366,
              width: index === 1 ? 382 : 342,
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

test("mobile visual geometry rejects section tabs stretched away from the topbar", async () => {
  await assert.rejects(
    assertMobileVisualGeometry(
      {
        async evaluate() {
          return { viewportWidth: 390, documentOverflow: 0, bodyOverflow: 0, sectionTabsGap: 130, targets: [] };
        },
      },
      { slug: "settings-hooks" },
      { slug: "mobile-dark", viewport: { width: 390, height: 844 } },
    ),
    /placed section tabs away from the topbar.*gap=130/u,
  );
});

test("visual regression returns failure evidence when a browser assertion throws", async () => {
  const results = [];
  let stackOptions;
  let pinnedProviderId;
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
      async pinVisualRegressionProvider(_gatewayUrl, providerId) {
        pinnedProviderId = providerId;
      },
      async prepareCleanRuntime(_runId, baseUrl) {
        assert.ok(baseUrl.startsWith("http://"));
        return "runtime-root";
      },
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
      async startDeterministicLlmStub() {
        return {
          providerId: "verification-stub",
          baseUrl: "http://127.0.0.1:4321/v1",
          async close() {},
        };
      },
      startVerificationStack: async (_context, options) => {
        stackOptions = options;
        return { gatewayUrl: "http://gateway", uiUrl: "http://ui" };
      },
      async stopVerificationStack() {},
      async waitForVerificationRouteReady() {},
      async writeDeterministicLlmProviderConfig() {},
      async writeMissionControlNextManualProofChecklist() {},
    },
  );

  assert.equal(results.length, 1);
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_MODE, "token");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_TOKEN, "verification-visual-regression-operator-token");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS, "true");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER, "true");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_VERIFY_STUB_LLM_KEY, "verification-visual-regression-stub-key");
  assert.equal(stackOptions.gatewayEnv.OPENAI_API_KEY, undefined);
  assert.equal(pinnedProviderId, "verification-stub");
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
