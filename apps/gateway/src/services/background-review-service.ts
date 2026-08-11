import { createHash } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmApiStyle,
  ModelUsageAttributionContext,
  OperatorProfileFact,
  OperatorProfileFactKind,
} from "@goatcitadel/contracts";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";
import { runBoundedUtilityModelCall } from "./utility-model-call.js";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";

/**
 * P2-S1 — Background-review (the self-improvement learning loop).
 *
 * After a *successful* root turn, the agent reflects on the just-completed
 * transcript and produces candidate material for later governed review. It
 * never writes OperatorProfile state, skill lifecycle state, or skill files;
 * the durable post-commit owner may separately submit filtered facts to the
 * governed trace-candidate inbox.
 *
 * Implementation: the proven, lower-risk **structured-extraction** pattern (the
 * same shape as the F3 commitment classifier) rather than a replayed,
 * tool-restricted delegated agent fork. We make cheap, read-only model call(s)
 * that emit strict JSON (no tool calls). Durable receipts retain only counts,
 * stable fingerprints, and candidate ids; raw facts may live only in the
 * governed proposal owner and raw skill suggestions remain response-local.
 *
 * Safety:
 *   - Runs ONLY on successful, human, non-eval, non-replay sessions (the caller
 *     resolves these guards and passes them in; this service re-asserts them).
 *   - An ANTI-SELF-POISONING filter drops transient / environment-dependent
 *     failures and negative tool claims so the agent cannot harden a one-off
 *     error into a durable rule or a refusal.
 *   - It has no mutation dependencies, so extraction cannot directly promote
 *     memory or skill state even if autonomy is enabled.
 *   - The whole pass is best-effort: any model/parse error is swallowed
 *     so it can never crash or fail the turn path.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_FACTS_PER_REVIEW = 8;
const MAX_FACT_LENGTH = 280;
const MIN_FACT_CONFIDENCE = 0.6;
const MAX_SKILL_SUMMARY_CHARS = 400;

const VALID_FACT_KINDS: readonly OperatorProfileFactKind[] = ["preference", "goal", "constraint", "fact"];

/**
 * Phrases that mark a "rule" as environment-dependent, transient, or a negative
 * tool claim. Any extracted fact matching one of these is dropped — capturing it
 * durably would let a one-off failure harden into a refusal next session. This is
 * the spirit of Hermes' anti-self-poisoning blocklist, applied as a hard
 * post-parse filter (the prompt also instructs the model to avoid them).
 */
