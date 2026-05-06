import type { AgenticCommandRunStatus, AgenticScriptedRunnerRecord } from "@goatcitadel/contracts";

export interface AgenticScriptedRunnerMemoryRecord extends AgenticScriptedRunnerRecord {
  status: AgenticCommandRunStatus;
  eventRefs: string[];
  blockedTools: string[];
  outputTruncated: boolean;
  externalExecution: "not_implemented";
}

export interface BuildAgenticScriptedRunnerRecordInput {
  scriptRunId: string;
  runId?: string;
  sessionId?: string;
  status?: AgenticCommandRunStatus;
  policySnapshotHash?: string;
  requestedToolNames?: string[];
  policyApprovedToolNames: string[];
  finalOutput?: string;
  maxOutputChars?: number;
  artifactRefs?: string[];
  eventRefs?: string[];
  approvalId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  now?: () => string;
}

export class AgenticScriptedRunnerMemoryStore {
  private readonly records = new Map<string, AgenticScriptedRunnerMemoryRecord>();

  public save(record: AgenticScriptedRunnerMemoryRecord): AgenticScriptedRunnerMemoryRecord {
    this.records.set(record.scriptRunId, record);
    return record;
  }

  public get(scriptRunId: string): AgenticScriptedRunnerMemoryRecord | undefined {
    return this.records.get(scriptRunId);
  }

  public list(): AgenticScriptedRunnerMemoryRecord[] {
    return [...this.records.values()];
  }
}

export function buildAgenticScriptedRunnerRecord(
  input: BuildAgenticScriptedRunnerRecordInput,
): AgenticScriptedRunnerMemoryRecord {
  const now = input.now ?? (() => new Date().toISOString());
  const requestedToolNames = normalizeToolNames(input.requestedToolNames ?? input.policyApprovedToolNames);
  const policyApprovedToolNames = new Set(normalizeToolNames(input.policyApprovedToolNames));
  const exposedTools = requestedToolNames.filter((toolName) => policyApprovedToolNames.has(toolName));
  const blockedTools = requestedToolNames.filter((toolName) => !policyApprovedToolNames.has(toolName));
  const boundedOutput = boundOutputPreview(input.finalOutput, input.maxOutputChars);
  const startedAt = input.startedAt ?? now();
  const completedAt = input.completedAt ?? (input.finalOutput !== undefined || input.error ? now() : undefined);

  return {
    scriptRunId: normalizeRequired(input.scriptRunId, "scriptRunId"),
    runId: normalizeOptional(input.runId),
    sessionId: normalizeOptional(input.sessionId),
    status: input.status ?? inferStatus(input),
    policySnapshotHash: normalizeOptional(input.policySnapshotHash),
    exposedTools,
    outputPreview: boundedOutput.preview,
    artifactRefs: normalizeRefs(input.artifactRefs),
    eventRefs: normalizeRefs(input.eventRefs),
    approvalId: normalizeOptional(input.approvalId),
    startedAt,
    completedAt,
    error: normalizeOptional(input.error),
    blockedTools,
    outputTruncated: boundedOutput.truncated,
    externalExecution: "not_implemented",
  };
}

export function recordAgenticScriptedRunnerResult(
  store: AgenticScriptedRunnerMemoryStore,
  input: BuildAgenticScriptedRunnerRecordInput,
): AgenticScriptedRunnerMemoryRecord {
  return store.save(buildAgenticScriptedRunnerRecord(input));
}

function inferStatus(input: BuildAgenticScriptedRunnerRecordInput): AgenticCommandRunStatus {
  if (input.error) {
    return "failed";
  }
  if (input.finalOutput !== undefined) {
    return "passed";
  }
  return "queued";
}

function normalizeToolNames(toolNames: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const toolName of toolNames) {
    const value = toolName.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeRefs(refs: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const ref of refs ?? []) {
    const value = ref.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function boundOutputPreview(
  output: string | undefined,
  maxOutputChars = 4_000,
): { preview: string | undefined; truncated: boolean } {
  if (output === undefined) {
    return { preview: undefined, truncated: false };
  }
  const limit = Math.max(0, Math.floor(maxOutputChars));
  if (output.length <= limit) {
    return { preview: output, truncated: false };
  }
  return { preview: output.slice(0, limit), truncated: true };
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
