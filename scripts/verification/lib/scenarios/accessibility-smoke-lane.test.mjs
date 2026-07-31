import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertVirtualKeyboardComposerVisible,
  buildCrossCuttingAccessibilityReport,
  isUndersizedTouchTarget,
  runAccessibilitySmokeLane,
} from "./accessibility-smoke-lane.mjs";

const healthyCrossCuttingMeasurements = {
  viewportWidth: 1440,
  viewportHeight: 1024,
  horizontalOverflowPx: 0,
  semanticMainCount: 1,
  headingCount: 1,
  liveRegionCount: 1,
  liveRegions: [{ role: "status", politeness: "polite", name: "Chat ready" }],
  screenReaderSignalCount: 1,
  reducedMotionMatches: false,
  unexpectedMotion: [],
  touchTargets: [],
  regionLandmarkNames: ["Chat activity"],
};

test("virtual-keyboard geometry keeps the focused composer inside the effective viewport", () => {
  assert.doesNotThrow(() =>
    assertVirtualKeyboardComposerVisible({
      activeLabel: "Message composer",
      providerReplyVisible: true,
      viewportWidth: 390,
      viewportHeight: 500,
      composerRect: { top: 420, right: 382, bottom: 492, left: 8, width: 374, height: 72 },
    }),
  );
  assert.throws(
    () =>
      assertVirtualKeyboardComposerVisible({
        activeLabel: "Message composer",
        providerReplyVisible: true,
        viewportWidth: 390,
        viewportHeight: 500,
        composerRect: { top: 470, right: 382, bottom: 542, left: 8, width: 374, height: 72 },
      }),
    /obscured the composer/u,
  );
  assert.throws(
    () =>
      assertVirtualKeyboardComposerVisible({
        activeLabel: "Send",
        providerReplyVisible: true,
        viewportWidth: 390,
        viewportHeight: 500,
        composerRect: { top: 420, right: 382, bottom: 492, left: 8, width: 374, height: 72 },
      }),
    /lost composer focus/u,
  );
  assert.throws(
    () =>
      assertVirtualKeyboardComposerVisible({
        activeLabel: "Message composer",
        providerReplyVisible: false,
        viewportWidth: 390,
        viewportHeight: 500,
        composerRect: { top: 420, right: 382, bottom: 492, left: 8, width: 374, height: 72 },
      }),
    /deterministic provider-backed turn/u,
  );
});

test("touch targets fail when width alone is below 24px", () => {
  assert.equal(isUndersizedTouchTarget({ visible: true, width: 23, height: 32 }), true);
  const report = buildCrossCuttingAccessibilityReport(
    {
      ...healthyCrossCuttingMeasurements,
      touchTargets: [{ name: "Narrow action", visible: true, width: 23, height: 32 }],
    },
    { expectTouchTargets: true },
  );
  assert.equal(report.passed, false);
  assert.match(report.failures.join("; "), /smaller than 24px in width or height/);
});

test("touch targets fail when height alone is below 24px", () => {
  assert.equal(isUndersizedTouchTarget({ visible: true, width: 32, height: 23 }), true);
  const report = buildCrossCuttingAccessibilityReport(
    {
      ...healthyCrossCuttingMeasurements,
      touchTargets: [{ name: "Short action", visible: true, width: 32, height: 23 }],
    },
    { expectTouchTargets: true },
  );
  assert.equal(report.passed, false);
  assert.equal(report.undersizedTouchTargets[0].name, "Short action");
});

test("touch targets fail for fractional dimensions below 24px", () => {
  assert.equal(isUndersizedTouchTarget({ visible: true, width: 23.99, height: 24 }), true);
  assert.equal(isUndersizedTouchTarget({ visible: true, width: 24, height: 23.5 }), true);
  assert.equal(isUndersizedTouchTarget({ visible: true, width: 24, height: 24 }), false);
});