const SELF_POISONING_PATTERNS: readonly RegExp[] = [
  // Negative tool / capability claims that would harden into refusals.
  /\b(can'?t|cannot|unable to|won'?t be able to|not able to|do not have access|don'?t have access|no access)\b/i,
  /\b(tool|api|endpoint|service|command|mcp|connector)\b[^.]*\b(fail|failed|failing|broke|broken|unavailable|down|error|errored|timed out|timeout|not working|doesn'?t work|didn'?t work)\b/i,
  /\b(always|never)\s+(fails?|works?|errors?|times? out)\b/i,
  // Transient / environment-specific conditions that are not durable truths.
  /\b(rate[- ]?limit|429|503|502|500|network error|connection (refused|reset|timed out)|offline|temporarily)\b/i,
  /\b(this (time|session|turn|run)|right now|at the moment|currently (?:un)?available|for now)\b/i,
  // Self-referential noise about the failure rather than the operator.
  /\b(retry|retried|try again|the previous (attempt|call|run))\b/i,
];

/** A durable operator fact as emitted by the memory-extraction model call. */
export interface BackgroundReviewMemoryFact {
  kind: OperatorProfileFactKind;
  content: string;
  confidence: number;
}

/** A skill suggestion as emitted by the skill-suggestion model call. */
export interface BackgroundReviewSkillSuggestion {
  /** Whether the model judged a reusable procedure worth authoring emerged. */
  shouldAuthor: boolean;
  /** Response-local description of the reusable procedure. Never persisted raw. */
  summary?: string;
}

export interface BackgroundReviewTurnInput {
  sessionId: string;
  /** The completed turn that produced this review input. */
  sourceTurnId: string;
  workspaceId: string;
  userText: string;
  assistantText: string;
  /** Honor the master autonomy kill switch (`autonomyV1Disabled`). */
  autonomyEnabled: boolean;
  /** Eval-integrity turns must never produce side effects. */
  evalIntegrityTurn?: boolean;
  /** Non-human / machine sessions (replay scratch, prompt-pack, subagent) are skipped. */
  humanSession?: boolean;
  /** Only successful turns are reviewed (failed turns teach nothing durable). */
  turnSucceeded?: boolean;
  /** Abort signal so a slow review never outlives anything that cares. */
  signal?: AbortSignal;
  /** Deterministic durable effect identity used to dedupe candidate authoring on replay. */
  effectExecutionId?: string;
}

export interface BackgroundReviewUsageLineage {
  workspaceId?: string;
  sessionId?: string;
  sourceTurnId?: string;
  effectExecutionId?: string;
}

/** Outcome of a single background review, returned for observability/testing. */
export interface BackgroundReviewResult {
  /** Whether the review actually ran (guards passed + transcript present). */
  ran: boolean;
  /** Filtered facts that are never promoted here; a caller may file governed proposals. */
  memoryFacts: OperatorProfileFact[];
  /** Stable, content-free evidence suitable for durable receipts. */
  memoryEvidenceFingerprints: string[];
  /** Whether the model found a possible reusable procedure. No direct promotion occurs. */
  skillProposed: boolean;
  /** Stable fingerprint of the response-local suggestion, when one exists. */
  skillEvidenceFingerprint?: string;
  /** @deprecated Retained as an always-absent compatibility field during shared-owner migration. */
  summaryMarker?: string;
  /** @deprecated Background review never creates a mutation; retained only for source compatibility. */
  skillMutation?: { skillId: string };
}

export interface BackgroundReviewModelDefaults {
  providerId?: string;
  model?: string;
}

export interface BackgroundReviewServiceDeps {
  /** Cheap, read-only model call (the judge/explainer chokepoint). */
  createChatCompletion(
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
  /** Cheap-model defaults (mirrors the explainer judge-model resolution). */
  resolveModelDefaults(): Promise<BackgroundReviewModelDefaults>;
  /** Resolve the execution api-style so we can gate `response_format`/`temperature`. */
  resolveApiStyle(providerId?: string, model?: string): LlmApiStyle;
  now?: () => Date;
  timeoutMs?: number;
}

export class BackgroundReviewService {
  public constructor(private readonly deps: BackgroundReviewServiceDeps) {}

  /**
   * Run one background-review pass over a completed turn. Best-effort: returns a
   * `ran:false` result (and persists nothing) when guards fail or the transcript
   * is empty, and swallows every downstream error. Never throws.
   */
  public async runBackgroundReview(input: BackgroundReviewTurnInput): Promise<BackgroundReviewResult> {
    const empty: BackgroundReviewResult = {
      ran: false,
      memoryFacts: [],
      memoryEvidenceFingerprints: [],
      skillProposed: false,
    };

    // Re-assert the safety guards even though the caller resolves them: never run
    // on disabled-autonomy, eval-integrity, non-human, or failed turns.
    if (
      !input.autonomyEnabled ||
      input.evalIntegrityTurn === true ||
      input.humanSession === false ||
      input.turnSucceeded === false
    ) {
      return empty;
    }

    const transcript = buildTranscript(input.userText, input.assistantText);
    if (!transcript) {
      return empty;
    }

    // Model outputs stay local to this service. A caller may route filtered
    // memory facts into a governed proposal owner; this service has no write ports.
    const usageLineage: BackgroundReviewUsageLineage = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sourceTurnId: input.sourceTurnId,
      effectExecutionId: input.effectExecutionId,
    };
    const memoryFacts = await this.extractMemoryFacts(transcript, input.signal, usageLineage);
    const suggestion = await this.suggestSkill(transcript, input.signal, usageLineage);
    const skillEvidenceFingerprint = buildBackgroundReviewSkillEvidenceFingerprint(suggestion);
    return {
      ran: true,
      memoryFacts,
      memoryEvidenceFingerprints: buildBackgroundReviewMemoryEvidenceFingerprints(memoryFacts),
      skillProposed: suggestion.shouldAuthor,
      ...(skillEvidenceFingerprint ? { skillEvidenceFingerprint } : {}),
    };
  }

  /**
   * Memory-extraction model call. Read-only, strict JSON, no tool calls. Applies
   * the anti-self-poisoning filter + confidence gate. Returns `[]` on any error.
   */
  public async extractMemoryFacts(
    transcript: string,
    signal?: AbortSignal,
    usageLineage?: BackgroundReviewUsageLineage,
  ): Promise<OperatorProfileFact[]> {
    const content = await this.callStrictJson(
      buildMemorySystemPrompt(),
      buildMemoryUserPrompt(transcript),
      "background_memory_extraction",
      transcript,
      signal,
      usageLineage,
    );
    if (!content) {
      return [];
    }
    return parseMemoryFacts(content);
  }

  public extractTurnMemoryFacts(
    userText: string,
    assistantText: string,
    signal?: AbortSignal,
    usageLineage?: BackgroundReviewUsageLineage,
  ): Promise<OperatorProfileFact[]> {
    return this.extractMemoryFacts(buildTranscript(userText, assistantText), signal, usageLineage);
  }

  /**
   * Skill-suggestion model call. Read-only, strict JSON, no tool calls. Returns a
   * `shouldAuthor:false` suggestion on any error (nothing authored).
   */
  public async suggestSkill(
    transcript: string,
    signal?: AbortSignal,
    usageLineage?: BackgroundReviewUsageLineage,
  ): Promise<BackgroundReviewSkillSuggestion> {
    const content = await this.callStrictJson(
      buildSkillSystemPrompt(),
      buildSkillUserPrompt(transcript),
      "background_skill_suggestion",
      transcript,
      signal,
      usageLineage,
    );
    if (!content) {
      return { shouldAuthor: false };
    }
    return parseSkillSuggestion(content);
  }

  public suggestTurnSkill(
    userText: string,
    assistantText: string,
    signal?: AbortSignal,
    usageLineage?: BackgroundReviewUsageLineage,
  ): Promise<BackgroundReviewSkillSuggestion> {
    return this.suggestSkill(buildTranscript(userText, assistantText), signal, usageLineage);
  }

  // ── internals ────────────────────────────────────────────────────────

  private async callStrictJson(
    system: string,
    user: string,
    utilityKind: "background_memory_extraction" | "background_skill_suggestion",
    transcript: string,
    signal?: AbortSignal,
    usageLineage?: BackgroundReviewUsageLineage,
  ): Promise<string> {
    const defaults = await this.deps.resolveModelDefaults();
    const apiStyle = this.deps.resolveApiStyle(defaults.providerId, defaults.model);
    const request: ChatCompletionRequest = {
      providerId: defaults.providerId,
      model: defaults.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 1_200,
      signal,
    };
    if (apiStyle !== "openai-codex-responses") {
      request.temperature = 0.1;
      request.response_format = { type: "json_object" };
    }

    let response: ChatCompletionResponse;
    try {
      const attribution = createUtilityModelUsageAttribution({
        operationId: buildBackgroundReviewOperationId(utilityKind, transcript, usageLineage),
        utilityKind,
        requestedProviderId: defaults.providerId,
        requestedModelId: defaults.model,
        lineage: {
          workspaceId: usageLineage?.workspaceId,
          sessionId: usageLineage?.sessionId,
          turnId: usageLineage?.sourceTurnId,
          durableRunId: usageLineage?.effectExecutionId,
          agentId: "background-reviewer",
          parentOperationId: usageLineage?.sourceTurnId
            ? `chat-turn:${encodeURIComponent(usageLineage.sourceTurnId)}`
            : undefined,
        },
      });
      response = await runBoundedUtilityModelCall({
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        timeoutMessage: "background review model call timed out",
        parentSignal: signal,
        start: (boundedSignal) => this.deps.createChatCompletion({ ...request, signal: boundedSignal }, attribution),
      });
    } catch (error) {
      if (isAuthoritativeModelUsageAccountingError(error)) {
        throw error;
      }
      // Hidden best-effort pass: never surface a review failure to the turn.
      return "";
    }
    return extractMessageContent(response);
  }
}

// ── pure helpers ───────────────────────────────────────────────────────

function buildMemorySystemPrompt(): string {
  return (
    "You review a single completed chat transcript and distill DURABLE facts about the operator " +
    "(the human user) that will still be true in a future, unrelated session. These become a " +
    "cross-session memory of who they are.\n\n" +
    "Capture ONLY stable, operator-centric truths: standing preferences, recurring goals, hard " +
    "constraints, and durable personal facts.\n\n" +
    "STRICT EXCLUSIONS — never record any of these (they would poison future sessions):\n" +
    "- Transient or environment-dependent conditions (a tool/API failing, a timeout, a rate limit, " +
    "something 'currently unavailable', anything true only 'this session' or 'right now').\n" +
    "- Negative capability/tool claims (e.g. 'cannot use X', 'tool Y is broken', 'X always fails'). " +
    "These would harden into refusals — never record them.\n" +
    "- One-off task details, the contents of this specific request, or anything you are not confident " +
    "is durable.\n" +
    "- Secrets, credentials, API keys, tokens, or passwords.\n\n" +
    "If nothing durable emerged, return an empty list. Prefer fewer, higher-confidence facts. " +
    "Return STRICT JSON only."
  );
}

function buildMemoryUserPrompt(transcript: string): string {
  return (
    "From the transcript below, extract durable operator facts as JSON.\n" +
    'Return an object: { "facts": [ { "kind", "content", "confidence" } ] }.\n' +
    "- kind: one of preference | goal | constraint | fact\n" +
    "- content: a concise, self-contained statement about the operator (not about this task)\n" +
    "- confidence: a number between 0 and 1 (how durable/certain this fact is)\n\n" +
    `TRANSCRIPT:\n${transcript}`
  );
}

function buildSkillSystemPrompt(): string {
  return (
    "You review a single completed chat transcript and decide whether a REUSABLE, repeatable " +
    "procedure emerged that may be worth a later governed skill proposal — a generalizable " +
    "method, not a one-off answer. You produce evidence only and never author a skill.\n\n" +
    "Mark a possible procedure ONLY when ALL hold:\n" +
    "- A concrete, repeatable procedure was demonstrated (steps that would help next time).\n" +
    "- It generalizes beyond this exact request.\n" +
    "- It does NOT encode transient failures, environment quirks, or 'tool X is broken' claims.\n" +
    "- It contains NO secrets, credentials, network calls, scripts, or executable commands.\n\n" +
    "If no durable procedure emerged, set shouldAuthor=false and omit summary. Never emit Markdown, " +
    "code, commands, or an activation request. Return STRICT JSON only."
  );
}

function buildSkillUserPrompt(transcript: string): string {
  return (
    "From the transcript below, decide whether one reusable procedure may merit governed review.\n" +
    'Return an object: { "shouldAuthor", "summary" }.\n' +
    "- shouldAuthor: boolean — true only if a genuinely reusable procedure emerged\n" +
    "- summary: a short, non-sensitive description of the procedure; no Markdown or commands\n\n" +
    `TRANSCRIPT:\n${transcript}`
  );
}

function buildBackgroundReviewOperationId(
  utilityKind: "background_memory_extraction" | "background_skill_suggestion",
  transcript: string,
  lineage?: BackgroundReviewUsageLineage,
): string {
  const logicalTurn = lineage?.effectExecutionId ?? lineage?.sourceTurnId;
  const stableRef = logicalTurn
    ? encodeURIComponent(logicalTurn)
    : createHash("sha256").update(transcript).digest("hex").slice(0, 32);
  return `background-review:${stableRef}:${utilityKind}`;
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

function parseMemoryFacts(content: string): OperatorProfileFact[] {
  const parsed = parseLooseJson(content);
  if (parsed === undefined) {
    return [];
  }
  const list = extractList(parsed, "facts");
  const out: OperatorProfileFact[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const fact = normalizeFact(entry);
    if (!fact) {
      continue;
    }
    const key = `${fact.kind}::${fact.content.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(fact);
    if (out.length >= MAX_FACTS_PER_REVIEW) {
      break;
    }
  }
  return out;
}

function normalizeFact(entry: unknown): OperatorProfileFact | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const content = normalizeText(entry.content, MAX_FACT_LENGTH);
  if (content === undefined) {
    return undefined;
  }
  // Anti-self-poisoning: drop transient / environment-failure / negative-tool
  // "facts" so a one-off error can never harden into a durable rule or refusal.
  if (isSelfPoisoning(content)) {
    return undefined;
  }
  // The former OperatorProfile mutation boundary also blocked secrets. Because
  // this service now persists only fingerprints, keep the same gate before a
  // secret can influence even derived durable evidence.
  if (looksSensitiveEvidence(content)) {
    return undefined;
  }
  const confidence = normalizeConfidence(entry.confidence);
  // Confidence-gate: only durable, high-confidence facts persist.
  if (confidence < MIN_FACT_CONFIDENCE) {
    return undefined;
  }
  return { kind: normalizeFactKind(entry.kind), content, confidence };
}

function parseSkillSuggestion(content: string): BackgroundReviewSkillSuggestion {
  const parsed = parseLooseJson(content);
  if (!isRecord(parsed)) {
    return { shouldAuthor: false };
  }
  const shouldAuthor = parsed.shouldAuthor === true;
  if (!shouldAuthor) {
    return { shouldAuthor: false };
  }
  const summary = normalizeText(parsed.summary, MAX_SKILL_SUMMARY_CHARS);
  if (summary === undefined || looksUnsafeSkillEvidence(summary)) {
    return { shouldAuthor: false };
  }
  return {
    shouldAuthor: true,
    summary,
  };
}

export function buildBackgroundReviewMemoryEvidenceFingerprints(facts: OperatorProfileFact[]): string[] {
  const fingerprints = facts.flatMap((fact) => {
    const normalized = normalizeFact(fact);
    return normalized
      ? [
          stableEvidenceFingerprint(
            `${normalized.kind}\n${normalized.content.trim().toLowerCase()}\n${normalized.confidence.toFixed(6)}`,
          ),
        ]
      : [];
  });
  return [...new Set(fingerprints)].sort((left, right) => left.localeCompare(right));
}

export function buildBackgroundReviewSkillEvidenceFingerprint(
  suggestion: BackgroundReviewSkillSuggestion,
): string | undefined {
  if (!suggestion.shouldAuthor) {
    return undefined;
  }
  const summary = normalizeText(suggestion.summary, MAX_SKILL_SUMMARY_CHARS);
  return summary && !looksUnsafeSkillEvidence(summary)
    ? stableEvidenceFingerprint(summary.trim().toLowerCase())
    : undefined;
}

// ── primitive normalizers ──────────────────────────────────────────────

function isSelfPoisoning(content: string): boolean {
  return SELF_POISONING_PATTERNS.some((pattern) => pattern.test(content));
}

function normalizeFactKind(value: unknown): OperatorProfileFactKind {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase() as OperatorProfileFactKind;
    if (VALID_FACT_KINDS.includes(lowered)) {
      return lowered;
    }
  }
  return "fact";
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeText(value: unknown, maxLength: number, options: { trim?: boolean } = {}): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const shouldTrim = options.trim !== false;
  const candidate = shouldTrim ? value.trim() : value;
  if (candidate.trim().length === 0) {
    return undefined;
  }
  return truncate(candidate, maxLength);
}

function parseLooseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return undefined;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

function extractList(parsed: unknown, key: string): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed) && Array.isArray(parsed[key])) {
    return parsed[key] as unknown[];
  }
  return [];
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

function stableEvidenceFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function looksUnsafeSkillEvidence(value: string): boolean {
  return (
    /(^|\s)(?:rm\s+-|del\s+\/|curl\s+|wget\s+|powershell\s+|bash\s+|cmd\s+\/)/i.test(value) ||
    looksSensitiveEvidence(value) ||
    /```|---\s*$|<script/i.test(value)
  );
}

function looksSensitiveEvidence(value: string): boolean {
  return (
    /api[_-]?key|token|secret|password|private[_-]?key|bearer\s+[a-z0-9._-]+/i.test(value) ||
    /\bsk-[a-z0-9-]{8,}\b/i.test(value) ||
    /\bghp_[a-z0-9]{10,}\b/i.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
