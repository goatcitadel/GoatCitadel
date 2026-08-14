import {
  HEARTBEAT_PERMISSION_PROFILE_ID,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
  type ChatSendMessageRequest,
  type ToolInvokeRequest,
  type ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import { SUBAGENT_FANOUT_MAX_SUBTASKS, SUBAGENT_FANOUT_TOOL_NAME } from "@goatcitadel/policy-engine";
import { resolvePreparedTurnMode, type PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { ChatDurableFanoutService } from "./chat-durable-fanout-service.js";
import type { ChatTurnStreamHost } from "./chat-turn-stream-service.js";

export { SUBAGENT_FANOUT_MAX_SUBTASKS, SUBAGENT_FANOUT_TOOL_NAME };

/** Per-child committed-output excerpt cap for the model-facing tool result. */
export const SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT = 3_000;

const SUBTASK_OBJECTIVE_MAX_LENGTH = 2_000;
const SUBTASK_LABEL_MAX_LENGTH = 120;
const SUBTASK_EXPECTED_OUTPUT_MAX_LENGTH = 500;

export interface SubagentFanoutSubtask {
  objective: string;
  label?: string;
  expectedOutput?: string;
}

export type SubagentFanoutParseResult = { ok: true; subtasks: SubagentFanoutSubtask[] } | { ok: false; error: string };

/** The runtime injects server-owned parent/tool identities from ToolInvokeRequest. */
export type SubagentFanoutExecutor = (input: {
  subtasks: SubagentFanoutSubtask[];
  toolRunId?: string;
  parentRunId?: string;
}) => Promise<Record<string, unknown>>;

export interface SubagentFanoutExecutorOptions {
  /**
   * The only production execution path. The legacy in-memory delegated-step
   * mapper is intentionally not retained as a fallback: disabled or missing
   * durable wiring must fail closed before a child can start.
   */
  durableFanout?: Pick<ChatDurableFanoutService, "execute">;
  signal?: AbortSignal;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ChatSendMessageRequest["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyContext?: ToolPolicyActorContext;
  fullWebAccess?: boolean;
  canonicalWriteFence?: <T>(work: () => T | Promise<T>) => Promise<Awaited<T>>;
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
 * Registration eligibility is intentionally only the explicit Chat selector.
 * Exact project/grant authority is rechecked by the durable aggregate at tool
 * execution and before every child dispatch; a stale UI selection cannot
 * create a child.
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
  if (prepared.routedContextSnapshot || isRestrictedAutonomousPermissionProfile(permissionProfileId)) return false;
  if (resolvePreparedTurnMode(prepared) !== "chat") return false;
  return (prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy) === "auto_when_useful";
}

/**
 * Session-scoped bridge from policy-engine authorization to the active Chat
 * turn. It deliberately contains no child execution state: canonical fan-out
 * identity and recovery live in `chat_fanout_invocations` plus delegation rows.
 */
export class SubagentFanoutRuntime {
  private readonly executorsBySession = new Map<string, { token: symbol; executor: SubagentFanoutExecutor }>();

  public constructor(
    private readonly options: {
      isDisabled?: () => boolean | Promise<boolean>;
      /** New default-off rollout. Undefined is fail-closed, never legacy fallback. */
      isDurableEnabled?: () => boolean | Promise<boolean>;
    } = {},
  ) {}

  public register(sessionId: string, executor: SubagentFanoutExecutor): () => void {
    const token = Symbol("subagent-fanout-executor");
    this.executorsBySession.set(sessionId, { token, executor });
    return () => {
      const current = this.executorsBySession.get(sessionId);
      if (current?.token === token) this.executorsBySession.delete(sessionId);
    };
  }

  public async execute(request: ToolInvokeRequest): Promise<Record<string, unknown>> {
    if ((await this.options.isDisabled?.()) === true) {
      throw new Error(`${SUBAGENT_FANOUT_TOOL_NAME} is disabled by the subagentFanoutV1Disabled kill switch.`);
    }
    if ((await this.options.isDurableEnabled?.()) !== true) {
      throw new Error(`${SUBAGENT_FANOUT_TOOL_NAME} is unavailable because durable Chat fan-out rollout is disabled.`);
    }
    const parsed = parseSubagentFanoutSubtasks(request.args ?? {});
    if (!parsed.ok) throw new Error(parsed.error);
    const entry = this.executorsBySession.get(request.sessionId);
    if (!entry) {
      throw new Error(`${SUBAGENT_FANOUT_TOOL_NAME} has no active chat turn for this session.`);
    }
    return await entry.executor({
      subtasks: parsed.subtasks,
      toolRunId: request.toolRunId,
      parentRunId: request.runId,
    });
  }
}

/**
 * Binds a turn to the durable aggregate. `host` remains part of the signature
 * for composition symmetry with the stream service, but execution intentionally
 * does not route through the old in-memory delegated-step bridge.
 */
export function createSubagentFanoutExecutor(
  _host: ChatTurnStreamHost,
  prepared: PreparedAgentChatTurn,
  options: SubagentFanoutExecutorOptions,
): SubagentFanoutExecutor {
  return async ({ subtasks, toolRunId, parentRunId }) => {
    if (!options.durableFanout) {
      throw new Error("Durable Chat fan-out is not configured; automatic fan-out fails closed.");
    }
    return await options.durableFanout.execute({
      prepared,
      subtasks,
      toolRunId,
      parentRunId,
      signal: options.signal,
      operatorId: options.operatorId,
      authActorId: options.authActorId,
      authActorSource: options.authActorSource,
      permissionProfileId: options.permissionProfileId,
      localOperatorOverrideId: options.localOperatorOverrideId,
      policyContext: options.policyContext,
      fullWebAccess: options.fullWebAccess,
    });
  };
}
