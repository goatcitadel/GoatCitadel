import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  clampString,
  maybeParseBool,
  maybeParseInt,
  readJson,
  repoRoot,
  runCommand,
  runScenario,
  sanitizeFilePart,
  writeJson,
  writeText,
} from "./shared.mjs";
import {
  buildVisualBaselineFileName,
  RELEASE_SURFACE_MANIFEST,
  RELEASE_SURFACE_VARIANTS,
} from "./release-surface-manifest.mjs";
import {
  delay,
  prepareVerificationRuntime,
  requestJson,
  startVerificationStack,
  stopProcess,
  stopVerificationStack,
} from "./runtime.mjs";

const PROVIDER_SCENARIOS = ["simple", "stream", "structured", "tools"];
const UNSUPPORTED_PROVIDER_SCENARIOS = {
  perplexity: ["tools"],
};
const TAB_ROUTES = [
  { tab: "dashboard", title: "Dashboard" },
  { tab: "chat", title: "Chat Workspace" },
  { tab: "promptLab", title: "Prompt Lab" },
  { tab: "approvals", title: "Approvals" },
  { tab: "settings", title: "Settings" },
  { tab: "workspaces", title: "Workspaces" },
  { tab: "integrations", title: "Integrations" },
  { tab: "mcp", title: "MCP" },
];

const SURFACE_REGRESSION_ROUTES = RELEASE_SURFACE_MANIFEST;
const VISUAL_REGRESSION_ROUTES = RELEASE_SURFACE_MANIFEST;
const VISUAL_REGRESSION_VARIANTS = RELEASE_SURFACE_VARIANTS;

const VISUAL_BASELINE_DIR = path.join(repoRoot, "scripts", "verification", "baselines", "visual");
const API_COMPAT_BASELINE_PATH = path.join(repoRoot, "scripts", "verification", "baselines", "api-compat", "rest-sse.json");
const API_COMPAT_ALLOWLIST_PATH = path.join(repoRoot, "scripts", "verification", "baselines", "api-compat", "allowlist.json");
const VISUAL_DIFF_PIXEL_DELTA = 18;
const VISUAL_DIFF_RATIO_THRESHOLD = 0.005;

export async function runFastLane(context) {
  const commands = [
    { id: "fast.typecheck", title: "Root typecheck", args: ["typecheck"] },
    { id: "fast.test", title: "Root tests", args: ["test"] },
    { id: "fast.smoke", title: "Gateway smoke", args: ["smoke"] },
    { id: "fast.build", title: "Root build", args: ["build"] },
    { id: "fast.docs", title: "Docs checks", args: ["docs:check"] },
  ];

  for (const command of commands) {
    await runScenario(
      context,
      {
        id: command.id,
        lane: "fast",
        title: command.title,
        subsystem: "fast",
      },
      async () => {
        const result = await runCommand(pnpmCommand(), command.args, {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: command.id,
        });
        return {
          status: result.code === 0 ? "passed" : "failed",
          error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
          metrics: {
            exitCode: result.code,
            durationMs: result.durationMs,
          },
          artifacts: {
            diagnostics: [],
            screenshots: [],
            traces: [],
            logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
            perf: [],
            playwright: [],
          },
        };
      },
    );
  }
}

export async function runDeepCoreLane(context, options = {}) {
  const stack = await startVerificationStack(context, {
    includeUi: true,
    gatewayEnv: {
      GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
      GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
    },
    uiEnv: {
      VITE_GOATCITADEL_VISUAL_REGRESSION_MODE: "true",
    },
  });
  try {
    const statusResponse = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/status");
    await runScenario(
      context,
      {
        id: "core.control-plane.status",
        lane: "deep-core",
        title: "Verification control plane status",
        subsystem: "gateway",
      },
      async () => ({
        status: statusResponse.ok ? "passed" : "failed",
        error: statusResponse.ok ? undefined : JSON.stringify(statusResponse.body),
        metrics: {
          providerCount: Array.isArray(statusResponse.body?.providers) ? statusResponse.body.providers.length : 0,
        },
        artifacts: {
          diagnostics: [],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
        },
      }),
    );

    const seedResponse = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
      method: "POST",
      body: {
        workspaceName: "Verification Core Workspace",
        sessionTitle: "Verification Core Session",
        sessionCount: 18,
        longThreadTurns: 60,
      },
    });
    if (!seedResponse.ok) {
      throw new Error(`verification seed failed: ${JSON.stringify(seedResponse.body)}`);
    }
    let onboardingStateResponse = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/state");
    if (!onboardingStateResponse.ok) {
      throw new Error(`verification onboarding state failed: ${JSON.stringify(onboardingStateResponse.body)}`);
    }
    if (!onboardingStateResponse.body?.completed) {
      const completeResponse = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/complete", {
        method: "POST",
        body: {
          completedBy: "verification-deep-core",
        },
      });
      if (!completeResponse.ok) {
        throw new Error(`verification onboarding completion failed: ${JSON.stringify(completeResponse.body)}`);
      }
      onboardingStateResponse = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/state");
      if (!onboardingStateResponse.ok || !onboardingStateResponse.body?.completed) {
        throw new Error(
          `verification onboarding completion did not persist: ${JSON.stringify(onboardingStateResponse.body)}`,
        );
      }
    }
    const onboardingCompleted = Boolean(onboardingStateResponse.body?.completed);
    const shellLandingTab = onboardingCompleted ? "dashboard" : "onboarding";

    await runGatewayApiSurfaceScenarios(context, stack.gatewayUrl, seedResponse.body);

    const browser = await chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext({
        viewport: { width: 1440, height: 1024 },
        colorScheme: "dark",
      });
      const page = await browserContext.newPage();
      const browserLog = attachBrowserLogging(page);

      await runScenario(
        context,
        {
          id: "core.browser.navigation",
          lane: "deep-core",
          title: "Mission Control core navigation",
          subsystem: "shell",
        },
        async ({ correlationId }) => {
          const metrics = {};
          for (const target of TAB_ROUTES) {
            await page.goto(`${stack.uiUrl}/?tab=${encodeURIComponent(target.tab)}`, { waitUntil: "domcontentloaded" });
            await waitForMissionControlShell(page);
            await waitForTabReady(page, target.tab === "dashboard" ? shellLandingTab : target.tab);
            await page.waitForTimeout(800);
            metrics[target.tab] = "ok";
          }
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "core-browser-navigation",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
          });
          return {
            status: "passed",
            notes: ["Core tabs rendered without immediate browser errors."],
            metrics,
            artifacts,
          };
        },
      );

      await runScenario(
        context,
        {
          id: "core.browser.chat-thread",
          lane: "deep-core",
          title: "Seeded chat thread renders and remains inspectable",
          subsystem: "chat",
        },
        async ({ correlationId }) => {
          await page.evaluate((workspaceId) => {
            window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", String(workspaceId));
          }, seedResponse.body.workspaceId);
          await page.goto(`${stack.uiUrl}/?tab=chat`, { waitUntil: "domcontentloaded" });
          await waitForMissionControlShell(page);
          await waitForTabReady(page, "chat");
          await setBrowserCorrelation(page, correlationId, seedResponse.body.sessionId);
          const seededSessionButton = page.locator(".chat-v11-session-row button").first();
          await seededSessionButton.waitFor({ timeout: 15000 });
          await seededSessionButton.click();
          await page.waitForTimeout(1000);
          await page.waitForSelector(".chat-v11-turn-surface", { timeout: 15000 });
          await page.getByText("Review run details", { exact: true }).first().click();
          await page.waitForSelector(".chat-v11-turn-details[open]", { timeout: 10000 });
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "core-chat-thread",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
          });
          return {
            status: "passed",
            notes: ["Seeded chat content rendered and turn details were inspectable."],
            metrics: {
              sessionCount: seedResponse.body.sessionIds.length,
            },
            artifacts,
          };
        },
      );

      await runScenario(
        context,
        {
          id: "core.browser.command-palette",
          lane: "deep-core",
          title: "Command palette and diagnostics panel are reachable",
          subsystem: "shell",
        },
        async ({ correlationId }) => {
          await page.goto(`${stack.uiUrl}/?tab=${encodeURIComponent(shellLandingTab)}`, {
            waitUntil: "domcontentloaded",
          });
          await waitForMissionControlShell(page);
          await waitForTabReady(page, shellLandingTab);
          await setBrowserCorrelation(page, correlationId);
          await page.getByRole("button", { name: "Command Palette" }).click();
          await page.getByPlaceholder("Type a page or action...").fill("chat");
          await page.locator(".command-palette-action", { hasText: "Open Chat" }).first().waitFor({ timeout: 15000 });
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Command Palette" }).click();
          await page.getByPlaceholder("Type a page or action...").fill("diagnostics");
          const diagnosticsAction = page
            .locator(".command-palette-action", { hasText: "Show developer diagnostics" })
            .first();
          await diagnosticsAction.waitFor({ timeout: 15000 });
          await diagnosticsAction.click();
          await page.waitForSelector('[aria-label="Developer diagnostics"]', { timeout: 15000 });
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "core-command-palette-diagnostics",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
          });
          return {
            status: "passed",
            notes: ["Command palette and diagnostics panel opened."],
            artifacts,
            metrics: {},
          };
        },
      );

      await runScenario(
        context,
        {
          id: "core.browser.effects-and-perf",
          lane: "deep-core",
          title: "Effects switching and chat/dashboard perf smoke",
          subsystem: "core-browser",
        },
        async ({ correlationId }) => {
          await page.goto(`${stack.uiUrl}/?tab=${encodeURIComponent(shellLandingTab)}`, {
            waitUntil: "domcontentloaded",
          });
          await waitForMissionControlShell(page);
          await waitForTabReady(page, shellLandingTab);
          await page.getByRole("button", { name: "Command Palette" }).click();
          await page.getByPlaceholder("Type a page or action...").fill("reduced effects");
          const reducedEffectsAction = page
            .locator(".command-palette-action", { hasText: "Use reduced effects" })
            .first();
          await reducedEffectsAction.waitFor({ timeout: 15000 });
          await reducedEffectsAction.click();
          await page.waitForFunction(
            () => {
              const shell = document.querySelector(".layout-shell");
              return shell?.getAttribute("data-effective-effects-mode") === "reduced";
            },
            { timeout: 15000 },
          );
          await page.waitForTimeout(400);
          const dashboardPerf = await measureLongTaskProfile(page, async () => {
            await page.evaluate(async () => {
              for (let index = 0; index < 8; index += 1) {
                window.scrollTo(0, index % 2 === 0 ? document.body.scrollHeight : 0);
                await new Promise((resolve) => setTimeout(resolve, 80));
              }
            });
          });
          await page.goto(`${stack.uiUrl}/?tab=chat`, { waitUntil: "domcontentloaded" });
          await waitForMissionControlShell(page);
          await waitForTabReady(page, "chat");
          const chatPerf = await measureLongTaskProfile(page, async () => {
            await page.evaluate(async () => {
              const rail = document.querySelector(".chat-v11-session-rail");
              const thread = document.querySelector(".chat-v11-thread-view");
              for (const element of [rail, thread]) {
                if (!(element instanceof HTMLElement)) {
                  continue;
                }
                for (let index = 0; index < 5; index += 1) {
                  element.scrollTop = element.scrollHeight;
                  await new Promise((resolve) => setTimeout(resolve, 60));
                  element.scrollTop = 0;
                  await new Promise((resolve) => setTimeout(resolve, 60));
                }
              }
            });
          });
          const perfPath = path.join(context.artifactRoot, "perf", "core-browser-perf.json");
          await writeJson(perfPath, {
            dashboard: dashboardPerf,
            chat: chatPerf,
          });
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "core-browser-perf",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
            extraPerfArtifacts: [perfPath],
          });
          return {
            status: dashboardPerf.longTaskCount > 12 || chatPerf.longTaskCount > 16 ? "degraded" : "passed",
            notes: ["Reduced effects mode and scroll smoke completed."],
            metrics: {
              dashboardLongTasks: dashboardPerf.longTaskCount,
              chatLongTasks: chatPerf.longTaskCount,
            },
            artifacts,
          };
        },
      );

      await browserContext.close();
    } finally {
      await browser.close();
    }

    await runLiveProviderScenarios(context, stack.gatewayUrl);
  } finally {
    await stopVerificationStack(stack);
  }
}

