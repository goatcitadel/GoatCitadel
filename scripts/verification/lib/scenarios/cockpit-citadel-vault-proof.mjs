import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export function assertVaultUnavailableAgreement({ before, request, status, response, owner }) {
  assert.equal(status, 503);
  assert.deepEqual(response, { error: "Vault is unavailable — the secret store could not provide a key." });
  assert.deepEqual(Object.keys(request).sort(), ["expectedRevision", "name", "value"]);
  assert.equal(request.expectedRevision, before.revision);
  assert.match(request.name, /^ux-vault-(desktop|mobile)-\d+$/u);
  assert.equal(request.value, "synthetic-vault-proof-input");
  assert.deepEqual(owner, before, "An unavailable keychain must not change Vault metadata.");
  assert.match(owner.revision, /^[a-f0-9]{64}$/u);
  assert.ok(owner.items.every(item => Object.keys(item).every(key => ["secretId", "secretName", "createdAt", "updatedAt"].includes(key))));
}

/** Real metadata/read/cancel and unavailable-keychain owner response. Never enables a keychain backend. */
export async function runCockpitCitadelVaultProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)));
  const vaultPath = `/api/v1/citadels/${encodeURIComponent(citadelId)}/vault-secrets`;
  const read = async () => { const result = await requestJson(stack.gatewayUrl, vaultPath); assertOk(result, vaultPath); return result.body; };
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-citadel-vault.${variant}`, lane: "ux-budgets",
      title: `Native Citadel Vault metadata and unavailable custody ${variant}`, subsystem: "mission-control-ux" }, async () => {
      let stage = "read isolated Vault metadata", page, browserContext;
      const screenshots = [], writes = [], unexpected = [], screenshotDir = path.join(context.artifactRoot, "screenshots");
      try {
        const before = await read(), name = `ux-vault-${variant}-${Date.now()}`;
        assert.equal(before.citadelId, citadelId); assert.match(before.revision, /^[a-f0-9]{64}$/u);
        const theme = variant === "mobile" ? "light" : "dark";
        browserContext = await browser.newContext({ viewport, colorScheme: theme });
        await browserContext.addInitScript(value => { window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"); window.localStorage.setItem("goatcitadel.ui.theme.v1", value); }, theme);
        await installMissionControlNextBrowserState(browserContext, "default", citadelId);
        page = await browserContext.newPage();
        page.on("request", request => {
          const pathname = new URL(request.url()).pathname;
          if (request.method() === "GET" && pathname.endsWith("/reveal")) unexpected.push("Unrequested secret reveal");
          if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) || !pathname.startsWith("/api/v1/")) return;
          if (request.method() === "POST" && pathname === vaultPath) writes.push(request.postDataJSON());
          else unexpected.push(`${request.method()} ${pathname}`);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/citadel?shell=cockpit#citadel-vault"), { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
        const panel = page.getByRole("region", { name: "Citadel Vault", exact: true });
        await panel.getByRole("button", { name: "Store secret", exact: true }).waitFor();
        for (const item of before.items.slice(0, 50)) await panel.getByRole("button", { name: `Inspect ${item.secretName}`, exact: true }).waitFor();
        await capture("metadata");
        stage = "cancel and discard unsaved synthetic input without a write";
        await panel.getByRole("button", { name: "Store secret", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "Store a secret", exact: true });
        await editor.getByLabel("Secret name", { exact: true }).fill(name);
        await editor.getByLabel("Secret value", { exact: true }).fill("synthetic-vault-proof-input");
        await editor.getByRole("button", { name: "Close secret editor", exact: true }).click();
        const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
        await leave.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(await editor.getByLabel("Secret value", { exact: true }).inputValue(), "synthetic-vault-proof-input");
        assert.deepEqual(writes, []);
        await editor.getByRole("button", { name: "Close secret editor", exact: true }).click();
        await leave.getByRole("button", { name: "Discard changes", exact: true }).click();
        await panel.getByRole("button", { name: "Store secret", exact: true }).click();
        assert.equal(await editor.getByLabel("Secret value", { exact: true }).inputValue(), "");
        assert.deepEqual(await read(), before); assert.deepEqual(writes, []);
        stage = "show actual unavailable keychain response without canonical write";
        await editor.getByLabel("Secret name", { exact: true }).fill(name);
        await editor.getByLabel("Secret value", { exact: true }).fill("synthetic-vault-proof-input");
        const responsePromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === vaultPath);
        await editor.getByRole("button", { name: "Seal & store", exact: true }).click();
        const response = await responsePromise;
        assertVaultUnavailableAgreement({ before, request: writes[0], status: response.status(), response: await response.json(), owner: await read() });
        await editor.getByText(/^Vault unavailable/).waitFor();
        assert.equal(await editor.getByLabel("Secret value", { exact: true }).inputValue(), "synthetic-vault-proof-input");
        // Clear synthetic plaintext before screenshots or retained artifact assembly.
        await editor.getByLabel("Secret value", { exact: true }).fill("");
        writes[0].value = "[synthetic input omitted]";
        await capture("unavailable");
        assert.equal(writes.length, 1); assert.deepEqual(unexpected, []);
        return { status: "passed", metrics: { metadataOwnerAgreement: true, cancelledWrites: 0, browserStoreAttempts: 1,
          confirmedCanonicalWrites: 0, explicitRevealRequests: 0, unavailableKeychainConfirmed: true, secretInputDiscarded: true, blockingAxe: 0,
          limitation: "Disabled-keychain fixture. Successful sealing, replacement, deletion and reveal are source-owner tests, not live credential custody proof." }, artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) { try { await page.locator('input[type="password"]').fill(""); await capture("failure", false); } catch { /* No secret-bearing fallback capture. */ } }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, browserStoreAttempts: writes.length, unexpectedMutations: unexpected }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { for (const write of writes) delete write.value; await browserContext?.close(); }
      async function capture(name, audit = true) {
        await mkdir(screenshotDir, { recursive: true });
        if (audit) { await page.addScriptTag({ path: axeSourcePath }); const result = await auditPageAccessibility(page);
          assert.deepEqual(result.violations.filter(item => ["serious", "critical"].includes(item.impact)).map(item => item.id), []);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1); }
        const file = path.join(screenshotDir, `ux-budgets-cockpit-citadel-vault-${variant}-${name}.png`);
        await page.screenshot({ path: file, fullPage: false }); screenshots.push(relativeToRun(context, file));
      }
    });
  }
}
