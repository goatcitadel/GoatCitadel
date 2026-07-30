import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendTraceArtifact,
  attachBrowserLogging,
  captureBrowserArtifacts,
  readBrowserSseDiagnostics,
  startBrowserTrace,
} from "./browser-helpers.mjs";

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
    assert.deepEqual(calls[0][1], { screenshots: true, snapshots: false, sources: false });
    assert.equal(calls[1][0], "stop");
    assert.match(calls[1][1].path, /failed-route-trace\.zip$/);
    assert.deepEqual(artifacts.traces, ["playwright/failed-route-trace.zip"]);
    assert.deepEqual(artifacts.playwright, ["console.json", "playwright/failed-route-trace.zip"]);
  } finally {
    await fs.rm(artifactRoot, { recursive: true, force: true });
  }
});

test("browser logging retains bounded exact event-stream network recovery evidence", () => {
  const page = new EventEmitter();
  const browserLog = attachBrowserLogging(page);
  const cursor = browserLog.mark();

  page.emit("requestfailed", failedRequest("http://127.0.0.1/api/v1/other", "net::ERR_CONNECTION_FAILED"));
  page.emit("requestfailed", failedRequest("http://127.0.0.1/api/v1/events/stream", "net::ERR_ABORTED"));
  page.emit(
    "requestfailed",
    failedRequest("http://127.0.0.1/api/v1/events/stream?afterCursor=fixture", "net::ERR_CONNECTION_FAILED"),
  );
  page.emit("response", response("http://127.0.0.1/api/v1/other", 200));
  page.emit("response", response("http://127.0.0.1/api/v1/events/stream?afterCursor=fixture", 503));
  page.emit("response", response("http://127.0.0.1/api/v1/events/stream?afterCursor=fixture", 200));

  const snapshot = browserLog.getSnapshot(cursor);
  assert.equal(snapshot.eventStreamEvidenceTruncated, false);
  assert.deepEqual(
    snapshot.eventStreamRequestFailures.map(({ url, errorText }) => ({ url, errorText })),
    [{ url: "/api/v1/events/stream", errorText: "net::ERR_CONNECTION_FAILED" }],
  );
  assert.deepEqual(
    snapshot.eventStreamResponses.map(({ url, status }) => ({ url, status })),
    [
      { url: "/api/v1/events/stream", status: 503 },
      { url: "/api/v1/events/stream", status: 200 },
    ],
  );
});

test("browser logging retains only bounded query-free loopback network metadata", () => {
  const page = new EventEmitter();
  const browserLog = attachBrowserLogging(page);
  const cursor = browserLog.mark();

  page.emit("response", response("http://127.0.0.1:3310/api/v1/skills?token=must-not-leak", 200, "POST"));
  page.emit(
    "requestfailed",
    failedRequest(
      "http://localhost:5173/assets/app.js?authorization=must-not-leak",
      "provider failure included must-not-leak",
      "GET",
    ),
  );
  page.emit("response", response("https://external.example/private?token=must-not-leak", 204, "DELETE"));

  const snapshot = browserLog.getSnapshot(cursor);
  assert.equal(snapshot.networkEvidenceTruncated, false);
  assert.deepEqual(
    snapshot.networkRecords.map(({ kind, method, path, status, failureClass }) => ({
      kind,
      method,
      path,
      status,
      failureClass,
    })),
    [
      {
        kind: "response",
        method: "POST",
        path: "/api/v1/skills",
        status: 200,
        failureClass: undefined,
      },
      {
        kind: "failure",
        method: "GET",
        path: "/assets/app.js",
        status: undefined,
        failureClass: "request_failed",
      },
    ],
  );
  const serialized = JSON.stringify(snapshot.networkRecords);
  assert.doesNotMatch(serialized, /must-not-leak|external\.example|authorization|provider failure/u);
});

test("browser logging marks native network metadata as truncated after its bounded limit", () => {
  const page = new EventEmitter();
  const browserLog = attachBrowserLogging(page);
  const cursor = browserLog.mark();
  for (let index = 0; index < 257; index += 1) {
    page.emit("response", response(`http://127.0.0.1/api/v1/items/${index}`, 200));
  }
  const snapshot = browserLog.getSnapshot(cursor);
  assert.equal(snapshot.networkRecords.length, 256);
  assert.equal(snapshot.networkRecords[0].path, "/api/v1/items/1");
  assert.equal(snapshot.networkEvidenceTruncated, true);
});

test("browser logging does not report truncation when only pre-cursor network evidence is evicted", () => {
  const page = new EventEmitter();
  const browserLog = attachBrowserLogging(page);
  for (let index = 0; index < 256; index += 1) {
    page.emit("response", response(`http://127.0.0.1/assets/${index}.js`, 200));
  }
  const cursor = browserLog.mark();
  page.emit("response", response("http://127.0.0.1/api/v1/health", 200));

  const snapshot = browserLog.getSnapshot(cursor);
  assert.deepEqual(
    snapshot.networkRecords.map(({ path }) => path),
    ["/api/v1/health"],
  );
  assert.equal(snapshot.networkEvidenceTruncated, false);
});

test("browser logging fails closed when bounded event-stream evidence is truncated", () => {
  const page = new EventEmitter();
  const browserLog = attachBrowserLogging(page);
  const cursor = browserLog.mark();
  for (let index = 0; index < 33; index += 1) {
    page.emit("requestfailed", failedRequest("http://127.0.0.1/api/v1/events/stream", "net::ERR_CONNECTION_FAILED"));
  }
  const snapshot = browserLog.getSnapshot(cursor);
  assert.equal(snapshot.eventStreamRequestFailures.length, 32);
  assert.equal(snapshot.eventStreamEvidenceTruncated, true);
});

test("client SSE diagnostics expose only bounded recovery fields", async () => {
  const page = {
    async evaluate() {
      return {
        available: true,
        records: [
          {
            category: "sse",
            event: "open",
            level: "info",
            timestamp: "2026-07-30T12:26:16.692Z",
            context: { secret: "must-not-leak" },
            message: "Realtime event stream connected",
          },
        ],
      };
    },
  };
  assert.deepEqual(await readBrowserSseDiagnostics(page), {
    available: true,
    records: [
      {
        category: "sse",
        event: "open",
        level: "info",
        timestamp: "2026-07-30T12:26:16.692Z",
      },
    ],
  });
});

test("client SSE diagnostics fail closed when the diagnostics bridge is unavailable", async () => {
  assert.deepEqual(
    await readBrowserSseDiagnostics({
      async evaluate() {
        return { available: false, records: [] };
      },
    }),
    { available: false, records: [] },
  );
});

function failedRequest(url, errorText, method = "GET") {
  return {
    url: () => url,
    method: () => method,
    failure: () => ({ errorText }),
  };
}

function response(url, status, method = "GET") {
  return {
    url: () => url,
    status: () => status,
    request: () => ({ method: () => method }),
  };
}
