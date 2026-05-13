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
  runAgenticPluginsMarketplaceLane,
  runAgenticSelfImprovementTrustLane,
  runAgenticWorkbenchLoopLane,
  runAuthMatrixLane,
  runApiCompatibilityLane,
  runBackupRoundtripLane,
  runCatalogParityLane,
  runCodeModeSandboxRequiredLane,
  runDeepCoreLane,
  runDeepEcosystemLane,
  runDurableRecoveryLane,
  runFastLane,
  runMemoryTruthLane,
  runOperatorProofLane,
  runRealtimeTruthLane,
  runRuntimeTruthLane,
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
  "deep-core",
  "deep-ecosystem",
  "catalog-parity",
  "api-compat",
  "operator-proof",
  "durable-recovery",
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
  "review",
  "all",
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
  const context = await createRunContext(lane, {
    runId: typeof options["run-id"] === "string" ? options["run-id"] : undefined,
    profile,
    includeSoak,
    durationMs,
  });

  let manifest;
  try {
    if (lane === "fast") {
      await runFastLane(context);
    } else if (lane === "deep-core") {
      await runDeepCoreLane(context, { profile });
    } else if (lane === "deep-ecosystem") {
      await runDeepEcosystemLane(context, { profile });
    } else if (lane === "catalog-parity") {
      await runCatalogParityLane(context, { profile });
    } else if (lane === "api-compat") {
      await runApiCompatibilityLane(context, { profile });
    } else if (lane === "operator-proof") {
      await runOperatorProofLane(context, { profile });
    } else if (lane === "durable-recovery") {
      await runDurableRecoveryLane(context, { profile });
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
    } else if (lane === "agentic-contracts") {
      await runAgenticContractsLane(context);
    } else if (lane === "agentic-governance") {
      await runAgenticGovernanceLane(context);
    } else if (lane === "agentic-harnesses") {
      await runAgenticHarnessesLane(context);
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
      await runAgenticContractsLane(context);
      await runAgenticGovernanceLane(context);
      await runAgenticHarnessesLane(context);
    } else if (lane === "all") {
      await runFastLane(context);
      await runCodeModeSandboxRequiredLane(context);
      await runAgenticContractsLane(context);
      await runAgenticGovernanceLane(context);
      await runAgenticHarnessesLane(context);
      await runDeepCoreLane(context, { profile });
      await runDeepEcosystemLane(context, { profile });
      await runCatalogParityLane(context, { profile });
      await runApiCompatibilityLane(context, { profile });
      await runOperatorProofLane(context, { profile });
      await runDurableRecoveryLane(context, { profile });
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
  return (
    lane === "deep-core" ||
    lane === "deep-ecosystem" ||
    lane === "catalog-parity" ||
    lane === "api-compat" ||
    lane === "operator-proof" ||
    lane === "durable-recovery" ||
    lane === "surface-regression" ||
    lane === "visual-regression" ||
    lane === "visual-rebaseline" ||
    lane === "backup-roundtrip" ||
    lane === "runtime-truth" ||
    lane === "auth-matrix" ||
    lane === "ui-parity" ||
    lane === "memory-truth" ||
    lane === "realtime-truth" ||
    lane === "architecture-metrics" ||
    lane === "code-mode-sandbox" ||
    lane === "agentic-contracts" ||
    lane === "agentic-governance" ||
    lane === "agentic-harnesses" ||
    lane === "agentic-workbench-loop" ||
    lane === "agentic-channels-runtime" ||
    lane === "agentic-harness-availability" ||
    lane === "agentic-plugins-marketplace" ||
    lane === "agentic-self-improvement-trust" ||
    lane === "agentic-parity" ||
    lane === "all" ||
    lane === "soak"
  );
}
