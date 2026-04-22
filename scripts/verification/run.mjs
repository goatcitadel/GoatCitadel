#!/usr/bin/env node
import path from "node:path";
import { generateVerificationReview, loadManifestForReview } from "./lib/review.mjs";
import {
  runApiCompatibilityLane,
  runBackupRoundtripLane,
  runCatalogParityLane,
  runDeepCoreLane,
  runDeepEcosystemLane,
  runDurableRecoveryLane,
  runFastLane,
  runOperatorProofLane,
  runVisualRegressionLane,
  runSurfaceRegressionLane,
  runSoakLane,
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
  const effectiveUiPackage = process.env.GOATCITADEL_UI_PACKAGE?.trim();
  if (
    effectiveUiPackage === "@goatcitadel/mission-control-next" &&
    !["surface-regression", "visual-regression", "visual-rebaseline", "review"].includes(lane)
  ) {
    throw new Error(
      "Mission Control Next verification currently supports surface-regression, visual-regression, visual-rebaseline, and review lanes only.",
    );
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
      await runSoakLane(context, { profile, durationMs });
    } else if (lane === "all") {
      await runFastLane(context);
      await runDeepCoreLane(context, { profile });
      await runDeepEcosystemLane(context, { profile });
      await runCatalogParityLane(context, { profile });
      await runApiCompatibilityLane(context, { profile });
      await runOperatorProofLane(context, { profile });
      await runDurableRecoveryLane(context, { profile });
      await runSurfaceRegressionLane(context, { profile });
      await runVisualRegressionLane(context, { profile, updateBaselines: false });
      await runBackupRoundtripLane(context, { profile });
      if (includeSoak) {
        await runSoakLane(context, { profile, durationMs });
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
    lane === "all" ||
    lane === "soak"
  );
}
