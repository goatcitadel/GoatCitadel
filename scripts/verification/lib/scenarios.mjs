import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
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
  collectArchitectureMetrics,
  compareArchitectureMetrics,
  readArchitectureMetricsBaseline,
} from "./architecture-metrics.mjs";
import {
  buildVisualBaselineFileName,
  NEXT_RELEASE_SURFACE_MANIFEST,
  RELEASE_SURFACE_VARIANTS,
  resolveLegacyRedirectManifest,
  resolveShellContract,
  resolveSurfaceRegressionManifest,
  resolveVisualBaselineNamespace,
  resolveVisualRegressionManifest,
  resolveVisualRegressionVariants,
} from "./release-surface-manifest.mjs";
import {
  delay,
  ensureGatewayWorkspaceBuild,
  prepareVerificationRuntime,
  resolveAvailablePort,
  requestJson,
  startProcess,
  startVerificationStack,
  stopProcess,
  stopVerificationStack,
  waitForHttp,
} from "./runtime.mjs";
import { DEFAULT_UI_PACKAGE, resolveUiTarget } from "../../lib/ui-target.mjs";

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

const NEXT_UI_PACKAGE = "@goatcitadel/mission-control-next";
const VISUAL_BASELINE_ROOT_DIR = path.join(repoRoot, "scripts", "verification", "baselines", "visual");
const API_COMPAT_BASELINE_PATH = path.join(
  repoRoot,
  "scripts",
  "verification",
  "baselines",
  "api-compat",
  "rest-sse.json",
);
const API_COMPAT_ALLOWLIST_PATH = path.join(
  repoRoot,
  "scripts",
  "verification",
  "baselines",
  "api-compat",
  "allowlist.json",
);
const VISUAL_DIFF_PIXEL_DELTA = 18;
const VISUAL_DIFF_RATIO_THRESHOLD = 0.04;
const VISUAL_DIFF_NORMALIZE_BLUR = 6;
const VISUAL_DIFF_NORMALIZE_SCALE = 0.25;
// Passing scenarios resolve in well under 10s. The 60s ceiling is a generous
// upper bound — anything approaching it indicates a real race in the seed or
// hydration path, not a viewport-size variance. On timeout the lane writes a
// *-route-ready-failure.json diagnostic capturing gateway thread state, queue
// state, and DOM marker visibility; use that to root-cause rather than bumping.
const VISUAL_ROUTE_READY_TIMEOUT_MS = 60000;
const FAST_LANE_TEMP_MIN_FREE_BYTES = 1024 * 1024 * 1024;
// The file upload fixture would otherwise render "now" in the file list baseline.
const MISSION_CONTROL_NEXT_FILE_FIXTURE_MTIME = new Date("2026-05-17T21:51:00.000Z");

export const FAST_LANE_COMMANDS = Object.freeze([
  { id: "fast.repo-hygiene", title: "Repo hygiene", args: ["verify:repo:hygiene"] },
  { id: "fast.storage-migration-parity", title: "Storage migration parity", args: ["verify:storage:migration-parity"] },
  {
    id: "fast.extensions-sdk-build",
    title: "Extensions SDK build",
    args: ["--filter", "@goatcitadel/extensions-sdk", "build"],
  },
  { id: "fast.typecheck", title: "Root typecheck", args: ["typecheck"] },
  {
    id: "fast.test",
    title: "Root tests",
    args: ["-r", "--workspace-concurrency=1", "test"],
  },
  { id: "fast.smoke", title: "Gateway smoke", args: ["smoke"] },
  { id: "fast.build", title: "Root build", args: ["build"] },
  { id: "fast.docs", title: "Docs checks", args: ["docs:check"] },
]);

function resolveVerificationTargetContext() {
  const uiTarget = resolveUiTarget(repoRoot, process.env);
  const packageName = uiTarget.packageName || DEFAULT_UI_PACKAGE;
  const surfaceRoutes = resolveSurfaceRegressionManifest(packageName);
  return {
    uiTarget,
    packageName,
    isNext: packageName === NEXT_UI_PACKAGE,
    shellContract: resolveShellContract(packageName),
    surfaceRoutes,
    visualRoutes: resolveVisualRegressionManifest(packageName),
    visualVariants: resolveVisualRegressionVariants(packageName),
    redirectRoutes: resolveLegacyRedirectManifest(packageName),
    routeByHref: new Map(surfaceRoutes.map((route) => [route.href, route])),
  };
}

function resolveVisualBaselineDir(packageName = DEFAULT_UI_PACKAGE) {
  const namespace = resolveVisualBaselineNamespace(packageName);
  return namespace ? path.join(VISUAL_BASELINE_ROOT_DIR, namespace) : VISUAL_BASELINE_ROOT_DIR;
}

function buildVerificationUiUrl(uiUrl, href) {
  return href.startsWith("/") ? `${uiUrl}${href}` : `${uiUrl}/${href}`;
}

