import { randomUUID } from "node:crypto";
import type {
  AgentCommitmentKind,
  AgentCommitmentRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  CommitmentClassification,
  LlmApiStyle,
} from "@goatcitadel/contracts";
import { COMMITMENT_CONFIDENCE_THRESHOLD } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

/**
 * Post-turn commitment classifier (P1-F3).
 *
 * After a *successful* turn, a cheap hidden model call reads the transcript
 * already in scope (no tool calls — a read-only LLM pass) and infers future
 * follow-up check-ins the user never explicitly scheduled. Only entries with
 * confidence ≥ {@link COMMITMENT_CONFIDENCE_THRESHOLD} are persisted, deduped on
 * `(sessionId, dedupeKey)`. Secrets are never persisted as suggested text.
 *
 * Safety: this service makes a single read-only completion. It is invoked
 * fire-and-forget beside learned-memory extraction and is gated by the master
 * autonomy switch + eval-integrity / non-human guards in {@link recordTurnCommitments}.
 */

const VALID_KINDS: readonly AgentCommitmentKind[] = ["follow_up", "deadline", "reminder", "check_in"];
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TRANSCRIPT_CHARS = 6_000;
const MAX_COMMITMENTS_PER_TURN = 5;
const MAX_SUGGESTED_TEXT_CHARS = 400;

export interface CommitmentClassifierModelDefaults {
  providerId?: string;
  model?: string;
}

export interface CommitmentClassifierTurnInput {
  sessionId: string;
  workspaceId: string;
  userText: string;
  assistantText: string;
  /** Abort signal so a slow classify never outlives its turn. */
  signal?: AbortSignal;
}

/**
 * Inputs for the fire-and-forget host callback. Carries the guards the gateway
 * resolves per-turn so the classifier can skip ineligible turns cheaply.
 */
export interface RecordTurnCommitmentsInput extends CommitmentClassifierTurnInput {
  /** Honor the master autonomy kill switch (`autonomyV1Disabled`). */
  autonomyEnabled: boolean;
  /** Eval-integrity turns must never produce side effects. */
  evalIntegrityTurn?: boolean;
  /** Non-human / machine sessions (replay scratch, prompt-pack, subagent) are skipped. */
  humanSession?: boolean;
}

export interface CommitmentClassifierServiceDeps {
  readonly storage: Pick<Storage, "agentCommitments">;
  /** Cheap, read-only model call (the judge/explainer chokepoint). */
  createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  /** Cheap-model defaults (mirrors the explainer judge-model resolution). */
  resolveModelDefaults(): CommitmentClassifierModelDefaults;
  /** Resolve the execution api-style so we can gate `response_format`/`temperature`. */
  resolveApiStyle(providerId?: string, model?: string): LlmApiStyle;
  now?: () => Date;
  uuid?: () => string;
  timeoutMs?: number;
}

export class CommitmentClassifierService {
  public constructor(private readonly deps: CommitmentClassifierServiceDeps) {}

  /**
   * Classify a completed turn's transcript into zero or more inferred follow-up
   * check-ins. Pure read: makes one model call, returns the parsed structured
   * output, persists nothing. Returns `[]` on empty input or any model/parse error.
   */
  public async classifyTurnForCommitments(input: CommitmentClassifierTurnInput): Promise<CommitmentClassification[]> {
    const transcript = buildTranscript(input.userText, input.assistantText);
    if (!transcript) {
      return [];
    }
    const defaults = this.deps.resolveModelDefaults();
    const apiStyle = this.deps.resolveApiStyle(defaults.providerId, defaults.model);
    const nowIso = this.clockNow().toISOString();

    const request: ChatCompletionRequest = {
      providerId: defaults.providerId,
      model: defaults.model,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(transcript, nowIso) },
      ],
      max_tokens: 500,
      signal: input.signal,
    };
    if (apiStyle !== "openai-codex-responses") {
      request.temperature = 0.1;
      request.response_format = { type: "json_object" };
    }

    let response: ChatCompletionResponse;
    try {
      response = await withTimeout(
        this.deps.createChatCompletion(request),
        this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        "commitment classifier timed out",
      );
    } catch {
      // Hidden best-effort pass: never surface classifier failure to the turn.
      return [];
    }

    const content = extractMessageContent(response);
    if (!content) {
      return [];
    }
    return parseCommitments(content, nowIso);
  }

  /**
   * Fire-and-forget post-turn entry point. Skips ineligible turns, classifies,
   * confidence-gates, blocks secrets, and upserts (dedupe wins). Persisted
   * commitments are returned for observability/testing; failures are swallowed.
   */
  public async recordTurnCommitments(input: RecordTurnCommitmentsInput): Promise<AgentCommitmentRecord[]> {
    if (!input.autonomyEnabled || input.evalIntegrityTurn === true || input.humanSession === false) {
      return [];
    }
    const classifications = await this.classifyTurnForCommitments(input);
    if (classifications.length === 0) {
      return [];
    }
    const nowIso = this.clockNow().toISOString();
    const persisted: AgentCommitmentRecord[] = [];
    for (const classification of classifications) {
      if (classification.confidence < COMMITMENT_CONFIDENCE_THRESHOLD) {
        continue;
      }
      if (looksSensitive(classification.suggestedText) || looksSensitive(classification.dedupeKey)) {
        continue;
      }
      try {
        const record = this.deps.storage.agentCommitments.upsertByDedupe(
          {
            commitmentId: this.makeUuid(),
            sessionId: input.sessionId,
            workspaceId: input.workspaceId,
            kind: classification.kind,
            dueAt: classification.dueAt,
            confidence: classification.confidence,
            dedupeKey: classification.dedupeKey,
            suggestedText: classification.suggestedText,
            createdBy: "classifier",
          },
          nowIso,
        );
        persisted.push(record);
      } catch {
        // Intentionally continue: a single bad row never aborts the rest.
      }
    }
    return persisted;
  }

  private clockNow(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private makeUuid(): string {
    return this.deps.uuid ? this.deps.uuid() : randomUUID();
  }
}

