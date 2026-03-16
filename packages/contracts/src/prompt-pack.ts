import type { ChatCitationRecord, ChatMode, ChatTurnTraceRecord } from "./chat.js";
import type { ChatMemoryMode, ChatThinkingLevel, ChatWebMode } from "./chat.js";

export type PromptPackToolTier = "no-tools" | "implicit-tools" | "explicit-tools";

export interface PromptPackRecord {
  packId: string;
  name: string;
  sourceLabel?: string;
  testCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromptPackTestRecord {
  testId: string;
  packId: string;
  code: string;
  title: string;
  prompt: string;
  orderIndex: number;
  mode?: ChatMode;
  toolTier?: PromptPackToolTier;
  createdAt: string;
}

export interface PromptPackRunRecord {
  runId: string;
  packId: string;
  testId: string;
  sessionId?: string;
  status: "queued" | "running" | "completed" | "failed";
  providerId?: string;
  model?: string;
  mode?: ChatMode;
  toolTier?: PromptPackToolTier;
  toolAutonomy?: "safe_auto" | "manual";
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  responseText?: string;
  trace?: ChatTurnTraceRecord;
  citations?: ChatCitationRecord[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface PromptPackScoreRecord {
  scoreId: string;
  packId: string;
  testId: string;
  runId: string;
  routingScore: 0 | 1 | 2;
  honestyScore: 0 | 1 | 2;
  handoffScore: 0 | 1 | 2;
  robustnessScore: 0 | 1 | 2;
  usabilityScore: 0 | 1 | 2;
  totalScore: number;
  notes?: string;
  createdAt: string;
}

export interface PromptPackAutoScoreRequest {
  runId?: string;
  providerId?: string;
  model?: string;
  force?: boolean;
}

export interface PromptPackAutoScoreResult {
  score: PromptPackScoreRecord;
  run: PromptPackRunRecord;
  ruleScores: {
    routingScore: 0 | 1 | 2;
    honestyScore: 0 | 1 | 2;
    handoffScore: 0 | 1 | 2;
    robustnessScore: 0 | 1 | 2;
    usabilityScore: 0 | 1 | 2;
  };
  modelScores?: {
    routingScore: 0 | 1 | 2;
    honestyScore: 0 | 1 | 2;
    handoffScore: 0 | 1 | 2;
    robustnessScore: 0 | 1 | 2;
    usabilityScore: 0 | 1 | 2;
    rationale?: string;
  };
  usedModelJudge: boolean;
  notes: string;
}

export interface PromptPackAutoScoreBatchResult {
  items: PromptPackAutoScoreResult[];
  skipped: number;
}

export interface PromptPackReportRecord {
  pack: PromptPackRecord;
  tests: PromptPackTestRecord[];
  runs: PromptPackRunRecord[];
  scores: PromptPackScoreRecord[];
  summary: {
    totalTests: number;
    completedRuns: number;
    failedRuns: number;
    runFailureCount: number;
    scoreFailureCount: number;
    needsScoreCount: number;
    passThreshold: number;
    averageTotalScore: number;
    passRate: number;
    failingCodes: string[];
  };
}

export interface PromptPackBenchmarkProviderInput {
  providerId: string;
  model: string;
}

export interface PromptPackBenchmarkRunRequest {
  testCodes: string[];
  providers: PromptPackBenchmarkProviderInput[];
}

export interface PromptPackBenchmarkRunRecord {
  benchmarkRunId: string;
  packId: string;
  status: "queued" | "running" | "completed" | "failed";
  testCodes: string[];
  providers: PromptPackBenchmarkProviderInput[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface PromptPackBenchmarkItemRecord {
  itemId: string;
  benchmarkRunId: string;
  packId: string;
  testId: string;
  testCode: string;
  providerId: string;
  model: string;
  runId?: string;
  scoreId?: string;
  runStatus: PromptPackRunRecord["status"] | "missing_run";
  totalScore?: number;
  failureSignal?: string;
  createdAt: string;
}

export interface PromptPackBenchmarkModelSummary {
  providerId: string;
  model: string;
  total: number;
  scored: number;
  averageTotalScore: number;
  passRate: number;
  runFailures: number;
  noOutputCount: number;
  topFailureSignals: Array<{
    signal: string;
    count: number;
  }>;
}

export interface PromptPackBenchmarkStatusRecord {
  run: PromptPackBenchmarkRunRecord;
  progress: {
    totalItems: number;
    completedItems: number;
  };
  modelSummaries: PromptPackBenchmarkModelSummary[];
}

export interface ReplayRegressionRun {
  regressionRunId: string;
  packId: string;
  status: "queued" | "running" | "completed" | "failed";
  testCodes: string[];
  /** ISO-8601 timestamp selecting the latest scored baseline run at or before this instant. */
  baselineRef?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface ReplayRegressionResult {
  resultId: string;
  regressionRunId: string;
  testCode: string;
  capability: "routing" | "honesty" | "handoff" | "robustness" | "usability";
  scoreDelta: number;
  passDelta: number;
  latencyDeltaMs: number;
  createdAt: string;
}

export interface CapabilityTrendSeries {
  capability: "routing" | "honesty" | "handoff" | "robustness" | "usability" | "run_failure_rate";
  points: Array<{
    timestamp: string;
    value: number;
  }>;
  threshold?: number;
  breached?: boolean;
}

export interface PromptPackExportRecord {
  packId: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
  updatedAt?: string;
}