function withVerificationRouteParams(href, params) {
  const url = new URL(href, "http://goatcitadel.local");
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function runFastLane(context) {
  for (const command of FAST_LANE_COMMANDS) {
    await runScenario(
      context,
      {
        id: command.id,
        lane: "fast",
        title: command.title,
        subsystem: "fast",
      },
      async () => {
        const env = await resolveFastLaneCommandEnv(context, command);
        const result = await runCommand(pnpmCommand(), command.args, {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: command.id,
          env,
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

async function resolveFastLaneCommandEnv(context, command) {
  const tempBaseRoot = await resolveFastLaneTempBaseRoot(context);
  const commandTempRoot = path.join(tempBaseRoot, sanitizeFilePart(command.id));
  const npmCacheRoot = path.join(commandTempRoot, "npm-cache");
  await fs.mkdir(commandTempRoot, { recursive: true });
  await fs.mkdir(npmCacheRoot, { recursive: true });
  const tempEnv = {
    NPM_CONFIG_CACHE: npmCacheRoot,
    TEMP: commandTempRoot,
    TMP: commandTempRoot,
    TMPDIR: commandTempRoot,
    npm_config_cache: npmCacheRoot,
  };
  if (command.id !== "fast.smoke") {
    return {
      ...tempEnv,
      ...(command.env ?? {}),
    };
  }
  const runtimeRoot = await prepareVerificationRuntime(`${context.runId}-fast-smoke`);
  return {
    ...tempEnv,
    ...(command.env ?? {}),
    GOATCITADEL_ROOT_DIR: runtimeRoot,
    GOATCITADEL_DATABASE_DRIVER: "sqlite",
    GOATCITADEL_DISABLE_SECRET_STORE: "true",
  };
}

async function resolveFastLaneTempBaseRoot(context) {
  const configuredTempRoot = process.env.GOATCITADEL_VERIFY_TEMP_ROOT?.trim();
  if (configuredTempRoot) {
    return path.join(configuredTempRoot, context.runId);
  }
  const systemTempRoot = os.tmpdir();
  if (await hasMinimumFreeSpace(systemTempRoot, FAST_LANE_TEMP_MIN_FREE_BYTES)) {
    return path.join(systemTempRoot, "goatcitadel-verify", context.runId);
  }
  return path.join(context.artifactRoot, "tmp");
}

async function hasMinimumFreeSpace(candidatePath, minFreeBytes) {
  try {
    await fs.mkdir(candidatePath, { recursive: true });
    const stats = await fs.statfs(candidatePath);
    return Number(stats.bavail) * Number(stats.bsize) >= minFreeBytes;
  } catch {
    return false;
  }
}

export async function runCodeModeSandboxRequiredLane(context) {
  await runScenario(
    context,
    {
      id: "code-mode.sandbox.required",
      lane: "code-mode-sandbox",
      title: "Code Mode sandbox metadata/fail-closed proof",
      subsystem: "gateway",
    },
    async () => {
      await ensureGatewayWorkspaceBuild(context);
      const proofPath = path.join(context.artifactRoot, "diagnostics", "code-mode-sandbox-required.json");
      const result = await runCommand(
        pnpmCommand(),
        ["--filter", "@goatcitadel/gateway", "exec", "tsx", "src/code-mode-sandbox-proof.ts", "--output", proofPath],
        {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: "code-mode-sandbox.required",
          env: {
            GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
            GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "true",
            GOATCITADEL_CODE_MODE_BEST_EFFORT_SANDBOX_ENABLED: "true",
            GOATCITADEL_ROOT_DIR: repoRoot,
          },
        },
      );
      const proof = await readJson(proofPath).catch(() => undefined);
      const failClosedProof =
        result.code !== 0 &&
        proof?.sandboxRequired === true &&
        proof?.sandboxAvailable === false &&
        typeof proof?.metadata?.failClosedReason === "string" &&
        proof.metadata.failClosedReason.length > 0;
      return {
        status: result.code === 0 || failClosedProof ? "passed" : "failed",
        error: result.code === 0 || failClosedProof ? undefined : clampString(result.stderr || result.stdout, 1200),
        metrics: {
          exitCode: result.code,
          durationMs: result.durationMs,
          sandboxRequired: proof?.sandboxRequired,
          sandboxAvailable: proof?.sandboxAvailable,
          failClosedProof,
          checksPassed: proof?.metadata?.checksPassed?.length,
          checksFailed: proof?.metadata?.checksFailed?.length,
        },
        artifacts: emptyArtifacts({
          diagnostics: proof ? [relativeToRun(context, proofPath)] : [],
          logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
        }),
      };
    },
  );
}

export async function runAgenticContractsLane(context) {
  await runAgenticProofScenario(context, {
    profile: "contracts",
    id: "agentic.contracts.anchors",
    lane: "agentic-contracts",
    title: "Agentic contract and API source anchors",
    subsystem: "agentic",
  });
  await runAgenticProofScenario(context, {
    profile: "workbench",
    id: "agentic.workbench.patch-test-review-loop",
    lane: "agentic-contracts",
    title: "Code Workbench patch/test/apply/export/revert behavior",
    subsystem: "agentic",
  });
  await runAgenticProofScenario(context, {
    profile: "channels",
    id: "agentic.channels.durable-delivery-runtime",
    lane: "agentic-contracts",
    title: "Durable channel delivery retry and stale-state behavior",
    subsystem: "agentic",
  });
}

export async function runAgenticWorkbenchLoopLane(context) {
  await runAgenticProofScenario(context, {
    profile: "workbench",
    id: "agentic.workbench.patch-test-review-loop",
    lane: "agentic-workbench-loop",
    title: "Code Workbench patch/test/apply/export/revert behavior",
    subsystem: "agentic",
  });
}

export async function runAgenticChannelsRuntimeLane(context) {
  await runAgenticProofScenario(context, {
    profile: "channels",
    id: "agentic.channels.durable-delivery-runtime",
    lane: "agentic-channels-runtime",
    title: "Durable channel delivery retry, stale-state, and route behavior",
    subsystem: "agentic",
  });
}

export async function runAgenticGovernanceLane(context) {
  await runAgenticProofScenario(context, {
    profile: "governance",
    id: "agentic.governance.review-first",
    lane: "agentic-governance",
    title: "Review-first Cowork and Code governance anchors",
    subsystem: "agentic",
  });
  await runAgenticProofScenario(context, {
    profile: "marketplace",
    id: "agentic.marketplace.callable-governance",
    lane: "agentic-governance",
    title: "Plugin/provider marketplace callable-boundary behavior",
    subsystem: "agentic",
  });
  await runAgenticProofScenario(context, {
    profile: "selfImprovement",
    id: "agentic.self-improvement.review-first",
    lane: "agentic-governance",
    title: "Self-improvement and curator review-first behavior",
    subsystem: "agentic",
  });
}

export async function runAgenticPluginsMarketplaceLane(context) {
  await runAgenticProofScenario(context, {
    profile: "marketplace",
    id: "agentic.marketplace.callable-governance",
    lane: "agentic-plugins-marketplace",
    title: "Plugin/provider marketplace callable-boundary behavior",
    subsystem: "agentic",
  });
}

export async function runAgenticSelfImprovementTrustLane(context) {
  await runAgenticProofScenario(context, {
    profile: "selfImprovement",
    id: "agentic.self-improvement.review-first",
    lane: "agentic-self-improvement-trust",
    title: "Self-improvement and curator review-first behavior",
    subsystem: "agentic",
  });
}

export async function runAgenticHarnessesLane(context) {
  await runAgenticProofScenario(context, {
    profile: "harnesses",
    id: "agentic.harnesses.availability-gated",
    lane: "agentic-harnesses",
    title: "External harness availability-gated parity anchors",
    subsystem: "agentic",
  });
  await runAgenticProofScenario(context, {
    profile: "behavioral",
    id: "agentic.behavioral.callable-boundaries",
    lane: "agentic-harnesses",
    title: "Agentic behavioral callable-boundary proof",
    subsystem: "agentic",
  });
}

export async function runAgenticHarnessAvailabilityLane(context) {
  await runAgenticProofScenario(context, {
    profile: "availability",
    id: "agentic.availability.route-and-callable-boundary",
    lane: "agentic-harness-availability",
    title: "Agentic availability route and callable-boundary behavior",
    subsystem: "agentic",
  });
  await runAgenticProofScenario(context, {
    profile: "behavioral",
    id: "agentic.behavioral.callable-boundaries",
    lane: "agentic-harness-availability",
    title: "Agentic behavioral callable-boundary proof",
    subsystem: "agentic",
  });
}

async function runAgenticProofScenario(context, definition) {
  await runScenario(
    context,
    {
      id: definition.id,
      lane: definition.lane,
      title: definition.title,
      subsystem: definition.subsystem,
    },
    async () => {
      await ensureGatewayWorkspaceBuild(context);
      const proofPath = path.join(context.artifactRoot, "diagnostics", `${definition.id}.json`);
      const result = await runCommand(
        process.execPath,
        [
          path.join(repoRoot, "scripts", "verification", "agentic-proof.mjs"),
          "--profile",
          definition.profile,
          "--output",
          proofPath,
        ],
        {
          cwd: repoRoot,
          artifactRoot: path.join(context.artifactRoot, "diagnostics"),
          logName: definition.id,
        },
      );
      const proof = await readJson(proofPath).catch(() => undefined);
      return {
        status: result.code === 0 ? "passed" : "failed",
        error: result.code === 0 ? undefined : clampString(result.stderr || result.stdout, 1200),
        notes: proof ? [`${proof.summary?.passed ?? 0}/${proof.summary?.total ?? 0} agentic proof checks passed.`] : [],
        metrics: {
          exitCode: result.code,
          durationMs: result.durationMs,
          checksTotal: proof?.summary?.total,
          checksPassed: proof?.summary?.passed,
          checksFailed: proof?.summary?.failed,
        },
        artifacts: emptyArtifacts({
          diagnostics: proof ? [relativeToRun(context, proofPath)] : [],
          logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
        }),
      };
    },
  );
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
    const verificationTarget = resolveVerificationTargetContext();
    const verificationPackageName = verificationTarget.packageName;

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
          if (verificationTarget.isNext) {
            for (const target of getNextCoreNavigationRoutes(verificationTarget)) {
              await page.goto(buildVerificationUiUrl(stack.uiUrl, target.href), { waitUntil: "domcontentloaded" });
              await waitForVerificationRouteReady(page, target, verificationPackageName);
              await page.waitForTimeout(800);
              metrics[target.slug] = "ok";
            }
          } else {
            for (const target of TAB_ROUTES) {
              await page.goto(`${stack.uiUrl}/?tab=${encodeURIComponent(target.tab)}`, {
                waitUntil: "domcontentloaded",
              });
              await waitForMissionControlShell(page);
              await waitForTabReady(page, target.tab === "dashboard" ? shellLandingTab : target.tab);
              await page.waitForTimeout(800);
              metrics[target.tab] = "ok";
            }
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
          if (verificationTarget.isNext) {
            const chatRoute = getVerificationRoute(verificationTarget, "chat");
            const seededChatHref = withVerificationRouteParams(chatRoute.href, {
              sessionId: seedResponse.body.sessionId,
            });
            await page.goto(buildVerificationUiUrl(stack.uiUrl, seededChatHref), { waitUntil: "domcontentloaded" });
            await waitForVerificationRouteReady(page, chatRoute, verificationPackageName);
            await setBrowserCorrelation(page, correlationId, seedResponse.body.sessionId);
            await page.waitForSelector(".mc-next-thread-turn-surface", { timeout: 15000 });
            const detailButton = page
              .locator(".mc-next-thread-inline-button", { hasText: /Details|Run details/i })
              .first();
            if (await detailButton.isVisible().catch(() => false)) {
              await detailButton.click();
              await page.waitForTimeout(500);
            }
          } else {
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
          }
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
          if (verificationTarget.isNext) {
            const diagnosticsRoute = getVerificationRoute(verificationTarget, "ops-diagnostics");
            await page.goto(buildVerificationUiUrl(stack.uiUrl, diagnosticsRoute.href), {
              waitUntil: "domcontentloaded",
            });
            await waitForVerificationRouteReady(page, diagnosticsRoute, verificationPackageName);
            await setBrowserCorrelation(page, correlationId);
            await performVerificationInteraction(page, "open-inspector", verificationPackageName);
          } else {
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
          }
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
          let dashboardPerf;
          let chatPerf;
          if (verificationTarget.isNext) {
            await page.evaluate((workspaceId) => {
              window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", String(workspaceId));
              window.localStorage.setItem("goatcitadel.ui.effects_mode.v1", "reduced");
            }, seedResponse.body.workspaceId);
            const opsRoute = getVerificationRoute(verificationTarget, "ops-activity");
            await page.goto(buildVerificationUiUrl(stack.uiUrl, opsRoute.href), {
              waitUntil: "domcontentloaded",
            });
            await waitForVerificationRouteReady(page, opsRoute, verificationPackageName);
            await page.waitForFunction(
              () => document.querySelector(".mc-next-shell")?.classList.contains("ui-effects-reduced"),
              undefined,
              { timeout: 15000 },
            );
            await page.waitForTimeout(400);
            dashboardPerf = await measureLongTaskProfile(page, async () => {
              await page.evaluate(async () => {
                for (let index = 0; index < 8; index += 1) {
                  window.scrollTo(0, index % 2 === 0 ? document.body.scrollHeight : 0);
                  await new Promise((resolve) => setTimeout(resolve, 80));
                }
              });
            });
            const chatRoute = getVerificationRoute(verificationTarget, "chat");
            const seededChatHref = withVerificationRouteParams(chatRoute.href, {
              sessionId: seedResponse.body.sessionId,
            });
            await page.goto(buildVerificationUiUrl(stack.uiUrl, seededChatHref), { waitUntil: "domcontentloaded" });
            await waitForVerificationRouteReady(page, chatRoute, verificationPackageName);
          } else {
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
            dashboardPerf = await measureLongTaskProfile(page, async () => {
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
          }
          chatPerf = await measureLongTaskProfile(page, async () => {
            await page.evaluate(async () => {
              const rail =
                document.querySelector(".chat-v11-session-rail") ?? document.querySelector(".mc-next-threaded-rail");
              const thread =
                document.querySelector(".chat-v11-thread-view") ?? document.querySelector(".mc-next-thread-scroll");
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

      const chatCommand = await requestJson(
        gatewayUrl,
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/commands/parse`,
        {
          method: "POST",
          body: {
            commandText: "/help",
          },
        },
      );
      assertOk(chatCommand, "parse chat command");
      if (chatCommand.body?.ok !== true || chatCommand.body?.command !== "/help") {
        throw new Error(`expected /help command parse to succeed: ${JSON.stringify(chatCommand.body ?? null)}`);
      }

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

      const completedRun = await waitForCodeModeRunCompletion(gatewayUrl, runId, {
        workspaceId: seed.workspaceId,
        sessionId,
      });
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
        chatCommand: chatCommand.body,
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
          workspaceId,
          activityType: "comment",
          message: "Verification activity trail entry",
          metadata: { source: "deep-core" },
        },
      });
      assertOk(activity, "append task activity");
      const deliverable = await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`, {
        method: "POST",
        body: {
          workspaceId,
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
        body: { workspaceId },
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

        const chatCommand = await requestJson(
          stack.gatewayUrl,
          `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/commands/parse`,
          {
            method: "POST",
            body: {
              commandText: "/help",
            },
          },
        );
        assertOk(chatCommand, "parse operator-proof chat command");
        if (chatCommand.body?.ok !== true || chatCommand.body?.command !== "/help") {
          throw new Error(`expected /help command parse to succeed: ${JSON.stringify(chatCommand.body ?? null)}`);
        }

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

        const completedRun = await waitForCodeModeRunCompletion(stack.gatewayUrl, runId, {
          workspaceId: seedResponse.body.workspaceId,
          sessionId,
        });
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
          chatCommand: chatCommand.body,
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

  const operatorToken = "verification-operator-token";
  const operatorHeaders = {
    Authorization: `Bearer ${operatorToken}`,
  };
  const authStack = await startVerificationStack(context, {
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_TOKEN: operatorToken,
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
    },
  });
  try {
    await ensureOnboardingComplete(authStack.gatewayUrl, "verification-operator-proof-auth", operatorHeaders);
    await runScenario(
      context,
      {
        id: "operator-proof.auth-boundary.device-companion-denied",
        lane: "operator-proof",
        title: "Token-auth stack denies device and companion principals on privileged control-plane routes",
        subsystem: "gateway",
      },
      async () => {
        const deviceRequest = await requestJson(authStack.gatewayUrl, "/api/v1/auth/device-requests", {
          method: "POST",
          body: {
            deviceLabel: "Verification Device",
            deviceType: "desktop",
            platform: "windows",
          },
        });
        assertOk(deviceRequest, "create anonymous device access request");
        const approvalId = deviceRequest.body?.approvalId;
        const requestId = deviceRequest.body?.requestId;
        const requestSecret = deviceRequest.body?.requestSecret;
        if (!approvalId || !requestId || !requestSecret) {
          throw new Error(
            `device request did not return approvalId/requestId/requestSecret: ${JSON.stringify(deviceRequest.body)}`,
          );
        }

        const resolvedApproval = await requestJson(
          authStack.gatewayUrl,
          `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
          {
            method: "POST",
            headers: operatorHeaders,
            body: {
              decision: "approve",
              resolvedBy: "verification-operator-proof",
              resolutionNote: "verification auth boundary approval resolution",
            },
          },
        );
        assertOk(resolvedApproval, "approve device access request");

        const approvedStatus = await waitForApprovedDeviceAccessRequest(authStack.gatewayUrl, requestId, requestSecret);
        const deviceToken = approvedStatus.body?.deviceToken;
        if (typeof deviceToken !== "string" || deviceToken.length === 0) {
          throw new Error(
            `device request approval did not yield a device token: ${JSON.stringify(approvedStatus.body)}`,
          );
        }

        const companionKeys = generateKeyPairSync("ed25519");
        const signingPublicKeyPem = companionKeys.publicKey.export({
          type: "spki",
          format: "pem",
        });
        const exchange = await requestJson(authStack.gatewayUrl, "/api/v1/auth/companion/session/exchange", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deviceToken}`,
          },
          body: {
            signingPublicKeyPem:
              typeof signingPublicKeyPem === "string" ? signingPublicKeyPem : signingPublicKeyPem.toString("utf8"),
            clientName: "Verification Companion",
            appVersion: "1.0.0",
          },
        });
        assertOk(exchange, "exchange device grant for companion session");
        const companionToken = exchange.body?.accessToken;
        if (typeof companionToken !== "string" || companionToken.length === 0) {
          throw new Error(`companion exchange did not return an access token: ${JSON.stringify(exchange.body)}`);
        }

        const deniedChecks = [
          {
            actor: "device",
            route: "/api/v1/admin/retention",
            response: await requestJson(authStack.gatewayUrl, "/api/v1/admin/retention", {
              headers: {
                Authorization: `Bearer ${deviceToken}`,
              },
            }),
          },
          {
            actor: "device",
            route: "/api/v1/durable/diagnostics",
            response: await requestJson(authStack.gatewayUrl, "/api/v1/durable/diagnostics", {
              headers: {
                Authorization: `Bearer ${deviceToken}`,
              },
            }),
          },
          {
            actor: "device",
            route: "/api/v1/approvals?status=pending&limit=20",
            response: await requestJson(authStack.gatewayUrl, "/api/v1/approvals?status=pending&limit=20", {
              headers: {
                Authorization: `Bearer ${deviceToken}`,
              },
            }),
          },
          {
            actor: "device",
            route: `/api/v1/approvals/${encodeURIComponent(approvalId)}/replay`,
            response: await requestJson(
              authStack.gatewayUrl,
              `/api/v1/approvals/${encodeURIComponent(approvalId)}/replay`,
              {
                headers: {
                  Authorization: `Bearer ${deviceToken}`,
                },
              },
            ),
          },
          {
            actor: "device",
            route: `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
            response: await requestJson(
              authStack.gatewayUrl,
              `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${deviceToken}`,
                },
                body: {
                  decision: "approve",
                  resolvedBy: "verification-device",
                },
              },
            ),
          },
          {
            actor: "device",
            route: "/api/v1/approvals/bulk-resolve",
            response: await requestJson(authStack.gatewayUrl, "/api/v1/approvals/bulk-resolve", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${deviceToken}`,
              },
              body: {
                decision: "reject",
              },
            }),
          },
          {
            actor: "device",
            route: `/api/v1/approvals/${encodeURIComponent(approvalId)}/remote-token`,
            response: await requestJson(
              authStack.gatewayUrl,
              `/api/v1/approvals/${encodeURIComponent(approvalId)}/remote-token`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${deviceToken}`,
                },
                body: {
                  connectorId: "verification-companion",
                },
              },
            ),
          },
          {
            actor: "companion",
            route: "/api/v1/admin/retention",
            response: await requestJson(authStack.gatewayUrl, "/api/v1/admin/retention", {
              headers: {
                Authorization: `Bearer ${companionToken}`,
              },
            }),
          },
          {
            actor: "companion",
            route: "/api/v1/auth/devices?view=all",
            response: await requestJson(authStack.gatewayUrl, "/api/v1/auth/devices?view=all", {
              headers: {
                Authorization: `Bearer ${companionToken}`,
              },
            }),
          },
          {
            actor: "companion",
            route: "/api/v1/approvals?status=pending&limit=20",
            response: await requestJson(authStack.gatewayUrl, "/api/v1/approvals?status=pending&limit=20", {
              headers: {
                Authorization: `Bearer ${companionToken}`,
              },
            }),
          },
          {
            actor: "companion",
            route: `/api/v1/approvals/${encodeURIComponent(approvalId)}/replay`,
            response: await requestJson(
              authStack.gatewayUrl,
              `/api/v1/approvals/${encodeURIComponent(approvalId)}/replay`,
              {
                headers: {
                  Authorization: `Bearer ${companionToken}`,
                },
              },
            ),
          },
          {
            actor: "companion",
            route: "/api/v1/approvals/bulk-resolve",
            response: await requestJson(authStack.gatewayUrl, "/api/v1/approvals/bulk-resolve", {
              method: "POST",
              headers: buildCompanionSignedHeaders({
                token: companionToken,
                privateKey: companionKeys.privateKey,
                path: "/api/v1/approvals/bulk-resolve",
                nonce: "approval-bulk-resolve",
                body: {
                  decision: "reject",
                },
              }),
              body: {
                decision: "reject",
              },
            }),
          },
          {
            actor: "companion",
            route: `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
            response: await requestJson(
              authStack.gatewayUrl,
              `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
              {
                method: "POST",
                headers: buildCompanionSignedHeaders({
                  token: companionToken,
                  privateKey: companionKeys.privateKey,
                  path: `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
                  nonce: "approval-resolve",
                  body: {
                    decision: "approve",
                    resolvedBy: "verification-companion",
                  },
                }),
                body: {
                  decision: "approve",
                  resolvedBy: "verification-companion",
                },
              },
            ),
          },
          {
            actor: "companion",
            route: `/api/v1/approvals/${encodeURIComponent(approvalId)}/remote-token`,
            response: await requestJson(
              authStack.gatewayUrl,
              `/api/v1/approvals/${encodeURIComponent(approvalId)}/remote-token`,
              {
                method: "POST",
                headers: buildCompanionSignedHeaders({
                  token: companionToken,
                  privateKey: companionKeys.privateKey,
                  path: `/api/v1/approvals/${encodeURIComponent(approvalId)}/remote-token`,
                  nonce: "approval-remote-token",
                  body: {
                    connectorId: "verification-companion",
                  },
                }),
                body: {
                  connectorId: "verification-companion",
                },
              },
            ),
          },
        ];

        for (const denied of deniedChecks) {
          if (denied.response.status !== 403) {
            throw new Error(
              `${denied.actor} credential unexpectedly reached ${denied.route}: ${JSON.stringify({
                status: denied.response.status,
                body: denied.response.body,
              })}`,
            );
          }
        }

        const outPath = path.join(context.artifactRoot, "diagnostics", "operator-proof-auth-boundary.json");
        await writeJson(outPath, {
          deviceRequest: deviceRequest.body,
          resolvedApproval: resolvedApproval.body,
          approvedStatus: approvedStatus.body,
          companionExchange: exchange.body,
          deniedChecks: deniedChecks.map((entry) => ({
            actor: entry.actor,
            route: entry.route,
            status: entry.response.status,
            body: entry.response.body,
          })),
        });
        return {
          status: "passed",
          metrics: {
            deniedCount: deniedChecks.length,
          },
          artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
        };
      },
    );
  } finally {
    await stopVerificationStack(authStack);
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
  const verificationTarget = resolveVerificationTargetContext();
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
    const fixture = verificationTarget.isNext
      ? await seedMissionControlNextFixture(stack.gatewayUrl, { runtimeRoot: stack.runtimeRoot })
      : null;
    const browser = await chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext({
        viewport: { width: 1440, height: 1024 },
        colorScheme: "dark",
      });
      if (fixture && verificationTarget.isNext) {
        await installMissionControlNextBrowserState(browserContext, fixture.workspaceId);
      }
      const page = await browserContext.newPage();
      const browserLog = attachBrowserLogging(page);

      for (const route of verificationTarget.surfaceRoutes) {
        await runScenario(
          context,
          {
            id: `surface-regression.${route.slug}`,
            lane: "surface-regression",
            title: `${route.slug} renders in Mission Control`,
            subsystem: "mission-control",
          },
          async ({ correlationId }) => {
            const browserLogCursor = browserLog.mark();
            await page.goto(buildVerificationUiUrl(stack.uiUrl, route.href), { waitUntil: "domcontentloaded" });
            await waitForVerificationRouteReady(page, route, verificationTarget.packageName);
            await setBrowserCorrelation(page, correlationId, fixture?.sessionId);
            await performVerificationInteraction(page, route.interaction, verificationTarget.packageName);
            const browserSanity = assertBrowserConsoleHealthy(
              browserLog,
              browserLogCursor,
              verificationTarget.packageName,
            );
            await page.waitForTimeout(250);
            const artifacts = await captureBrowserArtifacts(context, {
              slug: `surface-regression-${route.slug}`,
              page,
              browserLog,
              gatewayUrl: stack.gatewayUrl,
              correlationId,
              logCursor: browserLogCursor,
            });
            return {
              status: "passed",
              metrics: {
                route: route.href,
                consoleErrors: browserSanity.consoleErrors.length,
                pageErrors: browserSanity.pageErrors.length,
              },
              artifacts,
            };
          },
        );
      }

      for (const redirect of verificationTarget.redirectRoutes) {
        const route = verificationTarget.routeByHref.get(redirect.expectedPath);
        if (!route) {
          throw new Error(`verification redirect target was not mapped: ${redirect.expectedPath}`);
        }
        await runScenario(
          context,
          {
            id: `surface-regression.redirect.${redirect.slug}`,
            lane: "surface-regression",
            title: `${redirect.slug} redirects into Mission Control Next`,
            subsystem: "mission-control",
          },
          async ({ correlationId }) => {
            const browserLogCursor = browserLog.mark();
            await page.goto(buildVerificationUiUrl(stack.uiUrl, redirect.href), { waitUntil: "domcontentloaded" });
            await waitForMissionControlShell(page, { packageName: verificationTarget.packageName });
            await assertLegacyRedirectResolution(page, redirect.expectedPath);
            await waitForVerificationRouteReady(page, route, verificationTarget.packageName);
            await setBrowserCorrelation(page, correlationId, fixture?.sessionId);
            await performVerificationInteraction(
              page,
              redirect.interaction ?? route.interaction,
              verificationTarget.packageName,
            );
            const browserSanity = assertBrowserConsoleHealthy(
              browserLog,
              browserLogCursor,
              verificationTarget.packageName,
            );
            const artifacts = await captureBrowserArtifacts(context, {
              slug: `surface-regression-redirect-${redirect.slug}`,
              page,
              browserLog,
              gatewayUrl: stack.gatewayUrl,
              correlationId,
              logCursor: browserLogCursor,
            });
            return {
              status: "passed",
              metrics: {
                href: redirect.href,
                expectedPath: redirect.expectedPath,
                consoleErrors: browserSanity.consoleErrors.length,
                pageErrors: browserSanity.pageErrors.length,
              },
              artifacts,
            };
          },
        );
      }

      await browserContext.close();

      if (verificationTarget.isNext) {
        await runMissionControlNextMobileShellProof(context, {
          browser,
          gatewayUrl: stack.gatewayUrl,
          uiUrl: stack.uiUrl,
          workspaceId: fixture?.workspaceId ?? "default",
          sessionId: fixture?.sessionId,
          packageName: verificationTarget.packageName,
        });
      }
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
        const visibleCatalogKinds = ["channel", "model_provider", "productivity", "automation", "platform"];
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
        const nonOperatorReady = targetedEntries.filter(
          (item) => item.maturity !== "beta" && item.maturity !== "native",
        );
        const pluginVisible = targetedEntries.filter((item) => item.maturity === "plugin");
        const blockedWithoutSchema = targetedEntries.filter(
          (item) => !item.formSchema || !Array.isArray(item.formSchema.fields) || item.formSchema.fields.length === 0,
        );
        if (targetedEntries.length !== mandatoryVisibleIds.size) {
          throw new Error(
            `catalog parity expected ${mandatoryVisibleIds.size} mandatory visible entries, found ${targetedEntries.length}`,
          );
        }
        if (plannedEntries.length > 0) {
          throw new Error(
            `catalog parity found visible planned entries: ${plannedEntries.map((item) => item.catalogId).join(", ")}`,
          );
        }
        if (nonOperatorReady.length > 0) {
          throw new Error(
            `catalog parity found non-operator-ready entries: ${nonOperatorReady.map((item) => `${item.catalogId}:${item.maturity}`).join(", ")}`,
          );
        }
        if (pluginVisible.length > 0) {
          throw new Error(
            `catalog parity found visible plugin-backed entries: ${pluginVisible.map((item) => item.catalogId).join(", ")}`,
          );
        }
        if (targetedEntries.some((item) => item.runtimeAvailability !== "runnable")) {
          throw new Error(
            `catalog parity found non-runnable mandatory entries: ${targetedEntries
              .filter((item) => item.runtimeAvailability !== "runnable")
              .map((item) => item.catalogId)
              .join(", ")}`,
          );
        }
        if (blockedWithoutSchema.length > 0) {
          throw new Error(
            `catalog parity found mandatory entries without guided form schema: ${blockedWithoutSchema.map((item) => item.catalogId).join(", ")}`,
          );
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
        const allowlist = await readJson(API_COMPAT_ALLOWLIST_PATH).catch(() => ({
          removedRestPaths: [],
          removedRestMethods: [],
          removedRestResponses: [],
          removedSseEventTypes: [],
          removedSseEnvelopeFields: [],
        }));
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
        const providerConfigSnapshot = configSnapshots.find(
          (item) => item.relativePath === "config/llm-providers.json",
        );
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
          createdRetentionPolicy.body?.transcriptsDays !== dbSentinelPolicy.transcriptsDays ||
          createdRetentionPolicy.body?.auditDays !== dbSentinelPolicy.auditDays
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
        const restoredRetentionPolicy = await requestJson(stack.gatewayUrl, "/api/v1/admin/retention");
        assertOk(restoredRetentionPolicy, "read retention policy after restore");
        const retentionRestored =
          restoredRetentionPolicy.body?.transcriptsDays === dbSentinelPolicy.transcriptsDays &&
          restoredRetentionPolicy.body?.auditDays === dbSentinelPolicy.auditDays &&
          restoredRetentionPolicy.body?.backupsKeep === dbSentinelPolicy.backupsKeep;
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
          throw new Error(
            `backup manifest missed part of the minimum backup set: ${JSON.stringify(expectedManifestChecks)}`,
          );
        }
        const verifiedConfigCoverage = Array.isArray(
          verifiedBackup.body?.contractCoverage?.minimumSet?.config?.expectedPaths,
        )
          ? [...verifiedBackup.body.contractCoverage.minimumSet.config.expectedPaths].sort((left, right) =>
              left.localeCompare(right),
            )
          : [];
        const expectedConfigCoverage = configSnapshots
          .map((snapshot) => snapshot.relativePath)
          .sort((left, right) => left.localeCompare(right));
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
  const verificationTarget = resolveVerificationTargetContext();
  const updateBaselines = maybeParseBool(options.updateBaselines, false);
  const scenarioLane = updateBaselines ? "visual-rebaseline" : "visual-regression";
  const scenarioTitleSuffix = updateBaselines ? "baseline refresh" : "baseline renders";
  if (!updateBaselines) {
    await assertVisualBaselineCoverage(context, { packageName: verificationTarget.packageName });
  }
  const stack = await startVerificationStack(context, {
    includeUi: true,
    gatewayMode: "built",
    uiMode: "preview",
    gatewayEnv: {
      GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
      GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
      GOATCITADEL_MESH_NODE_ID: "build-main",
      OPENAI_API_KEY: "sk-visual-regression",
    },
    uiEnv: {
      VITE_GOATCITADEL_VISUAL_REGRESSION_MODE: "true",
    },
  });
  try {
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-visual-regression");
    await pinVisualRegressionProvider(stack.gatewayUrl);
    const fixture = verificationTarget.isNext
      ? await seedMissionControlNextFixture(stack.gatewayUrl, { runtimeRoot: stack.runtimeRoot })
      : null;
    const manualProofArtifacts = [];
    const browser = await chromium.launch({ headless: true });
    try {
      for (const variant of verificationTarget.visualVariants) {
        const browserContext = await browser.newContext({
          viewport: variant.viewport,
          colorScheme: variant.colorScheme,
          timezoneId: "UTC",
        });
        if (fixture && verificationTarget.isNext) {
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId);
        }
        try {
          const page = await browserContext.newPage();
          const browserLog = attachBrowserLogging(page);
          for (const route of verificationTarget.visualRoutes) {
            const scenarioRecord = await runScenario(
              context,
              {
                id: `${scenarioLane}.${route.slug}.${variant.slug}`,
                lane: scenarioLane,
                title: `${route.slug} ${variant.slug} ${scenarioTitleSuffix}`,
                subsystem: "mission-control",
              },
              async ({ correlationId }) => {
                const browserLogCursor = browserLog.mark();
                await page.goto(buildVerificationUiUrl(stack.uiUrl, resolveVisualRouteHref(route, variant, fixture)), {
                  waitUntil: "domcontentloaded",
                });
                try {
                  await waitForVerificationRouteReady(
                    page,
                    route,
                    verificationTarget.packageName,
                    VISUAL_ROUTE_READY_TIMEOUT_MS,
                  );
                } catch (readyError) {
                  return await captureRouteReadyFailure(context, {
                    page,
                    browserLog,
                    browserLogCursor,
                    route,
                    variant,
                    scenarioLane,
                    timeoutMs: VISUAL_ROUTE_READY_TIMEOUT_MS,
                    readyError,
                  });
                }
                const correlationSessionId =
                  (route?.fixtureSessionKey && fixture?.sessions?.[route.fixtureSessionKey]) || fixture?.sessionId;
                await setBrowserCorrelation(page, correlationId, correlationSessionId);
                const browserSanity = assertBrowserConsoleHealthy(
                  browserLog,
                  browserLogCursor,
                  verificationTarget.packageName,
                );
                await page.evaluate(async () => {
                  if (document.fonts?.ready) {
                    await document.fonts.ready;
                  }
                });
                await page.waitForTimeout(1000);
                await stabilizeVisualRegressionSnapshot(page);
                const baselineSlug = `visual-regression-${route.slug}-${variant.slug}`;
                const artifactSlug = `${scenarioLane}-${route.slug}-${variant.slug}`;
                const artifacts = await captureBrowserArtifacts(context, {
                  slug: artifactSlug,
                  page,
                  browserLog,
                  gatewayUrl: stack.gatewayUrl,
                  correlationId,
                  logCursor: browserLogCursor,
                });
                const comparison = await compareVisualBaseline(context, baselineSlug, {
                  artifactSlug,
                  updateBaselines,
                  packageName: verificationTarget.packageName,
                });
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
                    consoleErrors: browserSanity.consoleErrors.length,
                    pageErrors: browserSanity.pageErrors.length,
                  },
                  artifacts: {
                    ...artifacts,
                    screenshots: [...artifacts.screenshots, ...comparison.screenshots],
                    diagnostics: [...artifacts.diagnostics, ...comparison.diagnostics],
                  },
                };
              },
            );
            if (verificationTarget.isNext && scenarioRecord?.artifacts?.screenshots?.length) {
              manualProofArtifacts.push({
                routeSlug: route.slug,
                variantSlug: variant.slug,
                screenshots: scenarioRecord.artifacts.screenshots,
              });
            }
          }
        } finally {
          await browserContext.close();
        }
      }
    } finally {
      await browser.close();
    }

    if (verificationTarget.isNext) {
      await writeMissionControlNextManualProofChecklist(context, manualProofArtifacts);
    }
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function runDeepEcosystemLane(context, options = {}) {
  const verificationTarget = resolveVerificationTargetContext();
  const verificationPackageName = verificationTarget.packageName;
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
          if (verificationTarget.isNext) {
            const officeSuccessorRoute = getVerificationRoute(verificationTarget, "cowork-board");
            await page.goto(buildVerificationUiUrl(stack.uiUrl, officeSuccessorRoute.href), {
              waitUntil: "domcontentloaded",
            });
            await waitForVerificationRouteReady(page, officeSuccessorRoute, verificationPackageName);
          } else {
            await page.goto(`${stack.uiUrl}/?tab=office`, { waitUntil: "domcontentloaded" });
            await page.waitForSelector(".office-stage-panel", { timeout: 25000 });
          }
          await setBrowserCorrelation(page, correlationId);
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
            notes: [
              verificationTarget.isNext
                ? "Office successor route rendered with reduced effects enabled."
                : "Office route rendered with reduced effects enabled.",
            ],
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

export async function runRuntimeTruthLane(context, options = {}) {
  let stack;
  const restoreUiPackage = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    stack = await startVerificationStack(context, {
      includeUi: true,
      gatewayEnv: {
        GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
        GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
        GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
        GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-runtime-truth");

    await runScenario(
      context,
      {
        id: "runtime-truth.approval-restart-ui-consistency",
        lane: "runtime-truth",
        title: "Approval-gated durable work survives restart and the canonical next shell matches backend truth",
        subsystem: "mission-control",
      },
      async ({ correlationId }) => {
        const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
          method: "POST",
          body: {
            workspaceName: "Runtime Truth Verification Workspace",
            sessionTitle: "Runtime Truth Verification Session",
            sessionCount: 3,
            longThreadTurns: 10,
          },
        });
        assertOk(seeded, "seed runtime-truth workspace");

        const approvalSeed = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/chat-approval-scenario", {
          method: "POST",
          body: {
            sessionId: seeded.body?.sessionId,
            workspaceId: seeded.body?.workspaceId,
          },
        });
        assertOk(approvalSeed, "seed runtime-truth approval");

        const approvalId = approvalSeed.body?.approvalId;
        const sessionId = approvalSeed.body?.sessionId;
        const durableRunId = approvalSeed.body?.chatTurnDurableRunId;
        if (!approvalId || !sessionId || !durableRunId) {
          throw new Error(
            `runtime-truth seed missing approval/session/run identifiers: ${JSON.stringify(approvalSeed.body)}`,
          );
        }

        const beforeRestart = await requestJson(
          stack.gatewayUrl,
          `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}`,
        );
        assertOk(beforeRestart, "read runtime-truth durable run before restart");

        stack.gateway = await restartGatewayProcess(context, stack, {
          GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
          GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
          GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
          GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
        });

        const approved = await requestJson(stack.gatewayUrl, "/api/v1/chat/tools/approve", {
          method: "POST",
          body: {
            sessionId,
            approvalId,
            allowScope: "once",
          },
        });
        assertOk(approved, "resume runtime-truth approval-gated turn");
        if (approved.body?.resumedRunId !== durableRunId) {
          throw new Error(
            `runtime-truth expected resumed run ${durableRunId}, got ${approved.body?.resumedRunId ?? "unknown"}`,
          );
        }

        const durableRun = await waitForDurableRunStatus(stack.gatewayUrl, durableRunId, ["running", "completed"]);
        const lifecycle = await requestJson(
          stack.gatewayUrl,
          `/api/v1/runtime/lifecycle?approvalId=${encodeURIComponent(approvalId)}`,
        );
        assertOk(lifecycle, "read runtime-truth lifecycle");

        const browser = await chromium.launch({ headless: true });
        try {
          const browserContext = await browser.newContext({
            viewport: { width: 1440, height: 1024 },
            colorScheme: "dark",
          });
          await installMissionControlNextBrowserState(browserContext, seeded.body.workspaceId);
          const page = await browserContext.newPage();
          const browserLog = attachBrowserLogging(page);
          const browserLogCursor = browserLog.mark();

          await page.goto(
            buildVerificationUiUrl(stack.uiUrl, `/ops/approvals?approvalId=${encodeURIComponent(approvalId)}`),
            { waitUntil: "domcontentloaded" },
          );
          await waitForVerificationRouteReady(
            page,
            {
              expectedArea: "ops",
              expectedSection: "approvals",
              readyText: "Approval queue",
            },
            NEXT_UI_PACKAGE,
          );
          await setBrowserCorrelation(page, correlationId, sessionId);
          await page.getByRole("tab", { name: /History/i }).click();
          await page.getByRole("button", { name: /Load durable status/i }).click();
          await page.getByText("Status:", { exact: false }).first().waitFor({ timeout: 15000 });
          await page.getByText("Updated:", { exact: false }).first().waitFor({ timeout: 15000 });
          const runtimePreview = await page.evaluate(() => document.body?.innerText ?? "");
          const acceptableStatuses = [...new Set([durableRun.body?.status, "running", "completed"].filter(Boolean))];
          if (!acceptableStatuses.some((status) => runtimePreview.includes(`Status: ${status}`))) {
            throw new Error(
              `runtime-truth expected one of ${acceptableStatuses.join(", ")} in the approvals recovery panel`,
            );
          }
          const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, NEXT_UI_PACKAGE);
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "runtime-truth-approval-restart-ui-consistency",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
            logCursor: browserLogCursor,
          });
          const outPath = path.join(
            context.artifactRoot,
            "diagnostics",
            "runtime-truth-approval-restart-ui-consistency.json",
          );
          await writeJson(outPath, {
            seeded: seeded.body,
            approvalSeed: approvalSeed.body,
            beforeRestart: beforeRestart.body,
            approved: approved.body,
            durableRun: durableRun.body,
            lifecycle: lifecycle.body,
          });
          return {
            status: "passed",
            metrics: {
              durableStatus: durableRun.body?.status,
              consoleErrors: browserSanity.consoleErrors.length,
              pageErrors: browserSanity.pageErrors.length,
            },
            artifacts: {
              ...artifacts,
              diagnostics: [...artifacts.diagnostics, relativeToRun(context, outPath)],
            },
          };
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    if (stack) {
      await stopVerificationStack(stack);
    }
    restoreUiPackage();
  }
}

export async function runAuthMatrixLane(context, options = {}) {
  const operatorToken = "verification-auth-matrix-token";
  const approvalCreateToken = "verification-approval-create-token";
  const operatorHeaders = {
    Authorization: `Bearer ${operatorToken}`,
  };
  const stack = await startVerificationStack(context, {
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_TOKEN: operatorToken,
      GOATCITADEL_REMOTE_APPROVAL_CREATE_TOKEN: approvalCreateToken,
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
    },
  });
  try {
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-auth-matrix", operatorHeaders);
    await runScenario(
      context,
      {
        id: "auth-matrix.route-access-principals",
        lane: "auth-matrix",
        title: "Tracked route-access classes enforce the expected principal matrix",
        subsystem: "gateway",
      },
      async () => {
        const manifestResponse = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/route-access-manifest", {
          headers: operatorHeaders,
        });
        assertOk(manifestResponse, "fetch route-access manifest");

        const deviceAndCompanion = await createAuthMatrixCredentials(stack.gatewayUrl, operatorHeaders);
        const sseToken = await issueOperatorSseToken(stack.gatewayUrl, operatorHeaders);
        const manifestItems = Array.isArray(manifestResponse.body?.items) ? manifestResponse.body.items : [];
        const missingTracked = Array.isArray(manifestResponse.body?.missingTracked)
          ? manifestResponse.body.missingTracked
          : [];
        if (missingTracked.length > 0) {
          throw new Error(
            `auth-matrix route-access manifest has unclassified tracked routes: ${clampString(JSON.stringify(missingTracked), 800)}`,
          );
        }
        const accessClasses = [...new Set(manifestItems.map((item) => item.accessClass).filter(Boolean))];
        const results = [];
        const skippedAccessClasses = [];

        for (const accessClass of accessClasses) {
          const representative = selectRepresentativeManifestRoute(manifestItems, accessClass);
          if (!representative) {
            if (accessClass === "webhook") {
              skippedAccessClasses.push(accessClass);
              continue;
            }
            throw new Error(`auth-matrix could not find a representative route for ${accessClass}`);
          }
          const expectations = buildAuthMatrixExpectations(accessClass);
          for (const [caller, expected] of Object.entries(expectations)) {
            const probe = await probeAuthMatrixRoute(stack.gatewayUrl, representative, {
              caller,
              operatorHeaders,
              deviceToken: deviceAndCompanion.deviceToken,
              companionToken: deviceAndCompanion.companionToken,
              companionPrivateKey: deviceAndCompanion.companionPrivateKey,
              companionPublicKey: deviceAndCompanion.companionPublicKey,
              sseToken,
            });
            const allowed = isAllowedStatus(probe.status);
            if (allowed !== expected) {
              throw new Error(
                `auth-matrix ${accessClass} expected ${caller} to be ${expected ? "allowed" : "denied"} on ${representative.method} ${representative.url}, got ${probe.status} with ${clampString(JSON.stringify(probe.body ?? probe.preview ?? null), 400)}`,
              );
            }
            results.push({
              accessClass,
              caller,
              method: representative.method,
              url: representative.url,
              status: probe.status,
              allowed,
            });
          }
        }

        await assertHighRiskRouteFamiliesAreOperatorGated(stack.gatewayUrl, manifestItems, {
          operatorHeaders,
          deviceToken: deviceAndCompanion.deviceToken,
          companionToken: deviceAndCompanion.companionToken,
        });
        const approvalIngressResults = await assertApprovalIngressMatrix(
          stack.gatewayUrl,
          approvalCreateToken,
          operatorHeaders,
        );

        const outPath = path.join(context.artifactRoot, "diagnostics", "auth-matrix-route-access.json");
        await writeJson(outPath, {
          manifest: manifestResponse.body,
          results,
          approvalIngressResults,
          skippedAccessClasses,
        });
        return {
          status: "passed",
          metrics: {
            representedAccessClasses: accessClasses.length,
            skippedAccessClasses: skippedAccessClasses.length,
            checks: results.length,
          },
          artifacts: emptyArtifacts({
            diagnostics: [relativeToRun(context, outPath)],
          }),
        };
      },
    );
  } finally {
    await stopVerificationStack(stack);
  }
}

async function assertApprovalIngressMatrix(gatewayUrl, approvalCreateToken, operatorHeaders) {
  const body = {
    kind: "tool_request",
    riskLevel: "caution",
    payload: { toolName: "verification.approval.create" },
    preview: { summary: "Auth matrix remote approval creation proof" },
    sourceConnectorId: "auth-matrix-connector",
    sourceTraceId: "auth-matrix-trace",
  };
  const probes = [
    {
      label: "missing-create-token",
      expectedAllowed: false,
      response: await requestJson(gatewayUrl, "/api/v1/approvals", {
        method: "POST",
        headers: {
          "Idempotency-Key": "auth-matrix-approval-create-missing-token",
        },
        body,
      }),
    },
    {
      label: "bad-create-token",
      expectedAllowed: false,
      response: await requestJson(gatewayUrl, "/api/v1/approvals", {
        method: "POST",
        headers: {
          "Idempotency-Key": "auth-matrix-approval-create-bad-token",
          "X-GoatCitadel-Approval-Create-Token": "bad-token",
        },
        body,
      }),
    },
    {
      label: "valid-create-token",
      expectedAllowed: true,
      response: await requestJson(gatewayUrl, "/api/v1/approvals", {
        method: "POST",
        headers: {
          "Idempotency-Key": "auth-matrix-approval-create-valid-token",
          "X-GoatCitadel-Approval-Create-Token": approvalCreateToken,
        },
        body,
      }),
    },
  ];

  const results = [];
  for (const probe of probes) {
    const allowed = isAllowedStatus(probe.response.status);
    if (allowed !== probe.expectedAllowed) {
      throw new Error(
        `auth-matrix remote approval create ${probe.label} expected ${probe.expectedAllowed ? "allowed" : "denied"}, got ${probe.response.status} with ${clampString(JSON.stringify(probe.response.body ?? null), 400)}`,
      );
    }
    results.push({
      label: probe.label,
      status: probe.response.status,
      allowed,
    });
  }
  const createdApprovalId = probes.find((probe) => probe.label === "valid-create-token")?.response.body?.approvalId;
  if (!createdApprovalId) {
    throw new Error("auth-matrix remote approval create did not return an approvalId for remote-resolve proof");
  }
  const remoteToken = await requestJson(
    gatewayUrl,
    `/api/v1/approvals/${encodeURIComponent(createdApprovalId)}/remote-token`,
    {
      method: "POST",
      headers: operatorHeaders,
      body: {
        connectorId: "browser:mission-control",
      },
    },
  );
  assertOk(remoteToken, "create auth-matrix remote approval action token");
  const token = remoteToken.body?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`auth-matrix remote approval action token missing token: ${JSON.stringify(remoteToken.body)}`);
  }
  const remoteResolve = await requestJson(gatewayUrl, "/api/v1/approvals/remote-resolve", {
    method: "POST",
    headers: {
      Authorization: "Bearer invalid-operator-token",
    },
    body: {
      token,
      decision: "reject",
      resolutionNote: "auth matrix remote approval resolution proof",
    },
  });
  const remoteResolveAllowed = isAllowedStatus(remoteResolve.status);
  if (!remoteResolveAllowed) {
    throw new Error(
      `auth-matrix remote approval resolve expected public scoped-token route to be reachable, got ${remoteResolve.status} with ${clampString(JSON.stringify(remoteResolve.body ?? null), 400)}`,
    );
  }
  results.push({
    label: "valid-remote-resolve-token",
    status: remoteResolve.status,
    allowed: remoteResolveAllowed,
  });
  return results;
}

async function assertHighRiskRouteFamiliesAreOperatorGated(gatewayUrl, manifestItems, credentials) {
  const representatives = [
    { family: "mcp", method: "GET", url: "/api/v1/mcp/servers" },
    { family: "tools", method: "GET", url: "/api/v1/tools/catalog" },
    { family: "llm", method: "GET", url: "/api/v1/llm/config" },
    { family: "integrations", method: "GET", url: "/api/v1/integrations/catalog" },
    { family: "addons", method: "GET", url: "/api/v1/addons/catalog" },
    { family: "capabilities", method: "GET", url: "/api/v1/capabilities/catalog" },
    { family: "code-mode", method: "GET", url: "/api/v1/code-mode/runs" },
  ];

  for (const representative of representatives) {
    const manifestItem = manifestItems.find(
      (item) => item.method === representative.method && item.url === representative.url,
    );
    if (!manifestItem?.accessClass) {
      throw new Error(
        `auth-matrix high-risk route ${representative.method} ${representative.url} is missing route-access metadata`,
      );
    }
    if (manifestItem.accessClass !== "operator") {
      throw new Error(
        `auth-matrix high-risk route ${representative.method} ${representative.url} must be operator-gated, got ${manifestItem.accessClass}`,
      );
    }

    const operatorProbe = await requestJson(gatewayUrl, representative.url, {
      method: representative.method,
      headers: credentials.operatorHeaders,
    });
    if (!isAllowedStatus(operatorProbe.status)) {
      throw new Error(
        `auth-matrix high-risk route ${representative.family} rejected operator caller with ${operatorProbe.status}`,
      );
    }

    for (const caller of ["device", "companion"]) {
      const token = caller === "device" ? credentials.deviceToken : credentials.companionToken;
      const deniedProbe = await requestJson(gatewayUrl, representative.url, {
        method: representative.method,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (deniedProbe.status !== 403) {
        throw new Error(
          `auth-matrix high-risk route ${representative.family} expected ${caller} to be denied with 403, got ${deniedProbe.status}`,
        );
      }
    }
  }
}

export async function runUiParityLane(context, options = {}) {
  const stack = await startVerificationStack(context, {
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED: "true",
      GOATCITADEL_FEATURE_MEMORY_MAINTENANCE_V1_ENABLED: "true",
      GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
    },
  });
  const nextUi = await startVerificationUiProcess(context, stack.gatewayUrl, NEXT_UI_PACKAGE, "ui-parity-next");
  try {
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-ui-parity");
    const fixture = await seedMissionControlNextFixture(stack.gatewayUrl);
    const approvals = await requestJson(stack.gatewayUrl, "/api/v1/approvals?status=pending&limit=20");
    assertOk(approvals, "read ui-parity approvals");
    const memoryItems = await requestJson(stack.gatewayUrl, "/api/v1/memory/items?status=all&limit=20");
    assertOk(memoryItems, "read ui-parity memory items");
    const events = await requestJson(stack.gatewayUrl, "/api/v1/events?limit=20");
    assertOk(events, "read ui-parity events");
    const approvalNeedle = approvals.body?.items?.[0]?.kind ?? approvals.body?.items?.[0]?.approvalId ?? "shell.exec";
    const memoryNeedle = "Memory items";
    const activityNeedle = events.body?.items?.[0]?.eventType ?? "approval_created";

    await runScenario(
      context,
      {
        id: "ui-parity.next-operator-surfaces",
        lane: "ui-parity",
        title:
          "Canonical Mission Control Next routes expose seeded operator facts (legacy comparison retired in Track D Phase 3)",
        subsystem: "mission-control",
      },
      async ({ correlationId }) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const nextContext = await browser.newContext({
            viewport: { width: 1440, height: 1024 },
            colorScheme: "dark",
          });
          await installMissionControlNextBrowserState(nextContext, fixture.workspaceId);

          const nextPage = await nextContext.newPage();
          const nextLog = attachBrowserLogging(nextPage);
          const nextCursor = nextLog.mark();

          const parity = {
            approvals: await collectUiParitySurface({
              page: nextPage,
              baseUrl: nextUi.uiUrl,
              href: `/ops/approvals`,
              route: { expectedArea: "ops", expectedSection: "approvals", readyText: "Approval queue" },
              packageName: NEXT_UI_PACKAGE,
              correlationId,
              sessionId: fixture.sessionId,
              needle: approvalNeedle,
            }),
            runtime: await collectUiParitySurface({
              page: nextPage,
              baseUrl: nextUi.uiUrl,
              href: "/ops/runtime",
              route: { expectedArea: "ops", expectedSection: "runtime", readyText: "Runtime posture" },
              packageName: NEXT_UI_PACKAGE,
              correlationId,
              sessionId: fixture.sessionId,
              needle: "Daemon",
            }),
            activity: await collectUiParitySurface({
              page: nextPage,
              baseUrl: nextUi.uiUrl,
              href: "/ops/activity",
              route: { expectedArea: "ops", expectedSection: "activity", readyText: "Activity feed" },
              packageName: NEXT_UI_PACKAGE,
              correlationId,
              sessionId: fixture.sessionId,
              needle: activityNeedle,
            }),
            memory: await collectUiParitySurface({
              page: nextPage,
              baseUrl: nextUi.uiUrl,
              href: "/library/memory",
              route: { expectedArea: "library", expectedSection: "memory", readyText: "Memory items" },
              packageName: NEXT_UI_PACKAGE,
              correlationId,
              sessionId: fixture.sessionId,
              needle: memoryNeedle,
            }),
          };

          const labelledChecks = [
            ["approvals", parity.approvals],
            ["runtime", parity.runtime],
            ["activity", parity.activity],
            ["memory", parity.memory],
          ];
          for (const [label, nextResult] of labelledChecks) {
            if (!nextResult.ready) {
              throw new Error(`ui-parity ${label} route did not become ready`);
            }
            if (!nextResult.needleVisible) {
              throw new Error(`ui-parity next ${label} surface did not expose the seeded fact ${nextResult.needle}`);
            }
          }

          const nextArtifacts = await captureBrowserArtifacts(context, {
            slug: "ui-parity-next",
            page: nextPage,
            browserLog: nextLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
            logCursor: nextCursor,
          });
          const outPath = path.join(context.artifactRoot, "diagnostics", "ui-parity-operator-surfaces.json");
          await writeJson(outPath, {
            fixture,
            approvalNeedle,
            activityNeedle,
            memoryNeedle,
            parity,
          });
          return {
            status: "passed",
            metrics: {
              approvalReady: Number(parity.approvals.needleVisible),
              activityReady: Number(parity.activity.needleVisible),
              memoryReady: Number(parity.memory.needleVisible),
            },
            artifacts: {
              diagnostics: [...nextArtifacts.diagnostics, relativeToRun(context, outPath)],
              screenshots: nextArtifacts.screenshots,
              traces: [],
              logs: nextArtifacts.logs,
              perf: [],
              playwright: nextArtifacts.playwright,
            },
          };
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    await stopProcess(nextUi.handle);
    await stopVerificationStack(stack);
  }
}

export async function runMemoryTruthLane(context, options = {}) {
  let stack;
  const restoreUiPackage = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    stack = await startVerificationStack(context, {
      includeUi: true,
      gatewayEnv: {
        GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED: "true",
        GOATCITADEL_FEATURE_MEMORY_MAINTENANCE_V1_ENABLED: "true",
        GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
      },
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-memory-truth");
    await runScenario(
      context,
      {
        id: "memory-truth.ttl-lifecycle-visibility",
        lane: "memory-truth",
        title:
          "TTL expiry hides active reads but remains visible as expired lifecycle truth in API and Mission Control Next",
        subsystem: "memory",
      },
      async ({ correlationId }) => {
        const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
          method: "POST",
          body: {
            workspaceName: "Memory Truth Verification Workspace",
            sessionTitle: "Memory Truth Verification Session",
            sessionCount: 2,
            longThreadTurns: 6,
          },
        });
        assertOk(seeded, "seed memory-truth workspace");

        const memoryTitle = `Memory truth item ${randomUUID().slice(0, 8)}`;
        const created = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/memory-item-seed", {
          method: "POST",
          body: {
            namespace: "memory-truth",
            title: memoryTitle,
            content: "This item should expire without being silently deleted.",
            metadata: {
              lane: "memory-truth",
              sessionId: seeded.body?.sessionId,
              workspaceId: seeded.body?.workspaceId,
            },
          },
        });
        assertOk(created, "seed memory-truth item");

        const listedAll = await requestJson(stack.gatewayUrl, "/api/v1/memory/items?status=all&limit=200");
        assertOk(listedAll, "list memory items before ttl patch");
        const item = listedAll.body?.items?.find((entry) => entry.itemId === created.body?.itemId);
        if (!item?.itemId) {
          throw new Error(`memory-truth could not find seeded memory item ${memoryTitle}`);
        }

        const patched = await requestJson(stack.gatewayUrl, `/api/v1/memory/items/${encodeURIComponent(item.itemId)}`, {
          method: "PATCH",
          body: {
            ttlOverrideSeconds: 1,
          },
        });
        assertOk(patched, "patch memory item ttl");
        await delay(1500);

        const activeItems = await requestJson(stack.gatewayUrl, "/api/v1/memory/items?status=active&limit=200");
        assertOk(activeItems, "list active memory items after expiry");
        const allItems = await requestJson(stack.gatewayUrl, "/api/v1/memory/items?status=all&limit=200");
        assertOk(allItems, "list all memory items after expiry");
        const history = await requestJson(
          stack.gatewayUrl,
          `/api/v1/memory/items/${encodeURIComponent(item.itemId)}/history?limit=50`,
        );
        assertOk(history, "read memory item history after expiry");

        const expiredItem = allItems.body?.items?.find((entry) => entry.itemId === item.itemId);
        if (activeItems.body?.items?.some((entry) => entry.itemId === item.itemId)) {
          throw new Error(`memory-truth expected ${item.itemId} to disappear from active reads after expiry`);
        }
        if (!expiredItem || expiredItem.lifecycleState !== "expired") {
          throw new Error(`memory-truth expected ${item.itemId} to remain visible as expired in status=all`);
        }

        const browser = await chromium.launch({ headless: true });
        try {
          const browserContext = await browser.newContext({
            viewport: { width: 1440, height: 1024 },
            colorScheme: "dark",
          });
          await installMissionControlNextBrowserState(browserContext, seeded.body.workspaceId);
          const page = await browserContext.newPage();
          const browserLog = attachBrowserLogging(page);
          const browserLogCursor = browserLog.mark();
          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/library/memory"), {
            waitUntil: "domcontentloaded",
          });
          await waitForVerificationRouteReady(
            page,
            {
              expectedArea: "library",
              expectedSection: "memory",
              readyText: "Memory items",
            },
            NEXT_UI_PACKAGE,
          );
          await setBrowserCorrelation(page, correlationId, seeded.body.sessionId);
          await page.getByRole("heading", { name: memoryTitle, exact: false }).first().waitFor({ timeout: 15000 });
          await page
            .getByText(/Lifecycle expired/i, { exact: false })
            .first()
            .waitFor({ timeout: 15000 });
          const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, NEXT_UI_PACKAGE);
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "memory-truth-ttl-lifecycle-visibility",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
            logCursor: browserLogCursor,
          });
          const outPath = path.join(context.artifactRoot, "diagnostics", "memory-truth-ttl-lifecycle-visibility.json");
          await writeJson(outPath, {
            seeded: seeded.body,
            created: created.body,
            patched: patched.body,
            activeItems: activeItems.body,
            allItems: allItems.body,
            history: history.body,
          });
          return {
            status: "passed",
            metrics: {
              historyEntries: Array.isArray(history.body?.items) ? history.body.items.length : 0,
              consoleErrors: browserSanity.consoleErrors.length,
              pageErrors: browserSanity.pageErrors.length,
            },
            artifacts: {
              ...artifacts,
              diagnostics: [...artifacts.diagnostics, relativeToRun(context, outPath)],
            },
          };
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    if (stack) {
      await stopVerificationStack(stack);
    }
    restoreUiPackage();
  }
}

