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

const TARGET_CODES = ["TEST-04", "TEST-12", "TEST-23", "TEST-32"] as const;
const PROMPT_PACK_V2_GATING_ENABLED_ENV = "PROMPT_PACK_V2_GATING_ENABLED";

interface InjectErrorPayload {
  error?: unknown;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const fullRun = !args.has("--target-only");

  const app = await buildApp();
  await app.ready();
  const authHeaders = buildInternalAuthHeaders(app.gatewayConfig.assistant.auth);

  try {
    const { pack, tests } = await resolvePromptPack(app, authHeaders);
    const byCode = new Map(tests.map((test) => [normalizeCode(test.code), test]));

    const missing = TARGET_CODES.filter((code) => !byCode.has(normalizeCode(code)));
    if (missing.length > 0) {
      throw new Error(`Selected pack ${pack.packId} is missing target codes: ${missing.join(", ")}`);
    }

    const queue: PromptPackTestRecord[] = [];
    for (const code of TARGET_CODES) {
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
      // eslint-disable-next-line no-console
      console.log(`[gate] running ${test.code} ...`);
      const runResp = await app.inject({
        method: "POST",
        url: `/api/v1/prompt-packs/${encodeURIComponent(pack.packId)}/tests/${encodeURIComponent(test.testId)}/run`,
        headers: {
          ...authHeaders,
          "Idempotency-Key": `gate-run-${test.testId}-${Date.now()}`,
        },
        payload: {},
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
        durationMs,
        fullRun,
      }),
      "utf8",
    );

    // eslint-disable-next-line no-console
    console.log(`[gate] done. output: ${outPath}`);
    // eslint-disable-next-line no-console
    console.log(
      `[gate] summary: runFailures=${report.summary.runFailureCount} fail=${report.summary.failCount} review=${report.summary.reviewCount}` +
        ` needsScore=${report.summary.needsScoreCount} degraded=${report.summary.degradedScoreCount}` +
        ` avg=${report.summary.averageWeightedScore.toFixed(1)} passRate=${(report.summary.effectivePassRate * 100).toFixed(1)}%`,
    );
    if (!isEnvEnabled(PROMPT_PACK_V2_GATING_ENABLED_ENV)) {
      // eslint-disable-next-line no-console
      console.log(
        `[gate] release gating disabled via ${PROMPT_PACK_V2_GATING_ENABLED_ENV}; leaving exit code unchanged.`,
      );
    } else if (report.summary.failCount > 0 || report.summary.reviewCount > 0 || report.summary.needsScoreCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

async function resolvePromptPack(
  app: Awaited<ReturnType<typeof buildApp>>,
  authHeaders: Record<string, string>,
): Promise<{ pack: PromptPackRecord; tests: PromptPackTestRecord[] }> {
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

  let selected: PromptPackRecord | undefined;
  let selectedTests: PromptPackTestRecord[] = [];
  let selectedMatchCount = -1;
  let selectedTestCount = -1;

  const testsByPackId = new Map(
    await Promise.all(
      packs.map(async (pack) => [pack.packId, await listTests(app, pack.packId, authHeaders)] as const),
    ),
  );

  for (const pack of packs) {
    const tests = testsByPackId.get(pack.packId) ?? [];
    const byCode = new Set(tests.map((test) => normalizeCode(test.code)));
    const matchCount = TARGET_CODES.filter((code) => byCode.has(normalizeCode(code))).length;
    if (matchCount > selectedMatchCount || (matchCount === selectedMatchCount && tests.length > selectedTestCount)) {
      selected = pack;
      selectedTests = tests;
      selectedMatchCount = matchCount;
      selectedTestCount = tests.length;
    }
  }

  if (!selected) {
    throw new Error("Unable to resolve a prompt pack for gate run.");
  }
  return {
    pack: selected,
    tests: selectedTests,
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
  durationMs: number;
  fullRun: boolean;
}): string {
  const { pack, report, runResults, durationMs, fullRun } = input;
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
  const testByCode = new Map(report.tests.map((test) => [normalizeCode(test.code), test]));
  const targetedRows = TARGET_CODES.map((code) => {
    const test = testByCode.get(normalizeCode(code));
    const run = test ? latestRunByTestId.get(test.testId) : undefined;
    const assessment = test ? latestAssessmentByTestId.get(test.testId) : undefined;
    return `| ${code} | ${run?.status ?? "missing"} | ${assessment?.autoScore ? `${assessment.autoScore.weightedScore.toFixed(1)}/100` : "none"} | ${assessment?.effectiveVerdict ?? "none"} | ${run?.runId ?? "-"} |`;
  }).join("\n");

  const lines = [
    `# Prompt Gate Run (${new Date().toISOString()})`,
    "",
    `- Pack: ${pack.name} (\`${pack.packId}\`)`,
    `- Mode: ${fullRun ? "Targeted 4 + full pack" : "Targeted 4 only"}`,
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
    `- Degraded auto scores: ${report.summary.degradedScoreCount}`,
    `- Average weighted score: ${report.summary.averageWeightedScore.toFixed(1)}/100`,
    `- Effective pass rate @ ${report.summary.passThreshold}/100: ${(report.summary.effectivePassRate * 100).toFixed(1)}%`,
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

function safeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[gate] failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
