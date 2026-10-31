/**
 * Built-in tool groups. The operator can switch every group except Core off in Capabilities › Tools; the switch
 * saves through the Settings save.
 */
export type ToolGroupId =
  | "core"
  | "files"
  | "shell_and_code"
  | "git"
  | "web_search"
  | "web_requests"
  | "browser"
  | "memory"
  | "documents"
  | "email_and_calendar"
  | "messaging"
  | "webhooks"
  | "schedules"
  | "subagents";

export interface ToolGroupDefinition {
  readonly id: ToolGroupId;
  readonly label: string;
  readonly description: string;
  /** False only for Core, which GoatCitadel needs to run chats and connectors. */
  readonly switchable: boolean;
  readonly toolNames: readonly string[];
}

/** Every built-in tool belongs to exactly one group. MCP tools belong to their connector and are not listed here. */
export const TOOL_GROUPS: readonly ToolGroupDefinition[] = [
  {
    id: "core",
    label: "Core",
    description: "GoatCitadel needs these to run chats and connectors, so they stay on.",
    switchable: false,
    toolNames: [
      "capabilities.search",
      "skills.read",
      "tool_artifact.read",
      "change.request",
      "code_mode.request",
      "runtime.configure",
      "session.status",
      "session.search",
      "session.history",
      "user_input.request",
      "submit_work_result",
      "time.now",
      "context.list",
      "context.grep",
      "context.query",
      "context.read_range",
      "mcp.invoke",
    ],
  },
  {
    id: "files",
    label: "Files",
    description: "Read, search, write, move and delete files in your folders.",
    switchable: true,
    toolNames: [
      "fs.read",
      "fs.list",
      "fs.stat",
      "fs.write",
      "fs.patch",
      "fs.copy",
      "fs.move",
      "fs.delete",
      "file.read_range",
      "file.find",
      "code.search",
      "code.search_files",
    ],
  },
  {
    id: "shell_and_code",
    label: "Shell and code",
    description: "Run shell commands and your project's test, lint and build scripts.",
    switchable: true,
    toolNames: ["shell.exec", "shell.exec_background", "tests.run", "lint.run", "build.run"],
  },
  {
    id: "git",
    label: "Git",
    description: "See changes, commit, and manage branches and worktrees.",
    switchable: true,
    toolNames: [
      "git.status",
      "git.diff",
      "git.add",
      "git.commit",
      "git.branch.create",
      "git.branch.switch",
      "git.worktree.create",
      "git.worktree.remove",
    ],
  },
  {
    id: "web_search",
    label: "Web search",
    description: "Search the web, research local businesses and build citations.",
    switchable: true,
    toolNames: ["browser.search", "local_business.research", "citations.build"],
  },
  {
    id: "web_requests",
    label: "Web requests",
    description: "Fetch web pages and send data to web addresses directly.",
    switchable: true,
    toolNames: ["http.get", "http.post"],
  },
  {
    id: "browser",
    label: "Browser",
    description: "Open and read pages, take screenshots, click, and manage cookies and storage.",
    switchable: true,
    toolNames: [
      "browser.navigate",
      "browser.extract",
      "browser.screenshot",
      "browser.interact",
      "browser.cookies.get",
      "browser.cookies.set",
      "browser.cookies.clear",
      "browser.storage.get",
      "browser.storage.set",
      "browser.storage.clear",
      "browser.context.configure",
    ],
  },
  {
    id: "memory",
    label: "Memory",
    description: "Read, search and save what the AI remembers.",
    switchable: true,
    toolNames: ["memory.read", "memory.search", "memory.write", "memory.upsert"],
  },
  {
    id: "documents",
    label: "Documents",
    description: "Index and search your documents, and create documents, slides and artifacts.",
    switchable: true,
    toolNames: [
      "docs.ingest",
      "docs.read_bytes",
      "docs.extract_text",
      "docs.decompress",
      "docs.search",
      "embeddings.index",
      "embeddings.query",
      "artifacts.create",
      "documents.create",
      "presentations.create",
      "document.propose_patch",
    ],
  },
  {
    id: "email_and_calendar",
    label: "Email and calendar",
    description: "Read and send email, and read and add calendar events.",
    switchable: true,
    toolNames: ["gmail.read", "gmail.send", "smtp.send", "calendar.list", "calendar.create_event"],
  },
  {
    id: "messaging",
    label: "Messaging",
    description: "Send, react to and remove messages in your chat apps, and ask for your attention.",
    switchable: true,
    toolNames: [
      "notify.request",
      "channel.send",
      "channel.react",
      "channel.unsend",
      "discord.send",
      "discord.react",
      "discord.unsend",
      "line.send",
      "mattermost.send",
      "mattermost.react",
      "mattermost.unsend",
      "nextcloud-talk.send",
      "nextcloud-talk.react",
      "telegram.send",
      "telegram.react",
      "telegram.unsend",
      "whatsapp.send",
      "whatsapp.react",
      "slack.send",
      "slack.react",
      "slack.unsend",
      "google-chat.send",
      "teams.send",
      "zalo.send",
    ],
  },
  {
    id: "webhooks",
    label: "Webhooks",
    description: "Send data to your webhooks.",
    switchable: true,
    toolNames: ["webhook.send"],
  },
  {
    id: "schedules",
    label: "Schedules",
    description: "Set up and cancel the AI's own scheduled work.",
    switchable: true,
    toolNames: ["schedule.manage"],
  },
  {
    id: "subagents",
    label: "Subagents",
    description: "Hand parts of a task to up to three subagents.",
    switchable: true,
    toolNames: ["agent.fanout"],
  },
];

