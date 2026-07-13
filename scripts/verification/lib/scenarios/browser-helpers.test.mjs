import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendTraceArtifact, captureBrowserArtifacts, startBrowserTrace } from "./browser-helpers.mjs";

test("browser artifact capture keeps screenshot, console, and diagnostic evidence when the gateway is unavailable", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-browser-artifacts-"));
  try {
    const page = {
      async screenshot({ path: screenshotPath }) {
        await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
        await fs.writeFile(screenshotPath, "screenshot");
      },
      async evaluate() {
        return { browser: "bundle" };
      },
    };
    const artifacts = await captureBrowserArtifacts(
      { artifactRoot },
      {
        slug: "failed-route",
        page,
        browserLog: { getSnapshot: () => ({ consoleMessages: [{ type: "error", text: "boom" }], pageErrors: [] }) },
        gatewayUrl: "http://127.0.0.1:1",
        correlationId: "correlation-1",
        logCursor: { consoleMessages: 0, pageErrors: 0 },
      },
    );

    assert.deepEqual(artifacts.screenshots, ["screenshots/failed-route.png"]);
    assert.equal(artifacts.diagnostics.length, 2);
    assert.deepEqual(artifacts.logs, ["playwright/failed-route-console.json"]);
    const gatewayDiagnostics = JSON.parse(
      await fs.readFile(path.join(artifactRoot, "diagnostics", "failed-route-gateway.json"), "utf8"),
    );
    const browserDiagnostics = JSON.parse(
      await fs.readFile(path.join(artifactRoot, "diagnostics", "failed-route-browser.json"), "utf8"),
    );
    assert.match(gatewayDiagnostics.captureError.message, /fetch|bad port|failed/i);
    assert.equal(browserDiagnostics.browser, "bundle");
    assert.equal(browserDiagnostics.artifactCaptureErrors[0].stage, "gateway-diagnostics");
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("failure traces are retained once and attached to both trace and Playwright artifact lists", async () => {
  const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-browser-trace-"));
  const calls = [];
  try {
    const page = {
      context: () => ({
        tracing: {
          async start(options) {
            calls.push(["start", options]);
          },
          async stop(options) {
            calls.push(["stop", options]);
          },
        },
      }),
    };
    const trace = await startBrowserTrace({ artifactRoot }, { page, slug: "failed-route" });
    const retained = await trace.retain();
    await trace.discard();
    const artifacts = appendTraceArtifact(
      { diagnostics: [], screenshots: [], traces: [], logs: [], perf: [], playwright: ["console.json"] },
      retained,
    );

    assert.equal(retained, "playwright/failed-route-trace.zip");
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], "start");
    assert.equal(calls[1][0], "stop");
    assert.match(calls[1][1].path, /failed-route-trace\.zip$/);
    assert.deepEqual(artifacts.traces, ["playwright/failed-route-trace.zip"]);
    assert.deepEqual(artifacts.playwright, ["console.json", "playwright/failed-route-trace.zip"]);
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});
