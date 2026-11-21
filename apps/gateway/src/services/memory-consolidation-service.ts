import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatTurnTraceRecord,
  ModelUsageAttributionContext,
  TraceMemoryCandidateInput,
  TraceMemoryCandidateRecord,
  TraceMemoryCandidateType,
} from "@goatcitadel/contracts";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
import { createHash, randomUUID } from "node:crypto";
import type { ConsolidationSourceExclusion } from "@goatcitadel/storage";
import {
  MemoryConsolidationWorkSource,
  type ConsolidationSourceBinding,
  type MemoryConsolidationWorkSourceDeps,
} from "./memory-consolidation-work-source.js";

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
const MAX_SOURCE_WINDOWS_PER_RUN = 3;
const MAX_CANDIDATES_PER_SESSION = 5;
const MAX_CANDIDATES_PER_RUN = 10;
const MAX_REFLECTION_ATTEMPTS = 3;
const MIN_CANDIDATE_CONFIDENCE = 0.55;
const SIMILARITY_SKIP_THRESHOLD = 0.6;
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

export interface MemoryConsolidationDeps extends MemoryConsolidationWorkSourceDeps {
  isFeatureEnabled: (
    flag: "memoryConsolidationV1Enabled" | "autonomyV1Disabled" | "memoryLifecycleAdminV1Enabled",
  ) => Promise<boolean>;
  createChatCompletion: (
    request: ChatCompletionRequest,
    attribution: ModelUsageAttributionContext,
  ) => Promise<ChatCompletionResponse>;
  resolveModelDefaults: () => Promise<{ providerId?: string; model?: string }>;
  proposeTraceMemoryCandidate: (
    input: TraceMemoryCandidateInput,
    actorId: string,
  ) => Promise<TraceMemoryCandidateRecord>;
  listExistingInsightsForDedup: (workspaceId: string) => Promise<string[]>;
  publishRealtime: (eventType: string, source: string, payload?: Record<string, unknown>) => Promise<unknown>;
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
  sourceWindowsSampled: number;
  excludedTurns: number;
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
  sourceBinding?: ConsolidationSourceBinding;
}

export class MemoryConsolidationService {
  private readonly workSource: MemoryConsolidationWorkSource;

  public constructor(private readonly deps: MemoryConsolidationDeps) {
    this.workSource = new MemoryConsolidationWorkSource(deps);
  }

