import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export function assertPolicyEvaluationOwnerAgreement({ expected, submitted, owner, effective }) {
  assert.deepEqual(submitted, expected, "Policy request changed selected identity, argument values, or omitted fields");
  assert.equal(owner?.toolName, expected.toolName);
  assert.equal(typeof owner.allowed, "boolean");
  assert.equal(typeof owner.requiresApproval, "boolean");
  assert.ok(["safe", "caution", "danger", "nuclear"].includes(owner.riskLevel));
  assert.ok(Array.isArray(owner.reasonCodes) && owner.reasonCodes.every((reason) => typeof reason === "string"));
  assert.equal(effective?.workspaceId, expected.workspaceId);
  assert.equal(effective.sessionId, expected.sessionId);
  assert.equal(effective.surface, expected.surface);
  assert.ok(typeof effective.permissionProfile?.profileId === "string" && effective.permissionProfile.profileId);
  assert.equal(effective.permissionProfile.profileId, owner.permissionProfileId);
  assert.equal(effective.localOperatorOverrideId, owner.localOperatorOverrideId);
}

export async function runCockpitLibraryPolicyProof({ context, browser, stack, citadelId, viewports, deps }) {
  const { presentCapabilityTitle } = await import("../../../../packages/mission-control-shared/dist/content/capability-rows.js");
  const { humanizeToken, presentRiskLevel } = await import("../../../../packages/mission-control-shared/dist/content/status-vocabulary.js");
  const { assertOk, auditPageAccessibility, axeSourcePath, buildVerificationUiUrl, emptyArtifacts,
    installMissionControlNextBrowserState, path, relativeToRun, requestJson, runScenario } = deps;
  for (const { variant, viewport } of viewports) {
    await runScenario(context, { id: `ux-budgets.cockpit-library-policy.${variant}`, lane: "ux-budgets",
      title: `Cockpit Library advisory policy inspection ${variant}`, subsystem: "mission-control-ux" }, async () => {
      const seed = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", { method: "POST",
        body: { workspaceName: `Policy inspection ${variant}`, sessionTitle: "Policy inspection conversation", sessionCount: 1, longThreadTurns: 2 } });
      assertOk(seed, "seed policy inspection workspace");
      const { workspaceId, sessionId } = seed.body ?? {};
      assert.ok(workspaceId && sessionId);
      const [catalog, tools, agents] = await Promise.all([
        requestJson(stack.gatewayUrl, "/api/v1/capabilities/catalog?scope=inspectable"),
        requestJson(stack.gatewayUrl, "/api/v1/tools/catalog"), requestJson(stack.gatewayUrl, "/api/v1/agents?view=active&limit=50"),
      ]);
      assertOk(catalog, "read capability identity"); assertOk(tools, "read exact tool examples"); assertOk(agents, "read actual agent identities");
      const item = catalog.body?.items?.find((entry) => entry.kind === "tool" && entry.toolName === "fs.read");
      const tool = tools.body?.items?.find((entry) => entry.toolName === item?.toolName);
      const example = tool?.examples?.[0];
      const agent = agents.body?.items?.find((entry) => entry.lifecycleStatus === "active");
      assert.ok(item && example && agent, "Policy proof needs fs.read, its catalog example, and an actual active agent");
      const theme = variant === "mobile" ? "light" : "dark";
      const browserContext = await browser.newContext({ viewport, colorScheme: theme });
      let page;
      try {
        await browserContext.addInitScript((value) => {
          window.localStorage.setItem("goatcitadel.ui.shell.v1", "cockpit");
          window.localStorage.setItem("goatcitadel.ui.theme.v1", value);
        }, theme);
        await installMissionControlNextBrowserState(browserContext, workspaceId, citadelId);
        page = await browserContext.newPage();
        const policyRequests = [];
        const mutations = [];
        page.on("request", (request) => {
          const pathname = new URL(request.url()).pathname;
          if (pathname === "/api/v1/tools/access/evaluate") policyRequests.push(request);
          if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && pathname.startsWith("/api/v1/")) mutations.push(pathname);
        });
        await page.goto(buildVerificationUiUrl(stack.uiUrl, `/library/tool/${encodeURIComponent(item.capabilityId)}?shell=cockpit&type=tool`), { waitUntil: "domcontentloaded" });
        const detail = variant === "mobile" ? page.getByRole("dialog", { name: presentCapabilityTitle(item), exact: true })
          : page.getByRole("complementary", { name: "Capability details", exact: true });
        await detail.getByRole("tab", { name: "Policy", exact: true }).click({ timeout: 30_000 });
        const inspector = detail.getByRole("region", { name: "Tool policy inspector", exact: true });
        await inspector.getByRole("button", { name: "Inspect tool policy", exact: true }).waitFor();
        assert.equal(policyRequests.length, 0);
        await inspector.getByRole("button", { name: "Inspect tool policy", exact: true }).click();
        await inspector.getByRole("combobox", { name: /^Agent(?:\s|$)/u }).selectOption(agent.agentId);
        await inspector.getByRole("combobox", { name: /^Conversation(?:\s|$)/u }).selectOption(sessionId);
        await inspector.getByRole("combobox", { name: /^Arguments to evaluate(?:\s|$)/u }).selectOption("0");
        assert.equal(await inspector.locator("textarea").count(), 0, "Raw JSON must remain secondary");
        assert.equal(policyRequests.length, 0, "Context selection must not auto-evaluate");
        const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/tools/access/evaluate");
        await inspector.getByRole("button", { name: "Evaluate selected context", exact: true }).click();
        const response = await responsePromise;
        assert.equal(response.status(), 200, "Actual Gateway policy evaluation failed");
        const owner = await response.json();
        assert.equal(policyRequests.length, 1);
        const submitted = policyRequests[0].postDataJSON();
        const effective = await requestJson(stack.gatewayUrl, `/api/v1/tools/permission-profiles/effective?${new URLSearchParams({ workspaceId, sessionId, surface: "tools" })}`);
        assertOk(effective, "read exact conversation policy owner");
        assertPolicyEvaluationOwnerAgreement({ submitted, owner, effective: effective.body, expected: {
          toolName: tool.toolName, workspaceId, agentId: agent.agentId, sessionId,
          surface: "tools", trustLevel: "trusted_operator", args: example.args,
        } });
        const result = inspector.getByRole("region", { name: "Advisory policy result", exact: true });
        await result.waitFor();
        await result.getByText(owner.requiresApproval ? "Approval would be required" : owner.allowed ? "Allowed by this evaluation" : "Blocked by this evaluation", { exact: true }).waitFor();
        await result.getByText(presentRiskLevel(owner.riskLevel).label, { exact: true }).waitFor();
        assert.deepEqual(await result.locator("li").allTextContents(), owner.reasonCodes.slice(0, 12).map(humanizeToken));
        await result.getByText(`Profile: ${effective.body.permissionProfile.label}`, { exact: true }).waitFor();
        assert.ok(mutations.every((pathname) => pathname === "/api/v1/tools/access/evaluate"),
          `Policy inspector issued other mutations: ${mutations.join(", ")}`);
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        await page.addScriptTag({ path: axeSourcePath });
        const axe = await auditPageAccessibility(page);
        const blocking = axe.violations.filter((entry) => ["serious", "critical"].includes(entry.impact));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(blocking.length, 0, `Blocking policy accessibility: ${blocking.map((entry) => entry.id).join(", ")}`);
        assert.ok(overflow <= 1, `Policy horizontal overflow: ${overflow}px`);
        const screenshotDir = path.join(context.artifactRoot, "screenshots"); await mkdir(screenshotDir, { recursive: true });
        const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-library-policy-${variant}.png`);
        await result.scrollIntoViewIfNeeded(); await page.screenshot({ path: screenshot, fullPage: false });
        await inspector.getByRole("combobox", { name: /^Input trust(?:\s|$)/u }).selectOption("untrusted_external");
        assert.equal(await result.count(), 0, "Context edits must hide the old result");
        assert.equal(policyRequests.length, 1, "Context edits must not record another advisory decision");
        await inspector.getByRole("button", { name: "Close policy inspector", exact: true }).click();
        await inspector.getByRole("button", { name: "Inspect tool policy", exact: true }).click();
        await inspector.getByRole("combobox", { name: /^Agent(?:\s|$)/u }).waitFor();
        assert.equal(await inspector.getByRole("combobox", { name: /^Agent(?:\s|$)/u }).inputValue(), "");
        assert.equal(await inspector.getByRole("combobox", { name: /^Conversation(?:\s|$)/u }).inputValue(), "");
        assert.equal(await result.count(), 0);
        return { status: "passed", metrics: { workspaceId, sessionId, agentId: agent.agentId, toolName: tool.toolName,
          advisoryDecisionRecorded: true, actualToolExecuted: false, exactExampleArguments: true,
          ownerDecisionMatched: true, staleResultCleared: true, evaluationRequests: policyRequests.length, blockingAxe: 0, overflow },
        artifacts: emptyArtifacts({ screenshots: [relativeToRun(context, screenshot)] }) };
      } catch (error) {
        const screenshots = [];
        if (page && !page.isClosed()) {
          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          const screenshot = path.join(screenshotDir, `ux-budgets-cockpit-library-policy-${variant}-failure.png`);
          try {
            await mkdir(screenshotDir, { recursive: true });
            // This context only uses synthetic conversations and a built-in catalog example.
            await page.screenshot({ path: screenshot, fullPage: false, mask: [page.locator('input[type="password"], textarea')] });
            screenshots.push(relativeToRun(context, screenshot));
          } catch { /* Preserve the original scenario failure if the page can no longer be captured. */ }
        }
        return { status: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          artifacts: emptyArtifacts({ screenshots }) };
      } finally { await browserContext.close(); }
    });
  }
}
