export interface ReplayOverrideStep {
  stepKey: string;
  overrideKind: "tool_output" | "prompt_patch" | "policy_decision";
  override: Record<string, unknown>;
}

export interface ReplayOverrideDraft {
  replayRunId: string;
  sourceRunId: string;
  status: "draft" | "running" | "completed" | "failed";
  overrides: ReplayOverrideStep[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface ReplayDiffSummary {
  replayRunId: string;
  sourceRunId: string;
  status: "completed" | "failed";
  summary: {
    latencyDeltaMs: number;
    inputTokensDelta: number;
    outputTokensDelta: number;
    cachedInputTokensDelta: number;
    costUsdDelta: number;
    errorChanged: boolean;
  };
  comparedAt: string;
}
