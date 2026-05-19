import type { ChannelCommandDefinition, ChannelToolsetPosture } from "@goatcitadel/contracts";

export type NormalizedChannelCommandName =
  | "start"
  | "status"
  | "sethome"
  | "new"
  | "skills"
  | "skill"
  | "memory"
  | "recall"
  | "search"
  | "tools"
  | "personality"
  | "stop"
  | "approve"
  | "deny"
  | "run";

export interface NormalizedChannelCommand {
  handled: boolean;
  command?: `/${NormalizedChannelCommandName}`;
  name?: NormalizedChannelCommandName;
  args: string[];
  argText: string;
  commandText: string;
  approvalToken?: string;
  approvalDecision?: "approve" | "reject";
  runDetailId?: string;
}

export const SHARED_CHANNEL_COMMANDS: ChannelCommandDefinition[] = [
  command("start", "Pairing and help entrypoint.", { platforms: ["telegram"], bypassesActiveRunGuard: true }),
  command("status", "Show connection, home channel, tool, trust, and personality state.", {
    platforms: ["telegram", "discord"],
    bypassesActiveRunGuard: true,
  }),
  command("sethome", "Set the current chat/channel as the home delivery target.", {
    aliases: ["set-home"],
    platforms: ["telegram", "discord"],
    bypassesActiveRunGuard: true,
  }),
  command("new", "Start a fresh channel session.", {
    aliases: ["reset"],
    platforms: ["telegram", "discord"],
    bypassesActiveRunGuard: true,
  }),
  command("skills", "List visible channel skill bindings.", { platforms: ["telegram", "discord"] }),
  command("skill", "Invoke or inspect a visible channel skill binding.", {
    argsHint: "<name>",
    platforms: ["telegram", "discord"],
  }),
  command("memory", "Search recent learned memory for this channel session.", {
    argsHint: "<query>|auto|on|off",
    platforms: ["telegram", "discord"],
  }),
  command("recall", "Search persisted session transcript history for this channel workspace.", {
    argsHint: "<query>",
    platforms: ["telegram", "discord"],
  }),
  command("search", "Search learned memory and persisted sessions together.", {
    argsHint: "<query>",
    platforms: ["telegram", "discord"],
  }),
  command("tools", "List channel tool families and approval posture.", {
    platforms: ["telegram", "discord"],
    bypassesActiveRunGuard: true,
  }),
  command("personality", "List, set, or clear the visible channel personality.", {
    argsHint: "[name|none]",
    platforms: ["telegram", "discord"],
    bypassesActiveRunGuard: true,
  }),
  command("stop", "Stop or cancel the active channel run where supported.", {
    platforms: ["telegram", "discord"],
    bypassesActiveRunGuard: true,
  }),
  command("approve", "Approve a pending remote approval token.", {
    argsHint: "<action-token>",
    platforms: ["telegram", "discord"],
    bypassesActiveRunGuard: true,
  }),
  command("deny", "Reject a pending remote approval token.", {
    argsHint: "<action-token>",
    platforms: ["telegram", "discord"],
    bypassesActiveRunGuard: true,
  }),
  command("run", "Run a named workflow or inspect run details.", {
    argsHint: "research <query>|details <run-id>",
    platforms: ["discord"],
    bypassesActiveRunGuard: true,
  }),
];