async function runGatewayApiSurfaceScenarios(context, gatewayUrl, seed) {
  await runScenario(
    context,
    {
      id: "core.api.chat-code-mode-lifecycle",
      lane: "deep-core",
      title: "Chat command, Code Mode approval, and candidate lifecycle contracts",
      subsystem: "chat",
    },
    async () => {
      const createdSession = await requestJson(gatewayUrl, "/api/v1/chat/sessions", {
        method: "POST",
        body: {
          workspaceId: seed.workspaceId,
          title: "Verification Lifecycle Session",
          mode: "chat",
        },
      });
      assertOk(createdSession, "create verification lifecycle session");
      const sessionId = createdSession.body?.sessionId;

      const chatSend = await requestJson(
        gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send`,
        {
          method: "POST",
          body: {
            content: "/help",
            commandText: "/help",
            mode: "chat",
          },
        },
      );
      assertOk(chatSend, "send chat command");

      const codeModeRun = await requestJson(gatewayUrl, "/api/v1/code-mode/runs", {
        method: "POST",
        body: {
          language: "typescript",
          source: "return { ok: true, route: 'verification-code-mode' };",
          requestedOutputIntent: "Generate a governed verification candidate.",
          saveCandidateOnSuccess: true,
          sessionId,
        },
      });
      assertOk(codeModeRun, "create code mode run");
      const runId = codeModeRun.body?.runId;
      const approvalId = codeModeRun.body?.approvalId;

      const resolvedApproval = await requestJson(
        gatewayUrl,
        `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
        {
          method: "POST",
          body: {
            decision: "approve",
            resolvedBy: "verification",
            resolutionNote: "verification approval path",
          },
        },
      );
      assertOk(resolvedApproval, "approve code mode run");

      const completedRun = await waitForCodeModeRunCompletion(gatewayUrl, runId);
      if (completedRun.body?.status !== "completed") {
        throw new Error(`code mode run ${runId} finished with status ${completedRun.body?.status ?? "unknown"}`);
      }
      const candidateId = `candidate-${String(completedRun.body?.codeHash ?? "").slice(0, 12)}`;

      const candidateDetail = await waitForCapabilityCandidate(gatewayUrl, candidateId);

      const promoted = await requestJson(
        gatewayUrl,
        `/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/promote`,
        {
          method: "POST",
          body: {},
        },
      );
      assertOk(promoted, "promote candidate");

      const revoked = await requestJson(
        gatewayUrl,
        `/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/revoke`,
        {
          method: "POST",
          body: {},
        },
      );
      assertOk(revoked, "revoke candidate");

      const outPath = path.join(context.artifactRoot, "diagnostics", "core-api-chat-code-mode-lifecycle.json");
      await writeJson(outPath, {
        session: createdSession.body,
        chatSend: chatSend.body,
        codeModeRun: codeModeRun.body,
        resolvedApproval: resolvedApproval.body,
        completedRun: completedRun.body,
        candidateDetail: candidateDetail.body,
        promoted: promoted.body,
        revoked: revoked.body,
      });
      return {
        status: "passed",
        metrics: {
          runStatus: completedRun.body?.status,
          candidateId,
        },
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
      };
    },
  );

  await runScenario(
    context,
    {
      id: "core.api.approvals-lifecycle",
      lane: "deep-core",
      title: "Approvals create, list, resolve, and replay contracts",
      subsystem: "approvals",
    },
    async () => {
      const created = await requestJson(gatewayUrl, "/api/v1/approvals", {
        method: "POST",
        body: {
          kind: "verification.tool.run",
          riskLevel: "danger",
          payload: { command: "pnpm test", workspaceId: seed.workspaceId },
          preview: { title: "Verification approval lifecycle" },
        },
      });
      assertOk(created, "create approval");
      const approvalId = created.body?.approvalId;
      const pending = await requestJson(gatewayUrl, "/api/v1/approvals?status=pending&limit=20");
      assertOk(pending, "list pending approvals");
      const resolved = await requestJson(gatewayUrl, `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        body: {
          decision: "reject",
          resolutionNote: "verification rejection path",
          resolvedBy: "verification",
        },
      });
      assertOk(resolved, "resolve approval");
      const replay = await requestJson(gatewayUrl, `/api/v1/approvals/${encodeURIComponent(approvalId)}/replay`);
      assertOk(replay, "replay approval");
      const outPath = path.join(context.artifactRoot, "diagnostics", "core-api-approvals.json");
      await writeJson(outPath, {
        created: created.body,
        pending: pending.body,
        resolved: resolved.body,
        replay: replay.body,
      });
      return {
        status: "passed",
        metrics: {
          pendingCount: Array.isArray(pending.body?.items) ? pending.body.items.length : 0,
          replayEventCount: Array.isArray(replay.body?.events) ? replay.body.events.length : 0,
        },
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
      };
    },
  );

  await runScenario(
    context,
    {
      id: "core.api.tools-policy-grants",
      lane: "deep-core",
      title: "Tool catalog, deny grant, and access evaluation contracts",
      subsystem: "tools",
    },
    async () => {
      const catalog = await requestJson(gatewayUrl, "/api/v1/tools/catalog");
      assertOk(catalog, "tool catalog");
      const grant = await requestJson(gatewayUrl, "/api/v1/tools/grants", {
        method: "POST",
        body: {
          toolPattern: "shell.*",
          decision: "deny",
          scope: "workspace",
          scopeRef: seed.workspaceId,
          grantType: "persistent",
          createdBy: "verification",
        },
      });
      assertOk(grant, "create tool grant");
      const evaluated = await requestJson(gatewayUrl, "/api/v1/tools/access/evaluate", {
        method: "POST",
        body: {
          toolName: "shell.exec",
          agentId: "verify-agent",
          sessionId: seed.sessionId,
          workspaceId: seed.workspaceId,
          args: { command: "whoami" },
        },
      });
      assertOk(evaluated, "evaluate tool access");
      const grants = await requestJson(
        gatewayUrl,
        `/api/v1/tools/grants?scope=workspace&scopeRef=${encodeURIComponent(seed.workspaceId)}`,
      );
      assertOk(grants, "list tool grants");
      const outPath = path.join(context.artifactRoot, "diagnostics", "core-api-tools-policy.json");
      await writeJson(outPath, {
        catalog: catalog.body,
        grant: grant.body,
        evaluated: evaluated.body,
        grants: grants.body,
      });
      return {
        status: "passed",
        metrics: {
          catalogCount: Array.isArray(catalog.body?.items) ? catalog.body.items.length : 0,
          grantCount: Array.isArray(grants.body?.items) ? grants.body.items.length : 0,
        },
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
      };
    },
  );

  await runScenario(
    context,
    {
      id: "core.api.workspaces-tasks-trash",
      lane: "deep-core",
      title: "Workspace, task, activity, deliverable, trash, and restore contracts",
      subsystem: "tasks",
    },
    async () => {
      const slug = `verification-${sanitizeFilePart(context.runId).slice(0, 18)}`;
      const workspace = await requestJson(gatewayUrl, "/api/v1/workspaces", {
        method: "POST",
        body: {
          name: "Verification API Workspace",
          description: "Created by deep-core API scenario",
          slug,
        },
      });
      assertOk(workspace, "create workspace");
      const workspaceId = workspace.body?.workspaceId;
      const task = await requestJson(gatewayUrl, "/api/v1/tasks", {
        method: "POST",
        body: {
          workspaceId,
          title: "Verification API task",
          description: "Exercise task lifecycle contracts",
          status: "planning",
          priority: "high",
          createdBy: "verification",
        },
      });
      assertOk(task, "create task");
      const taskId = task.body?.taskId;
      const activity = await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/activities`, {
        method: "POST",
        body: {
          activityType: "comment",
          message: "Verification activity trail entry",
          metadata: { source: "deep-core" },
        },
      });
      assertOk(activity, "append task activity");
      const deliverable = await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`, {
        method: "POST",
        body: {
          deliverableType: "artifact",
          title: "Verification deliverable",
          description: "Synthetic deliverable contract",
        },
      });
      assertOk(deliverable, "append task deliverable");
      const deleted = await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        body: {
          mode: "soft",
          deletedBy: "verification",
          deleteReason: "restore scenario",
        },
      });
      assertOk(deleted, "soft delete task");
      const trash = await requestJson(
        gatewayUrl,
        `/api/v1/tasks?view=trash&workspaceId=${encodeURIComponent(workspaceId)}&limit=20`,
      );
      assertOk(trash, "list task trash");
      const restored = await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/restore`, {
        method: "POST",
        body: {},
      });
      assertOk(restored, "restore task");
      const outPath = path.join(context.artifactRoot, "diagnostics", "core-api-workspaces-tasks.json");
      await writeJson(outPath, {
        workspace: workspace.body,
        task: task.body,
        activity: activity.body,
        deliverable: deliverable.body,
        deleted: deleted.body,
        trash: trash.body,
        restored: restored.body,
      });
      return {
        status: "passed",
        metrics: {
          trashCount: Array.isArray(trash.body?.items) ? trash.body.items.length : 0,
        },
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
      };
    },
  );

  await runScenario(
    context,
    {
      id: "core.api.files-memory-settings-integrations",
      lane: "deep-core",
      title: "Files, memory, settings, and integrations read/write contracts",
      subsystem: "gateway",
    },
    async () => {
      const templates = await requestJson(gatewayUrl, "/api/v1/files/templates");
      assertOk(templates, "file templates");
      const upload = await requestJson(gatewayUrl, "/api/v1/files/upload", {
        method: "POST",
        body: {
          relativePath: "verification/api-surface.html",
          content: "<!doctype html><html><body><h1>Verification</h1><p>API surface smoke.</p></body></html>",
        },
      });
      assertOk(upload, "upload file");
      const preview = await requestJson(
        gatewayUrl,
        "/api/v1/files/preview?relativePath=verification%2Fapi-surface.html",
      );
      assertOk(preview, "preview file");
      const settings = await requestJson(gatewayUrl, "/api/v1/settings");
      assertOk(settings, "read settings");
      const settingsPatch = await requestJson(gatewayUrl, "/api/v1/settings", {
        method: "PATCH",
        body: {
          budgetMode: settings.body?.budgetMode ?? "balanced",
        },
      });
      assertOk(settingsPatch, "patch settings");
      const memoryStats = await requestJson(gatewayUrl, "/api/v1/memory/qmd/stats?limit=5");
      assertOk(memoryStats, "memory qmd stats");
      const memoryItems = await requestJson(gatewayUrl, "/api/v1/memory/items?limit=5");
      const memoryItemsEnabled = memoryItems.ok;
      if (!memoryItemsEnabled && memoryItems.status !== 409) {
        assertOk(memoryItems, "memory items");
      }
      const integrationCatalog = await requestJson(gatewayUrl, "/api/v1/integrations/catalog");
      assertOk(integrationCatalog, "integration catalog");
      const connections = await requestJson(gatewayUrl, "/api/v1/integrations/connections?limit=10");
      assertOk(connections, "integration connections");
      const outPath = path.join(
        context.artifactRoot,
        "diagnostics",
        "core-api-files-memory-settings-integrations.json",
      );
      await writeJson(outPath, {
        templates: templates.body,
        upload: upload.body,
        preview: preview.body,
        settings: settingsPatch.body,
        memoryStats: memoryStats.body,
        memoryItems: memoryItems.body,
        integrationCatalog: integrationCatalog.body,
        connections: connections.body,
      });
      return {
        status: "passed",
        notes: memoryItemsEnabled
          ? []
          : ["Memory items admin endpoint is disabled in this environment; qmd stats contract still verified."],
        metrics: {
          templateCount: Array.isArray(templates.body?.items) ? templates.body.items.length : 0,
          memoryItemCount: Array.isArray(memoryItems.body?.items) ? memoryItems.body.items.length : 0,
          memoryItemsEnabled,
          integrationCatalogCount: Array.isArray(integrationCatalog.body?.items)
            ? integrationCatalog.body.items.length
            : 0,
        },
        artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
      };
    },
  );
}

