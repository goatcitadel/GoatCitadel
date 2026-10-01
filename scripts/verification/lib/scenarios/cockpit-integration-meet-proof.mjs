import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const sessionsPath = "/api/v1/voice/google-meet/sessions";
const prerequisitePath = "/api/v1/voice/google-meet/prerequisites";
export function assertMeetReviewHasNoEffects({ before, after, writes, microphoneCalls }) {
  assert.deepEqual(after, before, "Review or cancellation changed canonical meeting records.");
  assert.deepEqual(writes, [], "Review or cancellation dispatched a meeting or credential mutation.");
  assert.equal(microphoneCalls, 0, "Review or cancellation requested microphone access.");
}
const observe = promise => { void promise.catch(() => {}); return promise; };

/** Real owner evidence and cancellation only: no Google/OpenAI request or simulated transport readiness. */
export async function runCockpitIntegrationMeetProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-/u.test(path.basename(stack.runtimeRoot)), "Requires disposable verification runtime.");
  const readRecords = async () => {
    const response = await requestJson(stack.gatewayUrl, `${sessionsPath}?limit=100`);
    assert.ok(response.ok && Array.isArray(response.body.items), "Meeting owner records unavailable.");
    return response.body.items;
  };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-integration-meet.${variant}`, lane: "ux-budgets",
      title: `Native meeting owner evidence and preparation cancellation ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let page, browserContext, stage = "read current meeting owner";
      const screenshots = [], diagnostics = [], writes = [];
      try {
        const before = await readRecords();
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
          window.__meetProofMicrophoneCalls = 0;
          const devices = navigator.mediaDevices;
          if (devices?.getUserMedia) {
            const original = devices.getUserMedia.bind(devices);
            devices.getUserMedia = (...args) => { window.__meetProofMicrophoneCalls += 1; return original(...args); };
          }
        }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          if (request.method() !== "GET" && (pathname.startsWith(sessionsPath) || pathname.includes("/voice/realtime/")))
            writes.push({ method: request.method(), pathname });
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/connections?shell=cockpit#integration-connections"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        await page.getByRole("button", { name: "Add and manage integrations", exact: true }).click();
        const prerequisitesResponse = observe(page.waitForResponse(response =>
          response.request().method() === "POST" && new URL(response.url()).pathname === prerequisitePath));
        await page.getByRole("region", { name: "Integration management", exact: true })
          .getByRole("button", { name: "Google Meet preparation", exact: true }).click();
        const response = await prerequisitesResponse;
        assert.equal(response.status(), 200);
        assert.deepEqual(response.request().postDataJSON(), {});
        const prerequisites = await response.json();
        assert.equal(prerequisites.provider, "openai-realtime");
        assert.ok(Array.isArray(prerequisites.prerequisites) && prerequisites.checkedAt);
        const panel = page.getByRole("region", { name: "Google Meet preparation", exact: true });
        await panel.getByRole("button", { name: "Review meeting preparation", exact: true }).waitFor();
        await panel.locator("summary", { hasText: "Gateway prerequisites without local microphone probe" }).click();
        for (const item of prerequisites.prerequisites) {
          const text = `${item.id}: ${item.ready ? "Ready according to Gateway" : "Blocked"} · ${item.message}`;
          await panel.getByText(text, { exact: true }).waitFor();
        }
        if (!before.length) await panel.getByText("No meeting records returned.", { exact: true }).waitFor();
        else for (const record of before.slice(0, 10))
          await panel.getByRole("heading", { name: record.displayName || record.meetingUrl, exact: true }).first().waitFor();
        await capture("owner-evidence");
        stage = "review explicit effects then cancel without dispatch";
        const meetingUrl = "https://meet.google.com/fixture-review-only";
        await panel.getByLabel("Google Meet URL", { exact: true }).fill(meetingUrl);
        await panel.getByLabel("Meeting display name", { exact: true }).fill(`Review only ${variant}`);
        await panel.getByLabel("Google account reference", { exact: true }).fill("fixture-reference-unverified");
        await panel.getByRole("button", { name: "Review meeting preparation", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Prepare Google Meet voice?", exact: true });
        await dialog.waitFor();
        const text = await dialog.innerText();
        assert.ok(text.includes(meetingUrl) && text.includes("fixture-reference-unverified"));
        assert.ok(text.includes("microphone permission") && text.includes("may contact OpenAI"));
        assert.ok(text.includes("do not join Google Meet or establish live audio") && text.includes("no atomic revision precondition"));
        await capture("preparation-review");
        await dialog.getByRole("button", { name: "Cancel meeting action", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        assertMeetReviewHasNoEffects({ before, after: await readRecords(), writes,
          microphoneCalls: await page.evaluate(() => window.__meetProofMicrophoneCalls) });
        await capture("cancelled");
        return { status: "passed", metrics: { canonicalMeetingEvidence: true, exactPrerequisiteEvidence: true,
          reviewCancellationWrites: 0, microphoneCalls: 0, liveMeetTransportTested: false, openAiCredentialTested: false,
          blockingAxe: 0 }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await screenshot("failure"); } catch { /* Preserve first failure. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, writes }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { await browserContext?.close(); }
      async function screenshot(name) {
        const directory = path.join(context.artifactRoot, "screenshots"); await mkdir(directory, { recursive: true });
        const file = path.join(directory, `cockpit-integration-meet-${variant}-${name}.png`);
        await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file));
      }
      async function capture(name) {
        await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page), blocking = audit.violations.filter(item => ["serious", "critical"].includes(item.impact));
        if (blocking.length) {
          const directory = path.join(context.artifactRoot, "diagnostics"); await mkdir(directory, { recursive: true });
          const file = path.join(directory, `cockpit-integration-meet-${variant}-${name}-axe.json`);
          await writeFile(file, JSON.stringify(blocking, null, 2)); diagnostics.push(relativeToRun(context, file));
        }
        assert.deepEqual(blocking.map(item => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        await screenshot(name);
      }
    });
  }
}
