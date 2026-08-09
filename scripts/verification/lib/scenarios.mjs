import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
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
  resolveDirectCompatibilityManifest,
  resolveLegacyRedirectManifest,
  resolveReleaseSurfaceHref,
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
import {
  appendTraceArtifact,
  attachBrowserLogging,
  captureBrowserArtifacts,
  readBrowserSseDiagnostics,
  setBrowserCorrelation,
  startBrowserTrace,
} from "./scenarios/browser-helpers.mjs";
import { seedMissionControlNextFixture as seedMissionControlNextFixtureImpl } from "./scenarios/fixture-seeding.mjs";
import { collectVisualBaselineCoverage } from "./visual-baseline-coverage.mjs";
import {
  captureConfigJsonSnapshots,
  findBackupConfigSnapshotDrift,
  removeBackupMutationFileWithRetry,
} from "./backup-snapshot-stability.mjs";
import {
  API_COMPAT_ALLOWLIST_PATH,
  API_COMPAT_BASELINE_PATH,
  compareRealtimeContract,
  compareRestContract,
  snapshotApiCompatibilityCurrentShellFacts as snapshotApiCompatibilityCurrentShellFactsImpl,
  snapshotRealtimeContract,
  snapshotRestContract,
} from "./scenarios/api-compatibility-helpers.mjs";
import { runDurableRecoveryLane as runDurableRecoveryLaneImpl } from "./scenarios/durable-recovery-lane.mjs";
import { runSelfConfigurationLane as runSelfConfigurationLaneImpl } from "./scenarios/self-configuration-lane.mjs";
import { runUsageReconciliationLane as runUsageReconciliationLaneImpl } from "./scenarios/usage-reconciliation-lane.mjs";
import { runRoutedContextSnapshotsLane as runRoutedContextSnapshotsLaneImpl } from "./scenarios/routed-context-snapshots-lane.mjs";
import { runModelCouncilLane as runModelCouncilLaneImpl } from "./scenarios/model-council-lane.mjs";
import { runSkillLearningLane as runSkillLearningLaneImpl } from "./scenarios/skill-learning-lane.mjs";
import { runSessionControlLane as runSessionControlLaneImpl } from "./scenarios/session-control-lane.mjs";
import {
  runReasoningProfilesLane as runReasoningProfilesLaneImpl,
  runVertexFireworksProvidersLane as runVertexFireworksProvidersLaneImpl,
} from "./scenarios/provider-reasoning-lanes.mjs";
import { runSurfaceRegressionLane as runSurfaceRegressionLaneImpl } from "./scenarios/surface-regression-lane.mjs";
import {
  runUsabilityCoreLane as runUsabilityCoreLaneImpl,
  runUsabilityLane as runUsabilityLaneImpl,
} from "./scenarios/usability-lane.mjs";
import {
  filterExpectedBrowserConsoleMessages,
  pollSseConnectionRecoveryEvidence,
  runUsabilityBrowserActionLane as runUsabilityBrowserActionLaneImpl,
} from "./scenarios/usability-browser-action-lane.mjs";
import {
  DETERMINISTIC_LLM_KEY_ENV,
  startDeterministicLlmStub,
  writeDeterministicLlmProviderConfig,
} from "./scenarios/deterministic-llm-stub.mjs";
import {
  assertNativeStageScrollContract,
  assertProviderAnchorAndAdviceContract,
  NATIVE_SCROLL_HANDOFF_ROUTE_SLUGS,
} from "./scenarios/native-scroll-contract-proof.mjs";
import {
  auditPageAccessibility,
  probeKeyboardFocus,
  runAccessibilitySmokeLane as runAccessibilitySmokeLaneImpl,
} from "./scenarios/accessibility-smoke-lane.mjs";
import { runApiCompatibilityLane as runApiCompatibilityLaneImpl } from "./scenarios/api-compatibility-lane.mjs";
import { runVisualRegressionLane as runVisualRegressionLaneImpl } from "./scenarios/visual-regression-lane.mjs";
import { runRuntimeTruthLane as runRuntimeTruthLaneImpl } from "./scenarios/runtime-truth-lane.mjs";
import { runAuthMatrixLane as runAuthMatrixLaneImpl } from "./scenarios/auth-matrix-lane.mjs";
import { runArchitectureMetricsLane as runArchitectureMetricsLaneImpl } from "./scenarios/architecture-metrics-lane.mjs";
import { runCatalogParityLane as runCatalogParityLaneImpl } from "./scenarios/catalog-parity-lane.mjs";
import { runMeshReadinessLane as runMeshReadinessLaneImpl } from "./scenarios/mesh-readiness-lane.mjs";
import { runSecurityEvalsLane as runSecurityEvalsLaneImpl } from "./scenarios/security-evals-lane.mjs";
import {
  runCodeModeHostileSandboxLane as runCodeModeHostileSandboxLaneImpl,
  runCodeModeSandboxRequiredLane as runCodeModeSandboxRequiredLaneImpl,
} from "./scenarios/code-mode-sandbox-lanes.mjs";
export { A2A_FULL_LANE_COMMANDS, FAST_LANE_COMMANDS, runA2AFullLane, runFastLane } from "./scenarios/fast-lane.mjs";

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
const AXE_SOURCE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const VISUAL_BASELINE_ROOT_DIR = path.join(repoRoot, "scripts", "verification", "baselines", "visual");
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
// The file upload fixture would otherwise render "now" in the file list baseline.
const MISSION_CONTROL_NEXT_FILE_FIXTURE_MTIME = new Date("2026-05-17T21:51:00.000Z");

function verificationLaneDeps() {
  return {
    API_COMPAT_ALLOWLIST_PATH,
    API_COMPAT_BASELINE_PATH,
    NEXT_UI_PACKAGE,
    VISUAL_DIFF_RATIO_THRESHOLD,
    VISUAL_ROUTE_READY_TIMEOUT_MS,
    assertApprovalIngressMatrix,
    assertBrowserConsoleHealthy,
    assertHighRiskRouteFamiliesAreOperatorGated,
    assertLegacyRedirectResolution,
    assertNextVisualScenarioChrome,
    assertNoFooterStatusCollision,
    assertNativeStageScrollContract,
    assertProviderAnchorAndAdviceContract,
    assertOk,
    assertVisualBaselineCoverage,
    appendTraceArtifact,
    attachBrowserLogging,
    auditPageAccessibility,
    axeSourcePath: AXE_SOURCE_PATH,
    buildAuthMatrixExpectations,
    buildVerificationUiUrl,
    captureBrowserArtifacts,
    captureRouteReadyFailure,
    chromium,
    clampString,
    collectArchitectureMetrics,
    compareRealtimeContract,
    compareArchitectureMetrics,
    compareRestContract,
    compareVisualBaseline,
    createAuthMatrixCredentials,
    delay,
    emptyArtifacts,
    ensureGatewayWorkspaceBuild,
    ensureOnboardingComplete,
    filterVisualItemsBySlug,
    filterExpectedBrowserConsoleMessages,
    forceVerificationUiPackage,
    installMissionControlNextBrowserState,
    isAllowedStatus,
    issueOperatorSseToken,
    maybeParseBool,
    NATIVE_SCROLL_HANDOFF_ROUTE_SLUGS,
    path,
    performVerificationInteraction,
    pinVisualRegressionProvider,
    probeKeyboardFocus,
    pollSseConnectionRecoveryEvidence,
    prepareVerificationRuntime,
    pnpmCommand,
    randomUUID,
    readBrowserSseDiagnostics,
    probeAuthMatrixRoute,
    readArchitectureMetricsBaseline,
    readJson,
    relativeToRun,
    repoRoot,
    requestJson,
    resolveVerificationTargetContext,
    resolveVisualRouteHref: resolveReleaseSurfaceHref,
    restartGatewayProcess,
    runCommand,
    runMissionControlNextMobileShellProof,
    runScenario,
    seedMissionControlNextFixture,
    selectRepresentativeManifestRoute,
    setBrowserCorrelation,
    snapshotApiCompatibilityCurrentShellFacts,
    snapshotRealtimeContract,
    snapshotRestContract,
    stabilizeVisualRegressionSnapshot,
    stabilizeMissionControlNextFileFixtureMtime,
    startVerificationStack,
    startDeterministicLlmStub,
    startVerificationUiProcess,
    startBrowserTrace,
    stopProcess,
    stopVerificationStack,
    waitForDurableRunStatus,
    waitForMissionControlShell,
    waitForVerificationRouteReady,
    writeJson,
    writeDeterministicLlmProviderConfig,
    writeMissionControlNextManualProofChecklist,
  };
}

