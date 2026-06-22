import type { CronAgentTurnConfig, CronJobRecord, ToolPolicyActorContext } from "@goatcitadel/contracts";
import { SCHEDULED_TURN_PERMISSION_PROFILE_ID } from "@goatcitadel/contracts";
import { parseSimpleCronSchedule } from "./cron-automation-service.js";

/**
 * Pure support for the model-callable `schedule.manage` tool (P1-F2).
 *
 * The gateway runtime hook (`scheduleManage` in `gateway-service.ts`) routes the
 * three ops here for parsing + validation, then performs the impure cron
 * mutation. Keeping the parsing, anti-recursion bounds, and creator-provenance
 * derivation in this pure module makes them directly unit-testable and keeps the
 * gateway method thin.
 *
 * Safety invariants enforced here (all required by the plan):
 *  - Per-creator cap: a creator may own at most {@link MAX_AGENT_TURN_JOBS_PER_CREATOR}
 *    enabled `agent_turn` jobs.
 *  - Schedule-interval floor: schedules finer than {@link MIN_SCHEDULE_INTERVAL_MINUTES}
 *    are rejected (a "* * * * *" every-minute schedule cannot wake the agent).
 *  - Depth chain cap: a job created from inside a scheduled turn is at depth
 *    >= {@link MAX_SCHEDULE_CHAIN_DEPTH} and is refused, so scheduled work cannot
 *    spawn further schedules. Only interactive callers (depth 0) may create.
 *  - Privilege bound: the creator's actor + permission profile are stamped onto
 *    the created job so F1 fires it bounded to <= the creator's privileges.
 */

/** Max enabled `agent_turn` jobs a single creator may own. */
export const MAX_AGENT_TURN_JOBS_PER_CREATOR = 25;

/** Minimum allowed interval (minutes) between scheduled fires. */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 15;

/** Max chain depth: 0 = created interactively, 1 = created by a scheduled turn. */
export const MAX_SCHEDULE_CHAIN_DEPTH = 1;

export type ScheduleManageOp = "create" | "list" | "cancel";

/**
 * Creator provenance stamped on a created job. Structurally a
 * `CronAgentTurnConfig["createdBy"]` but with `depth` always present (the
 * builder always computes it), so the anti-recursion depth check reads a
 * non-optional value.
 */
export type ScheduleCreatorProvenance = NonNullable<CronAgentTurnConfig["createdBy"]> & { depth: number };

export interface ScheduleManageArgs {
  op: ScheduleManageOp;
  jobId?: string;
  name?: string;
  schedule?: string;
  prompt?: string;
  deliveryChannel?: CronAgentTurnConfig["deliveryChannel"];
  endAt?: string;
}

/**
 * Parse + validate the raw tool args into a typed `schedule.manage` request.
 * Rejects an unknown/missing op. Does not yet apply create-specific validation
 * (that happens in {@link validateScheduleCreate} once we have the creator's
 * existing jobs).
 */
export function parseScheduleManageArgs(args: Record<string, unknown>): ScheduleManageArgs {
  const op = typeof args.op === "string" ? args.op.trim() : "";
  if (op !== "create" && op !== "list" && op !== "cancel") {
    throw new Error('schedule.manage requires op to be one of "create", "list", or "cancel".');
  }
  const jobId = typeof args.jobId === "string" && args.jobId.trim() ? args.jobId.trim() : undefined;
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
  const schedule = typeof args.schedule === "string" && args.schedule.trim() ? args.schedule.trim() : undefined;
  const prompt = typeof args.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : undefined;
  const endAt = typeof args.endAt === "string" && args.endAt.trim() ? args.endAt.trim() : undefined;
  const deliveryChannel = normalizeDeliveryChannelArg(args.deliveryChannel);
  return {
    op,
    ...(jobId ? { jobId } : {}),
    ...(name ? { name } : {}),
    ...(schedule ? { schedule } : {}),
    ...(prompt ? { prompt } : {}),
    ...(endAt ? { endAt } : {}),
    ...(deliveryChannel ? { deliveryChannel } : {}),
  };
}

function normalizeDeliveryChannelArg(value: unknown): CronAgentTurnConfig["deliveryChannel"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const channelKey = typeof raw.channelKey === "string" && raw.channelKey.trim() ? raw.channelKey.trim() : undefined;
  if (!channelKey) {
    return undefined;
  }
  const target = typeof raw.target === "string" && raw.target.trim() ? raw.target.trim() : undefined;
  return { channelKey, ...(target ? { target } : {}) };
}