export async function runOperatorProofLane(context, options = {}) {
  await runScenario(
    context,
    {
      id: "operator-proof.install.verify-install",
      lane: "operator-proof",
      title: "Installer and onboarding verification smoke",
      subsystem: "install",
    },
    async () => {
      const result = await runCommand(pnpmCommand(), ["verify:install"], {
        cwd: repoRoot,
        artifactRoot: path.join(context.artifactRoot, "diagnostics"),
        logName: "operator-proof-verify-install",
      });
      return {
        status: result.code === 0 ? "passed" : "failed",
        error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
        metrics: {
          exitCode: result.code,
          durationMs: result.durationMs,
        },
        artifacts: {
          diagnostics: [],
          screenshots: [],
          traces: [],
          logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
          perf: [],
          playwright: [],
        },
      };
    },
  );

  const stack = await startVerificationStack(context, {
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
      GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
      GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
      GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
    },
  });
  try {
    const seedResponse = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
      method: "POST",
      body: {
        workspaceName: "Verification Operator Workspace",
        sessionTitle: "Verification Operator Session",
        sessionCount: 8,
        longThreadTurns: 18,
      },
    });
    assertOk(seedResponse, "seed operator-proof workspace");
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-operator-proof");

    await runScenario(
      context,
      {
        id: "operator-proof.api.chat-code-mode-lifecycle",
        lane: "operator-proof",
        title: "Operator proof for chat send, approval resume, Code Mode, and candidate lifecycle",
        subsystem: "chat",
      },
      async () => {
        const createdSession = await requestJson(stack.gatewayUrl, "/api/v1/chat/sessions", {
          method: "POST",
          body: {
            workspaceId: seedResponse.body.workspaceId,
            title: "Verification Operator Lifecycle Session",
            mode: "chat",
          },
        });
        assertOk(createdSession, "create operator-proof session");
        const sessionId = createdSession.body?.sessionId;

        const chatSend = await requestJson(
          stack.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send`,
          {
            method: "POST",
            body: {
              content: "/help",
              commandText: "/help",
              mode: "chat",
            },
          },
        );
        assertOk(chatSend, "send operator-proof chat message");

        const chatApprovalSeed = await requestJson(
          stack.gatewayUrl,
          "/api/v1/dev/verification/chat-approval-scenario",
          {
            method: "POST",
            body: {
              sessionId,
              workspaceId: seedResponse.body.workspaceId,
            },
          },
        );
        assertOk(chatApprovalSeed, "seed operator-proof chat approval");
        const chatApprovalId = chatApprovalSeed.body?.approvalId;
        const chatApprovalTurnId = chatApprovalSeed.body?.turnId;
        const chatApprovalRunId = chatApprovalSeed.body?.chatTurnDurableRunId;

        const pendingChatApprovals = await requestJson(
          stack.gatewayUrl,
          `/api/v1/chat/tools/approvals?sessionId=${encodeURIComponent(sessionId)}`,
        );
        assertOk(pendingChatApprovals, "list operator-proof chat approvals");
        if (pendingChatApprovals.body?.activeApprovalId !== chatApprovalId) {
          throw new Error(
            `expected active chat approval ${chatApprovalId}, got ${pendingChatApprovals.body?.activeApprovalId}`,
          );
        }

        const pendingChatLifecycle = await requestJson(
          stack.gatewayUrl,
          `/api/v1/runtime/lifecycle?approvalId=${encodeURIComponent(chatApprovalId)}`,
        );
        assertOk(pendingChatLifecycle, "read pending chat approval lifecycle");

        const approvedChatTool = await requestJson(stack.gatewayUrl, "/api/v1/chat/tools/approve", {
          method: "POST",
          body: {
            sessionId,
            approvalId: chatApprovalId,
            allowScope: "once",
          },
        });
        assertOk(approvedChatTool, "approve operator-proof chat tool");
        if (approvedChatTool.body?.resumed !== true) {
          throw new Error(`expected chat approval ${chatApprovalId} to resume its linked turn`);
        }
        if (approvedChatTool.body?.resumedTurnId !== chatApprovalTurnId) {
          throw new Error(
            `expected resumed turn ${chatApprovalTurnId}, got ${approvedChatTool.body?.resumedTurnId ?? "unknown"}`,
          );
        }
        if (approvedChatTool.body?.resumedRunId !== chatApprovalRunId) {
          throw new Error(
            `expected resumed run ${chatApprovalRunId}, got ${approvedChatTool.body?.resumedRunId ?? "unknown"}`,
          );
        }

        const resumedChatRun = await waitForDurableRunStatus(stack.gatewayUrl, chatApprovalRunId, [
          "running",
          "completed",
        ]);

        const clearedChatApprovals = await requestJson(
          stack.gatewayUrl,
          `/api/v1/chat/tools/approvals?sessionId=${encodeURIComponent(sessionId)}`,
        );
        assertOk(clearedChatApprovals, "list cleared chat approvals");
        if (clearedChatApprovals.body?.activeApprovalId !== null) {
          throw new Error(
            `expected no remaining active chat approval, got ${clearedChatApprovals.body?.activeApprovalId}`,
          );
        }

        const resolvedChatLifecycle = await requestJson(
          stack.gatewayUrl,
          `/api/v1/runtime/lifecycle?approvalId=${encodeURIComponent(chatApprovalId)}`,
        );
        assertOk(resolvedChatLifecycle, "read resolved chat approval lifecycle");

        const codeModeRun = await requestJson(stack.gatewayUrl, "/api/v1/code-mode/runs", {
          method: "POST",
          body: {
            language: "typescript",
            source: "return { ok: true, route: 'verification-operator-proof' };",
            requestedOutputIntent: "Generate an operator-proof governed candidate.",
            saveCandidateOnSuccess: true,
            sessionId,
          },
        });
        assertOk(codeModeRun, "create operator-proof code mode run");
        const runId = codeModeRun.body?.runId;
        const approvalId = codeModeRun.body?.approvalId;

        const resolvedApproval = await requestJson(
          stack.gatewayUrl,
          `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
          {
            method: "POST",
            body: {
              decision: "approve",
              resolvedBy: "verification",
              resolutionNote: "operator-proof approval resume path",
            },
          },
        );
        assertOk(resolvedApproval, "approve operator-proof code mode run");

        const completedRun = await waitForCodeModeRunCompletion(stack.gatewayUrl, runId);
        if (completedRun.body?.status !== "completed") {
          throw new Error(`code mode run ${runId} finished with status ${completedRun.body?.status ?? "unknown"}`);
        }
        const candidateId = `candidate-${String(completedRun.body?.codeHash ?? "").slice(0, 12)}`;
        const candidateDetail = await waitForCapabilityCandidate(stack.gatewayUrl, candidateId);

        const promoted = await requestJson(
          stack.gatewayUrl,
          `/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/promote`,
          {
            method: "POST",
            body: {},
          },
        );
        assertOk(promoted, "promote operator-proof candidate");

        const revoked = await requestJson(
          stack.gatewayUrl,
          `/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/revoke`,
          {
            method: "POST",
            body: {},
          },
        );
        assertOk(revoked, "revoke operator-proof candidate");

        const outPath = path.join(context.artifactRoot, "diagnostics", "operator-proof-chat-code-mode-lifecycle.json");
        await writeJson(outPath, {
          session: createdSession.body,
          chatSend: chatSend.body,
          chatApprovalSeed: chatApprovalSeed.body,
          pendingChatApprovals: pendingChatApprovals.body,
          pendingChatLifecycle: pendingChatLifecycle.body,
          approvedChatTool: approvedChatTool.body,
          resumedChatRun: resumedChatRun.body,
          clearedChatApprovals: clearedChatApprovals.body,
          resolvedChatLifecycle: resolvedChatLifecycle.body,
          codeModeRun: codeModeRun.body,
          resolvedApproval: resolvedApproval.body,
          completedRun: completedRun.body,
          candidateDetail: candidateDetail.body,
          promoted: promoted.body,
          revoked: revoked.body,
        });
        return {
          status: "passed",
          metrics: {
            runStatus: completedRun.body?.status,
            candidateId,
          },
          artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
        };
      },
    );
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function runDurableRecoveryLane(context, options = {}) {
  let stack = await startVerificationStack(context, {
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
      GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
    },
  });
  try {
    await runScenario(
      context,
      {
        id: "durable-recovery.stack.approval-wait-restart-and-dlq",
        lane: "durable-recovery",
        title: "Stack-backed orphan restart and dead-letter recovery for approval wait flows",
        subsystem: "gateway",
      },
      async () => {
        const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/durable-recovery-seed", {
          method: "POST",
          body: {},
        });
        assertOk(seeded, "seed durable recovery verification state");
        const orphanRunId = seeded.body?.orphanRecovery?.runId;
        const deadLetterRunId = seeded.body?.deadLetterRecovery?.runId;
        const deadLetterId = seeded.body?.deadLetterRecovery?.deadLetterId;

        const orphanBeforeRestart = await requestJson(
          stack.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(orphanRunId)}`,
        );
        assertOk(orphanBeforeRestart, "read orphan durable run before restart");
        if (orphanBeforeRestart.body?.status !== "running") {
          throw new Error(`expected orphan durable run ${orphanRunId} to start as running`);
        }

        const deadLettersBeforeRecovery = await requestJson(stack.gatewayUrl, "/api/v1/durable/dead-letters?limit=20");
        assertOk(deadLettersBeforeRecovery, "list dead letters before recovery");

        await stopProcess(stack.gateway);
        stack = await startVerificationStack(context, {
          runtimeRoot: stack.runtimeRoot,
          includeUi: false,
          gatewayEnv: {
            GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
            GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
          },
        });

        const orphanAfterRestart = await waitForDurableRunStatus(stack.gatewayUrl, orphanRunId, ["completed"]);
        const orphanTimeline = await requestJson(
          stack.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(orphanRunId)}/timeline?limit=50`,
        );
        assertOk(orphanTimeline, "read orphan durable run timeline");
        if (
          !Array.isArray(orphanTimeline.body?.items) ||
          !orphanTimeline.body.items.some((item) => item?.eventType === "run_started")
        ) {
          throw new Error(`expected orphan durable run ${orphanRunId} timeline to include run_started after restart`);
        }

        const recoveredDeadLetter = await requestJson(
          stack.gatewayUrl,
          `/api/v1/durable/dead-letters/${encodeURIComponent(deadLetterId)}/recover`,
          {
            method: "POST",
            body: {},
          },
        );
        assertOk(recoveredDeadLetter, "recover durable dead letter");

        const deadLetterAfterRecovery = await waitForDurableRunStatus(stack.gatewayUrl, deadLetterRunId, ["completed"]);
        const deadLetterTimeline = await requestJson(
          stack.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(deadLetterRunId)}/timeline?limit=50`,
        );
        assertOk(deadLetterTimeline, "read recovered dead-letter run timeline");
        if (
          !Array.isArray(deadLetterTimeline.body?.items) ||
          !deadLetterTimeline.body.items.some((item) => item?.eventType === "dead_letter_recovered")
        ) {
          throw new Error(`expected dead-letter run ${deadLetterRunId} timeline to include dead_letter_recovered`);
        }

        const outPath = path.join(context.artifactRoot, "diagnostics", "durable-recovery-stack-proof.json");
        await writeJson(outPath, {
          seeded: seeded.body,
          orphanBeforeRestart: orphanBeforeRestart.body,
          deadLettersBeforeRecovery: deadLettersBeforeRecovery.body,
          orphanAfterRestart: orphanAfterRestart.body,
          orphanTimeline: orphanTimeline.body,
          recoveredDeadLetter: recoveredDeadLetter.body,
          deadLetterAfterRecovery: deadLetterAfterRecovery.body,
          deadLetterTimeline: deadLetterTimeline.body,
        });

        return {
          status: "passed",
          metrics: {
            orphanRunStatus: orphanAfterRestart.body?.status,
            deadLetterRunStatus: deadLetterAfterRecovery.body?.status,
            deadLetterId,
          },
          artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
        };
      },
    );
  } finally {
    await stopVerificationStack(stack);
  }

  const commands = [
    {
      id: "durable-recovery.gateway.worker-tests",
      title: "Durable worker restart, retry, and DLQ recovery tests",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/chat-durable-run-service.test.ts",
        "src/services/durable-run-service.test.ts",
      ],
    },
    {
      id: "durable-recovery.gateway.approval-wake-tests",
      title: "Approval wake and linked durable resume tests",
      args: [
        "--filter",
        "@goatcitadel/gateway",
        "exec",
        "vitest",
        "run",
        "src/services/approval-resolution-effects-service.test.ts",
      ],
    },
  ];

  for (const command of commands) {
    await runScenario(
      context,
      {
        id: command.id,
        lane: "durable-recovery",
        title: command.title,
        subsystem: "gateway",
      },
      async () => {
        const result = await runCommand(pnpmCommand(), command.args, {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: command.id,
        });
        return {
          status: result.code === 0 ? "passed" : "failed",
          error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
          metrics: {
            exitCode: result.code,
            durationMs: result.durationMs,
          },
          artifacts: {
            diagnostics: [],
            screenshots: [],
            traces: [],
            logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
            perf: [],
            playwright: [],
          },
        };
      },
    );
  }
}

export async function runSurfaceRegressionLane(context, options = {}) {
  const stack = await startVerificationStack(context, {
    includeUi: true,
    gatewayEnv: {
      GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
      GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
      GOATCITADEL_MESH_NODE_ID: "build-main",
    },
    uiEnv: {
      VITE_GOATCITADEL_VISUAL_REGRESSION_MODE: "true",
    },
  });
  try {
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-surface-regression");
    const browser = await chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext({
        viewport: { width: 1440, height: 1024 },
        colorScheme: "dark",
      });
      const page = await browserContext.newPage();
      const browserLog = attachBrowserLogging(page);

      for (const route of SURFACE_REGRESSION_ROUTES) {
        await runScenario(
          context,
          {
            id: `surface-regression.${route.slug}`,
            lane: "surface-regression",
            title: `${route.slug} renders in Mission Control`,
            subsystem: "mission-control",
          },
          async ({ correlationId }) => {
            await page.goto(`${stack.uiUrl}/${route.href}`, { waitUntil: "domcontentloaded" });
            await waitForMissionControlShell(page);
            await setBrowserCorrelation(page, correlationId);
            if (route.readySelector) {
              await page.waitForSelector(route.readySelector, { timeout: 30000 });
            }
            if (route.readyText) {
              await page.getByText(route.readyText, { exact: false }).first().waitFor({ timeout: 30000 });
            }
            await page.waitForTimeout(250);
            const artifacts = await captureBrowserArtifacts(context, {
              slug: `surface-regression-${route.slug}`,
              page,
              browserLog,
              gatewayUrl: stack.gatewayUrl,
              correlationId,
            });
            return {
              status: "passed",
              metrics: {
                route: route.href,
              },
              artifacts,
            };
          },
        );
      }

      await browserContext.close();
    } finally {
      await browser.close();
    }
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function runCatalogParityLane(context, options = {}) {
  const fixture = await startCatalogParityFixtureServer();
  let stack;
  try {
    stack = await startVerificationStack(context, {
      includeUi: false,
      gatewayEnv: {
        GOATCITADEL_TRELLO_API_BASE_URL: fixture.baseUrl,
        GOATCITADEL_TENOR_API_BASE_URL: fixture.baseUrl,
        GOATCITADEL_GMAIL_API_BASE_URL: fixture.baseUrl,
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-catalog-parity");
    await runScenario(
      context,
      {
        id: "catalog-parity.visible-catalog-truth",
        lane: "catalog-parity",
        title: "Visible catalog entries stay on operator-ready maturity with no planned escape hatch",
        subsystem: "gateway",
      },
      async () => {
        const visibleCatalogKinds = [
          "channel",
          "model_provider",
          "productivity",
          "automation",
          "platform",
        ];
        const visibleItems = [];
        for (const kind of visibleCatalogKinds) {
          const response = await requestJson(stack.gatewayUrl, `/api/v1/integrations/catalog?kind=${kind}`);
          assertOk(response, `fetch ${kind} integration catalog`);
          const items = Array.isArray(response.body?.items) ? response.body.items : [];
          visibleItems.push(...items);
        }

        const mandatoryVisibleIds = new Set([
          "model_provider.minimax",
          "model_provider.vercel",
          "model_provider.mistral",
          "model_provider.deepseek",
          "model_provider.perplexity",
          "model_provider.huggingface",
          "productivity.apple-notes",
          "productivity.apple-reminders",
          "productivity.things3",
          "productivity.bear",
          "productivity.trello",
          "automation.gmail",
          "automation.gif-search",
          "automation.peekaboo-screen",
          "automation.camera-photo-video",
          "platform.macos-menubar-voice",
          "platform.ios-canvas-camera-voice",
        ]);
        const runtimeActionCatalogIds = [
          "productivity.apple-notes",
          "productivity.apple-reminders",
          "productivity.things3",
          "productivity.bear",
          "productivity.trello",
          "automation.gmail",
          "automation.gif-search",
          "automation.peekaboo-screen",
          "automation.camera-photo-video",
          "platform.macos-menubar-voice",
          "platform.ios-canvas-camera-voice",
        ];
        const targetedEntries = visibleItems.filter((item) => mandatoryVisibleIds.has(item.catalogId));
        const plannedEntries = visibleItems.filter((item) => item.maturity === "planned");
        const nonOperatorReady = targetedEntries.filter((item) => item.maturity !== "beta" && item.maturity !== "native");
        const pluginVisible = targetedEntries.filter((item) => item.maturity === "plugin");
        const blockedWithoutSchema = targetedEntries.filter((item) => !item.formSchema || !Array.isArray(item.formSchema.fields) || item.formSchema.fields.length === 0);
        if (targetedEntries.length !== mandatoryVisibleIds.size) {
          throw new Error(`catalog parity expected ${mandatoryVisibleIds.size} mandatory visible entries, found ${targetedEntries.length}`);
        }
        if (plannedEntries.length > 0) {
          throw new Error(`catalog parity found visible planned entries: ${plannedEntries.map((item) => item.catalogId).join(", ")}`);
        }
        if (nonOperatorReady.length > 0) {
          throw new Error(`catalog parity found non-operator-ready entries: ${nonOperatorReady.map((item) => `${item.catalogId}:${item.maturity}`).join(", ")}`);
        }
        if (pluginVisible.length > 0) {
          throw new Error(`catalog parity found visible plugin-backed entries: ${pluginVisible.map((item) => item.catalogId).join(", ")}`);
        }
        if (targetedEntries.some((item) => item.runtimeAvailability !== "runnable")) {
          throw new Error(`catalog parity found non-runnable mandatory entries: ${targetedEntries.filter((item) => item.runtimeAvailability !== "runnable").map((item) => item.catalogId).join(", ")}`);
        }
        if (blockedWithoutSchema.length > 0) {
          throw new Error(`catalog parity found mandatory entries without guided form schema: ${blockedWithoutSchema.map((item) => item.catalogId).join(", ")}`);
        }
        const runtimeActionResults = [];
        for (const catalogId of runtimeActionCatalogIds) {
          const entry = targetedEntries.find((item) => item.catalogId === catalogId);
          if (!entry) {
            throw new Error(`catalog parity could not find runtime action entry ${catalogId}`);
          }
          const operatorAction = Array.isArray(entry.operatorActions) ? entry.operatorActions[0] : undefined;
          if (!operatorAction) {
            throw new Error(`catalog parity expected ${catalogId} to expose at least one operator action`);
          }
          const createdConnection = await requestJson(stack.gatewayUrl, "/api/v1/integrations/connections", {
            method: "POST",
            body: {
              catalogId,
              label: `${entry.label} Verification`,
              enabled: true,
              status: "connected",
              config: buildCatalogParityConnectionConfig(catalogId, fixture.baseUrl),
            },
          });
          assertOk(createdConnection, `create ${catalogId} verification connection`);
          const actionResult = await requestJson(
            stack.gatewayUrl,
            `/api/v1/integrations/connections/${encodeURIComponent(createdConnection.body?.connectionId ?? "")}/actions/${encodeURIComponent(operatorAction.actionId)}`,
            {
              method: "POST",
              body: {
                input: buildCatalogParityActionInput(catalogId, operatorAction.actionId),
              },
            },
          );
          assertOk(actionResult, `invoke ${catalogId}:${operatorAction.actionId}`);
          if (actionResult.body?.status !== "executed") {
            throw new Error(
              `catalog parity action ${catalogId}:${operatorAction.actionId} returned ${actionResult.body?.status ?? "unknown"}: ${JSON.stringify(actionResult.body)}`,
            );
          }
          runtimeActionResults.push({
            catalogId,
            actionId: operatorAction.actionId,
            status: actionResult.body?.status,
            message: actionResult.body?.message,
            output: actionResult.body?.output,
          });
        }
        const artifactPath = path.join(context.artifactRoot, "diagnostics", "catalog-parity-visible-catalog.json");
        await writeJson(artifactPath, {
          checkedAt: new Date().toISOString(),
          targetedEntries,
          visibleCatalogCount: visibleItems.length,
          runtimeActionResults,
        });
        return {
          status: "passed",
          metrics: {
            mandatoryVisibleCount: targetedEntries.length,
            runtimeActionProofCount: runtimeActionResults.length,
          },
          artifacts: {
            diagnostics: [relativeToRun(context, artifactPath)],
            screenshots: [],
            traces: [],
            logs: [],
            perf: [],
            playwright: [],
          },
        };
      },
    );
  } finally {
    if (stack) {
      await stopVerificationStack(stack);
    }
    await fixture.close();
  }
}

export async function runApiCompatibilityLane(context, options = {}) {
  const stack = await startVerificationStack(context, {
    includeUi: false,
  });
  try {
    await runScenario(
      context,
      {
        id: "api-compat.rest-sse.additive-only",
        lane: "api-compat",
        title: "REST routes and SSE envelopes remain additive-only against the checked-in baseline",
        subsystem: "contracts",
      },
      async () => {
        const openApi = await requestJson(stack.gatewayUrl, "/api/v1/docs/openapi.json");
        assertOk(openApi, "fetch openapi spec for compatibility lane");
        const current = {
          rest: snapshotRestContract(openApi.body),
          sse: await snapshotRealtimeContract(),
        };
        const baseline = await readJson(API_COMPAT_BASELINE_PATH);
        const allowlist = (await readJson(API_COMPAT_ALLOWLIST_PATH).catch(() => ({
          removedRestPaths: [],
          removedRestMethods: [],
          removedRestResponses: [],
          removedSseEventTypes: [],
          removedSseEnvelopeFields: [],
        })));
        const issues = [
          ...compareRestContract(baseline.rest ?? {}, current.rest, allowlist),
          ...compareRealtimeContract(baseline.sse ?? {}, current.sse, allowlist),
        ];
        const artifactPath = path.join(context.artifactRoot, "diagnostics", "api-compat-rest-sse.json");
        await writeJson(artifactPath, {
          checkedAt: new Date().toISOString(),
          baselinePath: API_COMPAT_BASELINE_PATH,
          allowlistPath: API_COMPAT_ALLOWLIST_PATH,
          current,
          issues,
        });
        return {
          status: issues.length > 0 ? "failed" : "passed",
          error: issues.length > 0 ? issues.join("\n") : undefined,
          metrics: {
            restPathCount: Object.keys(current.rest).length,
            sseEventTypeCount: current.sse.eventTypes.length,
            sseEnvelopeFieldCount: current.sse.envelopeFields.length,
          },
          artifacts: emptyArtifacts({
            diagnostics: [relativeToRun(context, artifactPath)],
          }),
        };
      },
    );
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function runBackupRoundtripLane(context, options = {}) {
  const runtimeRoot = await prepareVerificationRuntime(`${context.runId}-backup-roundtrip`);
  const backupRoot = path.join(runtimeRoot, ".GoatCitadel", "backups");
  let stack = await startVerificationStack(context, {
    runtimeRoot,
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_BACKUP_DIR: backupRoot,
      GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
      HOME: runtimeRoot,
      USERPROFILE: runtimeRoot,
    },
  });
  try {
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-backup-roundtrip");
    await runScenario(
      context,
      {
        id: "backup-roundtrip.runtime.config-restore",
        lane: "backup-roundtrip",
        title: "Backup create, verify, and restore returns the full minimum backup set to its pre-mutation content",
        subsystem: "runtime",
      },
      async () => {
        const runtimeRelativePath = (targetPath) => path.relative(runtimeRoot, targetPath).replaceAll("\\", "/");
        const configDir = path.join(runtimeRoot, "config");
        const configPath = path.join(configDir, "llm-providers.json");
        const configSentinelPath = path.join(configDir, "verification-backup-roundtrip.json");
        const dbPath = path.join(runtimeRoot, "data", "index.db");
        const dbWalPath = `${dbPath}-wal`;
        const dbShmPath = `${dbPath}-shm`;
        const transcriptsDir = path.join(runtimeRoot, "data", "transcripts");
        const auditDir = path.join(runtimeRoot, "data", "audit");
        const transcriptPath = path.join(transcriptsDir, "verification-backup-roundtrip-session.jsonl");
        const auditPath = path.join(auditDir, "verification-backup-roundtrip.jsonl");
        const transcriptSentinelRaw = `${JSON.stringify({
          eventId: "backup-roundtrip-transcript",
          sessionId: "verification-backup-roundtrip-session",
          timestamp: "2026-04-10T00:00:00.000Z",
          type: "message.user",
          payload: { content: "transcript sentinel" },
        })}\n`;
        const auditSentinelRaw = `${JSON.stringify({
          eventId: "backup-roundtrip-audit",
          timestamp: "2026-04-10T00:00:00.000Z",
          stream: "operator",
          action: "backup-roundtrip-sentinel",
        })}\n`;
        const configSentinelRaw = `${JSON.stringify(
          {
            sentinel: "backup-roundtrip",
            createdAt: "2026-04-10T00:00:00.000Z",
            note: "verification config sentinel",
          },
          null,
          2,
        )}\n`;

        await fs.writeFile(configSentinelPath, configSentinelRaw, "utf8");
        const configFileNames = (await fs.readdir(configDir))
          .filter((entry) => entry.toLowerCase().endsWith(".json"))
          .sort((left, right) => left.localeCompare(right));
        const configSnapshots = await Promise.all(
          configFileNames.map(async (fileName) => {
            const absolutePath = path.join(configDir, fileName);
            return {
              absolutePath,
              relativePath: runtimeRelativePath(absolutePath),
              raw: await fs.readFile(absolutePath, "utf8"),
            };
          }),
        );
        const providerConfigSnapshot = configSnapshots.find((item) => item.relativePath === "config/llm-providers.json");
        if (!providerConfigSnapshot) {
          throw new Error("backup roundtrip expected config/llm-providers.json in the runtime root");
        }
        const originalConfigRaw = providerConfigSnapshot.raw;
        const originalConfig = JSON.parse(originalConfigRaw);
        const targetProvider = Array.isArray(originalConfig.providers)
          ? (originalConfig.providers.find((item) => item?.providerId === "openai") ?? originalConfig.providers[0])
          : null;
        if (!targetProvider) {
          throw new Error("backup roundtrip config mutation could not find a provider entry");
        }
        const originalLabel = String(targetProvider.label ?? "OpenAI");
        const mutatedMarker = " (mutated after backup)";
        const dbSentinelPolicy = {
          realtimeEventsDays: 11,
          backupsKeep: 17,
          transcriptsDays: 77,
          auditDays: 55,
        };

        await fs.mkdir(transcriptsDir, { recursive: true });
        await fs.mkdir(auditDir, { recursive: true });
        await writeText(transcriptPath, transcriptSentinelRaw);
        await writeText(auditPath, auditSentinelRaw);

        const createdRetentionPolicy = await requestJson(stack.gatewayUrl, "/api/v1/admin/retention", {
          method: "PATCH",
          body: dbSentinelPolicy,
        });
        assertOk(createdRetentionPolicy, "seed DB-backed retention policy sentinel");
        if (
          createdRetentionPolicy.body?.transcriptsDays !== dbSentinelPolicy.transcriptsDays
          || createdRetentionPolicy.body?.auditDays !== dbSentinelPolicy.auditDays
        ) {
          throw new Error("DB-backed retention policy sentinel was not visible before backup");
        }

        const createdBackup = await requestJson(stack.gatewayUrl, "/api/v1/admin/backups/create", {
          method: "POST",
          body: {
            name: "verification-backup-roundtrip",
          },
        });
        assertOk(createdBackup, "create runtime backup");
        const backupPath = path.basename(String(createdBackup.body?.outputPath ?? ""));
        if (!backupPath) {
          throw new Error("backup create response did not include an outputPath");
        }

        const verifiedBackup = await requestJson(stack.gatewayUrl, "/api/v1/admin/backups/verify", {
          method: "POST",
          body: {
            filePath: backupPath,
          },
        });
        assertOk(verifiedBackup, "verify runtime backup");
        if (verifiedBackup.body?.verified !== true || verifiedBackup.body?.contractVerified !== true) {
          throw new Error(`expected verified backup, got ${JSON.stringify(verifiedBackup.body)}`);
        }

        await stopProcess(stack.gateway);
        const configMutationSummary = {};
        for (const [index, snapshot] of configSnapshots.entries()) {
          if (snapshot.relativePath === "config/llm-providers.json") {
            const mutatedConfig = {
              ...originalConfig,
              providers: Array.isArray(originalConfig.providers)
                ? originalConfig.providers.map((provider) =>
                    provider?.providerId === targetProvider.providerId
                      ? { ...provider, label: `${originalLabel}${mutatedMarker}` }
                      : provider,
                  )
                : originalConfig.providers,
            };
            const mutatedRaw = `${JSON.stringify(mutatedConfig, null, 2)}\n`;
            await fs.writeFile(snapshot.absolutePath, mutatedRaw, "utf8");
            configMutationSummary[snapshot.relativePath] = {
              mutation: "overwritten",
              mutated: mutatedRaw !== snapshot.raw,
            };
            continue;
          }
          if (index % 2 === 0) {
            const mutatedRaw = `${JSON.stringify({
              mutated: true,
              relativePath: snapshot.relativePath,
              note: "verification backup mutation",
            })}\n`;
            await fs.writeFile(snapshot.absolutePath, mutatedRaw, "utf8");
            configMutationSummary[snapshot.relativePath] = {
              mutation: "overwritten",
              mutated: mutatedRaw !== snapshot.raw,
            };
            continue;
          }
          await fs.rm(snapshot.absolutePath, { force: true });
          configMutationSummary[snapshot.relativePath] = {
            mutation: "deleted",
            mutated: !(await exists(snapshot.absolutePath)),
          };
        }
        await fs.rm(dbPath, { force: true });
        await fs.rm(dbWalPath, { force: true });
        await fs.rm(dbShmPath, { force: true });
        await fs.rm(transcriptPath, { force: true });
        await fs.rm(auditPath, { force: true });
        const dbMissing = !(await exists(dbPath));
        const transcriptMissing = !(await exists(transcriptPath));
        const auditMissing = !(await exists(auditPath));
        const configMutationFailed = Object.entries(configMutationSummary).filter(([, value]) => !value.mutated);
        if (!dbMissing || !transcriptMissing || !auditMissing || configMutationFailed.length > 0) {
          throw new Error(
            `database, transcript, audit, or config sentinels did not disappear during mutation step: ${JSON.stringify({
              dbMissing,
              transcriptMissing,
              auditMissing,
              configMutationFailed,
            })}`,
          );
        }
        const restoreCommand = await runCommand(
          pnpmCommand(),
          ["admin", "backup", "restore", "--file", backupPath, "--confirm"],
          {
            cwd: repoRoot,
            artifactRoot: path.join(context.artifactRoot, "diagnostics"),
            logName: "backup-roundtrip-restore-cli",
            env: {
              GOATCITADEL_ROOT_DIR: runtimeRoot,
              GOATCITADEL_BACKUP_DIR: backupRoot,
              GOATCITADEL_AUTH_MODE: "none",
              GOATCITADEL_DATABASE_DRIVER: "sqlite",
              GOATCITADEL_DISABLE_SECRET_STORE: "true",
              HOME: runtimeRoot,
              USERPROFILE: runtimeRoot,
            },
          },
        );
        if (restoreCommand.code !== 0) {
          throw new Error(
            `backup restore CLI failed: ${clampString(restoreCommand.stderr || restoreCommand.stdout, 1200)}`,
          );
        }
        const restoredConfigSummary = {};
        for (const snapshot of configSnapshots) {
          const restoredRaw = await fs.readFile(snapshot.absolutePath, "utf8");
          if (restoredRaw !== snapshot.raw) {
            throw new Error(`config file ${snapshot.relativePath} was not byte-restored`);
          }
          restoredConfigSummary[snapshot.relativePath] = {
            ...configMutationSummary[snapshot.relativePath],
            restored: true,
          };
        }
        stack = await startVerificationStack(context, {
          runtimeRoot,
          includeUi: false,
          gatewayEnv: {
            GOATCITADEL_BACKUP_DIR: backupRoot,
            GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
            HOME: runtimeRoot,
            USERPROFILE: runtimeRoot,
          },
        });

        const restoredConfigRaw = await fs.readFile(configPath, "utf8");
        if (restoredConfigRaw !== originalConfigRaw) {
          throw new Error("config state did not return to its pre-backup byte content after restore");
        }
        const restoredRetentionPolicy = await requestJson(
          stack.gatewayUrl,
          "/api/v1/admin/retention",
        );
        assertOk(restoredRetentionPolicy, "read retention policy after restore");
        const retentionRestored =
          restoredRetentionPolicy.body?.transcriptsDays === dbSentinelPolicy.transcriptsDays
          && restoredRetentionPolicy.body?.auditDays === dbSentinelPolicy.auditDays
          && restoredRetentionPolicy.body?.backupsKeep === dbSentinelPolicy.backupsKeep;
        if (!retentionRestored) {
          throw new Error("DB-backed retention policy sentinel was not restored");
        }
        const restoredTranscriptRaw = await fs.readFile(transcriptPath, "utf8");
        const restoredAuditRaw = await fs.readFile(auditPath, "utf8");
        if (restoredTranscriptRaw !== transcriptSentinelRaw) {
          throw new Error("transcript sentinel content was not byte-restored");
        }
        if (restoredAuditRaw !== auditSentinelRaw) {
          throw new Error("audit sentinel content was not byte-restored");
        }
        const manifestPaths = Array.isArray(verifiedBackup.body?.manifest?.files)
          ? verifiedBackup.body.manifest.files.map((item) => String(item.path ?? ""))
          : [];
        const configManifestChecks = Object.fromEntries(
          configSnapshots.map((snapshot) => [snapshot.relativePath, manifestPaths.includes(snapshot.relativePath)]),
        );
        const expectedManifestChecks = {
          database: manifestPaths.some((item) => item.endsWith("data/index.db")),
          transcripts: manifestPaths.some((item) => item.includes("data/transcripts/")),
          audit: manifestPaths.some((item) => item.includes("data/audit/")),
          config: Object.values(configManifestChecks).every(Boolean),
        };
        if (Object.values(expectedManifestChecks).some((value) => !value)) {
          throw new Error(`backup manifest missed part of the minimum backup set: ${JSON.stringify(expectedManifestChecks)}`);
        }
        const verifiedConfigCoverage = Array.isArray(verifiedBackup.body?.contractCoverage?.minimumSet?.config?.expectedPaths)
          ? [...verifiedBackup.body.contractCoverage.minimumSet.config.expectedPaths].sort((left, right) => left.localeCompare(right))
          : [];
        const expectedConfigCoverage = configSnapshots.map((snapshot) => snapshot.relativePath).sort((left, right) => left.localeCompare(right));
        if (JSON.stringify(verifiedConfigCoverage) !== JSON.stringify(expectedConfigCoverage)) {
          throw new Error(
            `backup verify contract coverage did not report the exact config file set: ${JSON.stringify({
              verifiedConfigCoverage,
              expectedConfigCoverage,
            })}`,
          );
        }

        for (const snapshot of configSnapshots) {
          restoredConfigSummary[snapshot.relativePath] = {
            ...restoredConfigSummary[snapshot.relativePath],
            manifestIncluded: configManifestChecks[snapshot.relativePath] === true,
          };
        }

        const outPath = path.join(context.artifactRoot, "diagnostics", "backup-roundtrip-runtime-config.json");
        await writeJson(outPath, {
          configPath,
          configFiles: configSnapshots.map((snapshot) => snapshot.relativePath),
          transcriptPath,
          auditPath,
          originalConfigLabel: originalLabel,
          createdRetentionPolicy: createdRetentionPolicy.body,
          createdBackup: createdBackup.body,
          mutatedConfigLabel: `${originalLabel}${mutatedMarker}`,
          verifiedBackup: verifiedBackup.body,
          restoredBackup: {
            code: restoreCommand.code,
            stdoutPath: restoreCommand.stdoutPath,
            stderrPath: restoreCommand.stderrPath,
          },
          backupClasses: {
            database: {
              seeded: true,
              mutated: dbMissing,
              restored: retentionRestored,
            },
            transcript: {
              seeded: true,
              mutated: transcriptMissing,
              restored: restoredTranscriptRaw.includes("backup-roundtrip-transcript"),
            },
            audit: {
              seeded: true,
              mutated: auditMissing,
              restored: restoredAuditRaw.includes("backup-roundtrip-audit"),
            },
            config: {
              seeded: true,
              mutated: Object.values(configMutationSummary).every((value) => value.mutated),
              restored: Object.values(restoredConfigSummary).every((value) => value.restored),
            },
          },
          manifestChecks: expectedManifestChecks,
          contractCoverage: verifiedBackup.body?.contractCoverage ?? null,
          configManifestChecks,
          configRestoreSummary: restoredConfigSummary,
        });

        return {
          status: "passed",
          metrics: {
            backupId: createdBackup.body?.backupId,
            restoreExitCode: restoreCommand.code,
          },
          artifacts: emptyArtifacts({
            diagnostics: [relativeToRun(context, outPath)],
            logs: [
              relativeToRun(context, restoreCommand.stdoutPath),
              relativeToRun(context, restoreCommand.stderrPath),
            ],
          }),
        };
      },
    );
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function runVisualRegressionLane(context, options = {}) {
  const updateBaselines = maybeParseBool(process.env.GOATCITADEL_UPDATE_VISUAL_BASELINES, false);
  if (!updateBaselines) {
    await assertVisualBaselineCoverage(context);
  }
  const stack = await startVerificationStack(context, {
    includeUi: true,
    gatewayEnv: {
      GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
      GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
      GOATCITADEL_MESH_NODE_ID: "build-main",
    },
    uiEnv: {
      VITE_GOATCITADEL_VISUAL_REGRESSION_MODE: "true",
    },
  });
  try {
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-visual-regression");
    const browser = await chromium.launch({ headless: true });
    try {
      for (const variant of VISUAL_REGRESSION_VARIANTS) {
        const browserContext = await browser.newContext({
          viewport: variant.viewport,
          colorScheme: variant.colorScheme,
        });
        try {
          const page = await browserContext.newPage();
          const browserLog = attachBrowserLogging(page);
          for (const route of VISUAL_REGRESSION_ROUTES) {
            await runScenario(
              context,
              {
                id: `visual-regression.${route.slug}.${variant.slug}`,
                lane: "visual-regression",
                title: `${route.slug} ${variant.slug} baseline renders`,
                subsystem: "mission-control",
              },
              async ({ correlationId }) => {
                await page.goto(`${stack.uiUrl}/${appendQuery(route.href, variant.themeQuery)}`, { waitUntil: "domcontentloaded" });
                await waitForMissionControlShell(page);
                await setBrowserCorrelation(page, correlationId);
                if (route.readySelector) {
                  await page.waitForSelector(route.readySelector, { timeout: 30000 });
                }
                if (route.readyText) {
                  await page.getByText(route.readyText, { exact: false }).first().waitFor({ timeout: 30000 });
                }
                await page.waitForTimeout(1000);
                const artifactSlug = `visual-regression-${route.slug}-${variant.slug}`;
                const artifacts = await captureBrowserArtifacts(context, {
                  slug: artifactSlug,
                  page,
                  browserLog,
                  gatewayUrl: stack.gatewayUrl,
                  correlationId,
                });
                const comparison = await compareVisualBaseline(context, artifactSlug);
                const failed = comparison.diffRatio > VISUAL_DIFF_RATIO_THRESHOLD;
                return {
                  status: failed ? "failed" : "passed",
                  error: failed
                    ? `visual diff ratio ${comparison.diffRatio.toFixed(4)} exceeded threshold ${VISUAL_DIFF_RATIO_THRESHOLD}`
                    : undefined,
                  metrics: {
                    route: route.href,
                    variant: variant.slug,
                    diffRatio: comparison.diffRatio,
                    changedPixels: comparison.changedPixels,
                  },
                  artifacts: {
                    ...artifacts,
                    screenshots: [...artifacts.screenshots, ...comparison.screenshots],
                    diagnostics: [...artifacts.diagnostics, ...comparison.diagnostics],
                  },
                };
              },
            );
          }
        } finally {
          await browserContext.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function runDeepEcosystemLane(context, options = {}) {
  const stack = await startVerificationStack(context, {
    includeUi: true,
  });
  try {
    await runScenario(
      context,
      {
        id: "ecosystem.doctor.audit",
        lane: "deep-ecosystem",
        title: "Doctor deep audit",
        subsystem: "ecosystem",
      },
      async () => {
        const result = await runCommand(pnpmCommand(), ["doctor:audit"], {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: "ecosystem-doctor-deep",
          env: {
            GOATCITADEL_GATEWAY_URL: stack.gatewayUrl,
            GOATCITADEL_ROOT_DIR: stack.runtimeRoot,
          },
        });
        return {
          status: result.code === 0 ? "passed" : "failed",
          error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
          artifacts: {
            diagnostics: [],
            screenshots: [],
            traces: [],
            logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
            perf: [],
            playwright: [],
          },
          metrics: {
            exitCode: result.code,
          },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "ecosystem.voice.runtime-status",
        lane: "deep-ecosystem",
        title: "Managed voice runtime status",
        subsystem: "voice",
      },
      async () => {
        const response = await requestJson(stack.gatewayUrl, "/api/v1/voice/runtime");
        const diagnosticsPath = path.join(context.artifactRoot, "diagnostics", "voice-runtime-status.json");
        await writeJson(diagnosticsPath, response.body);
        return {
          status: response.ok ? "passed" : "failed",
          error: response.ok ? undefined : JSON.stringify(response.body),
          artifacts: {
            diagnostics: [relativeToRun(context, diagnosticsPath)],
            screenshots: [],
            traces: [],
            logs: [],
            perf: [],
            playwright: [],
          },
          metrics: {
            installedModelCount: Array.isArray(response.body?.installedModels)
              ? response.body.installedModels.length
              : 0,
            runtimeReady: Boolean(response.body?.runtimeReady),
          },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "ecosystem.addons.arena",
        lane: "deep-ecosystem",
        title: "Arena add-on catalog and status",
        subsystem: "addons",
      },
      async () => {
        const catalog = await requestJson(stack.gatewayUrl, "/api/v1/addons/catalog");
        const arenaEntry = Array.isArray(catalog.body?.items)
          ? catalog.body.items.find((item) => item.addonId === "arena")
          : undefined;
        let status = null;
        if (arenaEntry) {
          status = await requestJson(stack.gatewayUrl, "/api/v1/addons/arena/status");
        }
        const outPath = path.join(context.artifactRoot, "provider-results", "arena-status.json");
        await writeJson(outPath, {
          catalog: catalog.body,
          status: status?.body ?? null,
        });
        return {
          status: arenaEntry ? "passed" : "failed",
          error: arenaEntry ? undefined : "Arena add-on is missing from the catalog.",
          artifacts: {
            diagnostics: [relativeToRun(context, outPath)],
            screenshots: [],
            traces: [],
            logs: [],
            perf: [],
            playwright: [],
          },
          metrics: {
            hasArenaCatalogEntry: Boolean(arenaEntry),
            launchUrlPresent: Boolean(status?.body?.launchUrl),
          },
        };
      },
    );

    await runScenario(
      context,
      {
        id: "ecosystem.mesh.status",
        lane: "deep-ecosystem",
        title: "Mesh and onboarding readiness endpoints",
        subsystem: "ecosystem",
      },
      async () => {
        const mesh = await requestJson(stack.gatewayUrl, "/api/v1/mesh/status");
        const onboarding = await requestJson(stack.gatewayUrl, "/api/v1/onboarding/state");
        const outPath = path.join(context.artifactRoot, "diagnostics", "ecosystem-mesh-onboarding.json");
        await writeJson(outPath, {
          mesh: mesh.body,
          onboarding: onboarding.body,
        });
        return {
          status: mesh.ok && onboarding.ok ? "passed" : "failed",
          error: mesh.ok && onboarding.ok ? undefined : "Mesh or onboarding endpoint failed.",
          artifacts: {
            diagnostics: [relativeToRun(context, outPath)],
            screenshots: [],
            traces: [],
            logs: [],
            perf: [],
            playwright: [],
          },
          metrics: {
            meshEnabled: Boolean(mesh.body?.enabled),
            onboardingComplete: Boolean(onboarding.body?.completed),
          },
        };
      },
    );

    const browser = await chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext({
        viewport: { width: 1440, height: 1024 },
        colorScheme: "dark",
      });
      const page = await browserContext.newPage();
      const browserLog = attachBrowserLogging(page);

      await runScenario(
        context,
        {
          id: "ecosystem.office.route",
          lane: "deep-ecosystem",
          title: "Office route renders with reduced effects",
          subsystem: "office",
        },
        async ({ correlationId }) => {
          await page.addInitScript(() => {
            window.localStorage.setItem("goatcitadel.ui.effects_mode.v1", "reduced");
          });
          await page.goto(`${stack.uiUrl}/?tab=office`, { waitUntil: "domcontentloaded" });
          await setBrowserCorrelation(page, correlationId);
          await page.waitForSelector(".office-stage-panel", { timeout: 25000 });
          await page.waitForTimeout(3500);
          const perf = await measureLongTaskProfile(page, async () => {
            await page.evaluate(async () => {
              window.scrollTo(0, document.body.scrollHeight);
              await new Promise((resolve) => setTimeout(resolve, 120));
              window.scrollTo(0, 0);
              await new Promise((resolve) => setTimeout(resolve, 120));
            });
          });
          const perfPath = path.join(context.artifactRoot, "perf", "ecosystem-office-perf.json");
          await writeJson(perfPath, perf);
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "ecosystem-office-route",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
            extraPerfArtifacts: [perfPath],
          });
          return {
            status: perf.longTaskCount > 16 ? "degraded" : "passed",
            metrics: {
              longTaskCount: perf.longTaskCount,
              maxLongTaskMs: perf.maxLongTaskMs,
            },
            notes: ["Office route rendered with reduced effects enabled."],
            artifacts,
          };
        },
      );

      await browserContext.close();
    } finally {
      await browser.close();
    }
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function runSoakLane(context, options = {}) {
  const durationMs = maybeParseInt(options.durationMs ?? process.env.GOATCITADEL_VERIFY_SOAK_DURATION_MS, 7_200_000);
  const stack = await startVerificationStack(context, {
    includeUi: true,
  });
  try {
    const statusResponse = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/status");
    const configuredProviders = (statusResponse.body?.providers ?? []).filter((item) => item.hasSecret);
    const endAt = Date.now() + durationMs;
    let cycle = 0;
    while (Date.now() < endAt) {
      cycle += 1;
      await runScenario(
        context,
        {
          id: `soak.gateway.provider-cycle-${cycle}`,
          lane: "soak",
          title: `Provider soak cycle ${cycle}`,
          subsystem: "providers",
        },
        async () => {
          for (const provider of configuredProviders) {
            const result = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/provider-exercise", {
              method: "POST",
              body: {
                providerId: provider.providerId,
                model: provider.defaultModel,
                scenario: "simple",
              },
            });
            if (!result.body?.ok) {
              return {
                status: "failed",
                providerId: provider.providerId,
                modelId: provider.defaultModel,
                error: result.body?.error ?? "provider soak failed",
                metrics: { cycle },
                artifacts: {
                  diagnostics: [],
                  screenshots: [],
                  traces: [],
                  logs: [],
                  perf: [],
                  playwright: [],
                },
              };
            }
          }
          return {
            status: configuredProviders.length > 0 ? "passed" : "not_configured",
            metrics: {
              cycle,
              configuredProviders: configuredProviders.length,
            },
            artifacts: {
              diagnostics: [],
              screenshots: [],
              traces: [],
              logs: [],
              perf: [],
              playwright: [],
            },
          };
        },
      );

      await delay(1000);
    }
  } finally {
    await stopVerificationStack(stack);
  }
}

async function runLiveProviderScenarios(context, gatewayUrl) {
  const statusResponse = await requestJson(gatewayUrl, "/api/v1/dev/verification/status");
  const providers = Array.isArray(statusResponse.body?.providers) ? statusResponse.body.providers : [];
  for (const provider of providers) {
    if (!provider.hasSecret) {
      await runScenario(
        context,
        {
          id: `providers.${provider.providerId}.not-configured`,
          lane: "deep-core",
          title: `${provider.label} provider readiness`,
          subsystem: "providers",
        },
        async () => ({
          status: "not_configured",
          providerId: provider.providerId,
          modelId: provider.defaultModel,
          notes: ["Provider is not configured in this environment."],
          artifacts: {
            diagnostics: [],
            screenshots: [],
            traces: [],
            logs: [],
            perf: [],
            playwright: [],
          },
        }),
      );
      continue;
    }

    const unsupportedScenarios = new Set(UNSUPPORTED_PROVIDER_SCENARIOS[provider.providerId] ?? []);
    for (const scenario of PROVIDER_SCENARIOS) {
      await runScenario(
        context,
        {
          id: `providers.${provider.providerId}.${scenario}`,
          lane: "deep-core",
          title: `${provider.label} ${scenario} verification`,
          subsystem: "providers",
        },
        async () => {
          if (unsupportedScenarios.has(scenario)) {
            return {
              status: "skipped",
              providerId: provider.providerId,
              modelId: provider.defaultModel,
              notes: ["Scenario skipped because this provider/model does not support that capability."],
              artifacts: {
                diagnostics: [],
                screenshots: [],
                traces: [],
                logs: [],
                perf: [],
                playwright: [],
              },
              metrics: {},
            };
          }
          const response = await requestJson(gatewayUrl, "/api/v1/dev/verification/provider-exercise", {
            method: "POST",
            body: {
              providerId: provider.providerId,
              model: provider.defaultModel,
              scenario,
            },
          });
          const resultPath = path.join(
            context.artifactRoot,
            "provider-results",
            `${sanitizeFilePart(provider.providerId)}-${sanitizeFilePart(scenario)}.json`,
          );
          await writeJson(resultPath, response.body);
          const status = deriveProviderStatus(response.body);
          return {
            status,
            providerId: provider.providerId,
            modelId: provider.defaultModel,
            error: response.body?.ok ? undefined : response.body?.error,
            notes: response.body?.ok ? [clampString(response.body.outputPreview ?? "", 240)] : [],
            artifacts: {
              diagnostics: [relativeToRun(context, resultPath)],
              screenshots: [],
              traces: [],
              logs: [],
              perf: [],
              playwright: [],
            },
            metrics: {
              elapsedMs: response.body?.elapsedMs ?? 0,
              chunkCount: response.body?.chunkCount ?? 0,
            },
          };
        },
      );
    }
  }
}

async function waitForMissionControlShell(page, timeoutMs = 30000) {
  await page.waitForFunction(
    () => {
      const shell = document.querySelector(".layout-shell");
      const accessGate = document.querySelector(".gateway-access-shell");
      return Boolean(shell) && !accessGate;
    },
    { timeout: timeoutMs },
  );
  await page.waitForSelector(".shell-bar", { timeout: timeoutMs });
}

async function waitForTabReady(page, tab, timeoutMs = 30000) {
  switch (tab) {
    case "onboarding":
      await page.waitForSelector("text=Step 1: Gateway Access", { timeout: timeoutMs });
      break;
    case "dashboard":
      await page.getByPlaceholder("Ask GoatCitadel anything... Try /help").waitFor({ timeout: timeoutMs });
      break;
    case "chat":
      await page.getByPlaceholder("Ask GoatCitadel anything... Try /help").waitFor({ timeout: timeoutMs });
      break;
    default:
      await page.waitForFunction(
        () => {
          const loading = document.querySelector(".shell-page-loading");
          return !loading;
        },
        { timeout: timeoutMs },
      );
      await page.waitForSelector(".shell-bar", { timeout: timeoutMs });
      break;
  }
}

function deriveProviderStatus(payload) {
  if (payload?.ok) {
    return "passed";
  }
  const error = String(payload?.error ?? "").toLowerCase();
  if (
    /invalid api key|authentication failed|authentication_error|unauthorized|insufficient credits|payment required|no longer available to new users|provider is not configured|missing .*api key|authorized_error/.test(
      error,
    )
  ) {
    return "not_configured";
  }
  if (
    /unsupported|not supported|json_schema|tool_choice|tools are not available|response_format|unavailable now/.test(
      error,
    )
  ) {
    return "degraded";
  }
  if (/not found|404/.test(error)) {
    return "degraded";
  }
  return "failed";
}

function assertOk(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} failed (${response?.status ?? "unknown"}): ${JSON.stringify(response?.body ?? null)}`);
  }
}