export const SWITCHABLE_TOOL_GROUP_IDS: readonly [ToolGroupId, ...ToolGroupId[]] = [
  "files",
  "shell_and_code",
  "git",
  "web_search",
  "web_requests",
  "browser",
  "memory",
  "documents",
  "email_and_calendar",
  "messaging",
  "webhooks",
  "schedules",
  "subagents",
];

export const ESSENTIAL_TOOL_GROUP_IDS: readonly ToolGroupId[] = ["files", "web_search", "memory", "browser"];

const TOOL_GROUP_BY_ID: ReadonlyMap<string, ToolGroupDefinition> = new Map(
  TOOL_GROUPS.map((group) => [group.id, group] as const),
);

const TOOL_GROUP_BY_TOOL_NAME: ReadonlyMap<string, ToolGroupDefinition> = new Map(
  TOOL_GROUPS.flatMap((group) => group.toolNames.map((toolName) => [toolName, group] as const)),
);

export function isSwitchableToolGroupId(value: unknown): value is ToolGroupId {
  return typeof value === "string" && TOOL_GROUP_BY_ID.get(value)?.switchable === true;
}

export function toolGroupForTool(toolName: string): ToolGroupDefinition | undefined {
  return TOOL_GROUP_BY_TOOL_NAME.get(toolName);
}

/** One governed switch: turn one switchable group on (`enabled: true`) or off. Core can't be named. */
export interface ToolGroupChange {
  readonly groupId: ToolGroupId;
  readonly enabled: boolean;
}

export function isToolGroupChange(value: unknown): value is ToolGroupChange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  return (
    keys.length === 2 &&
    keys.every((key) => key === "groupId" || key === "enabled") &&
    isSwitchableToolGroupId(record.groupId) &&
    typeof record.enabled === "boolean"
  );
}

/**
 * Tool name → its group, for the switchable groups in `disabled`. Core and unknown ids are ignored.
 * `disabled` comes from a config file the operator may edit by hand, so a value that isn't a list
 * switches nothing off, and entries that aren't strings are skipped.
 */
export function toolNamesSwitchedOff(disabled: readonly string[] | undefined): ReadonlyMap<string, ToolGroupId> {
  const switchedOff = new Map<string, ToolGroupId>();
  for (const groupId of Array.isArray(disabled) ? disabled : []) {
    if (!isSwitchableToolGroupId(groupId)) {
      continue;
    }
    for (const toolName of TOOL_GROUP_BY_ID.get(groupId)?.toolNames ?? []) {
      switchedOff.set(toolName, groupId);
    }
  }
  return switchedOff;
}
