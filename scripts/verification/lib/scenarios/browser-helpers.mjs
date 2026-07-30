import fs from "node:fs/promises";
import path from "node:path";

import { requestJson } from "../runtime.mjs";
import { writeJson } from "../shared.mjs";

const EVENT_STREAM_PATH = "/api/v1/events/stream";
const MAX_EVENT_STREAM_NETWORK_RECORDS = 32;
const MAX_BROWSER_NETWORK_RECORDS = 256;

export function attachBrowserLogging(page) {
  const consoleMessages = [];
  const pageErrors = [];
  const networkRecords = [];
  const eventStreamRequestFailures = [];
  const eventStreamResponses = [];
  let networkSequence = 0;
  let requestFailureSequence = 0;
  let responseSequence = 0;
  let droppedRequestFailures = 0;
  let droppedResponses = 0;
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      timestamp: new Date().toISOString(),
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push({
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    });
  });
  page.on("requestfailed", (request) => {
    const requestPath = loopbackNetworkPath(request.url());
    if (!requestPath) {
      return;
    }
    const failureText = request.failure()?.errorText;
    networkSequence += 1;
    appendBoundedNetworkRecord(
      networkRecords,
      {
        sequence: networkSequence,
        kind: "failure",
        method: safeRequestMethod(request),
        path: requestPath,
        failureClass: safeNetworkFailureClass(failureText),
        timestamp: new Date().toISOString(),
      },
      MAX_BROWSER_NETWORK_RECORDS,
    );
    if (requestPath !== EVENT_STREAM_PATH) {
      return;
    }
    if (failureText !== "net::ERR_CONNECTION_FAILED") {
      return;
    }
    requestFailureSequence += 1;
    droppedRequestFailures += appendBoundedNetworkRecord(
      eventStreamRequestFailures,
      {
        sequence: requestFailureSequence,
        url: EVENT_STREAM_PATH,
        errorText: failureText,
        timestamp: new Date().toISOString(),
      },
      MAX_EVENT_STREAM_NETWORK_RECORDS,
    );
  });
  page.on("response", (response) => {
    const responsePath = loopbackNetworkPath(response.url());
    if (!responsePath) {
      return;
    }
    networkSequence += 1;
    appendBoundedNetworkRecord(
      networkRecords,
      {
        sequence: networkSequence,
        kind: "response",
        method: safeRequestMethod(response.request?.()),
        path: responsePath,
        status: response.status(),
        timestamp: new Date().toISOString(),
      },
      MAX_BROWSER_NETWORK_RECORDS,
    );
    if (responsePath !== EVENT_STREAM_PATH) {
      return;
    }
    responseSequence += 1;
    droppedResponses += appendBoundedNetworkRecord(
      eventStreamResponses,
      {
        sequence: responseSequence,
        url: EVENT_STREAM_PATH,
        status: response.status(),
        timestamp: new Date().toISOString(),
      },
      MAX_EVENT_STREAM_NETWORK_RECORDS,
    );
  });
  return {
    mark: () => ({
      consoleMessages: consoleMessages.length,
      pageErrors: pageErrors.length,
      networkRecords: networkSequence,
      eventStreamRequestFailures: requestFailureSequence,
      eventStreamResponses: responseSequence,
      droppedEventStreamRequestFailures: droppedRequestFailures,
      droppedEventStreamResponses: droppedResponses,
    }),
    getSnapshot: (cursor = null) => ({
      consoleMessages: [...consoleMessages.slice(cursor?.consoleMessages ?? 0)],
      pageErrors: [...pageErrors.slice(cursor?.pageErrors ?? 0)],
      networkRecords: networkRecords.filter((record) => record.sequence > (cursor?.networkRecords ?? 0)),
      networkEvidenceTruncated: hasBoundedEvidenceGap(networkRecords, cursor?.networkRecords ?? 0, networkSequence),
      eventStreamRequestFailures: eventStreamRequestFailures.filter(
        (record) => record.sequence > (cursor?.eventStreamRequestFailures ?? 0),
      ),
      eventStreamResponses: eventStreamResponses.filter(
        (record) => record.sequence > (cursor?.eventStreamResponses ?? 0),
      ),
      eventStreamEvidenceTruncated:
        droppedRequestFailures > (cursor?.droppedEventStreamRequestFailures ?? 0) ||
        droppedResponses > (cursor?.droppedEventStreamResponses ?? 0),
    }),
  };
}

export async function readBrowserSseDiagnostics(page) {
  try {
    const evidence = await page.evaluate((limit) => {
      const diagnostics = window.__goatcitadelDevDiagnostics;
      if (!diagnostics) {
        return { available: false, records: [] };
      }
      return { available: true, records: diagnostics.list({ category: "sse", limit }) };
    }, MAX_EVENT_STREAM_NETWORK_RECORDS);
    if (evidence?.available !== true || !Array.isArray(evidence.records)) {
      return { available: false, records: [] };
    }
    return {
      available: true,
      records: evidence.records
        .filter((record) => record && typeof record === "object")
        .slice(0, MAX_EVENT_STREAM_NETWORK_RECORDS)
        .map((record) => ({
          category: typeof record.category === "string" ? record.category : undefined,
          event: typeof record.event === "string" ? record.event : undefined,
          level: typeof record.level === "string" ? record.level : undefined,
          timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
        })),
    };
  } catch (error) {
    return {
      available: false,
      records: [],
      captureError: serializeError(error),
    };
  }
}

export async function setBrowserCorrelation(page, correlationId, sessionId) {
  await page.evaluate(
    ({ correlationId: value, sessionId: activeSessionId }) => {
      window.__goatcitadelDevDiagnostics?.setCorrelationId(value);
      if (activeSessionId) {
        window.__goatcitadelDevDiagnostics?.setChatSessionId(activeSessionId);
      }
    },
    { correlationId, sessionId },
  );
}

