import type { ApprovalCreateInput, ChatCompletionRequest, OrchestrationPlan } from "@goatcitadel/contracts";

export interface LlmRequestHookPatch {
  providerId?: string;
  model?: string;
  prependMessages?: ChatCompletionRequest["messages"];
  appendMessages?: ChatCompletionRequest["messages"];
  tools?: Array<Record<string, unknown>>;
  toolChoice?: string | Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type ToolCallHookPatch = Record<string, unknown> & {
  toolName?: string;
  args?: Record<string, unknown>;
};

export interface ApprovalCreateHookPatch {
  riskLevel?: ApprovalCreateInput["riskLevel"];
  payloadMerge?: Record<string, unknown>;
  previewMerge?: Record<string, unknown>;
  expiresAt?: string | null;
}

export interface OrchestrationRunHookPatch {
  maxIterations?: number;
  maxRuntimeMinutes?: number;
  maxCostUsd?: number;
}

export interface OrchestrationPhaseHookPatch {
  ownerAgentId?: string;
  specPath?: string;
  loopMode?: "fresh-context" | "compaction";
  requiresApproval?: boolean;
}

export interface TransformLlmOutputHookPatch {
  content?: string;
  metadata?: Record<string, unknown>;
}

export function parseLlmModelSelectHookPatch(
  value: Record<string, unknown>,
): Pick<LlmRequestHookPatch, "providerId" | "model"> | undefined {
  const providerId =
    typeof value.providerId === "string" && value.providerId.trim() ? value.providerId.trim() : undefined;
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  if (!providerId && !model) {
    return undefined;
  }
  return {
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
  };
}

export function parseLlmRequestHookPatch(value: Record<string, unknown>): LlmRequestHookPatch | undefined {
  const base = parseLlmModelSelectHookPatch(value);
  const prependMessages = parseChatCompletionMessages(value.prependMessages);
  const appendMessages = parseChatCompletionMessages(value.appendMessages);
  const tools = Array.isArray(value.tools)
    ? value.tools.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : undefined;
  const toolChoice =
    typeof value.toolChoice === "string"
      ? value.toolChoice
      : value.toolChoice && typeof value.toolChoice === "object" && !Array.isArray(value.toolChoice)
        ? (value.toolChoice as Record<string, unknown>)
        : undefined;
  const metadata =
    value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? (value.metadata as Record<string, unknown>)
      : undefined;
  if (!base && !prependMessages && !appendMessages && !tools && !toolChoice && !metadata) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(prependMessages ? { prependMessages } : {}),
    ...(appendMessages ? { appendMessages } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function mergeLlmRequestHookPatch(
  current: LlmRequestHookPatch | undefined,
  next: LlmRequestHookPatch,
): LlmRequestHookPatch {
  return {
    ...(current ?? {}),
    ...next,
    ...(current?.prependMessages || next.prependMessages
      ? { prependMessages: [...(current?.prependMessages ?? []), ...(next.prependMessages ?? [])] }
      : {}),
    ...(current?.appendMessages || next.appendMessages
      ? { appendMessages: [...(current?.appendMessages ?? []), ...(next.appendMessages ?? [])] }
      : {}),
    ...(current?.metadata || next.metadata
      ? { metadata: { ...(current?.metadata ?? {}), ...(next.metadata ?? {}) } }
      : {}),
  };
}

export function applyLlmRequestHookPatch(
  request: ChatCompletionRequest,
  patch: LlmRequestHookPatch,
): ChatCompletionRequest {
  return {
    ...request,
    ...(patch.providerId ? { providerId: patch.providerId } : {}),
    ...(patch.model ? { model: patch.model } : {}),
    messages: [...(patch.prependMessages ?? []), ...request.messages, ...(patch.appendMessages ?? [])],
    ...(patch.tools ? { tools: patch.tools } : {}),
    ...(patch.toolChoice ? { tool_choice: patch.toolChoice } : {}),
    ...(patch.metadata ? { metadata: { ...(request.metadata ?? {}), ...patch.metadata } } : {}),
  };
}

export function parseToolCallHookPatch(value: Record<string, unknown>): ToolCallHookPatch | undefined {
  const toolName = typeof value.toolName === "string" && value.toolName.trim() ? value.toolName.trim() : undefined;
  const args =
    value.args && typeof value.args === "object" && !Array.isArray(value.args)
      ? (value.args as Record<string, unknown>)
      : undefined;
  if (!toolName && !args) {
    return undefined;
  }
  return {
    ...(toolName ? { toolName } : {}),
    ...(args ? { args } : {}),
  };
}

export function parseApprovalCreateHookPatch(value: Record<string, unknown>): ApprovalCreateHookPatch | undefined {
  const riskLevel =
    value.riskLevel === "safe" ||
    value.riskLevel === "caution" ||
    value.riskLevel === "danger" ||
    value.riskLevel === "nuclear"
      ? value.riskLevel
      : undefined;
  const payloadMerge =
    value.payloadMerge && typeof value.payloadMerge === "object" && !Array.isArray(value.payloadMerge)
      ? (value.payloadMerge as Record<string, unknown>)
      : undefined;
  const previewMerge =
    value.previewMerge && typeof value.previewMerge === "object" && !Array.isArray(value.previewMerge)
      ? (value.previewMerge as Record<string, unknown>)
      : undefined;
  const expiresAt =
    value.expiresAt === null
      ? null
      : typeof value.expiresAt === "string" && value.expiresAt.trim()
        ? value.expiresAt.trim()
        : undefined;
  if (!riskLevel && !payloadMerge && !previewMerge && expiresAt === undefined) {
    return undefined;
  }
  return {
    ...(riskLevel ? { riskLevel } : {}),
    ...(payloadMerge ? { payloadMerge } : {}),
    ...(previewMerge ? { previewMerge } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export function parseOrchestrationRunHookPatch(value: Record<string, unknown>): OrchestrationRunHookPatch | undefined {
  const maxIterations = parseOptionalPositiveInt(value.maxIterations);
  const maxRuntimeMinutes = parseOptionalPositiveInt(value.maxRuntimeMinutes);
  const maxCostUsd =
    typeof value.maxCostUsd === "number" && Number.isFinite(value.maxCostUsd) && value.maxCostUsd > 0
      ? value.maxCostUsd
      : undefined;
  if (maxIterations === undefined && maxRuntimeMinutes === undefined && maxCostUsd === undefined) {
    return undefined;
  }
  return {
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(maxRuntimeMinutes !== undefined ? { maxRuntimeMinutes } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  };
}

export function parseTransformLlmOutputHookPatch(
  value: Record<string, unknown>,
): TransformLlmOutputHookPatch | undefined {
  const content = typeof value.content === "string" && value.content.trim() ? value.content : undefined;
  const metadata =
    value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? (value.metadata as Record<string, unknown>)
      : undefined;
  if (content === undefined && metadata === undefined) {
    return undefined;
  }
  return {
    ...(content !== undefined ? { content } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function parseOrchestrationPhaseHookPatch(
  value: Record<string, unknown>,
): OrchestrationPhaseHookPatch | undefined {
  const ownerAgentId =
    typeof value.ownerAgentId === "string" && value.ownerAgentId.trim() ? value.ownerAgentId.trim() : undefined;
  const specPath = typeof value.specPath === "string" && value.specPath.trim() ? value.specPath.trim() : undefined;
  const loopMode = value.loopMode === "fresh-context" || value.loopMode === "compaction" ? value.loopMode : undefined;
  const requiresApproval = typeof value.requiresApproval === "boolean" ? value.requiresApproval : undefined;
  if (!ownerAgentId && !specPath && !loopMode && requiresApproval === undefined) {
    return undefined;
  }
  return {
    ...(ownerAgentId ? { ownerAgentId } : {}),
    ...(specPath ? { specPath } : {}),
    ...(loopMode ? { loopMode } : {}),
    ...(requiresApproval !== undefined ? { requiresApproval } : {}),
  };
}

export function applyOrchestrationPhaseHookPatch(
  plan: OrchestrationPlan,
  phaseId: string,
  patch: OrchestrationPhaseHookPatch,
): OrchestrationPlan {
  return {
    ...plan,
    waves: plan.waves.map((wave) => ({
      ...wave,
      phases: wave.phases.map((phase) => {
        if (phase.phaseId !== phaseId) {
          return phase;
        }
        return {
          ...phase,
          ...(patch.ownerAgentId ? { ownerAgentId: patch.ownerAgentId } : {}),
          ...(patch.specPath ? { specPath: patch.specPath } : {}),
          ...(patch.loopMode ? { loopMode: patch.loopMode } : {}),
          ...(patch.requiresApproval !== undefined ? { requiresApproval: patch.requiresApproval } : {}),
        };
      }),
    })),
  };
}

function parseChatCompletionMessages(value: unknown): ChatCompletionRequest["messages"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const messages = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const candidate = item as {
      role?: unknown;
      content?: unknown;
      name?: unknown;
      tool_call_id?: unknown;
    };
    if (
      candidate.role !== "system" &&
      candidate.role !== "developer" &&
      candidate.role !== "user" &&
      candidate.role !== "assistant" &&
      candidate.role !== "tool"
    ) {
      return [];
    }
    if (typeof candidate.content !== "string" && !Array.isArray(candidate.content)) {
      return [];
    }
    return [
      {
        role: candidate.role as ChatCompletionRequest["messages"][number]["role"],
        content: candidate.content,
        ...(typeof candidate.name === "string" && candidate.name.trim() ? { name: candidate.name.trim() } : {}),
        ...(typeof candidate.tool_call_id === "string" && candidate.tool_call_id.trim()
          ? { tool_call_id: candidate.tool_call_id.trim() }
          : {}),
      },
    ];
  });
  return messages.length > 0 ? messages : undefined;
}

function parseOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
