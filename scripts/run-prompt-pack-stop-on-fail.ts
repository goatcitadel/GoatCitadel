import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildApp } from "../apps/gateway/src/app";
import type { AuthConfig } from "../apps/gateway/src/config";

type JsonRecord = Record<string, unknown>;

type PromptPackTestRecord = {
  code?: string;
  testId: string;
  name?: string;
  prompt?: string;
};

type PromptPackRunRecord = {
  runId?: string;
  testId?: string;
  status?: string;
  responseText?: string | null;
  failure?: string | null;
  score?: JsonRecord | null;
  integrity?: JsonRecord | null;
  errors?: unknown;
};

type PromptPackAssessmentRecord = {
  testId?: string;
  effectiveVerdict?: string | null;
  effectiveState?: string | null;
  scoringFailures?: unknown;
  scoringWarnings?: unknown;
  failureReasons?: unknown;
  latestRunId?: string | null;
};

type PromptPackReport = {
  runs?: PromptPackRunRecord[];
  latestAssessments?: PromptPackAssessmentRecord[];
};

type StopOnFailFailure = {
  code: string;
  testId: string;
  name?: string;
  reason: string;
  runId?: string;
  status?: string;
  effectiveVerdict?: string | null;
  effectiveState?: string | null;
  scoringFailures?: unknown;
  scoringWarnings?: unknown;
  failureReasons?: unknown;
  responseText?: string | null;
  prompt?: string;
};

type StopOnFailCheckpoint = {
  packId: string;
  startedAt: string;
  updatedAt: string;
  passedCodes: string[];
  failed?: StopOnFailFailure;
  completed?: boolean;
};

const DEFAULT_PACK_ID = "pack-81737f94-82bc-4d2e-b027-c35d4af1d5bf";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function codeOf(test: PromptPackTestRecord): string {
  return String(test.code ?? test.testId).trim();
}

function ensureArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildInternalAuthHeaders(auth: AuthConfig): Record<string, string> {
  if (auth.mode === "none") {
    return {};
  }
  if (auth.mode === "token") {
    const token = auth.token.value?.trim();
    if (!token) {
      throw new Error("Prompt-pack runner requires a configured token when gateway auth mode is token.");
    }
    return {
      authorization: `Bearer ${token}`,
      "x-goatcitadel-token": token,
    };
  }
  const username = auth.basic.username?.trim();
  const password = auth.basic.password ?? "";
  if (!username || !password.trim()) {
    throw new Error("Prompt-pack runner requires configured basic auth credentials when gateway auth mode is basic.");
  }
  return {
    authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
  };
}

function safeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

async function injectJson<T>(
  app: Awaited<ReturnType<typeof buildApp>>,
  options: {
    method: "GET" | "POST";
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  },
): Promise<{ ok: boolean; status: number; body: T | JsonRecord | string | null }> {
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers: options.headers,
    payload: options.payload,
  });
  const text = response.body ?? "";
  let body: T | JsonRecord | string | null = null;
  if (text.length > 0) {
    try {
      body = safeJson<T>(text);
    } catch {
      body = text;
    }
  }
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    body,
  };
}

function summarizeBody(body: unknown): string {
  if (typeof body === "string") {
    return body.slice(0, 500);
  }
  if (body == null) {
    return "empty response body";
  }
  return JSON.stringify(body).slice(0, 500);
}

function newestRunForTest(report: PromptPackReport, testId: string): PromptPackRunRecord | undefined {
  return ensureArray(report.runs).find((run) => (run as PromptPackRunRecord).testId === testId) as PromptPackRunRecord | undefined;
}

function latestAssessmentForTest(report: PromptPackReport, testId: string): PromptPackAssessmentRecord | undefined {
  return ensureArray(report.latestAssessments).find(
    (assessment) => (assessment as PromptPackAssessmentRecord).testId === testId,
  ) as PromptPackAssessmentRecord | undefined;
}

function failureFrom(
  test: PromptPackTestRecord,
  reason: string,
  report?: PromptPackReport,
  run?: PromptPackRunRecord,
): StopOnFailFailure {
  const resolvedRun = run ?? (report ? newestRunForTest(report, test.testId) : undefined);
  const assessment = report ? latestAssessmentForTest(report, test.testId) : undefined;
  return {
    code: codeOf(test),
    testId: test.testId,
    name: test.name,
    reason,
    runId: resolvedRun?.runId,
    status: resolvedRun?.status,
    effectiveVerdict: assessment?.effectiveVerdict ?? null,
    effectiveState: assessment?.effectiveState ?? null,
    scoringFailures: assessment?.scoringFailures,
    scoringWarnings: assessment?.scoringWarnings,
    failureReasons: assessment?.failureReasons,
    responseText: resolvedRun?.responseText ?? null,
    prompt: test.prompt,
  };
}

