import { createHash } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmApiStyle,
  ModelUsageAttributionContext,
  OperatorProfileFact,
  OperatorProfileFactKind,
} from "@goatcitadel/contracts";
import type { RecordOperatorProfileFactsResult } from "./operator-profile-service.js";
import type {
  DraftSkillMutationInput,
  PreparedSkillMutationPlan,
  SkillMutationResult,
} from "./skill-mutation-service.js";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";
import { runBoundedUtilityModelCall } from "./utility-model-call.js";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";

/**
 * P2-S1 — Background-review (the self-improvement learning loop).
 *
 * After a *successful* root turn, the agent reflects on the just-completed
 * transcript and (a) distills durable, cross-session operator facts and (b) — if
 * a genuinely reusable procedure emerged — authors or patches ONE skill from
 * experience. This is Hermes' core differentiator ported onto GoatCitadel's
 * governance spine, so the agent improves across sessions.
 *
 * Implementation: the proven, lower-risk **structured-extraction** pattern (the
 * same shape as the F3 commitment classifier) rather than a replayed,
 * tool-restricted delegated agent fork. We make cheap, read-only model call(s)
 * that emit strict JSON (no tool calls), then persist via the EXISTING governed
 * services — {@link recordOperatorProfileFacts} (secret-blocked, snapshotted,
 * autonomy-gated) and the skill mutation path (jailed write, validated,
 * candidate-only, snapshotted; auto-promotion is the governed activation path's
 * job, never this service's).
 *
 * Safety:
 *   - Runs ONLY on successful, human, non-eval, non-replay sessions (the caller
 *     resolves these guards and passes them in; this service re-asserts them).
 *   - An ANTI-SELF-POISONING filter drops transient / environment-dependent
 *     failures and negative tool claims so the agent cannot harden a one-off
 *     error into a durable rule or a refusal.
 *   - Secrets are always blocked (the operator-profile gate enforces this).
 *   - With autonomy OFF every write is propose-only (the governed services
 *     enforce this) — this service still runs the extraction but persists nothing
 *     that would auto-apply.
 *   - The whole pass is best-effort: any model/parse/persist error is swallowed
 *     so it can never crash or fail the turn path.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_FACTS_PER_REVIEW = 8;
const MAX_FACT_LENGTH = 280;
const MIN_FACT_CONFIDENCE = 0.6;
const MAX_SKILL_MARKDOWN_CHARS = 8_000;

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
  /** Optional stable skill id; derived from frontmatter name when omitted. */
  skillId?: string;
  /** The full `SKILL.md` (frontmatter + body) to author/patch. */
  skillMarkdown?: string;
  /** Short human-readable summary persisted into provenance. */
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
  /** Facts that survived filtering and were handed to the profile service. */
  memoryFacts: OperatorProfileFact[];
  /** The profile write result, when a memory write was attempted. */
  memoryWrite?: RecordOperatorProfileFactsResult;
  /** The skill mutation result, when a skill was authored/patched. */
  skillMutation?: SkillMutationResult;
  /** Skill suggestion outcome: did the model propose authoring + did it apply. */
  skillProposed: boolean;
  /**
   * A one-line, user-visible summary marker (Hermes "💾 Self-improvement
   * review: …" spirit). Present ONLY when something was actually written.
   */
  summaryMarker?: string;
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
  resolveModelDefaults(): BackgroundReviewModelDefaults;
  /** Resolve the execution api-style so we can gate `response_format`/`temperature`. */
  resolveApiStyle(providerId?: string, model?: string): LlmApiStyle;
  /**
   * Persist durable operator facts via the governed operator-profile service
   * (secrets blocked, snapshotted, autonomy-gated). Returns the write outcome.
   */
  recordOperatorProfileFacts(workspaceId: string, facts: OperatorProfileFact[]): RecordOperatorProfileFactsResult;
  /**
   * Author or patch a single skill via the governed skill-mutation service
   * (validated, jailed, candidate-only, snapshotted). Returns the mutation
   * result. Implementations must NOT promote the skill to callable here.
   */
  draftSkillMutation(input: {
    skillMarkdown: string;
    skillId?: string;
    evaluationRunId?: string;
    sourceTurnId?: string;
    summary?: string;
  }): Promise<SkillMutationResult>;
  prepareDurableSkillMutation(input: DraftSkillMutationInput): PreparedSkillMutationPlan;
  applyPreparedSkillMutationFilesSync(plan: PreparedSkillMutationPlan): void;
  commitPreparedSkillMutation(plan: PreparedSkillMutationPlan): SkillMutationResult;
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
    const empty: BackgroundReviewResult = { ran: false, memoryFacts: [], skillProposed: false };

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

    // (b) Memory extraction → durable facts → governed profile write.
    const usageLineage: BackgroundReviewUsageLineage = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sourceTurnId: input.sourceTurnId,
      effectExecutionId: input.effectExecutionId,
    };
    const memoryFacts = await this.extractMemoryFacts(transcript, input.signal, usageLineage);
    let memoryWrite: RecordOperatorProfileFactsResult | undefined;
    if (memoryFacts.length > 0) {
      memoryWrite = this.safeRecordFacts(input.workspaceId, memoryFacts, Boolean(input.effectExecutionId));
    }

    // (c) Skill suggestion → optionally author/patch ONE skill (candidate).
    const suggestion = await this.suggestSkill(transcript, input.signal, usageLineage);
    let skillMutation: SkillMutationResult | undefined;
    if (suggestion.shouldAuthor && suggestion.skillMarkdown) {
      skillMutation = await this.safeDraftSkill(suggestion, input.sourceTurnId, input.effectExecutionId);
    }

    const summaryMarker = buildSummaryMarker(memoryWrite, skillMutation);
    return {
      ran: true,
      memoryFacts,
      ...(memoryWrite ? { memoryWrite } : {}),
      ...(skillMutation ? { skillMutation } : {}),
      skillProposed: suggestion.shouldAuthor,
      ...(summaryMarker ? { summaryMarker } : {}),
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

  /** Commit precomputed facts through the existing governed profile boundary. */
  public recordMemoryFacts(
    workspaceId: string,
    facts: OperatorProfileFact[],
    options: { strict?: boolean } = {},
  ): RecordOperatorProfileFactsResult | undefined {
    return this.safeRecordFacts(workspaceId, facts, options.strict === true);
  }

  /** Validate and freeze a provider suggestion before durable persistence. */
  public prepareSuggestedSkillMutation(
    suggestion: BackgroundReviewSkillSuggestion,
    sourceTurnId: string | undefined,
    effectExecutionId: string,
  ): PreparedSkillMutationPlan | undefined {
    if (!suggestion.shouldAuthor || !suggestion.skillMarkdown) {
      return undefined;
    }
    return this.deps.prepareDurableSkillMutation(buildSkillMutationInput(suggestion, sourceTurnId, effectExecutionId));
  }

  /** Create or verify the exact plan-owned files outside any database transaction. */
  public applyPreparedSkillMutationFiles(plan: PreparedSkillMutationPlan): void {
    this.deps.applyPreparedSkillMutationFilesSync(plan);
  }

  /** Commit lifecycle state only; the durable caller owns the receipt transaction. */
  public commitPreparedSkillMutation(plan: PreparedSkillMutationPlan): SkillMutationResult {
    return this.deps.commitPreparedSkillMutation(plan);
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
    const defaults = this.deps.resolveModelDefaults();
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

  private safeRecordFacts(
    workspaceId: string,
    facts: OperatorProfileFact[],
    strictPersistence: boolean,
  ): RecordOperatorProfileFactsResult | undefined {
    try {
      return this.deps.recordOperatorProfileFacts(workspaceId, facts);
    } catch (error) {
      if (strictPersistence) {
        throw error;
      }
      // A persistence failure must never crash the background pass.
      return undefined;
    }
  }

  private async safeDraftSkill(
    suggestion: BackgroundReviewSkillSuggestion,
    sourceTurnId?: string,
    effectExecutionId?: string,
  ): Promise<SkillMutationResult | undefined> {
    if (!suggestion.skillMarkdown) {
      return undefined;
    }
    try {
      return await this.deps.draftSkillMutation(buildSkillMutationInput(suggestion, sourceTurnId, effectExecutionId));
    } catch (error) {
      if (effectExecutionId) {
        throw error;
      }
      // Validation/jail/secret rejection (or any write error) is non-fatal: the
      // skill mutation service rejects unsafe drafts by throwing, and a rejected
      // draft must not crash the review.
      return undefined;
    }
  }
}

function buildSkillMutationInput(
  suggestion: BackgroundReviewSkillSuggestion,
  sourceTurnId?: string,
  effectExecutionId?: string,
): {
  skillMarkdown: string;
  skillId?: string;
  evaluationRunId?: string;
  sourceTurnId?: string;
  summary?: string;
} {
  if (!suggestion.skillMarkdown) {
    throw new Error("A skill mutation requires non-empty Markdown.");
  }
  return {
    skillMarkdown: suggestion.skillMarkdown,
    ...(effectExecutionId
      ? { skillId: buildBackgroundReviewEffectSkillId(effectExecutionId), evaluationRunId: effectExecutionId }
      : suggestion.skillId
        ? { skillId: suggestion.skillId }
        : {}),
    ...(sourceTurnId ? { sourceTurnId } : {}),
    ...(suggestion.summary ? { summary: suggestion.summary } : {}),
  };
}

function buildBackgroundReviewEffectSkillId(effectExecutionId: string): string {
  const digest = createHash("sha256").update(effectExecutionId).digest("hex").slice(0, 24);
  return `background-review-${digest}`;
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
    "procedure emerged that is worth capturing as a reusable skill for future sessions — a " +
    "generalizable method, not a one-off answer.\n\n" +
    "Author a skill ONLY when ALL hold:\n" +
    "- A concrete, repeatable procedure was demonstrated (steps that would help next time).\n" +
    "- It generalizes beyond this exact request.\n" +
    "- It does NOT encode transient failures, environment quirks, or 'tool X is broken' claims.\n" +
    "- It contains NO secrets, credentials, network calls, scripts, or executable commands.\n\n" +
    "If no durable procedure emerged, set shouldAuthor=false and omit skillMarkdown. Author AT MOST " +
    "ONE skill. The skill body is plain Markdown documentation (frontmatter + prose steps), never " +
    "code to execute. Return STRICT JSON only."
  );
}