export async function runRealtimeTruthLane(context, options = {}) {
  let stack;
  const restoreUiPackage = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  try {
    stack = await startVerificationStack(context, {
      includeUi: true,
    });
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-realtime-truth");
    const fixture = await seedMissionControlNextFixture(stack.gatewayUrl);
    await runScenario(
      context,
      {
        id: "realtime-truth.explicit-compatibility-replay-gap",
        lane: "realtime-truth",
        title:
          "Realtime explicit metadata, compatibility fallback, and replay-gap paths stay legible in Mission Control Next",
        subsystem: "mission-control",
      },
      async ({ correlationId }) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const browserContext = await browser.newContext({
            viewport: { width: 1440, height: 1024 },
            colorScheme: "dark",
          });
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId);
          const page = await browserContext.newPage();
          const browserLog = attachBrowserLogging(page);
          const browserLogCursor = browserLog.mark();

          await page.goto(buildVerificationUiUrl(stack.uiUrl, "/ops/activity"), {
            waitUntil: "domcontentloaded",
          });
          await waitForVerificationRouteReady(
            page,
            {
              expectedArea: "ops",
              expectedSection: "activity",
              readyText: "Activity feed",
            },
            NEXT_UI_PACKAGE,
          );
          await setBrowserCorrelation(page, correlationId, fixture.sessionId);

          const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/realtime-truth-seed", {
            method: "POST",
            body: {},
          });
          assertOk(seeded, "seed realtime-truth events");

          const explicitEvents = await requestJson(stack.gatewayUrl, "/api/v1/events?limit=20");
          assertOk(explicitEvents, "list realtime events after explicit seed");
          const explicitEvent = explicitEvents.body?.items?.find(
            (item) => item.eventId === seeded.body?.explicitEvent?.eventId,
          );
          const compatibilityEvent = explicitEvents.body?.items?.find(
            (item) => item.eventId === seeded.body?.compatibilityEvent?.eventId,
          );
          if (!explicitEvent?.eventClass || !explicitEvent?.eventAuthority) {
            throw new Error("realtime-truth expected explicit event metadata to survive the API envelope");
          }
          if (!compatibilityEvent?.eventId) {
            throw new Error(
              "realtime-truth expected compatibility fallback event to remain visible in the retained API list",
            );
          }

          const replayGap = await requestJson(
            stack.gatewayUrl,
            `/api/v1/events?cursor=${encodeURIComponent(seeded.body?.staleCursor ?? "")}&limit=5`,
          );
          if (replayGap.status !== 409 || replayGap.body?.error !== "replay_gap") {
            throw new Error(`realtime-truth expected replay-gap 409, got ${JSON.stringify(replayGap)}`);
          }

          const sseReplayGap = await requestSseProbe(
            `${stack.gatewayUrl}/api/v1/events/stream?afterCursor=${encodeURIComponent(seeded.body?.staleCursor ?? "")}&clientId=realtime-truth`,
          );
          if (!sseReplayGap.ok || !sseReplayGap.preview.includes("event: replay-gap")) {
            throw new Error(`realtime-truth expected replay-gap SSE event, got ${JSON.stringify(sseReplayGap)}`);
          }

          await page.evaluate(() => {
            window.localStorage.removeItem("goatcitadel.events.cursor.v1");
          });
          await page.reload({ waitUntil: "domcontentloaded" });
          await waitForVerificationRouteReady(
            page,
            {
              expectedArea: "ops",
              expectedSection: "activity",
              readyText: "Activity feed",
            },
            NEXT_UI_PACKAGE,
          );

          await page.evaluate(
            (cursor) => {
              window.localStorage.setItem("goatcitadel.events.cursor.v1", cursor);
            },
            String(seeded.body?.staleCursor ?? ""),
          );
          await page.reload({ waitUntil: "domcontentloaded" });
          await waitForVerificationRouteReady(
            page,
            {
              expectedArea: "ops",
              expectedSection: "activity",
              readyText: "Activity feed",
            },
            NEXT_UI_PACKAGE,
          );
          await page
            .getByText(
              "Live event history rotated past this browser cursor. Mission Control is refreshing from the latest retained state.",
              { exact: false },
            )
            .first()
            .waitFor({ timeout: 15000 });
          const realtimeCopy = (await page.locator("body").innerText({ timeout: 15000 })) ?? "";
          if (!/(Live recovery|Polling|Realtime degraded)/.test(realtimeCopy)) {
            throw new Error("realtime-truth expected visible realtime degraded/recovery posture copy");
          }
          if (!/(Streaming via replay recovery|Polling fallback|Streaming \(replay recovery\))/.test(realtimeCopy)) {
            throw new Error("realtime-truth expected visible realtime replay recovery or polling fallback copy");
          }
          const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, NEXT_UI_PACKAGE);
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "realtime-truth-explicit-compatibility-replay-gap",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
            logCursor: browserLogCursor,
          });
          const outPath = path.join(
            context.artifactRoot,
            "diagnostics",
            "realtime-truth-explicit-compatibility-replay-gap.json",
          );
          await writeJson(outPath, {
            fixture,
            seeded: seeded.body,
            explicitEvent,
            compatibilityEvent,
            replayGap,
            sseReplayGap,
          });
          return {
            status: "passed",
            metrics: {
              replayGapStatus: replayGap.status,
              consoleErrors: browserSanity.consoleErrors.length,
              pageErrors: browserSanity.pageErrors.length,
            },
            artifacts: {
              ...artifacts,
              diagnostics: [...artifacts.diagnostics, relativeToRun(context, outPath)],
            },
          };
        } finally {
          await browser.close();
        }
      },
    );
  } finally {
    if (stack) {
      await stopVerificationStack(stack);
    }
    restoreUiPackage();
  }
}

