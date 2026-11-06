import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createReviewedMutationRecorder } from "./cockpit-reviewed-mutations.mjs";
import { verificationErrorDiagnostic, writeJson } from "../shared.mjs";
const requireCanonicalContract = createRequire(import.meta.url);
// Keep synchronous transport helpers canonical without loading build output at registry startup.
const startupReadContract = () => requireCanonicalContract("../../../../packages/contracts/dist/gateway-startup-reads.js");

const parseInboxJson = text => { try { return JSON.parse(text); } catch { throw new Error("Invalid Inbox transport JSON"); } };
const exactInboxMembership = url => {
  assert.ok(url.searchParams.getAll("workspaceId").length === 1 && url.searchParams.get("workspaceId") === "default", "Inbox transport has foreign or ambiguous workspace membership");
  assert.ok([...url.searchParams.keys()].every(key => key === "workspaceId"), "Inbox transport has unexpected query fields");
};
/** Select the genuine owner by its original request position, never by response content. */
export function matchInboxOwnerRead(request) {
  if (request.method() !== "GET") return null;
  const url = new URL(request.url());
  if (url.pathname === "/api/v1/inbox") { exactInboxMembership(url); return { transport: "direct", index: 0, count: 1 }; }
  if (url.pathname !== "/api/v1/startup-reads") return null;
  const { isStartupReadRequest, STARTUP_READ_BATCH_LIMIT, STARTUP_READ_BATCH_QUERY_LIMIT } = startupReadContract();
  assert.ok(Buffer.byteLength(url.pathname + url.search, "utf8") <= STARTUP_READ_BATCH_QUERY_LIMIT + 100, "Startup read query exceeds its contract bound");
  assert.ok(url.searchParams.getAll("reads").length === 1 && [...url.searchParams.keys()].every(key => key === "reads"), "Invalid startup read query shape");
  const rows = parseInboxJson(url.searchParams.get("reads"));
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= STARTUP_READ_BATCH_LIMIT && rows.every(isStartupReadRequest), "Invalid startup read membership");
  const matches = [];
  rows.forEach((row, index) => { const owner = new URL(row.path, "http://startup-read.invalid"); if (owner.pathname === "/api/v1/inbox") { exactInboxMembership(owner); matches.push(index); } });
  assert.ok(matches.length <= 1, "Duplicate Inbox owner membership");
  return matches.length ? { transport: "startup_batch", index: matches[0], count: rows.length } : null;
}
export async function readInboxOwnerResult(request, response) {
  const membership = matchInboxOwnerRead(request);
  if (!membership) return null;
  assert.equal(response.status(), 200);
  let body;
  try { body = await response.json(); } catch { throw new Error("Invalid Inbox transport JSON"); }
  if (membership.transport === "startup_batch") {
    const { STARTUP_READ_BATCH_BODY_LIMIT } = startupReadContract();
    assert.ok(body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every(key => key === "items") && Array.isArray(body.items) && body.items.length === membership.count, "Startup response does not match original membership");
    const headers = new Set(["content-type", "cache-control", "etag", "x-goatcitadel-correlation-id"]);
    assert.ok(body.items.every(row => row && typeof row === "object" && !Array.isArray(row) &&
      Object.keys(row).every(key => ["status", "bodyText", "headers", "directReadRequired"].includes(key)) &&
      Number.isInteger(row.status) && row.status >= 200 && row.status <= 599 && typeof row.bodyText === "string" && Buffer.byteLength(row.bodyText, "utf8") <= STARTUP_READ_BATCH_BODY_LIMIT &&
      row.headers && typeof row.headers === "object" && !Array.isArray(row.headers) && Object.entries(row.headers).every(([key, value]) => headers.has(key) && typeof value === "string" && !/[\r\n]/u.test(value)) &&
      (row.directReadRequired === undefined || row.directReadRequired === true)), "Invalid startup owner response envelope");
    const selected = body.items[membership.index];
    assert.ok(selected.status === 200 && selected.directReadRequired === undefined, "Inbox owner result is not an authentic successful snapshot");
    body = parseInboxJson(selected.bodyText);
  }
  assert.ok(body && typeof body === "object" && body.authority === "derived_projection" && body.workspaceId === "default" && Array.isArray(body.items), "Inbox snapshot authority or workspace is unavailable");
  return body;
}
export function createHeldInboxOwnerRoute({ isHeld, onStart, onReady, gate, isClosed, record = () => {} }) {
  return async route => {
    const request = route.request();
    const membership = matchInboxOwnerRead(request);
    if (!membership || isHeld()) return route.continue();
    record({ kind: "route_hit", owner: "inbox", method: "GET", scope: "expected", transport: membership.transport });
    onStart();
    let response;
    try { response = await route.fetch(); await readInboxOwnerResult(request, response); record({ kind: "fetch_result", owner: "inbox", method: "GET", status: response.status(), transport: membership.transport }); }
    catch (error) { record({ kind: "fetch_failed", owner: "inbox", method: "GET", transport: membership.transport }); throw error; }
    onReady();
    await gate;
    if (!isClosed()) await route.fulfill({ response });
  };
}