  public async runConsolidation(): Promise<MemoryConsolidationRunSummary> {
    const empty: Omit<MemoryConsolidationRunSummary, "status"> = {
      scannedTurns: 0,
      qualifyingTurns: 0,
      sessionsSampled: 0,
      sessionsFailed: 0,
      sourceWindowsSampled: 0,
      excludedTurns: 0,
      drafted: 0,
      deduplicated: 0,
      proposed: 0,
    };
    // memoryLifecycleAdminV1Enabled guards proposeTraceMemoryCandidate itself;
    // treating it as a hard prerequisite keeps this job from throwing mid-run.
    if (
      !(await this.deps.isFeatureEnabled("memoryConsolidationV1Enabled")) ||
      !(await this.deps.isFeatureEnabled("memoryLifecycleAdminV1Enabled"))
    ) {
      return { status: "disabled", ...empty };
    }
    if (await this.deps.isFeatureEnabled("autonomyV1Disabled")) {
      return { status: "skipped_kill_switch", ...empty };
    }

    const summary: MemoryConsolidationRunSummary = { status: "completed", ...empty };
    const now = this.deps.now?.() ?? new Date();
    const workspaces = await this.workSource.listDueWorkspaces();
    for (const { workspaceId, progress } of workspaces.slice(0, 20)) {
      if (
        summary.sessionsSampled >= MAX_SESSIONS_PER_RUN ||
        summary.sourceWindowsSampled >= MAX_SOURCE_WINDOWS_PER_RUN ||
        summary.proposed >= MAX_CANDIDATES_PER_RUN ||
        summary.scannedTurns >= MAX_TRACES_PER_RUN
      )
        break;
      const leaseOwner = randomUUID();
      const claim = await this.workSource.claimProgress(workspaceId, progress.revision, leaseOwner, now.toISOString());
      if (!claim) continue;
      let nextCursor = progress.cursor;
      const sourceExclusions: ConsolidationSourceExclusion[] = [];
      try {
        const after = progress.cursor ?? {
          finishedAt: new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString(),
          turnId: "",
        };
        summary.watermark ??= after.finishedAt;
        const traces = await this.workSource.listCompletedTracePage({
          workspaceId,
          after,
          through: now.toISOString(),
          limit: MAX_TRACES_PER_RUN - summary.scannedTurns,
        });
        const eligible = new Set<string>();
        for (const sessionId of new Set(traces.map((trace) => trace.sessionId))) {
          if (await this.workSource.isEligibleSession(sessionId, workspaceId)) eligible.add(sessionId);
        }
        const qualifying = traces.filter((trace) => isQualifyingTrace(trace) && eligible.has(trace.sessionId));
        const sessions = pickSessions(qualifying, MAX_SESSIONS_PER_RUN - summary.sessionsSampled);
        summary.scannedTurns += traces.length;
        summary.qualifyingTurns += qualifying.length;
        const seenInsights = (await this.deps.listExistingInsightsForDedup(workspaceId)).map(tokenizeInsight);
        const processedTurnIds = new Set<string>();
        for (const session of sessions) {
          if (summary.sourceWindowsSampled >= MAX_SOURCE_WINDOWS_PER_RUN || summary.proposed >= MAX_CANDIDATES_PER_RUN)
            break;
          // The autonomy kill switch may flip mid-run; re-check before every
          // session so an engaged switch halts further proposals immediately.
          if (!(await this.learningEnabled())) {
            summary.status = (await this.deps.isFeatureEnabled("autonomyV1Disabled"))
              ? "skipped_kill_switch"
              : "disabled";
            break;
          }
          summary.sessionsSampled += 1;
          const prepared = await this.workSource
            .prepareSourceWindows(
              session,
              workspaceId,
              MAX_SOURCE_WINDOWS_PER_RUN - summary.sourceWindowsSampled,
              (exclusion) => {
                sourceExclusions.push(exclusion);
                processedTurnIds.add(exclusion.turnId);
                summary.excludedTurns += 1;
                this.reportRunIssue({
                  event: "memory.consolidation.source_excluded",
                  message:
                    "A source turn was excluded from bounded consolidation; review it in Chat or prepare a smaller explicit memory.",
                  context: { workspaceId, ...exclusion },
                });
              },
            )
            .catch(() => {
              this.reportRunIssue({
                event: "memory.consolidation.source_unavailable",
                message: "Consolidation source could not be read; its checkpoint remains retryable.",
                context: { workspaceId, sessionId: session.sessionId },
              });
              return { windows: [], unavailable: true };
            });
          if (prepared.unavailable) summary.sessionsFailed += 1;
          for (const window of prepared.windows) {
            summary.sourceWindowsSampled += 1;
            let drafted: DraftedCandidate[];
            try {
              drafted = await this.draftSessionCandidates(session.sessionId, workspaceId, after.finishedAt, window);
            } catch (error) {
              if (isAuthoritativeModelUsageAccountingError(error)) {
                throw error;
              }
              summary.sessionsFailed += 1;
              this.reportRunIssue({
                event: "memory.consolidation.session_failed",
                message: "Memory consolidation drafting failed for a session",
                context: {
                  sessionId: session.sessionId,
                  error: error instanceof Error ? error.message : String(error),
                },
              });
              break;
            }
            let allCandidatesProcessed = true;
            for (const candidate of drafted) {
              if (summary.proposed >= MAX_CANDIDATES_PER_RUN) {
                allCandidatesProcessed = false;
                break;
              }
              if (
                !(await this.learningEnabled()) ||
                !(await this.workSource.isEligibleSession(session.sessionId, workspaceId))
              ) {
                allCandidatesProcessed = false;
                break;
              }
              summary.drafted += 1;
              if (candidate.sourceBinding && !(await this.workSource.hasCurrentBinding(candidate.sourceBinding))) {
                allCandidatesProcessed = false;
                break;
              }
              const tokens = tokenizeInsight(candidate.insight);
              if (seenInsights.some((existing) => jaccardSimilarity(existing, tokens) >= SIMILARITY_SKIP_THRESHOLD)) {
                summary.deduplicated += 1;
                continue;
              }
              await this.deps.proposeTraceMemoryCandidate(
                {
                  workspaceId,
                  candidateType: candidate.candidateType,
                  proposedInsight: candidate.insight,
                  confidence: candidate.confidence,
                  sourceSessionId: candidate.sessionId,
                  ...(candidate.turnId ? { sourceTurnId: candidate.turnId } : {}),
                  metadata: {
                    consolidation: true,
                    consolidationRunKind: "weekly",
                    ...(candidate.sourceBinding ? { consolidationSource: candidate.sourceBinding } : {}),
                  },
                },
                "memory-consolidation-job",
              );
              seenInsights.push(tokens);
              summary.proposed += 1;
            }
            if (allCandidatesProcessed) for (const trace of window) processedTurnIds.add(trace.turnId);
            else break;
          }
        }
        if (summary.status === "completed") {
          nextCursor = after;
          for (const trace of traces) {
            if (isQualifyingTrace(trace) && eligible.has(trace.sessionId) && !processedTurnIds.has(trace.turnId)) break;
            nextCursor = { finishedAt: trace.finishedAt ?? trace.startedAt, turnId: trace.turnId };
          }
          summary.nextWatermark = nextCursor.finishedAt;
        }
      } finally {
        await this.workSource.commitProgress(
          workspaceId,
          claim.revision,
          leaseOwner,
          nextCursor,
          (this.deps.now?.() ?? new Date()).toISOString(),
          sourceExclusions,
        );
      }
      if (summary.status !== "completed") break;
    }

    await this.deps.publishRealtime("system", "memory", {
      type: "memory_consolidation_run",
      ...summary,
    });
    return summary;
  }

