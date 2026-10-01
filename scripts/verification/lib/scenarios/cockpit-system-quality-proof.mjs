import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

export function assertQualityExportReceipt(kind, receipt, clipboard) {
  assert.equal(receipt.posture?.readOnly, true);
  assert.equal(receipt.posture?.sideEffectPosture, "audit_only");
  assert.equal(receipt.version, kind === "evaluations" ? "llm.eval_proof_export.v1" : "ops.quality_export.otel_json.v1");
  // Windows text clipboard APIs normalize LF to CRLF; preserve every other byte.
  assert.ok(clipboard.replaceAll("\r\n", "\n") === receipt.content.replaceAll("\r\n", "\n"),
    "Clipboard differs from the owner response beyond platform newline normalization");
  const copied = JSON.parse(clipboard);
  assert.equal(copied.version, receipt.version);
  assert.equal(copied.generatedAt, receipt.generatedAt);
  if (kind === "evaluations") assert.deepEqual(copied.runs, receipt.runs);
}

export function assertFirstBuiltinImport(definition, receipt, owner) {
  const expected = definition.importCapability;
  assert.deepEqual(receipt.importReceipt, { version: "prompt_pack.builtin_import_receipt.v1", operation: "created",
    packKey: definition.packKey, definitionRevision: expected.definitionRevision, contentSha256: expected.contentSha256 });
  assert.equal(receipt.pack.packId, expected.packId);
  assert.equal(receipt.pack.contentSha256, expected.contentSha256);
  assert.equal(receipt.pack.testCount, definition.testCount);
  assert.equal(owner.pack.packId, expected.packId);
  assert.equal(owner.pack.contentSha256, expected.contentSha256);
  assert.equal(owner.tests.length, definition.testCount);
  assert.equal(new Set(owner.tests.map((test) => test.testId)).size, definition.testCount);
  assert.ok(owner.tests.every((test) => test.packId === expected.packId));
  assert.deepEqual([...owner.tests].sort((a, b) => a.testId.localeCompare(b.testId)),
    [...receipt.tests].sort((a, b) => a.testId.localeCompare(b.testId)));
}