const boundedCount = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(10_000, value) : null;
export function createOwnerReadDiagnostic() {
  const events = [];
  const counts = Object.fromEntries(["request", "response", "request_failed", "route_hit", "fetch_result", "fetch_failed", "stream_ready", "other"].map(kind => [kind, 0]));
  let dropped = 0, gap = false, ui = null, device = null;
  return {
    record(input) {
      const kind = Object.hasOwn(counts, input?.kind) ? input.kind : "other";
      counts[kind] = Math.min(10_000, counts[kind] + 1);
      if (events.length >= 32) { dropped = Math.min(10_000, dropped + 1); gap = true; return; }
      events.push({
        kind,
        owner: ["inbox", "device_grants", "current_access"].includes(input?.owner) ? input.owner : "other",
        method: ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(input?.method) ? input.method : "other",
        transport: ["direct", "startup_batch"].includes(input?.transport) ? input.transport : "other",
        scope: ["expected", "different", "missing", "not_applicable"].includes(input?.scope) ? input.scope : "missing",
        status: Number.isSafeInteger(input?.status) && input.status >= 100 && input.status <= 599 ? input.status : null,
        queryShape: ["workspace_only", "workspace_and_other", "view_all", "other", "not_applicable"].includes(input?.queryShape) ? input.queryShape : "not_applicable",
        elapsedMs: Number.isSafeInteger(input?.elapsedMs) && input.elapsedMs >= 0 ? Math.min(120_000, input.elapsedMs) : null,
      });
    },
    unavailable() { gap = true; },
    ui(value) {
      ui = { selectedScope: ["expected", "different", "missing"].includes(value?.selectedScope) ? value.selectedScope : "missing" };
      for (const key of ["expectedSectionPresent", "scopeTriggerPresent", "scopeBusy", "loadingVisible", "paginationVisible", "streamReady", "heldReadStarted", "heldSnapshotReady"])
        ui[key] = typeof value?.[key] === "boolean" ? value[key] : null;
      for (const key of ["statusCount", "alertCount", "visibleDeviceRows", "pendingResponses"]) ui[key] = boundedCount(value?.[key]);
    },
    device(value) {
      device = {};
      device.total = boundedCount(value?.total);
      for (const key of ["subjectIndex", "peerIndex"]) device[key] = value?.[key] === -1 ? -1 : boundedCount(value?.[key]);
      for (const key of ["subjectIsCurrent", "peerIsCurrent", "currentGrantPresent"]) device[key] = typeof value?.[key] === "boolean" ? value[key] : null;
    },
    snapshot() { return { events: events.map(event => ({ ...event })), counts: { ...counts }, dropped, diagnosticGap: gap || ui === null,
      ui: ui && { ...ui }, device: device && { ...device } }; },
  };
}

/** Redact before the existing atomic writer; instrumentation cannot replace
 * the original failed outcome or silently report a successful capture. */
export async function retainOwnerReadDiagnostic(snapshot, filePath, { redact = verificationErrorDiagnostic, write = writeJson } = {}) {
  try {
    const redacted = await redact(JSON.stringify(snapshot));
    const suppressed = typeof redacted !== "string" || redacted.startsWith("Verification diagnostic suppressed:");
    await write(filePath, { format: "owner-read-diagnostic.v1", diagnosticGap: Boolean(snapshot.diagnosticGap) || suppressed,
      redactionSuppressed: suppressed, redactedEvidence: suppressed ? "Canonical diagnostic redaction unavailable." : redacted });
    return { retained: true, writeFailure: false };
  } catch { return { retained: false, writeFailure: true }; }
}

export function withOwnerDiagnosticResult(result, diagnosticWriteFailure) {
  return { ...result, metrics: { ...result.metrics, diagnosticWriteFailure } };
}

