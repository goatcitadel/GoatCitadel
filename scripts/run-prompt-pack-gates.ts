import fs from "node:fs/promises";
import path from "node:path";
import { buildApp } from "../apps/gateway/src/app.ts";
import type {
  PromptPackLatestAssessmentRecordV2,
  PromptPackRecord,
  PromptPackReportRecord,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import type { AuthConfig } from "../apps/gateway/src/config.ts";

const LEGACY_TARGET_CODES = ["TEST-04", "TEST-12", "TEST-23", "TEST-32"] as const;
// v7 overall gate pack representatives (one per surface + the budgeted cowork
// research row); the TEST-C101-era set fell out of use when v1-v3 packs were archived.
const MODERN_TARGET_CODE_CANDIDATES = ["TEST-C709", "TEST-W713", "TEST-D710", "TEST-W707"] as const;
const PROMPT_PACK_GATE_CODES_ENV = "PROMPT_PACK_GATE_CODES";
const PROMPT_PACK_V2_GATING_ENABLED_ENV = "PROMPT_PACK_V2_GATING_ENABLED";

interface InjectErrorPayload {
  error?: unknown;
}

interface GateSummaryMetrics {
  notRunCount: number;
  completedValidLatestRuns: number;
  autoScoredRuns: number;
  scoredCoverageDenominator: number;
  missingCurrentScores: number;
}

/**
 * Derived coverage metrics shared by the console summary in main() and the
 * markdown report in renderReport() — keep both in lockstep.
 */
function deriveGateSummaryMetrics(summary: PromptPackReportRecord["summary"]): GateSummaryMetrics {
  const notRunCount = Math.max(
    summary.totalTests - summary.completedRuns - summary.failedRuns - (summary.approvalPausedRuns ?? 0),
    0,
  );
  const completedValidLatestRuns = Math.max(summary.completedRuns - summary.invalidLatestRuns, 0);
  const autoScoredRuns = summary.autoScoredRuns ?? 0;
  const scoredCoverageDenominator = Math.max(completedValidLatestRuns, autoScoredRuns + summary.needsScoreCount);
  const missingCurrentScores = Math.max(scoredCoverageDenominator - autoScoredRuns, 0);
  return { notRunCount, completedValidLatestRuns, autoScoredRuns, scoredCoverageDenominator, missingCurrentScores };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const fullRun = !args.has("--target-only");
  const explicitTargetCodes = resolveExplicitTargetCodes(argv);
  const executionStyle = resolveExecutionStyle(argv);

  const app = await buildApp();
  await app.ready();
  const authHeaders = buildInternalAuthHeaders(app.gatewayConfig.assistant.auth);

  try {
    const { pack, tests, targetCodes } = await resolvePromptPack(app, authHeaders, explicitTargetCodes);
    const byCode = new Map(tests.map((test) => [normalizeCode(test.code), test]));

    const missing = targetCodes.filter((code) => !byCode.has(normalizeCode(code)));
    if (missing.length > 0) {
      throw new Error(`Selected pack ${pack.packId} is missing target codes: ${missing.join(", ")}`);
    }

    console.log(`[gate] using target codes: ${targetCodes.join(", ")}`);

    const queue: PromptPackTestRecord[] = [];
    for (const code of targetCodes) {
      queue.push(byCode.get(normalizeCode(code))!);
    }
    if (fullRun) {
      const seen = new Set(queue.map((test) => test.testId));
      for (const test of tests) {
        if (seen.has(test.testId)) {
          continue;
        }
        seen.add(test.testId);
        queue.push(test);
      }
    }

    const startedAt = new Date();
    const runResults: Array<{
      code: string;
      runId?: string;
      runStatus?: PromptPackRunRecord["status"];
      autoScoreStatus: "scored" | "skipped" | "failed";
      autoScoreError?: string;
      runError?: string;
    }> = [];

    for (const test of queue) {
      console.log(`[gate] running ${test.code} ...`);
      const runResp = await app.inject({
        method: "POST",
        url: `/api/v1/prompt-packs/${encodeURIComponent(pack.packId)}/tests/${encodeURIComponent(test.testId)}/run`,
        headers: {
          ...authHeaders,
          "Idempotency-Key": `gate-run-${test.testId}-${Date.now()}`,
        },
        payload: executionStyle ? { executionStyle } : {},
      });
      if (runResp.statusCode !== 200) {
        const payload = safeJson<InjectErrorPayload>(runResp.body);
        runResults.push({
          code: test.code,
          autoScoreStatus: "skipped",
          runError: typeof payload.error === "string" ? payload.error : `HTTP ${runResp.statusCode}`,
        });
        continue;
      }
      const run = safeJson<PromptPackRunRecord>(runResp.body);
      if (!run?.runId) {
        runResults.push({
          code: test.code,
          autoScoreStatus: "skipped",
          runError: "run endpoint did not return a runId",
        });
        continue;
      }
      if (run.status !== "completed") {
        runResults.push({
          code: test.code,
          runId: run.runId,
          runStatus: run.status,
          autoScoreStatus: "skipped",
        });
        continue;
      }

      const autoResp = await app.inject({
        method: "POST",
        url: `/api/v1/prompt-packs/${encodeURIComponent(pack.packId)}/tests/${encodeURIComponent(test.testId)}/auto-score`,
        headers: {
          ...authHeaders,
          "Idempotency-Key": `gate-score-${run.runId}-${Date.now()}`,
        },
        payload: { runId: run.runId, force: true },
      });
      if (autoResp.statusCode !== 200) {
        const payload = safeJson<InjectErrorPayload>(autoResp.body);
        runResults.push({
          code: test.code,
          runId: run.runId,
          runStatus: run.status,
          autoScoreStatus: "failed",
          autoScoreError: typeof payload.error === "string" ? payload.error : `HTTP ${autoResp.statusCode}`,
        });
        continue;
      }

      runResults.push({
        code: test.code,
        runId: run.runId,
        runStatus: run.status,
        autoScoreStatus: "scored",
      });
    }

    const report = await getReport(app, pack.packId, authHeaders);
    const { notRunCount, autoScoredRuns, scoredCoverageDenominator, missingCurrentScores } = deriveGateSummaryMetrics(
      report.summary,
    );
    const fullPackPassReady =
      fullRun &&
      report.summary.totalTests > 0 &&
      notRunCount === 0 &&
      report.summary.failedRuns === 0 &&
      report.summary.runFailureCount === 0 &&
      report.summary.invalidLatestRuns === 0 &&
      missingCurrentScores === 0 &&
      report.summary.staleLatestAutoScoreCount === 0 &&
      report.summary.failCount === 0 &&
      report.summary.reviewCount === 0 &&
      report.summary.judgeErrorCount === 0 &&
      (report.summary.degradedScoreCount ?? 0) === 0 &&
      report.summary.effectivePassRate === 1;
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const timestamp = formatStamp(finishedAt);
    const outDir = path.join(process.cwd(), "artifacts", "prompt-lab");
    const outPath = path.join(outDir, `gate-run-${timestamp}.md`);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      outPath,
      renderReport({
        pack,
        report,
        runResults,
        targetCodes,
        durationMs,
        fullRun,
        executionStyle,
      }),
      "utf8",
    );

    console.log(`[gate] done. output: ${outPath}`);
    console.log(
      `[gate] summary: runFailures=${report.summary.runFailureCount} fail=${report.summary.failCount} review=${report.summary.reviewCount}` +
        ` needsScore=${report.summary.needsScoreCount} stale=${report.summary.staleLatestAutoScoreCount}` +
        ` degraded=${report.summary.degradedScoreCount}` +
        ` coverage=${report.summary.completedRuns}/${report.summary.totalTests} notRun=${notRunCount}` +
        ` scored=${autoScoredRuns}/${scoredCoverageDenominator}` +
        ` avg=${report.summary.averageWeightedScore.toFixed(1)} scoredPassRate=${(report.summary.effectivePassRate * 100).toFixed(1)}%` +
        ` fullPackReady=${fullPackPassReady ? "yes" : "no"}`,
    );
    if (!isEnvEnabled(PROMPT_PACK_V2_GATING_ENABLED_ENV)) {
      console.log(
        `[gate] release gating disabled via ${PROMPT_PACK_V2_GATING_ENABLED_ENV}; leaving exit code unchanged.`,
      );
    } else if (
      report.summary.failCount > 0 ||
      report.summary.reviewCount > 0 ||
      report.summary.needsScoreCount > 0 ||
      report.summary.staleLatestAutoScoreCount > 0 ||
      (fullRun &&
        (notRunCount > 0 ||
          report.summary.failedRuns > 0 ||
          report.summary.runFailureCount > 0 ||
          report.summary.invalidLatestRuns > 0 ||
          missingCurrentScores > 0 ||
          report.summary.judgeErrorCount > 0 ||
          (report.summary.degradedScoreCount ?? 0) > 0 ||
          report.summary.effectivePassRate < 1))
    ) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

async function resolvePromptPack(
  app: Awaited<ReturnType<typeof buildApp>>,
  authHeaders: Record<string, string>,
  explicitTargetCodes?: string[],
): Promise<{ pack: PromptPackRecord; tests: PromptPackTestRecord[]; targetCodes: string[] }> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/prompt-packs?limit=200",
    headers: authHeaders,
  });
  if (response.statusCode !== 200) {
    throw new Error(`Failed to list prompt packs: HTTP ${response.statusCode}`);
  }
  const payload = safeJson<{ items: PromptPackRecord[] }>(response.body);
  const packs = payload.items ?? [];
  if (packs.length === 0) {
    throw new Error("No prompt packs available. Import a prompt pack before running gates.");
  }

  const testsByPackId = new Map(
    await Promise.all(
      packs.map(async (pack) => [pack.packId, await listTests(app, pack.packId, authHeaders)] as const),
    ),
  );

  if (explicitTargetCodes && explicitTargetCodes.length > 0) {
    const matchingPacks = packs
      .map((pack) => ({
        pack,
        tests: testsByPackId.get(pack.packId) ?? [],
      }))
      .filter(({ tests }) => {
        const byCode = new Set(tests.map((test) => normalizeCode(test.code)));
        return explicitTargetCodes.every((code) => byCode.has(normalizeCode(code)));
      });
    if (matchingPacks.length === 0) {
      throw new Error(`No prompt pack contains all requested gate codes: ${explicitTargetCodes.join(", ")}`);
    }
    if (matchingPacks.length > 1) {
      throw new Error(
        `Explicit gate codes are ambiguous across multiple prompt packs: ${matchingPacks.map(({ pack }) => pack.packId).join(", ")}`,
      );
    }
    return {
      pack: matchingPacks[0].pack,
      tests: matchingPacks[0].tests,
      targetCodes: explicitTargetCodes,
    };
  }

  const candidates = packs
    .map((pack) => {
      const tests = testsByPackId.get(pack.packId) ?? [];
      return {
        pack,
        tests,
        targetCodes: selectPromptPackGateTargetCodes(tests),
      };
    })
    .filter((candidate) => candidate.targetCodes.length > 0)
    .sort((left, right) => {
      if (right.targetCodes.length !== left.targetCodes.length) {
        return right.targetCodes.length - left.targetCodes.length;
      }
      return right.tests.length - left.tests.length;
    });

  const selected = candidates[0];
  if (!selected) {
    throw new Error("No prompt pack matched the known legacy or modern gate target sets. Pass --codes explicitly.");
  }
  return {
    pack: selected.pack,
    tests: selected.tests,
    targetCodes: selected.targetCodes,
  };
}