function buildSkillUserPrompt(transcript: string): string {
  return (
    "From the transcript below, decide whether to author one reusable skill.\n" +
    'Return an object: { "shouldAuthor", "skillId", "skillMarkdown", "summary" }.\n' +
    "- shouldAuthor: boolean — true only if a genuinely reusable procedure emerged\n" +
    "- skillId: optional short slug (e.g. 'summarize-csv-exports'); omit to derive from the title\n" +
    "- skillMarkdown: the full SKILL.md (YAML frontmatter with name + description, then Markdown body)\n" +
    "- summary: a one-line description of what the skill captures\n\n" +
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
  const skillMarkdown = normalizeText(parsed.skillMarkdown, MAX_SKILL_MARKDOWN_CHARS, { trim: false });
  if (skillMarkdown === undefined) {
    // Model said author but gave nothing usable: treat as no-op.
    return { shouldAuthor: false };
  }
  const skillId = normalizeSlug(parsed.skillId);
  const summary = normalizeText(parsed.summary, MAX_FACT_LENGTH);
  return {
    shouldAuthor: true,
    skillMarkdown,
    ...(skillId ? { skillId } : {}),
    ...(summary ? { summary } : {}),
  };
}

function buildSummaryMarker(
  memoryWrite: RecordOperatorProfileFactsResult | undefined,
  skillMutation: SkillMutationResult | undefined,
): string | undefined {
  const parts: string[] = [];
  if (memoryWrite && memoryWrite.outcome === "applied" && memoryWrite.record) {
    // Only count it as "remembered" when something actually applied (not blocked
    // / proposed-only under autonomy-off).
    parts.push("updated durable memory");
  } else if (memoryWrite && memoryWrite.outcome === "proposed") {
    parts.push("proposed durable memory");
  }
  if (skillMutation) {
    parts.push(`drafted skill "${skillMutation.skillId}"`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return `💾 Self-improvement review: ${parts.join("; ")}.`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