async function main(): Promise<void> {
  const packId = getArg("--pack-id") ?? process.env.PROMPT_PACK_ID ?? DEFAULT_PACK_ID;
  const providerId = getArg("--provider") ?? process.env.PROMPT_PACK_PROVIDER_ID;
  const model = getArg("--model") ?? process.env.PROMPT_PACK_MODEL;
  const checkpointPath =
    getArg("--checkpoint") ??
    path.join(process.cwd(), "artifacts", "prompt-lab", `${packId}-stop-on-fail-checkpoint.json`);
  const latestResultPath =
    getArg("--latest-result") ??
    path.join(process.cwd(), "artifacts", "prompt-lab", `${packId}-stop-on-fail-latest.json`);
  const onlyCode = getArg("--only")?.trim();
  const maxCountRaw = getArg("--max");
  const maxCount = maxCountRaw ? Number.parseInt(maxCountRaw, 10) : Number.POSITIVE_INFINITY;
  const reset = hasFlag("--reset");

  const checkpoint: StopOnFailCheckpoint =
    !reset && (await readJsonFile<StopOnFailCheckpoint>(checkpointPath)) != null
      ? ((await readJsonFile<StopOnFailCheckpoint>(checkpointPath)) as StopOnFailCheckpoint)
      : {
          packId,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          passedCodes: [],
        };

  checkpoint.packId = packId;
  checkpoint.completed = false;
  checkpoint.updatedAt = new Date().toISOString();
  await writeJsonFile(checkpointPath, checkpoint);

  const app = await buildApp();
  await app.ready();
  try {
    const headers = buildInternalAuthHeaders(app.gatewayConfig.assistant.auth);
    const testsResponse = await injectJson<{ tests?: PromptPackTestRecord[]; items?: PromptPackTestRecord[] }>(
      app,
      {
        headers,
        method: "GET",
        url: `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests?limit=2000`,
      },
    );

    if (!testsResponse.ok || typeof testsResponse.body !== "object" || testsResponse.body == null) {
      throw new Error(`Unable to load tests for ${packId}: ${summarizeBody(testsResponse.body)}`);
    }

    const testsPayload = testsResponse.body as { tests?: PromptPackTestRecord[]; items?: PromptPackTestRecord[] };
    const allTests = ensureArray(testsPayload.tests ?? testsPayload.items) as PromptPackTestRecord[];
    const testsByCode = new Map(allTests.map((test) => [codeOf(test), test]));
    const alreadyPassed = new Set(checkpoint.passedCodes);
    const queue: PromptPackTestRecord[] = [];

    if (onlyCode) {
      const test = testsByCode.get(onlyCode);
      if (!test) {
        throw new Error(`Could not find test code ${onlyCode} in pack ${packId}`);
      }
      queue.push(test);
    } else if (checkpoint.failed && !alreadyPassed.has(checkpoint.failed.code)) {
      const failedTest = testsByCode.get(checkpoint.failed.code);
      if (failedTest) {
        queue.push(failedTest);
      }
      for (const test of allTests) {
        const code = codeOf(test);
        if (code === checkpoint.failed.code || alreadyPassed.has(code)) {
          continue;
        }
        queue.push(test);
      }
    } else {
      for (const test of allTests) {
        if (!alreadyPassed.has(codeOf(test))) {
          queue.push(test);
        }
      }
    }

    const limitedQueue = queue.slice(0, Number.isFinite(maxCount) ? maxCount : queue.length);
    console.log(
      JSON.stringify({
        event: "queue_ready",
        packId,
        providerId: providerId ?? null,
        model: model ?? null,
        totalTests: allTests.length,
        alreadyPassed: checkpoint.passedCodes.length,
        queued: limitedQueue.length,
        onlyCode: onlyCode ?? null,
      }),
    );

    if (limitedQueue.length === 0) {
      checkpoint.failed = undefined;
      checkpoint.completed = checkpoint.passedCodes.length >= allTests.length;
      checkpoint.updatedAt = new Date().toISOString();
      await writeJsonFile(checkpointPath, checkpoint);
      await writeJsonFile(latestResultPath, {
        status: checkpoint.completed ? "completed" : "idle",
        packId,
        passedCodes: checkpoint.passedCodes,
        totalTests: allTests.length,
        providerId: providerId ?? null,
        model: model ?? null,
      });
      console.log(
        JSON.stringify({
          event: checkpoint.completed ? "all_done" : "nothing_to_run",
          passed: checkpoint.passedCodes.length,
          totalTests: allTests.length,
        }),
      );
      return;
    }

    for (let index = 0; index < limitedQueue.length; index += 1) {
      const test = limitedQueue[index];
      const code = codeOf(test);
      console.log(
        JSON.stringify({
          event: "starting_test",
          code,
          testId: test.testId,
          index: checkpoint.passedCodes.length + 1,
          remainingInInvocation: limitedQueue.length - index,
        }),
      );

      const runResponse = await injectJson<PromptPackRunRecord>(
        app,
        {
          headers: {
            ...headers,
            "Idempotency-Key": `stop-on-fail:${packId}:${code}:${Date.now()}`,
          },
          method: "POST",
          url: `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(test.testId)}/run`,
          payload: {
            ...(providerId ? { providerId } : {}),
            ...(model ? { model } : {}),
          },
        },
      );

      if (!runResponse.ok || typeof runResponse.body !== "object" || runResponse.body == null) {
        const failure = failureFrom(test, `run_request_failed:${runResponse.status}:${summarizeBody(runResponse.body)}`);
        checkpoint.failed = failure;
        checkpoint.updatedAt = new Date().toISOString();
        await writeJsonFile(checkpointPath, checkpoint);
        await writeJsonFile(latestResultPath, {
          status: "failed",
          failure,
          providerId: providerId ?? null,
          model: model ?? null,
        });
        console.log(JSON.stringify({ event: "stop_on_fail", failure }));
        process.exitCode = 2;
        return;
      }

      const run = runResponse.body as PromptPackRunRecord;
      if (run.status !== "completed" || !run.runId) {
        const failure = failureFrom(test, `run_not_completed:${run.status ?? "unknown"}`, undefined, run);
        checkpoint.failed = failure;
        checkpoint.updatedAt = new Date().toISOString();
        await writeJsonFile(checkpointPath, checkpoint);
        await writeJsonFile(latestResultPath, {
          status: "failed",
          failure,
          providerId: providerId ?? null,
          model: model ?? null,
        });
        console.log(JSON.stringify({ event: "stop_on_fail", failure }));
        process.exitCode = 2;
        return;
      }

      const scoreResponse = await injectJson<JsonRecord>(
        app,
        {
          headers: {
            ...headers,
            "Idempotency-Key": `stop-on-fail-score:${run.runId}:${Date.now()}`,
          },
          method: "POST",
          url: `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(test.testId)}/auto-score`,
          payload: {
            runId: run.runId,
            force: true,
            ...(providerId ? { providerId } : {}),
            ...(model ? { model } : {}),
          },
        },
      );

      const reportResponse = await injectJson<PromptPackReport>(
        app,
        {
          headers,
          method: "GET",
          url: `/api/v1/prompt-packs/${encodeURIComponent(packId)}/report`,
        },
      );
      const report = typeof reportResponse.body === "object" && reportResponse.body != null ? (reportResponse.body as PromptPackReport) : undefined;

      if (!scoreResponse.ok) {
        const failure = failureFrom(test, `auto_score_failed:${scoreResponse.status}:${summarizeBody(scoreResponse.body)}`, report, run);
        checkpoint.failed = failure;
        checkpoint.updatedAt = new Date().toISOString();
        await writeJsonFile(checkpointPath, checkpoint);
        await writeJsonFile(latestResultPath, {
          status: "failed",
          failure,
          providerId: providerId ?? null,
          model: model ?? null,
        });
        console.log(JSON.stringify({ event: "stop_on_fail", failure }));
        process.exitCode = 2;
        return;
      }

      const assessment = report ? latestAssessmentForTest(report, test.testId) : undefined;
      const verdict = assessment?.effectiveVerdict ?? null;
      if (verdict !== "pass") {
        const failure = failureFrom(test, `non_pass_verdict:${verdict ?? "missing"}`, report, run);
        checkpoint.failed = failure;
        checkpoint.updatedAt = new Date().toISOString();
        await writeJsonFile(checkpointPath, checkpoint);
        await writeJsonFile(latestResultPath, {
          status: "failed",
          failure,
          providerId: providerId ?? null,
          model: model ?? null,
        });
        console.log(JSON.stringify({ event: "stop_on_fail", failure }));
        process.exitCode = 2;
        return;
      }

      if (!alreadyPassed.has(code)) {
        checkpoint.passedCodes.push(code);
        alreadyPassed.add(code);
      }
      if (checkpoint.failed?.code === code) {
        checkpoint.failed = undefined;
      }
      checkpoint.updatedAt = new Date().toISOString();
      await writeJsonFile(checkpointPath, checkpoint);
      await writeJsonFile(latestResultPath, {
        status: "passed",
        code,
        testId: test.testId,
        runId: run.runId,
        effectiveVerdict: verdict,
        passedCodes: checkpoint.passedCodes,
        providerId: providerId ?? null,
        model: model ?? null,
      });
      console.log(
        JSON.stringify({
          event: "passed_test",
          code,
          runId: run.runId,
          passedCount: checkpoint.passedCodes.length,
          totalTests: allTests.length,
        }),
      );
    }

    checkpoint.completed = checkpoint.passedCodes.length >= allTests.length;
    checkpoint.updatedAt = new Date().toISOString();
    await writeJsonFile(checkpointPath, checkpoint);
    await writeJsonFile(latestResultPath, {
      status: checkpoint.completed ? "completed" : "partial_pass",
      passedCodes: checkpoint.passedCodes,
      totalTests: allTests.length,
      providerId: providerId ?? null,
      model: model ?? null,
    });
    console.log(
      JSON.stringify({
        event: checkpoint.completed ? "all_done" : "invocation_complete",
        passed: checkpoint.passedCodes.length,
        totalTests: allTests.length,
      }),
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "runner_error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  process.exitCode = 1;
});