export async function runArchitectureMetricsLane(context) {
  await runScenario(
    context,
    {
      id: "architecture.metrics.snapshot",
      lane: "architecture-metrics",
      title: "Gateway coupling, route-service metrics, and large-service debt snapshot",
      subsystem: "architecture",
    },
    async () => {
      const metrics = await collectArchitectureMetrics();
      const baseline = await readArchitectureMetricsBaseline();
      const comparison = compareArchitectureMetrics(metrics, baseline);
      const outPath = path.join(context.artifactRoot, "diagnostics", "architecture-metrics.json");
      const baselinePath = path.join(context.artifactRoot, "diagnostics", "architecture-metrics-baseline.json");
      const comparePath = path.join(context.artifactRoot, "diagnostics", "architecture-metrics-compare.json");
      await writeJson(outPath, metrics);
      await writeJson(baselinePath, baseline);
      await writeJson(comparePath, comparison);
      return {
        status: comparison.status,
        notes: [...comparison.debtNotes, ...comparison.improvements, ...comparison.regressions],
        error: comparison.regressions.length > 0 ? comparison.regressions.join("; ") : undefined,
        metrics: {
          gatewayLineCount: metrics.gatewayLineCount,
          largeServiceDebt: comparison.largeServiceDebt,
          gatewayPublicMethodCount: metrics.gatewayPublicMethodCount,
          gatewayServiceImportConsumerCount: metrics.gatewayServiceImportConsumerCount,
          fastifyGatewayCallSites: metrics.fastifyGatewayCallSites,
          gatewayInternalPublicCount: metrics.gatewayInternalPublicCount,
          serviceContextConsumerCount: metrics.serviceContextConsumerCount,
          totalHostCallbacks: metrics.totalHostCallbacks,
          routeFacingServiceCount: metrics.routeFacingServiceCount,
          baselineGatewayLineCount: baseline.gatewayLineCount,
          baselineGatewayPublicMethodCount: baseline.gatewayPublicMethodCount,
          baselineGatewayServiceImportConsumerCount: baseline.gatewayServiceImportConsumerCount,
          baselineFastifyGatewayCallSites: baseline.fastifyGatewayCallSites,
          baselineGatewayInternalPublicCount: baseline.gatewayInternalPublicCount,
          baselineServiceContextConsumerCount: baseline.serviceContextConsumerCount,
          baselineTotalHostCallbacks: baseline.totalHostCallbacks,
          baselineRouteFacingServiceCount: baseline.routeFacingServiceCount,
        },
        artifacts: {
          diagnostics: [
            relativeToRun(context, outPath),
            relativeToRun(context, baselinePath),
            relativeToRun(context, comparePath),
          ],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
        },
      };
    },
  );
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

async function waitForMissionControlShell(page, options = {}) {
  const timeoutMs = typeof options === "number" ? options : (options.timeoutMs ?? 30000);
  const packageName = typeof options === "number" ? DEFAULT_UI_PACKAGE : (options.packageName ?? DEFAULT_UI_PACKAGE);
  const shellContract = resolveShellContract(packageName);
  await page.waitForFunction(
    ({ shellSelector, forbiddenSelector }) => {
      const shell = document.querySelector(shellSelector);
      const accessGate = document.querySelector(forbiddenSelector);
      return Boolean(shell) && !accessGate;
    },
    {
      shellSelector: shellContract.shellSelector,
      forbiddenSelector: shellContract.forbiddenSelector,
    },
    { timeout: timeoutMs },
  );
  await page.waitForSelector(shellContract.chromeSelector, { timeout: timeoutMs });
}

async function waitForVerificationRouteReady(page, route, packageName = DEFAULT_UI_PACKAGE, timeoutMs = 30000) {
  await waitForMissionControlShell(page, { packageName, timeoutMs });
  if (packageName === NEXT_UI_PACKAGE) {
    await page.waitForFunction(
      ({ area, section, loadingSelector }) => {
        const shell = document.querySelector(".mc-next-shell");
        if (!(shell instanceof HTMLElement)) {
          return false;
        }
        const fallback = document.querySelector(loadingSelector);
        return !fallback && shell.dataset.area === area && shell.dataset.section === (section ?? "root");
      },
      {
        area: route.expectedArea ?? "chat",
        section: route.expectedSection ?? "root",
        loadingSelector: resolveShellContract(packageName).loadingSelector,
      },
      { timeout: timeoutMs },
    );
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll(".mc-next-blocks-loader-label")).some((label) =>
          label.textContent?.includes("Loading current route data"),
        ),
      undefined,
      { timeout: timeoutMs },
    );
  }
  if (route.readySelector) {
    await page.waitForSelector(route.readySelector, { timeout: timeoutMs });
    if (packageName === NEXT_UI_PACKAGE && route.readySelector.includes("mc-next-threaded-surface")) {
      const threadedEmptyStateVisible = await page
        .locator(".mc-next-threaded-surface .mc-next-threaded-empty")
        .first()
        .isVisible()
        .catch(() => false);
      if (threadedEmptyStateVisible) {
        return;
      }
      await page.waitForFunction(
        () => !document.querySelector(".mc-next-threaded-surface .mc-next-thread-empty"),
        undefined,
        { timeout: timeoutMs },
      );
      if (route.expectedArea === "code") {
        // The threaded-surface shell mounts before the gateway run-context
        // stream delivers the payload that resolves the provider route, policy
        // summary, and model-probe. Visual baselines capture the post-
        // resolution state, so screenshotting earlier produces diffs that
        // straddle the threshold non-deterministically. Wait for every
        // hydration placeholder to clear before letting the snapshot proceed.
        await page.waitForFunction(
          () => {
            const header = document.querySelector(".mc-next-threaded-header");
            if (!header) {
              return false;
            }
            const headerText = header.textContent ?? "";
            if (
              headerText.includes("Provider routing pending") ||
              headerText.includes("Policy loading") ||
              headerText.includes("Route checking")
            ) {
              return false;
            }
            const catalogEntry = Array.from(
              document.querySelectorAll(".chat-model-picker-metadata > div"),
            ).find((entry) => entry.querySelector("dt")?.textContent?.trim() === "Catalog");
            if (catalogEntry?.querySelector("dd")?.textContent?.trim() === "not_checked") {
              return false;
            }
            const routeLoadingBanner = Array.from(
              document.querySelectorAll(".mc-next-composer-banner.info"),
            ).some((banner) =>
              banner.textContent?.includes("Checking the selected provider/model route"),
            );
            if (routeLoadingBanner) {
              return false;
            }
            return true;
          },
          undefined,
          { timeout: timeoutMs },
        );
      }
    }
  }
  if (route.readyText) {
    if (packageName === NEXT_UI_PACKAGE) {
      await page.locator("h1, h2, h3").filter({ hasText: route.readyText }).first().waitFor({ timeout: timeoutMs });
    } else {
      await page.getByText(route.readyText, { exact: false }).first().waitFor({ timeout: timeoutMs });
    }
  }
  if (packageName === NEXT_UI_PACKAGE && route.releaseStatus && route.releaseStatus !== "ship") {
    await page
      .locator(`[data-release-status="${route.releaseStatus}"]:visible`)
      .filter({ hasText: route.releaseStatus === "experimental" ? "Experimental" : "Needs release polish" })
      .first()
      .waitFor({ timeout: timeoutMs });
  }
}

