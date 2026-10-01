import { mkdir } from "node:fs/promises";

export async function runCockpitWorkArtifactProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-work-artifact.${variant}`, lane: "ux-budgets",
      title: `Cockpit Work artifact preview ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
        method: "POST", body: { workspaceName: `Work artifact ${variant}`, sessionTitle: "Work artifact owner", sessionCount: 1, longThreadTurns: 2 },
      });
      assertOk(seeded, "seed Work artifact workspace");
      const { workspaceId, sessionId } = seeded.body ?? {};
      if (!workspaceId || !sessionId) throw new Error("Work artifact fixture has no workspace and session.");
      const route = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`;
      const input = { action: "send", content: "Reply with the verification summary.", mode: "chat", webMode: "off", memoryMode: "off" };
      const preflight = await requestJson(stack.gatewayUrl, `${route}/route-preflight`, { method: "POST", body: input });
      assertOk(preflight, "preflight Work artifact conversation");
      const decision = preflight.body?.decision;
      if (!decision?.effectiveProviderId || !decision.effectiveModel) throw new Error("Work artifact preflight has no effective model route.");
      const sent = await requestJson(stack.gatewayUrl, `${route}/agent-send`, { method: "POST", body: {
        ...input, routeDecision: decision, providerId: decision.effectiveProviderId, model: decision.effectiveModel,
      } });
      assertOk(sent, "complete Work artifact conversation");
      const turnId = sent.body?.turnId;
      const runId = sent.body?.trace?.durable?.runId;
      if (!turnId || !runId || sent.body.trace.status !== "completed") throw new Error("Work artifact has no completed durable Chat turn.");
      const created = await requestJson(stack.gatewayUrl, `${route}/turns/${encodeURIComponent(turnId)}/generated-artifact`, {
        method: "POST", body: { supersedeLatest: false },
      });
      assertOk(created, "save Work artifact");
      const ownerList = await requestJson(stack.gatewayUrl, `/api/v1/chat/generated-artifacts?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`);
      assertOk(ownerList, "read Work artifact owner");
      const artifact = ownerList.body?.items?.find((item) => item.turnId === turnId);
      if (!artifact?.contentHash || !artifact.artifactId) throw new Error("Work artifact has no canonical hash.");
      const owner = await requestJson(stack.gatewayUrl, `/api/v1/chat/generated-artifacts/${encodeURIComponent(artifact.artifactId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
      assertOk(owner, "read exact Work artifact");
      const record = owner.body?.item;
      if (!record?.content || record.version !== artifact.version) throw new Error("Work artifact owner has no matching content.");
      const trace = await requestJson(stack.gatewayUrl, `/api/v1/observe/runs/${encodeURIComponent(runId)}/trace`);
      assertOk(trace, "read Work artifact trace");
      if (!trace.body?.artifacts?.items?.some((item) => item.artifactId === artifact.artifactId && item.contentHash === artifact.contentHash)) {
        throw new Error("Generated artifact is absent from its exact durable run trace.");
      }
      const browserContext = await browser.newContext({ viewport, colorScheme: variant === "mobile" ? "light" : "dark" });
      try {
        await browserContext.addInitScript(() => window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit"));
        await browserContext.addInitScript((theme) => window.localStorage.setItem("goatcitadel.ui.theme.v1", theme), variant === "mobile" ? "light" : "dark");
        await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
        const page = await browserContext.newPage();
        const reads = [];
        page.on("request", (request) => {
          if (new URL(request.url()).pathname === `/api/v1/chat/generated-artifacts/${encodeURIComponent(artifact.artifactId)}`) reads.push(request.url());
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, `/work/runs/${encodeURIComponent(runId)}?shell=cockpit`), { waitUntil: "domcontentloaded" });
        const section = page.getByRole("region", { name: "Run artifacts", exact: true });
        await section.waitFor({ timeout: 30_000 });
        await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, variant === "mobile" ? "light" : "dark");
        if (reads.length) throw new Error("Work loaded artifact content before a preview request.");
        await section.getByRole("button", { name: "Preview artifact", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Run artifact preview", exact: true });
        await dialog.getByText(record.content, { exact: true }).waitFor();
        if (variant === "desktop") {
          await page.waitForFunction(() => {
            const panel = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
            return panel && Math.abs(panel.right - window.innerWidth) <= 1 && panel.width < window.innerWidth * 0.6 && panel.height >= window.innerHeight - 1;
          });
        }
        if (!reads.length || reads.some((url) => new URL(url).searchParams.get("workspaceId") !== workspaceId)) throw new Error("Artifact read omitted exact workspace scope.");
        await page.addScriptTag({ path: axeSourcePath });
        const axe = await auditPageAccessibility(page);
        const blocking = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (blocking.length || overflow > 1) throw new Error(`Work artifact ${variant}: accessibility ${blocking.map((item) => item.id).join(", ") || "clear"}; overflow ${overflow}px`);
        const screenshotDir = path.join(context.artifactRoot, "screenshots");
        await mkdir(screenshotDir, { recursive: true });
        const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-work-artifact-${variant}.png`);
        await page.screenshot({ path: screenshot, fullPage: false });
        await dialog.getByRole("button", { name: "Close sheet", exact: true }).click();
        return { status: "passed", metrics: { runId, artifactId: artifact.artifactId, version: artifact.version, scopedReads: reads.length, blockingAxe: 0, overflow },
          artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }) };
      } finally {
        await browserContext.close();
      }
    });
  }
}
