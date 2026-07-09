import type { ChatToolRunRecord, PromptPackRunRecord } from "@goatcitadel/contracts";

export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function safeJsonParseDefined<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as T | null | undefined;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function resolvePromptPackScoreFacingResponseText(run: Pick<PromptPackRunRecord, "responseText">): string {
  // Scoring must always see the model's real output. finalResponseText is a
  // historical fabrication artifact retained on old run records for audit only.
  return (run.responseText ?? "").trim();
}

export interface PromptPackChatToolRunRow {
  tool_run_id: string;
  turn_id: string;
  session_id: string;
  tool_name: string;
  status: ChatToolRunRecord["status"];
  approval_id: string | null;
  args_json: string | null;
  result_json: string | null;
  reused: number | null;
  reused_from_tool_run_id: string | null;
  reuse_reason: string | null;
  error: string | null;
  failure_guidance: string | null;
  started_at: string;
  finished_at: string | null;
}

export function toPromptPackChatToolRunRows(value: unknown): PromptPackChatToolRunRow[] {
  return Array.isArray(value) ? value.filter(isPromptPackChatToolRunRow) : [];
}

function isPromptPackChatToolRunRow(value: unknown): value is PromptPackChatToolRunRow {
  return (
    isRecord(value) &&
    typeof value.tool_run_id === "string" &&
    typeof value.turn_id === "string" &&
    typeof value.session_id === "string" &&
    typeof value.tool_name === "string" &&
    typeof value.status === "string" &&
    (typeof value.approval_id === "string" || value.approval_id === null) &&
    (typeof value.args_json === "string" || value.args_json === null) &&
    (typeof value.result_json === "string" || value.result_json === null) &&
    (typeof value.reused === "number" || value.reused === null) &&
    (typeof value.reused_from_tool_run_id === "string" || value.reused_from_tool_run_id === null) &&
    (typeof value.reuse_reason === "string" || value.reuse_reason === null) &&
    (typeof value.error === "string" || value.error === null) &&
    (typeof value.failure_guidance === "string" || value.failure_guidance === null) &&
    typeof value.started_at === "string" &&
    (typeof value.finished_at === "string" || value.finished_at === null)
  );
}

export function mapPromptPackChatToolRunRow(row: PromptPackChatToolRunRow): ChatToolRunRecord {
  return {
    toolRunId: row.tool_run_id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    status: row.status,
    approvalId: row.approval_id ?? undefined,
    args: parsePromptPackToolRunRecord(row.args_json),
    result: parsePromptPackToolRunRecord(row.result_json),
    reused: row.reused === null ? undefined : row.reused !== 0,
    reusedFromToolRunId: row.reused_from_tool_run_id ?? undefined,
    reuseReason: row.reuse_reason ?? undefined,
    error: row.error ?? undefined,
    failureGuidance: row.failure_guidance ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function parsePromptPackToolRunRecord(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = safeJsonParse<unknown>(raw, undefined);
  return isRecord(parsed) ? parsed : undefined;
}

export function truncatePromptPackLogValue(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 16)).trim()} ... [truncated]`;
}

export function summarizePromptPackRecordForLog(
  value: Record<string, unknown> | undefined,
  maxChars = 700,
): string | undefined {
  if (!value || Object.keys(value).length === 0) {
    return undefined;
  }
  try {
    const summarized = JSON.stringify(value, (_key, item) =>
      typeof item === "string" ? truncatePromptPackLogValue(item, 240) : item,
    );
    return summarized ? truncatePromptPackLogValue(summarized, maxChars).replace(/`/g, "'") : undefined;
  } catch {
    return undefined;
  }
}

function readPromptPackLogString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return truncatePromptPackLogValue(value, 500);
    }
  }
  return undefined;
}

function readPromptPackLogNumber(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function summarizePromptPackToolResultForLog(toolRun: ChatToolRunRecord): string[] {
  const result = toolRun.result;
  if (!result || Object.keys(result).length === 0) {
    return [];
  }
  const lines: string[] = [];
  const url = readPromptPackLogString(result, "finalUrl", "url");
  const pathValue = readPromptPackLogString(result, "path", "filePath");
  const httpStatus = readPromptPackLogNumber(result, "status", "httpStatus");
  const artifactId = readPromptPackLogString(result, "artifactId");
  const artifactPath = readPromptPackLogString(result, "artifactPath");
  const artifactSummary = readPromptPackLogString(result, "artifactSummary");
  const summary = readPromptPackLogString(result, "snippet", "textSnippet", "bodySnippet", "contentText", "message");
  const browserFailureClass = readPromptPackLogString(result, "browserFailureClass");
  const originalByteLength = readPromptPackLogNumber(result, "originalByteLength", "byteLength");
  if (url) {
    lines.push(`url: ${url}`);
  }
  if (pathValue) {
    lines.push(`path: ${pathValue}`);
  }
  if (httpStatus !== undefined) {
    lines.push(`http status: ${httpStatus}`);
  }
  if (artifactId || artifactPath || artifactSummary) {
    lines.push(
      `artifact: ${artifactId ?? "-"}${artifactPath ? ` at ${artifactPath}` : ""}${artifactSummary ? ` (${artifactSummary})` : ""}`,
    );
  }
  if (browserFailureClass) {
    lines.push(`browser failure class: ${browserFailureClass}`);
  }
  if (originalByteLength !== undefined) {
    lines.push(`result bytes: ${originalByteLength}`);
  }
  if (result.storedAsArtifact === true) {
    lines.push("stored as artifact: yes");
  }
  if (result.virtualized === true) {
    lines.push("output virtualized: yes");
  }
  if (summary) {
    lines.push(`result summary: ${summary}`);
  }
  if (lines.length === 0) {
    const recordSummary = summarizePromptPackRecordForLog(result);
    if (recordSummary) {
      lines.push(`result: \`${recordSummary}\``);
    }
  }
  return lines;
}

export function normalizePromptPackJudgeScores(payload: Record<string, unknown>):
  | {
      routingScore: 0 | 1 | 2;
      honestyScore: 0 | 1 | 2;
      handoffScore: 0 | 1 | 2;
      robustnessScore: 0 | 1 | 2;
      usabilityScore: 0 | 1 | 2;
    }
  | undefined {
  const asScore = (value: unknown): 0 | 1 | 2 | undefined => {
    if (typeof value === "number" || typeof value === "string") {
      return clampPromptScore(value);
    }
    return undefined;
  };
  const routingScore = asScore(payload.routingScore);
  const honestyScore = asScore(payload.honestyScore);
  const handoffScore = asScore(payload.handoffScore);
  const robustnessScore = asScore(payload.robustnessScore);
  const usabilityScore = asScore(payload.usabilityScore);
  if (
    routingScore === undefined ||
    honestyScore === undefined ||
    handoffScore === undefined ||
    robustnessScore === undefined ||
    usabilityScore === undefined
  ) {
    return undefined;
  }
  return {
    routingScore,
    honestyScore,
    handoffScore,
    robustnessScore,
    usabilityScore,
  };
}

export function clampPromptScore(value: string | number): 0 | 1 | 2 {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  if (parsed >= 2) {
    return 2;
  }
  return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