// ── pure helpers ─────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return (
    "You infer future follow-up check-ins from a chat transcript. " +
    "A follow-up is something the assistant could proactively check in on later — e.g. the user mentions " +
    "an interview tomorrow ⇒ a 'how did it go?' check-in. Only infer check-ins that are genuinely useful and " +
    "time-anchored. If nothing warrants a follow-up, return an empty list. Never invent personal data. " +
    "Return STRICT JSON only."
  );
}

function buildUserPrompt(transcript: string, nowIso: string): string {
  return (
    `The current time is ${nowIso}.\n\n` +
    "From the transcript below, list inferred follow-up check-ins as JSON.\n" +
    'Return an object: { "commitments": [ { "kind", "dueAt", "confidence", "dedupeKey", "suggestedText" } ] }.\n' +
    "- kind: one of follow_up | deadline | reminder | check_in\n" +
    "- dueAt: an ISO-8601 timestamp in the future (when the check-in should fire)\n" +
    "- confidence: a number between 0 and 1\n" +
    "- dedupeKey: a short stable slug identifying this follow-up (e.g. 'interview-acme-followup')\n" +
    "- suggestedText: the check-in message to send when due\n\n" +
    `TRANSCRIPT:\n${transcript}`
  );
}

function buildTranscript(userText: string, assistantText: string): string {
  const user = (userText ?? "").trim();
  const assistant = (assistantText ?? "").trim();
  if (!user && !assistant) {
    return "";
  }
  const parts: string[] = [];
  if (user) {
    parts.push(`User: ${user}`);
  }
  if (assistant) {
    parts.push(`Assistant: ${assistant}`);
  }
  return truncate(parts.join("\n\n"), MAX_TRANSCRIPT_CHARS);
}

function parseCommitments(content: string, nowIso: string): CommitmentClassification[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return [];
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }

  const list = extractCommitmentList(parsed);
  const out: CommitmentClassification[] = [];
  const seenKeys = new Set<string>();
  for (const entry of list) {
    const normalized = normalizeCommitment(entry, nowIso);
    if (!normalized) {
      continue;
    }
    if (seenKeys.has(normalized.dedupeKey)) {
      continue;
    }
    seenKeys.add(normalized.dedupeKey);
    out.push(normalized);
    if (out.length >= MAX_COMMITMENTS_PER_TURN) {
      break;
    }
  }
  return out;
}

function extractCommitmentList(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed) && Array.isArray(parsed.commitments)) {
    return parsed.commitments;
  }
  return [];
}

function normalizeCommitment(entry: unknown, nowIso: string): CommitmentClassification | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const kind = normalizeKind(entry.kind);
  const dueAt = normalizeFutureIso(entry.dueAt, nowIso);
  const confidence = normalizeConfidence(entry.confidence);
  const dedupeKey = normalizeSlug(entry.dedupeKey);
  const suggestedText = normalizeText(entry.suggestedText);
  if (!dueAt || dedupeKey === undefined || suggestedText === undefined) {
    return undefined;
  }
  return { kind, dueAt, confidence, dedupeKey, suggestedText };
}

function normalizeKind(value: unknown): AgentCommitmentKind {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase() as AgentCommitmentKind;
    if (VALID_KINDS.includes(lowered)) {
      return lowered;
    }
  }
  return "follow_up";
}

function normalizeFutureIso(value: unknown, nowIso: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) {
    return undefined;
  }
  // Reject past due dates — a check-in must fire in the future.
  if (parsedMs <= Date.parse(nowIso)) {
    return undefined;
  }
  return new Date(parsedMs).toISOString();
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeSlug(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug.length > 0 ? slug : undefined;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return truncate(trimmed, MAX_SUGGESTED_TEXT_CHARS);
}

/**
 * Secret detector mirroring the learned-memory post-turn gate
 * (`chat-learned-memory-service.ts`). Secrets are never persisted as commitment
 * text, regardless of autonomy level.
 */
function looksSensitive(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /api[_-]?key|token|secret|password|private[_-]?key|bearer\s+[a-z0-9._-]+/i.test(normalized) ||
    /\bsk-[a-z0-9-]{8,}\b/i.test(normalized) ||
    /\bghp_[a-z0-9]{10,}\b/i.test(normalized)
  );
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