async function ensureOnboardingComplete(gatewayUrl, completedBy) {
  let onboardingStateResponse = await requestJson(gatewayUrl, "/api/v1/onboarding/state");
  assertOk(onboardingStateResponse, "read onboarding state");
  if (onboardingStateResponse.body?.completed) {
    return onboardingStateResponse.body;
  }
  const completeResponse = await requestJson(gatewayUrl, "/api/v1/onboarding/complete", {
    method: "POST",
    body: {
      completedBy,
    },
  });
  assertOk(completeResponse, "complete onboarding");
  onboardingStateResponse = await requestJson(gatewayUrl, "/api/v1/onboarding/state");
  assertOk(onboardingStateResponse, "re-read onboarding state");
  if (!onboardingStateResponse.body?.completed) {
    throw new Error(
      `verification onboarding completion did not persist: ${JSON.stringify(onboardingStateResponse.body)}`,
    );
  }
  return onboardingStateResponse.body;
}

function emptyArtifacts(overrides = {}) {
  return {
    diagnostics: [],
    screenshots: [],
    traces: [],
    logs: [],
    perf: [],
    playwright: [],
    ...overrides,
  };
}

async function waitForCodeModeRunCompletion(gatewayUrl, runId, attempts = 20) {
  let latest = null;
  for (let index = 0; index < attempts; index += 1) {
    latest = await requestJson(gatewayUrl, `/api/v1/code-mode/runs/${encodeURIComponent(runId)}`);
    assertOk(latest, "read code mode run");
    if (latest.body?.status === "completed" || latest.body?.status === "failed") {
      return latest;
    }
    await delay(250);
  }
  throw new Error(`code mode run ${runId} did not reach a terminal state in time`);
}

