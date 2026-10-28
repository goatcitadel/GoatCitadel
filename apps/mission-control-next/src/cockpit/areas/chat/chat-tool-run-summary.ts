// After hermes-agent's run-summary (https://github.com/nousresearch/hermes-agent, MIT, Copyright (c) 2025 Nous
// Research), keyed to GoatCitadel's own tool names and argument shapes.
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { summarizeShellCommand } from "./summarize-shell-command";

type ToolCategory = "edit" | "explore" | "search" | "read" | "interact" | "run" | "create" | "send" | "other";

/** Clause order is fixed, so the same turn always reads the same way. */
const CATEGORY_ORDER: readonly ToolCategory[] = [
  "edit",
  "explore",
  "search",
  "read",
  "interact",
  "run",
  "create",
  "send",
  "other",
];

const CATEGORY_COPY: Record<ToolCategory, { noun: [string, string]; past: string; present: string }> = {
  edit: { noun: ["file", "files"], past: "Changed", present: "Changing" },
  explore: { noun: ["file", "files"], past: "Explored", present: "Exploring" },
  search: { noun: ["search", "searches"], past: "Searched", present: "Searching" },
  read: { noun: ["page", "pages"], past: "Read", present: "Reading" },
  interact: { noun: ["browser action", "browser actions"], past: "Performed", present: "Performing" },
  run: { noun: ["command", "commands"], past: "Ran", present: "Running" },
  create: { noun: ["document", "documents"], past: "Created", present: "Creating" },
  send: { noun: ["message", "messages"], past: "Sent", present: "Sending" },
  other: { noun: ["tool", "tools"], past: "Used", present: "Using" },
};

const TOOL_CATEGORY: Record<string, ToolCategory> = {
  "fs.write": "edit",
  "fs.patch": "edit",
  "fs.copy": "edit",
  "fs.move": "edit",
  "fs.delete": "edit",
  "fs.read": "explore",
  "fs.list": "explore",
  "fs.stat": "explore",
  "file.find": "explore",
  "file.read_range": "explore",
  "code.search": "explore",
  "code.search_files": "explore",
  "browser.search": "search",
  "memory.search": "search",
  "docs.search": "search",
  "session.search": "search",
  "capabilities.search": "search",
  "browser.navigate": "read",
  "browser.extract": "read",
  "http.get": "read",
  "shell.exec": "run",
  "shell.exec_background": "run",
  "tests.run": "run",
  "lint.run": "run",
  "build.run": "run",
  "documents.create": "create",
  "presentations.create": "create",
  "artifacts.create": "create",
};

const SEND_TOOL = /^(?:channel|discord|slack|telegram|teams|mattermost|whatsapp|line|zalo|gmail|smtp|webhook)\.send$/;

function toolCategory(toolName: string | undefined): ToolCategory {
  // A malformed record from the wire still reads as a plain tool rather than breaking the turn.
  if (typeof toolName !== "string") return "other";
  if (TOOL_CATEGORY[toolName]) return TOOL_CATEGORY[toolName];
  if (SEND_TOOL.test(toolName)) return "send";
  return toolName.startsWith("browser.") ? "interact" : "other";
}

function stringArg(args: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

const fileName = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : "";
  } catch {
    return "";
  }
}

function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export type ToolRunTarget = { label: string; full: string; kind: "file" | "command" | "query" | "host" };

/**
 * What one tool call acted on, as its row names it: a file name, the command that matters, a quoted query, or a
 * host. `full` keeps the whole value for a tooltip. Undefined when the call's arguments name nothing readable.
 */
export function toolRunTarget(run: Pick<ChatToolRunRecord, "toolName" | "args">): ToolRunTarget | undefined {
  const args = run.args;
  const category = toolCategory(run.toolName);
  if (run.toolName === "shell.exec" || run.toolName === "shell.exec_background") {
    const command = stringArg(args, "command");
    return command ? { label: shorten(summarizeShellCommand(command), 60), full: command, kind: "command" } : undefined;
  }
  if (category === "search" || run.toolName === "code.search" || run.toolName === "code.search_files") {
    const query = stringArg(args, "query");
    return query ? { label: `“${shorten(query, 48)}”`, full: query, kind: "query" } : undefined;
  }
  if (run.toolName === "file.find") {
    const pattern = stringArg(args, "pattern");
    return pattern ? { label: `“${shorten(pattern, 48)}”`, full: pattern, kind: "query" } : undefined;
  }
  if (category === "read" || run.toolName === "browser.interact") {
    const url = stringArg(args, "url");
    const host = hostOf(url);
    return host ? { label: host, full: url, kind: "host" } : undefined;
  }
  if (category === "edit" || category === "explore") {
    const path = stringArg(args, "path", "from");
    return path ? { label: fileName(path), full: path, kind: "file" } : undefined;
  }
  return undefined;
}

function clause(category: ToolCategory, runs: ChatToolRunRecord[], live: boolean): string {
  const copy = CATEGORY_COPY[category];
  const verb = live ? copy.present : copy.past;
  const target = runs.length === 1 ? toolRunTarget(runs[0]!) : undefined;
  // A settled command reads better as a count; its command line earns the space only while it is the wait.
  if (target && (live || category !== "run")) return `${verb} ${target.label}`;
  return `${verb} ${runs.length} ${copy.noun[runs.length === 1 ? 0 : 1]}`;
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * What a turn's tool calls did, as one plain line: "Changed hero.css, explored 3 files, ran 2 commands". While the
 * turn streams, the category of the call in progress (or the latest call) reads in the present tense. It counts
 * every call, whatever its outcome; the outcomes are the status counts shown beside it.
 */
export function summarizeTurnToolRuns(runs: readonly ChatToolRunRecord[], live: boolean): string {
  const narrating = live ? (runs.find((run) => run.status === "started") ?? runs.at(-1)) : undefined;
  const liveCategory = narrating ? toolCategory(narrating.toolName) : null;
  const byCategory = new Map<ToolCategory, ChatToolRunRecord[]>();
  for (const run of runs) {
    const category = toolCategory(run.toolName);
    byCategory.set(category, [...(byCategory.get(category) ?? []), run]);
  }
  const clauses = CATEGORY_ORDER.flatMap((category) => {
    const group = byCategory.get(category);
    return group ? [clause(category, group, category === liveCategory)] : [];
  });
  return clauses.map((text, index) => (index === 0 ? text : lowerFirst(text))).join(", ");
}
