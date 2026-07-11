import { randomUUID } from "node:crypto";
import {
  HEARTBEAT_PERMISSION_PROFILE_ID,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
  type ChatSendMessageRequest,
  type ToolInvokeRequest,
  type ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import { SUBAGENT_FANOUT_MAX_SUBTASKS, SUBAGENT_FANOUT_TOOL_NAME } from "@goatcitadel/policy-engine";
import type {
  OrchestrationPlan,
  OrchestrationStepExecutionResult,
  OrchestrationTaskInput,
} from "../orchestration/types.js";
import { resolvePreparedTurnMode, type PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
// Type-only: erased at runtime, so the stream service's value import of this
// module does not create an import cycle.
import type { ChatTurnStreamHost } from "./chat-turn-stream-service.js";

export { SUBAGENT_FANOUT_MAX_SUBTASKS, SUBAGENT_FANOUT_TOOL_NAME };

/**
 * R3-8 model-callable spawn tool (`agent.fanout`), gateway side.
 *
 * The policy engine owns policy/approval/audit and dispatches an authorized
 * invoke to the gateway through the `subagentFanout` runtime hook (mirroring
 * `schedule.manage`). This module supplies the gateway half:
 *
 *  - {@link parseSubagentFanoutSubtasks}: untrusted-args validation (≤3
 *    subtasks, non-empty objectives, clamped lengths).
 *  - {@link SubagentFanoutRuntime}: resolves the invoke to the executor the
 *    active chat turn registered for its session. Fails closed when the kill
 *    switch `subagentFanoutV1Disabled` is on, when args are malformed, or when
 *    no turn is live — the tool can never silently no-op.
 *  - {@link createSubagentFanoutExecutor}: runs each subtask through the
 *    existing delegated-step machinery (`executeDelegatedPlanStep`, injected by
 *    the stream service) concurrently, bounded at
 *    {@link SUBAGENT_FANOUT_MAX_SUBTASKS}, and aggregates buffered per-subtask
 *    results. Children inherit the delegated-step hard floors
 *    (`subagentPolicy:"off"`, `orchestrationEnabled:false`), so recursion is
 *    impossible by construction.
 */

/** Per-subtask child-output excerpt cap — mirrors the delegated prior-step handoff excerpt (3,000 chars). */
export const SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT = 3_000;

const SUBTASK_OBJECTIVE_MAX_LENGTH = 2_000;
const SUBTASK_LABEL_MAX_LENGTH = 120;
const SUBTASK_EXPECTED_OUTPUT_MAX_LENGTH = 500;
const PARENT_OBJECTIVE_MAX_LENGTH = 2_000;

export interface SubagentFanoutSubtask {
  objective: string;
  label?: string;
  expectedOutput?: string;
}

export type SubagentFanoutParseResult = { ok: true; subtasks: SubagentFanoutSubtask[] } | { ok: false; error: string };

export type SubagentFanoutExecutor = (input: { subtasks: SubagentFanoutSubtask[] }) => Promise<Record<string, unknown>>;

/** The subset of `executeDelegatedPlanStep`'s input this service constructs. */
export interface SubagentFanoutDelegatedStepInput {
  task: OrchestrationTaskInput;
  plan: OrchestrationPlan;
  priorSteps: OrchestrationStepExecutionResult[];
  step: OrchestrationPlan["steps"][number];
  stepIndex: number;
  runId: string;
  signal?: AbortSignal;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ChatSendMessageRequest["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyContext?: ToolPolicyActorContext;
  fullWebAccess?: boolean;
  canonicalWriteFence?: <T>(work: () => T) => T;
}

export type SubagentFanoutRunDelegatedStep = (
  host: ChatTurnStreamHost,
  prepared: PreparedAgentChatTurn,
  input: SubagentFanoutDelegatedStepInput,
) => Promise<OrchestrationStepExecutionResult>;

export interface SubagentFanoutExecutorOptions {
  /**
   * The delegated-step runner — in production always
   * `executeDelegatedPlanStep`, bound by the stream service's
   * `createTurnSubagentFanoutExecutor` wrapper (injected here instead of
   * imported to keep this module out of an import cycle with the stream
   * service).
   */
  runDelegatedStep: SubagentFanoutRunDelegatedStep;
  signal?: AbortSignal;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ChatSendMessageRequest["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyContext?: ToolPolicyActorContext;
  fullWebAccess?: boolean;
  canonicalWriteFence?: <T>(work: () => T) => T;
}

function truncateWithLimit(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

export function parseSubagentFanoutSubtasks(args: Record<string, unknown>): SubagentFanoutParseResult {
  const raw = args.subtasks;
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      error: `${SUBAGENT_FANOUT_TOOL_NAME} requires a subtasks array with 1..${SUBAGENT_FANOUT_MAX_SUBTASKS} entries.`,
    };
  }
  if (raw.length > SUBAGENT_FANOUT_MAX_SUBTASKS) {
    return {
      ok: false,
      error: `${SUBAGENT_FANOUT_TOOL_NAME} accepts at most ${SUBAGENT_FANOUT_MAX_SUBTASKS} subtasks per call; merge or drop the extras and call again.`,
    };
  }
  const subtasks: SubagentFanoutSubtask[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `Subtask ${index + 1} must be an object with a non-empty string objective.` };
    }
    const record = entry as Record<string, unknown>;
    const objective = typeof record.objective === "string" ? record.objective.trim() : "";
    if (!objective) {
      return { ok: false, error: `Subtask ${index + 1} needs a non-empty string objective.` };
    }
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const expectedOutput = typeof record.expectedOutput === "string" ? record.expectedOutput.trim() : "";
    subtasks.push({
      objective: truncateWithLimit(objective, SUBTASK_OBJECTIVE_MAX_LENGTH),
      ...(label ? { label: truncateWithLimit(label, SUBTASK_LABEL_MAX_LENGTH) } : {}),
      ...(expectedOutput
        ? { expectedOutput: truncateWithLimit(expectedOutput, SUBTASK_EXPECTED_OUTPUT_MAX_LENGTH) }
        : {}),
    });
  }
  return { ok: true, subtasks };
}

/**
 * Registration-side eligibility gate: only Chat-normalized turns whose
 * subagentPolicy explicitly permits automatic subagents may hold a live fan-out
 * executor. `ask_when_useful` is a suggestion/confirmation posture, not a
 * model-callable auto-run. Delegated child turns are floored to
 * `subagentPolicy:"off"` by `executeDelegatedPlanStep`, so they can never
 * register one — which keeps the no-recursion guarantee independent of the
 * tool-schema gate. Even a child model that hallucinates an `agent.fanout` call
 * (or a provider that ignores the advertised schema) finds no executor and the
 * runtime hook fails closed.
 */
function isRestrictedAutonomousPermissionProfile(permissionProfileId?: string): boolean {
  return (
    permissionProfileId === SCHEDULED_TURN_PERMISSION_PROFILE_ID ||
    permissionProfileId === HEARTBEAT_PERMISSION_PROFILE_ID
  );
}

export function shouldRegisterSubagentFanoutExecutor(
  prepared: PreparedAgentChatTurn,
  permissionProfileId?: string,
): boolean {
  if (isRestrictedAutonomousPermissionProfile(permissionProfileId)) {
    return false;
  }
  const mode = resolvePreparedTurnMode(prepared);
  if (mode !== "chat") {
    return false;
  }
  return (prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy) === "auto_when_useful";
}

/**
 * Session-scoped registry that connects the policy engine's `subagentFanout`
 * runtime hook (gateway-lifetime) to the turn-scoped fan-out executor. The
 * entry/stream turn services register an executor for the duration of a direct
 * turn (gated by {@link shouldRegisterSubagentFanoutExecutor}) and dispose it
 * in their `finally`; delegated child turns never register one, so — beyond
 * the schema gate — an `agent.fanout` call from a child fails closed here too.
 */
export class SubagentFanoutRuntime {
  private readonly executorsBySession = new Map<string, { token: symbol; executor: SubagentFanoutExecutor }>();

  public constructor(private readonly options: { isDisabled?: () => boolean } = {}) {}

  /**
   * Register the executor for a session's active turn. Returns a disposer that
   * removes only its own registration: if a newer turn re-registered in the
   * meantime, a stale disposer is a no-op (token compare), so overlapping
   * turn teardown can never evict the live turn's executor.
   */
  public register(sessionId: string, executor: SubagentFanoutExecutor): () => void {
    const token = Symbol("subagent-fanout-executor");
    this.executorsBySession.set(sessionId, { token, executor });
    return () => {
      const current = this.executorsBySession.get(sessionId);
      if (current?.token === token) {
        this.executorsBySession.delete(sessionId);
      }
    };
  }

  public async execute(request: ToolInvokeRequest): Promise<Record<string, unknown>> {
    if (this.options.isDisabled?.() === true) {
      throw new Error(`${SUBAGENT_FANOUT_TOOL_NAME} is disabled by the subagentFanoutV1Disabled kill switch.`);
    }
    const parsed = parseSubagentFanoutSubtasks(request.args ?? {});
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const entry = this.executorsBySession.get(request.sessionId);
    if (!entry) {
      throw new Error(
        `${SUBAGENT_FANOUT_TOOL_NAME} has no active chat turn for this session (no fan-out executor is registered).`,
      );
    }
    return entry.executor({ subtasks: parsed.subtasks });
  }
}

/** Mirrors the orchestration engine's bounded worker-pool mapper; results keep item order. */
async function mapWithBoundedConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  mapper: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(limit)));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index] as TItem, index);
      }
    }),
  );
  return results;
}

