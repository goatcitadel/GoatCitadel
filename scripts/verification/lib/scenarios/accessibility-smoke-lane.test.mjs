import assert from "node:assert/strict";
import { test } from "node:test";

import { runAccessibilitySmokeLane } from "./accessibility-smoke-lane.mjs";

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

  await runAccessibilitySmokeLane(
    { artifactRoot: "artifacts" },
    {
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
      startVerificationStack: async () => ({ gatewayUrl: "http://gateway", uiUrl: "http://ui" }),
      async stopVerificationStack() {},
      async waitForVerificationRouteReady() {},
      async writeJson() {},
    },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error, /button-name \(serious, 1 node\)/);
  assert.deepEqual(results[0].artifacts.screenshots, ["screenshots/accessibility-smoke-chat.png"]);
  assert.deepEqual(results[0].artifacts.traces, ["playwright/accessibility-smoke-chat-trace.zip"]);
  assert.ok(results[0].artifacts.diagnostics.includes("diagnostics/accessibility-smoke-chat-accessibility.json"));
  assert.equal(restored, true);
});