/**
 * Derive the creator provenance to stamp on a created job from the calling
 * turn's policy context. The created job will fire bounded to this profile.
 * `createdByJobId`/`depth` describe the anti-recursion chain.
 */
export function deriveScheduleCreator(
  policyContext: ToolPolicyActorContext | undefined,
  createdByJobId: string | undefined,
): ScheduleCreatorProvenance {
  const parentDepth = isScheduledTurnContext(policyContext) ? MAX_SCHEDULE_CHAIN_DEPTH : 0;
  const depth = createdByJobId ? parentDepth + 1 : parentDepth;
  return {
    ...(policyContext?.operatorId ? { operatorId: policyContext.operatorId } : {}),
    ...(policyContext?.authActorId ? { authActorId: policyContext.authActorId } : {}),
    ...(policyContext?.permissionProfileId ? { permissionProfileId: policyContext.permissionProfileId } : {}),
    ...(createdByJobId ? { createdByJobId } : {}),
    depth,
  };
}

/** True when the calling turn is itself a restricted scheduled turn. */
export function isScheduledTurnContext(policyContext: ToolPolicyActorContext | undefined): boolean {
  return policyContext?.permissionProfileId === SCHEDULED_TURN_PERMISSION_PROFILE_ID;
}

/**
 * Resolve the stable creator key used to scope the per-creator job cap and the
 * `list`/`cancel` ownership filter. Prefers operatorId, then authActorId. Returns
 * undefined when the caller is unidentified (cap/ownership cannot be scoped).
 */
export function resolveScheduleCreatorKey(policyContext: ToolPolicyActorContext | undefined): string | undefined {
  return policyContext?.operatorId?.trim() || policyContext?.authActorId?.trim() || undefined;
}

/** True when a cron job is an `agent_turn` job owned by the given creator key. */
export function isAgentTurnJobOwnedBy(job: CronJobRecord, creatorKey: string): boolean {
  if (job.action !== "agent_turn") {
    return false;
  }
  const createdBy = job.actionConfig?.agentTurn?.createdBy;
  return createdBy?.operatorId === creatorKey || createdBy?.authActorId === creatorKey;
}

export interface ScheduleCreateValidationInput {
  args: ScheduleManageArgs;
  policyContext: ToolPolicyActorContext | undefined;
  /** All existing cron jobs (used to enforce the per-creator cap). */
  existingJobs: readonly CronJobRecord[];
  createdByJobId?: string;
}

export interface ScheduleCreateValidationResult {
  prompt: string;
  name: string;
  schedule: string;
  endAt?: string;
  deliveryChannel?: CronAgentTurnConfig["deliveryChannel"];
  createdBy: ScheduleCreatorProvenance;
}

/**
 * Validate a `create` op and produce the normalized fields for the new job.
 * Enforces: required prompt + schedule, the interval floor, the depth cap, and
 * the per-creator job cap. Throws a clear, model-readable error on any breach.
 */
export function validateScheduleCreate(input: ScheduleCreateValidationInput): ScheduleCreateValidationResult {
  const { args, policyContext } = input;
  const prompt = args.prompt?.trim();
  if (!prompt) {
    throw new Error('schedule.manage create requires a non-empty "prompt".');
  }
  const schedule = args.schedule?.trim();
  if (!schedule) {
    throw new Error('schedule.manage create requires a "schedule" (cron-style, e.g. "0 9 * * 1").');
  }
  assertScheduleIntervalFloor(schedule);

  const createdBy = deriveScheduleCreator(policyContext, input.createdByJobId);
  // Reject at-or-above the cap (`>=`, not `>`). A scheduled turn that owns a
  // parent job lands at depth 2; one *without* a resolvable parent job still
  // lands at depth === MAX_SCHEDULE_CHAIN_DEPTH (1) — `>` would let that case
  // through (1 > 1 is false) and a scheduled turn could self-schedule. `>=`
  // closes that hole while interactive callers (depth 0) remain allowed.
  if (createdBy.depth >= MAX_SCHEDULE_CHAIN_DEPTH) {
    throw new Error(
      `schedule.manage create refused: schedule chain depth ${createdBy.depth} reaches the maximum of ${MAX_SCHEDULE_CHAIN_DEPTH} (a scheduled turn cannot create deeper schedules).`,
    );
  }

  const creatorKey = resolveScheduleCreatorKey(policyContext);
  if (creatorKey) {
    const ownedEnabled = input.existingJobs.filter(
      (job) => job.enabled && isAgentTurnJobOwnedBy(job, creatorKey),
    ).length;
    if (ownedEnabled >= MAX_AGENT_TURN_JOBS_PER_CREATOR) {
      throw new Error(
        `schedule.manage create refused: you already own ${ownedEnabled} enabled scheduled jobs (limit ${MAX_AGENT_TURN_JOBS_PER_CREATOR}). Cancel one before creating another.`,
      );
    }
  }

  const name = args.name?.trim() || deriveScheduleName(prompt);
  return {
    prompt,
    name,
    schedule,
    ...(args.endAt ? { endAt: args.endAt } : {}),
    ...(args.deliveryChannel ? { deliveryChannel: args.deliveryChannel } : {}),
    createdBy,
  };
}

