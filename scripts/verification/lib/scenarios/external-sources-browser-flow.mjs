// HX-407 C4b external-sources browser flow (closure packet
// docs/review/HX_407_CLOSURE_PACKET_2026-07-14.md, C4 row-completion rows 2/3):
// the complete Library→Chat selection/send/approval-recovery path driven in a
// REAL browser against the REAL gateway + mission-control-next stack, executed
// at desktop and mobile viewports in light and dark color schemes (viewport /
// scheme parametrization — no pixel baselines; pixel VR stays CI-gated).
//
// Harness convention: this repo's browser-driven proofs live in
// `scripts/verification/lib/scenarios/*.mjs` and drive Playwright chromium
// headless against `startVerificationStack` (real gateway via dev:gateway +
// the mc-next Vite dev server) — the deep-core / accessibility-smoke lanes'
// pattern. This spec follows it and is invoked by
// `scripts/verification/external-sources-proof.mjs` (the verify:external-sources
// lane), which parses the printed combo summary with a >0 honesty guard.
//
// The chat send needs a completing LLM turn, so the flow runs a loopback
// OpenAI-compatible stub provider (node:http, the catalog-parity fixture-server
// precedent + the gateway's own fake-openai-server test contract) and points
// the runtime-root llm-providers.json at it. Loopback provider base URLs are
// an explicitly supported local-inference posture (llm-service SSRF policy).
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import {
  buildVerificationProcessEnv,
  prepareVerificationRuntime,
  requestJson,
  startVerificationStack,
  stopVerificationStack,
} from "../runtime.mjs";
import { repoRoot } from "../shared.mjs";
import {
  appendTraceArtifact,
  attachBrowserLogging,
  captureBrowserArtifacts,
  setBrowserCorrelation,
  startBrowserTrace,
} from "./browser-helpers.mjs";
import {
  DETERMINISTIC_LLM_DEFAULT_REPLY,
  DETERMINISTIC_LLM_KEY_ENV,
  DETERMINISTIC_LLM_MODEL,
  DETERMINISTIC_LLM_PROVIDER_ID,
  startDeterministicLlmStub,
  writeDeterministicLlmProviderConfig,
} from "./deterministic-llm-stub.mjs";
import { resolveExternalSourcesSecretEnvKeys } from "./external-sources-environment.mjs";

const STUB_PROVIDER_ID = DETERMINISTIC_LLM_PROVIDER_ID;
const STUB_MODEL = DETERMINISTIC_LLM_MODEL;
const STUB_REPLY_TEXT = DETERMINISTIC_LLM_DEFAULT_REPLY;
const STUB_KEY_ENV = DETERMINISTIC_LLM_KEY_ENV;
const KNOWLEDGE_APPROVAL_KIND = "external_source.knowledge_snapshot";

/** Closure-packet row 3: light/dark × desktop/mobile. */
export const EXTERNAL_SOURCES_BROWSER_COMBOS = Object.freeze([
  { id: "desktop-dark", viewport: { width: 1440, height: 1024 }, colorScheme: "dark", theme: "dark" },
  { id: "desktop-light", viewport: { width: 1440, height: 1024 }, colorScheme: "light", theme: "light" },
  { id: "mobile-dark", viewport: { width: 390, height: 844 }, colorScheme: "dark", theme: "dark" },
  { id: "mobile-light", viewport: { width: 390, height: 844 }, colorScheme: "light", theme: "light" },
]);

export function formatBrowserFlowSummary(result) {
  return (
    `External-sources browser flow summary: combos ${result.combosPlanned} planned / ` +
    `${result.combosExecuted} executed / ${result.combosPassed} passed / ${result.combosFailed} failed; ` +
    `steps ${result.stepsExecuted}`
  );
}

