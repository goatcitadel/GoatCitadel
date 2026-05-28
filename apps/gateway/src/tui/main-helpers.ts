export type HomeView =
  | "dashboard"
  | "chat"
  | "code"
  | "approvals"
  | "promptlab"
  | "memory"
  | "files"
  | "cron"
  | "improvement"
  | "sessions"
  | "costs"
  | "tools"
  | "tasks"
  | "skills"
  | "curator"
  | "integrations"
  | "mesh"
  | "npu"
  | "system"
  | "onboarding"
  | "settings"
  | "exit";

export interface TuiArgs {
  profile?: string;
  gateway?: string;
  readOnly: boolean;
  doctor: boolean;
  deep: boolean;
  yes: boolean;
  json: boolean;
  auditOnly: boolean;
  noRepair: boolean;
}

export interface TuiChoice<TValue extends string = string> {
  name: string;
  value: TValue;
}

export interface HeaderSummaryInput {
  profile: string;
  gateway: string;
  readOnly: boolean;
  liveState: string;
  lastEventAt?: string;
  liveNote?: string;
  activeProviderId?: string;
  activeModel?: string;
  activeSessionId?: string;
  changedFiles?: number;
  codeModeRuns?: number;
}

export const MANUAL_SESSION_ENTRY = "__manual_session__";
export const MAX_TUI_SESSION_CHOICES = 14;

export const HOME_VIEW_CHOICES: ReadonlyArray<TuiChoice<HomeView>> = [
  { name: "Dashboard", value: "dashboard" },
  { name: "Chat", value: "chat" },
  { name: "Code", value: "code" },
  { name: "Approvals", value: "approvals" },
  { name: "Prompt Lab", value: "promptlab" },
  { name: "Memory", value: "memory" },
  { name: "Files", value: "files" },
  { name: "Cron", value: "cron" },
  { name: "Improvement", value: "improvement" },
  { name: "Sessions", value: "sessions" },
  { name: "Costs", value: "costs" },
  { name: "Tools", value: "tools" },
  { name: "Tasks", value: "tasks" },
  { name: "Skills", value: "skills" },
  { name: "Curator", value: "curator" },
  { name: "Integrations", value: "integrations" },
  { name: "Mesh", value: "mesh" },
  { name: "NPU", value: "npu" },
  { name: "System", value: "system" },
  { name: "Onboarding", value: "onboarding" },
  { name: "Settings", value: "settings" },
  { name: "Exit", value: "exit" },
];

export function parseTuiArgs(argv: string[]): TuiArgs {
  let profile: string | undefined;
  let gateway: string | undefined;
  let readOnly = false;
  let doctor = false;
  let deep = false;
  let yes = false;
  let json = false;
  let auditOnly = false;
  let noRepair = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--profile") {
      profile = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--gateway") {
      gateway = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--read-only") {
      readOnly = true;
      continue;
    }
    if (value === "doctor" || value === "--doctor") {
      doctor = true;
      continue;
    }
    if (value === "--deep") {
      deep = true;
      continue;
    }
    if (value === "--yes" || value === "-y") {
      yes = true;
      continue;
    }
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--audit-only") {
      auditOnly = true;
      continue;
    }
    if (value === "--no-repair") {
      noRepair = true;
      continue;
    }
  }

  return { profile, gateway, readOnly, doctor, deep, yes, json, auditOnly, noRepair };
}

export interface RuntimeLlmSummaryInput {
  activeProviderId?: string;
  activeModel?: string;
  activeModelContextWindow?: number;
  activeModelOutputTokenLimit?: number;
  providers?: unknown;
}

export function buildRuntimeLlmSummaryLines(input: RuntimeLlmSummaryInput): string[] {
  const lines: string[] = [
    `Active provider: ${input.activeProviderId ?? "unset"}`,
    `Active model: ${input.activeModel ?? "unset"}`,
  ];
  if (typeof input.activeModelContextWindow === "number") {
    lines.push(`Context window: ${input.activeModelContextWindow.toLocaleString()}`);
  }
  if (typeof input.activeModelOutputTokenLimit === "number") {
    lines.push(`Output limit: ${input.activeModelOutputTokenLimit.toLocaleString()}`);
  }
  lines.push("New chats fall back to this runtime selection when session prefs are blank.");
  return lines;
}

export function buildHeaderSummaryRows(input: HeaderSummaryInput): Array<{ key: string; value: string }> {
  const providerModel = [input.activeProviderId, input.activeModel].filter(Boolean).join(" / ");
  return [
    { key: "Profile", value: input.profile },
    { key: "Gateway", value: input.gateway },
    { key: "Live", value: input.liveState },
    { key: "Mode", value: input.readOnly ? "read-only" : "read+safe-write" },
    ...(providerModel ? [{ key: "Provider", value: providerModel }] : []),
    ...(input.activeSessionId ? [{ key: "Session", value: summarizeText(input.activeSessionId, 40) }] : []),
    ...(typeof input.changedFiles === "number" ? [{ key: "Changes", value: `${input.changedFiles} files` }] : []),
    ...(typeof input.codeModeRuns === "number" ? [{ key: "Code Mode", value: `${input.codeModeRuns} runs` }] : []),
    { key: "Last event", value: input.lastEventAt ? formatTimestamp(input.lastEventAt) : "none yet" },
    ...(input.liveNote ? [{ key: "Feed note", value: summarizeText(input.liveNote, 100) }] : []),
  ];
}

export function buildSessionChoices(
  sessionItems: Array<Record<string, unknown>>,
  limit = MAX_TUI_SESSION_CHOICES,
): Array<TuiChoice<string>> {
  const available = sessionItems
    .map((session) => ({
      sessionId: toText(session.sessionId),
      summary: formatSessionSummary(session),
    }))
    .filter((session) => session.sessionId);

  return [
    ...available.slice(0, limit).map((session) => ({
      name: session.summary,
      value: session.sessionId,
    })),
    { name: "Enter session ID manually", value: MANUAL_SESSION_ENTRY },
  ];
}

export function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function formatSessionSummary(session: Record<string, unknown>): string {
  const sessionId = toText(session.sessionId) || "unknown";
  const title = toText(session.title) || "(untitled)";
  const kind = toText(session.kind) || "chat";
  const updatedAt = formatTimestamp(toText(session.updatedAt));
  return `${title} [${sessionId}] · ${kind} · updated ${updatedAt}`;
}

export function formatTimestamp(value: string): string {
  if (!value) {
    return "unknown";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

export function summarizeText(value: string, limit = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact || "(empty)";
  }
  return `${compact.slice(0, limit - 3)}...`;
}
