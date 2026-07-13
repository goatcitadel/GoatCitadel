import fs from "node:fs/promises";
import path from "node:path";

import { requestJson } from "../runtime.mjs";
import { writeJson } from "../shared.mjs";

export function attachBrowserLogging(page) {
  const consoleMessages = [];
  const pageErrors = [];
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
  return {
    mark: () => ({
      consoleMessages: consoleMessages.length,
      pageErrors: pageErrors.length,
    }),
    getSnapshot: (cursor = null) => ({
      consoleMessages: [...consoleMessages.slice(cursor?.consoleMessages ?? 0)],
      pageErrors: [...pageErrors.slice(cursor?.pageErrors ?? 0)],
    }),
  };
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

function relativeToRun(context, filePath) {
  return path.relative(context.artifactRoot, filePath).replaceAll("\\", "/");
}
