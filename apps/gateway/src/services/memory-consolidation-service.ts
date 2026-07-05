import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatTurnTraceRecord,
  TraceMemoryCandidateInput,
  TraceMemoryCandidateRecord,
  TraceMemoryCandidateType,
  TranscriptEvent,
} from "@goatcitadel/contracts";

// Governed background memory consolidation (competitive-gap program phase A3).
//
// Mines recently completed chat-turn traces and PROPOSES memory candidates —
// it never writes approved memory. Every output lands as a `proposed`
// trace-memory candidate (authority: agent_proposed) in the existing operator
// review surface (Memory route), where promotion stays a manual, gated action
// via promoteTraceMemoryCandidate. Two independent gates:
//   - memoryConsolidationV1Enabled must be ON (opt-in, default off)
//   - autonomyV1Disabled must be OFF (master autonomy kill switch)
// Drafting goes through the prompt-runner model-defaults chokepoint, so it
// automatically rides the cheap utility tier once utilityModelRoutingV1Enabled
// lands. Dedup is lexical (token Jaccard) in v1; embedding-based dedup is a
// tracked follow-up.

export const MEMORY_CONSOLIDATION_WATERMARK_SETTING_KEY = "memory_consolidation_watermark_v1";

const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_TRACES_PER_RUN = 500;
const MAX_SESSIONS_PER_RUN = 3;
const MAX_CANDIDATES_PER_SESSION = 5;
const MAX_CANDIDATES_PER_RUN = 10;
const MAX_REFLECTION_ATTEMPTS = 3;
const MIN_CANDIDATE_CONFIDENCE = 0.55;
const SIMILARITY_SKIP_THRESHOLD = 0.6;
const MAX_DIGEST_EVENTS = 40;
const MAX_DIGEST_EVENT_CHARS = 400;
const MAX_DIGEST_TOTAL_CHARS = 6_000;
const MIN_DIGEST_CHARS = 200;
export const EXISTING_LEARNINGS_DEDUP_LIMIT = 200;
export const PENDING_CANDIDATES_DEDUP_LIMIT = 100;

const CANDIDATE_TYPES: ReadonlySet<TraceMemoryCandidateType> = new Set([
  "fact",
  "decision",
  "tool_outcome",
  "operator_preference",
  "repo_fact",
  "workflow",
]);

const CONSOLIDATION_SYSTEM_PROMPT = [
  "You extract durable, reusable insights from an operator's AI session transcript.",
  "Return ONLY a JSON array (no prose) of at most " + String(MAX_CANDIDATES_PER_SESSION) + " items:",
  '[{"type":"fact|decision|tool_outcome|operator_preference|repo_fact|workflow","insight":"...","confidence":0.0-1.0}]',
  "Rules: each insight must stand alone without the transcript, be useful in FUTURE sessions,",
  "and never contain secrets, tokens, or credentials. Prefer fewer, higher-confidence insights.",
  "Return [] when nothing durable was learned.",
].join("\n");

export interface MemoryConsolidationDeps {
  isFeatureEnabled: (
    flag: "memoryConsolidationV1Enabled" | "autonomyV1Disabled" | "memoryLifecycleAdminV1Enabled",
  ) => boolean;
  listCompletedTurnTracesSince: (sinceIso: string, limit: number) => ChatTurnTraceRecord[];
  readTranscriptOrEmpty: (sessionId: string) => Promise<TranscriptEvent[]>;
  createChatCompletion: (request: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
  resolveModelDefaults: () => { providerId?: string; model?: string };
  proposeTraceMemoryCandidate: (
    input: TraceMemoryCandidateInput,
    actorId: string,
  ) => Promise<TraceMemoryCandidateRecord>;
  listExistingInsightsForDedup: () => string[];
  getWatermark: () => string | undefined;
  setWatermark: (iso: string) => void;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => void;
  recordDevDiagnostic?: (input: {
    level: "info" | "warn";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }) => void;
  now?: () => Date;
}

export interface MemoryConsolidationRunSummary {
  status: "disabled" | "skipped_kill_switch" | "completed";
  scannedTurns: number;
  qualifyingTurns: number;
  sessionsSampled: number;
  sessionsFailed: number;
  drafted: number;
  deduplicated: number;
  proposed: number;
  watermark?: string;
  nextWatermark?: string;
}

interface DraftedCandidate {
  candidateType: TraceMemoryCandidateType;
  insight: string;
  confidence: number;
  sessionId: string;
  turnId?: string;
}

export class MemoryConsolidationService {
  public constructor(private readonly deps: MemoryConsolidationDeps) {}

