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

  await input.page.screenshot({ path: screenshotPath, fullPage: false });
  const gatewayDiagnostics = await requestJson(
    input.gatewayUrl,
    `/api/v1/dev/verification/diagnostics-snapshot?limit=150${input.correlationId ? `&correlationId=${encodeURIComponent(input.correlationId)}` : ""}`,
  );
  await writeJson(gatewayDiagnosticsPath, gatewayDiagnostics.body);
  const browserBundle = await input.page.evaluate((gatewayItems) => {
    return window.__goatcitadelDevDiagnostics?.buildBundle(gatewayItems) ?? null;
  }, gatewayDiagnostics.body?.items ?? []);
  await writeJson(browserDiagnosticsPath, browserBundle);
  await writeJson(consoleLogPath, input.browserLog.getSnapshot(input.logCursor));
  return {
    diagnostics: [relativeToRun(context, browserDiagnosticsPath), relativeToRun(context, gatewayDiagnosticsPath)],
    screenshots: [relativeToRun(context, screenshotPath)],
    traces: [],
    logs: [relativeToRun(context, consoleLogPath)],
    perf: (input.extraPerfArtifacts ?? []).map((item) => relativeToRun(context, item)),
    playwright: [relativeToRun(context, consoleLogPath)],
  };
}

function relativeToRun(context, filePath) {
  return path.relative(context.artifactRoot, filePath).replaceAll("\\", "/");
}