async function waitForCapabilityCandidate(gatewayUrl, candidateId, attempts = 20) {
  let latest = null;
  for (let index = 0; index < attempts; index += 1) {
    latest = await requestJson(gatewayUrl, `/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}`);
    if (latest?.ok) {
      return latest;
    }
    if (latest?.status !== 404) {
      assertOk(latest, "read candidate detail");
    }
    await delay(250);
  }
  throw new Error(`candidate ${candidateId} did not become available in time`);
}

async function waitForDurableRunStatus(gatewayUrl, runId, acceptedStatuses, attempts = 30) {
  let latest = null;
  for (let index = 0; index < attempts; index += 1) {
    latest = await requestJson(gatewayUrl, `/api/v1/durable/runs/${encodeURIComponent(runId)}`);
    assertOk(latest, "read durable run");
    if (acceptedStatuses.includes(latest.body?.status)) {
      return latest;
    }
    await delay(250);
  }
  throw new Error(
    `durable run ${runId} did not reach one of [${acceptedStatuses.join(", ")}] in time; last status=${latest?.body?.status ?? "unknown"}`,
  );
}

function attachBrowserLogging(page) {
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
    getSnapshot: () => ({
      consoleMessages: [...consoleMessages],
      pageErrors: [...pageErrors],
    }),
  };
}