  public async runConsolidation(): Promise<MemoryConsolidationRunSummary> {
    const empty: Omit<MemoryConsolidationRunSummary, "status"> = {
      scannedTurns: 0,
      qualifyingTurns: 0,
      sessionsSampled: 0,
      sessionsFailed: 0,
      drafted: 0,
      deduplicated: 0,
      proposed: 0,
    };
    // memoryLifecycleAdminV1Enabled guards proposeTraceMemoryCandidate itself;
    // treating it as a hard prerequisite keeps this job from throwing mid-run.
    if (
      !this.deps.isFeatureEnabled("memoryConsolidationV1Enabled") ||
      !this.deps.isFeatureEnabled("memoryLifecycleAdminV1Enabled")
    ) {
      return { status: "disabled", ...empty };
    }
    if (this.deps.isFeatureEnabled("autonomyV1Disabled")) {
      return { status: "skipped_kill_switch", ...empty };
    }

    const now = this.deps.now?.() ?? new Date();
    const watermark =
      this.deps.getWatermark() ?? new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const traces = this.deps.listCompletedTurnTracesSince(watermark, MAX_TRACES_PER_RUN);
    const qualifying = traces.filter((trace) => isQualifyingTrace(trace));
    const sessions = pickSessions(qualifying, MAX_SESSIONS_PER_RUN);

    const summary: MemoryConsolidationRunSummary = {
      status: "completed",
      ...empty,
      scannedTurns: traces.length,
      qualifyingTurns: qualifying.length,
      watermark,
    };

    const seenInsights = this.deps.listExistingInsightsForDedup().map(tokenizeInsight);
    for (const session of sessions) {
      // The autonomy kill switch may flip mid-run; re-check before every
      // session so an engaged switch halts further proposals immediately.
      if (this.deps.isFeatureEnabled("autonomyV1Disabled")) {
        summary.status = "skipped_kill_switch";
        break;
      }
      summary.sessionsSampled += 1;
      let drafted: DraftedCandidate[];
      try {
        drafted = await this.draftSessionCandidates(session.sessionId, session.turnIds[0]);
      } catch (error) {
        summary.sessionsFailed += 1;
        this.deps.recordDevDiagnostic?.({
          level: "warn",
          category: "memory",
          event: "memory.consolidation.session_failed",
          message: "Memory consolidation drafting failed for a session",
          context: {
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        continue;
      }
      for (const candidate of drafted) {
        if (summary.proposed >= MAX_CANDIDATES_PER_RUN) {
          break;
        }
        summary.drafted += 1;
        const tokens = tokenizeInsight(candidate.insight);
        if (seenInsights.some((existing) => jaccardSimilarity(existing, tokens) >= SIMILARITY_SKIP_THRESHOLD)) {
          summary.deduplicated += 1;
          continue;
        }
        await this.deps.proposeTraceMemoryCandidate(
          {
            candidateType: candidate.candidateType,
            proposedInsight: candidate.insight,
            confidence: candidate.confidence,
            sourceSessionId: candidate.sessionId,
            sourceTurnId: candidate.turnId,
            metadata: { consolidation: true, consolidationRunKind: "weekly" },
          },
          "memory-consolidation-job",
        );
        seenInsights.push(tokens);
        summary.proposed += 1;
      }
    }

    // Advance the watermark only when the run made real progress: either
    // there was nothing to process, or at least one session drafted cleanly.
    // A run where every sampled session failed retries the same window.
    const madeProgress =
      sessions.length === 0 || summary.sessionsFailed < summary.sessionsSampled || summary.status !== "completed";
    if (summary.status === "completed" && madeProgress && traces.length > 0) {
      const nextWatermark = traces.reduce(
        (latest, trace) => (trace.startedAt > latest ? trace.startedAt : latest),
        watermark,
      );
      this.deps.setWatermark(nextWatermark);
      summary.nextWatermark = nextWatermark;
    } else if (summary.status === "completed" && traces.length === 0) {
      summary.nextWatermark = watermark;
    }

    this.deps.publishRealtime("system", "memory", {
      type: "memory_consolidation_run",
      ...summary,
    });
    return summary;
  }

  private async draftSessionCandidates(sessionId: string, turnId?: string): Promise<DraftedCandidate[]> {
    const events = await this.deps.readTranscriptOrEmpty(sessionId);
    const digest = buildTranscriptDigest(events);
    if (digest.length < MIN_DIGEST_CHARS) {
      return [];
    }
    const defaults = this.deps.resolveModelDefaults();
    const completion = await this.deps.createChatCompletion({
      providerId: defaults.providerId,
      model: defaults.model,
      messages: [
        { role: "system", content: CONSOLIDATION_SYSTEM_PROMPT },
        { role: "user", content: digest },
      ],
      temperature: 0,
      max_tokens: 900,
    });
    const rawContent = completion.choices?.[0]
      ? (completion.choices[0] as { message?: { content?: string } }).message?.content
      : undefined;
    return parseDraftedCandidates(typeof rawContent === "string" ? rawContent : "", sessionId, turnId);
  }
}

function isQualifyingTrace(trace: ChatTurnTraceRecord): boolean {
  if (!trace.assistantMessageId) {
    return false;
  }
  const reflection = trace.reflection;
  if (reflection?.outcome === "still_failed") {
    return false;
  }
  if ((reflection?.attemptCount ?? 0) > MAX_REFLECTION_ATTEMPTS) {
    return false;
  }
  return true;
}

function pickSessions(traces: ChatTurnTraceRecord[], limit: number): Array<{ sessionId: string; turnIds: string[] }> {
  const bySession = new Map<string, string[]>();
  for (const trace of traces) {
    const turnIds = bySession.get(trace.sessionId) ?? [];
    turnIds.push(trace.turnId);
    bySession.set(trace.sessionId, turnIds);
  }
  return Array.from(bySession.entries())
    .map(([sessionId, turnIds]) => ({ sessionId, turnIds }))
    .sort((a, b) => b.turnIds.length - a.turnIds.length)
    .slice(0, limit);
}

function buildTranscriptDigest(events: TranscriptEvent[]): string {
  const lines: string[] = [];
  let total = 0;
  const messages = events.filter((event) => event.type === "message.user" || event.type === "message.assistant");
  for (const event of messages.slice(-MAX_DIGEST_EVENTS)) {
    const text = extractEventText(event.payload);
    if (!text) {
      continue;
    }
    const role = event.type === "message.user" ? "user" : "assistant";
    const line = `${role}: ${text.slice(0, MAX_DIGEST_EVENT_CHARS)}`;
    if (total + line.length > MAX_DIGEST_TOTAL_CHARS) {
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
}

function extractEventText(payload: Record<string, unknown>): string | undefined {
  for (const key of ["text", "content", "message"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function parseDraftedCandidates(content: string, sessionId: string, turnId?: string): DraftedCandidate[] {
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const drafted: DraftedCandidate[] = [];
  for (const item of parsed.slice(0, MAX_CANDIDATES_PER_SESSION)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const insight = typeof record.insight === "string" ? record.insight.trim() : "";
    if (insight.length < 20 || insight.length > 600) {
      continue;
    }
    const confidence =
      typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? Math.max(0, Math.min(1, record.confidence))
        : 0.6;
    if (confidence < MIN_CANDIDATE_CONFIDENCE) {
      continue;
    }
    const rawType = typeof record.type === "string" ? record.type.trim() : "";
    const candidateType = CANDIDATE_TYPES.has(rawType as TraceMemoryCandidateType)
      ? (rawType as TraceMemoryCandidateType)
      : "fact";
    drafted.push({ candidateType, insight, confidence, sessionId, turnId });
  }
  return drafted;
}

export function tokenizeInsight(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}