export const DEFAULT_CHANNEL_TOOLSET_POSTURE: ChannelToolsetPosture[] = [
  {
    family: "conversation",
    label: "Conversation",
    enabled: true,
    approval: "not_required",
    riskSummary: "Normal chat, drafting, Q&A, and status responses.",
  },
  {
    family: "skills",
    label: "Skills",
    enabled: true,
    approval: "policy_gated",
    riskSummary: "Only visible channel skill bindings can be invoked, and each skill keeps its trust policy.",
  },
  {
    family: "web",
    label: "Web and research",
    enabled: true,
    approval: "policy_gated",
    riskSummary:
      "Network reads may run when policy allows; sensitive or mutating connector actions still require approval.",
  },
  {
    family: "terminal",
    label: "Terminal",
    enabled: true,
    approval: "always_required",
    riskSummary: "Remote terminal requests are allowed from channels but must pass policy and visible approval.",
  },
  {
    family: "filesystem",
    label: "Filesystem",
    enabled: true,
    approval: "always_required",
    riskSummary: "Read/write/patch requests remain sandboxed and approval-gated when risky.",
  },
  {
    family: "browser",
    label: "Browser",
    enabled: true,
    approval: "policy_gated",
    riskSummary: "Browser automation can run when configured; logins, purchases, and mutations remain approval-gated.",
  },
  {
    family: "cron",
    label: "Scheduled work",
    enabled: true,
    approval: "policy_gated",
    riskSummary: "Scheduling and background delivery use the home channel and existing automation policy.",
  },
  {
    family: "messaging",
    label: "Messaging",
    enabled: true,
    approval: "policy_gated",
    riskSummary: "Cross-platform sends use visible targets and connector mutation approvals where required.",
  },
];

export function findSharedChannelCommand(name: string): ChannelCommandDefinition | undefined {
  const normalized = name.trim().toLowerCase().replace(/^\//, "");
  return SHARED_CHANNEL_COMMANDS.find((item) => item.name === normalized || item.aliases.includes(normalized));
}

export function listSharedChannelCommandsForPlatform(platform: string): ChannelCommandDefinition[] {
  return SHARED_CHANNEL_COMMANDS.filter((item) => item.platforms.includes(platform));
}

export function normalizeChannelCommandInput(
  input: string,
  options: {
    platform?: string;
  } = {},
): NormalizedChannelCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return emptyNormalizedCommand(trimmed);
  }
  const [rawCommand = "", ...args] = trimmed.split(/\s+/g).filter(Boolean);
  const requestedName = rawCommand.replace(/^\//, "").split("@", 1)[0]?.trim().toLowerCase();
  if (!requestedName) {
    return emptyNormalizedCommand(trimmed);
  }
  const definition = findSharedChannelCommand(requestedName);
  if (!definition || (options.platform && !definition.platforms.includes(options.platform))) {
    return emptyNormalizedCommand(trimmed);
  }
  const name = definition.name as NormalizedChannelCommandName;
  const command = `/${name}` as const;
  const argText = args.join(" ").trim();
  const normalized: NormalizedChannelCommand = {
    handled: true,
    command,
    name,
    args,
    argText,
    commandText: [command, argText].filter(Boolean).join(" "),
  };
  if (name === "approve" || name === "deny") {
    normalized.approvalDecision = name === "approve" ? "approve" : "reject";
    normalized.approvalToken = normalizeChannelApprovalToken(argText);
  }
  if (name === "run" && args[0]?.toLowerCase() === "details") {
    normalized.runDetailId = args.slice(1).join(" ").trim() || undefined;
  }
  return normalized;
}

export function normalizeChannelApprovalToken(input: string): string | undefined {
  const token = input.trim();
  return token.length > 0 ? token : undefined;
}

function emptyNormalizedCommand(commandText: string): NormalizedChannelCommand {
  return {
    handled: false,
    args: [],
    argText: "",
    commandText,
  };
}

function command(
  name: string,
  description: string,
  input: {
    aliases?: string[];
    argsHint?: string;
    platforms: string[];
    requiresAuthorization?: boolean;
    bypassesActiveRunGuard?: boolean;
  },
): ChannelCommandDefinition {
  return {
    name,
    aliases: input.aliases ?? [],
    description,
    argsHint: input.argsHint,
    platforms: input.platforms,
    requiresAuthorization: input.requiresAuthorization ?? true,
    bypassesActiveRunGuard: input.bypassesActiveRunGuard ?? false,
  };
}