async function setBrowserCorrelation(page, correlationId, sessionId) {
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

function appendQuery(href, query) {
  if (!query) {
    return href;
  }
  return `${href}${href.includes("?") ? "&" : "?"}${query}`;
}

async function captureBrowserArtifacts(context, input) {
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
  await writeJson(consoleLogPath, input.browserLog.getSnapshot());
  return {
    diagnostics: [relativeToRun(context, browserDiagnosticsPath), relativeToRun(context, gatewayDiagnosticsPath)],
    screenshots: [relativeToRun(context, screenshotPath)],
    traces: [],
    logs: [relativeToRun(context, consoleLogPath)],
    perf: (input.extraPerfArtifacts ?? []).map((item) => relativeToRun(context, item)),
    playwright: [relativeToRun(context, consoleLogPath)],
  };
}

async function compareVisualBaseline(context, slug) {
  const screenshotPath = path.join(context.artifactRoot, "screenshots", `${slug}.png`);
  const baselinePath = path.join(VISUAL_BASELINE_DIR, `${slug}.png`);
  const diagnosticsPath = path.join(context.artifactRoot, "diagnostics", `${slug}-visual-compare.json`);
  const diffPath = path.join(context.artifactRoot, "screenshots", `${slug}-diff.png`);
  const baselineArtifactPath = path.join(context.artifactRoot, "screenshots", `${slug}-baseline.png`);
  const updateBaselines = maybeParseBool(process.env.GOATCITADEL_UPDATE_VISUAL_BASELINES, false);

  await fs.mkdir(path.dirname(baselinePath), { recursive: true });
  if (updateBaselines) {
    await fs.copyFile(screenshotPath, baselinePath);
  }

  let baselineExists = true;
  try {
    await fs.access(baselinePath);
  } catch {
    baselineExists = false;
  }

  if (!baselineExists) {
    await writeJson(diagnosticsPath, {
      slug,
      status: "missing_baseline",
      baselinePath,
      screenshotPath,
    });
    return {
      diffRatio: 1,
      changedPixels: 0,
      diagnostics: [relativeToRun(context, diagnosticsPath)],
      screenshots: [],
    };
  }

  await fs.copyFile(baselinePath, baselineArtifactPath);

  const current = await sharp(screenshotPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const baseline = await sharp(baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  let changedPixels = 0;
  let diffRatio = 0;
  let dimensionMismatch = false;

  if (current.info.width !== baseline.info.width || current.info.height !== baseline.info.height) {
    dimensionMismatch = true;
    diffRatio = 1;
  } else {
    const pixelCount = current.info.width * current.info.height;
    const diffBuffer = Buffer.alloc(current.data.length);
    for (let index = 0; index < current.data.length; index += 4) {
      const delta = Math.max(
        Math.abs(current.data[index] - baseline.data[index]),
        Math.abs(current.data[index + 1] - baseline.data[index + 1]),
        Math.abs(current.data[index + 2] - baseline.data[index + 2]),
        Math.abs(current.data[index + 3] - baseline.data[index + 3]),
      );
      if (delta > VISUAL_DIFF_PIXEL_DELTA) {
        changedPixels += 1;
        diffBuffer[index] = 255;
        diffBuffer[index + 1] = 0;
        diffBuffer[index + 2] = 0;
        diffBuffer[index + 3] = 255;
      } else {
        diffBuffer[index] = baseline.data[index];
        diffBuffer[index + 1] = baseline.data[index + 1];
        diffBuffer[index + 2] = baseline.data[index + 2];
        diffBuffer[index + 3] = 80;
      }
    }
    diffRatio = pixelCount > 0 ? changedPixels / pixelCount : 0;
    await sharp(diffBuffer, {
      raw: {
        width: current.info.width,
        height: current.info.height,
        channels: 4,
      },
    }).png().toFile(diffPath);
  }

  await writeJson(diagnosticsPath, {
    slug,
    screenshotPath,
    baselinePath,
    updateBaselines,
    dimensionMismatch,
    changedPixels,
    diffRatio,
    diffPixelDelta: VISUAL_DIFF_PIXEL_DELTA,
    diffRatioThreshold: VISUAL_DIFF_RATIO_THRESHOLD,
  });

  return {
    diffRatio,
    changedPixels,
    diagnostics: [relativeToRun(context, diagnosticsPath)],
    screenshots: dimensionMismatch
      ? [relativeToRun(context, baselineArtifactPath)]
      : [relativeToRun(context, baselineArtifactPath), relativeToRun(context, diffPath)],
  };
}

async function assertVisualBaselineCoverage(context) {
  const expectedFiles = RELEASE_SURFACE_MANIFEST.flatMap((route) =>
    RELEASE_SURFACE_VARIANTS.map((variant) => buildVisualBaselineFileName(route.slug, variant.slug)),
  );
  const missing = [];
  for (const fileName of expectedFiles) {
    try {
      await fs.access(path.join(VISUAL_BASELINE_DIR, fileName));
    } catch {
      missing.push(fileName);
    }
  }
  if (missing.length === 0) {
    return;
  }
  const diagnosticsPath = path.join(context.artifactRoot, "diagnostics", "visual-baseline-coverage.json");
  await writeJson(diagnosticsPath, {
    baselineDirectory: VISUAL_BASELINE_DIR,
    expectedFiles,
    missingFiles: missing,
  });
  throw new Error(`visual baseline coverage is incomplete: ${missing.join(", ")}`);
}

function snapshotRestContract(openApiDocument) {
  const paths = openApiDocument && typeof openApiDocument === "object" && openApiDocument.paths && typeof openApiDocument.paths === "object"
    ? openApiDocument.paths
    : {};
  return Object.fromEntries(
    Object.entries(paths)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([routePath, methods]) => [
        routePath,
        Object.fromEntries(
          Object.entries(methods ?? {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([method, definition]) => [
              method,
              {
                responses: Object.keys(definition?.responses ?? {}).sort(),
              },
            ]),
        ),
      ]),
  );
}

async function snapshotRealtimeContract() {
  const monitoringPath = path.join(repoRoot, "packages", "contracts", "src", "monitoring.ts");
  const source = await fs.readFile(monitoringPath, "utf8");
  const eventTypesMatch = source.match(/export type RealtimeEventType =([\s\S]*?);/);
  const realtimeInterfaceMatch = source.match(/export interface RealtimeEvent \{([\s\S]*?)\n\}/);
  const eventTypes = [...(eventTypesMatch?.[1]?.matchAll(/"([^"]+)"/g) ?? [])].map((match) => match[1]).sort();
  const envelopeFields = (realtimeInterfaceMatch?.[1] ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([a-zA-Z0-9_]+)\??:/)?.[1] ?? null)
    .filter(Boolean)
    .sort();
  return {
    eventTypes,
    envelopeFields,
  };
}

function compareRestContract(baseline, current, allowlist) {
  const issues = [];
  for (const [routePath, baselineMethods] of Object.entries(baseline)) {
    if (!current[routePath]) {
      if (!allowlist.removedRestPaths?.includes(routePath)) {
        issues.push(`REST path removed: ${routePath}`);
      }
      continue;
    }
    for (const [method, baselineDefinition] of Object.entries(baselineMethods ?? {})) {
      if (!current[routePath]?.[method]) {
        const allowlistKey = `${String(method).toUpperCase()} ${routePath}`;
        if (!allowlist.removedRestMethods?.includes(allowlistKey)) {
          issues.push(`REST method removed: ${allowlistKey}`);
        }
        continue;
      }
      for (const responseCode of baselineDefinition?.responses ?? []) {
        const allowlistKey = `${String(method).toUpperCase()} ${routePath} -> ${responseCode}`;
        if (!current[routePath][method].responses.includes(responseCode) && !allowlist.removedRestResponses?.includes(allowlistKey)) {
          issues.push(`REST response removed: ${allowlistKey}`);
        }
      }
    }
  }
  return issues;
}

function compareRealtimeContract(baseline, current, allowlist) {
  const issues = [];
  for (const eventType of baseline.eventTypes ?? []) {
    if (!current.eventTypes.includes(eventType) && !allowlist.removedSseEventTypes?.includes(eventType)) {
      issues.push(`SSE event type removed: ${eventType}`);
    }
  }
  for (const field of baseline.envelopeFields ?? []) {
    if (!current.envelopeFields.includes(field) && !allowlist.removedSseEnvelopeFields?.includes(field)) {
      issues.push(`SSE envelope field removed: ${field}`);
    }
  }
  return issues;
}

async function startCatalogParityFixtureServer() {
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const parsedBody = rawBody.trim() ? safeJsonParse(rawBody) : undefined;

    if (url.pathname === "/v1/integrations/actions" && method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        message: "fixture bridge ok",
        output: {
          catalogId: parsedBody?.catalogId,
          actionId: parsedBody?.actionId,
          input: parsedBody?.input ?? {},
        },
      }));
      return;
    }
    if (url.pathname === "/1/members/me/boards" && method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ id: "board-1", name: "Verification Board", url: "https://trello.test/board-1" }]));
      return;
    }
    if (url.pathname === "/1/cards" && method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "card-1", name: "Verification Card", url: "https://trello.test/card-1" }));
      return;
    }
    if (url.pathname === "/v2/search" && method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        results: [
          {
            id: "gif-1",
            content_description: "Happy goat",
            media_formats: {
              gif: {
                url: "https://media.example.test/happy-goat.gif",
              },
            },
          },
        ],
      }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages" && method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ messages: [{ id: "msg-1", threadId: "thread-1" }] }));
      return;
    }
    if (url.pathname === "/gmail/v1/users/me/messages/send" && method === "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "sent-1" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found", path: url.pathname, method }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("catalog parity fixture server did not expose an address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
    },
  };
}

