#!/usr/bin/env node
import path from "node:path";
import { generateVerificationReview, loadManifestForReview, validateExplicitReviewTarget } from "./lib/review.mjs";
import { collectVerificationSecretEnvKeys } from "./lib/scenarios/usability-coverage.mjs";
import { runJourneysLane } from "./lib/scenarios/journeys-lane.mjs";
import { runUsabilityDiskCapacityPreflight } from "./lib/scenarios/usability-disk-preflight.mjs";
import {
  beginUsabilitySourceGuard,
  combineUsabilityPrimaryAndIntegrityErrors,
  completeUsabilityFinalIntegrity,
} from "./lib/scenarios/usability-final-integrity.mjs";
import { assertNamedScenarioProofs } from "./lib/scenario-artifact-evidence.mjs";
import {
  runArchitectureMetricsLane,
  runAgenticChannelsRuntimeLane,
  runAgenticChatFanoutLane,
  runAgenticContractsLane,
  runAgenticGovernanceLane,
  runAgenticHarnessAvailabilityLane,
  runAgenticHarnessesLane,
  runAgenticMcpOAuthLane,
  runAgenticPluginsMarketplaceLane,
  runAgenticSelfImprovementTrustLane,
  runAgenticWorkbenchLoopLane,
  runAccessibilitySmokeLane,
  runA2AFullLane,
  runAuthMatrixLane,
  runApiCompatibilityLane,
  runBackupRoundtripLane,
  runCatalogParityLane,
  runCodeModeHostileSandboxLane,
  runCodeModeSandboxRequiredLane,
  runDeepCoreLane,
  runDeepEcosystemLane,
  runDesktopLane,
  runDurableRecoveryLane,
  runSelfConfigurationLane,
  runChatEvolutionLane,
  runUsageReconciliationLane,
  runRoutedContextSnapshotsLane,
  runModelCouncilLane,
  runSkillLearningLane,
  runSessionControlLane,
  runReasoningProfilesLane,
  runVertexFireworksProvidersLane,
  FAST_LANE_COMMANDS,
  runFastLane,
  runExtensionsPackageLane,
  runSkillsCatalogLane,
  runMemoryTruthLane,
  runMeshReadinessLane,
  runOperatorProofLane,
  runOrchestrationPerformanceLane,
  runRealtimeTruthLane,
  runRuntimeTruthLane,
  runSecurityEvalsLane,
  runVisualRegressionLane,
  runSurfaceRegressionLane,
  runSoakLane,
  runUiParityLane,
  runUsabilityCoreLane,
  runUsabilityLane,
} from "./lib/scenarios.mjs";
import {
  artifactsRoot,
  createRunContext,
  finalizeRunContext,
  maybeParseBool,
  maybeParseInt,
  parseCliArgs,
  parseLatestRunPointer,
  readJson as readRunJson,
  repoRoot,
} from "./lib/shared.mjs";
import { acquireWorktreeOutputLock } from "../lib/worktree-output-lock.mjs";

const VALID_LANES = new Set([
  "fast",
  "journeys",
  "desktop",
  "extensions-package",
  "orchestration-performance",
  "a2a-full",
  "deep-core",
  "deep-ecosystem",
  "catalog-parity",
  "skills-catalog",
  "security-evals",
  "api-compat",
  "operator-proof",
  "durable-recovery",
  "self-configuration",
  "chat-evolution",
  "usage-reconciliation",
  "routed-context-snapshots",
  "model-council",
  "skill-learning",
  "session-control",
  "providers-vertex-fireworks",
  "reasoning-profiles",
  "usability",
  "usability-core",
  "accessibility-smoke",
  "surface-regression",
  "visual-regression",
  "visual-rebaseline",
  "backup-roundtrip",
  "soak",
  "runtime-truth",
  "auth-matrix",
  "ui-parity",
  "memory-truth",
  "realtime-truth",
  "architecture-metrics",
  "code-mode-sandbox",
  "code-mode-hostile-sandbox",
  "mesh-readiness",
  "agentic-contracts",
  "agentic-governance",
  "agentic-harnesses",
  "agentic-mcp-oauth",
  "agentic-workbench-loop",
  "agentic-channels-runtime",
  "agentic-harness-availability",
  "agentic-plugins-marketplace",
  "agentic-self-improvement-trust",
  "agentic-proof",
  "agentic-parity",
  "review",
  "all",
]);

