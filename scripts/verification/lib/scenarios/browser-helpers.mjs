import fs from "node:fs/promises";
import path from "node:path";

import { requestJson } from "../runtime.mjs";
import { writeJson } from "../shared.mjs";

const EVENT_STREAM_PATH = "/api/v1/events/stream";
const MAX_EVENT_STREAM_NETWORK_RECORDS = 32;

export function attachBrowserLogging(page) {
  const consoleMessages = [];
  const pageErrors = [];
  const eventStreamRequestFailures = [];
  const eventStreamResponses = [];
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
    if (networkPath(request.url()) !== EVENT_STREAM_PATH) {
      return;
    }
    const failureText = request.failure()?.errorText;
    if (failureText !== "net::ERR_CONNECTION_FAILED") {
      return;
    }
    requestFailureSequence += 1;
    droppedRequestFailures += appendBoundedNetworkRecord(eventStreamRequestFailures, {
      sequence: requestFailureSequence,
      url: EVENT_STREAM_PATH,
      errorText: failureText,
      timestamp: new Date().toISOString(),
    });
  });
  page.on("response", (response) => {
    if (networkPath(response.url()) !== EVENT_STREAM_PATH) {
      return;
    }
    responseSequence += 1;
    droppedResponses += appendBoundedNetworkRecord(eventStreamResponses, {
      sequence: responseSequence,
      url: EVENT_STREAM_PATH,
      status: response.status(),
      timestamp: new Date().toISOString(),
    });
  });
  return {
    mark: () => ({
      consoleMessages: consoleMessages.length,
      pageErrors: pageErrors.length,
      eventStreamRequestFailures: requestFailureSequence,
      eventStreamResponses: responseSequence,
      droppedEventStreamRequestFailures: droppedRequestFailures,
      droppedEventStreamResponses: droppedResponses,
    }),
    getSnapshot: (cursor = null) => ({
      consoleMessages: [...consoleMessages.slice(cursor?.consoleMessages ?? 0)],
      pageErrors: [...pageErrors.slice(cursor?.pageErrors ?? 0)],
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
    await tracing.start({ screenshots: true, snapshots: true, sources: true });
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

function appendBoundedNetworkRecord(records, record) {
  records.push(record);
  if (records.length <= MAX_EVENT_STREAM_NETWORK_RECORDS) {
    return 0;
  }
  records.splice(0, records.length - MAX_EVENT_STREAM_NETWORK_RECORDS);
  return 1;
}

function networkPath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

function relativeToRun(context, filePath) {
  return path.relative(context.artifactRoot, filePath).replaceAll("\\", "/");
}