  private async draftSessionCandidates(
    sessionId: string,
    workspaceId: string,
    watermark: string,
    traces: readonly ChatTurnTraceRecord[],
  ): Promise<DraftedCandidate[]> {
    const { digest, binding } = await this.workSource.readDraftSource(workspaceId, sessionId, traces);
    if (!digest.trim()) {
      return [];
    }
    // A multi-turn digest only establishes session-level provenance for its drafts.
    const turnId = traces.length === 1 ? traces[0]?.turnId : undefined;
    const defaults = await this.deps.resolveModelDefaults();
    const completion = await this.deps.createChatCompletion(
      {
        providerId: defaults.providerId,
        model: defaults.model,
        messages: [
          { role: "system", content: CONSOLIDATION_SYSTEM_PROMPT },
          { role: "user", content: digest },
        ],
        temperature: 0,
        max_tokens: 900,
      },
      createUtilityModelUsageAttribution({
        operationId: `memory-consolidation:${encodeURIComponent(watermark)}:${encodeURIComponent(sessionId)}:${binding?.sourceHash ?? createHash("sha256").update(digest).digest("hex")}`,
        utilityKind: "memory_candidate_consolidation",
        requestedProviderId: defaults.providerId,
        requestedModelId: defaults.model,
        lineage: {
          workspaceId,
          sessionId,
          ...(turnId ? { turnId } : {}),
          agentId: "memory-consolidator",
        },
      }),
    );
    const rawContent = completion.choices?.[0]
      ? (completion.choices[0] as { message?: { content?: string } }).message?.content
      : undefined;
    return parseDraftedCandidates(typeof rawContent === "string" ? rawContent : "", sessionId, turnId).map(
      (candidate) => ({
        ...candidate,
        ...(binding ? { sourceBinding: binding } : {}),
      }),
    );
  }

  private async learningEnabled(): Promise<boolean> {
    return (
      (await this.deps.isFeatureEnabled("memoryConsolidationV1Enabled")) &&
      (await this.deps.isFeatureEnabled("memoryLifecycleAdminV1Enabled")) &&
      !(await this.deps.isFeatureEnabled("autonomyV1Disabled"))
    );
  }

  private reportRunIssue(input: { event: string; message: string; context: Record<string, unknown> }): void {
    this.deps.recordDevDiagnostic?.({ level: "warn", category: "memory", ...input });
  }
}

function isQualifyingTrace(trace: ChatTurnTraceRecord): boolean {
  if (
    trace.status !== "completed" ||
    trace.completion?.status !== "complete" ||
    !Number.isFinite(trace.completion.providerCallCount) ||
    (trace.completion.providerCallCount ?? 0) < 1
  )
    return false;
  if (trace.memoryMode === "off") return false;
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

function pickSessions(
  traces: ChatTurnTraceRecord[],
  limit: number,
): Array<{ sessionId: string; traces: ChatTurnTraceRecord[] }> {
  const bySession = new Map<string, ChatTurnTraceRecord[]>();
  for (const trace of traces) {
    const sessionTraces = bySession.get(trace.sessionId) ?? [];
    sessionTraces.push(trace);
    bySession.set(trace.sessionId, sessionTraces);
  }
  return Array.from(bySession.entries())
    .map(([sessionId, sessionTraces]) => ({ sessionId, traces: sessionTraces }))
    .sort((a, b) =>
      (a.traces[0]?.finishedAt ?? a.traces[0]?.startedAt ?? "").localeCompare(
        b.traces[0]?.finishedAt ?? b.traces[0]?.startedAt ?? "",
      ),
    )
    .slice(0, limit);
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