function buildCatalogParityConnectionConfig(catalogId, fixtureBaseUrl) {
  switch (catalogId) {
    case "productivity.trello":
      return {
        apiKey: "trello-key",
        token: "trello-token",
        defaultListId: "list-123",
      };
    case "automation.gmail":
      return {
        accessToken: "gmail-token",
      };
    case "automation.gif-search":
      return {
        provider: "tenor",
        apiKey: "tenor-key",
      };
    case "platform.ios-canvas-camera-voice":
      return {
        bridgeUrl: fixtureBaseUrl,
        deviceId: "verification-ios-device",
      };
    default:
      return {
        bridgeUrl: fixtureBaseUrl,
        authToken: "fixture-bridge-token",
      };
  }
}

function buildCatalogParityActionInput(catalogId, actionId) {
  if (catalogId === "automation.gmail" && actionId === "write") {
    return {
      to: "ops@example.com",
      subject: "GoatCitadel operator check",
      bodyText: "This is a GoatCitadel Gmail operator check.",
    };
  }
  if (catalogId === "automation.gif-search" && actionId === "search") {
    return {
      query: "happy goat",
    };
  }
  if (catalogId === "platform.macos-menubar-voice" && actionId === "voice") {
    return {
      prompt: "Operator voice check",
    };
  }
  if (catalogId === "platform.ios-canvas-camera-voice" && actionId === "canvas") {
    return {
      content: "Operator canvas check",
    };
  }
  return {};
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function measureLongTaskProfile(page, action) {
  await page.evaluate(() => {
    const bucket = {
      entries: [],
      unsupported: false,
      observer: null,
    };
    if (typeof PerformanceObserver === "undefined") {
      bucket.unsupported = true;
      window.__goatVerifyLongTaskBucket = bucket;
      return;
    }
    const observer = new PerformanceObserver((list) => {
      bucket.entries.push(
        ...list.getEntries().map((entry) => ({
          name: entry.name,
          duration: entry.duration,
          startTime: entry.startTime,
        })),
      );
    });
    observer.observe({ entryTypes: ["longtask"] });
    bucket.observer = observer;
    window.__goatVerifyLongTaskBucket = bucket;
  });
  const startedAt = Date.now();
  await action();
  await delay(500);
  const summary = await page.evaluate(() => {
    const bucket = window.__goatVerifyLongTaskBucket;
    if (!bucket) {
      return { unsupported: true, entries: [] };
    }
    bucket.observer?.disconnect?.();
    return {
      unsupported: Boolean(bucket.unsupported),
      entries: bucket.entries ?? [],
    };
  });
  const durations = summary.entries.map((item) => item.duration);
  return {
    unsupported: summary.unsupported,
    longTaskCount: durations.length,
    maxLongTaskMs: durations.length > 0 ? Math.max(...durations) : 0,
    totalLongTaskMs: durations.reduce((sum, value) => sum + value, 0),
    actionDurationMs: Date.now() - startedAt,
  };
}

function relativeToRun(context, filePath) {
  return path.relative(context.artifactRoot, filePath).replaceAll("\\", "/");
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}