export async function captureOwnerReadUi(page, kind, diagnostic, gate = {}) {
  try {
    const ui = await page.evaluate(({ kind }) => {
      const visible = element => Boolean(element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
      const scope = window.localStorage.getItem("goatcitadel.ui.workspace_id.v1");
      const scopeTrigger = document.querySelector('[aria-label$=", change Citadel and workspace"]');
      const panel = kind === "device" ? document.getElementById("device-access") : document.querySelector("main");
      return { selectedScope: scope === "default" ? "expected" : scope ? "different" : "missing",
        scopeTriggerPresent: visible(scopeTrigger), scopeBusy: scopeTrigger?.getAttribute("aria-busy") === "true",
        expectedSectionPresent: kind === "device" ? visible(panel) : location.pathname === "/inbox",
        loadingVisible: [...document.querySelectorAll('[role="status"]')].some(element => visible(element) &&
          ["Loading device grants…", "Loading Inbox…", "Loading inbox…"].includes(element.textContent?.trim())),
        statusCount: document.querySelectorAll('[role="status"]').length,
        alertCount: document.querySelectorAll('[role="alert"]').length,
        visibleDeviceRows: kind === "device" && panel ? [...panel.querySelectorAll("li")].filter(visible).length : 0,
        paginationVisible: kind === "device" && panel ? [...panel.querySelectorAll("button")].some(element => visible(element) && element.textContent?.startsWith("Show more devices (")) : false,
      };
    }, { kind });
    diagnostic.ui({ ...ui, ...gate });
  } catch { diagnostic.unavailable(); }
}

const RULE_LABELS = {
  approve_all: "Ask every time",
  approve_risky: "Ask for risky work",
  bypass: "Skip normal prompts",
};
export function assertApprovedDecisionReceipt({ approvalId, workspaceId, decision, rendered, recordHref }) {
  assert.ok(approvalId, "The expected canonical approval identity is required.");
  assert.ok(workspaceId, "The expected workspace identity is required.");
  assert.equal(decision.approval?.approvalId, approvalId);
  assert.equal(decision.approval?.status, "approved");
  const followOnMessages = [
    "Follow-on action is blocked by policy.",
    "Follow-on work failed. Check its saved outcome before retrying.",
    "Follow-on settlement is pending.",
    "Approval effects settled. Linked work has its own execution outcome.",
    "Follow-on execution needs separate verification.",
  ];
  assert.ok(
    followOnMessages.some((message) => rendered === `Decision recorded: Approved. ${message}`),
    "The native settlement must retain the approved decision and separate follow-on outcome.",
  );
  // ApprovalSettlement and its compatibility adapter emit root-relative owner links.
  // Validate raw form before URL parsing can normalize authority, slashes or controls.
  assert.equal(typeof recordHref, "string");
  assert.match(
    recordHref,
    /^\/inbox\?/,
    "The settlement link must be a relative canonical owner destination.",
  );
  assert.ok(
    !/[\u0000-\u0020\u007f\\]/.test(recordHref),
    "The settlement link must not contain ambiguous URL characters.",
  );
  const owner = new URL(recordHref, "http://verification.invalid");
  assert.equal(owner.pathname, "/inbox");
  assert.deepEqual(owner.searchParams.getAll("workspaceId"), [workspaceId]);
  assert.deepEqual(owner.searchParams.getAll("view"), ["history"]);
  assert.deepEqual(owner.searchParams.getAll("shell"), ["cockpit"]);
  assert.equal(owner.searchParams.has("shellScope"), false);
  assert.deepEqual(
    owner.searchParams.getAll("approvalId"),
    [approvalId],
    "The settlement link must identify exactly one canonical approval.",
  );
}
export function assertApprovalModeBypassReview(rendered) {
  assert.ok(
    !/settings (?:revision|version)/i.test(rendered),
    "The settings version belongs in technical details, not the review copy.",
  );
  for (const consequence of [
    "Allowed tools may run without normal prompts.",
    "Deny rules, Nuclear risk and risky-shell approvals, read boundaries, and tool grants remain in force.",
  ])
    assert.ok(rendered.includes(consequence), `Missing reviewed consequence: ${consequence}`);
}
export function assertApprovalModeInspection({ before, after, rendered, mutations }) {
  assert.ok(Object.hasOwn(RULE_LABELS, before?.toolApprovalMode), "The owner approval rule is unavailable.");
  assert.ok(
    Number.isSafeInteger(before.revision) && before.revision > 0,
    "The owner settings revision is unavailable.",
  );
  assert.equal(rendered.current, `Current: ${RULE_LABELS[before.toolApprovalMode]}`);
  assert.equal(rendered.selection, before.toolApprovalMode, "The editor did not return to the saved owner rule.");
  assert.equal(after?.toolApprovalMode, before.toolApprovalMode, "Inspection changed the global approval rule.");
  assert.equal(after?.deploymentProfile, before.deploymentProfile, "Inspection changed the deployment profile.");
  assert.equal(after?.revision, before.revision, "Inspection changed the settings revision.");
  assert.deepEqual(mutations, [], "Review or cancellation issued a governed mutation.");
}

export function assertInboxToastOwnerBinding({ item, title, reads, signal }) {
  assert.equal(signal.afterReady, true);
  assert.equal(signal.links?.approvalId, item.source.approvalId);
  assert.ok(
    reads.some(
      (read) =>
        read.status === 200 &&
        read.startedAt >= signal.observedAt &&
        read.authority === "derived_projection" &&
        read.workspaceId === item.source.workspaceId &&
        read.approvals?.some(
          (approval) =>
            approval.id === item.id &&
            approval.source.approvalId === item.source.approvalId &&
            approval.source.workspaceId === item.source.workspaceId &&
            approval.title === title,
        ),
    ),
    "Toast title must come from a scoped current-owner read begun after its live signal.",
  );
}

export function assertInboxChangeBinding({ source, derived }) {
  assert.equal(derived.afterReady, true);
  assert.equal(derived.eventType, "inbox.changed");
  assert.equal(derived.source, "operator_inbox");
  assert.equal(derived.eventClass, "operational_signal");
  assert.equal(derived.eventAuthority, "retained_stream");
  assert.deepEqual(derived.payload, {
    sourceEventId: source.eventId,
    deliveryId: `inbox.changed:${source.eventId}`,
    family: "approvals",
    scope: source.links?.workspaceId ? "workspace" : "all_workspaces",
  });
  assert.deepEqual(derived.links ?? {}, source.links?.workspaceId ? { workspaceId: source.links.workspaceId } : {});
  assert.equal(derived.timestamp, source.timestamp);
}

/** Real owner reads, a failed-read fixture, then one reviewed save through its canonical approval. */
export async function runCockpitApprovalModeProof({ context, browser, stack, citadelId, viewports, deps }) {
  const {
    assertOk,
    auditPageAccessibility,
    axeSourcePath,
    buildVerificationUiUrl,
    emptyArtifacts,
    installMissionControlNextBrowserState,
    path,
    relativeToRun,
    requestJson,
    runScenario,
  } = deps;
  assert.ok(
    stack.runtimeRoot && /goatcitadel-/i.test(path.basename(stack.runtimeRoot)),
    "Approval proof requires an isolated verification runtime.",
  );
  for (const { variant, viewport } of viewports) {
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-approval-mode.${variant}`,
        lane: "ux-budgets",
        title: `Cockpit approval rule review, failed-read guard, and approved save ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        const before = await requestJson(stack.gatewayUrl, "/api/v1/settings");
        assertOk(before, "read approval settings owner");
        assert.ok(
          ["approve_all", "approve_risky"].includes(before.body?.toolApprovalMode),
          "The shipped fixture must begin with normal approval prompts enabled.",
        );
        assert.ok(
          ["local_dev", "trusted_local"].includes(before.body?.deploymentProfile),
          "Bypass cancellation proof requires the local verification profile.",
        );
        const theme = variant === "mobile" ? "light" : "dark";
        const browserContext = await browser.newContext({ viewport, colorScheme: theme });
        let page, approvalPage;
        let releaseHeldInboxRead = () => {};
        const screenshots = [];
        const settingsTraffic = [];
        const ownerDiagnostic = createOwnerReadDiagnostic(), diagnosticStartedAt = Date.now();
        const diagnostics = [];
        let diagnosticWriteFailure = false;
        let streamReady = false, heldInboxRead = false, heldInboxReady = false;
        const retainDiagnostic = async () => {
          if (approvalPage && !approvalPage.isClosed()) await captureOwnerReadUi(approvalPage, "inbox", ownerDiagnostic,
            { streamReady, heldReadStarted: heldInboxRead, heldSnapshotReady: heldInboxReady });
          const diagnosticPath = path.join(context.artifactRoot, "diagnostics", `approval-mode-owner-${variant}.json`);
          const retained = await retainOwnerReadDiagnostic(ownerDiagnostic.snapshot(), diagnosticPath);
          diagnosticWriteFailure ||= retained.writeFailure;
          if (retained.retained && !diagnostics.length) diagnostics.push(relativeToRun(context, diagnosticPath));
        };
        try {
          await browserContext.addInitScript((value) => {
            window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
            window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
          }, theme);
          await installMissionControlNextBrowserState(browserContext, "default", citadelId);
          page = await browserContext.newPage();
          const mutations = [],
            traffic = createReviewedMutationRecorder();
          page.on("request", (request) => {
            const pathname = new URL(request.url()).pathname;
            if (pathname === "/api/v1/settings")
              settingsTraffic.push({ at: Date.now(), kind: "request", method: request.method() });
            const beforeCount = traffic.writes.length;
            traffic.record(request);
            if (traffic.writes.length !== beforeCount) mutations.push(`${request.method()} ${pathname}`);
          });
          page.on("response", (response) => {
            if (new URL(response.url()).pathname === "/api/v1/settings")
              settingsTraffic.push({
                at: Date.now(),
                kind: "response",
                method: response.request().method(),
                status: response.status(),
              });
          });
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/safety?shell=cockpit#approval-mode"), {
            waitUntil: "domcontentloaded",
          });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
          const panel = page.getByRole("region", { name: "Tool approval rule", exact: true });
          const select = panel.getByRole("combobox", { name: /^Approval rule(?:\s|$)/ });
          await select.waitFor();
          const ownerText = `Current: ${RULE_LABELS[before.body.toolApprovalMode]}`;
          await panel.getByText(ownerText, { exact: true }).waitFor();
          assert.equal(await select.inputValue(), before.body.toolApprovalMode);
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          await page.addScriptTag({ path: axeSourcePath });
          const audit = async (stage, target = page) => {
            const axe = await auditPageAccessibility(target);
            const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
            const overflow = await target.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            assert.equal(
              blocking.length,
              0,
              `Approval ${stage} accessibility: ${blocking.map((item) => item.id).join(", ")}`,
            );
            assert.ok(overflow <= 1, `Approval ${stage} overflow ${overflow}px`);
            const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-approval-mode-${variant}-${stage}.png`);
            await target.screenshot({ path: screenshot, fullPage: false });
            screenshots.push(relativeToRun(context, screenshot));
            return overflow;
          };
          await select.selectOption("bypass");
          const reviewSkipping = panel.getByRole("button", { name: "Review prompt skipping", exact: true });
          await reviewSkipping.scrollIntoViewIfNeeded();
          await page.evaluate(
            () => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))),
          );
          assert.equal(await select.inputValue(), "bypass");
          await panel.getByText(ownerText, { exact: true }).waitFor();
          await page.waitForFunction(
            () =>
              [...document.querySelectorAll("#approval-mode button")].some(
                (button) => button.textContent === "Review prompt skipping" && !button.disabled,
              ),
            undefined,
            { timeout: 30_000 },
          );
          assert.equal(
            await reviewSkipping.isEnabled(),
            true,
            "The current approval draft must be ready before its reviewed click.",
          );
          await reviewSkipping.click();
          const dialog = page.getByRole("dialog", { name: "Skip normal tool prompts?", exact: true });
          await dialog.waitFor();
          assertApprovalModeBypassReview(await dialog.innerText());
          assert.deepEqual(mutations, [], "Opening dangerous review mutated the owner.");
          await audit("bypass-review");
          await dialog.getByRole("button", { name: "Keep current rule", exact: true }).click();
          await dialog.waitFor({ state: "hidden" });
          await traffic.assertPageBackground(page, "default");
          assert.deepEqual(mutations, [], "Cancelling bypass mutated the owner.");

          const draftMode = before.body.toolApprovalMode === "approve_all" ? "approve_risky" : "approve_all";
          await select.selectOption(draftMode);
          let failedReads = 0;
          const failedRead = async (route) => {
            if (route.request().method() !== "GET") return route.continue();
            failedReads += 1;
            return route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "Verification fixture: approval settings read unavailable" }),
            });
          };
          // Deliberately fail only this browser's read. The live Gateway owner remains unchanged.
          await page.route("**/api/v1/settings", failedRead);
          await panel.getByRole("button", { name: "Refresh approval settings", exact: true }).click();
          await panel.getByRole("alert").waitFor({ timeout: 30_000 });
          assert.equal(await select.count(), 0, "Cached owner data remained editable after refresh failed.");
          assert.equal(await panel.getByRole("button", { name: "Save approval rule", exact: true }).count(), 0);
          assert.ok(failedReads > 0, "The unavailable-read fixture was not exercised.");
          assert.deepEqual(mutations, [], "A stale read initiated a settings mutation.");
          await panel.scrollIntoViewIfNeeded();
          await audit("owner-unavailable");
          await page.unroute("**/api/v1/settings", failedRead);
          const recovered = page.waitForResponse(
            (response) =>
              response.request().method() === "GET" &&
              new URL(response.url()).pathname === "/api/v1/settings" &&
              response.status() === 200,
          );
          await panel.getByRole("button", { name: "Refresh approval settings", exact: true }).click();
          await recovered;
          await select.waitFor();
          assert.equal(await select.inputValue(), draftMode, "Failed refresh discarded the unsaved rule draft.");
          await panel.getByText(ownerText, { exact: true }).waitFor();
          await select.selectOption(before.body.toolApprovalMode);
          assert.equal(await panel.getByRole("button", { name: "Save approval rule", exact: true }).isDisabled(), true);
          const after = await requestJson(stack.gatewayUrl, "/api/v1/settings");
          assertOk(after, "read approval owner after review");
          assertApprovalModeInspection({
            before: before.body,
            after: after.body,
            mutations,
            rendered: { current: await panel.getByText(/^Current:/).innerText(), selection: await select.inputValue() },
          });
          await panel.scrollIntoViewIfNeeded();
          const overflow = await audit("recovered");
          approvalPage = await browserContext.newPage();
          const approvalTraffic = createReviewedMutationRecorder();
          approvalPage.on("request", (request) => approvalTraffic.record(request));
          const stream = await browserContext.newCDPSession(approvalPage);
          await stream.send("Network.enable");
          const signals = [];
          const inboxReads = [];
          const requestStarts = new WeakMap();
          approvalPage.on("request", (request) => {
            requestStarts.set(request, Date.now());
            try {
              const membership = matchInboxOwnerRead(request);
              if (membership) ownerDiagnostic.record({ kind: "request", owner: "inbox", method: request.method(), scope: "expected",
                transport: membership.transport, queryShape: membership.transport === "direct" ? "workspace_only" : "other", elapsedMs: Date.now() - diagnosticStartedAt });
            } catch { ownerDiagnostic.unavailable(); }
          });
          approvalPage.on("requestfailed", request => {
            try {
              const membership = matchInboxOwnerRead(request);
              if (membership) ownerDiagnostic.record({ kind: "request_failed", owner: "inbox", method: request.method(), transport: membership.transport, elapsedMs: Date.now() - diagnosticStartedAt });
            } catch { ownerDiagnostic.unavailable(); }
          });
          approvalPage.on("response", async (response) => {
            try {
              const membership = matchInboxOwnerRead(response.request());
              if (!membership) return;
              ownerDiagnostic.record({ kind: "response", owner: "inbox", method: response.request().method(), status: response.status(), transport: membership.transport, elapsedMs: Date.now() - diagnosticStartedAt });
              const body = await readInboxOwnerResult(response.request(), response);
              inboxReads.push({
                status: response.status(),
                startedAt: requestStarts.get(response.request()),
                completedAt: Date.now(),
                authority: body.authority,
                workspaceId: body.workspaceId,
                approvals: body.items
                  ?.filter((entry) => entry.kind === "approval")
                  .map((entry) => ({ id: entry.id, title: entry.title, source: entry.source })),
              });
            } catch {
              ownerDiagnostic.unavailable(); // Preserve the journey outcome; never retain a raw transport failure.
            }
          });
          stream.on("Network.eventSourceMessageReceived", ({ eventName, data }) => {
            if (eventName === "stream-ready") {
              streamReady = true;
              ownerDiagnostic.record({ kind: "stream_ready", owner: "inbox", elapsedMs: Date.now() - diagnosticStartedAt });
            }
            if (eventName !== "message") return;
            try {
              const event = JSON.parse(data);
              if (event.eventType?.includes("approval") || event.eventType === "inbox.changed")
                signals.push({
                  observedAt: Date.now(),
                  eventId: event.eventId,
                  timestamp: event.timestamp,
                  source: event.source,
                  payload: event.payload,
                  eventType: event.eventType,
                  eventClass: event.eventClass,
                  eventAuthority: event.eventAuthority,
                  links: event.links,
                  afterReady: streamReady,
                });
            } catch {
              /* Ignore unrelated non-JSON stream frames. */
            }
          });
          await approvalPage.addInitScript(() => {
            window.__cockpitNotificationObservations = [];
            let last = "";
            new window.MutationObserver(() => {
              const toasts = [...document.querySelectorAll("[data-sonner-toast]")].map((toast) => ({
                title: toast.querySelector("[data-title]")?.textContent,
                text: toast.textContent,
                visible: toast.getAttribute("data-visible"),
                removed: toast.getAttribute("data-removed"),
              }));
              const value = JSON.stringify(toasts);
              if (value === last) return;
              last = value;
              window.__cockpitNotificationObservations.push({ at: Date.now(), toasts });
              if (window.__cockpitNotificationObservations.length > 20)
                window.__cockpitNotificationObservations.shift();
            }).observe(document, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ["data-visible", "data-removed"],
            });
          });
          // Hold one authentic owner snapshot captured before the approval. The live
          // notification must dispatch its own read, not share this pending HTTP GET.
          const heldInboxGate = new Promise((resolve) => {
            releaseHeldInboxRead = resolve;
          });
          await approvalPage.route(url => ["/api/v1/inbox", "/api/v1/startup-reads"].includes(url.pathname), createHeldInboxOwnerRoute({
            isHeld: () => heldInboxRead, onStart: () => { heldInboxRead = true; }, onReady: () => { heldInboxReady = true; },
            gate: heldInboxGate, isClosed: () => approvalPage.isClosed(),
            record: event => ownerDiagnostic.record({ ...event, elapsedMs: Date.now() - diagnosticStartedAt }),
          }));
          await approvalPage.goto(buildVerificationUiUrl(stack.uiUrl, "/inbox?shell=cockpit"), {
            waitUntil: "domcontentloaded",
          });
          await approvalPage.waitForSelector('[data-cockpit-ready="true"]');
          for (let attempt = 0; (!streamReady || !heldInboxReady) && attempt < 100; attempt += 1)
            await new Promise((resolve) => setTimeout(resolve, 100));
          await retainDiagnostic();
          assert.equal(
            streamReady,
            true,
            "The notification observer must finish replay before the live approval is created.",
          );
          assert.equal(
            heldInboxReady,
            true,
            "The pre-event owner snapshot must be captured before creating the approval.",
          );
          await approvalPage.evaluate(() => {
            document.documentElement.dataset.inboxNavigationProof = "same-document";
          });
          await page.bringToFront();
          await select.selectOption(draftMode);
          await panel.getByText("Unsaved approval rule draft", { exact: true }).waitFor();
          await page.waitForFunction((mode) => {
            const region = document.getElementById("approval-mode");
            const buttons = [...(region?.querySelectorAll("button") ?? [])];
            return (
              region?.querySelector("select")?.value === mode &&
              buttons.some((button) => button.textContent === "Save approval rule" && !button.disabled) &&
              buttons.some((button) => button.textContent === "Refresh approval settings" && !button.disabled)
            );
          }, draftMode);
          await page.evaluate(() => {
            window.__cockpitApprovalClicks = [];
            for (const type of ["pointerdown", "click"])
              document.addEventListener(
                type,
                (event) => {
                  const button =
                    event.target instanceof window.Element ? event.target.closest("#approval-mode button") : null;
                  if (button?.textContent !== "Save approval rule") return;
                  window.__cockpitApprovalClicks.push({
                    at: Date.now(),
                    type,
                    disabled: button.disabled,
                    focus: document.hasFocus(),
                    visibility: document.visibilityState,
                    value: document.querySelector("#approval-mode select")?.value,
                  });
                },
                true,
              );
          });
          const submittedResponse = page
            .waitForResponse(
              (response) =>
                response.request().method() === "PATCH" && new URL(response.url()).pathname === "/api/v1/settings",
            )
            .then(
              (response) => ({ response }),
              (error) => ({ error }),
            );
          await panel.getByRole("button", { name: "Save approval rule", exact: true }).click();
          const submission = await submittedResponse;
          if (submission.error)
            throw new Error(
              `Approval Save did not return a PATCH. Panel: ${await panel.innerText()}. Clicks: ${JSON.stringify(await page.evaluate(() => window.__cockpitApprovalClicks))}. Settings traffic: ${JSON.stringify(settingsTraffic)}. ${submission.error.message}`,
              { cause: submission.error },
            );
          const submittedHttp = submission.response;
          releaseHeldInboxRead();
          assert.equal(submittedHttp.status(), 200);
          assert.deepEqual(submittedHttp.request().postDataJSON(), {
            expectedRevision: after.body.revision,
            toolApprovalMode: draftMode,
          });
          const submitted = await submittedHttp.json();
          const receipt = submitted.changePlanReceipt;
          assert.equal(receipt?.status, "awaiting_approval", "A caution change must wait for its canonical approval.");
          assert.equal(receipt?.requiredAction?.kind, "approval");
          assert.ok(receipt.requiredAction.approvalId);
          assert.equal(
            submitted.toolApprovalMode,
            after.body.toolApprovalMode,
            "Unapproved save changed the default rule.",
          );
          assert.equal(submitted.revision, after.body.revision);
          const approvalId = receipt.requiredAction.approvalId;
          const projection = await requestJson(stack.gatewayUrl, "/api/v1/inbox?workspaceId=default");
          assertOk(projection, "read pending rule approval Inbox");
          const item = projection.body.items.find(
            (entry) => entry.kind === "approval" && entry.source.approvalId === approvalId,
          );
          assert.equal(item?.source.workspaceId, "default");
          const approvalSignal = signals.find(
            (signal) =>
              signal.afterReady && signal.eventType === "approval_created" && signal.links?.approvalId === approvalId,
          );
          assert.ok(approvalSignal, `No live approval signal matched the owner: ${JSON.stringify(signals)}`);
          let inboxChange;
          for (let attempt = 0; attempt < 50; attempt += 1) {
            inboxChange = signals.find(
              (signal) =>
                signal.afterReady &&
                signal.eventType === "inbox.changed" &&
                signal.payload?.sourceEventId === approvalSignal.eventId,
            );
            if (inboxChange) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.ok(
            inboxChange,
            `No retained Inbox invalidation matched its approval source: ${JSON.stringify(signals)}`,
          );
          assertInboxChangeBinding({ source: approvalSignal, derived: inboxChange });
          await approvalPage.bringToFront();
          const attention = approvalPage
            .locator("[data-sonner-toast]")
            .filter({ has: approvalPage.getByRole("button", { name: "Open Inbox item", exact: true }) });
          try {
            await attention.waitFor({ timeout: 10_000 });
            const toastTitle = await attention.locator("[data-title]").innerText();
            assertInboxToastOwnerBinding({ item, title: toastTitle, reads: inboxReads, signal: approvalSignal });
            await attention.getByRole("button", { name: "Open Inbox item", exact: true }).click({ timeout: 10_000 });
          } catch (cause) {
            const observations = await approvalPage.evaluate(() => window.__cockpitNotificationObservations);
            throw new Error(
              `Current Inbox notification unavailable. Owner binding: ${JSON.stringify(item.source)}. Signals: ${JSON.stringify(signals)}. Inbox reads: ${JSON.stringify(inboxReads)}. Toast observations: ${JSON.stringify(observations)}. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
              { cause },
            );
          }
          const linkedLocation = new URL(approvalPage.url());
          assert.equal(linkedLocation.pathname, "/inbox");
          assert.equal(linkedLocation.searchParams.get("workspaceId"), "default");
          assert.equal(linkedLocation.searchParams.get("item"), item.id);
          assert.equal(
            await approvalPage.evaluate(() => document.documentElement.dataset.inboxNavigationProof),
            "same-document",
          );
          const inspector = approvalPage.getByLabel(`Inspector: ${item.title}`, { exact: true });
          await inspector.getByRole("button", { name: "Approve once", exact: true }).waitFor();
          // Follow the live toast before its normal six-second display expires.
          // The pending-plan review below must not consume that attention window.
          await panel
            .getByText("The draft remains unsaved until GoatCitadel confirms the change.", { exact: true })
            .waitFor();
          await panel.getByRole("button", { name: "Refresh approval change", exact: true }).click();
          const continueChange = panel.getByRole("button", { name: "Continue approved change", exact: true });
          await continueChange.click();
          await panel
            .getByText("The approval is not approved yet. Review the required approval first.", { exact: true })
            .waitFor();
          assert.deepEqual(mutations, ["PATCH /api/v1/settings"], "An unapproved change attempted to resume.");
          await audit("pending");
          await approvalPage.addScriptTag({ path: axeSourcePath });
          await audit("decision-review", approvalPage);
          const decisionResponse = approvalPage.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              new URL(response.url()).pathname === `/api/v1/approvals/${approvalId}/resolve`,
          );
          await inspector.getByRole("button", { name: "Approve once", exact: true }).click();
          const decisionHttp = await decisionResponse;
          assert.equal(decisionHttp.status(), 200);
          const decision = await decisionHttp.json();
          assert.equal(decision.approval?.approvalId, approvalId);
          assert.equal(decision.approval?.status, "approved");
          const settlement = inspector.getByRole("region", { name: "Decision and follow-on work", exact: true });
          const decisionStatus = settlement.getByRole("status").filter({ hasText: /^Decision recorded: Approved\./ });
          await decisionStatus.waitFor();
          assertApprovedDecisionReceipt({
            approvalId,
            workspaceId: "default",
            decision,
            rendered: await decisionStatus.innerText(),
            recordHref: await settlement
              .getByRole("link", { name: "Inspect decision and execution record", exact: true })
              .getAttribute("href"),
          });
          const ready = await requestJson(
            stack.gatewayUrl,
            `/api/v1/change-plans/${receipt.planId}?workspaceId=default`,
          );
          assertOk(ready, "read approved change before explicit continuation");
          assert.equal(
            ready.body.status,
            "awaiting_approval",
            "This setting must retain explicit continuation after approval.",
          );
          assert.equal(ready.body.requiredAction?.approvalId, approvalId);
          await panel.getByRole("button", { name: "Refresh approval change", exact: true }).click();
          const resumedResponse = page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              new URL(response.url()).pathname === `/api/v1/change-plans/${receipt.planId}/responses`,
          );
          await continueChange.click();
          const resumedHttp = await resumedResponse;
          assert.equal(resumedHttp.status(), 200);
          const resumeRequest = resumedHttp.request().postDataJSON();
          assert.equal(resumeRequest.workspaceId, "default");
          assert.equal(resumeRequest.expectedRevision, ready.body.revision);
          assert.equal(resumeRequest.actionId, ready.body.requiredAction.actionId);
          assert.equal(resumeRequest.actionNonce, ready.body.requiredAction.actionNonce);
          assert.deepEqual(resumeRequest.values, {});
          let completed;
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const result = await requestJson(
              stack.gatewayUrl,
              `/api/v1/change-plans/${receipt.planId}?workspaceId=default`,
            );
            assertOk(result, "read rule change settlement");
            completed = result.body;
            if (["completed", "applied"].includes(completed.status)) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          assert.ok(["completed", "applied"].includes(completed?.status), "The approved rule plan did not complete.");
          assert.equal(completed.origin?.workspaceId, "default");
          assert.deepEqual(completed.request, {
            kind: "runtime_configuration",
            change: { operation: "tool_approval_mode", mode: draftMode },
          });
          assert.equal(completed.target?.expectedRevision, after.body.revision);
          const saved = await requestJson(stack.gatewayUrl, "/api/v1/settings");
          assertOk(saved, "read approved rule owner");
          assert.equal(saved.body.toolApprovalMode, draftMode);
          assert.equal(saved.body.deploymentProfile, before.body.deploymentProfile);
          assert.ok(saved.body.revision > after.body.revision);
          await panel.getByRole("button", { name: "Refresh approval change", exact: true }).click();
          await panel.getByText("Change saved and confirmed.", { exact: false }).waitFor();
          await panel.getByText(`Current: ${RULE_LABELS[draftMode]}`, { exact: true }).waitFor();
          assert.equal(await select.inputValue(), draftMode);
          assert.equal(await panel.getByRole("button", { name: "Save approval rule", exact: true }).isDisabled(), true);
          assert.deepEqual(mutations, [
            "PATCH /api/v1/settings",
            `POST /api/v1/change-plans/${receipt.planId}/responses`,
          ]);
          await panel.scrollIntoViewIfNeeded();
          await audit("saved");
          await traffic.assertPageBackground(page, "default");
          await approvalTraffic.assertPageBackground(approvalPage, "default");
          assert.deepEqual(
            approvalTraffic.writes.map((entry) => `${entry.method} ${entry.pathname}`),
            [`POST /api/v1/approvals/${approvalId}/resolve`],
          );
          await approvalPage.close();
          return withOwnerDiagnosticResult({
            status: "passed",
            metrics: {
              savedRevision: saved.body.revision,
              rule: saved.body.toolApprovalMode,
              bypassReviewCancelled: true,
              failedReadFixture: true,
              failedReads,
              preservedDraft: true,
              settingsMutations: mutations.length,
              browserMutations: traffic.total + approvalTraffic.total,
              presenceMutations: traffic.presence.length + approvalTraffic.presence.length,
              observerRequests: traffic.observers.length + approvalTraffic.observers.length,
              reviewOwnerUnchanged: true,
              canonicalApprovalResolved: true,
              unapprovedContinuationBlocked: true,
              explicitApprovedContinuation: true,
              scopedInboxDeepLink: true,
              currentOwnerNotification: true,
              notificationWithoutReload: true,
              retainedInboxInvalidationBound: true,
              preEventInboxReadHeld: true,
              freshOwnerReadAfterSignal: true,
              exactRuleSaveVerified: true,
              blockingAxe: 0,
              overflow,
            },
            artifacts: emptyArtifacts({ screenshots, diagnostics }),
          }, diagnosticWriteFailure);
        } catch (error) {
          await retainDiagnostic();
          for (const [target, suffix] of [
            [page, "failure"],
            [approvalPage, "approval-failure"],
          ]) {
            if (!target || target.isClosed()) continue;
            try {
              const screenshotDir = path.join(context.artifactRoot, "screenshots");
              await mkdir(screenshotDir, { recursive: true });
              const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-approval-mode-${variant}-${suffix}.png`);
              await target.screenshot({ path: screenshot, fullPage: false });
              screenshots.push(relativeToRun(context, screenshot));
            } catch {
              /* Keep the first failure when screenshot capture is unavailable. */
            }
          }
          return withOwnerDiagnosticResult({
            status: "failed",
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            metrics: { settingsTraffic },
            artifacts: emptyArtifacts({ screenshots, diagnostics }),
          }, diagnosticWriteFailure);
        } finally {
          releaseHeldInboxRead();
          await browserContext.close();
        }
      },
    );
  }
}
