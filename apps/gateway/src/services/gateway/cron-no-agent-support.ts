import { redactSecretText, type CronJobRecord } from "@goatcitadel/contracts";
import type { CronJobRuntimeTelemetryPatch } from "@goatcitadel/storage";
import { resolveNoAgentTimeoutMs, type NoAgentRunResult } from "./cron-no-agent-runner.js";

const NO_AGENT_STDERR_SUMMARY_MAX_LENGTH = 300;
/** Bound for the persisted and broadcast copies of stdout (after redaction). */
const NO_AGENT_OUTPUT_MAX_LENGTH = 16 * 1024;

type NoAgentRunHandler = (input: {
  command: string;
  args?: string[];
  workdir?: string;
  timeoutMs?: number;
}) => Promise<NoAgentRunResult>;

export function normalizeNoAgentCronActionConfig(rawValue: Record<string, unknown>): CronJobRecord["actionConfig"] {
  const rawNoAgent =
    rawValue.noAgent && typeof rawValue.noAgent === "object" && !Array.isArray(rawValue.noAgent)
      ? (rawValue.noAgent as Record<string, unknown>)
      : undefined;
  if (!rawNoAgent || typeof rawNoAgent.command !== "string" || !rawNoAgent.command.trim()) {
    throw new Error("no_agent cron job requires actionConfig.noAgent.command.");
  }
  const args = Array.isArray(rawNoAgent.args)
    ? rawNoAgent.args.filter((token): token is string => typeof token === "string")
    : undefined;
  // Always bounded: a missing timeout takes the default, an oversized one is capped.
  const timeoutMs = resolveNoAgentTimeoutMs(
    typeof rawNoAgent.timeoutMs === "number" ? rawNoAgent.timeoutMs : undefined,
  );
  const rawChannel =
    rawNoAgent.deliveryChannel &&
    typeof rawNoAgent.deliveryChannel === "object" &&
    !Array.isArray(rawNoAgent.deliveryChannel)
      ? (rawNoAgent.deliveryChannel as Record<string, unknown>)
      : undefined;
  const deliveryChannel =
    rawChannel && typeof rawChannel.channelKey === "string"
      ? {
          channelKey: rawChannel.channelKey,
          target: typeof rawChannel.target === "string" ? rawChannel.target : undefined,
        }
      : undefined;
  return {
    noAgent: {
      command: rawNoAgent.command.trim(),
      ...(args ? { args } : {}),
      timeoutMs,
      ...(deliveryChannel ? { deliveryChannel } : {}),
    },
  };
}

export async function runNoAgentCronJob(input: {
  job: CronJobRecord;
  normalizedJobId: string;
  runId: string;
  runHandler: NoAgentRunHandler;
  mergeCronJobRuntimeTelemetry: (
    jobId: string,
    patch: CronJobRuntimeTelemetryPatch,
    updatedAt: string,
  ) => CronJobRecord | Promise<CronJobRecord>;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => Promise<unknown>;
  computeNextCronRunAt: (schedule: string, from: Date, endAt?: string) => string | undefined;
}): Promise<Record<string, unknown>> {
  const noAgentConfig = input.job.actionConfig?.noAgent;
  if (!noAgentConfig?.command) {
    throw new Error(`no_agent cron job missing command: ${input.normalizedJobId}`);
  }
  const runResult = await input.runHandler({
    command: noAgentConfig.command,
    args: noAgentConfig.args,
    workdir: input.job.workdir,
    timeoutMs: noAgentConfig.timeoutMs,
  });
  const finishedAt = new Date().toISOString();
  const stdoutTrimmed = boundRedactedOutput(runResult.stdout.replace(/\r?\n$/, ""), runResult.stdoutTruncated);
  const hasOutput = stdoutTrimmed.length > 0;
  const failed = runResult.timedOut || (runResult.exitCode !== null && runResult.exitCode !== 0);
  // A spawn error settles with exitCode null and no timeout; that is a failed run too.
  const spawnFailed = runResult.exitCode === null && !runResult.timedOut;
  if (hasOutput) {
    await input.publishRealtime("cron_job_run", "cron", {
      type: "cron_no_agent_output",
      jobId: input.job.jobId,
      runId: input.runId,
      output: stdoutTrimmed,
      deliveryChannel: noAgentConfig.deliveryChannel,
    });
  }
  if (failed || spawnFailed) {
    // The caller records this as a failed run (lastRunStatus "failed", lastFailure, evidence).
    throw new Error(summarizeNoAgentFailure(input.normalizedJobId, runResult));
  }
  const saved = await input.mergeCronJobRuntimeTelemetry(
    input.job.jobId,
    {
      lastRunAt: finishedAt,
      lastRunOutput: hasOutput ? stdoutTrimmed : null,
      lastRunId: input.runId,
      lastRunStatus: "ok",
      lastFailureAt: null,
      lastFailure: null,
      failureCount: 0,
      backoffUntil: null,
      nextRunAt: input.computeNextCronRunAt(input.job.schedule, new Date(finishedAt), input.job.endAt) ?? null,
    },
    finishedAt,
  );
  return {
    result: "ok",
    action: input.job.action,
    exitCode: runResult.exitCode,
    timedOut: false,
    ...(runResult.stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(runResult.stderrTruncated ? { stderrTruncated: true } : {}),
    runId: input.runId,
    hasOutput,
    nextRunAt: saved.nextRunAt,
  };
}

/** Failed-run summary: exit code, timeout flag, and a bounded, redacted stderr tail. */
function summarizeNoAgentFailure(
  normalizedJobId: string,
  runResult: Pick<NoAgentRunResult, "stderr" | "exitCode" | "timedOut" | "spawnErrorCode">,
): string {
  const stderr = redactSecretText(runResult.stderr.replace(/\s+/g, " ").trim()).value;
  const bounded =
    stderr.length > NO_AGENT_STDERR_SUMMARY_MAX_LENGTH
      ? `...${stderr.slice(stderr.length - NO_AGENT_STDERR_SUMMARY_MAX_LENGTH + 3)}`
      : stderr;
  return `no_agent cron job failed: ${normalizedJobId} (exitCode=${String(runResult.exitCode)}, timedOut=${String(
    runResult.timedOut,
  )}${runResult.spawnErrorCode ? `, spawnError=${runResult.spawnErrorCode}` : ""})${bounded ? ` stderr: ${bounded}` : ""}`;
}

/** Redacts secrets, then keeps the tail within the persisted/broadcast bound. */
function boundRedactedOutput(text: string, captureTruncated: boolean | undefined): string {
  const redacted = redactSecretText(text).value;
  if (redacted.length <= NO_AGENT_OUTPUT_MAX_LENGTH && !captureTruncated) {
    return redacted;
  }
  const tail = redacted.slice(Math.max(0, redacted.length - NO_AGENT_OUTPUT_MAX_LENGTH));
  return `[output truncated; showing tail]\n${tail}`;
}
