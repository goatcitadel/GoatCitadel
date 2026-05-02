import type { ChannelCommandDefinition, ChannelToolsetPosture } from "@goatcitadel/contracts";

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
    argsHint: "<token-id>",
    platforms: ["telegram"],
    bypassesActiveRunGuard: true,
  }),
  command("deny", "Reject a pending remote approval token.", {
    argsHint: "<token-id>",
    platforms: ["telegram"],
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
