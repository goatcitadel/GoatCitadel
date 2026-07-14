import { createHash } from "node:crypto";
import type {
  AgentCommitmentRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmApiStyle,
  ModelUsageAttributionContext,
  TaskRecord,
} from "@goatcitadel/contracts";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";
import { runBoundedUtilityModelCall } from "./utility-model-call.js";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";

/**
 * De-novo origination planner (P1-F5).
 *
 * Reactive proactivity derives every action from the user's most recent message.
 * De-novo origination lets the agent plan *without* a human seed: from open
 * commitments (F3), an open linked task, recent assistant state, and time
 * signals, a cheap hidden planner model proposes a small set of self-initiated
 * actions. De-novo grants **initiative, not new authority** — proposed actions
 * still flow through the restricted-profile `executeProactiveToolAction →
 * invokeTool → engine.invoke` path and the same autonomy budgets.
 *
 * This module is the pure, model-agnostic core: it assembles the planning
 * context, builds the prompt, makes one read-only completion, and normalizes the
 * structured output into planner actions. Confidence is held to a conservative
 * floor so the agent only acts on its own initiative when it is genuinely
 * warranted. Any model/parse failure yields zero actions (silent best-effort).
 */

/** Planner action shape (mirrors `ChatProactiveService`'s internal planned action). */
export interface DeNovoPlannedAction {
  kind: "tool" | "note";
  toolName?: string;
  args?: Record<string, unknown>;
  note?: string;
}

export interface DeNovoPlanResult {
  confidence: number;
  reasoningSummary: string;
  actions: DeNovoPlannedAction[];
}

/** Context assembled from de-novo sources (no last-user message required). */
export interface DeNovoPlanContext {
  /** Pending, not-yet-delivered commitments for the session, oldest-due first. */
  commitments: AgentCommitmentRecord[];
  /** An open linked task to continue, if any. */
  openTask?: Pick<TaskRecord, "taskId" | "title" | "status">;
  /** Recent assistant turn text (most recent first), for situational grounding. */
  recentAssistantText: string[];
  /** ISO-8601 "now" used for time-signal grounding + due comparisons. */
  nowIso: string;
}

export interface DeNovoPlannerModelDeps {
  /** Cheap, read-only model call (the same judge/explainer chokepoint as F3). */
  createChatCompletion(
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
  /** Cheap-model defaults (mirrors the explainer judge-model resolution). */
  resolveModelDefaults(): { providerId?: string; model?: string };
  /** Resolve the execution api-style so we can gate `response_format`/`temperature`. */
  resolveApiStyle(providerId?: string, model?: string): LlmApiStyle;
  /** Abort signal so a slow plan never outlives its tick. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Server-owned durable/proactive lineage supplied by the runtime owner. */
  modelUsageAttribution?: ModelUsageAttributionContext;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_ACTIONS = 3;
const MAX_TOOL_NAME_CHARS = 80;
const MAX_NOTE_CHARS = 400;
const MAX_RECENT_ASSISTANT_CHARS = 1_500;
const MAX_COMMITMENTS_IN_PROMPT = 8;

/**
 * Conservative confidence floor for de-novo: below this, the planner returns no
 * actions (the agent stays silent rather than acting on a weak self-initiated
 * hunch). De-novo is the most autonomous behavior, so the bar is deliberately
 * higher than the reactive heuristic confidence (0.78).
 */
export const DE_NOVO_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Tools the de-novo planner is permitted to *propose*. This is an additional,
 * conservative narrowing layer on top of the policy engine: the restricted
 * permission profile is still the binding authority, but de-novo should never
 * even suggest a mutating tool. Everything not listed is dropped to a note.
 */
const DE_NOVO_PROPOSABLE_TOOLS = new Set<string>([
  "time.now",
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "http.get",
]);

/** True when the assembled context has anything worth planning from. */
export function hasDeNovoContext(context: DeNovoPlanContext): boolean {
  return context.commitments.length > 0 || context.openTask !== undefined;
}

/**
 * Plan self-initiated actions from de-novo context via one cheap model call.
 * Returns `{actions: []}` when there is no context, the model fails/times out,
 * the output is unparseable, or confidence is below the conservative floor.
 */
export async function planDeNovoActions(
  context: DeNovoPlanContext,
  deps: DeNovoPlannerModelDeps,
): Promise<DeNovoPlanResult> {
  if (!hasDeNovoContext(context)) {
    return { confidence: 0.1, reasoningSummary: "No open commitments or tasks to originate from.", actions: [] };
  }

  const defaults = deps.resolveModelDefaults();
  const apiStyle = deps.resolveApiStyle(defaults.providerId, defaults.model);
  const request: ChatCompletionRequest = {
    providerId: defaults.providerId,
    model: defaults.model,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(context) },
    ],
    max_tokens: 500,
    signal: deps.signal,
  };
  if (apiStyle !== "openai-codex-responses") {
    request.temperature = 0.1;
    request.response_format = { type: "json_object" };
  }

  let response: ChatCompletionResponse;
  try {
    const attribution = deps.modelUsageAttribution ?? buildStandaloneDeNovoAttribution(context, request);
    response = await runBoundedUtilityModelCall({
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      timeoutMessage: "de-novo planner timed out",
      parentSignal: deps.signal,
      start: (boundedSignal) => deps.createChatCompletion({ ...request, signal: boundedSignal }, attribution),
    });
  } catch (error) {
    if (isAuthoritativeModelUsageAccountingError(error)) {
      throw error;
    }
    // Hidden best-effort pass: a planner failure never surfaces — just no action.
    return { confidence: 0.1, reasoningSummary: "De-novo planner unavailable.", actions: [] };
  }

