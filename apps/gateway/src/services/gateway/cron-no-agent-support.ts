import type { CronJobRecord } from "@goatcitadel/contracts";

export const EXPERIMENTAL_NO_AGENT_CRON_ENV = "GOATCITADEL_EXPERIMENTAL_NO_AGENT_CRON";

type NoAgentRunHandler = (input: {
  command: string;
  args?: string[];
  workdir?: string;
  timeoutMs?: number;
}) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;

type CronActionUpdateInput = {
  name?: string;
  action?: CronJobRecord["action"];
  description?: string;
  schedule?: string;
  enabled?: boolean;
  endAt?: string | null;
  actionConfig?: unknown;
  workdir?: string | null;
  contextFrom?: string | null;
  lastRunOutput?: string | null;
  lastRunId?: string | null;
};

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
  const timeoutMs =
    typeof rawNoAgent.timeoutMs === "number" && Number.isFinite(rawNoAgent.timeoutMs) && rawNoAgent.timeoutMs > 0
      ? Math.floor(rawNoAgent.timeoutMs)
      : undefined;
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
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(deliveryChannel ? { deliveryChannel } : {}),
    },
  };
}

export function isCronActionEnabledForScheduledRun(action: CronJobRecord["action"]): boolean {
  return action !== "no_agent" || isExperimentalNoAgentCronEnabled();
}

export function assertCronActionMutationAllowed(
  action: CronJobRecord["action"],
  operation: "create" | "update",
  current?: CronJobRecord,
  input?: CronActionUpdateInput,
): void {
  if (action !== "no_agent" || isExperimentalNoAgentCronEnabled()) {
    return;
  }
  if (operation === "update" && current?.action === "no_agent" && input && isOnlyNoAgentDisableUpdate(input)) {
    return;
  }
  throw new Error(buildNoAgentCronDisabledMessage());
}

export function assertExperimentalNoAgentCronEnabled(): void {
  if (!isExperimentalNoAgentCronEnabled()) {
    throw new Error(buildNoAgentCronDisabledMessage());
  }
}

export function isExperimentalNoAgentCronEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env[EXPERIMENTAL_NO_AGENT_CRON_ENV]?.trim() ?? "");
}

export function buildNoAgentCronDisabledMessage(): string {
  return `no_agent cron execution is experimental and disabled by default. Set ${EXPERIMENTAL_NO_AGENT_CRON_ENV}=true only for local, explicitly governed experiments.`;
}

export async function runNoAgentCronJob(input: {
  job: CronJobRecord;
  normalizedJobId: string;
  runId: string;
  runHandler: NoAgentRunHandler;
  upsertCronJob: (job: CronJobRecord, updatedAt: string) => CronJobRecord;
  persistCronJobsConfig: () => void;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => void;
  computeNextCronRunAt: (schedule: string, from: Date, endAt?: string) => string | undefined;
}): Promise<Record<string, unknown>> {
  assertExperimentalNoAgentCronEnabled();
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
  const stdoutTrimmed = runResult.stdout.replace(/\r?\n$/, "");
  const hasOutput = stdoutTrimmed.length > 0;
  const saved = input.upsertCronJob(
    {
      ...input.job,
      lastRunAt: finishedAt,
      lastRunOutput: hasOutput ? stdoutTrimmed : undefined,
      lastRunId: input.runId,
      nextRunAt: input.computeNextCronRunAt(input.job.schedule, new Date(finishedAt), input.job.endAt),
    },
    finishedAt,
  );
  input.persistCronJobsConfig();
  if (hasOutput) {
    input.publishRealtime("cron_job_run", "cron", {
      type: "cron_no_agent_output",
      jobId: saved.jobId,
      runId: input.runId,
      output: stdoutTrimmed,
      deliveryChannel: noAgentConfig.deliveryChannel,
    });
  }
  if (runResult.timedOut || (runResult.exitCode !== null && runResult.exitCode !== 0)) {
    throw new Error(
      `no_agent cron job failed: ${input.normalizedJobId} (exitCode=${String(runResult.exitCode)}, timedOut=${String(
        runResult.timedOut,
      )})`,
    );
  }
  return {
    ...runResult,
    action: input.job.action,
    runId: input.runId,
    hasOutput,
    nextRunAt: saved.nextRunAt,
  };
}

function isOnlyNoAgentDisableUpdate(input: CronActionUpdateInput): boolean {
  return (
    input.enabled === false &&
    input.name === undefined &&
    input.action === undefined &&
    input.description === undefined &&
    input.schedule === undefined &&
    input.endAt === undefined &&
    input.actionConfig === undefined &&
    input.workdir === undefined &&
    input.contextFrom === undefined &&
    input.lastRunOutput === undefined &&
    input.lastRunId === undefined
  );
}