export async function captureBrowserArtifacts(context, input) {
  const screenshotPath = path.join(context.artifactRoot, "screenshots", `${input.slug}.png`);
  const browserDiagnosticsPath = path.join(context.artifactRoot, "diagnostics", `${input.slug}-browser.json`);
  const gatewayDiagnosticsPath = path.join(context.artifactRoot, "diagnostics", `${input.slug}-gateway.json`);
  const consoleLogPath = path.join(context.artifactRoot, "playwright", `${input.slug}-console.json`);

  const captureErrors = [];
  let screenshotCaptured = false;
  try {
    await input.page.screenshot({ path: screenshotPath, fullPage: false });
    screenshotCaptured = true;
  } catch (error) {
    captureErrors.push({ stage: "screenshot", error: serializeError(error) });
  }

  let gatewayDiagnosticsBody;
  try {
    const gatewayDiagnostics = await requestJson(
      input.gatewayUrl,
      `/api/v1/dev/verification/diagnostics-snapshot?limit=150${input.correlationId ? `&correlationId=${encodeURIComponent(input.correlationId)}` : ""}`,
    );
    gatewayDiagnosticsBody = gatewayDiagnostics.body;
  } catch (error) {
    const serialized = serializeError(error);
    captureErrors.push({ stage: "gateway-diagnostics", error: serialized });
    gatewayDiagnosticsBody = { captureError: serialized, items: [] };
  }
  await writeJson(gatewayDiagnosticsPath, gatewayDiagnosticsBody);

  let browserBundle;
  try {
    browserBundle = await input.page.evaluate((gatewayItems) => {
      return window.__goatcitadelDevDiagnostics?.buildBundle(gatewayItems) ?? null;
    }, gatewayDiagnosticsBody?.items ?? []);
  } catch (error) {
    const serialized = serializeError(error);
    captureErrors.push({ stage: "browser-diagnostics", error: serialized });
    browserBundle = { captureError: serialized };
  }
  if (captureErrors.length > 0) {
    browserBundle = {
      ...(browserBundle && typeof browserBundle === "object" ? browserBundle : { bundle: browserBundle }),
      artifactCaptureErrors: captureErrors,
    };
  }
  await writeJson(browserDiagnosticsPath, browserBundle);
  await writeJson(consoleLogPath, input.browserLog.getSnapshot(input.logCursor));
  return {
    diagnostics: [relativeToRun(context, browserDiagnosticsPath), relativeToRun(context, gatewayDiagnosticsPath)],
    screenshots: screenshotCaptured ? [relativeToRun(context, screenshotPath)] : [],
    traces: [],
    logs: [relativeToRun(context, consoleLogPath)],
    perf: (input.extraPerfArtifacts ?? []).map((item) => relativeToRun(context, item)),
    playwright: [relativeToRun(context, consoleLogPath)],
  };
}

export async function startBrowserTrace(context, input) {
  const tracing = input.page.context?.()?.tracing;
  if (!tracing?.start || !tracing?.stop) {
    return disabledTrace();
  }
  const tracePath = path.join(context.artifactRoot, "playwright", `${input.slug}-trace.zip`);
  try {
    await fs.mkdir(path.dirname(tracePath), { recursive: true });
    // Retained evidence already carries screenshots, the action timeline, console
    // output, bounded query-free network metadata, and Gateway/browser diagnostics.
    // Playwright source and DOM/network snapshots can archive unrelated
    // credential-shaped fixture text from verifier sources or API response bodies,
    // so keep those copies out of evidence ZIPs.
    await tracing.start({ screenshots: true, snapshots: false, sources: false });
  } catch {
    return disabledTrace();
  }
  let active = true;
  return {
    async retain() {
      if (!active) {
        return null;
      }
      active = false;
      await tracing.stop({ path: tracePath });
      return relativeToRun(context, tracePath);
    },
    async discard() {
      if (!active) {
        return;
      }
      active = false;
      await tracing.stop();
    },
  };
}

export function appendTraceArtifact(artifacts, traceArtifact) {
  if (!traceArtifact) {
    return artifacts;
  }
  return {
    ...artifacts,
    traces: [...new Set([...(artifacts.traces ?? []), traceArtifact])],
    playwright: [...new Set([...(artifacts.playwright ?? []), traceArtifact])],
  };
}

function disabledTrace() {
  return {
    async retain() {
      return null;
    },
    async discard() {},
  };
}

function serializeError(error) {
  return error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
}

function appendBoundedNetworkRecord(records, record, limit) {
  records.push(record);
  if (records.length <= limit) {
    return 0;
  }
  records.splice(0, records.length - limit);
  return 1;
}

function hasBoundedEvidenceGap(records, cursorSequence, currentSequence) {
  if (currentSequence <= cursorSequence) {
    return false;
  }
  const firstRetainedRecord = records.find((record) => record.sequence > cursorSequence);
  return !firstRetainedRecord || firstRetainedRecord.sequence > cursorSequence + 1;
}

function loopbackNetworkPath(value) {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase())
    ) {
      return undefined;
    }
    return parsed.pathname;
  } catch {
    return undefined;
  }
}

function safeRequestMethod(request) {
  try {
    const method = request?.method?.();
    return typeof method === "string" && /^[A-Z]{1,16}$/u.test(method) ? method : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function safeNetworkFailureClass(value) {
  return typeof value === "string" && /^net::ERR_[A-Z0-9_]+$/u.test(value) ? value : "request_failed";
}

function relativeToRun(context, filePath) {
  return path.relative(context.artifactRoot, filePath).replaceAll("\\", "/");
}