/**
 * Reject schedules that fire more often than the interval floor. Uses the same
 * `parseSimpleCronSchedule` the cron service uses, so a schedule accepted here is
 * guaranteed parseable by the scheduler. An every-minute (`*` minute) schedule,
 * or an hourly-step schedule with a wildcard minute, both breach the floor.
 */
export function assertScheduleIntervalFloor(schedule: string): void {
  const parsed = parseSimpleCronSchedule(schedule);
  if (!parsed) {
    throw new Error(
      'schedule.manage create: invalid schedule. Use "M H * * *", "M H * * DOW", or "M */N * * *" (optionally with a timezone).',
    );
  }
  const intervalMinutes = estimateScheduleIntervalMinutes(parsed);
  if (intervalMinutes < MIN_SCHEDULE_INTERVAL_MINUTES) {
    throw new Error(
      `schedule.manage create refused: schedule fires too often (~${intervalMinutes} min). The minimum interval is ${MIN_SCHEDULE_INTERVAL_MINUTES} minutes — pin the minute field (e.g. "0 * * * *" or "0 9 * * *").`,
    );
  }
}

/**
 * Conservative lower-bound estimate (in minutes) of how often a parsed schedule
 * fires. A wildcard minute means it fires every matching minute → effectively
 * 1-minute granularity (below the floor). A pinned minute fires at most once an
 * hour (or per hour-step), so >= 60 minutes. We only need to distinguish
 * "finer than the floor" from "at/above it", so the coarse estimate is enough.
 */
function estimateScheduleIntervalMinutes(parsed: NonNullable<ReturnType<typeof parseSimpleCronSchedule>>): number {
  if (parsed.wildcardMinute) {
    // Fires every minute within each matching hour → 1-minute granularity.
    return 1;
  }
  // Minute is pinned → at most one fire per matching hour. The smallest gap is
  // an hour-step of 1 (every hour) → 60 minutes; larger steps/fixed hours are
  // even sparser. Pinned-minute schedules therefore always clear the floor.
  return 60;
}

/** Derive a readable job name from the prompt when none is supplied. */
function deriveScheduleName(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/)[0]?.trim() ?? prompt.trim();
  const collapsed = firstLine.replace(/\s+/g, " ");
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed || "Scheduled turn";
}

/**
 * Build the `agent_turn` actionConfig for a created job, forcing the action
 * surface and embedding the creator provenance. The cron service forces
 * `action:"agent_turn"`; this is the matching actionConfig payload.
 */
export function buildScheduleCreateActionConfig(result: ScheduleCreateValidationResult): {
  agentTurn: CronAgentTurnConfig;
} {
  return {
    agentTurn: {
      prompt: result.prompt,
      ...(result.deliveryChannel ? { deliveryChannel: result.deliveryChannel } : {}),
      deliverMode: "always",
      createdBy: result.createdBy,
    },
  };
}

/** Project a cron job into the model-facing summary returned by `list`. */
export function summarizeScheduleJob(job: CronJobRecord): {
  jobId: string;
  name: string;
  schedule: string;
  enabled: boolean;
  prompt?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  endAt?: string;
} {
  return {
    jobId: job.jobId,
    name: job.name,
    schedule: job.schedule,
    enabled: job.enabled,
    ...(job.actionConfig?.agentTurn?.prompt ? { prompt: job.actionConfig.agentTurn.prompt } : {}),
    ...(job.nextRunAt ? { nextRunAt: job.nextRunAt } : {}),
    ...(job.lastRunAt ? { lastRunAt: job.lastRunAt } : {}),
    ...(job.endAt ? { endAt: job.endAt } : {}),
  };
}