export async function runExternalSourcesBrowserFlow({
  artifactRoot,
  log = (line) => process.stdout.write(`${line}\n`),
  secretEnvKeys,
  processLogPrefix,
}) {
  const resolvedSecretEnvKeys = await resolveExternalSourcesBrowserFlowSecretEnvKeys(secretEnvKeys);
  const runId = `external-sources-browser-${randomBytes(4).toString("hex")}`;
  const context = { artifactRoot, runId };
  await fs.mkdir(path.join(artifactRoot, "diagnostics"), { recursive: true });
  await fs.mkdir(path.join(artifactRoot, "screenshots"), { recursive: true });

  const fixtures = await importSyntheticFixtures();
  const stub = await startDeterministicLlmStub();
  let runtimeRoot;
  let stack;
  let browser;
  const comboResults = [];
  let stepsExecuted = 0;

  try {
    // The mc-next Vite dev server imports workspace packages from their BUILT
    // dist (threaded-surface-core, mission-control-shared, …). Rebuild the UI
    // dependency graph and drop the Vite dep-optimizer cache so the browser
    // proof always runs against the current sources, never a stale dist (the
    // documented shared-package staleness hazard).
    ensureUiWorkspaceDependenciesBuilt(resolvedSecretEnvKeys);
    await fs.rm(path.join(repoRoot, "apps", "mission-control-next", "node_modules", ".vite"), {
      recursive: true,
      force: true,
    });

    runtimeRoot = await prepareVerificationRuntime(runId);
    // Keep the repository's bundled runtime skills in place. The usability
    // campaign must exercise the same inspectable/callable catalog that ships;
    // deleting skills here would hide capability-id or sealing regressions.
    await writeDeterministicLlmProviderConfig(runtimeRoot, stub.baseUrl);
    log(`[browser-flow] stub LLM provider listening at ${stub.baseUrl}`);

    stack = await startVerificationStack(context, {
      runtimeRoot,
      includeUi: true,
      ...buildExternalSourcesProcessOptions({ secretEnvKeys: resolvedSecretEnvKeys, processLogPrefix }),
      gatewayEnv: {
        GOATCITADEL_RATE_LIMIT_ENABLED: "false",
        // The external-sources routes require a SPECIFIC authenticated
        // operator (token|basic|loopback actor) — `auth mode none` maps every
        // request to the rejected `auth:none` actor. Token mode with the
        // loopback bypass gives both the browser and this flow's API calls the
        // same real `loopback:127.0.0.1` operator identity, with no token
        // material in the UI.
        GOATCITADEL_AUTH_MODE: "token",
        GOATCITADEL_AUTH_TOKEN: `verification-browser-flow-${randomUUID()}`,
        GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
        [STUB_KEY_ENV]: "verification-stub-key",
      },
    });
    log(`[browser-flow] gateway ${stack.gatewayUrl} / ui ${stack.uiUrl}`);
    await ensureOnboardingComplete(stack.gatewayUrl);

    browser = await chromium.launch({ headless: true });
    for (const combo of EXTERNAL_SOURCES_BROWSER_COMBOS) {
      const result = await runCombo({ combo, stack, runtimeRoot, artifactRoot, fixtures });
      stepsExecuted += result.steps.length;
      comboResults.push(result);
      log(
        `[browser-flow] combo ${combo.id} (${combo.viewport.width}x${combo.viewport.height} ${combo.colorScheme}): ` +
          `${result.status.toUpperCase()} (${result.steps.filter((step) => step.status === "passed").length}/${result.steps.length} steps)` +
          (result.error ? ` — ${result.error}` : ""),
      );
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    if (stack) {
      await stopVerificationStack(stack);
    } else if (runtimeRoot) {
      await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    await stub.close().catch(() => undefined);
  }

  const result = {
    combosPlanned: EXTERNAL_SOURCES_BROWSER_COMBOS.length,
    combosExecuted: comboResults.length,
    combosPassed: comboResults.filter((combo) => combo.status === "passed").length,
    combosFailed: comboResults.filter((combo) => combo.status !== "passed").length,
    stepsExecuted,
    comboResults,
  };
  const reportPath = path.join(artifactRoot, "diagnostics", "external-sources-browser-flow.json");
  await fs.writeFile(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        stubProvider: { providerId: STUB_PROVIDER_ID, model: STUB_MODEL, requestPaths: stub.requestPaths() },
        ...result,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  result.reportPath = reportPath;
  log(formatBrowserFlowSummary(result));
  return result;

  async function runCombo({
    combo,
    stack: activeStack,
    runtimeRoot: activeRuntimeRoot,
    artifactRoot: root,
    fixtures: fx,
  }) {
    const steps = [];
    const comboState = {};
    const browserContext = await browser.newContext({
      viewport: combo.viewport,
      colorScheme: combo.colorScheme,
    });
    const page = await browserContext.newPage();
    const browserLog = attachBrowserLogging(page);
    const logCursor = browserLog.mark();
    const correlationId = `external-sources-${combo.id}-${randomUUID()}`;
    const failureSlug = `external-sources-flow-${combo.id}-failure`;
    const trace = await startBrowserTrace(context, { page, slug: failureSlug });
    page.setDefaultTimeout(30_000);

    const step = async (name, fn) => {
      const startedAt = Date.now();
      try {
        await fn();
        steps.push({ name, status: "passed", durationMs: Date.now() - startedAt });
      } catch (error) {
        steps.push({
          name,
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

    let comboError;
    let failureArtifacts;
    let artifactCaptureError;
    try {
      await step("seed-fixture-and-session", async () => {
        // The fixture root must live INSIDE the gateway's workspace root
        // (`<rootDir>/workspace`): the path-bridge service only verifies paths
        // within the workspace-allowed roots (the closure integration test
        // uses the same placement).
        const sourceRoot = path.join(activeRuntimeRoot, "workspace", "external-fixtures", combo.id);
        const sessionsDir = path.join(sourceRoot, "sessions", "2026", "07", "14");
        await fs.mkdir(sessionsDir, { recursive: true });
        const secondSessionId = deterministicUuid(combo.id);
        await fs.writeFile(
          path.join(sessionsDir, `rollout-2026-07-14T00-00-00-${fx.SYNTHETIC_SESSION_ID}.jsonl`),
          fx.SYNTHETIC_CODEX_ROLLOUT_JSONL,
          "utf8",
        );
        await fs.writeFile(
          path.join(sessionsDir, `rollout-2026-07-14T00-01-00-${secondSessionId}.jsonl`),
          fx.SYNTHETIC_CODEX_ROLLOUT_JSONL.replaceAll(fx.SYNTHETIC_SESSION_ID, secondSessionId),
          "utf8",
        );

        const verified = await requestJson(activeStack.gatewayUrl, "/api/v1/ops/workspace-path-bridges/resolve", {
          method: "POST",
          body: {
            verificationId: `browser-flow-${combo.id}`,
            workspaceId: "default",
            inputPath: sourceRoot,
            inputFlavor: hostPathFlavor(),
            targetFlavor: hostPathFlavor(),
            requireGitIdentity: false,
          },
        });
        if (!verified.ok) {
          throw new Error(`path-bridge resolve failed (${verified.status}): ${JSON.stringify(verified.body)}`);
        }
        comboState.snapshot = verified.body;
        if (!comboState.snapshot?.canonicalHostPath || !comboState.snapshot?.snapshotId) {
          throw new Error("path-bridge snapshot is missing canonicalHostPath/snapshotId");
        }

        const session = await requestJson(activeStack.gatewayUrl, "/api/v1/chat/sessions", {
          method: "POST",
          body: { title: `External sources browser ${combo.id}` },
        });
        if (!session.ok || !session.body?.sessionId) {
          throw new Error(`chat session create failed (${session.status}): ${JSON.stringify(session.body)}`);
        }
        comboState.sessionId = session.body.sessionId;

        // The routed-context send gate requires subagent policy OFF (the
        // frozen provider/model budget cannot be delegated); an operator sets
        // Subagents = "No subagents" in the context drawer. Session seeding is
        // API-driven in this flow, so apply the same real pref through the
        // exact prefs endpoint the drawer patches, before the UI loads it.
        const prefs = await requestJson(
          activeStack.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(comboState.sessionId)}/prefs`,
        );
        if (!prefs.ok || typeof prefs.body?.revision !== "number") {
          throw new Error(`chat session prefs read failed (${prefs.status}): ${JSON.stringify(prefs.body)}`);
        }
        const prefsPatch = await requestJson(
          activeStack.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(comboState.sessionId)}/prefs`,
          {
            method: "PATCH",
            body: { expectedRevision: prefs.body.revision, subagentPolicy: "off" },
          },
        );
        if (!prefsPatch.ok) {
          throw new Error(`chat session prefs patch failed (${prefsPatch.status}): ${JSON.stringify(prefsPatch.body)}`);
        }
      });

      await step("library-register-source", async () => {
        // The register form's "Expected workspace revision" is operator-typed
        // CAS input against the LIVE workspace aggregate (which chat-turn
        // execution in an earlier combo legitimately bumps). Read the same
        // server truth an operator would and type it into the form.
        const workspace = await requestJson(activeStack.gatewayUrl, "/api/v1/workspaces/default");
        if (!workspace.ok || typeof workspace.body?.revision !== "number") {
          throw new Error(`workspace revision read failed (${workspace.status}): ${JSON.stringify(workspace.body)}`);
        }
        await gotoRoute(page, activeStack.uiUrl, `/library/knowledge?theme=${combo.theme}`);
        await page.getByRole("button", { name: "Register source", exact: true }).click();
        comboState.sourceLabel = `Browser combo ${combo.id}`;
        await page.getByLabel("Label", { exact: true }).fill(comboState.sourceLabel);
        await page.getByLabel("Canonical root path").fill(comboState.snapshot.canonicalHostPath);
        await page.getByLabel("Path-bridge snapshot id").fill(comboState.snapshot.snapshotId);
        await page.getByLabel("Path-bridge snapshot sha256").fill(comboState.snapshot.snapshotSha256);
        await page.getByLabel("Accepted producer versions").fill(fx.SYNTHETIC_CODEX_PRODUCER_VERSION);
        await page.getByLabel("Expected workspace revision").fill(String(workspace.body.revision));
        await page.getByRole("button", { name: "Register the source" }).click();
        // Registration truth: the transient notice OR the registered source's
        // own scan control (the deterministic post-registration UI the next
        // step drives). Waiting on either de-flakes the notice race observed
        // once on mobile-light under load — a real wait condition, no sleeps.
        try {
          await page
            .getByText(`Registered ${comboState.sourceLabel}`, { exact: false })
            .or(page.getByRole("button", { name: `Run a sealed catalog scan of ${comboState.sourceLabel}` }))
            .first()
            .waitFor({ timeout: 60_000 });
        } catch (error) {
          // Post-mortem: read the server list to learn whether registration
          // actually landed (UI render gap) or never happened (request gap).
          const listed = await requestJson(
            activeStack.gatewayUrl,
            "/api/v1/library/external-sources?workspaceId=default",
          ).catch((listError) => ({ ok: false, status: String(listError) }));
          const labels =
            listed.ok && Array.isArray(listed.body?.items) ? listed.body.items.map((sourceRow) => sourceRow.label) : [];
          const firstLine = error instanceof Error ? error.message.split("\n")[0] : String(error);
          throw new Error(
            `${firstLine} — server external-sources list (status ${listed.status ?? "?"}) labels: ${JSON.stringify(labels).slice(0, 300)}`,
            { cause: error },
          );
        }
      });

      await step("library-scan-seals-catalog", async () => {
        await page.getByRole("button", { name: `Run a sealed catalog scan of ${comboState.sourceLabel}` }).click();
        await page.getByText("Scan sealed: 2 supported of 2 items.", { exact: false }).waitFor({ timeout: 60_000 });
      });

      await step("library-dry-run-plan", async () => {
        await page.locator(".mc-next-ext-source-catalog input[type=checkbox]").first().check();
        await page.getByRole("button", { name: "Create a dry-run import plan for the selected items" }).click();
        await page.getByText("Dry run sealed. Review the exact hashes, then apply.", { exact: false }).waitFor({
          timeout: 60_000,
        });
      });

      await step("library-apply-import", async () => {
        await page.getByRole("button", { name: "Apply the sealed import plan exactly" }).click();
        await page.getByText(/Import applied: 1 item\(s\)\./u).waitFor({ timeout: 60_000 });
        // The provenance panel surfaces the applied import id; capture it the
        // way an operator reads it, then load the same content-free provenance
        // detail the UI serves to learn the exact source/item identifiers.
        const provenanceText = await page.locator(".mc-next-ext-source-provenance").first().innerText();
        const importIdMatch = provenanceText.match(
          /external-import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u,
        );
        if (!importIdMatch) {
          throw new Error(`import id not visible in provenance panel: ${provenanceText.slice(0, 300)}`);
        }
        comboState.importId = importIdMatch[0];
        const detail = await requestJson(
          activeStack.gatewayUrl,
          `/api/v1/library/external-source-imports/${encodeURIComponent(comboState.importId)}?workspaceId=default`,
        );
        if (!detail.ok) {
          throw new Error(`import detail read failed (${detail.status})`);
        }
        comboState.sourceId = detail.body.intent.sourceId;
        comboState.itemId = detail.body.items[0].itemId;
        comboState.normalizedArtifactSha256 = detail.body.items[0].normalizedArtifactSha256;
        comboState.rawSha256 = detail.body.items[0].rawSha256;
      });

      await step("chat-attach-goes-live", async () => {
        await gotoRoute(
          page,
          activeStack.uiUrl,
          `/chat?sessionId=${encodeURIComponent(comboState.sessionId)}&theme=${combo.theme}`,
        );
        await page.getByLabel("Message composer").waitFor({ timeout: 60_000 });
        const strip = page.locator('section[aria-label="Read-only external source attachments"]');
        await strip.waitFor({ timeout: 60_000 });
        // C4b activation truth: the durable reload carried the incarnation, so
        // no disabled-mutation hint may be present.
        const stripText = await strip.innerText();
        if (stripText.includes("stay disabled until")) {
          throw new Error("external-source mutations are still disabled: the incarnation did not activate the strip");
        }
        await strip.getByRole("button", { name: "Attach imported item" }).click();
        await strip.getByLabel("Source id").fill(comboState.sourceId);
        await strip.getByLabel("Import id").fill(comboState.importId);
        await strip.getByLabel("Item id").fill(comboState.itemId);
        await strip.getByRole("button", { name: "Attach read-only" }).click();
        // The durable chip (its per-turn checkbox exists only once the C1
        // attach landed and the reload rendered it) is the attach truth; the
        // local notice only renders inside a non-empty thread timeline.
        await strip
          .getByRole("checkbox", { name: `Include external source ${comboState.itemId} in the next turn` })
          .waitFor({ timeout: 60_000 });
        await strip.getByText("Read-only", { exact: true }).first().waitFor();
        // Content-free chip truth: the CONTENT digests render truncated only
        // (the itemId is a server-derived identity that legitimately embeds
        // its own 64-hex digest), and no transcript bytes appear.
        const chipText = await strip.innerText();
        if (
          chipText.includes(comboState.normalizedArtifactSha256) ||
          (comboState.rawSha256 && chipText.includes(comboState.rawSha256))
        ) {
          throw new Error("a full content digest leaked into the attachment strip");
        }
        if (chipText.includes(fx.SYNTHETIC_CODEX_VISIBLE_USER_TEXT)) {
          throw new Error("transcript content leaked into the attachment strip");
        }
      });

      await step("select-attachment-for-turn", async () => {
        const strip = page.locator('section[aria-label="Read-only external source attachments"]');
        await strip
          .getByRole("checkbox", { name: `Include external source ${comboState.itemId} in the next turn` })
          .check();
        await strip.getByText("1 selected for the next turn", { exact: false }).waitFor();
      });

      await step("send-with-frozen-refs-clears-selection", async () => {
        await page.getByLabel("Message composer").fill("Please use the attached external source context.");
        await page.locator(".mc-next-composer-primary", { hasText: "Send" }).click();
        // The stub provider completes the real turn end-to-end. Scope the
        // reply wait to a thread turn so a stub-derived session TITLE can
        // never satisfy it.
        try {
          await page
            .locator(".mc-next-thread-turn-surface", { hasText: STUB_REPLY_TEXT })
            .first()
            .waitFor({ timeout: 120_000 });
        } catch (error) {
          // Post-mortem: the SERVER-side turn record is the diagnosis truth
          // (the UI banner is generic). Content-free: status + failure class.
          const diagnosis = await describeLatestTurn(activeStack.gatewayUrl, comboState.sessionId);
          const firstLine = error instanceof Error ? error.message.split("\n")[0] : String(error);
          throw new Error(`${firstLine} — server turn state: ${diagnosis}`, { cause: error });
        }
        // Selection clears ONLY after the successful send consumed the frozen refs.
        const strip = page.locator('section[aria-label="Read-only external source attachments"]');
        await strip.getByText("Select attachments to include in the next turn.", { exact: false }).waitFor({
          timeout: 60_000,
        });
      });

      await step("request-knowledge-copy", async () => {
        const strip = page.locator('section[aria-label="Read-only external source attachments"]');
        await strip.getByRole("button", { name: `Request a governed knowledge copy of ${comboState.itemId}` }).click();
        const notice = page.getByText(/Knowledge copy requested\. Resolve approval /u).first();
        await notice.waitFor({ timeout: 60_000 });
        const noticeText = await notice.innerText();
        const suffixMatch = noticeText.match(/Resolve approval ([0-9a-f-]{8}) /u);
        if (!suffixMatch) {
          throw new Error(`knowledge-request notice carried no approval reference: ${noticeText}`);
        }
        comboState.approvalIdSuffix = suffixMatch[1];
      });

      await step("approve-in-approvals-inbox", async () => {
        await gotoRoute(page, activeStack.uiUrl, `/ops/approvals?theme=${combo.theme}`);
        const pendingCard = page
          .locator("article, li, section")
          .filter({ has: page.getByText(KNOWLEDGE_APPROVAL_KIND, { exact: true }) })
          .filter({ has: page.getByRole("button", { name: "Approve now" }) })
          .first();
        await pendingCard.waitFor({ timeout: 60_000 });
        await pendingCard.getByRole("button", { name: "Approve now" }).click();
        await page.getByText("Approve this request?", { exact: false }).waitFor();
        await page.getByRole("button", { name: "Approve", exact: true }).click();
        // The pending knowledge approval leaves the queue once resolved.
        await page
          .getByRole("button", { name: "Approve now" })
          .first()
          .waitFor({ state: "detached", timeout: 60_000 })
          .catch(() => undefined);
      });

      await step("recovered-snapshot-visible-with-provenance", async () => {
        // The approval-resolution effects worker executes the recovered C2
        // apply; the Journey read surface is the operator-visible completion
        // evidence (the same truth the closure integration test asserts).
        const event = await pollForSnapshotCreated(activeStack.gatewayUrl, comboState.approvalIdSuffix, 120_000);
        comboState.approvalId = event.approvalId;

        await gotoRoute(page, activeStack.uiUrl, `/library/journey?theme=${combo.theme}`);
        await page.getByText("Journey timeline", { exact: false }).first().waitFor({ timeout: 60_000 });
        const snapshotRow = page.getByText("Snapshot created", { exact: true }).first();
        await snapshotRow.waitFor({ timeout: 60_000 });
        await snapshotRow.click();
        // The evidence panel renders the approval linkage and content-free
        // provenance (evidence refs + summary carry the full approval id).
        // Scope the wait to the DETAIL stack: the timeline list's own row body
        // also contains "approval · <id>" in a collapsed (hidden) preview and
        // a page-wide `.first()` would pin that hidden node forever.
        const evidencePanel = page.locator(".mc-next-settings-stack");
        await evidencePanel.getByText("Snapshot created", { exact: true }).first().waitFor({ timeout: 60_000 });
        await evidencePanel.getByText(comboState.approvalId, { exact: false }).first().waitFor({ timeout: 60_000 });
        const pageText = await page.locator("body").innerText();
        if (pageText.includes(fx.SYNTHETIC_CODEX_VISIBLE_USER_TEXT)) {
          throw new Error("transcript content leaked into the Journey provenance surface");
        }
      });

      await step("capture-evidence-screenshot", async () => {
        await page.screenshot({
          path: path.join(root, "screenshots", `external-sources-flow-${combo.id}.png`),
          fullPage: false,
        });
      });
    } catch (error) {
      comboError = error instanceof Error ? error.message : String(error);
      const retained = await retainExternalSourcesFailureEvidence(context, {
        page,
        browserLog,
        gatewayUrl: activeStack.gatewayUrl,
        correlationId,
        logCursor,
        slug: failureSlug,
        trace,
      });
      failureArtifacts = retained.artifacts;
      artifactCaptureError = retained.captureError;
    } finally {
      await trace.discard().catch(() => undefined);
      await browserContext.close().catch(() => undefined);
    }

    const browserSnapshot = browserLog.getSnapshot(logCursor);
    return {
      combo: combo.id,
      viewport: `${combo.viewport.width}x${combo.viewport.height}`,
      colorScheme: combo.colorScheme,
      status: comboError ? "failed" : "passed",
      ...(comboError ? { error: comboError } : {}),
      steps,
      pageErrors: browserSnapshot.pageErrors.map((error) => error.message),
      correlationId,
      ...(failureArtifacts ? { artifacts: failureArtifacts } : {}),
      ...(artifactCaptureError ? { artifactCaptureError } : {}),
      sessionId: comboState.sessionId,
      approvalId: comboState.approvalId,
    };

    function deterministicUuid(seed) {
      const hex = Buffer.from(`${seed}-second-session`).toString("hex").padEnd(32, "0").slice(0, 32);
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    }

    async function gotoRoute(activePage, uiUrl, href) {
      await activePage.goto(`${uiUrl}${href}`, { waitUntil: "domcontentloaded" });
      await activePage.waitForSelector(".mc-next-shell", { timeout: 60_000 });
      await activePage
        .waitForFunction(
          () =>
            !Array.from(document.querySelectorAll(".mc-next-blocks-loader-label")).some((label) =>
              label.textContent?.includes("Loading current route data"),
            ),
          undefined,
          { timeout: 60_000 },
        )
        .catch(() => undefined);
      await setBrowserCorrelation(activePage, correlationId, comboState.sessionId);
    }
  }
}

export async function resolveExternalSourcesBrowserFlowSecretEnvKeys(secretEnvKeys, options, deps) {
  return await resolveExternalSourcesSecretEnvKeys({ secretEnvKeys, ...options }, deps);
}

export function buildExternalSourcesProcessOptions({ secretEnvKeys = [], processLogPrefix } = {}) {
  const omitEnv = [...new Set(secretEnvKeys.filter((key) => typeof key === "string" && key.length > 0))];
  return {
    gatewayEnvOmit: omitEnv,
    uiEnvOmit: omitEnv,
    ...(typeof processLogPrefix === "string" && processLogPrefix.trim()
      ? { processLogPrefix: processLogPrefix.trim() }
      : {}),
  };
}

export async function retainExternalSourcesFailureEvidence(
  context,
  input,
  deps = { appendTraceArtifact, captureBrowserArtifacts },
) {
  let artifacts = {
    diagnostics: [],
    screenshots: [],
    traces: [],
    logs: [],
    perf: [],
    playwright: [],
  };
  const captureErrors = [];
  try {
    artifacts = await deps.captureBrowserArtifacts(context, input);
  } catch (error) {
    captureErrors.push(`browser/Gateway bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    artifacts = deps.appendTraceArtifact(artifacts, await input.trace.retain());
  } catch (error) {
    captureErrors.push(`Playwright trace: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    artifacts,
    ...(captureErrors.length > 0 ? { captureError: captureErrors.join("; ") } : {}),
  };
}

/**
 * Content-free server-side post-mortem for a failed send wait: the latest
 * thread turn's status + failure record is the diagnosis truth (the UI banner
 * is generic).
 */
async function describeLatestTurn(gatewayUrl, sessionId) {
  try {
    const thread = await requestJson(gatewayUrl, `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`);
    if (!thread.ok) {
      return `thread read failed (${thread.status})`;
    }
    const turns = Array.isArray(thread.body?.turns) ? thread.body.turns : [];
    const latest = turns.at(-1);
    if (!latest) {
      return "no thread turns exist — the send never created a turn";
    }
    const trace = latest.trace ?? {};
    return (
      `turn ${latest.turnId ?? "?"} status=${trace.status ?? "?"} ` +
      `failure=${JSON.stringify(trace.failure ?? null)?.slice(0, 400)}`
    );
  } catch (error) {
    return `diagnosis failed: ${String(error)}`;
  }
}

async function pollForSnapshotCreated(gatewayUrl, approvalIdSuffix, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastBody = "";
  while (Date.now() < deadline) {
    const response = await requestJson(
      gatewayUrl,
      "/api/v1/journey/events?workspaceId=default&eventTypes=knowledge_snapshot_lifecycle",
    );
    if (response.ok) {
      lastBody = JSON.stringify(response.body).slice(0, 600);
      const items = Array.isArray(response.body?.items) ? response.body.items : [];
      const match = items.find(
        (item) =>
          item?.action === "snapshot_created" &&
          typeof item?.approvalId === "string" &&
          item.approvalId.includes(approvalIdSuffix),
      );
      if (match) {
        return match;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `snapshot_created Journey evidence for approval …${approvalIdSuffix} did not appear within ${timeoutMs}ms. Last body: ${lastBody}`,
  );
}

function hostPathFlavor() {
  return process.platform === "win32" ? "windows_native" : "windows_forward";
}

function ensureUiWorkspaceDependenciesBuilt(secretEnvKeys = []) {
  const args = ["--dir", repoRoot, "--filter", "@goatcitadel/mission-control-next^...", "build"];
  const isWindows = process.platform === "win32";
  const cmdPath = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe");
  const result = isWindows
    ? spawnSync(cmdPath, ["/d", "/s", "/c", "pnpm.cmd", ...args], {
        cwd: repoRoot,
        env: buildVerificationProcessEnv(process.env, {}, secretEnvKeys),
        encoding: "utf8",
        windowsHide: true,
      })
    : spawnSync("pnpm", args, {
        cwd: repoRoot,
        env: buildVerificationProcessEnv(process.env, {}, secretEnvKeys),
        encoding: "utf8",
        windowsHide: true,
      });
  if (result.error || result.status !== 0) {
    throw new Error(
      `UI workspace dependency build failed (${result.status ?? "spawn error"}): ${String(result.stderr ?? result.error ?? "").slice(-600)}`,
    );
  }
}

async function importSyntheticFixtures() {
  const fixturePath = path.join(
    repoRoot,
    "apps",
    "gateway",
    "dist",
    "services",
    "external-source-adapters",
    "fixtures",
    "synthetic-fixtures.js",
  );
  try {
    return await import(pathToFileURL(fixturePath).href);
  } catch (error) {
    throw new Error(
      `synthetic external-source fixtures are not built at ${fixturePath} — run the gateway workspace build first`,
      { cause: error },
    );
  }
}

async function ensureOnboardingComplete(gatewayUrl) {
  const state = await requestJson(gatewayUrl, "/api/v1/onboarding/state");
  if (state.ok && state.body?.completed) {
    return;
  }
  const completed = await requestJson(gatewayUrl, "/api/v1/onboarding/complete", {
    method: "POST",
    body: { completedBy: "verification-external-sources-browser" },
  });
  if (!completed.ok) {
    throw new Error(`onboarding completion failed: ${JSON.stringify(completed.body)}`);
  }
}

// Standalone execution for development: node scripts/verification/lib/scenarios/external-sources-browser-flow.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifactRoot = path.join(
    repoRoot,
    "artifacts",
    "verification",
    `${new Date().toISOString().replaceAll(":", "-").replace(".", "-")}-external-sources-browser-standalone`,
  );
  const result = await runExternalSourcesBrowserFlow({ artifactRoot });
  process.exitCode = result.combosFailed === 0 && result.combosPassed === result.combosPlanned ? 0 : 1;
}