async function performVerificationInteraction(page, interaction, packageName = DEFAULT_UI_PACKAGE) {
  if (!interaction) {
    return;
  }
  if (interaction === "open-inspector" && packageName === NEXT_UI_PACKAGE) {
    const contextButton = page
      .locator(".mc-next-topbar-right .mc-next-wa-button")
      .filter({ hasText: /Open Context|Hide Context/i })
      .first();
    await contextButton.waitFor({ timeout: 15000 });
    const inspector = page.locator(".mc-next-shell-inspector");
    const deadline = Date.now() + 15000;
    let attemptedClick = false;

    while (Date.now() < deadline) {
      if (await inspector.isVisible().catch(() => false)) {
        return;
      }

      const label = (await contextButton.textContent())?.trim() ?? "";
      if (!/hide context/i.test(label) || !attemptedClick) {
        try {
          await contextButton.click({ timeout: 5000 });
        } catch {
          await contextButton.evaluate((element) => {
            element.click();
          });
        }
        attemptedClick = true;
      }

      if (await inspector.isVisible().catch(() => false)) {
        return;
      }
      await page.waitForTimeout(250);
    }

    await page.waitForSelector(".mc-next-shell-inspector", { state: "visible", timeout: 1500 });
  }
}

async function assertLegacyRedirectResolution(page, expectedPath, timeoutMs = 30000) {
  await page.waitForFunction((pathName) => window.location.pathname === pathName, expectedPath, {
    timeout: timeoutMs,
  });
  const leakedParams = await page.evaluate(() => {
    const params = new URLSearchParams(window.location.search);
    return ["tab", "space", "page", "surface"].filter((key) => params.has(key));
  });
  if (leakedParams.length > 0) {
    throw new Error(`legacy redirect left old search params in place: ${leakedParams.join(", ")}`);
  }
}

