/** Presentation evidence from OpenCode's `run --format json` protocol.
 * These are external agent reports, never Gateway approvals or file receipts. */
export interface OpenCodeRunSummary {
  version: 1;
  engine: "opencode";
  sessionId?: string;
  text?: string;
  error?: string;
  finishReason?: string;
  steps: Array<{ id: string; tool: string; title: string; status: "completed" | "error"; error?: string }>;
  files: Array<{ path: string; patch?: string; additions?: number; deletions?: number; truncated?: boolean }>;
  truncated: boolean;
}

const MAX_STEPS = 12;
const MAX_FILES = 6;
const MAX_PATCH_CHARS = 1_200;
const MAX_OUTPUT_CHARS = 1_048_576;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  // eslint-disable-next-line no-control-regex -- Remove ANSI terminal escapes from CLI display text.
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").slice(0, limit);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A bounded projection, also used when a large tool result becomes an artifact. */
export function readOpenCodeRunSummary(value: unknown): OpenCodeRunSummary | undefined {
  const source = record(value);
  if (
    source?.version !== 1 ||
    source.engine !== "opencode" ||
    !Array.isArray(source.steps) ||
    !Array.isArray(source.files)
  ) {
    return undefined;
  }
  const steps: OpenCodeRunSummary["steps"] = [];
  const files: OpenCodeRunSummary["files"] = [];
  for (const item of source.steps.slice(0, MAX_STEPS)) {
    const step = record(item);
    if (!step || (step.status !== "completed" && step.status !== "error")) continue;
    const tool = text(step.tool, 80);
    const id = text(step.id, 120);
    if (!tool || !id) continue;
    steps.push({ id, tool, title: text(step.title, 160) ?? tool, status: step.status, error: text(step.error, 300) });
  }
  for (const item of source.files.slice(0, MAX_FILES)) {
    const file = record(item);
    const filePath = text(file?.path, 300);
    if (!filePath) continue;
    files.push({
      path: filePath,
      patch: text(file?.patch, MAX_PATCH_CHARS),
      additions: count(file?.additions),
      deletions: count(file?.deletions),
      truncated: file?.truncated === true || (typeof file?.patch === "string" && file.patch.length > MAX_PATCH_CHARS),
    });
  }
  return {
    version: 1,
    engine: "opencode",
    sessionId: text(source.sessionId, 120),
    text: text(source.text, 1_200),
    error: text(source.error, 500),
    finishReason: text(source.finishReason, 80),
    steps,
    files,
    truncated: source.truncated === true || source.steps.length > MAX_STEPS || source.files.length > MAX_FILES,
  };
}

/** Parse only redacted stdout, never raw provider credentials or process environment.
 * Unknown event types, mixed sessions, and incomplete lines cannot become success. */
export function parseOpenCodeRunOutput(stdout: string): OpenCodeRunSummary | undefined {
  const result: OpenCodeRunSummary = { version: 1, engine: "opencode", steps: [], files: [], truncated: false };
  const steps = new Map<string, OpenCodeRunSummary["steps"][number]>();
  const files = new Map<string, OpenCodeRunSummary["files"][number]>();
  let recognized = false;
  const lines = stdout.slice(0, MAX_OUTPUT_CHARS).split(/\r?\n/u);
  result.truncated = stdout.length > MAX_OUTPUT_CHARS || lines.length > 2_000;
  for (const line of lines.slice(0, 2_000)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(line));
    } catch {
      result.truncated = true;
      continue;
    }
    if (!event || !["step_start", "step_finish", "tool_use", "text", "error"].includes(String(event.type))) continue;
    const sessionId = text(event.sessionID, 120);
    if (!sessionId || !/^ses_[\w-]+$/u.test(sessionId)) continue;
    if (result.sessionId && result.sessionId !== sessionId) {
      result.truncated = true;
      continue;
    }
    result.sessionId = sessionId;
    recognized = true;
    const part = record(event.part);
    if (event.type === "text" && part?.type === "text") {
      const next = text(part.text, 1_200);
      if (next) {
        // Keep the latest answer; intermediate agent commentary stays in the artifact.
        result.text = next;
        if (typeof part.text === "string" && part.text.length > 1_200) result.truncated = true;
      }
    } else if (event.type === "error") {
      const error = record(event.error);
      result.error = text(record(error?.data)?.message, 500) ?? text(error?.name, 500) ?? "OpenCode reported an error.";
    } else if (event.type === "step_finish") {
      result.finishReason = text(part?.reason, 80);
    } else if (event.type === "tool_use" && part?.type === "tool") {
      const state = record(part.state);
      const tool = text(part.tool, 80);
      const id = text(part.callID, 120) ?? text(part.id, 120);
      if (!tool || !id || (state?.status !== "completed" && state?.status !== "error")) continue;
      if (steps.size < MAX_STEPS || steps.has(id)) {
        steps.set(id, {
          id,
          tool,
          title: text(state.title, 160) ?? tool,
          status: state.status,
          error: text(state.error, 300),
        });
      } else result.truncated = true;
      if (state.status === "error") result.error ??= text(state.error, 500) ?? `${tool} failed.`;
      // Proposed changes and failed tools never become a reported changed file.
      if (state.status !== "completed" || !["edit", "write", "apply_patch"].includes(tool)) continue;
      const metadata = record(state.metadata);
      const input = record(state.input);
      const candidates = Array.isArray(metadata?.files)
        ? metadata.files.slice(0, MAX_FILES + 1)
        : [record(metadata?.filediff) ?? { filePath: input?.filePath, patch: metadata?.diff }];
      for (const candidate of candidates) {
        const file = record(candidate);
        const filePath = text(file?.relativePath ?? file?.file ?? file?.filePath, 300);
        if (!filePath) continue;
        if (files.size >= MAX_FILES && !files.has(filePath)) {
          result.truncated = true;
          continue;
        }
        files.set(filePath, {
          path: filePath,
          patch: text(file?.patch, MAX_PATCH_CHARS),
          additions: count(file?.additions),
          deletions: count(file?.deletions),
          truncated: typeof file?.patch === "string" && file.patch.length > MAX_PATCH_CHARS,
        });
      }
    }
  }
  result.steps = [...steps.values()];
  result.files = [...files.values()];
  return recognized ? result : undefined;
}

/** Require an actual direct CLI invocation, never a prompt merely mentioning it. */
export function isOpenCodeJsonInvocation(executable: string, argv: readonly string[]): boolean {
  const basename = executable.split(/[\\/]/u).at(-1)?.toLowerCase();
  const flags = argv.slice(1, argv.indexOf("--") < 0 ? undefined : argv.indexOf("--"));
  return (
    /^(?:opencode)(?:\.exe|\.cmd|\.bat)?$/u.test(basename ?? "") &&
    argv[0] === "run" &&
    (flags.includes("--format=json") || flags.some((arg, index) => arg === "--format" && flags[index + 1] === "json"))
  );
}
