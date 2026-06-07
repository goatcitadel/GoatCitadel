import { buildApp } from "../apps/gateway/src/app.ts";
import type { PromptPackAutoScoreResult, PromptPackRunRecord } from "@goatcitadel/contracts";

interface CliOptions {
  runId?: string;
  packId?: string;
  limit: number;
  compareLatestV1: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const app = await buildApp();
  await app.ready();

  try {
    if (options.runId) {
      const run = app.gateway.storage.promptPackRuns.get(options.runId);
      await rescoreRun(app, run, options);
      return;
    }

    if (!options.packId) {
      throw new Error("Provide either --run-id <id> or --pack-id <id>.");
    }

    const pack = app.gateway.storage.promptPacks.getPack(options.packId);
    const report = app.gateway.getPromptPackReport(pack.packId);
    const queuedRuns = report.latestAssessments
      .filter((assessment) => assessment.runId)
      .map((assessment) => app.gateway.storage.promptPackRuns.get(assessment.runId!))
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, options.limit);

    if (queuedRuns.length === 0) {
      console.log(`[rescore] no latest runs found for pack ${pack.packId}.`);
      return;
    }

    console.log(`[rescore] pack ${pack.packId} (${pack.name}) -> ${queuedRuns.length} latest runs`);
    let failures = 0;
    for (const run of queuedRuns) {
      try {
        await rescoreRun(app, run, options);
      } catch (error) {
        failures += 1;
        console.error(`[rescore] ${run.runId} failed: ${formatError(error)}`);
      }
    }

    if (failures > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

async function rescoreRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  run: PromptPackRunRecord,
  options: CliOptions,
): Promise<void> {
  const test = app.gateway.storage.promptPacks.getTest(run.testId);
  const existingV2 = app.gateway.storage.promptPackAutoScoresV2.listByRun(run.runId, 5)[0];
  const existingV1 = options.compareLatestV1
    ? app.gateway.storage.promptPackScores.listByRun(run.runId, 1)[0]
    : undefined;

  const result = await app.gateway.autoScorePromptPackTest({
    packId: run.packId,
    testId: run.testId,
    runId: run.runId,
    force: true,
  });

  printRescoreSummary(test.code, run, existingV2, result, existingV1?.totalScore);
}

function printRescoreSummary(
  testCode: string,
  run: PromptPackRunRecord,
  existingV2: PromptPackAutoScoreResult["score"] | undefined,
  result: PromptPackAutoScoreResult,
  legacyTotalScore?: number,
): void {
  const reused = existingV2?.autoScoreId === result.score.autoScoreId;
  const comparison = [
    `[rescore] ${testCode}`,
    `run=${run.runId}`,
    `status=${run.status}`,
    `weighted=${result.score.weightedScore.toFixed(1)}/100`,
    `verdict=${result.score.autoVerdict}`,
    `judge=${result.score.judgeStatus}`,
    `state=${result.score.scoreState}`,
    reused ? "reused=current-version-row" : `autoScoreId=${result.score.autoScoreId}`,
  ];
  if (legacyTotalScore !== undefined) {
    comparison.push(`legacy=${legacyTotalScore}/10`);
  }
  if (result.score.reviewReasons.length > 0) {
    comparison.push(`reviewReasons=${result.score.reviewReasons.join(",")}`);
  }
  if (result.score.degradedReasons.length > 0) {
    comparison.push(`degraded=${result.score.degradedReasons.join(",")}`);
  }
  console.log(comparison.join(" | "));
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: 25,
    compareLatestV1: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    switch (current) {
      case "--run-id":
        options.runId = requireValue(argv, index, current);
        index += 1;
        break;
      case "--pack-id":
        options.packId = requireValue(argv, index, current);
        index += 1;
        break;
      case "--limit":
        options.limit = Math.max(1, Number.parseInt(requireValue(argv, index, current), 10) || 25);
        index += 1;
        break;
      case "--compare-latest-v1":
        options.compareLatestV1 = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  if (!options.runId && !options.packId) {
    throw new Error("Expected --run-id <id> or --pack-id <id>.");
  }
  if (options.runId && options.packId) {
    throw new Error("Use either --run-id or --pack-id, not both.");
  }

  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function printUsage(): void {
  console.log(
    "Usage: pnpm tsx scripts/rescore-prompt-pack.ts --run-id <runId> [--compare-latest-v1]\n" +
      "   or: pnpm tsx scripts/rescore-prompt-pack.ts --pack-id <packId> [--limit <n>] [--compare-latest-v1]",
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

void main().catch((error) => {
  console.error(`[rescore] ${formatError(error)}`);
  printUsage();
  process.exitCode = 1;
});
