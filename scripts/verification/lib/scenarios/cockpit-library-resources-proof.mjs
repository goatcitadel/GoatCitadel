import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { seedVisibleChatArtifact } from "./chat-artifact-fixture.mjs";

export function assertLibraryResourceOwnerAgreement(kind, items, workspaceId, expectedId) {
  assert.ok(Array.isArray(items), `${kind} owner returned no item collection`);
  const identity = kind === "memory" ? "itemId" : kind === "notes" ? "noteId" : kind === "files" ? "relativePath" : "artifactId";
  const item = items.find((entry) => entry[identity] === expectedId);
  assert.ok(item, `The seeded ${kind} record is absent from its actual owner window`);
  if (kind !== "files") assert.equal(item.workspaceId, workspaceId, `${kind} record has a foreign scope`);
  if (kind === "artifacts") {
    assert.ok(item.contentHash && /^[a-f0-9]{64}$/iu.test(item.contentHash));
    assert.ok(Number.isSafeInteger(item.version) && item.version > 0);
  }
  return item;
}

export async function runCockpitLibraryResourcesProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-library-resources.${variant}`, lane: "ux-budgets",
      title: `Cockpit Library resource owner inspection ${variant}`, subsystem: "mission-control-ux" }, async () => {
      assert.ok(stack.runtimeRoot && /^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)),
        "Library resource proof requires the disposable usability runtime");
      const { workspaceId, artifact } = await seedVisibleChatArtifact(stack.gatewayUrl, { requestJson, assertOk });
      const token = randomUUID();
      const content = `Synthetic Library inspection fixture ${token}.`;
      const title = `Library resource proof ${token}`;
      const memory = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/memory-item-seed", {
        method: "POST", body: { workspaceId, namespace: "verification-library", title, content, metadata: { source: "verification" } },
      });
      assertOk(memory, "seed isolated Library memory");
      const note = await requestJson(stack.gatewayUrl, "/api/v1/notes", {
        method: "POST", body: { workspaceId, title, body: content },
      });
      assertOk(note, "create isolated Library note");
      // Files walks the root before applying its bounded window. Earlier Work
      // proofs create >100 files, so keep this fixture before those directories.
      // The owner agreement below still requires it in the actual returned window.
      const relativePath = `000-library-resource-${token}.txt`;
      const file = await requestJson(stack.gatewayUrl, "/api/v1/files/upload", {
        method: "POST", body: { relativePath, content },
      });
      assertOk(file, "create isolated shared Library file");
      const expected = [
        { kind: "memory", label: "Memory", id: memory.body?.itemId, title, content,
          ownerPath: `/api/v1/memory/items?${new URLSearchParams({ workspaceId, status: "active", limit: "100" })}` },
        { kind: "notes", label: "Notes", id: note.body?.noteId, title, content,
          ownerPath: `/api/v1/notes?${new URLSearchParams({ workspaceId, lifecycleStatus: "active" })}` },
        { kind: "files", label: "Files", id: relativePath, title: relativePath, content,
          ownerPath: "/api/v1/files/list?dir=.&limit=100" },
        { kind: "artifacts", label: "Artifacts", id: artifact.artifactId, title: artifact.title,
          ownerPath: `/api/v1/chat/generated-artifacts?${new URLSearchParams({ workspaceId, citadelId, limit: "100" })}` },
      ];
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      let page;
      let stage = "browser setup";
      let ownerEvidence = {};
      const screenshots = [];
      try {
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
        page = await browserContext.newPage();
        const reads = [], mutations = [];
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (pathname.startsWith("/api/v1/")) {
            if (request.method() === "GET") reads.push(request.url());
            else if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) mutations.push(pathname);
          }
        });
        stage = "open Library";
        await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/memory?shell=cockpit"), { waitUntil: "domcontentloaded" });
        for (const entry of expected) {
          stage = `${entry.kind}: read owner`;
          ownerEvidence = { resourceKind: entry.kind };
          assert.ok(entry.id, `Missing seeded ${entry.kind} ID`);
          const owner = await requestJson(stack.gatewayUrl, entry.ownerPath);
          ownerEvidence = { resourceKind: entry.kind, ownerStatus: owner.status,
            ownerItemCount: Array.isArray(owner.body?.items) ? owner.body.items.length : null };
          assertOk(owner, `read actual ${entry.kind} owner`);
          stage = `${entry.kind}: match owner window`;
          const record = assertLibraryResourceOwnerAgreement(entry.kind, owner.body?.items, workspaceId, entry.id);
          stage = `${entry.kind}: open directory`;
          await page.getByRole("navigation", { name: "Library sections", exact: true }).getByRole("link", { name: entry.label, exact: true }).click();
          const section = page.getByRole("region", { name: `Library ${entry.label}`, exact: true });
          const inspect = section.getByRole("button", { name: `Inspect ${entry.title.slice(0, 300)}`, exact: true });
          await inspect.waitFor({ timeout: 30_000 });
          if (entry.kind === "files") await section.getByText("Installation shared files. Workspace selection does not change this file root.", { exact: true }).waitFor();
          if (entry.kind === "artifacts") assert.equal(reads.filter((url) => new URL(url).pathname === `/api/v1/chat/generated-artifacts/${encodeURIComponent(entry.id)}`).length, 0);
          if (entry.kind === "files") assert.equal(reads.filter((url) => new URL(url).pathname === "/api/v1/files/download").length, 0);
          const artifactResponse = entry.kind === "artifacts" ? page.waitForResponse((response) =>
            new URL(response.url()).pathname === `/api/v1/chat/generated-artifacts/${encodeURIComponent(entry.id)}`) : null;
          stage = `${entry.kind}: inspect preview`;
          await inspect.click();
          const detail = page.getByRole("dialog", { name: `${entry.label} preview`, exact: true });
          await detail.waitFor();
          await detail.getByRole("heading", { name: entry.title.slice(0, 300), exact: true }).first().waitFor();
          if (entry.content) await detail.getByText(entry.content, { exact: true }).waitFor();
          if (entry.kind === "artifacts") {
            const actualResponse = await artifactResponse;
            assert.equal(actualResponse.status(), 200);
            const actual = (await actualResponse.json()).item;
            assert.equal(actual.workspaceId, workspaceId);
            assert.equal(actual.version, record.version);
            assert.equal(actual.contentHash, record.contentHash);
            await detail.locator(".generated-artifact-viewer").waitFor();
            await detail.getByRole("link", { name: "Open artifact conversation", exact: true }).waitFor();
            assert.ok(reads.some((url) => new URL(url).pathname === `/api/v1/chat/generated-artifacts/${encodeURIComponent(entry.id)}`));
            const exact = await requestJson(stack.gatewayUrl, `/api/v1/chat/generated-artifacts/${encodeURIComponent(entry.id)}?${new URLSearchParams({ workspaceId, citadelId })}`);
            assertOk(exact, "read exact artifact owner");
            assert.equal(exact.body?.item?.version, record.version);
            assert.equal(exact.body?.item?.contentHash, record.contentHash);
            assert.equal(actual.content, exact.body?.item?.content);
            assert.equal(await detail.locator('[role="alert"]').count(), 0);
          }
          stage = `${entry.kind}: accessibility and screenshot`;
          await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
          await page.addScriptTag({ path: axeSourcePath });
          const axe = await auditPageAccessibility(page);
          const blocking = axe.violations.filter((issue) => ["serious", "critical"].includes(issue.impact));
          assert.equal(blocking.length, 0, `${entry.kind} accessibility violations: ${blocking.map((issue) => issue.id).join(", ")}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 1, `${entry.kind} horizontal overflow: ${overflow}px`);
          const screenshot = path.join(context.artifactRoot, "screenshots", `ux-budgets-cockpit-library-${entry.kind}-${variant}.png`);
          await mkdir(path.dirname(screenshot), { recursive: true });
          await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot));
          stage = `${entry.kind}: close preview`;
          await detail.getByRole("button", { name: "Close sheet", exact: true }).click();
          await detail.waitFor({ state: "hidden" });
        }
        stage = "verify read-only inspection";
        assert.deepEqual(mutations, [], "Library inspection must not issue runtime mutations");
        return { status: "passed", metrics: { workspaceId, resourcesInspected: expected.length, ownerRecordsMatched: true,
          explicitPreview: true, readOnlyInspection: true, filesScope: "installation_shared", seededArtifact: true },
        artifacts: emptyArtifacts({ screenshots }) };
      } catch (error) {
        if (page && !page.isClosed()) {
          const screenshot = path.join(context.artifactRoot, "screenshots", `ux-budgets-cockpit-library-resources-${variant}-failure.png`);
          try { await mkdir(path.dirname(screenshot), { recursive: true }); await page.screenshot({ path: screenshot, fullPage: false }); screenshots.push(relativeToRun(context, screenshot)); } catch { /* Keep original failure. */ }
        }
        return { status: "failed", error: `${stage}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
          metrics: { failedStage: stage, ...ownerEvidence }, artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