const DIRECT_BROWSER_SECRET_SCRUB_LANES = new Set([
  "accessibility-smoke",
  "surface-regression",
  "visual-regression",
  "visual-rebaseline",
  "all",
]);

const USABILITY_FAST_EVIDENCE_COMMAND_IDS = Object.freeze(
  FAST_LANE_COMMANDS.map((command) => command.id).filter(
    (id) =>
      id.startsWith("fast.test.gateway.") ||
      id === "fast.test.storage" ||
      id === "fast.test.mission-control-next" ||
      id === "fast.test.policy-engine" ||
      id === "fast.test.libraries",
  ),
);

const REVIEW_LANES = new Set([
  "desktop",
  "extensions-package",
  "orchestration-performance",
  "deep-core",
  "deep-ecosystem",
  "catalog-parity",
  "skills-catalog",
  "security-evals",
  "api-compat",
  "a2a-full",
  "operator-proof",
  "durable-recovery",
  "self-configuration",
  "chat-evolution",
  "usage-reconciliation",
  "routed-context-snapshots",
  "model-council",
  "skill-learning",
  "session-control",
  "providers-vertex-fireworks",
  "reasoning-profiles",
  "usability",
  "usability-core",
  "accessibility-smoke",
  "surface-regression",
  "visual-regression",
  "visual-rebaseline",
  "backup-roundtrip",
  "runtime-truth",
  "auth-matrix",
  "ui-parity",
  "memory-truth",
  "realtime-truth",
  "architecture-metrics",
  "code-mode-sandbox",
  "code-mode-hostile-sandbox",
  "mesh-readiness",
  "agentic-contracts",
  "agentic-governance",
  "agentic-harnesses",
  "agentic-workbench-loop",
  "agentic-channels-runtime",
  "agentic-harness-availability",
  "agentic-plugins-marketplace",
  "agentic-self-improvement-trust",
  "agentic-proof",
  "agentic-parity",
  "all",
  "soak",
]);

async function main() {
  const { positional, options } = parseCliArgs(process.argv.slice(2));
  const lane = positional[0] ?? "fast";
  if (!VALID_LANES.has(lane)) {
    throw new Error(`Unknown verification lane: ${lane}`);
  }
  const outputLockLease = await acquireWorktreeOutputLock({
    repoRoot,
    owner: `verification:${lane}`,
  });
  try {
    await runLockedVerification(lane, options);
  } finally {
    await outputLockLease.release();
  }
}