export async function runSkillsCatalogLane(context) {
  await runScenario(
    context,
    {
      id: "skills-catalog.coverage-floor",
      lane: "skills-catalog",
      title: "Skill catalog coverage and token budget",
      subsystem: "skills",
    },
    async () => {
      const result = await runCommand(pnpmCommand(), ["verify:skills:catalog"], {
        cwd: repoRoot,
        artifactRoot: path.join(context.artifactRoot, "diagnostics"),
        logName: "skills-catalog.coverage-floor",
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

export async function runDesktopLane(context) {
  return await runRawVerificationCommandLane(context, {
    id: "desktop.platform-proof",
    lane: "desktop",
    title: "Native desktop build, test, and launcher proof",
    subsystem: "desktop",
    script: "verify:desktop:raw",
  });
}

export async function runExtensionsPackageLane(context) {
  return await runRawVerificationCommandLane(context, {
    id: "extensions.package-proof",
    lane: "extensions-package",
    title: "Extensions SDK package artifact proof",
    subsystem: "extensions",
    script: "verify:extensions:package:raw",
  });
}

export async function runOrchestrationPerformanceLane(context) {
  await runScenario(
    context,
    {
      id: "orchestration.performance.runtime-benchmark",
      lane: "orchestration-performance",
      title: "Deterministic routed orchestration runtime benchmark",
      subsystem: "orchestration",
    },
    async () => {
      const reportPath = path.join(context.artifactRoot, "perf", "orchestration-performance.json");
      const result = await runCommand(pnpmCommand(), ["verify:orchestration:perf:raw", "--output", reportPath], {
        cwd: repoRoot,
        artifactRoot: path.join(context.artifactRoot, "diagnostics"),
        logName: "orchestration.performance.runtime-benchmark",
      });
      return await buildOrchestrationPerformanceScenarioResult(context, result, reportPath);
    },
  );
}

export async function buildOrchestrationPerformanceScenarioResult(context, result, reportPath) {
  // The performance CLI writes its report before setting a failing exit code.
  // Preserve that structured failure evidence instead of replacing it with raw
  // process output when a threshold is exceeded.
  const report = await readJson(reportPath).catch(() => undefined);
  const passed = result.code === 0 && report?.passed === true;
  return {
    status: passed ? "passed" : "failed",
    error: passed
      ? undefined
      : clampString(report?.performanceGate?.thresholdFailures?.join("; ") || result.stderr || result.stdout, 1200),
    metrics: {
      exitCode: result.code,
      durationMs: result.durationMs,
      measuredRunCount: report?.aggregate?.measuredRunCount ?? 0,
      serialMedianEndToEndMs: report?.comparisons?.serialVsParallel?.serialMedianEndToEndMs,
      parallelMedianEndToEndMs: report?.comparisons?.serialVsParallel?.parallelMedianEndToEndMs,
      medianSpeedupRatio: report?.comparisons?.serialVsParallel?.medianSpeedupRatio,
      totalRetries: report?.aggregate?.totalRetries ?? 0,
      totalDuplicateDispatches: report?.aggregate?.totalDuplicateDispatches ?? 0,
    },
    artifacts: {
      diagnostics: [],
      screenshots: [],
      traces: [],
      logs: [relativeToRun(context, result.stdoutPath), relativeToRun(context, result.stderrPath)],
      perf: report ? [relativeToRun(context, reportPath)] : [],
      playwright: [],
    },
  };
}

async function runRawVerificationCommandLane(context, definition) {
  await runScenario(context, definition, async () => {
    const result = await runCommand(pnpmCommand(), [definition.script], {
      cwd: repoRoot,
      artifactRoot: path.join(context.artifactRoot, "diagnostics"),
      logName: definition.id,
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
  });
}

export async function runSecurityEvalsLane(context) {
  return await runSecurityEvalsLaneImpl(context, verificationLaneDeps());
}

function resolveVerificationTargetContext() {
  const uiTarget = resolveUiTarget(repoRoot, process.env);
  const packageName = uiTarget.packageName || DEFAULT_UI_PACKAGE;
  const surfaceRoutes =
    packageName === NEXT_UI_PACKAGE ? NEXT_RELEASE_SURFACE_MANIFEST : resolveSurfaceRegressionManifest();
  return {
    uiTarget,
    packageName,
    isNext: packageName === NEXT_UI_PACKAGE,
    shellContract: resolveShellContract(packageName),
    surfaceRoutes,
    visualRoutes: resolveVisualRegressionManifest(),
    visualVariants: resolveVisualRegressionVariants(),
    redirectRoutes: resolveLegacyRedirectManifest(packageName),
    directCompatibilityRoutes: resolveDirectCompatibilityManifest(packageName),
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

export async function runCodeModeSandboxRequiredLane(context) {
  return await runCodeModeSandboxRequiredLaneImpl(context, verificationLaneDeps());
}

export async function runCodeModeHostileSandboxLane(context) {
  return await runCodeModeHostileSandboxLaneImpl(context, verificationLaneDeps());
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

// Scope caveat (Phase 6 doc-truth): this lane proves the channel-AGNOSTIC durable
// delivery runtime — idempotency dedup, retry backoff, overdue→stale, delivery-attempt
// persistence, the comms HTTP route, and workspace-scoped channel memory lookup — via
// channel-delivery-runtime-service.test.ts, chat-command-service.runtime.test.ts,
// routes/comms.test.ts, and comms-delivery-repo.test.ts. It intentionally does NOT
// exercise concrete channel adapters (Telegram/Discord/Slack) end-to-end; per-adapter
// send/inbound/voice behavior is covered by each adapter's own service tests, not here.
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
    title: "Review-first Chat governance anchors",
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
  await runAutonomousActivationGrantGovernanceScenario(context);
}

// The autonomy-grant gate (deny -> grant -> allow -> revoke -> deny) is the subject of
// this lane. The shipped `chat-agent` default profile denies the synthetic `mcp.invoke`
// tool outright, and deny-wins is absolute -- so under that profile a matching grant can
// never reach an allowed invoke, masking the grant gate behind a base-policy block (and
// making the lane pass or fail depending on whether a gitignored local
// `config/tool-policy.json` happens to exist). Pin an explicit operator-permissive policy
// into the runtime so `mcp.invoke` is allowed by the base policy; the autonomy grant then
// becomes the sole gate the lane actually exercises. Deny-by-default posture for
// `mcp.invoke` is covered separately by the policy-engine deny-wins tests.
export async function writeAutonomyGrantRuntimeToolPolicy(runtimeRoot) {
  const toolPolicy = {
    profiles: { danger: ["*"] },
    tools: {
      approvalMode: "bypass",
      profile: "danger",
      allow: [],
      deny: [],
      loopDetection: {
        enabled: false,
        historySize: 8,
        warningThreshold: 3,
        criticalThreshold: 4,
        globalThreshold: 6,
        detectors: { repeated_same_call: true, no_progress_polling: true, ping_pong: true },
      },
    },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace", "./data", "./.worktrees"],
      readOnlyRoots: ["./skills"],
      readAccessMode: "approval_required",
      networkAllowlist: ["127.0.0.1", "localhost"],
      riskyShellPatterns: ["rm", "rmdir", "del", "format", "shutdown", "reboot", "git push", "git reset --hard"],
      requireApprovalForRiskyShell: true,
    },
  };
  await writeJson(path.join(runtimeRoot, "config", "tool-policy.json"), toolPolicy);

  const unifiedPath = path.join(runtimeRoot, "config", "goatcitadel.json");
  try {
    const unified = await readJson(unifiedPath);
    if (unified && typeof unified === "object" && !Array.isArray(unified)) {
      const updated = { ...unified, toolPolicy };
      // `generation.digest` covers the unified sections. This verification-only
      // policy override intentionally changes one of those sections, so retain no
      // stale digest: an absent generation is the supported fresh-install path and
      // the Gateway stamps the isolated config again during startup.
      delete updated.generation;
      await writeJson(unifiedPath, updated);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function runAutonomousActivationGrantGovernanceScenario(context) {
  const runtimeRoot = await prepareVerificationRuntime(context.runId);
  await writeAutonomyGrantRuntimeToolPolicy(runtimeRoot);
  const stack = await startVerificationStack(context, { includeUi: false, runtimeRoot });
  try {
    await runScenario(
      context,
      {
        id: "agentic.governance.autonomous-activation-grants",
        lane: "agentic-governance",
        title: "Autonomous activation requires an expiring matching operator grant and revokes cleanly",
        subsystem: "agentic",
      },
      async () => {
        const servers = await requestJson(stack.gatewayUrl, "/api/v1/mcp/servers");
        assertOk(servers, "list Gateway-owned MCP servers");
        const server = servers.body?.items?.find((item) => item?.url === "goatcitadel://approval-inbox");
        if (!server?.serverId || server.status !== "connected") {
          throw new Error("Gateway-owned MCP approval inbox server is not connected.");
        }
        const deniedBeforeGrant = await requestJson(stack.gatewayUrl, "/api/v1/mcp/invoke", {
          method: "POST",
          body: {
            serverId: server.serverId,
            toolName: "goatcitadel.approval.remote_action_inbox.list",
            workspaceId: "default",
            surface: "mcp",
            autonomousActivation: true,
            estimatedCostUsd: 0.05,
            arguments: { limit: 1 },
          },
        });
        assertOk(deniedBeforeGrant, "autonomous MCP invoke denied before grant");
        if (deniedBeforeGrant.body?.ok !== false || deniedBeforeGrant.body?.autonomousActivation?.allowed !== false) {
          throw new Error("autonomous MCP runtime invocation was not denied before a matching grant existed");
        }
        const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
        const created = await requestJson(stack.gatewayUrl, "/api/v1/capabilities/autonomy-grants", {
          method: "POST",
          body: {
            workspaceId: "default",
            surfaces: ["cowork", "code", "mcp"],
            maxRiskLevel: "danger",
            capabilityPatterns: ["capability.*"],
            toolPatterns: ["mcp.*", "code.*"],
            activationKinds: ["capability", "tool", "mcp_tool", "code_mode"],
            maxActivations: 2,
            budgetUsd: 1,
            grantor: "verification",
            reason: "verify governed autonomous activation grant matching and revocation",
            expiresAt,
          },
        });
        assertOk(created, "create autonomous activation grant");
        const allowed = await requestJson(stack.gatewayUrl, "/api/v1/capabilities/autonomy-grants/evaluate", {
          method: "POST",
          body: {
            workspaceId: "default",
            surface: "cowork",
            riskLevel: "danger",
            activationKind: "tool",
            toolName: "mcp.remote.fetch",
          },
        });
        assertOk(allowed, "evaluate autonomous activation grant allowed");
        if (!allowed.body?.allowed || allowed.body?.matchedGrantId !== created.body?.grantId) {
          throw new Error("autonomous activation grant did not match the governed request");
        }
        const allowedInvoke = await requestJson(stack.gatewayUrl, "/api/v1/mcp/invoke", {
          method: "POST",
          body: {
            serverId: server.serverId,
            toolName: "goatcitadel.approval.remote_action_inbox.list",
            workspaceId: "default",
            surface: "mcp",
            autonomousActivation: true,
            estimatedCostUsd: 0.05,
            arguments: { limit: 1 },
          },
        });
        assertOk(allowedInvoke, "autonomous MCP invoke allowed with matching grant");
        const allowedInvokeMatchedGrant =
          allowedInvoke.body?.autonomousActivation?.matchedGrantId === created.body?.grantId;
        const allowedInvokeRespectedPolicy =
          allowedInvoke.body?.ok === true ||
          (allowedInvoke.body?.approvalRequired === true &&
            String(allowedInvoke.body?.policyReason ?? "").includes("approval"));
        if (!allowedInvokeMatchedGrant || !allowedInvokeRespectedPolicy) {
          throw new Error(
            `autonomous MCP runtime invocation did not carry matching grant or policy evidence: ${JSON.stringify(
              allowedInvoke.body,
            )}`,
          );
        }
        const revoked = await requestJson(
          stack.gatewayUrl,
          `/api/v1/capabilities/autonomy-grants/${encodeURIComponent(created.body.grantId)}/revoke`,
          {
            method: "POST",
            body: { revokedBy: "verification", reason: "governance lane cleanup" },
          },
        );
        assertOk(revoked, "revoke autonomous activation grant");
        const denied = await requestJson(stack.gatewayUrl, "/api/v1/capabilities/autonomy-grants/evaluate", {
          method: "POST",
          body: {
            workspaceId: "default",
            surface: "cowork",
            riskLevel: "danger",
            activationKind: "tool",
            toolName: "mcp.remote.fetch",
          },
        });
        assertOk(denied, "evaluate revoked autonomous activation grant");
        const deniedAfterRevoke = await requestJson(stack.gatewayUrl, "/api/v1/mcp/invoke", {
          method: "POST",
          body: {
            serverId: server.serverId,
            toolName: "goatcitadel.approval.remote_action_inbox.list",
            workspaceId: "default",
            surface: "mcp",
            autonomousActivation: true,
            estimatedCostUsd: 0.05,
            arguments: { limit: 1 },
          },
        });
        assertOk(deniedAfterRevoke, "autonomous MCP invoke denied after grant revoke");
        if (deniedAfterRevoke.body?.ok !== false || deniedAfterRevoke.body?.autonomousActivation?.allowed !== false) {
          throw new Error("autonomous MCP runtime invocation was not denied after grant revocation");
        }
        const artifactPath = path.join(context.artifactRoot, "diagnostics", "agentic-governance-autonomy-grants.json");
        await writeJson(artifactPath, {
          checkedAt: new Date().toISOString(),
          server,
          deniedBeforeGrant: deniedBeforeGrant.body,
          created: created.body,
          allowed: allowed.body,
          allowedInvoke: allowedInvoke.body,
          revoked: revoked.body,
          denied: denied.body,
          deniedAfterRevoke: deniedAfterRevoke.body,
        });
        return {
          status: denied.body?.allowed || deniedAfterRevoke.body?.ok ? "failed" : "passed",
          error:
            denied.body?.allowed || deniedAfterRevoke.body?.ok
              ? "Revoked grant still allowed autonomous activation."
              : undefined,
          metrics: {
            matchedGrantId: allowed.body?.matchedGrantId,
            runtimeGrantId: allowedInvoke.body?.autonomousActivation?.matchedGrantId,
            revokedStatus: revoked.body?.status,
            deniedBlockers: Array.isArray(denied.body?.blockers) ? denied.body.blockers.length : 0,
            deniedRuntimeReasonCodes: Array.isArray(deniedAfterRevoke.body?.reasonCodes)
              ? deniedAfterRevoke.body.reasonCodes.length
              : 0,
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

export async function runAgenticPluginsMarketplaceLane(context) {
  await runAgenticProofScenario(context, {
    profile: "marketplace",
    id: "agentic.marketplace.callable-governance",
    lane: "agentic-plugins-marketplace",
    title: "Plugin/provider marketplace callable-boundary behavior",
    subsystem: "agentic",
  });
}

export async function runAgenticMcpOAuthLane(context) {
  await runAgenticProofScenario(context, {
    profile: "mcpOAuth",
    id: "agentic.mcp-oauth.gateway-governed",
    lane: "agentic-mcp-oauth",
    title: "Remote MCP and OAuth invocation remains gateway-governed",
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

export async function runDeepCoreLane(context, _options = {}) {
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
          await page.addInitScript((workspaceId) => {
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
            await page.addInitScript((workspaceId) => {
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
      const candidateLifecycle = await exerciseCapabilityCandidatePromotionAndRevocation(
        gatewayUrl,
        candidateId,
        "deep-core candidate",
      );

      const outPath = path.join(context.artifactRoot, "diagnostics", "core-api-chat-code-mode-lifecycle.json");
      await writeJson(outPath, {
        session: createdSession.body,
        chatCommand: chatCommand.body,
        codeModeRun: codeModeRun.body,
        resolvedApproval: resolvedApproval.body,
        completedRun: completedRun.body,
        candidateDetail: candidateLifecycle.initialDetail.body,
        promotionRequest: candidateLifecycle.promotionRequest.body,
        promotionResolution: candidateLifecycle.promotionResolution.body,
        promotedDetail: candidateLifecycle.promotedDetail.body,
        revocationRequest: candidateLifecycle.revocationRequest.body,
        revocationResolution: candidateLifecycle.revocationResolution.body,
        revokedDetail: candidateLifecycle.revokedDetail.body,
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
      const taskRevision = requirePositiveRevision(task.body, "created task");
      const deleted = await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        body: {
          expectedRevision: taskRevision,
          mode: "soft",
          workspaceId,
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
      const trashedTask = Array.isArray(trash.body?.items)
        ? trash.body.items.find((item) => item?.taskId === taskId)
        : undefined;
      const trashedTaskRevision = requirePositiveRevision(trashedTask, "soft-deleted task");
      const restored = await requestJson(gatewayUrl, `/api/v1/tasks/${encodeURIComponent(taskId)}/restore`, {
        method: "POST",
        body: { workspaceId, expectedRevision: trashedTaskRevision },
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
      const settingsRevision = requirePositiveRevision(settings.body, "settings");
      const settingsPatch = await requestJson(gatewayUrl, "/api/v1/settings", {
        method: "PATCH",
        body: {
          expectedRevision: settingsRevision,
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

export async function runOperatorProofLane(context, _options = {}) {
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

  const operatorStub = await startDeterministicLlmStub({
    replyText: "Verification operator approval resumed.",
  });
  let operatorRuntimeRoot;
  let stack;
  try {
    operatorRuntimeRoot = await prepareVerificationRuntime(`${context.runId}-operator-proof`);
    await writeDeterministicLlmProviderConfig(operatorRuntimeRoot, operatorStub.baseUrl);
    stack = await startVerificationStack(context, {
      runtimeRoot: operatorRuntimeRoot,
      includeUi: false,
      gatewayEnv: {
        GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
        GOATCITADEL_DURABLE_FOUNDATION_ENABLED: "true",
        GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
        GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
        [DETERMINISTIC_LLM_KEY_ENV]: "verification-stub-key",
      },
    });
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
        const candidateLifecycle = await exerciseCapabilityCandidatePromotionAndRevocation(
          stack.gatewayUrl,
          candidateId,
          "operator-proof candidate",
        );

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
          candidateDetail: candidateLifecycle.initialDetail.body,
          promotionRequest: candidateLifecycle.promotionRequest.body,
          promotionResolution: candidateLifecycle.promotionResolution.body,
          promotedDetail: candidateLifecycle.promotedDetail.body,
          revocationRequest: candidateLifecycle.revocationRequest.body,
          revocationResolution: candidateLifecycle.revocationResolution.body,
          revokedDetail: candidateLifecycle.revokedDetail.body,
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
    if (stack) {
      await stopVerificationStack(stack);
    } else if (operatorRuntimeRoot) {
      await fs.rm(operatorRuntimeRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    await operatorStub.close().catch(() => undefined);
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
        await writeJson(
          outPath,
          projectOperatorAuthBoundaryEvidence({
            deviceRequest: deviceRequest.body,
            resolvedApproval: resolvedApproval.body,
            approvedStatus: approvedStatus.body,
            companionExchange: exchange.body,
            deniedChecks,
          }),
        );
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

export function projectOperatorAuthBoundaryEvidence(input) {
  const approval = input.resolvedApproval?.approval;
  const resolutionEffects = input.resolvedApproval?.resolutionEffects;
  return {
    deviceRequest: {
      requestId: input.deviceRequest?.requestId,
      approvalId: input.deviceRequest?.approvalId,
      status: input.deviceRequest?.status,
      expiresAt: input.deviceRequest?.expiresAt,
    },
    resolvedApproval: {
      approval: approval
        ? {
            approvalId: approval.approvalId,
            kind: approval.kind,
            riskLevel: approval.riskLevel,
            status: approval.status,
            createdAt: approval.createdAt,
            resolvedAt: approval.resolvedAt,
            explanationStatus: approval.explanationStatus,
          }
        : null,
      effects: Array.isArray(input.resolvedApproval?.effects)
        ? input.resolvedApproval.effects.map((effect) => ({
            effectId: effect.effectId,
            effectKind: effect.effectKind,
            targetKind: effect.targetKind,
            targetId: effect.targetId,
            status: effect.status,
            attemptCount: effect.attemptCount,
            version: effect.version,
          }))
        : [],
      durableRunId: input.resolvedApproval?.durableRunId,
      resolutionEffects: resolutionEffects
        ? {
            approvalWaitDurableRunId: resolutionEffects.approvalWaitDurableRunId,
            proactiveRunCount: Array.isArray(resolutionEffects.proactiveRunIds)
              ? resolutionEffects.proactiveRunIds.length
              : 0,
            chatTurnResume: resolutionEffects.chatTurnResume
              ? {
                  resumed: resolutionEffects.chatTurnResume.resumed === true,
                  resumedTurnId: resolutionEffects.chatTurnResume.resumedTurnId,
                  resumedRunId: resolutionEffects.chatTurnResume.resumedRunId,
                }
              : null,
          }
        : null,
    },
    approvedStatus: {
      requestId: input.approvedStatus?.requestId,
      approvalId: input.approvedStatus?.approvalId,
      status: input.approvedStatus?.status,
      expiresAt: input.approvedStatus?.expiresAt,
      resolvedAt: input.approvedStatus?.resolvedAt,
      deviceCredentialIssued:
        typeof input.approvedStatus?.deviceToken === "string" && input.approvedStatus.deviceToken.length > 0,
      credentialExpiresAt: input.approvedStatus?.deviceTokenExpiresAt,
      message: input.approvedStatus?.message,
    },
    companionExchange: {
      contractId: input.companionExchange?.contractId,
      sessionId: input.companionExchange?.sessionId,
      grantId: input.companionExchange?.grantId,
      actorId: input.companionExchange?.actorId,
      deviceLabel: input.companionExchange?.deviceLabel,
      deviceType: input.companionExchange?.deviceType,
      platform: input.companionExchange?.platform,
      accessCredentialIssued:
        typeof input.companionExchange?.accessToken === "string" && input.companionExchange.accessToken.length > 0,
      accessCredentialExpiresAt: input.companionExchange?.accessTokenExpiresAt,
      refreshCredentialIssued:
        typeof input.companionExchange?.refreshToken === "string" && input.companionExchange.refreshToken.length > 0,
      refreshCredentialExpiresAt: input.companionExchange?.refreshTokenExpiresAt,
      issuedAt: input.companionExchange?.issuedAt,
      signatureAlgorithm: input.companionExchange?.signatureAlgorithm,
      principalPurpose: input.companionExchange?.principalPurpose,
    },
    deniedChecks: input.deniedChecks.map((entry) => ({
      actor: entry.actor,
      route: entry.route,
      status: entry.response.status,
      error: typeof entry.response.body?.error === "string" ? entry.response.body.error : undefined,
      code: typeof entry.response.body?.code === "string" ? entry.response.body.code : undefined,
    })),
  };
}

export async function runDurableRecoveryLane(context, options = {}) {
  return await runDurableRecoveryLaneImpl(context, options, verificationLaneDeps());
}

export async function runSelfConfigurationLane(context, options = {}) {
  return await runSelfConfigurationLaneImpl(context, options, verificationLaneDeps());
}

export async function runUsageReconciliationLane(context, options = {}) {
  return await runUsageReconciliationLaneImpl(context, options, verificationLaneDeps());
}

export async function runRoutedContextSnapshotsLane(context, options = {}) {
  return await runRoutedContextSnapshotsLaneImpl(context, options, verificationLaneDeps());
}

export async function runModelCouncilLane(context, options = {}) {
  return await runModelCouncilLaneImpl(context, options, verificationLaneDeps());
}

export async function runSkillLearningLane(context, options = {}) {
  return await runSkillLearningLaneImpl(context, options, verificationLaneDeps());
}

export async function runSessionControlLane(context, options = {}) {
  return await runSessionControlLaneImpl(context, options, verificationLaneDeps());
}

export async function runVertexFireworksProvidersLane(context, options = {}) {
  return await runVertexFireworksProvidersLaneImpl(context, options, verificationLaneDeps());
}

export async function runReasoningProfilesLane(context, options = {}) {
  return await runReasoningProfilesLaneImpl(context, options, verificationLaneDeps());
}

export async function runSurfaceRegressionLane(context, options = {}) {
  return await runSurfaceRegressionLaneImpl(context, options, verificationLaneDeps());
}

export async function runUsabilityLane(context, options = {}) {
  return await runUsabilityLaneImpl(context, options, verificationLaneDeps());
}

export async function runUsabilityBrowserActionBundles(context, options = {}) {
  return await runUsabilityBrowserActionLaneImpl(context, options, verificationLaneDeps());
}

export async function runUsabilityCoreLane(context, options = {}) {
  return await runUsabilityCoreLaneImpl(context, options, verificationLaneDeps());
}

export async function runAccessibilitySmokeLane(context, options = {}) {
  return await runAccessibilitySmokeLaneImpl(context, options, verificationLaneDeps());
}

export async function runCatalogParityLane(context, options = {}) {
  return await runCatalogParityLaneImpl(context, options, verificationLaneDeps());
}

export async function runApiCompatibilityLane(context, options = {}) {
  return await runApiCompatibilityLaneImpl(context, options, verificationLaneDeps());
}

async function snapshotApiCompatibilityCurrentShellFacts(gatewayUrl) {
  return await snapshotApiCompatibilityCurrentShellFactsImpl(gatewayUrl, verificationLaneDeps());
}

export async function runMeshReadinessLane(context, options = {}) {
  return await runMeshReadinessLaneImpl(context, options, verificationLaneDeps());
}

export async function runBackupRoundtripLane(context, _options = {}) {
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

        // A live config owner can finish an atomic generation write between a
        // filesystem read and the backup request. Pair the exact recursive
        // config bytes with the completed backup before destructive mutation.
        // This bounded precondition retry preserves byte-for-byte restore proof
        // without classifying legitimate owner completion as restore drift.
        const maxBackupSnapshotAttempts = 8;
        let backupSnapshotAttempts = 0;
        let configSnapshots = [];
        let createdBackup;
        let backupPath = "";
        let snapshotDrift = [];
        while (backupSnapshotAttempts < maxBackupSnapshotAttempts) {
          backupSnapshotAttempts += 1;
          configSnapshots = await captureConfigJsonSnapshots(configDir, runtimeRoot);
          createdBackup = await requestJson(stack.gatewayUrl, "/api/v1/admin/backups/create", {
            method: "POST",
            body: {
              name: "verification-backup-roundtrip",
            },
          });
          assertOk(createdBackup, "create runtime backup");
          backupPath = path.basename(String(createdBackup.body?.outputPath ?? ""));
          if (!backupPath) {
            throw new Error("backup create response did not include an outputPath");
          }
          snapshotDrift = await findBackupConfigSnapshotDrift(
            configSnapshots,
            path.join(backupRoot, backupPath, "payload"),
          );
          if (snapshotDrift.length === 0) break;
          if (backupSnapshotAttempts < maxBackupSnapshotAttempts) await delay(250);
        }
        if (!createdBackup || snapshotDrift.length > 0) {
          throw new Error(
            `backup config snapshot did not stabilize after ${backupSnapshotAttempts} attempts: ${snapshotDrift.join(", ")}`,
          );
        }

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
        const mutationRemovalAttempts = {};
        const removeMutationFile = async (targetPath) => {
          const relativePath = path.relative(runtimeRoot, targetPath).replaceAll("\\", "/");
          mutationRemovalAttempts[relativePath] = await removeBackupMutationFileWithRetry(targetPath);
        };
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
          await removeMutationFile(snapshot.absolutePath);
          configMutationSummary[snapshot.relativePath] = {
            mutation: "deleted",
            mutated: !(await exists(snapshot.absolutePath)),
          };
        }
        await removeMutationFile(dbPath);
        await removeMutationFile(dbWalPath);
        await removeMutationFile(dbShmPath);
        await removeMutationFile(transcriptPath);
        await removeMutationFile(auditPath);
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
          backupSnapshotAttempts,
          mutationRemovalAttempts,
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
  return await runVisualRegressionLaneImpl(context, options, verificationLaneDeps());
}

function filterVisualItemsBySlug(items, rawSlugs, label) {
  const slugs = String(rawSlugs ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  if (slugs.length === 0) {
    return items;
  }
  const selected = items.filter((item) => slugs.includes(item.slug));
  const selectedSlugs = new Set(selected.map((item) => item.slug));
  const missing = slugs.filter((slug) => !selectedSlugs.has(slug));
  if (missing.length > 0) {
    throw new Error(`Unknown ${label} slug(s): ${missing.join(", ")}`);
  }
  return selected;
}

export async function runDeepEcosystemLane(context, _options = {}) {
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
          id: "ecosystem.ops-kanban.route",
          lane: "deep-ecosystem",
          title: "Ops Kanban route renders with reduced effects",
          subsystem: "ops-kanban",
        },
        async ({ correlationId }) => {
          await page.addInitScript(() => {
            window.localStorage.setItem("goatcitadel.ui.effects_mode.v1", "reduced");
          });
          if (verificationTarget.isNext) {
            const opsKanbanRoute = getVerificationRoute(verificationTarget, "ops-kanban");
            await page.goto(buildVerificationUiUrl(stack.uiUrl, opsKanbanRoute.href), {
              waitUntil: "domcontentloaded",
            });
            await waitForVerificationRouteReady(page, opsKanbanRoute, verificationPackageName);
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
          const perfPath = path.join(context.artifactRoot, "perf", "ecosystem-ops-kanban-perf.json");
          await writeJson(perfPath, perf);
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "ecosystem-ops-kanban-route",
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
                ? "Ops Kanban rendered with reduced effects enabled."
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
  return await runRuntimeTruthLaneImpl(context, options, verificationLaneDeps());
}

export async function runAuthMatrixLane(context, options = {}) {
  return await runAuthMatrixLaneImpl(context, options, verificationLaneDeps());
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
    // Provider summaries exercise the same operator-only /api/v1/llm policy
    // without coupling the auth proof to an in-flight config-generation reconciliation.
    { family: "llm", method: "GET", url: "/api/v1/llm/providers" },
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

export function requireCanonicalMemorySeed(body, expectedWorkspaceId, label) {
  const itemId = typeof body?.itemId === "string" ? body.itemId.trim() : "";
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
  if (!itemId || workspaceId !== expectedWorkspaceId) {
    throw new Error(`${label} did not return canonical ownership`);
  }
  return itemId;
}

export async function runUiParityLane(context, _options = {}) {
  const stack = await startVerificationStack(context, {
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_TOKEN: "verification-ui-parity-operator-token",
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
      GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED: "true",
      GOATCITADEL_FEATURE_MEMORY_MAINTENANCE_V1_ENABLED: "true",
      GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
    },
  });
  const nextUi = await startVerificationUiProcess(context, stack.gatewayUrl, NEXT_UI_PACKAGE, "ui-parity-next");
  try {
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-ui-parity");
    const fixture = await seedMissionControlNextFixture(stack.gatewayUrl);
    const foreignFixture = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
      method: "POST",
      body: {
        workspaceName: "UI Parity Foreign Workspace",
        sessionTitle: "UI Parity Foreign Session",
        sessionCount: 1,
        longThreadTurns: 2,
      },
    });
    assertOk(foreignFixture, "seed ui-parity foreign workspace");
    const foreignWorkspaceId = foreignFixture.body?.workspaceId;
    if (!foreignWorkspaceId) {
      throw new Error("ui-parity foreign seed did not return a workspaceId");
    }
    const foreignMemoryNeedle = `Foreign workspace memory ${randomUUID().slice(0, 8)}`;
    const foreignMemory = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/memory-item-seed", {
      method: "POST",
      body: {
        workspaceId: foreignWorkspaceId,
        namespace: "mission-control-next",
        title: foreignMemoryNeedle,
        content: "This foreign-workspace item must not appear in the selected workspace Library.",
        metadata: { source: "ui-parity-foreign" },
      },
    });
    assertOk(foreignMemory, "seed ui-parity foreign memory item");
    const foreignMemoryItemId = requireCanonicalMemorySeed(
      foreignMemory.body,
      foreignWorkspaceId,
      "ui-parity foreign memory seed",
    );
    const approvals = await requestJson(stack.gatewayUrl, "/api/v1/approvals?status=pending&limit=20");
    assertOk(approvals, "read ui-parity approvals");
    const memoryItems = await requestJson(
      stack.gatewayUrl,
      `/api/v1/memory/items?workspaceId=${encodeURIComponent(fixture.workspaceId)}&status=all&limit=20`,
    );
    assertOk(memoryItems, "read ui-parity memory items");
    const memoryNeedle = "Mission Control Next shell posture";
    if (
      !memoryItems.body?.items?.some((item) => item.title === memoryNeedle && item.workspaceId === fixture.workspaceId)
    ) {
      throw new Error("ui-parity selected-workspace memory read omitted its canonical item");
    }
    if (
      memoryItems.body?.items?.some((item) => item.itemId === foreignMemoryItemId || item.title === foreignMemoryNeedle)
    ) {
      throw new Error("ui-parity selected-workspace memory read exposed the foreign item");
    }
    const events = await requestJson(stack.gatewayUrl, "/api/v1/events?limit=20");
    assertOk(events, "read ui-parity events");
    const approvalNeedle = approvals.body?.items?.[0]?.kind ?? approvals.body?.items?.[0]?.approvalId ?? "shell.exec";
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
            diagnostics: await collectUiParitySurface({
              page: nextPage,
              baseUrl: nextUi.uiUrl,
              href: "/ops/diagnostics",
              route: { expectedArea: "ops", expectedSection: "diagnostics", readyText: "Diagnostics directory" },
              packageName: NEXT_UI_PACKAGE,
              correlationId,
              sessionId: fixture.sessionId,
              needle: "System vitals",
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
              absentNeedle: foreignMemoryNeedle,
            }),
            mcpSettings: await collectUiParitySurface({
              page: nextPage,
              baseUrl: nextUi.uiUrl,
              href: "/settings/mcp",
              route: { expectedArea: "settings", expectedSection: "mcp", readyText: "MCP servers" },
              packageName: NEXT_UI_PACKAGE,
              correlationId,
              sessionId: fixture.sessionId,
              needle: "Remote MCP preview",
            }),
          };

          const labelledChecks = [
            ["approvals", parity.approvals],
            ["runtime", parity.runtime],
            ["diagnostics", parity.diagnostics],
            ["activity", parity.activity],
            ["memory", parity.memory],
            ["mcp-settings", parity.mcpSettings],
          ];
          for (const [label, nextResult] of labelledChecks) {
            if (!nextResult.ready) {
              throw new Error(`ui-parity ${label} route did not become ready`);
            }
            if (!nextResult.needleVisible) {
              throw new Error(`ui-parity next ${label} surface did not expose the seeded fact ${nextResult.needle}`);
            }
          }
          if (parity.memory.absentNeedleVisible) {
            throw new Error(`ui-parity memory surface exposed foreign workspace item ${foreignMemoryNeedle}`);
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
              diagnosticsReady: Number(parity.diagnostics.needleVisible),
              activityReady: Number(parity.activity.needleVisible),
              memoryReady: Number(parity.memory.needleVisible),
              mcpSettingsReady: Number(parity.mcpSettings.needleVisible),
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

export async function runMemoryTruthLane(context, _options = {}) {
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
        const memoryWorkspaceId = seeded.body?.workspaceId;
        if (!memoryWorkspaceId) {
          throw new Error("memory-truth seed did not return a workspaceId");
        }
        const foreignSeed = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
          method: "POST",
          body: {
            workspaceName: "Memory Truth Foreign Workspace",
            sessionTitle: "Memory Truth Foreign Session",
            sessionCount: 1,
            longThreadTurns: 2,
          },
        });
        assertOk(foreignSeed, "seed memory-truth foreign workspace");
        const foreignWorkspaceId = foreignSeed.body?.workspaceId;
        if (!foreignWorkspaceId) {
          throw new Error("memory-truth foreign seed did not return a workspaceId");
        }
        const foreignTitle = `Foreign memory truth item ${randomUUID().slice(0, 8)}`;
        const foreignItem = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/memory-item-seed", {
          method: "POST",
          body: {
            workspaceId: foreignWorkspaceId,
            namespace: "memory-truth",
            title: foreignTitle,
            content: "FOREIGN_MEMORY_TRUTH_SENTINEL must stay outside the selected workspace.",
            metadata: { lane: "memory-truth-foreign" },
          },
        });
        assertOk(foreignItem, "seed memory-truth foreign item");
        const foreignItemId = requireCanonicalMemorySeed(
          foreignItem.body,
          foreignWorkspaceId,
          "memory-truth foreign memory seed",
        );

        const memoryTitle = `Memory truth item ${randomUUID().slice(0, 8)}`;
        const created = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/memory-item-seed", {
          method: "POST",
          body: {
            workspaceId: memoryWorkspaceId,
            namespace: "memory-truth",
            title: memoryTitle,
            content: "This item should expire without being silently deleted.",
            metadata: {
              lane: "memory-truth",
              sessionId: seeded.body?.sessionId,
            },
          },
        });
        assertOk(created, "seed memory-truth item");
        if (created.body?.workspaceId !== memoryWorkspaceId) {
          throw new Error("memory-truth seed did not return canonical workspace ownership");
        }

        const listedAll = await requestJson(
          stack.gatewayUrl,
          `/api/v1/memory/items?workspaceId=${encodeURIComponent(memoryWorkspaceId)}&status=all&limit=200`,
        );
        assertOk(listedAll, "list memory items before ttl patch");
        const item = listedAll.body?.items?.find((entry) => entry.itemId === created.body?.itemId);
        if (!item?.itemId) {
          throw new Error(`memory-truth could not find seeded memory item ${memoryTitle}`);
        }
        if (item.workspaceId !== memoryWorkspaceId) {
          throw new Error(`memory-truth listed ${item.itemId} without canonical workspace ownership`);
        }
        if (listedAll.body?.items?.some((entry) => entry.itemId === foreignItemId || entry.title === foreignTitle)) {
          throw new Error(`memory-truth exposed foreign workspace item ${foreignTitle}`);
        }

        const patchRequest = await requestJson(
          stack.gatewayUrl,
          `/api/v1/memory/items/${encodeURIComponent(item.itemId)}`,
          {
            method: "PATCH",
            body: {
              ttlOverrideSeconds: 1,
            },
          },
        );
        assertOk(patchRequest, "request memory item ttl patch approval");
        const patchApprovalId = patchRequest.body?.pendingApproval?.approvalId;
        if (typeof patchApprovalId !== "string" || !patchApprovalId.trim()) {
          throw new Error("memory-truth ttl patch did not return a pending memory.lifecycle approval");
        }
        const patchResolution = await requestJson(
          stack.gatewayUrl,
          `/api/v1/approvals/${encodeURIComponent(patchApprovalId)}/resolve`,
          {
            method: "POST",
            body: {
              decision: "approve",
              resolutionNote: "memory-truth ttl lifecycle verification",
            },
          },
        );
        assertOk(patchResolution, "resolve memory item ttl patch approval");

        let activeItems = null;
        let allItems = null;
        let expiredItem = null;
        let patchedItem = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          activeItems = await requestJson(
            stack.gatewayUrl,
            `/api/v1/memory/items?workspaceId=${encodeURIComponent(memoryWorkspaceId)}&status=active&limit=200`,
          );
          assertOk(activeItems, "list active memory items after ttl approval");
          allItems = await requestJson(
            stack.gatewayUrl,
            `/api/v1/memory/items?workspaceId=${encodeURIComponent(memoryWorkspaceId)}&status=all&limit=200`,
          );
          assertOk(allItems, "list all memory items after ttl approval");
          patchedItem = allItems.body?.items?.find((entry) => entry.itemId === item.itemId) ?? null;
          const patchApplied =
            patchedItem?.ttlOverrideSeconds === 1 &&
            typeof patchedItem?.expiresAt === "string" &&
            Number.isFinite(Date.parse(patchedItem.expiresAt));
          const visibleAsActive = activeItems.body?.items?.some((entry) => entry.itemId === item.itemId) === true;
          if (patchApplied && !visibleAsActive && patchedItem.lifecycleState === "expired") {
            expiredItem = patchedItem;
            break;
          }
          await delay(250);
        }
        if (!patchedItem || patchedItem.ttlOverrideSeconds !== 1 || !patchedItem.expiresAt) {
          throw new Error(
            `memory-truth approval ${patchApprovalId} did not apply the ttl patch: ${JSON.stringify(patchedItem)}`,
          );
        }
        if (!expiredItem) {
          throw new Error(
            `memory-truth expected ${item.itemId} to expire after the approved ttl patch; ` +
              `expiresAt=${patchedItem.expiresAt}; active=${JSON.stringify(activeItems?.body ?? null)}`,
          );
        }
        const history = await requestJson(
          stack.gatewayUrl,
          `/api/v1/memory/items/${encodeURIComponent(item.itemId)}/history?limit=50`,
        );
        assertOk(history, "read memory item history after expiry");

        if (activeItems.body?.items?.some((entry) => entry.itemId === item.itemId)) {
          throw new Error(`memory-truth expected ${item.itemId} to disappear from active reads after expiry`);
        }
        if (expiredItem.lifecycleState !== "expired") {
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
          if ((await page.getByText(foreignTitle, { exact: false }).count()) > 0) {
            throw new Error(`memory-truth Library exposed foreign workspace item ${foreignTitle}`);
          }
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
            patchRequest: patchRequest.body,
            patchResolution: patchResolution.body,
            patchedItem,
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

export async function runRealtimeTruthLane(context, _options = {}) {
  let stack;
  const restoreUiPackage = forceVerificationUiPackage(NEXT_UI_PACKAGE);
  const realtimeGatewayEnv = {
    GOATCITADEL_AUTH_MODE: "token",
    GOATCITADEL_AUTH_TOKEN: "verification-realtime-truth-operator-token",
    GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
  };
  try {
    stack = await startVerificationStack(context, {
      includeUi: true,
      gatewayEnv: realtimeGatewayEnv,
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

          // Replace the live same-origin document before installing the stale
          // cursor. This closes its EventSource without crossing into an opaque
          // origin, where the shared browser-state initializer cannot access
          // localStorage. It also prevents that EventSource from racing the write.
          await page.setContent("<!doctype html><html><body></body></html>");
          await page.evaluate(
            (cursor) => {
              window.localStorage.setItem("goatcitadel.events.cursor.v1", cursor);
            },
            String(seeded.body?.staleCursor ?? ""),
          );
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

    await runScenario(
      context,
      {
        id: "realtime-truth.disconnect-reconnect-resubscribe",
        lane: "realtime-truth",
        title: "Mission Control visibly degrades, reconnects, and consumes a post-restart realtime event",
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
          await page.locator('[aria-label="Live updates: Streaming"]').first().waitFor({ timeout: 15000 });

          const screenshotDir = path.join(context.artifactRoot, "screenshots");
          await fs.mkdir(screenshotDir, { recursive: true });
          const beforeScreenshot = path.join(screenshotDir, "realtime-disconnect-reconnect-before.png");
          const degradedScreenshot = path.join(screenshotDir, "realtime-disconnect-reconnect-degraded.png");
          const recoveredScreenshot = path.join(screenshotDir, "realtime-disconnect-reconnect-recovered.png");
          await page.screenshot({ path: beforeScreenshot, fullPage: false });

          const beforeState = await page.evaluate(() => ({
            clientId: window.localStorage.getItem("goatcitadel.events.client.v1"),
            cursor: window.localStorage.getItem("goatcitadel.events.cursor.v1"),
          }));
          const gatewayPidBefore = stack.gateway?.child?.pid;
          const outageLogCursor = browserLog.mark();
          await stopProcess(stack.gateway);
          await page.locator('[aria-label="Live updates: Polling fallback"]').first().waitFor({ timeout: 15000 });
          await page.screenshot({ path: degradedScreenshot, fullPage: false });

          stack.gateway = await restartGatewayProcess(context, stack, realtimeGatewayEnv);
          const gatewayPidAfter = stack.gateway?.child?.pid;
          if (
            !Number.isSafeInteger(gatewayPidBefore) ||
            !Number.isSafeInteger(gatewayPidAfter) ||
            gatewayPidBefore === gatewayPidAfter
          ) {
            throw new Error(
              `realtime reconnect expected a new owned Gateway process, got ${String(gatewayPidBefore)} -> ${String(gatewayPidAfter)}`,
            );
          }
          await page.locator('[aria-label="Live updates: Streaming"]').first().waitFor({ timeout: 30000 });
          const recoveryLogCursor = browserLog.mark();

          const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/realtime-truth-seed", {
            method: "POST",
            body: {},
          });
          assertOk(seeded, "seed post-reconnect realtime event");
          const expectedSequence = Number(seeded.body?.compatibilityEvent?.sequence);
          if (!Number.isSafeInteger(expectedSequence) || expectedSequence <= 0) {
            throw new Error("post-reconnect realtime seed returned no valid terminal sequence");
          }
          await page.waitForFunction(
            (sequence) => Number(window.localStorage.getItem("goatcitadel.events.cursor.v1")) >= sequence,
            expectedSequence,
            { timeout: 15000 },
          );
          const afterState = await page.evaluate(() => ({
            clientId: window.localStorage.getItem("goatcitadel.events.client.v1"),
            cursor: window.localStorage.getItem("goatcitadel.events.cursor.v1"),
          }));
          if (!beforeState.clientId || afterState.clientId !== beforeState.clientId) {
            throw new Error(
              `realtime reconnect changed the browser client identity (${beforeState.clientId ?? "missing"} -> ${afterState.clientId ?? "missing"})`,
            );
          }

          await page.getByLabel("Refresh Ops runtime data").click();
          await page.getByText("verification_memory_refresh", { exact: false }).first().waitFor({ timeout: 15000 });
          await page.screenshot({ path: recoveredScreenshot, fullPage: false });
          const browserSanity = assertBrowserConsoleHealthy(browserLog, recoveryLogCursor, NEXT_UI_PACKAGE);
          const artifacts = await captureBrowserArtifacts(context, {
            slug: "realtime-disconnect-reconnect-resubscribe",
            page,
            browserLog,
            gatewayUrl: stack.gatewayUrl,
            correlationId,
            logCursor: recoveryLogCursor,
          });
          const outPath = path.join(
            context.artifactRoot,
            "diagnostics",
            "realtime-disconnect-reconnect-resubscribe.json",
          );
          await writeJson(outPath, {
            gateway: {
              beforePid: gatewayPidBefore,
              afterPid: gatewayPidAfter,
              endpoint: stack.gatewayUrl,
            },
            browser: {
              before: beforeState,
              after: afterState,
              outageDiagnostics: browserLog.getSnapshot(outageLogCursor),
            },
            postReconnectEvent: {
              eventId: seeded.body?.compatibilityEvent?.eventId,
              eventType: seeded.body?.compatibilityEvent?.eventType,
              sequence: expectedSequence,
            },
          });
          return {
            status: "passed",
            metrics: {
              gatewayPidBefore,
              gatewayPidAfter,
              postReconnectSequence: expectedSequence,
              consoleErrorsAfterRecovery: browserSanity.consoleErrors.length,
              pageErrorsAfterRecovery: browserSanity.pageErrors.length,
            },
            artifacts: {
              ...artifacts,
              diagnostics: [...artifacts.diagnostics, relativeToRun(context, outPath)],
              screenshots: [
                relativeToRun(context, beforeScreenshot),
                relativeToRun(context, degradedScreenshot),
                relativeToRun(context, recoveredScreenshot),
                ...artifacts.screenshots,
              ],
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
  return await runArchitectureMetricsLaneImpl(context, verificationLaneDeps());
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
          const status = deriveProviderStatus(response.body, { providerConfigured: true });
          return {
            status,
            providerId: response.body?.providerId ?? null,
            modelId: response.body?.model,
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
              requestedProviderId: response.body?.requestedProviderId ?? provider.providerId,
              requestedModel: response.body?.requestedModel ?? provider.defaultModel,
              returnedModel: response.body?.model ?? null,
              usage: response.body?.usage ?? null,
              modelUsageEventIds: response.body?.modelUsageEventIds ?? [],
              toolCallObserved: response.body?.toolCallObserved ?? false,
              toolResultRoundTrip: response.body?.toolResultRoundTrip ?? false,
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
            const catalogEntry = Array.from(document.querySelectorAll(".chat-model-picker-metadata > div")).find(
              (entry) => entry.querySelector("dt")?.textContent?.trim() === "Catalog",
            );
            if (catalogEntry?.querySelector("dd")?.textContent?.trim() === "not_checked") {
              return false;
            }
            const routeLoadingBanner = Array.from(document.querySelectorAll(".mc-next-composer-banner.info")).some(
              (banner) => banner.textContent?.includes("Checking the selected provider/model route"),
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

export async function performVerificationInteraction(page, interaction, packageName = DEFAULT_UI_PACKAGE) {
  if (!interaction) {
    return;
  }
  if (interaction === "open-inspector" && packageName === NEXT_UI_PACKAGE) {
    const inspector = page.locator(".mc-next-shell-inspector");
    const routeDetailsButton = page.getByRole("button", { name: /^(Open|Hide) Route details$/i }).first();
    if (!(await routeDetailsButton.isVisible().catch(() => false))) {
      const overflowButton = page.getByRole("button", { name: /^More controls$/i }).first();
      await overflowButton.waitFor({ timeout: 15000 });
      await overflowButton.click();
      const routeDetailsMenuItem = page.getByRole("menuitem", { name: /^(Open|Hide) Route details$/i }).first();
      await routeDetailsMenuItem.waitFor({ timeout: 15000 });
      await routeDetailsMenuItem.click();
      await inspector.waitFor({ state: "visible", timeout: 15000 });
      return;
    }
    await routeDetailsButton.waitFor({ timeout: 15000 });
    const deadline = Date.now() + 15000;
    let attemptedClick = false;

    while (Date.now() < deadline) {
      if (await inspector.isVisible().catch(() => false)) {
        return;
      }

      const label = (await routeDetailsButton.textContent())?.trim() ?? "";
      if (!/hide route details/i.test(label) || !attemptedClick) {
        try {
          await routeDetailsButton.click({ timeout: 5000 });
        } catch {
          await routeDetailsButton.evaluate((element) => {
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

async function assertLegacyRedirectResolution(page, expectedPath, expectedSearchParams = {}, timeoutMs = 30000) {
  await page.waitForFunction((pathName) => window.location.pathname === pathName, expectedPath, {
    timeout: timeoutMs,
  });
  const { leakedParams, searchMismatches } = await page.evaluate((expectedEntries) => {
    const params = new URLSearchParams(window.location.search);
    return {
      leakedParams: ["tab", "space", "page", "surface"].filter((key) => params.has(key)),
      searchMismatches: Object.entries(expectedEntries ?? {})
        .filter(([key, expected]) => params.get(key) !== String(expected))
        .map(([key, expected]) => `${key}=${params.get(key) ?? "<missing>"} (expected ${expected})`),
    };
  }, expectedSearchParams);
  if (leakedParams.length > 0) {
    throw new Error(`legacy redirect left old search params in place: ${leakedParams.join(", ")}`);
  }
  if (searchMismatches.length > 0) {
    throw new Error(`legacy redirect landed with unexpected search params: ${searchMismatches.join(", ")}`);
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

export function getNextCoreNavigationRoutes(verificationTarget) {
  return [
    "chat",
    "projects",
    "library-skills",
    "library-prompt-packs",
    "ops-activity",
    "ops-approvals",
    "ops-kanban",
    "settings-providers",
  ].map((slug) => getVerificationRoute(verificationTarget, slug));
}

export function deriveProviderStatus(payload, { providerConfigured = false } = {}) {
  if (payload?.ok) {
    return "passed";
  }
  const error = String(payload?.error ?? "").toLowerCase();
  // Genuinely absent: no credential is present at all. Reporting these as
  // not_configured is correct (keyless CI has nothing to exercise).
  if (/provider is not configured|missing .*api key|no longer available to new users/.test(error)) {
    return providerConfigured ? "failed" : "not_configured";
  }
  // Configured but rejected: a credential WAS supplied and the provider refused it
  // (bad/expired key, auth error, billing). This must fail the lane rather than
  // being swallowed as not_configured, so every configured-provider break stays visible.
  if (
    /invalid api key|authentication failed|authentication_error|unauthorized|authorized_error|insufficient credits|payment required/.test(
      error,
    )
  ) {
    return "failed";
  }
  if (
    /json_schema|tool_choice|tools are not available|response_format|protocol|invalid request|bad request/.test(error)
  ) {
    return "failed";
  }
  if (/not found|404/.test(error)) {
    return "failed";
  }
  if (/unsupported|not supported|unavailable now/.test(error)) {
    return "degraded";
  }
  return "failed";
}

function assertOk(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} failed (${response?.status ?? "unknown"}): ${JSON.stringify(response?.body ?? null)}`);
  }
}

const ONBOARDING_RECONCILIATION_CONFLICT_MESSAGE =
  "Settings are temporarily unavailable while runtime owners reconcile a config generation.";
const ONBOARDING_RECONCILIATION_ATTEMPTS = 120;
const ONBOARDING_RECONCILIATION_RETRY_MS = 250;

export async function ensureOnboardingComplete(gatewayUrl, completedBy, headers = {}, options = {}) {
  const request = options.requestJson ?? requestJson;
  const wait = options.delay ?? delay;
  const attempts = options.reconciliationAttempts ?? ONBOARDING_RECONCILIATION_ATTEMPTS;
  const retryMs = options.reconciliationRetryMs ?? ONBOARDING_RECONCILIATION_RETRY_MS;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let onboardingStateResponse = await request(gatewayUrl, "/api/v1/onboarding/state", {
      headers,
    });
    if (isOnboardingReconciliationConflict(onboardingStateResponse) && attempt < attempts) {
      await wait(retryMs);
      continue;
    }
    assertOk(onboardingStateResponse, "read onboarding state");
    if (onboardingStateResponse.body?.completed) {
      return onboardingStateResponse.body;
    }

    const completeResponse = await request(gatewayUrl, "/api/v1/onboarding/complete", {
      method: "POST",
      headers,
      body: {
        completedBy,
      },
    });
    if (isOnboardingReconciliationConflict(completeResponse) && attempt < attempts) {
      await wait(retryMs);
      continue;
    }
    assertOk(completeResponse, "complete onboarding");

    onboardingStateResponse = await request(gatewayUrl, "/api/v1/onboarding/state", {
      headers,
    });
    if (isOnboardingReconciliationConflict(onboardingStateResponse) && attempt < attempts) {
      await wait(retryMs);
      continue;
    }
    assertOk(onboardingStateResponse, "re-read onboarding state");
    if (!onboardingStateResponse.body?.completed) {
      throw new Error(
        `verification onboarding completion did not persist: ${JSON.stringify(onboardingStateResponse.body)}`,
      );
    }
    return onboardingStateResponse.body;
  }

  throw new Error("verification onboarding config-generation reconciliation retry budget was exhausted");
}

function isOnboardingReconciliationConflict(response) {
  return (
    response?.status === 409 &&
    response.body?.code === "STATE_CONFLICT" &&
    response.body?.error === ONBOARDING_RECONCILIATION_CONFLICT_MESSAGE
  );
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
  const state = await requestJson(gatewayUrl, "/api/v1/onboarding/state");
  assertOk(state, "read visual regression settings revision");
  const expectedRevision = state.body?.settings?.revision;
  if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
    throw new Error("visual regression settings revision is missing or invalid");
  }
  const response = await requestJson(gatewayUrl, "/api/v1/onboarding/bootstrap", {
    method: "POST",
    body: {
      expectedRevision,
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
  const attempts = typeof options === "number" ? options : (options.attempts ?? 40);
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

async function exerciseCapabilityCandidatePromotionAndRevocation(gatewayUrl, candidateId, label) {
  const initialDetail = await waitForCapabilityCandidate(gatewayUrl, candidateId);
  const initialRevision = requirePositiveRevision(initialDetail.body, `${label} initial detail`);
  const versionId = initialDetail.body?.versions?.[0]?.versionId;
  if (typeof versionId !== "string" || !versionId.trim()) {
    throw new Error(`${label} did not expose a candidate version to review`);
  }

  const promotionRequest = await requestJson(
    gatewayUrl,
    `/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/promote`,
    {
      method: "POST",
      body: { expectedRevision: initialRevision, versionId },
    },
  );
  assertOk(promotionRequest, `request ${label} promotion`);
  const promotionResolution = await resolveCapabilityLifecycleApproval(
    gatewayUrl,
    promotionRequest.body?.pendingApproval,
    `${label} promotion`,
  );
  const promotedDetail = await waitForCapabilityCandidateState(
    gatewayUrl,
    candidateId,
    initialRevision,
    (body) =>
      body?.activeVersion?.versionId === versionId &&
      (body.activeVersion.lifecycleState === "approved" || body.activeVersion.lifecycleState === "trusted") &&
      body.activationBlocked === false,
    `${label} promotion`,
  );
  const promotedRevision = requirePositiveRevision(promotedDetail.body, `${label} promoted detail`);

  const revocationRequest = await requestJson(
    gatewayUrl,
    `/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/revoke`,
    {
      method: "POST",
      body: { expectedRevision: promotedRevision, versionId },
    },
  );
  assertOk(revocationRequest, `request ${label} revocation`);
  const revocationResolution = await resolveCapabilityLifecycleApproval(
    gatewayUrl,
    revocationRequest.body?.pendingApproval,
    `${label} revocation`,
  );
  const revokedDetail = await waitForCapabilityCandidateState(
    gatewayUrl,
    candidateId,
    promotedRevision,
    (body) => {
      const selected = Array.isArray(body?.versions)
        ? body.versions.find((version) => version?.versionId === versionId)
        : undefined;
      return (
        selected?.lifecycleState === "revoked" &&
        body?.activeVersion?.versionId !== versionId &&
        body?.activationBlocked === true
      );
    },
    `${label} revocation`,
  );

  return {
    initialDetail,
    promotionRequest,
    promotionResolution,
    promotedDetail,
    revocationRequest,
    revocationResolution,
    revokedDetail,
  };
}

async function resolveCapabilityLifecycleApproval(gatewayUrl, pendingApproval, label) {
  const approvalId = pendingApproval?.approvalId;
  if (typeof approvalId !== "string" || !approvalId.trim()) {
    throw new Error(`${label} did not return a pending capability.lifecycle approval`);
  }
  const resolved = await requestJson(gatewayUrl, `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
    method: "POST",
    body: {
      decision: "approve",
      resolvedBy: "verification",
      resolutionNote: `${label} verification approval`,
    },
  });
  assertOk(resolved, `resolve ${label} approval`);
  return resolved;
}

async function waitForCapabilityCandidateState(
  gatewayUrl,
  candidateId,
  previousRevision,
  predicate,
  label,
  attempts = 40,
) {
  let latest = null;
  for (let index = 0; index < attempts; index += 1) {
    latest = await requestJson(gatewayUrl, `/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}`);
    assertOk(latest, `read ${label} candidate detail`);
    const revision = requirePositiveRevision(latest.body, `${label} candidate detail`);
    if (revision > previousRevision && predicate(latest.body)) {
      return latest;
    }
    await delay(250);
  }
  throw new Error(`${label} did not apply in time; last candidate detail=${JSON.stringify(latest?.body ?? null)}`);
}

function requirePositiveRevision(value, label) {
  const revision = value?.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`${label} did not return a valid positive revision`);
  }
  return revision;
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
    `durable run ${runId} did not reach one of [${acceptedStatuses.join(", ")}] in time; last status=${latest?.body?.status ?? "unknown"}; last error=${latest?.body?.lastError ?? "none"}`,
  );
}

async function stabilizeVisualRegressionSnapshot(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    for (const element of Array.from(document.querySelectorAll("*"))) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      const canScroll = element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth;
      if (canScroll) {
        element.scrollTop = 0;
        element.scrollLeft = 0;
      }
    }

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
  await page.waitForTimeout(100);
}

async function assertNextVisualScenarioChrome(page, route) {
  if (route?.slug !== "chat-pending-user-input") {
    return;
  }
  const result = await page.evaluate(() => {
    const text = document.body?.textContent ?? "";
    const buttonTexts = Array.from(document.querySelectorAll("button")).map((button) =>
      (button.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    return {
      hasThreadedSurface: Boolean(document.querySelector(".mc-next-threaded-surface")),
      hasContextPanel: Boolean(document.querySelector(".mc-next-threaded-context-panel")),
      hasMobileContextControl: buttonTexts.some((value) => value === "Context" || value.endsWith(" Context")),
      hasWorkingContextCopy: /Working Context|WORKING CONTEXT/.test(text),
      legacyNeedles: ["GOATCITADEL / Mission Control", "New session", "MODE Chat"].filter((needle) =>
        text.includes(needle),
      ),
    };
  });
  if (!result.hasThreadedSurface) {
    throw new Error("chat-pending-user-input rendered outside the Mission Control Next threaded surface");
  }
  if (!result.hasContextPanel && !result.hasMobileContextControl && !result.hasWorkingContextCopy) {
    throw new Error("chat-pending-user-input did not expose the new Working Context surface or mobile control");
  }
  if (result.legacyNeedles.length > 0) {
    throw new Error(`chat-pending-user-input rendered legacy shell copy: ${result.legacyNeedles.join(", ")}`);
  }
}

async function assertNoFooterStatusCollision(page, input = {}) {
  const result = await page.evaluate(() => {
    const primary = document.querySelector(".mc-next-status-strip-primary");
    const details = document.querySelector(".mc-next-status-details");
    if (!primary || !details) {
      return { checked: false };
    }
    const primaryRect = primary.getBoundingClientRect();
    const detailsRect = details.getBoundingClientRect();
    const primaryVisible = primaryRect.width > 0 && primaryRect.height > 0;
    const detailsVisible = detailsRect.width > 0 && detailsRect.height > 0;
    if (!primaryVisible || !detailsVisible) {
      return { checked: false };
    }
    const overlapWidth = Math.max(
      0,
      Math.min(primaryRect.right, detailsRect.right) - Math.max(primaryRect.left, detailsRect.left),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(primaryRect.bottom, detailsRect.bottom) - Math.max(primaryRect.top, detailsRect.top),
    );
    return {
      checked: true,
      overlapArea: overlapWidth * overlapHeight,
      primary: {
        bottom: primaryRect.bottom,
        left: primaryRect.left,
        right: primaryRect.right,
        top: primaryRect.top,
      },
      details: {
        bottom: detailsRect.bottom,
        left: detailsRect.left,
        right: detailsRect.right,
        top: detailsRect.top,
      },
    };
  });
  if (!result.checked || result.overlapArea <= 1) {
    return;
  }
  const routeSlug = input.route?.slug ?? "unknown-route";
  const variantSlug = input.variant?.slug ?? "unknown-variant";
  throw new Error(
    `footer status collision detected for ${routeSlug}/${variantSlug}: primary=${JSON.stringify(
      result.primary,
    )} details=${JSON.stringify(result.details)}`,
  );
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
          thread?.turns?.find?.((turn) => turn.turnId === (thread.selectedTurnId ?? thread.activeLeafTurnId)) ??
          thread?.turns?.at?.(-1);
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

async function seedMissionControlNextFixture(gatewayUrl, options = {}) {
  return await seedMissionControlNextFixtureImpl(gatewayUrl, options, verificationLaneDeps());
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

async function installMissionControlNextBrowserState(browserContext, workspaceId, citadelId = "personal") {
  await browserContext.addInitScript(
    ({ activeWorkspaceId, activeCitadelId }) => {
      window.localStorage.setItem("goatcitadel.ui.workspace_id.v1", activeWorkspaceId);
      window.localStorage.setItem("goatcitadel.ui.citadel_id.v1", activeCitadelId);
      window.localStorage.setItem("goatcitadel.ui.mode.v1", "simple");
      window.localStorage.setItem("goatcitadel.ui.technical_details.v1", "false");
    },
    { activeWorkspaceId: workspaceId, activeCitadelId: citadelId },
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
  try {
    await waitForHttp(uiUrl, `${packageName} UI`, 180000, handle);
  } catch (error) {
    // A UI that never serves (build failure, or a vite dev server that starts
    // but never answers) must not leak its process: stop it before propagating
    // so callers that treat "no UI-served environment" as a conditional skip
    // (runtime-truth) do not leave a lingering port-holding server behind.
    await stopProcess(handle).catch(() => undefined);
    throw error;
  }
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
    "device-session-exchange": [{ method: "POST", url: "/api/v1/auth/companion/session/exchange" }],
    "session-control-companion": [{ method: "POST", url: "/api/v1/chat/sessions/:sessionId/control/requests" }],
    "operator-or-companion": [{ method: "GET", url: "/api/v1/approvals" }],
    // Pinned to the plain JSON read; this class also carries an SSE route
    // (.../control/events/stream) that the generic JSON probe cannot exercise.
    "operator-or-session-control-companion": [{ method: "GET", url: "/api/v1/chat/sessions/:sessionId/messages" }],
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
    case "device-session-exchange":
      return {
        unauthenticated: false,
        badToken: false,
        operator: false,
        device: true,
        companion: false,
      };
    case "session-control-companion":
      // Requires a purpose-bound (session_control_client) companion with a bound
      // session, which none of the standard callers is — the matrix proves the
      // class is closed to generic authority; the allow side is proven by
      // verify:session-control with signed companion requests.
      return {
        unauthenticated: false,
        badToken: false,
        operator: false,
        device: false,
        companion: false,
      };
    case "operator-or-session-control-companion":
      return {
        unauthenticated: false,
        badToken: false,
        operator: true,
        device: false,
        companion: false,
      };
    case "operator-or-companion":
      return {
        unauthenticated: false,
        badToken: false,
        operator: true,
        device: false,
        companion: true,
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
  if (url.includes(":sessionId") && credentials.seededSessionId) {
    url = url.replace(":sessionId", encodeURIComponent(credentials.seededSessionId));
  }

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

async function collectUiParitySurface({
  page,
  baseUrl,
  href,
  route,
  packageName,
  correlationId,
  sessionId,
  needle,
  absentNeedle,
}) {
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
    absentNeedle,
    absentNeedleVisible: absentNeedle ? preview.includes(absentNeedle) : false,
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
        const artifactSlug = "surface-regression-mobile-chat-shell";
        const trace = await startBrowserTrace(context, { page, slug: artifactSlug });
        let artifacts;
        try {
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
          const buildIdentityChip = page.locator('[data-shell-identity-anchor="pinned"] .mc-next-status-pill').first();
          await assertLocatorFullyVisible(page, buildIdentityChip, "pinned mobile build identity");
          const identityScreenshotPath = path.join(
            context.artifactRoot,
            "screenshots",
            `${artifactSlug}-build-identity.png`,
          );
          await fs.mkdir(path.dirname(identityScreenshotPath), { recursive: true });
          await page.screenshot({ path: identityScreenshotPath, fullPage: false });
          const menuButton = page.locator(".mc-next-nav-toggle").first();
          await assertLocatorFullyVisible(page, menuButton, "mobile menu toggle");
          await menuButton.click();
          await page.waitForSelector(".mc-next-rail.open", { timeout: 15000 });
          const { railCloseButton } = await exerciseMissionControlNextMobileRail(page);
          const drawerScreenshotPath = path.join(
            context.artifactRoot,
            "screenshots",
            `${artifactSlug}-navigation-drawer.png`,
          );
          await fs.mkdir(path.dirname(drawerScreenshotPath), { recursive: true });
          await page.screenshot({ path: drawerScreenshotPath, fullPage: false });
          await railCloseButton.click();
          await page.waitForFunction(() => !document.querySelector(".mc-next-rail.open"), { timeout: 15000 });
          await openMissionControlNextThreadedContext(page);
          await assertNoHorizontalOverflow(page, "mobile chat shell with threaded context");
          const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, input.packageName);
          artifacts = await captureBrowserArtifacts(context, {
            slug: artifactSlug,
            page,
            browserLog,
            gatewayUrl: input.gatewayUrl,
            correlationId,
            logCursor: browserLogCursor,
          });
          artifacts.screenshots = [
            relativeToRun(context, identityScreenshotPath),
            relativeToRun(context, drawerScreenshotPath),
            ...(artifacts.screenshots ?? []),
          ];
          return {
            status: "passed",
            metrics: {
              consoleErrors: browserSanity.consoleErrors.length,
              pageErrors: browserSanity.pageErrors.length,
            },
            artifacts,
          };
        } catch (error) {
          artifacts ??= await captureBrowserArtifacts(context, {
            slug: `${artifactSlug}-failure`,
            page,
            browserLog,
            gatewayUrl: input.gatewayUrl,
            correlationId,
            logCursor: browserLogCursor,
          });
          const traceArtifact = await trace.retain().catch(() => null);
          return {
            status: "failed",
            error: formatBrowserScenarioFailure(error),
            metrics: {},
            artifacts: appendTraceArtifact(artifacts, traceArtifact),
          };
        } finally {
          await trace.discard().catch(() => undefined);
        }
      },
    );

    await runScenario(
      context,
      {
        id: "surface-regression.mobile.ops-kanban",
        lane: "surface-regression",
        title: "Mission Control Next mobile task board avoids overflow and clipped primary actions",
        subsystem: "mission-control",
      },
      async ({ correlationId }) => {
        const browserLogCursor = browserLog.mark();
        const artifactSlug = "surface-regression-mobile-ops-kanban";
        const trace = await startBrowserTrace(context, { page, slug: artifactSlug });
        let artifacts;
        try {
          await page.goto(buildVerificationUiUrl(input.uiUrl, "/ops/kanban"), { waitUntil: "domcontentloaded" });
          await waitForVerificationRouteReady(
            page,
            { expectedArea: "ops", expectedSection: "kanban", readySelector: ".mc-next-kanban-board" },
            input.packageName,
          );
          await setBrowserCorrelation(page, correlationId, input.sessionId);
          await assertNoHorizontalOverflow(page, "mobile ops kanban");
          const primaryTaskAction = page.locator(".mc-next-kanban-board button, .mc-next-kanban-column").first();
          await assertLocatorFullyVisible(page, primaryTaskAction, "task board primary action");
          await performVerificationInteraction(page, "open-inspector", input.packageName);
          await assertNoHorizontalOverflow(page, "mobile ops kanban with inspector");
          const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, input.packageName);
          artifacts = await captureBrowserArtifacts(context, {
            slug: artifactSlug,
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
        } catch (error) {
          artifacts ??= await captureBrowserArtifacts(context, {
            slug: `${artifactSlug}-failure`,
            page,
            browserLog,
            gatewayUrl: input.gatewayUrl,
            correlationId,
            logCursor: browserLogCursor,
          });
          const traceArtifact = await trace.retain().catch(() => null);
          return {
            status: "failed",
            error: formatBrowserScenarioFailure(error),
            metrics: {},
            artifacts: appendTraceArtifact(artifacts, traceArtifact),
          };
        } finally {
          await trace.discard().catch(() => undefined);
        }
      },
    );

    await runScenario(
      context,
      {
        id: "surface-regression.mobile.native-stage-scroll",
        lane: "surface-regression",
        title: "Mission Control Next mobile native routes reach their final content without overflow",
        subsystem: "mission-control",
      },
      async ({ correlationId }) => {
        const browserLogCursor = browserLog.mark();
        const artifactSlug = "surface-regression-mobile-native-stage-scroll";
        const trace = await startBrowserTrace(context, { page, slug: artifactSlug });
        let artifacts;
        const routes = [
          {
            slug: "settings-providers",
            href: "/settings/providers",
            expectedArea: "settings",
            expectedSection: "providers",
            readyText: "Providers",
          },
          {
            slug: "ops-runtime",
            href: "/ops/runtime",
            expectedArea: "ops",
            expectedSection: "runtime",
            readyText: "Runtime authority map",
          },
          {
            slug: "projects",
            href: "/projects",
            expectedArea: "projects",
            expectedSection: "root",
            readyText: "Project containers",
          },
          {
            slug: "library-memory",
            href: "/library/memory",
            expectedArea: "library",
            expectedSection: "memory",
            readyText: "Mission Control Next shell posture",
          },
        ];
        try {
          const routeMetrics = [];
          for (const route of routes) {
            await page.goto(buildVerificationUiUrl(input.uiUrl, route.href), { waitUntil: "domcontentloaded" });
            await waitForVerificationRouteReady(page, route, input.packageName);
            await setBrowserCorrelation(page, correlationId, input.sessionId);
            await assertNoHorizontalOverflow(page, `mobile ${route.slug}`);
            routeMetrics.push({
              route: route.href,
              ...(await assertNativeStageScrollContract(page, { label: `mobile ${route.slug}` })),
            });
          }
          const browserSanity = assertBrowserConsoleHealthy(browserLog, browserLogCursor, input.packageName);
          artifacts = await captureBrowserArtifacts(context, {
            slug: artifactSlug,
            page,
            browserLog,
            gatewayUrl: input.gatewayUrl,
            correlationId,
            logCursor: browserLogCursor,
          });
          return {
            status: "passed",
            metrics: {
              routes: routeMetrics,
              consoleErrors: browserSanity.consoleErrors.length,
              pageErrors: browserSanity.pageErrors.length,
            },
            artifacts,
          };
        } catch (error) {
          artifacts ??= await captureBrowserArtifacts(context, {
            slug: `${artifactSlug}-failure`,
            page,
            browserLog,
            gatewayUrl: input.gatewayUrl,
            correlationId,
            logCursor: browserLogCursor,
          });
          const traceArtifact = await trace.retain().catch(() => null);
          return {
            status: "failed",
            error: formatBrowserScenarioFailure(error),
            metrics: {},
            artifacts: appendTraceArtifact(artifacts, traceArtifact),
          };
        } finally {
          await trace.discard().catch(() => undefined);
        }
      },
    );
  } finally {
    await browserContext.close();
  }
}

function formatBrowserScenarioFailure(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export async function openMissionControlNextThreadedContext(page) {
  const routeDetailsControl = page.getByRole("button", { name: /^(Open|Hide) Route details$/i });
  const shellInspector = page.locator(".mc-next-shell-inspector");
  if ((await routeDetailsControl.count()) > 0 || (await shellInspector.count()) > 0) {
    throw new Error("mobile Chat exposed the generic Route details inspector instead of threaded Working Context");
  }

  const contextButton = page
    .locator(".mc-next-threaded-mobile-bar .mc-next-threaded-menu-button")
    .filter({ hasText: /^(Context|Hide context)$/i })
    .first();
  await assertLocatorFullyVisible(page, contextButton, "mobile threaded context button");
  const contextPanel = page.locator('.mc-next-threaded-context-panel[aria-label="Thread context drawer"]').first();
  if (!(await contextPanel.isVisible().catch(() => false))) {
    await contextButton.click();
  }
  await contextPanel.waitFor({ state: "visible", timeout: 15000 });
  await page
    .locator(".mc-next-threaded-context-panel .mc-next-context-drawer")
    .filter({ hasText: /Working Context/i })
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
}

export async function exerciseMissionControlNextMobileRail(page) {
  const rail = page.locator(".mc-next-rail.open").first();
  await rail.waitFor({ state: "visible", timeout: 15000 });
  await assertLocatorFullyVisible(page, rail, "mobile navigation drawer");

  const activeCitadel = page.getByRole("combobox", { name: "Active Citadel" }).first();
  const activeWorkspace = page.getByRole("combobox", { name: "Active Workspace" }).first();
  const commandPaletteButton = page.getByRole("button", { name: "Open Command Palette" }).first();
  await assertLocatorFullyVisible(page, activeCitadel, "mobile Active Citadel control");
  await assertLocatorFullyVisible(page, activeWorkspace, "mobile Active Workspace control");
  await assertLocatorFullyVisible(page, commandPaletteButton, "mobile Command Palette control");

  await commandPaletteButton.click();
  await page.waitForFunction(() => !document.querySelector(".mc-next-rail.open"), { timeout: 15000 });
  const paletteDialog = page.getByRole("dialog", { name: /Command Palette/i }).first();
  await assertLocatorFullyVisible(page, paletteDialog, "mobile Command Palette dialog");
  await page.keyboard.press("Escape");
  await paletteDialog.waitFor({ state: "hidden", timeout: 15000 });

  const menuButton = page.getByRole("button", { name: "Open navigation" }).first();
  await assertLocatorFullyVisible(page, menuButton, "mobile menu toggle after palette close");
  await menuButton.click();
  await rail.waitFor({ state: "visible", timeout: 15000 });
  await assertLocatorFullyVisible(page, rail, "mobile navigation drawer after palette close");
  const railCloseButton = page.getByRole("button", { name: "Close navigation" }).first();
  await assertLocatorFullyVisible(page, railCloseButton, "mobile rail close button");
  return { railCloseButton };
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
    "- Confirm Route details opens on non-Chat routes and Chat opens its threaded Working Context cleanly.",
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
  const routes = resolveVisualRegressionManifest();
  const variants = resolveVisualRegressionVariants();
  const baselineDir = resolveVisualBaselineDir(packageName);
  const expectedFiles = routes.flatMap((route) =>
    variants.map((variant) => buildVisualBaselineFileName(route.slug, variant.slug)),
  );
  const coverage = await collectVisualBaselineCoverage(baselineDir, expectedFiles);
  if (coverage.missingFiles.length === 0 && coverage.unexpectedFiles.length === 0) {
    return;
  }
  const diagnosticsPath = path.join(context.artifactRoot, "diagnostics", "visual-baseline-coverage.json");
  await writeJson(diagnosticsPath, coverage);
  const problems = [
    coverage.missingFiles.length > 0 ? `missing: ${coverage.missingFiles.join(", ")}` : null,
    coverage.unexpectedFiles.length > 0 ? `unexpected: ${coverage.unexpectedFiles.join(", ")}` : null,
  ].filter(Boolean);
  throw new Error(`visual baseline coverage does not match the canonical manifest (${problems.join("; ")})`);
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
