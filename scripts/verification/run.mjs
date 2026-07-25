#!/usr/bin/env node
import path from "node:path";
import { generateVerificationReview, loadManifestForReview } from "./lib/review.mjs";
import {
  runArchitectureMetricsLane,
  runAgenticChannelsRuntimeLane,
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
  runUsageReconciliationLane,
  runRoutedContextSnapshotsLane,
  runModelCouncilLane,
  runSkillLearningLane,
  runSessionControlLane,
  runReasoningProfilesLane,
  runVertexFireworksProvidersLane,
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
} from "./lib/shared.mjs";

const VALID_LANES = new Set([
  "fast",
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
  "usage-reconciliation",
  "routed-context-snapshots",
  "model-council",
  "skill-learning",
  "session-control",
  "providers-vertex-fireworks",
  "reasoning-profiles",
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
  "usage-reconciliation",
  "routed-context-snapshots",
  "model-council",
  "skill-learning",
  "session-control",
  "providers-vertex-fireworks",
  "reasoning-profiles",
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
  try {
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
    } else if (lane === "accessibility-smoke") {
      await runAccessibilitySmokeLane(context, { profile });
    } else if (lane === "surface-regression") {
      await runSurfaceRegressionLane(context, { profile });
    } else if (lane === "visual-regression") {
      await runVisualRegressionLane(context, { profile, updateBaselines: false });
    } else if (lane === "visual-rebaseline") {
      await runVisualRegressionLane(context, { profile, updateBaselines: true });
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
      await runAccessibilitySmokeLane(context, { profile });
      await runSurfaceRegressionLane(context, { profile });
      await runVisualRegressionLane(context, { profile, updateBaselines: false });
      await runBackupRoundtripLane(context, { profile });
      await runRuntimeTruthLane(context, { profile });
      await runAuthMatrixLane(context, { profile });
      await runUiParityLane(context, { profile });
      await runMemoryTruthLane(context, { profile });
      await runRealtimeTruthLane(context, { profile });
      await runArchitectureMetricsLane(context);
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
  } catch (error) {
    manifest = await finalizeRunContext(context, "failed");
    if (shouldGenerateReview(lane)) {
      await generateVerificationReview(context, {
        manifest,
        reviewGatewayUrl: options["review-gateway-url"],
      }).catch(() => undefined);
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

function shouldGenerateReview(lane) {
  return REVIEW_LANES.has(lane);
}

async function runAgenticProofSuite(context) {
  await runAgenticContractsLane(context);
  await runAgenticGovernanceLane(context);
  await runAgenticMcpOAuthLane(context);
  await runAgenticHarnessesLane(context);
  await runAgenticWorkbenchLoopLane(context);
  await runAgenticChannelsRuntimeLane(context);
  await runAgenticHarnessAvailabilityLane(context);
  await runAgenticPluginsMarketplaceLane(context);
  await runAgenticSelfImprovementTrustLane(context);
}