async function runLockedVerification(lane, options) {
  const requestedUiPackage = typeof options["ui-package"] === "string" ? options["ui-package"].trim() : "";
  if (requestedUiPackage) {
    process.env.GOATCITADEL_UI_PACKAGE = requestedUiPackage;
  }

  if (lane === "review") {
    const latestPointer = parseLatestRunPointer(await readRunJson(path.join(artifactsRoot, "latest-run.json")));
    const context = {
      artifactRoot: latestPointer.artifactRoot,
      runId: latestPointer.runId,
    };
    const manifest = await loadManifestForReview(context.artifactRoot);
    validateExplicitReviewTarget({
      artifactRoot: context.artifactRoot,
      latestPointer,
      manifest,
      expectedRunId: options["run-id"] ?? process.env.GOATCITADEL_VERIFY_REVIEW_RUN_ID,
      expectedLane: options["expected-lane"] ?? process.env.GOATCITADEL_VERIFY_REVIEW_EXPECTED_LANE,
      startedAfter: options["started-after"] ?? process.env.GOATCITADEL_VERIFY_REVIEW_STARTED_AFTER,
    });
    await generateVerificationReview(context, {
      manifest,
      reviewGatewayUrl: options["review-gateway-url"],
    });
    console.log(`Verification review written to ${context.artifactRoot}`);
    return;
  }

  const profile = String(options.profile ?? process.env.GOATCITADEL_VERIFY_PROFILE ?? "local");
  const durationMs = maybeParseInt(options["duration-ms"] ?? process.env.GOATCITADEL_VERIFY_DURATION_MS, undefined);
  const includeSoak = maybeParseBool(options["include-soak"] ?? process.env.GOATCITADEL_VERIFY_INCLUDE_SOAK, false);
  const fastOptions = {
    failFast: maybeParseBool(options["fail-fast"] ?? process.env.GOATCITADEL_VERIFY_FAIL_FAST, false),
    serial: maybeParseBool(options.serial ?? process.env.GOATCITADEL_VERIFY_SERIAL, false),
    // `--commands=fast.test.gateway,fast.build` runs one slice of the lane so CI can
    // spread the lane across parallel jobs. Each slice writes its own partial
    // manifest; merge-fast-manifests.mjs recomposes them into one run.
    commands: typeof options.commands === "string" ? options.commands : undefined,
  };
  const context = await createRunContext(lane, {
    runId: typeof options["run-id"] === "string" ? options["run-id"] : undefined,
    profile,
    includeSoak,
    durationMs,
    commandSelection: lane === "fast" ? fastOptions.commands : undefined,
  });

  let manifest;
  let usabilitySourceState;
  try {
    const directBrowserSecretEnvKeys = DIRECT_BROWSER_SECRET_SCRUB_LANES.has(lane)
      ? await collectVerificationSecretEnvKeys(path.join(repoRoot, "config"))
      : undefined;
    if (lane === "usability" || lane === "all") {
      usabilitySourceState = beginUsabilitySourceGuard(repoRoot, process.env.GOATCITADEL_USABILITY_SOURCE_MODE);
    }
    if (lane === "fast") {
      await runFastLane(context, fastOptions);
    } else if (lane === "desktop") {
      await runDesktopLane(context);
    } else if (lane === "extensions-package") {
      await runExtensionsPackageLane(context);
    } else if (lane === "orchestration-performance") {
      await runOrchestrationPerformanceLane(context);
    } else if (lane === "a2a-full") {
      await runA2AFullLane(context);
    } else if (lane === "deep-core") {
      await runDeepCoreLane(context, { profile });
    } else if (lane === "deep-ecosystem") {
      await runDeepEcosystemLane(context, { profile });
    } else if (lane === "catalog-parity") {
      await runCatalogParityLane(context, { profile });
    } else if (lane === "skills-catalog") {
      await runSkillsCatalogLane(context);
    } else if (lane === "security-evals") {
      await runSecurityEvalsLane(context);
    } else if (lane === "api-compat") {
      await runApiCompatibilityLane(context, { profile });
    } else if (lane === "operator-proof") {
      await runOperatorProofLane(context, { profile });
    } else if (lane === "durable-recovery") {
      await runDurableRecoveryLane(context, { profile });
    } else if (lane === "self-configuration") {
      await runSelfConfigurationLane(context, { profile });
    } else if (lane === "chat-evolution") {
      await runChatEvolutionLane(context, { profile });
    } else if (lane === "usage-reconciliation") {
      await runUsageReconciliationLane(context, { profile });
    } else if (lane === "routed-context-snapshots") {
      await runRoutedContextSnapshotsLane(context, { profile });
    } else if (lane === "model-council") {
      await runModelCouncilLane(context, { profile });
    } else if (lane === "skill-learning") {
      await runSkillLearningLane(context, { profile });
    } else if (lane === "session-control") {
      await runSessionControlLane(context, { profile });
    } else if (lane === "providers-vertex-fireworks") {
      await runVertexFireworksProvidersLane(context, { profile });
    } else if (lane === "reasoning-profiles") {
      await runReasoningProfilesLane(context, { profile });
    } else if (lane === "usability") {
      await runUsabilityDiskCapacityPreflight(context, { repoRoot });
      const scrubbedSecretEnvKeys = await collectVerificationSecretEnvKeys(path.join(repoRoot, "config"));
      for (const key of scrubbedSecretEnvKeys) delete process.env[key];
      const evidenceStartIndex = context.manifest.scenarios.length;
      await runFastLane(context, {
        ...fastOptions,
        failFast: true,
        serial: true,
        commands: USABILITY_FAST_EVIDENCE_COMMAND_IDS.join(","),
      });
      assertScenarioSlicePassed(context, evidenceStartIndex, "usability focused regression prerequisites");
      const authStartIndex = context.manifest.scenarios.length;
      await runAuthMatrixLane(context, { profile });
      assertScenarioSlicePassed(context, authStartIndex, "usability authentication foundations");
      await runBackupRoundtripLane(context, { profile });
      await runRuntimeTruthLane(context, { profile });
      await runRealtimeTruthLane(context, { profile });
      assertNamedScenarioProofs(
        context,
        [
          "backup-roundtrip.runtime.config-restore",
          "runtime-truth.approval-restart-durable-truth",
          "realtime-truth.disconnect-reconnect-resubscribe",
        ],
        "usability isolated restart, backup, and realtime-reconnect foundations",
      );
      await runUsabilityLane(context, { profile, sourceState: usabilitySourceState });
    } else if (lane === "usability-core") {
      const scrubbedSecretEnvKeys = await collectVerificationSecretEnvKeys(path.join(repoRoot, "config"));
      for (const key of scrubbedSecretEnvKeys) delete process.env[key];
      await runUsabilityCoreLane(context, { profile });
    } else if (lane === "accessibility-smoke") {
      await runAccessibilitySmokeLane(context, { profile, secretEnvKeys: directBrowserSecretEnvKeys });
    } else if (lane === "surface-regression") {
      await runSurfaceRegressionLane(context, { profile, secretEnvKeys: directBrowserSecretEnvKeys });
    } else if (lane === "visual-regression") {
      await runVisualRegressionLane(context, {
        profile,
        updateBaselines: false,
        secretEnvKeys: directBrowserSecretEnvKeys,
      });
    } else if (lane === "visual-rebaseline") {
      await runVisualRegressionLane(context, {
        profile,
        updateBaselines: true,
        secretEnvKeys: directBrowserSecretEnvKeys,
      });
    } else if (lane === "backup-roundtrip") {
      await runBackupRoundtripLane(context, { profile });
    } else if (lane === "soak") {
      await runSoakLane(context, { durationMs });
    } else if (lane === "runtime-truth") {
      await runRuntimeTruthLane(context, { profile });
    } else if (lane === "auth-matrix") {
      await runAuthMatrixLane(context, { profile });
    } else if (lane === "ui-parity") {
      await runUiParityLane(context, { profile });
    } else if (lane === "memory-truth") {
      await runMemoryTruthLane(context, { profile });
    } else if (lane === "realtime-truth") {
      await runRealtimeTruthLane(context, { profile });
    } else if (lane === "journeys") {
      await runJourneysLane(context);
    } else if (lane === "architecture-metrics") {
      await runArchitectureMetricsLane(context);
    } else if (lane === "code-mode-sandbox") {
      await runCodeModeSandboxRequiredLane(context);
    } else if (lane === "code-mode-hostile-sandbox") {
      await runCodeModeHostileSandboxLane(context);
    } else if (lane === "mesh-readiness") {
      await runMeshReadinessLane(context, { profile });
    } else if (lane === "agentic-contracts") {
      await runAgenticContractsLane(context);
    } else if (lane === "agentic-governance") {
      await runAgenticGovernanceLane(context);
    } else if (lane === "agentic-harnesses") {
      await runAgenticHarnessesLane(context);
    } else if (lane === "agentic-mcp-oauth") {
      await runAgenticMcpOAuthLane(context);
    } else if (lane === "agentic-workbench-loop") {
      await runAgenticWorkbenchLoopLane(context);
    } else if (lane === "agentic-channels-runtime") {
      await runAgenticChannelsRuntimeLane(context);
    } else if (lane === "agentic-harness-availability") {
      await runAgenticHarnessAvailabilityLane(context);
    } else if (lane === "agentic-plugins-marketplace") {
      await runAgenticPluginsMarketplaceLane(context);
    } else if (lane === "agentic-self-improvement-trust") {
      await runAgenticSelfImprovementTrustLane(context);
    } else if (lane === "agentic-proof" || lane === "agentic-parity") {
      await runAgenticProofSuite(context);
      await runOrchestrationPerformanceLane(context);
    } else if (lane === "all") {
      await runFastLane(context, fastOptions);
      await runCodeModeSandboxRequiredLane(context);
      await runCodeModeHostileSandboxLane(context);
      await runMeshReadinessLane(context, { profile });
      await runAgenticProofSuite(context);
      await runOrchestrationPerformanceLane(context);
      await runDeepCoreLane(context, { profile });
      await runDeepEcosystemLane(context, { profile });
      await runCatalogParityLane(context, { profile });
      await runSkillsCatalogLane(context);
      await runSecurityEvalsLane(context);
      await runApiCompatibilityLane(context, { profile });
      await runA2AFullLane(context);
      await runOperatorProofLane(context, { profile });
      await runDurableRecoveryLane(context, { profile });
      await runUsageReconciliationLane(context, { profile });
      // "all" means every registered lane: these were silently missing, so a
      // green `verify:all` under-reported the verified surface.
      await runExtensionsPackageLane(context);
      await runRoutedContextSnapshotsLane(context, { profile });
      await runModelCouncilLane(context, { profile });
      await runSkillLearningLane(context, { profile });
      await runSessionControlLane(context, { profile });
      await runVertexFireworksProvidersLane(context, { profile });
      await runReasoningProfilesLane(context, { profile });
      await runDesktopLane(context);
      await runVisualRegressionLane(context, {
        profile,
        updateBaselines: false,
        secretEnvKeys: directBrowserSecretEnvKeys,
      });
      await runBackupRoundtripLane(context, { profile });
      await runRuntimeTruthLane(context, { profile });
      await runAuthMatrixLane(context, { profile });
      await runUiParityLane(context, { profile });
      await runMemoryTruthLane(context, { profile });
      await runRealtimeTruthLane(context, { profile });
      await runArchitectureMetricsLane(context);
      // Usability runs last because its route/action ledger joins exact
      // evidence scenarios produced by the broader campaign. It composes the
      // surface and accessibility browser passes so `all` executes each once.
      await runUsabilityLane(context, { profile, sourceState: usabilitySourceState });
      if (includeSoak) {
        await runSoakLane(context, { durationMs });
      }
    }

    manifest = await finalizeRunContext(context);
    if (shouldGenerateReview(lane)) {
      await generateVerificationReview(context, {
        manifest,
        reviewGatewayUrl: options["review-gateway-url"],
      });
    }
    if (usabilitySourceState) {
      await completeUsabilityFinalIntegrity(context, usabilitySourceState, { repoRoot });
    }
  } catch (error) {
    manifest = await finalizeRunContext(context, "failed");
    if (shouldGenerateReview(lane)) {
      await generateVerificationReview(context, {
        manifest,
        reviewGatewayUrl: options["review-gateway-url"],
      }).catch(() => undefined);
    }
    if (usabilitySourceState) {
      try {
        // Failed runs retain the richest traces and logs, so they must pass the
        // same exact-root leakage scan and completion source check after their
        // failed manifest and best-effort review are durable.
        await completeUsabilityFinalIntegrity(context, usabilitySourceState, { repoRoot });
      } catch (integrityError) {
        throw combineUsabilityPrimaryAndIntegrityErrors(error, integrityError);
      }
    }
    throw error;
  }

  console.log(`Verification run completed: ${context.artifactRoot}`);
  console.log(`Status: ${manifest.status}`);
  if (manifest.status === "failed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

function assertScenarioSlicePassed(context, startIndex, label) {
  const scenarios = context.manifest.scenarios.slice(startIndex);
  const failed = scenarios.filter((scenario) => scenario.status !== "passed");
  if (scenarios.length === 0) throw new Error(`${label} produced no scenarios`);
  if (failed.length > 0) {
    throw new Error(`${label} failed: ${failed.map((scenario) => scenario.id).join(", ")}`);
  }
}

function shouldGenerateReview(lane) {
  return REVIEW_LANES.has(lane);
}

async function runAgenticProofSuite(context) {
  await runAgenticContractsLane(context);
  await runAgenticGovernanceLane(context);
  await runAgenticChatFanoutLane(context);
  await runAgenticMcpOAuthLane(context);
  await runAgenticHarnessesLane(context);
  await runAgenticWorkbenchLoopLane(context);
  await runAgenticChannelsRuntimeLane(context);
  await runAgenticHarnessAvailabilityLane(context);
  await runAgenticPluginsMarketplaceLane(context);
  await runAgenticSelfImprovementTrustLane(context);
}