async function listTests(
  app: Awaited<ReturnType<typeof buildApp>>,
  packId: string,
  authHeaders: Record<string, string>,
): Promise<PromptPackTestRecord[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests?limit=2000`,
    headers: authHeaders,
  });
  if (response.statusCode !== 200) {
    throw new Error(`Failed to list tests for ${packId}: HTTP ${response.statusCode}`);
  }
  const payload = safeJson<{ items: PromptPackTestRecord[] }>(response.body);
  return payload.items ?? [];
}

async function getReport(
  app: Awaited<ReturnType<typeof buildApp>>,
  packId: string,
  authHeaders: Record<string, string>,
): Promise<PromptPackReportRecord> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/prompt-packs/${encodeURIComponent(packId)}/report`,
    headers: authHeaders,
  });
  if (response.statusCode !== 200) {
    throw new Error(`Failed to fetch prompt report for ${packId}: HTTP ${response.statusCode}`);
  }
  return safeJson<PromptPackReportRecord>(response.body);
}

function buildInternalAuthHeaders(auth: AuthConfig): Record<string, string> {
  if (auth.mode === "none") {
    return {};
  }

  if (auth.mode === "token") {
    const token = auth.token.value?.trim();
    if (!token) {
      throw new Error("Prompt gate runner requires a configured token when gateway auth mode is token.");
    }
    return {
      authorization: `Bearer ${token}`,
      "x-goatcitadel-token": token,
    };
  }

  const username = auth.basic.username?.trim();
  const password = auth.basic.password ?? "";
  if (!username || !password.trim()) {
    throw new Error("Prompt gate runner requires configured basic auth credentials when gateway auth mode is basic.");
  }
  return {
    authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
  };
}