function buildSyntheticFanoutPlan(input: {
  prepared: PreparedAgentChatTurn;
  mode: OrchestrationTaskInput["mode"];
  subtasks: SubagentFanoutSubtask[];
}): OrchestrationPlan {
  return {
    workflowTemplate: "model.subagent.fanout",
    routeDecision: {
      modePolicy: input.mode,
      workflowTemplate: "model.subagent.fanout",
      hidden: false,
      visibility: "summarized",
      intensity: "minimal",
      providerPreference: input.prepared.prefs.orchestrationProviderPreference ?? "balanced",
      reviewDepth: input.prepared.prefs.orchestrationReviewDepth ?? "off",
      parallelism: "parallel",
      selectedRoles: ["worker"],
      selectedProviders: [],
      triggerReason: `Model-requested ${SUBAGENT_FANOUT_TOOL_NAME} subtask fan-out`,
    },
    summary: `Model-requested fan-out of ${input.subtasks.length} independent subtask(s) via ${SUBAGENT_FANOUT_TOOL_NAME}.`,
    source: "workflow_template",
    steps: input.subtasks.map((subtask, index) => ({
      stepId: `fanout-${index + 1}`,
      index,
      role: "worker",
      label: subtask.label ?? `Subtask ${index + 1}`,
      stage: 1,
      objective: subtask.objective,
      expectedOutput: subtask.expectedOutput,
      parallelizable: true,
      dependsOnStepIds: [],
    })),
  };
}