test("page-level region landmark names must be unique", () => {
  const report = buildCrossCuttingAccessibilityReport({
    ...healthyCrossCuttingMeasurements,
    regionLandmarkNames: ["Permission profile grants", " permission   profile grants ", "Override history"],
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.duplicateRegionLandmarkNames, [{ name: "Permission profile grants", count: 2 }]);
  assert.match(report.failures.join("; "), /region landmark names must be unique/);
});

test("screen-reader spot checks require an operator-readable live announcement", () => {
  const report = buildCrossCuttingAccessibilityReport({
    ...healthyCrossCuttingMeasurements,
    liveRegions: [{ role: "status", politeness: "polite", name: "" }],
    screenReaderSignalCount: 0,
  });
  assert.equal(report.passed, false);
  assert.match(report.failures.join("; "), /operator-readable announcement/u);
});

test("accessibility smoke retains browser evidence and a failure-only trace for blocking axe violations", async () => {
  const results = [];
  const trace = {
    async retain() {
      return "playwright/accessibility-smoke-chat-trace.zip";
    },
    async discard() {},
  };
  const page = {
    async addScriptTag() {},
    async evaluate() {
      return healthyCrossCuttingMeasurements;
    },
    async goto() {},
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
  let restored = false;
  let stackOptions;

  await runAccessibilitySmokeLane(
    { artifactRoot: "artifacts" },
    {
      secretEnvKeys: ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"],
      scenarios: [
        {
          id: "chat",
          title: "Chat accessibility",
          href: "/chat",
          viewport: { width: 1440, height: 1024 },
          route: { expectedArea: "chat", expectedSection: "root" },
        },
      ],
    },
    {
      NEXT_UI_PACKAGE: "@goatcitadel/mission-control-next",
      appendTraceArtifact: (artifacts, traceArtifact) => ({
        ...artifacts,
        traces: traceArtifact ? [traceArtifact] : [],
        playwright: traceArtifact ? [...artifacts.playwright, traceArtifact] : artifacts.playwright,
      }),
      assertBrowserConsoleHealthy: () => ({ consoleErrors: [], pageErrors: [] }),
      attachBrowserLogging: () => ({ mark: () => ({}), getSnapshot: () => ({}) }),
      auditPageAccessibility: async () => ({
        violations: [{ id: "button-name", impact: "serious", nodes: [{ target: ["button"] }] }],
      }),
      axeSourcePath: "node_modules/axe-core/axe.min.js",
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
      forceVerificationUiPackage: () => () => {
        restored = true;
      },
      async installMissionControlNextBrowserState() {},
      path: { join: (...parts) => parts.join("/") },
      async prepareVerificationRuntime() {
        return "runtime-root";
      },
      probeKeyboardFocus: async () => ({
        passed: true,
        observations: [{ name: "Chat", hasVisibleIndicator: true }],
        unnamedTargets: [],
        focusIndicatorFound: true,
      }),
      relativeToRun: (_context, value) => value.replace("artifacts/", ""),
      runScenario: async (_context, _definition, fn) => {
        const result = await fn({ correlationId: "correlation-1" });
        results.push(result);
        return result;
      },
      seedMissionControlNextFixture: async () => ({
        workspaceId: "workspace-1",
        citadelId: "personal",
        sessionId: "session-1",
      }),
      async setBrowserCorrelation() {},
      startBrowserTrace: async () => trace,
      async startDeterministicLlmStub(options) {
        assert.equal(options.replyText, "KEYBOARD_OK");
        assert.equal(options.expectedAuthorization, "Bearer verification-accessibility-smoke-stub-key");
        return { baseUrl: "http://stub/v1", async close() {} };
      },
      startVerificationStack: async (_context, options) => {
        stackOptions = options;
        return { gatewayUrl: "http://gateway", uiUrl: "http://ui" };
      },
      async stopVerificationStack() {},
      async waitForVerificationRouteReady() {},
      async writeDeterministicLlmProviderConfig(runtimeRoot, baseUrl) {
        assert.equal(runtimeRoot, "runtime-root");
        assert.equal(baseUrl, "http://stub/v1");
      },
      async writeJson() {},
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error, /button-name \(serious, 1 node\)/);
  assert.deepEqual(results[0].artifacts.screenshots, ["screenshots/accessibility-smoke-chat.png"]);
  assert.deepEqual(results[0].artifacts.traces, ["playwright/accessibility-smoke-chat-trace.zip"]);
  assert.ok(results[0].artifacts.diagnostics.includes("diagnostics/accessibility-smoke-chat-accessibility.json"));
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_MODE, "token");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_TOKEN, "verification-accessibility-smoke-operator-token");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS, "true");
  assert.equal(stackOptions.gatewayEnv.GOATCITADEL_VERIFY_STUB_LLM_KEY, "verification-accessibility-smoke-stub-key");
  assert.deepEqual(stackOptions.gatewayEnvOmit, ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"]);
  assert.deepEqual(stackOptions.uiEnvOmit, ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"]);
  assert.equal(stackOptions.runtimeRoot, "runtime-root");
  assert.equal(restored, true);
});