function isEnvEnabled(name: string, defaultValue = true): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  return !["0", "false", "off", "no", "disabled"].includes(raw);
}

function renderReport(input: {
  pack: PromptPackRecord;
  report: PromptPackReportRecord;
  runResults: Array<{
    code: string;
    runId?: string;
    runStatus?: PromptPackRunRecord["status"];
    autoScoreStatus: "scored" | "skipped" | "failed";
    autoScoreError?: string;
    runError?: string;
  }>;
  targetCodes: string[];
  durationMs: number;
  fullRun: boolean;
  executionStyle?: "single_turn_harness" | "agentic_surface";
}): string {
  const { pack, report, runResults, targetCodes, durationMs, fullRun, executionStyle } = input;
  const latestRunByTestId = new Map<string, PromptPackRunRecord>();
  for (const run of report.runs) {
    if (!latestRunByTestId.has(run.testId)) {
      latestRunByTestId.set(run.testId, run);
    }
  }
  const latestAssessmentByTestId = new Map<string, PromptPackLatestAssessmentRecordV2>();
  for (const assessment of report.latestAssessments) {
    if (!latestAssessmentByTestId.has(assessment.testId)) {
      latestAssessmentByTestId.set(assessment.testId, assessment);
    }
  }
  const { notRunCount, autoScoredRuns, scoredCoverageDenominator, missingCurrentScores } = deriveGateSummaryMetrics(
    report.summary,
  );
  const fullPackReadinessBlockers = [
    report.summary.totalTests === 0 ? "no tests loaded" : undefined,
    !fullRun ? "target-only run" : undefined,
    notRunCount > 0 ? `${notRunCount} not run` : undefined,
    report.summary.failedRuns > 0 ? `${report.summary.failedRuns} failed run(s)` : undefined,
    report.summary.runFailureCount > 0 ? `${report.summary.runFailureCount} runtime failure(s)` : undefined,
    report.summary.invalidLatestRuns > 0 ? `${report.summary.invalidLatestRuns} invalid latest run(s)` : undefined,
    missingCurrentScores > 0 ? `${missingCurrentScores} completed run(s) without current auto-score` : undefined,
    report.summary.staleLatestAutoScoreCount > 0
      ? `${report.summary.staleLatestAutoScoreCount} stale score row(s)`
      : undefined,
    report.summary.failCount > 0 ? `${report.summary.failCount} fail verdict(s)` : undefined,
    report.summary.reviewCount > 0 ? `${report.summary.reviewCount} review verdict(s)` : undefined,
    report.summary.judgeErrorCount > 0 ? `${report.summary.judgeErrorCount} judge error(s)` : undefined,
    (report.summary.degradedScoreCount ?? 0) > 0 ? `${report.summary.degradedScoreCount} degraded score(s)` : undefined,
    report.summary.effectivePassRate < 1 ? "scored pass rate below 100%" : undefined,
  ].filter((item): item is string => Boolean(item));
  const fullPackReady = report.summary.totalTests > 0 && fullPackReadinessBlockers.length === 0;
  const testByCode = new Map(report.tests.map((test) => [normalizeCode(test.code), test]));
  const targetedRows = targetCodes
    .map((code) => {
      const test = testByCode.get(normalizeCode(code));
      const run = test ? latestRunByTestId.get(test.testId) : undefined;
      const assessment = test ? latestAssessmentByTestId.get(test.testId) : undefined;
      return `| ${code} | ${run?.status ?? "missing"} | ${assessment?.autoScore ? `${assessment.autoScore.weightedScore.toFixed(1)}/100` : "none"} | ${assessment?.effectiveVerdict ?? "none"} | ${run?.runId ?? "-"} |`;
    })
    .join("\n");

  const lines = [
    `# Prompt Gate Run (${new Date().toISOString()})`,
    "",
    `- Pack: ${pack.name} (\`${pack.packId}\`)`,
    `- Mode: ${fullRun ? `Targeted ${targetCodes.length} + full pack` : `Targeted ${targetCodes.length} only`}`,
    `- Target codes: ${targetCodes.join(", ")}`,
    ...(executionStyle ? [`- Execution style override: ${executionStyle}`] : []),
    `- Duration: ${(durationMs / 1000).toFixed(1)}s`,
    "",
    "## Targeted Test Status",
    "",
    "| Test | Latest run status | Latest score | Effective verdict | Latest run id |",
    "|---|---|---:|---|---|",
    targetedRows,
    "",
    "## Overall Summary",
    "",
    `- Total tests: ${report.summary.totalTests}`,
    `- Run failures: ${report.summary.runFailureCount}`,
    `- Fail verdicts: ${report.summary.failCount}`,
    `- Review verdicts: ${report.summary.reviewCount}`,
    `- Needs score: ${report.summary.needsScoreCount}`,
    `- Stale latest auto scores: ${report.summary.staleLatestAutoScoreCount}`,
    `- Degraded auto scores: ${report.summary.degradedScoreCount}`,
    `- Full-pack pass readiness: ${fullPackReady ? "ready" : `not ready (${fullPackReadinessBlockers.join("; ")})`}`,
    `- Run coverage: ${report.summary.completedRuns}/${report.summary.totalTests} latest runs completed`,
    `- Scored coverage: ${autoScoredRuns}/${scoredCoverageDenominator} completed valid latest runs`,
    `- Average weighted score: ${report.summary.averageWeightedScore.toFixed(1)}/100`,
    `- Effective pass rate @ ${report.summary.passThreshold}/100 (scored rows only): ${(report.summary.effectivePassRate * 100).toFixed(1)}%`,
    `- Review rate: ${(report.summary.reviewRate * 100).toFixed(1)}%`,
    "",
    "## Execution Log (This Run)",
    "",
    "| Code | Run status | Auto-score | Run id | Error |",
    "|---|---|---|---|---|",
    ...runResults.map(
      (row) =>
        `| ${row.code} | ${row.runStatus ?? "n/a"} | ${row.autoScoreStatus} | ${row.runId ?? "-"} | ${
          row.runError ?? row.autoScoreError ?? "-"
        } |`,
    ),
    "",
  ];
  return lines.join("\n");
}