function toFailedStepResult(
  step: OrchestrationPlan["steps"][number],
  index: number,
  startedAt: string,
  error: unknown,
): OrchestrationStepExecutionResult {
  const finishedAt = new Date().toISOString();
  return {
    stepId: step.stepId,
    role: step.role,
    label: step.label,
    index,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    citations: [],
  };
}

export function createSubagentFanoutExecutor(
  host: ChatTurnStreamHost,
  prepared: PreparedAgentChatTurn,
  options: SubagentFanoutExecutorOptions,
): SubagentFanoutExecutor {
  return async ({ subtasks }) => {
    const runId = `subagent-fanout:${prepared.turnId}:${randomUUID().slice(0, 8)}`;
    const mode = resolvePreparedTurnMode(prepared);
    const task: OrchestrationTaskInput = {
      sessionId: prepared.session.sessionId,
      workspaceId: prepared.workspaceId,
      mode,
      objective: truncateWithLimit(prepared.content, PARENT_OBJECTIVE_MAX_LENGTH),
      prefs: prepared.prefs,
      conversation: [],
      historyMessages: [],
    };
    const plan = buildSyntheticFanoutPlan({ prepared, mode, subtasks });

    const stepResults = await mapWithBoundedConcurrency(
      plan.steps,
      SUBAGENT_FANOUT_MAX_SUBTASKS,
      async (step, index) => {
        const startedAt = new Date().toISOString();
        try {
          return await options.runDelegatedStep(host, prepared, {
            task,
            plan,
            priorSteps: [],
            step,
            stepIndex: index,
            runId,
            signal: options.signal,
            operatorId: options.operatorId,
            authActorId: options.authActorId,
            authActorSource: options.authActorSource,
            permissionProfileId: options.permissionProfileId,
            localOperatorOverrideId: options.localOperatorOverrideId,
            policyContext: options.policyContext,
            fullWebAccess: options.fullWebAccess,
            canonicalWriteFence: options.canonicalWriteFence,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            (error.name === "DurableWorkerInterruptionError" ||
              error.name === "DurableRunPausedError" ||
              error.name === "DurableRunCancelledError")
          ) {
            throw error;
          }
          // executeDelegatedPlanStep shapes its own failures; this catch only
          // guards the fan-out from an unexpected throw so one subtask can never
          // sink its siblings.
          return toFailedStepResult(step, index, startedAt, error);
        }
      },
    );

    const results = stepResults.map((step, index) => {
      const subtask = subtasks[index] as SubagentFanoutSubtask;
      const rawOutput = step.output?.trim() ?? "";
      const output = rawOutput.slice(0, SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT);
      const status = step.status === "completed" ? "completed" : step.status === "running" ? "incomplete" : "failed";
      return {
        index,
        objective: subtask.objective,
        ...(subtask.label ? { label: subtask.label } : {}),
        status,
        ...(step.summary ? { summary: step.summary } : {}),
        ...(output ? { output } : {}),
        ...(rawOutput.length > output.length ? { outputTruncated: true } : {}),
        ...(step.waitStatus ? { waitStatus: step.waitStatus } : {}),
        ...(step.error ? { error: step.error } : {}),
        ...(step.failureGuidance ? { failureGuidance: step.failureGuidance } : {}),
        ...(step.childSessionId ? { childSessionId: step.childSessionId } : {}),
        ...(step.childTurnId ? { childTurnId: step.childTurnId } : {}),
        ...(typeof step.durationMs === "number" ? { durationMs: step.durationMs } : {}),
      };
    });
    const completedCount = results.filter((entry) => entry.status === "completed").length;
    const failedCount = results.length - completedCount;
    const guidance = [
      "Each subtask ran as an isolated subagent that cannot spawn further subagents.",
      results.some((entry) => entry.status === "incomplete")
        ? "At least one subagent parked waiting (e.g. on an approval) and did not finish within this call."
        : undefined,
      "Synthesize the per-subtask outputs yourself before answering.",
    ]
      .filter(Boolean)
      .join(" ");

    return {
      status: completedCount === results.length ? "completed" : completedCount > 0 ? "partial" : "failed",
      subtaskCount: results.length,
      completedCount,
      failedCount,
      runId,
      results,
      guidance,
    };
  };
}