  const content = extractMessageContent(response);
  if (!content) {
    return { confidence: 0.1, reasoningSummary: "De-novo planner returned no content.", actions: [] };
  }
  return parsePlan(content);
}

function buildStandaloneDeNovoAttribution(
  context: DeNovoPlanContext,
  request: ChatCompletionRequest,
): ModelUsageAttributionContext {
  const contextFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        commitmentIds: context.commitments.map((item) => item.commitmentId),
        openTaskId: context.openTask?.taskId,
        recentAssistantText: context.recentAssistantText,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return createUtilityModelUsageAttribution({
    operationId: `proactive-denovo:${contextFingerprint}`,
    utilityKind: "proactive_denovo_planning",
    requestedProviderId: request.providerId,
    requestedModelId: request.model,
    lineage: { agentId: "proactive-planner" },
  });
}

// ── prompt builders ──────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return (
    "You are deciding whether an AI assistant should take initiative WITHOUT being prompted by the user. " +
    "You are given the assistant's open commitments (follow-ups it inferred earlier), any open task, and recent context. " +
    "Propose at most a few SAFE, READ-ONLY actions that genuinely advance an open commitment or task right now — " +
    "for example, gathering fresh information the assistant will need to follow up well. " +
    "Be conservative: if nothing clearly warrants self-initiated action, return an empty list with low confidence. " +
    "Never propose actions that send messages, write files, run shells, or change anything. Return STRICT JSON only."
  );
}

function buildUserPrompt(context: DeNovoPlanContext): string {
  const commitmentLines = context.commitments
    .slice(0, MAX_COMMITMENTS_IN_PROMPT)
    .map((commitment) => `- [${commitment.kind}] due ${commitment.dueAt}: ${commitment.suggestedText}`)
    .join("\n");
  const taskLine = context.openTask
    ? `Open task (${context.openTask.status}): ${context.openTask.title}`
    : "No open task.";
  const recent = truncate(context.recentAssistantText.join("\n").trim(), MAX_RECENT_ASSISTANT_CHARS);
  const allowed = [...DE_NOVO_PROPOSABLE_TOOLS].join(", ");
  return (
    `The current time is ${context.nowIso}.\n\n` +
    `OPEN COMMITMENTS:\n${commitmentLines || "(none)"}\n\n` +
    `${taskLine}\n\n` +
    `RECENT ASSISTANT CONTEXT:\n${recent || "(none)"}\n\n` +
    "Decide whether to take initiative now. Return an object:\n" +
    '{ "confidence": number, "reasoning": string, "actions": [ { "kind": "tool"|"note", "toolName"?: string, "args"?: object, "note"?: string } ] }\n' +
    `- confidence: 0..1, how strongly self-initiated action is warranted right now\n` +
    `- actions: at most ${MAX_ACTIONS}; only READ-ONLY tools from: ${allowed}\n` +
    "- prefer an empty list when in doubt; a single note is fine when no tool helps"
  );
}

// ── parsing / normalization ──────────────────────────────────────────

function parsePlan(content: string): DeNovoPlanResult {
  const parsed = parseJsonObject(content);
  if (!parsed) {
    return { confidence: 0.1, reasoningSummary: "De-novo planner output was not valid JSON.", actions: [] };
  }
  const confidence = normalizeConfidence(parsed.confidence);
  const reasoningSummary = normalizeReasoning(parsed.reasoning);
  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions = normalizeActions(rawActions);

  // Conservative gate: below the floor, OR no actionable tool — stay silent.
  if (confidence < DE_NOVO_CONFIDENCE_THRESHOLD) {
    return { confidence, reasoningSummary, actions: [] };
  }
  return { confidence, reasoningSummary, actions };
}

function normalizeActions(raw: unknown[]): DeNovoPlannedAction[] {
  const out: DeNovoPlannedAction[] = [];
  for (const entry of raw) {
    const action = normalizeAction(entry);
    if (action) {
      out.push(action);
    }
    if (out.length >= MAX_ACTIONS) {
      break;
    }
  }
  return out;
}

function normalizeAction(entry: unknown): DeNovoPlannedAction | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const toolName = normalizeToolName(entry.toolName);
  // Only propose tools on the conservative read-only allowlist; anything else
  // (unknown, mutating, or missing) degrades to a note so de-novo never even
  // *suggests* widening the surface.
  if (toolName && DE_NOVO_PROPOSABLE_TOOLS.has(toolName)) {
    return {
      kind: "tool",
      toolName,
      args: isRecord(entry.args) ? (entry.args as Record<string, unknown>) : {},
    };
  }
  const note = normalizeNote(entry.note);
  return note ? { kind: "note", note } : undefined;
}

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().slice(0, MAX_TOOL_NAME_CHARS);
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNote(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? truncate(trimmed, MAX_NOTE_CHARS) : undefined;
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeReasoning(value: unknown): string {
  if (typeof value !== "string") {
    return "De-novo origination plan.";
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? truncate(trimmed, MAX_NOTE_CHARS) : "De-novo origination plan.";
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(match[0]);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

function extractMessageContent(response: ChatCompletionResponse): string {
  const message = response.choices?.[0]?.message;
  if (!message) {
    return "";
  }
  const raw = message.content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? text : "";
      })
      .join("\n");
  }
  return "";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