function formatStamp(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const dd = `${date.getUTCDate()}`.padStart(2, "0");
  const hh = `${date.getUTCHours()}`.padStart(2, "0");
  const mi = `${date.getUTCMinutes()}`.padStart(2, "0");
  const ss = `${date.getUTCSeconds()}`.padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}Z`;
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

function resolveExplicitTargetCodes(argv: string[]): string[] | undefined {
  const cliRaw =
    extractFlagValue(argv, "--codes") ??
    extractFlagValue(argv, "--target-codes") ??
    process.env[PROMPT_PACK_GATE_CODES_ENV];
  if (!cliRaw) {
    return undefined;
  }
  const values = splitCodeList(cliRaw);
  return values.length > 0 ? values : undefined;
}

function extractFlagValue(argv: string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === flag) {
      return argv[index + 1];
    }
    if (current.startsWith(`${flag}=`)) {
      return current.slice(flag.length + 1);
    }
  }
  return undefined;
}

function splitCodeList(raw: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const part of raw.split(",")) {
    const normalized = normalizeCode(part);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

function resolveExecutionStyle(argv: string[]): "single_turn_harness" | "agentic_surface" | undefined {
  const raw = extractFlagValue(argv, "--execution-style") ?? extractFlagValue(argv, "--style");
  if (!raw) {
    return undefined;
  }
  if (raw === "single_turn_harness" || raw === "agentic_surface") {
    return raw;
  }
  throw new Error(`Unsupported execution style: ${raw}`);
}

function selectPromptPackGateTargetCodes(tests: PromptPackTestRecord[]): string[] {
  const availableCodes = new Set(tests.map((test) => normalizeCode(test.code)));
  if (LEGACY_TARGET_CODES.every((code) => availableCodes.has(normalizeCode(code)))) {
    return [...LEGACY_TARGET_CODES];
  }

  const selected: string[] = [];
  for (const code of MODERN_TARGET_CODE_CANDIDATES) {
    if (availableCodes.has(normalizeCode(code))) {
      selected.push(normalizeCode(code));
    }
  }
  return selected;
}

function safeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

main().catch((error) => {
  console.error(`[gate] failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
