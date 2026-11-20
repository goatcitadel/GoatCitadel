import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { classifyCockpitProofWrite } from "./cockpit-proof-writes.mjs";

const HOLD_MESSAGE = "Storing and revealing secrets are disabled in this release.";

export function assertVaultReleaseHoldAgreement({ citadelId, before, owner, browserOperations }) {
  assert.equal(owner.citadelId, citadelId);
  assert.equal(owner.keys?.cryptoAvailability, "release_hold");
  assert.deepEqual(owner, before, "Refreshing and inspecting a held Vault must preserve its metadata.");
  assert.deepEqual(browserOperations, [], "Inspecting a held Vault must not request a write or a reveal.");
  assert.match(owner.revision, /^[a-f0-9]{64}$/u);
  assert.ok(
    owner.items.every((item) =>
      Object.keys(item).every((key) =>
        ["secretId", "secretName", "createdAt", "updatedAt", "chamberId", "keyVersion"].includes(key),
      ),
    ),
  );
}

/** Real metadata and refresh proof for a Gateway running with the release hold. */
export async function runCockpitCitadelVaultProof({ context, browser, stack, citadelId, viewports, deps }) {
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
  assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)));
  const vaultPath = `/api/v1/citadels/${encodeURIComponent(citadelId)}/vault-secrets`;
  const read = async () => {
    const result = await requestJson(stack.gatewayUrl, vaultPath);
    assertOk(result, vaultPath);
    return result.body;
  };
  for (const { variant, viewport } of viewports) {
    await runScenario(
      context,
      {
        id: `ux-budgets.cockpit-citadel-vault.${variant}`,
        lane: "ux-budgets",
        title: `Native Citadel Vault metadata during the release hold ${variant}`,
        subsystem: "mission-control-ux",
      },
      async () => {
        let stage = "read isolated Vault metadata",
          page,
          browserContext;
        const screenshots = [],
          browserOperations = [],
          screenshotDir = path.join(context.artifactRoot, "screenshots");
        try {
          const before = await read();
          assert.equal(before.citadelId, citadelId);
          assert.match(before.revision, /^[a-f0-9]{64}$/u);
          assert.equal(before.keys?.cryptoAvailability, "release_hold");
          const theme = variant === "mobile" ? "light" : "dark";
          browserContext = await browser.newContext({ viewport, colorScheme: theme });
          await browserContext.addInitScript((value) => {
            window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
            window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
          }, theme);
          await installMissionControlNextBrowserState(browserContext, "default", citadelId);
          page = await browserContext.newPage();
          page.on("request", (request) => {
            const pathname = new URL(request.url()).pathname;
            const method = request.method();
            const reveal = method === "GET" && pathname.startsWith(`${vaultPath}/`) && pathname.endsWith("/reveal");
            if (reveal || classifyCockpitProofWrite(method, pathname) === "owner") {
              browserOperations.push(`${method} ${pathname}`);
            }
          });
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/settings/citadel?shell=cockpit#citadel-vault"), {
            waitUntil: "domcontentloaded",
          });
          await page.waitForSelector('[data-cockpit-ready="true"]', { timeout: 30_000 });
          const panel = page.getByRole("region", { name: "Citadel Vault", exact: true });
          await panel.getByText(HOLD_MESSAGE, { exact: true }).waitFor();
          const store = panel.getByRole("button", { name: "Store secret", exact: true });
          assert.equal(await store.isDisabled(), true);
          assert.equal(await page.getByRole("dialog", { name: "Store a secret", exact: true }).count(), 0);
          for (const item of before.items.slice(0, 50))
            await panel.getByRole("button", { name: `Inspect ${item.secretName}`, exact: true }).waitFor();
          stage = "refresh held Vault metadata";
          const responsePromise = page.waitForResponse(
            (response) => response.request().method() === "GET" && new URL(response.url()).pathname === vaultPath,
          );
          await panel.getByRole("button", { name: "Refresh Vault metadata", exact: true }).click();
          const response = await responsePromise;
          assert.equal(response.status(), 200);
          assertVaultReleaseHoldAgreement({ citadelId, before, owner: await response.json(), browserOperations });
          await panel
            .getByRole("button", { name: "Refresh Vault metadata", exact: true })
            .and(page.locator("button:enabled"))
            .waitFor();
          assert.equal(await store.isDisabled(), true);
          await capture("held");
          const first = before.items[0];
          if (first) {
            stage = "inspect stored metadata during the release hold";
            await panel.getByRole("button", { name: `Inspect ${first.secretName}`, exact: true }).click();
            const inspection = page.getByRole("dialog", { name: first.secretName, exact: true });
            await inspection.getByText(HOLD_MESSAGE, { exact: true }).waitFor();
            assert.equal(
              await inspection.getByRole("button", { name: "Reveal secret", exact: true }).isDisabled(),
              true,
            );
            await capture("inspection");
            await page.keyboard.press("Escape");
            await inspection.waitFor({ state: "hidden" });
          }
          assertVaultReleaseHoldAgreement({ citadelId, before, owner: await read(), browserOperations });
          return {
            status: "passed",
            metrics: {
              metadataOwnerAgreement: true,
              releaseHoldConfirmed: true,
              browserStoreAttempts: 0,
              explicitRevealRequests: 0,
              inspectedStoredEntry: Boolean(first),
              blockingAxe: 0,
              limitation:
                "The Gateway's release hold was active. This scenario verifies availability and metadata recovery.",
            },
            artifacts: emptyArtifacts({ screenshots }),
          };
        } catch (error) {
          if (page && !page.isClosed() && !browserOperations.length) {
            try {
              await capture("failure", false);
            } catch {
              /* The page may have closed during failure. */
            }
          }
          return {
            status: "failed",
            error: `${stage}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
            metrics: { failedStage: stage, browserOperations },
            artifacts: emptyArtifacts({ screenshots }),
          };
        } finally {
          await browserContext?.close();
        }
        async function capture(name, audit = true) {
          await mkdir(screenshotDir, { recursive: true });
          if (audit) {
            await page.addScriptTag({ path: axeSourcePath });
            const result = await auditPageAccessibility(page);
            assert.deepEqual(
              result.violations.filter((item) => ["serious", "critical"].includes(item.impact)).map((item) => item.id),
              [],
            );
            assert.ok(
              (await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
              )) <= 1,
            );
          }
          const file = path.join(screenshotDir, `ux-budgets-cockpit-citadel-vault-${variant}-${name}.png`);
          await page.screenshot({ path: file, fullPage: false });
          screenshots.push(relativeToRun(context, file));
        }
      },
    );
  }
}