export async function runCockpitSystemQualityProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, requestJson, runScenario, path, buildVerificationUiUrl, installMissionControlNextBrowserState,
    auditPageAccessibility, axeSourcePath, relativeToRun, emptyArtifacts } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)), "Quality proof requires an isolated fixture runtime");
  const read = async (route, init) => {
    const response = await requestJson(stack.gatewayUrl, route, init);
    assertOk(response, route);
    return response.body;
  };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-system-quality.${variant}`, lane: "ux-budgets",
      title: `Cockpit System Quality exact evidence and read-only exports ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const token = randomUUID().slice(0, 8);
      const workspace = await read("/api/v1/workspaces", { method: "POST", body: { name: `Quality proof ${token}`, ...(citadelId ? { citadelId } : {}) } });
      assert.ok(workspace.workspaceId && workspace.citadelId);
      const config = await read("/api/v1/llm/config");
      const provider = config.providers.find((item) => item.providerId === config.activeProviderId) ?? config.providers[0];
      assert.ok(provider?.providerId && provider.defaultModel);
      const runIds = [];
      // This owner records existing measurements/operator scores; it does not dispatch a model.
      for (const score of [0.31, 0.82]) {
        const recorded = await read("/api/v1/llm/eval-proof", { method: "POST", body: {
          prompt: `Recorded synthetic quality comparison ${token} ${score}`,
          candidates: [{ providerId: provider.providerId, model: provider.defaultModel, qualityScore: score }],
        } });
        assert.ok(recorded.run?.runId); runIds.push(recorded.run.runId);
      }
      const imported = await read("/api/v1/prompt-packs/import", { method: "POST", body: {
        name: `Quality fixture ${token}`, sourceLabel: "Disposable Quality browser proof",
        content: `# Quality fixture ${token}\n\n## TEST-91: Recorded fixture\n\nInspect this synthetic fixture only.\n`,
      } });
      assert.ok(imported.pack?.packId);
      const browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark",
        permissions: ["clipboard-read", "clipboard-write"] });
      const screenshots = [], diagnostics = [];
      let page, stage = "setup";
      try {
        await browserContext.addInitScript((theme) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", theme);
        }, variant === "mobile" ? "light" : "dark");
        await installMissionControlNextBrowserState(browserContext, workspace.workspaceId, workspace.citadelId);
        page = await browserContext.newPage();
        const writes = [], ownerReads = [];
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (pathname.startsWith("/api/") && ["POST", "PATCH", "PUT", "DELETE"].includes(request.method())) writes.push(pathname);
          if (pathname === "/api/v1/ops/quality") ownerReads.push(request.url());
        });
        const snapshotResponse = page.waitForResponse((response) => response.request().method() === "GET"
          && new URL(response.url()).pathname === "/api/v1/ops/quality");
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/system/quality?shell=cockpit"), { waitUntil: "domcontentloaded" });
        const response = await snapshotResponse;
        assert.equal(response.ok(), true);
        const snapshot = await response.json();
        await page.getByRole("heading", { name: "Quality", exact: true }).waitFor();
        assert.equal(snapshot.metricScope.scope, "bounded_read");
        await page.getByText("Installation-wide stored evidence. Refresh and exports do not run evaluations.", { exact: true }).waitFor();
        stage = "exact prompt and security gate evidence";
        const packLink = page.getByRole("region", { name: "Prompt packs", exact: true }).getByRole("link", { name: `Review ${imported.pack.name}`, exact: true });
        const link = new URL(await packLink.getAttribute("href"), stack.uiUrl);
        assert.equal(link.searchParams.get("view"), `pack:${imported.pack.packId}`);
        assert.equal(link.searchParams.get("shell"), "classic");
        const packReportResponse = page.waitForResponse((result) => result.request().method() === "GET"
          && new URL(result.url()).pathname === `/api/v1/prompt-packs/${imported.pack.packId}/report`);
        await page.getByRole("button", { name: `Inspect ${imported.pack.name}`, exact: true }).click();
        const packReportResult = await packReportResponse;
        assert.equal(packReportResult.ok(), true);
        const packReport = await packReportResult.json();
        assert.equal(packReport.pack.packId, imported.pack.packId);
        const selectedPack = page.getByRole("region", { name: "Selected prompt pack", exact: true });
        await selectedPack.getByRole("heading", { name: imported.pack.name, exact: true }).waitFor();
        const totalTests = selectedPack.locator("dt").filter({ hasText: /^Total tests$/u }).locator("..").locator("dd");
        await totalTests.waitFor();
        assert.equal(Number(await totalTests.textContent()), packReport.summary.totalTests);
        const gate = snapshot.securityQualityGates.state === "available" ? snapshot.securityQualityGates.items[0] : undefined;
        if (gate) {
          await page.getByRole("button", { name: `Inspect ${gate.title}`, exact: true }).click();
          const detail = page.getByRole("region", { name: "Selected quality gate", exact: true });
          await detail.getByRole("heading", { name: gate.title, exact: true }).waitFor();
          for (const message of [...gate.blockers, ...gate.nextActions]) await detail.getByText(message, { exact: true }).waitFor();
        }
        await capture("gates");
        stage = "select exact evaluation";
        await page.getByRole("tab", { name: "Evaluations", exact: true }).click();
        for (const runId of runIds) {
          const index = snapshot.evalProof.items.findIndex((item) => item.runId === runId);
          assert.ok(index >= 0, "Owner snapshot omitted the recorded fixture evaluation");
          const owner = snapshot.evalProof.items[index];
          await page.getByRole("button", { name: `Inspect evaluation ${index + 1}`, exact: true }).click();
          const detail = page.getByRole("region", { name: "Selected evaluation", exact: true });
          const technical = detail.locator("details").filter({ has: page.locator("summary", { hasText: /^Technical evidence$/u }) });
          if (await technical.getAttribute("open") === null) await technical.locator("summary").click();
          await detail.getByText(owner.runId, { exact: true }).waitFor();
          await detail.getByText(owner.promptHash, { exact: true }).waitFor();
          await detail.getByText(`${provider.providerId} · ${provider.defaultModel}`, { exact: true }).waitFor();
          const score = await detail.locator("dt").filter({ hasText: /^Operator quality score$/u }).locator("..").locator("dd").textContent();
          assert.equal(Number(score), owner.results[0].qualityScore);
        }
        await capture("evaluation");
        stage = "design checks";
        await page.getByRole("tab", { name: "Design", exact: true }).click();
        const check = snapshot.designQuality.state === "available" ? snapshot.designQuality.checks[0] : undefined;
        if (check) {
          await page.getByRole("button", { name: "Inspect check 1", exact: true }).click();
          const detail = page.getByRole("region", { name: "Selected design check", exact: true });
          await detail.locator("p").filter({ hasText: new RegExp(`^${check.evidence.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u") }).waitFor();
          await detail.getByRole("heading", { name: check.label, exact: true }).waitFor();
        } else {
          await page.getByRole("region", { name: "Design quality checks", exact: true }).getByRole("status").waitFor();
        }
        stage = "read-only clipboard exports";
        await page.locator("summary").filter({ hasText: /^Evidence exports$/u }).click();
        for (const kind of ["evaluations", "quality"]) {
          const route = kind === "evaluations" ? "/api/v1/llm/eval-proof/export" : "/api/v1/ops/quality/export";
          const resultPromise = page.waitForResponse((result) => result.request().method() === "GET" && new URL(result.url()).pathname === route);
          await page.getByRole("button", { name: kind === "evaluations" ? "Copy evaluation evidence" : "Copy quality transport evidence", exact: true }).click();
          const result = await resultPromise;
          assert.equal(result.ok(), true);
          const receipt = await result.json();
          await page.getByText(kind === "evaluations" ? "Evaluation evidence copied." : "Quality transport evidence copied.", { exact: true }).waitFor();
          assertQualityExportReceipt(kind, receipt, await page.evaluate(() => navigator.clipboard.readText()));
        }
        assert.deepEqual(writes, [], "Inspecting Quality or copying evidence dispatched a mutation");
        assert.ok(ownerReads.length > 0);
        await capture("exports");
        stage = "reviewed first definition import";
        await page.getByRole("tab", { name: "Gates", exact: true }).click();
        const definitions = await read("/api/v1/prompt-packs/builtins");
        const builtin = definitions.items.find((item) => item.importCapability?.version === "prompt_pack.builtin_import.v1");
        assert.ok(builtin, "The matching Gateway must advertise a create-only definition owner");
        const definitionsPanel = page.getByRole("region", { name: "Defensive security definitions", exact: true });
        let firstImport = false;
        if (builtin.importCapability.targetState === "absent") {
          const reviewButton = definitionsPanel.getByRole("button", { name: `Review import: ${builtin.title}`, exact: true });
          await reviewButton.click();
          const review = page.getByRole("dialog", { name: "Import defensive definition?", exact: true });
          await review.waitFor();
          assert.ok((await review.innerText()).includes(`${builtin.testCount} tests`));
          assert.ok((await review.innerText()).includes("An existing pack is preserved"));
          await capture("definition-review");
          await review.getByRole("button", { name: "Keep definitions unchanged", exact: true }).click();
          await review.waitFor({ state: "hidden" });
          assert.deepEqual(writes, [], "Cancelled definition review issued a write");
          await reviewButton.click(); await review.waitFor();
          const route = `/api/v1/prompt-packs/builtins/${encodeURIComponent(builtin.packKey)}/import-if-absent`;
          const importResponse = page.waitForResponse((result) => result.request().method() === "POST" && new URL(result.url()).pathname === route);
          await review.getByRole("button", { name: "Import reviewed definition", exact: true }).click();
          const importedResponse = await importResponse;
          assert.equal(importedResponse.status(), 200);
          assert.deepEqual(importedResponse.request().postDataJSON(), { expectedDefinitionRevision: builtin.importCapability.definitionRevision });
          const receipt = await importedResponse.json();
          const owner = await read(`/api/v1/prompt-packs/${encodeURIComponent(builtin.importCapability.packId)}/report`);
          assertFirstBuiltinImport(builtin, receipt, owner);
          await definitionsPanel.getByText(`${owner.pack.name} imported and confirmed with ${owner.tests.length} tests. No evaluations were run.`, { exact: true }).waitFor();
          assert.deepEqual(writes, [route]);
          const rejected = await requestJson(stack.gatewayUrl, route, { method: "POST", body: { expectedDefinitionRevision: builtin.importCapability.definitionRevision } });
          assert.equal(rejected.status, 409, "The owner must reject replacement atomically");
          assert.equal(rejected.body.code, "WRITE_CONFLICT");
          assert.equal(rejected.body.details.reason, "PROMPT_PACK_ALREADY_EXISTS");
          assert.equal(rejected.body.details.mutationCommitted, false);
          const preserved = await read(`/api/v1/prompt-packs/${encodeURIComponent(builtin.importCapability.packId)}/report`);
          assert.deepEqual(preserved.pack, owner.pack); assert.deepEqual(preserved.tests, owner.tests);
          firstImport = true;
          await page.reload({ waitUntil: "domcontentloaded" });
          await definitionsPanel.getByRole("link", { name: "Inspect saved prompt pack", exact: true }).waitFor();
        } else {
          await definitionsPanel.getByRole("link", { name: "Inspect saved prompt pack", exact: true }).waitFor();
          assert.deepEqual(writes, [], "An occupied definition was reimported by inspection");
        }
        assert.equal(await definitionsPanel.getByRole("button", { name: `Review import: ${builtin.title}`, exact: true }).count(), 0,
          "An existing key remained offered as a first import");
        const ownerLink = new URL(await definitionsPanel.getByRole("link", { name: "Inspect saved prompt pack", exact: true }).getAttribute("href"), stack.uiUrl);
        assert.equal(ownerLink.searchParams.get("view"), `pack:${builtin.importCapability.packId}`);
        await capture("definition-saved");
        const diagnostic = path.join(context.artifactRoot, "diagnostics", `cockpit-system-quality-${variant}.json`);
        await mkdir(path.dirname(diagnostic), { recursive: true });
        await writeFile(diagnostic, `${JSON.stringify({ runIds, gateId: gate?.gateId, designCheckId: check?.id,
          designState: snapshot.designQuality.state, promptPackId: imported.pack.packId,
          firstImport, builtinPackKey: builtin.packKey,
          boundary: "Synthetic owner-recorded scores and definitions in an isolated runtime. Inspection/exports performed zero writes. Only explicit reviewed first import created a definition; no evaluations or provider calls were dispatched." }, null, 2)}\n`);
        diagnostics.push(relativeToRun(context, diagnostic));
        return { status: "passed", metrics: { exactEvaluations: 2, clipboardReadbacks: 2, browserMutations: writes.length,
          firstImport, occupiedDefinitionPreserved: true,
          gateInspected: Boolean(gate), designInspected: Boolean(check), designState: snapshot.designQuality.state },
          artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } catch (error) {
        await mkdir(path.join(context.artifactRoot, "diagnostics"), { recursive: true });
        await mkdir(path.join(context.artifactRoot, "screenshots"), { recursive: true });
        const diagnostic = path.join(context.artifactRoot, "diagnostics", `cockpit-system-quality-${variant}-failure.json`);
        await writeFile(diagnostic, `${JSON.stringify({ stage, runIds, error: String(error) }, null, 2)}\n`);
        diagnostics.push(relativeToRun(context, diagnostic));
        if (page) {
          const shot = path.join(context.artifactRoot, "screenshots", `cockpit-system-quality-${variant}-failure.png`);
          await page.screenshot({ path: shot, fullPage: false }).then(() => screenshots.push(relativeToRun(context, shot))).catch(() => {});
        }
        return { status: "failed", error: `${stage}: ${error.stack ?? error}`, metrics: { failedStage: stage }, artifacts: emptyArtifacts({ screenshots, diagnostics }) };
      } finally { await browserContext.close(); }
      async function capture(label) {
        await page.addScriptTag({ path: axeSourcePath });
        const audit = await auditPageAccessibility(page);
        assert.deepEqual(audit.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id), []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
        const shot = path.join(context.artifactRoot, "screenshots", `cockpit-system-quality-${variant}-${label}.png`);
        await mkdir(path.dirname(shot), { recursive: true });
        await page.screenshot({ path: shot, fullPage: false }); screenshots.push(relativeToRun(context, shot));
      }
    });
  }
}