function assertBrowserConsoleHealthy(browserLog, cursor, packageName = DEFAULT_UI_PACKAGE) {
  const snapshot = browserLog.getSnapshot(cursor);
  const consoleErrors = snapshot.consoleMessages.filter(
    (message) => message.type === "error" && !isAllowedBrowserConsoleMessage(message.text),
  );
  const pageErrors = snapshot.pageErrors.filter((message) => !isAllowedBrowserPageError(message.message));
  if (packageName === NEXT_UI_PACKAGE && (consoleErrors.length > 0 || pageErrors.length > 0)) {
    throw new Error(
      [
        consoleErrors.length > 0 ? `console errors: ${consoleErrors.map((item) => item.text).join(" | ")}` : null,
        pageErrors.length > 0 ? `page errors: ${pageErrors.map((item) => item.message).join(" | ")}` : null,
      ]
        .filter(Boolean)
        .join(" ; "),
    );
  }
  return {
    consoleErrors,
    pageErrors,
  };
}

function isAllowedBrowserConsoleMessage(text) {
  return /favicon\.ico|Download the React DevTools|React Router Future Flag/i.test(text ?? "");
}

function isAllowedBrowserPageError(_message) {
  return false;
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

function getVerificationRoute(verificationTarget, slug) {
  const route = verificationTarget.surfaceRoutes.find((item) => item.slug === slug);
  if (!route) {
    throw new Error(`Verification route ${slug} is not available for ${verificationTarget.packageName}.`);
  }
  return route;
}

function getNextCoreNavigationRoutes(verificationTarget) {
  return [
    "chat",
    "cowork",
    "code",
    "library-memory",
    "library-prompt-packs",
    "ops-activity",
    "ops-approvals",
    "settings-providers",
  ].map((slug) => getVerificationRoute(verificationTarget, slug));
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

async function ensureOnboardingComplete(gatewayUrl, completedBy, headers = {}) {
  let onboardingStateResponse = await requestJson(gatewayUrl, "/api/v1/onboarding/state", {
    headers,
  });
  assertOk(onboardingStateResponse, "read onboarding state");
  if (onboardingStateResponse.body?.completed) {
    return onboardingStateResponse.body;
  }
  const completeResponse = await requestJson(gatewayUrl, "/api/v1/onboarding/complete", {
    method: "POST",
    headers,
    body: {
      completedBy,
    },
  });
  assertOk(completeResponse, "complete onboarding");
  onboardingStateResponse = await requestJson(gatewayUrl, "/api/v1/onboarding/state", {
    headers,
  });
  assertOk(onboardingStateResponse, "re-read onboarding state");
  if (!onboardingStateResponse.body?.completed) {
    throw new Error(
      `verification onboarding completion did not persist: ${JSON.stringify(onboardingStateResponse.body)}`,
    );
  }
  return onboardingStateResponse.body;
}

function buildCompanionSignedHeaders({ token, privateKey, path, nonce, body, timestamp = new Date().toISOString() }) {
  const payload = buildCompanionVerificationPayload({
    method: "POST",
    path,
    timestamp,
    nonce,
    body,
  });
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url");
  return {
    Authorization: `Bearer ${token}`,
    "x-goatcitadel-companion-timestamp": timestamp,
    "x-goatcitadel-companion-nonce": nonce,
    "x-goatcitadel-companion-signature": signature,
  };
}

function buildCompanionVerificationPayload({ method, path, timestamp, nonce, body }) {
  const canonicalBody = canonicalizeCompanionVerificationBody(body);
  const bodyHash = createHash("sha256").update(canonicalBody, "utf8").digest("hex");
  return `${method.trim().toUpperCase()}\n${path}\n${timestamp.trim()}\n${nonce}\n${bodyHash}`;
}

function canonicalizeCompanionVerificationBody(value) {
  if (value === undefined) {
    return "";
  }
  return JSON.stringify(sortCompanionVerificationValue(value));
}

function sortCompanionVerificationValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortCompanionVerificationValue(item));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .reduce((acc, key) => {
        acc[key] = sortCompanionVerificationValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

async function waitForApprovedDeviceAccessRequest(gatewayUrl, requestId, requestSecret, attempts = 20) {
  let latest = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await requestJson(gatewayUrl, `/api/v1/auth/device-requests/${encodeURIComponent(requestId)}/status`, {
      headers: {
        "x-goatcitadel-device-request-secret": requestSecret,
      },
    });
    assertOk(latest, "read device access request status");
    if (latest.body?.status === "approved" && typeof latest.body?.deviceToken === "string") {
      return latest;
    }
    if (latest.body?.status === "rejected" || latest.body?.status === "expired") {
      throw new Error(`device access request ${requestId} resolved as ${latest.body?.status}`);
    }
    await delay(500);
  }
  throw new Error(
    `device access request ${requestId} did not reach approved status in time: ${JSON.stringify(latest?.body)}`,
  );
}

async function pinVisualRegressionProvider(gatewayUrl) {
  const response = await requestJson(gatewayUrl, "/api/v1/onboarding/bootstrap", {
    method: "POST",
    body: {
      llm: {
        activeProviderId: "openai",
      },
      completedBy: "verification-visual-regression",
      markComplete: true,
    },
  });
  assertOk(response, "pin visual regression provider");
  return response.body;
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

async function waitForCodeModeRunCompletion(gatewayUrl, runId, options = {}) {
  const attempts = typeof options === "number" ? options : options.attempts ?? 40;
  const query = new URLSearchParams();
  if (typeof options !== "number") {
    if (typeof options.workspaceId === "string" && options.workspaceId.length > 0) {
      query.set("workspaceId", options.workspaceId);
    }
    if (typeof options.sessionId === "string" && options.sessionId.length > 0) {
      query.set("sessionId", options.sessionId);
    }
    if (typeof options.turnId === "string" && options.turnId.length > 0) {
      query.set("turnId", options.turnId);
    }
  }
  const queryString = query.toString();
  const pathSuffix = queryString ? `?${queryString}` : "";
  let latest = null;
  for (let index = 0; index < attempts; index += 1) {
    latest = await requestJson(gatewayUrl, `/api/v1/code-mode/runs/${encodeURIComponent(runId)}${pathSuffix}`);
    if (latest.status === 404) {
      await delay(250);
      continue;
    }
    assertOk(latest, "read code mode run");
    if (latest.body?.status === "completed" || latest.body?.status === "failed") {
      return latest;
    }
    await delay(250);
  }
  throw new Error(
    `code mode run ${runId} did not reach a terminal state in time; last status=${latest?.status ?? "unknown"} body=${JSON.stringify(latest?.body ?? null)}`,
  );
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
    mark: () => ({
      consoleMessages: consoleMessages.length,
      pageErrors: pageErrors.length,
    }),
    getSnapshot: (cursor = null) => ({
      consoleMessages: [...consoleMessages.slice(cursor?.consoleMessages ?? 0)],
      pageErrors: [...pageErrors.slice(cursor?.pageErrors ?? 0)],
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

async function stabilizeVisualRegressionSnapshot(page) {
  await page.evaluate(() => {
    const replacements = [
      {
        pattern: /\b\d{1,2}\/\d{1,2}\/\d{4},\s*\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M\b/g,
        value: "1/1/2026, 12:00:00 AM",
      },
      {
        pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/g,
        value: "2026-01-01T00:00:00.000Z",
      },
      {
        pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        value: "00000000-0000-0000-0000-000000000000",
      },
      {
        pattern: /\b[0-9a-f]{24,}\b/gi,
        value: "000000000000000000000000",
      },
    ];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
      let next = node.textContent ?? "";
      for (const replacement of replacements) {
        next = next.replace(replacement.pattern, replacement.value);
      }
      node.textContent = next;
    }
  });
}

function appendQuery(href, query) {
  if (!query) {
    return href;
  }
  return `${href}${href.includes("?") ? "&" : "?"}${query}`;
}

function resolveVisualRouteHref(route, variant, fixture) {
  let href = appendQuery(route.href, variant.themeQuery);
  if (route?.fixtureSessionKey && fixture?.sessions) {
    const sessionId = fixture.sessions[route.fixtureSessionKey];
    if (sessionId) {
      href = appendQuery(href, `sessionId=${encodeURIComponent(sessionId)}`);
    }
  }
  return href;
}

async function captureRouteReadyFailure(context, input) {
  const { page, browserLog, browserLogCursor, route, variant, scenarioLane, timeoutMs, readyError } = input;
  const baseSlug = `${scenarioLane}-${route.slug}-${variant.slug}-route-ready-failure`;
  const diagnosticPath = path.join(context.artifactRoot, "diagnostics", `${baseSlug}.json`);
  const screenshotPath = path.join(context.artifactRoot, "screenshots", `${baseSlug}.png`);
  const consoleLogPath = path.join(context.artifactRoot, "playwright", `${baseSlug}-console.json`);

  // Pull the gateway-side state for the seeded session and the client-derived
  // pendingApproval/thread shape at the moment of the timeout. This is the
  // evidence needed to tell whether the prompt never rendered, rendered then
  // got clobbered, or the gateway never returned the approval.
  const evidence = await page
    .evaluate(async () => {
      try {
        const params = new URLSearchParams(globalThis.location?.search ?? "");
        const sessionId = params.get("sessionId");
        if (!sessionId) {
          return { error: "sessionId query param missing" };
        }
        const [threadRes, queueRes] = await Promise.all([
          fetch(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`),
          fetch(`/api/v1/chat/tools/approvals?sessionId=${encodeURIComponent(sessionId)}`),
        ]);
        const thread = await threadRes.json();
        const queue = await queueRes.json();
        const selectedTurn =
          thread?.turns?.find?.(
            (turn) => turn.turnId === (thread.selectedTurnId ?? thread.activeLeafTurnId),
          ) ?? thread?.turns?.at?.(-1);
        return {
          sessionId,
          thread: {
            selectedTurnId: thread?.selectedTurnId ?? null,
            activeLeafTurnId: thread?.activeLeafTurnId ?? null,
            turnCount: Array.isArray(thread?.turns) ? thread.turns.length : 0,
            selectedTurnStatus: selectedTurn?.trace?.status ?? null,
            selectedTurnToolRunsCount: selectedTurn?.trace?.toolRuns?.length ?? 0,
            selectedTurnToolRuns:
              selectedTurn?.trace?.toolRuns?.map((toolRun) => ({
                toolRunId: toolRun?.toolRunId,
                status: toolRun?.status,
                approvalId: toolRun?.approvalId,
                toolName: toolRun?.toolName,
              })) ?? [],
          },
          queue: {
            activeApprovalId: queue?.activeApprovalId ?? null,
            itemsCount: Array.isArray(queue?.items) ? queue.items.length : 0,
            items:
              queue?.items?.map?.((item) => ({
                approvalId: item?.approvalId,
                stale: item?.stale,
                staleReason: item?.staleReason,
                riskLevel: item?.riskLevel,
              })) ?? [],
          },
          dom: {
            blockingApprovalPromptVisible: Boolean(
              document.querySelector('.mc-next-thread-blocking-prompt[data-blocker-kind="approval"]'),
            ),
            blockingUserInputPromptVisible: Boolean(
              document.querySelector('.mc-next-thread-blocking-prompt[data-blocker-kind="user-input"]'),
            ),
            shellArea: document.querySelector(".mc-next-shell")?.getAttribute("data-area") ?? null,
            shellSection: document.querySelector(".mc-next-shell")?.getAttribute("data-section") ?? null,
            visualRegressionShowBlocked:
              document.documentElement.getAttribute("data-visual-regression-show-blocked") ?? null,
          },
        };
      } catch (evidenceError) {
        return {
          error: evidenceError instanceof Error ? evidenceError.message : String(evidenceError),
        };
      }
    })
    .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));

  await writeJson(diagnosticPath, {
    capturedAt: new Date().toISOString(),
    routeSlug: route.slug,
    variantSlug: variant.slug,
    timeoutMs,
    readyError: readyError instanceof Error ? readyError.message : String(readyError),
    evidence,
  });
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
  await writeJson(consoleLogPath, browserLog.getSnapshot(browserLogCursor));
  return {
    status: "failed",
    error: `route ready wait timed out after ${timeoutMs}ms: ${
      readyError instanceof Error ? readyError.message : String(readyError)
    }`,
    metrics: {
      route: route.href,
      variant: variant.slug,
      timeoutMs,
    },
    artifacts: emptyArtifacts({
      diagnostics: [relativeToRun(context, diagnosticPath)],
      screenshots: [relativeToRun(context, screenshotPath)],
      logs: [relativeToRun(context, consoleLogPath)],
      playwright: [relativeToRun(context, consoleLogPath)],
    }),
  };
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
  await writeJson(consoleLogPath, input.browserLog.getSnapshot(input.logCursor));
  return {
    diagnostics: [relativeToRun(context, browserDiagnosticsPath), relativeToRun(context, gatewayDiagnosticsPath)],
    screenshots: [relativeToRun(context, screenshotPath)],
    traces: [],
    logs: [relativeToRun(context, consoleLogPath)],
    perf: (input.extraPerfArtifacts ?? []).map((item) => relativeToRun(context, item)),
    playwright: [relativeToRun(context, consoleLogPath)],
  };
}

async function seedMissionControlNextFixture(gatewayUrl, options = {}) {
  const seedResponse = await requestJson(gatewayUrl, "/api/v1/dev/verification/seed", {
    method: "POST",
    body: {
      workspaceName: "Mission Control Next Verification Workspace",
      sessionTitle: "Mission Control Next Verification Session",
      sessionCount: 8,
      longThreadTurns: 20,
    },
  });
  assertOk(seedResponse, "seed mission-control-next verification data");

  const workspaceId = seedResponse.body?.workspaceId;
  const sessionId = seedResponse.body?.sessionId;
  if (!workspaceId || !sessionId) {
    throw new Error("mission-control-next verification seed did not return workspaceId/sessionId");
  }

  const threadResponse = await requestJson(gatewayUrl, `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`);
  assertOk(threadResponse, "read mission-control-next verification thread");
  const artifactTurnId =
    threadResponse.body?.selectedTurnId ??
    threadResponse.body?.activeLeafTurnId ??
    threadResponse.body?.turns?.at?.(-1)?.turnId;

  if (artifactTurnId) {
    const artifactResponse = await requestJson(
      gatewayUrl,
      `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(artifactTurnId)}/generated-artifact`,
      {
        method: "POST",
        body: {
          supersedeLatest: true,
        },
      },
    );
    assertOk(artifactResponse, "create mission-control-next generated artifact");
  }

  // Seed a pending-user-input prompt on a SEPARATE session BEFORE the approval
  // scenario, so the chat-approval session remains the most-recently-active
  // session and existing "/chat" baselines that auto-pick the freshest session
  // still resolve to the approval state. The chat-pending-user-input baseline
  // targets the user-input session explicitly via fixtureSessionKey.
  const seededSessionIds = Array.isArray(seedResponse.body?.sessionIds) ? seedResponse.body.sessionIds : [];
  const userInputSessionId = seededSessionIds.find((candidate) => candidate && candidate !== sessionId);
  if (userInputSessionId) {
    const userInputResponse = await requestJson(gatewayUrl, "/api/v1/dev/verification/chat-user-input-scenario", {
      method: "POST",
      body: {
        sessionId: userInputSessionId,
        workspaceId,
      },
    });
    assertOk(userInputResponse, "create mission-control-next chat user-input prompt");
  }

  const approvalResponse = await requestJson(gatewayUrl, "/api/v1/dev/verification/chat-approval-scenario", {
    method: "POST",
    body: {
      sessionId,
      workspaceId,
    },
  });
  assertOk(approvalResponse, "create mission-control-next chat approval");

  const agentSpecs = [
    {
      roleId: `mc-next-operator-${randomUUID().slice(0, 8)}`,
      name: "Operator Scout",
      title: "Evidence Scout",
      summary: "Keeps route proof legible and traces noteworthy activity.",
      specialties: ["verification", "summaries"],
      defaultTools: ["fs.read", "fs.list"],
      aliases: ["scout"],
    },
    {
      roleId: `mc-next-builder-${randomUUID().slice(0, 8)}`,
      name: "Builder Pair",
      title: "Workbench Pair",
      summary: "Owns code posture and implementation reviews in shared workspaces.",
      specialties: ["code", "review"],
      defaultTools: ["fs.read", "fs.write", "git.status"],
      aliases: ["pair"],
    },
  ];

  const createdAgents = [];
  for (const agentSpec of agentSpecs) {
    const response = await requestJson(gatewayUrl, "/api/v1/agents", {
      method: "POST",
      body: agentSpec,
    });
    assertOk(response, `create mission-control-next agent ${agentSpec.name}`);
    createdAgents.push(response.body);
  }

  const tasks = [];
  const taskSpecs = [
    {
      title: "Validate the new Chat/Cowork/Code shell",
      description: "Check the default operator path, context panel, and visual hierarchy.",
      status: "planning",
      priority: "high",
      assignedAgentId: createdAgents[0]?.agentId,
    },
    {
      title: "Review task board and agent board cohesion",
      description: "Make sure orchestration state stays visible without clutter.",
      status: "in_progress",
      priority: "urgent",
      assignedAgentId: createdAgents[1]?.agentId,
    },
    {
      title: "Capture prompt-pack quality posture",
      description: "Benchmark the quality route without leaving the new shell.",
      status: "review",
      priority: "normal",
      assignedAgentId: createdAgents[0]?.agentId,
    },
    {
      title: "Watch runtime approvals and costs",
      description: "Keep Ops readable while approvals and spend update.",
      status: "blocked",
      priority: "normal",
      assignedAgentId: createdAgents[1]?.agentId,
    },
  ];

  for (const taskSpec of taskSpecs) {
    const response = await requestJson(gatewayUrl, "/api/v1/tasks", {
      method: "POST",
      body: {
        workspaceId,
        ...taskSpec,
      },
    });
    assertOk(response, `create mission-control-next task ${taskSpec.title}`);
    tasks.push(response.body);
  }

  if (tasks[0]?.taskId) {
    const taskId = tasks[0].taskId;
    assertOk(
      await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/activities`, {
        method: "POST",
        body: {
          workspaceId,
          activityType: "comment",
          message: "Surface proof fixture loaded with deterministic activity.",
          agentId: createdAgents[0]?.agentId ?? "operator",
        },
      }),
      "append mission-control-next task activity",
    );
    assertOk(
      await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`, {
        method: "POST",
        body: {
          workspaceId,
          deliverableType: "artifact",
          title: "Mission Control Next proof artifact",
          path: "workspace/verification/mission-control-next-proof.md",
          description: "Seeded deliverable for task detail proof.",
        },
      }),
      "append mission-control-next task deliverable",
    );
    assertOk(
      await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/subagents`, {
        method: "POST",
        body: {
          workspaceId,
          agentSessionId: `agent-session-${randomUUID().slice(0, 8)}`,
          agentName: createdAgents[1]?.name ?? "Builder Pair",
        },
      }),
      "append mission-control-next task subagent",
    );
  }

  assertOk(
    await requestJson(gatewayUrl, "/api/v1/dev/verification/memory-item-seed", {
      method: "POST",
      body: {
        namespace: "mission-control-next",
        title: "Mission Control Next shell posture",
        content: "Chat is the default lane, Cowork owns structured work, and Code stays workbench-first.",
        metadata: {
          tags: ["verification", "ui"],
          source: "verification",
          sessionId,
        },
      },
    }),
    "seed mission-control-next memory item",
  );

  const uploadResponse = await requestJson(gatewayUrl, "/api/v1/files/upload", {
    method: "POST",
    body: {
      relativePath: "workspace/verification/mission-control-next-proof.md",
      content: "# Mission Control Next\n\n- Seeded for visual proof.\n- Safe to overwrite.\n",
    },
  });
  assertOk(uploadResponse, "upload mission-control-next file fixture");
  await stabilizeMissionControlNextFileFixtureMtime(options.runtimeRoot, uploadResponse.body?.fullPath);

  assertOk(
    await requestJson(gatewayUrl, "/api/v1/prompt-packs/import", {
      method: "POST",
      body: {
        name: "Mission Control Next Verification Pack",
        sourceLabel: "verification",
        content: [
          "[TEST-01] Mission Control Next shell posture",
          "Confirm the new shell is calmer than the legacy frame.",
          "",
          "[TEST-02] Context panel posture",
          "Explain what the context panel should reveal without overwhelming the operator.",
        ].join("\n"),
      },
    }),
    "import mission-control-next prompt pack",
  );

  return {
    workspaceId,
    sessionId,
    sessionIds: seededSessionIds,
    sessions: {
      approval: sessionId,
      ...(userInputSessionId ? { userInput: userInputSessionId } : {}),
    },
    agentIds: createdAgents.map((agent) => agent?.agentId).filter(Boolean),
    taskIds: tasks.map((task) => task?.taskId).filter(Boolean),
  };
}

async function stabilizeMissionControlNextFileFixtureMtime(runtimeRoot, serializedPath) {
  if (!runtimeRoot || typeof serializedPath !== "string" || !serializedPath.startsWith("./")) {
    return;
  }
  const relativePath = serializedPath.slice(2);
  const fullPath = path.resolve(runtimeRoot, relativePath);
  const relativeToRuntime = path.relative(runtimeRoot, fullPath);
  if (relativeToRuntime.startsWith("..") || path.isAbsolute(relativeToRuntime)) {
    return;
  }
  await fs.utimes(fullPath, MISSION_CONTROL_NEXT_FILE_FIXTURE_MTIME, MISSION_CONTROL_NEXT_FILE_FIXTURE_MTIME);
}

async function installMissionControlNextBrowserState(browserContext, workspaceId) {
  await browserContext.addInitScript(
    ({ activeWorkspaceId }) => {
      window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", activeWorkspaceId);
      window.localStorage.setItem("goatcitadel.ui.mode.v1", "simple");
      window.localStorage.setItem("goatcitadel.ui.technical_details.v1", "false");
    },
    { activeWorkspaceId: workspaceId },
  );
}

async function installLegacyMissionControlBrowserState(browserContext, workspaceId) {
  await browserContext.addInitScript(
    ({ activeWorkspaceId }) => {
      window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", activeWorkspaceId);
      window.localStorage.setItem("goatcitadel.ui.mode.v1", "advanced");
      window.localStorage.setItem("goatcitadel.ui.technical_details.v1", "false");
    },
    { activeWorkspaceId: workspaceId },
  );
}

function forceVerificationUiPackage(packageName) {
  const previous = process.env.GOATCITADEL_UI_PACKAGE;
  process.env.GOATCITADEL_UI_PACKAGE = packageName;
  return () => {
    if (previous) {
      process.env.GOATCITADEL_UI_PACKAGE = previous;
      return;
    }
    delete process.env.GOATCITADEL_UI_PACKAGE;
  };
}

async function restartGatewayProcess(context, stack, gatewayEnv = {}) {
  const gatewayPort = Number.parseInt(new URL(stack.gatewayUrl).port, 10);
  await stopProcess(stack.gateway);
  const gateway = await startProcess(context, "gateway", [pnpmCommand(), "--dir", repoRoot, "dev:gateway"], {
    GOATCITADEL_ROOT_DIR: stack.runtimeRoot,
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(gatewayPort),
    GOATCITADEL_AUTH_MODE: "none",
    GOATCITADEL_DATABASE_DRIVER: "sqlite",
    GOATCITADEL_DISABLE_SECRET_STORE: "true",
    GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true",
    GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "false",
    ...gatewayEnv,
  });
  await waitForHttp(`${stack.gatewayUrl}/health`, "Gateway health", 180000, gateway);
  return gateway;
}

async function startVerificationUiProcess(context, gatewayUrl, packageName, name) {
  const uiPort = await resolveAvailablePort(0);
  const uiUrl = `http://127.0.0.1:${uiPort}`;
  const handle = await startProcess(
    context,
    name,
    [
      pnpmCommand(),
      "--dir",
      repoRoot,
      "--filter",
      packageName,
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(uiPort),
    ],
    {
      VITE_GATEWAY_URL: gatewayUrl,
      VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true",
      VITE_GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "false",
    },
  );
  await waitForHttp(uiUrl, `${packageName} UI`, 180000, handle);
  return {
    handle,
    uiPort,
    uiUrl,
    packageName,
  };
}

async function requestSseProbe(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: options.headers ?? {},
      signal: controller.signal,
    });

    if (!response.body) {
      return {
        ok: response.ok,
        status: response.status,
        preview: await response.text(),
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let preview = "";
    const deadline = Date.now() + timeoutMs;

    try {
      while (Date.now() < deadline && preview.length < 4096) {
        const remaining = Math.max(50, deadline - Date.now());
        const next = await Promise.race([
          reader.read(),
          delay(Math.min(remaining, 250)).then(() => ({ timeout: true })),
        ]);
        if (next?.timeout) {
          continue;
        }
        if (next.done) {
          break;
        }
        preview += decoder.decode(next.value, { stream: true });
        if (preview.includes("event:") || preview.includes("data:") || preview.includes(": connected")) {
          if (preview.includes("event: replay-gap") || preview.includes("stream-ready") || response.status >= 400) {
            break;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    return {
      ok: response.ok,
      status: response.status,
      preview,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        status: 0,
        preview: "aborted",
      };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function createAuthMatrixCredentials(gatewayUrl, operatorHeaders) {
  const issueApprovedDeviceToken = async (deviceLabel) => {
    const deviceRequest = await requestJson(gatewayUrl, "/api/v1/auth/device-requests", {
      method: "POST",
      body: {
        deviceLabel,
        deviceType: "desktop",
        platform: "verification",
      },
    });
    assertOk(deviceRequest, `create ${deviceLabel} device request`);
    const requestId = deviceRequest.body?.requestId;
    const requestSecret = deviceRequest.body?.requestSecret;
    const approvalId = deviceRequest.body?.approvalId;
    if (!requestId || !requestSecret || !approvalId) {
      throw new Error(`auth-matrix device request missing identifiers: ${JSON.stringify(deviceRequest.body)}`);
    }

    const resolved = await requestJson(gatewayUrl, `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: "POST",
      headers: operatorHeaders,
      body: {
        decision: "approve",
        resolvedBy: "verification-auth-matrix",
        resolutionNote: "Approved for auth-matrix verification.",
      },
    });
    assertOk(resolved, `approve ${deviceLabel} device request`);

    const approvedStatus = await waitForApprovedDeviceAccessRequest(gatewayUrl, requestId, requestSecret);
    const deviceToken = approvedStatus.body?.deviceToken;
    if (!deviceToken) {
      throw new Error(
        `auth-matrix device request did not return a device token: ${JSON.stringify(approvedStatus.body)}`,
      );
    }
    return deviceToken;
  };

  const deviceToken = await issueApprovedDeviceToken("Auth Matrix Device");
  const companionSourceDeviceToken = await issueApprovedDeviceToken("Auth Matrix Companion Source");

  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const exchange = await requestJson(gatewayUrl, "/api/v1/auth/companion/session/exchange", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${companionSourceDeviceToken}`,
    },
    body: {
      signingPublicKeyPem: publicKeyPem,
      clientName: "Auth Matrix Companion",
      appVersion: "1.0.0",
    },
  });
  assertOk(exchange, "exchange auth-matrix companion session");
  const companionToken = exchange.body?.accessToken;
  if (!companionToken) {
    throw new Error(`auth-matrix companion session missing access token: ${JSON.stringify(exchange.body)}`);
  }

  return {
    deviceToken,
    companionSourceDeviceToken,
    companionToken,
    companionPrivateKey: privateKeyPem,
    companionPublicKey: publicKeyPem,
    companionSessionId: exchange.body?.sessionId,
  };
}

async function issueOperatorSseToken(gatewayUrl, operatorHeaders) {
  const response = await requestJson(gatewayUrl, "/api/v1/auth/sse-token", {
    method: "POST",
    headers: operatorHeaders,
    body: {
      scope: "events:stream",
    },
  });
  assertOk(response, "issue auth-matrix operator sse token");
  if (!response.body?.token) {
    throw new Error(`auth-matrix sse token response was incomplete: ${JSON.stringify(response.body)}`);
  }
  return response.body.token;
}

function selectRepresentativeManifestRoute(manifestItems, accessClass) {
  if (accessClass === "webhook") {
    return null;
  }
  const preferredRoutes = {
    public: [{ method: "POST", url: "/api/v1/auth/device-requests" }],
    "authenticated-read": [{ method: "GET", url: "/api/v1/events" }],
    operator: [{ method: "GET", url: "/api/v1/admin/retention" }],
    device: [{ method: "POST", url: "/api/v1/auth/companion/session/exchange" }],
    companion: [{ method: "GET", url: "/api/v1/auth/companion/session" }],
    "sse-read": [{ method: "GET", url: "/api/v1/events/stream" }],
    webhook: [],
    loopback: [],
  };

  const preferred = preferredRoutes[accessClass] ?? [];
  for (const candidate of preferred) {
    const exact = manifestItems.find(
      (item) => item.accessClass === accessClass && item.method === candidate.method && item.url === candidate.url,
    );
    if (exact) {
      return exact;
    }
  }

  return (
    manifestItems.find(
      (item) => item.accessClass === accessClass && !item.url.includes(":") && item.method === "GET",
    ) ??
    manifestItems.find((item) => item.accessClass === accessClass && !item.url.includes(":")) ??
    null
  );
}

function buildAuthMatrixExpectations(accessClass) {
  switch (accessClass) {
    case "public":
      return {
        unauthenticated: true,
        badToken: true,
        operator: true,
        device: true,
        companion: true,
      };
    case "authenticated-read":
      return {
        unauthenticated: false,
        badToken: false,
        operator: true,
        device: true,
        companion: true,
      };
    case "operator":
      return {
        unauthenticated: false,
        badToken: false,
        operator: true,
        device: false,
        companion: false,
      };
    case "device":
      return {
        unauthenticated: false,
        badToken: false,
        operator: false,
        device: true,
        companion: false,
      };
    case "companion":
      return {
        unauthenticated: false,
        badToken: false,
        operator: false,
        device: false,
        companion: true,
      };
    case "sse-read":
      return {
        unauthenticated: false,
        badToken: false,
        operator: true,
        device: false,
        companion: true,
        sse: true,
      };
    case "webhook":
      return {
        unauthenticated: false,
        badToken: false,
        operator: false,
      };
    default:
      return {
        unauthenticated: false,
        badToken: false,
        operator: false,
      };
  }
}

async function probeAuthMatrixRoute(gatewayUrl, representative, credentials) {
  const method = representative.method ?? "GET";
  let headers = {};
  let body;
  let url = representative.url;

  switch (credentials.caller) {
    case "operator":
      headers = { ...credentials.operatorHeaders };
      break;
    case "device":
      headers = {
        Authorization: `Bearer ${credentials.deviceToken}`,
      };
      break;
    case "companion":
      headers = {
        Authorization: `Bearer ${credentials.companionToken}`,
      };
      break;
    case "badToken":
      headers = {
        Authorization: `Bearer auth-matrix-bad-token`,
      };
      break;
    case "sse":
      break;
    case "unauthenticated":
    default:
      break;
  }

  if (representative.url === "/api/v1/auth/companion/session/exchange") {
    body = {
      signingPublicKeyPem: credentials.companionPublicKey,
      clientName: "Auth Matrix Companion",
      appVersion: "1.0.0",
    };
  } else if (representative.url === "/api/v1/auth/device-requests") {
    body = {
      deviceLabel: `Auth Matrix ${credentials.caller}`,
      deviceType: "desktop",
      platform: "verification",
    };
  }

  if (representative.url === "/api/v1/events/stream") {
    const query = new URLSearchParams({
      clientId: `auth-matrix-${credentials.caller}`,
    });
    if (credentials.caller === "sse") {
      query.set("sse_token", credentials.sseToken);
    }
    return await requestSseProbe(`${gatewayUrl}${url}?${query.toString()}`, { headers });
  }

  return await requestJson(gatewayUrl, url, {
    method,
    headers,
    body,
  });
}

function isAllowedStatus(status) {
  return Number.isFinite(status) && status >= 200 && status < 300;
}

async function collectUiParitySurface({ page, baseUrl, href, route, packageName, correlationId, sessionId, needle }) {
  let ready = false;
  let error = null;
  let preview = "";

  await page.goto(buildVerificationUiUrl(baseUrl, href), {
    waitUntil: "domcontentloaded",
  });
  try {
    await waitForVerificationRouteReady(page, route, packageName);
    ready = true;
    await setBrowserCorrelation(page, correlationId, sessionId);
    try {
      await page.waitForFunction(
        (expectedNeedle) => (document.body?.innerText ?? "").includes(expectedNeedle),
        needle,
        { timeout: 8000 },
      );
    } catch {
      await page.waitForTimeout(500);
    }
    preview = await page.evaluate(() => document.body?.innerText ?? "");
  } catch (routeError) {
    error = routeError instanceof Error ? routeError.message : String(routeError);
    preview = await page.evaluate(() => document.body?.innerText ?? "");
  }

  return {
    href,
    ready,
    needle,
    needleVisible: preview.includes(needle),
    preview: clampString(preview.replace(/\s+/g, " ").trim(), 280),
    error,
  };
}

async function runMissionControlNextMobileShellProof(context, input) {
  const browserContext = await input.browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
  });
  await installMissionControlNextBrowserState(browserContext, input.workspaceId);
  const page = await browserContext.newPage();
  const browserLog = attachBrowserLogging(page);
  try {
    await runScenario(
      context,
      {
        id: "surface-regression.mobile.chat-shell",
        lane: "surface-regression",
        title: "Mission Control Next mobile shell drawers stay usable",
        subsystem: "mission-control",
      },
      async ({ correlationId }) => {
        const browserLogCursor = browserLog.mark();
        await page.goto(buildVerificationUiUrl(input.uiUrl, "/chat"), { waitUntil: "domcontentloaded" });
        await waitForVerificationRouteReady(
          page,
          {
            expectedArea: "chat",
            expectedSection: "root",
            readySelector: '.mc-next-threaded-surface[data-mode="chat"]',
          },
          input.packageName,
        );
        await setBrowserCorrelation(page, correlationId, input.sessionId);
        await assertNoHorizontalOverflow(page, "mobile chat shell");
        const menuButton = page.locator(".mc-next-nav-toggle").first();
        await assertLocatorFullyVisible(page, menuButton, "mobile menu toggle");
        await menuButton.click();
        await page.waitForSelector(".mc-next-rail.open", { timeout: 15000 });
        const railCloseButton = page.locator(".mc-next-rail-close").first();
        await assertLocatorFullyVisible(page, railCloseButton, "mobile rail close button");
        await railCloseButton.click();
        await page.waitForFunction(() => !document.querySelector(".mc-next-rail.open"), { timeout: 15000 });
        const contextButton = page
          .locator(".mc-next-topbar-right .mc-next-wa-button")
          .filter({ hasText: /Open Context|Hide Context/i })
          .first();
        await assertLocatorFullyVisible(page, contextButton, "mobile open context button");
        await contextButton.click();
        await page.waitForSelector(".mc-next-shell-inspector", { state: "visible", timeout: 15000 });
        await assertNoHorizontalOverflow(page, "mobile chat shell with inspector");
        const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, input.packageName);
        const artifacts = await captureBrowserArtifacts(context, {
          slug: "surface-regression-mobile-chat-shell",
          page,
          browserLog,
          gatewayUrl: input.gatewayUrl,
          correlationId,
          logCursor: browserLogCursor,
        });
        return {
          status: "passed",
          metrics: {
            consoleErrors: browserSanity.consoleErrors.length,
            pageErrors: browserSanity.pageErrors.length,
          },
          artifacts,
        };
      },
    );

    await runScenario(
      context,
      {
        id: "surface-regression.mobile.cowork-tasks",
        lane: "surface-regression",
        title: "Mission Control Next mobile task board avoids overflow and clipped primary actions",
        subsystem: "mission-control",
      },
      async ({ correlationId }) => {
        const browserLogCursor = browserLog.mark();
        await page.goto(buildVerificationUiUrl(input.uiUrl, "/cowork/tasks"), { waitUntil: "domcontentloaded" });
        await waitForVerificationRouteReady(
          page,
          { expectedArea: "cowork", expectedSection: "tasks", readySelector: ".mc-next-directory-page" },
          input.packageName,
        );
        await setBrowserCorrelation(page, correlationId, input.sessionId);
        await assertNoHorizontalOverflow(page, "mobile cowork tasks");
        const primaryTaskAction = page.locator(".mc-next-directory-page button, .mc-next-directory-action").first();
        await assertLocatorFullyVisible(page, primaryTaskAction, "task board primary action");
        await performVerificationInteraction(page, "open-inspector", input.packageName);
        await assertNoHorizontalOverflow(page, "mobile cowork tasks with inspector");
        const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, input.packageName);
        const artifacts = await captureBrowserArtifacts(context, {
          slug: "surface-regression-mobile-cowork-tasks",
          page,
          browserLog,
          gatewayUrl: input.gatewayUrl,
          correlationId,
          logCursor: browserLogCursor,
        });
        return {
          status: "passed",
          metrics: {
            consoleErrors: browserSanity.consoleErrors.length,
            pageErrors: browserSanity.pageErrors.length,
          },
          artifacts,
        };
      },
    );
  } finally {
    await browserContext.close();
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      doc: doc ? doc.scrollWidth - window.innerWidth : 0,
      body: body ? body.scrollWidth - window.innerWidth : 0,
    };
  });
  if (overflow.doc > 1 || overflow.body > 1) {
    throw new Error(`${label} overflowed horizontally (doc=${overflow.doc}, body=${overflow.body})`);
  }
}

async function assertLocatorFullyVisible(page, locator, label) {
  const viewport = page.viewportSize();
  if (!viewport) {
    return;
  }
  const deadline = Date.now() + 15000;
  let lastBox = null;
  await locator.waitFor({ state: "visible", timeout: 15000 });
  while (Date.now() < deadline) {
    const box = await locator.boundingBox();
    if (box) {
      lastBox = box;
      const horizontallyVisible = box.x >= 0 && box.x + box.width <= viewport.width + 1;
      const verticallyVisible = box.y >= 0 && box.y + box.height <= viewport.height + 1;
      if (horizontallyVisible && verticallyVisible) {
        return;
      }
    }
    await page.waitForTimeout(50);
  }
  if (!lastBox) {
    throw new Error(`${label} did not expose a visible bounding box`);
  }
  throw new Error(
    `${label} was clipped in the viewport (x=${lastBox.x}, y=${lastBox.y}, width=${lastBox.width}, height=${lastBox.height})`,
  );
}

async function writeMissionControlNextManualProofChecklist(context, entries) {
  const checklistPath = path.join(context.artifactRoot, "diagnostics", "mission-control-next-manual-proof.md");
  const normalizedEntries = entries
    .filter((entry) => Array.isArray(entry.screenshots) && entry.screenshots.length > 0)
    .map((entry) => ({
      routeSlug: entry.routeSlug,
      variantSlug: entry.variantSlug,
      screenshots: [...new Set(entry.screenshots)],
    }));
  const lines = [
    "# Mission Control Next manual proof checklist",
    "",
    "Review these generated artifacts before promoting Mission Control Next:",
    "",
    "- Check for horizontal overflow or clipped controls.",
    "- Confirm sticky regions stay stable on desktop and mobile.",
    "- Confirm drawer usability at 390x844.",
    "- Confirm the context inspector opens cleanly on wide and narrow layouts.",
    "- Confirm dark/light contrast remains readable without neon overload.",
    "",
    "## Captured screenshots",
  ];
  for (const entry of normalizedEntries) {
    lines.push(`- ${entry.routeSlug} / ${entry.variantSlug}: ${entry.screenshots.join(", ")}`);
  }
  lines.push("");
  lines.push(`Generated at ${new Date().toISOString()}`);
  await writeText(checklistPath, `${lines.join("\n")}\n`);
  return checklistPath;
}

async function compareVisualBaseline(context, slug, options = {}) {
  const artifactSlug = options.artifactSlug ?? slug;
  const screenshotPath = path.join(context.artifactRoot, "screenshots", `${artifactSlug}.png`);
  const baselinePath = path.join(resolveVisualBaselineDir(options.packageName ?? DEFAULT_UI_PACKAGE), `${slug}.png`);
  const diagnosticsPath = path.join(context.artifactRoot, "diagnostics", `${artifactSlug}-visual-compare.json`);
  const diffPath = path.join(context.artifactRoot, "screenshots", `${artifactSlug}-diff.png`);
  const baselineArtifactPath = path.join(context.artifactRoot, "screenshots", `${artifactSlug}-baseline.png`);
  const updateBaselines = maybeParseBool(options.updateBaselines, false);

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
      artifactSlug,
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

  const current = await loadVisualComparisonImage(screenshotPath);
  const baseline = await loadVisualComparisonImage(baselinePath);

  let changedPixels = 0;
  let diffRatio = 0;
  let dimensionMismatch = false;

  if (current.info.width !== baseline.info.width || current.info.height !== baseline.info.height) {
    dimensionMismatch = true;
    diffRatio = 1;
  } else {
    const pixelCount = current.info.width * current.info.height;
    const channelCount = current.info.channels;
    const diffBuffer = Buffer.alloc(pixelCount * 4);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const sourceOffset = pixelIndex * channelCount;
      const diffOffset = pixelIndex * 4;
      let delta = 0;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        delta = Math.max(
          delta,
          Math.abs(current.data[sourceOffset + channelIndex] - baseline.data[sourceOffset + channelIndex]),
        );
      }
      if (delta > VISUAL_DIFF_PIXEL_DELTA) {
        changedPixels += 1;
        diffBuffer[diffOffset] = 255;
        diffBuffer[diffOffset + 1] = 0;
        diffBuffer[diffOffset + 2] = 0;
        diffBuffer[diffOffset + 3] = 255;
      } else {
        const baselineValue = baseline.data[sourceOffset];
        diffBuffer[diffOffset] = baselineValue;
        diffBuffer[diffOffset + 1] = baselineValue;
        diffBuffer[diffOffset + 2] = baselineValue;
        diffBuffer[diffOffset + 3] = 80;
      }
    }
    diffRatio = pixelCount > 0 ? changedPixels / pixelCount : 0;
    await sharp(diffBuffer, {
      raw: {
        width: current.info.width,
        height: current.info.height,
        channels: 4,
      },
    })
      .png()
      .toFile(diffPath);
  }

  await writeJson(diagnosticsPath, {
    slug,
    artifactSlug,
    screenshotPath,
    baselinePath,
    updateBaselines,
    dimensionMismatch,
    changedPixels,
    diffRatio,
    diffPixelDelta: VISUAL_DIFF_PIXEL_DELTA,
    diffRatioThreshold: VISUAL_DIFF_RATIO_THRESHOLD,
    normalizedBlur: VISUAL_DIFF_NORMALIZE_BLUR,
    normalizedScale: VISUAL_DIFF_NORMALIZE_SCALE,
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

async function loadVisualComparisonImage(filePath) {
  const image = sharp(filePath);
  const metadata = await image.metadata();
  const width = Math.max(1, Math.round((metadata.width ?? 1) * VISUAL_DIFF_NORMALIZE_SCALE));
  const height = Math.max(1, Math.round((metadata.height ?? 1) * VISUAL_DIFF_NORMALIZE_SCALE));
  return image
    .grayscale()
    .blur(VISUAL_DIFF_NORMALIZE_BLUR)
    .resize({ width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function assertVisualBaselineCoverage(context, options = {}) {
  const packageName = options.packageName ?? DEFAULT_UI_PACKAGE;
  const routes = resolveVisualRegressionManifest(packageName);
  const variants = resolveVisualRegressionVariants(packageName);
  const baselineDir = resolveVisualBaselineDir(packageName);
  const expectedFiles = routes.flatMap((route) =>
    variants.map((variant) => buildVisualBaselineFileName(route.slug, variant.slug)),
  );
  const missing = [];
  for (const fileName of expectedFiles) {
    try {
      await fs.access(path.join(baselineDir, fileName));
    } catch {
      missing.push(fileName);
    }
  }
  if (missing.length === 0) {
    return;
  }
  const diagnosticsPath = path.join(context.artifactRoot, "diagnostics", "visual-baseline-coverage.json");
  await writeJson(diagnosticsPath, {
    baselineDirectory: baselineDir,
    expectedFiles,
    missingFiles: missing,
  });
  throw new Error(`visual baseline coverage is incomplete: ${missing.join(", ")}`);
}

function snapshotRestContract(openApiDocument) {
  const paths =
    openApiDocument &&
    typeof openApiDocument === "object" &&
    openApiDocument.paths &&
    typeof openApiDocument.paths === "object"
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
        if (
          !current[routePath][method].responses.includes(responseCode) &&
          !allowlist.removedRestResponses?.includes(allowlistKey)
        ) {
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
      response.end(
        JSON.stringify({
          message: "fixture bridge ok",
          output: {
            catalogId: parsedBody?.catalogId,
            actionId: parsedBody?.actionId,
            input: parsedBody?.input ?? {},
          },
        }),
      );
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
      response.end(
        JSON.stringify({
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
        }),
      );
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
