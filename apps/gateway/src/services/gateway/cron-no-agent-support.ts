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

type NoAgentPublishRealtime = (
  eventType: string,
  source: string,
  payload?: Record<string, unknown>,
) => Promise<unknown>;

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
  publishRealtime: NoAgentPublishRealtime;
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
  const lastRunOutput = hasOutput ? stdoutTrimmed : null;
  if (failed || spawnFailed) {
    // Canonical state first: lastRunOutput is written (or cleared) on the failure path too, so a
    // failed run never leaves an earlier run's output behind. The caller then records the rest of
    // the failure (lastRunStatus "failed", lastFailure, evidence) from the thrown error.
    await input.mergeCronJobRuntimeTelemetry(input.job.jobId, { lastRunOutput }, finishedAt);
    await publishNoAgentOutput(input, noAgentConfig.deliveryChannel, lastRunOutput);
    throw new Error(summarizeNoAgentFailure(input.normalizedJobId, runResult));
  }
  const saved = await input.mergeCronJobRuntimeTelemetry(
    input.job.jobId,
    {
      lastRunAt: finishedAt,
      lastRunOutput,
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
  // Live emission only after the canonical commit; a rejected publish never flips the outcome.
  const outputPublished = await publishNoAgentOutput(input, noAgentConfig.deliveryChannel, lastRunOutput);
  return {
    result: "ok",
    action: input.job.action,
    exitCode: runResult.exitCode,
    timedOut: false,
    ...(runResult.stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(runResult.stderrTruncated ? { stderrTruncated: true } : {}),
    runId: input.runId,
    hasOutput,
    ...(outputPublished === false ? { outputBroadcastFailed: true } : {}),
    nextRunAt: saved.nextRunAt,
  };
}

type NoAgentDeliveryChannel = NonNullable<NonNullable<CronJobRecord["actionConfig"]>["noAgent"]>["deliveryChannel"];

/**
 * Best-effort realtime emission of the already-persisted, redacted, bounded stdout. Returns
 * `undefined` when there is nothing to emit and `false` when the publish rejected. The rejection
 * is swallowed on purpose: the persisted `lastRunOutput` is the canonical copy, and the run summary
 * reports `outputBroadcastFailed` so the miss stays visible.
 */
async function publishNoAgentOutput(
  input: { job: CronJobRecord; runId: string; publishRealtime: NoAgentPublishRealtime },
  deliveryChannel: NoAgentDeliveryChannel,
  output: string | null,
): Promise<boolean | undefined> {
  if (output === null) {
    return undefined;
  }
  try {
    await input.publishRealtime("cron_job_run", "cron", {
      type: "cron_no_agent_output",
      jobId: input.job.jobId,
      runId: input.runId,
      output,
      deliveryChannel,
    });
    return true;
  } catch {
    return false;
  }
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
