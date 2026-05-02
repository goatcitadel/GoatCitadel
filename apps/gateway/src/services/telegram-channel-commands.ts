import type { IntegrationConnection } from "@goatcitadel/contracts";
import { DEFAULT_CHANNEL_TOOLSET_POSTURE, SHARED_CHANNEL_COMMANDS } from "./channel-command-contract.js";
import {
  buildPersonalityOverlay,
  getPersonalityPreset,
  listPersonalityPresets,
  normalizePersonalityId,
} from "./channel-personalities.js";

export interface TelegramCommandContext {
  connection: Pick<IntegrationConnection, "connectionId" | "label" | "config" | "enabled" | "status">;
  chatId: string;
  actorId: string;
  actorDisplayName?: string;
  content: string;
  resolveApprovalToken?: (
    token: string,
    decision: "approve" | "reject",
  ) => Promise<{ approvalId: string; status: string }>;
}

export interface TelegramCommandResult {
  handled: boolean;
  command?: string;
  configPatch?: Record<string, unknown>;
  response?: TelegramWebhookSendMessage;
}

export interface TelegramWebhookSendMessage {
  method: "sendMessage";
  chat_id: string;
  text: string;
  reply_markup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

const COMMANDS = [
  "/start",
  "/status",
  "/sethome",
  "/new",
  "/skills",
  "/skill",
  "/tools",
  "/personality",
  "/stop",
  "/approve",
  "/deny",
];

export async function handleTelegramChannelCommand(context: TelegramCommandContext): Promise<TelegramCommandResult> {
  const [rawCommand, ...args] = context.content.trim().split(/\s+/);
  const command = rawCommand ? rawCommand.split("@", 1)[0]?.toLowerCase() : undefined;
  if (!command || !COMMANDS.includes(command)) {
    return { handled: false };
  }

  switch (command) {
    case "/start":
      return respond(command, context, renderStart(context));
    case "/status":
      return respond(command, context, renderStatus(context));
    case "/sethome":
      return {
        handled: true,
        command,
        configPatch: {
          defaultChannelId: context.chatId,
          defaultChatId: context.chatId,
          homeChannelSetAt: new Date().toISOString(),
        },
        response: sendMessage(
          context.chatId,
          [
            "Home channel set.",
            "",
            `GoatCitadel will use this Telegram chat (${context.chatId}) for background results, scheduled work, and cross-platform delivery when no more specific target is selected.`,
          ].join("\n"),
        ),
      };
    case "/new":
      return respond(
        command,
        context,
        "New session requested. The next normal message in this Telegram chat will continue through GoatCitadel's channel session routing.",
      );
    case "/skills":
      return respond(command, context, renderSkills(context));
    case "/skill":
      return respond(command, context, renderSkill(args.join(" "), context));
    case "/tools":
      return respond(command, context, renderTools());
    case "/personality":
      return handlePersonalityCommand(args.join(" "), context);
    case "/stop":
      return respond(
        command,
        context,
        "Stop requested. If a channel run is active, GoatCitadel will cancel it where the underlying runtime supports cancellation.",
      );
    case "/approve":
      return handleApprovalFallbackCommand(command, args.join(" "), context, "approve");
    case "/deny":
      return handleApprovalFallbackCommand(command, args.join(" "), context, "reject");
    default:
      return { handled: false };
  }
}

export function readActiveChannelPersonality(config: Record<string, unknown>, chatId: string): string {
  const personalities = readRecord(config.channelPersonalities);
  const targetValue = readString(personalities[chatId]);
  return normalizePersonalityId(targetValue ?? readString(config.defaultPersonalityId));
}

export function buildChannelPersonalitySystemOverlay(
  config: Record<string, unknown>,
  chatId: string,
): string | undefined {
  return buildPersonalityOverlay(readActiveChannelPersonality(config, chatId));
}

function handlePersonalityCommand(argument: string, context: TelegramCommandContext): TelegramCommandResult {
  const requested = normalizePersonalityId(argument);
  if (!argument.trim()) {
    return respond(
      "/personality",
      context,
      [
        "Available personalities:",
        ...listPersonalityPresets().map((preset) => `- ${preset.id}: ${preset.description}`),
        "",
        "Use /personality <name> to set one for this chat, or /personality none to clear it.",
      ].join("\n"),
    );
  }

  const preset = getPersonalityPreset(requested);
  if (requested !== "default" && preset.id === "default") {
    return respond(
      "/personality",
      context,
      `Unknown personality "${argument.trim()}". Use /personality to list available presets.`,
    );
  }

  const current = readRecord(context.connection.config.channelPersonalities);
  const nextPersonalities = { ...current };
  if (preset.id === "default") {
    delete nextPersonalities[context.chatId];
  } else {
    nextPersonalities[context.chatId] = preset.id;
  }

  return {
    handled: true,
    command: "/personality",
    configPatch: {
      channelPersonalities: nextPersonalities,
      channelPersonalityUpdatedAt: new Date().toISOString(),
    },
    response: sendMessage(
      context.chatId,
      preset.id === "default"
        ? "Personality cleared for this Telegram chat. GoatCitadel is back to the default voice."
        : `Personality set to ${preset.label} for this Telegram chat.\n\n${preset.description}`,
    ),
  };
}

function renderStart(context: TelegramCommandContext): string {
  return [
    "Hi. I can connect this Telegram chat to GoatCitadel.",
    "",
    "If I do not recognize you yet, approve this chat from Mission Control or use the pairing code shown there.",
    `Chat target: ${context.chatId}`,
    context.actorDisplayName ? `Requested by: ${context.actorDisplayName}` : `Requested by actor ${context.actorId}`,
    "",
    `Useful commands: ${SHARED_CHANNEL_COMMANDS.filter((item) => item.platforms.includes("telegram"))
      .slice(0, 9)
      .map((item) => `/${item.name}`)
      .join(", ")}.`,
  ].join("\n");
}

function renderStatus(context: TelegramCommandContext): string {
  const active = getPersonalityPreset(readActiveChannelPersonality(context.connection.config, context.chatId));
  const home =
    readString(context.connection.config.defaultChannelId) ?? readString(context.connection.config.defaultChatId);
  return [
    "GoatCitadel Telegram status",
    "",
    `Connection: ${context.connection.label}`,
    `Enabled: ${context.connection.enabled ? "yes" : "no"}`,
    `Status: ${context.connection.status}`,
    `Home channel: ${home ? (home === context.chatId ? "this chat" : home) : "not set"}`,
    "Pairing: visible approval recommended for new chats",
    "Runtime: webhook inbound path",
    `Personality: ${active.label}`,
    "Trust: channel requests can ask for tools, but terminal/filesystem/network actions remain policy- and approval-gated.",
  ].join("\n");
}

function renderSkills(context: TelegramCommandContext): string {
  const bindings = readSkillBindings(context.connection.config);
  if (bindings.length === 0) {
    return "No channel-specific skills are enabled for this Telegram connection yet. Configure visible skill bindings in Mission Control before using /skill <name>.";
  }
  return ["Enabled channel skills:", ...bindings.map((item) => `- ${item.alias}: ${item.skillId}`)].join("\n");
}

function renderSkill(name: string, context: TelegramCommandContext): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return "Use /skill <name> to invoke a visible channel skill binding.";
  }
  const binding = readSkillBindings(context.connection.config).find(
    (item) => item.enabled && item.alias.toLowerCase() === normalized,
  );
  if (!binding) {
    return `No visible channel skill binding matched "${name.trim()}". Use /skills to list enabled skills.`;
  }
  return `Skill "${binding.alias}" is available and will run through GoatCitadel's normal skill trust and approval policy. Send your request as a normal message and mention ${binding.alias}.`;
}

function renderTools(): string {
  return [
    "Channel tool posture",
    "",
    ...DEFAULT_CHANNEL_TOOLSET_POSTURE.map(
      (item) =>
        `- ${item.label}: ${item.enabled ? item.approval.replace("_", " ") : "unavailable"} - ${item.riskSummary}`,
    ),
  ].join("\n");
}

async function handleApprovalFallbackCommand(
  command: string,
  token: string,
  context: TelegramCommandContext,
  decision: "approve" | "reject",
): Promise<TelegramCommandResult> {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return respond(command, context, `Use ${command} <action-token> from an approval message.`);
  }
  if (!context.resolveApprovalToken) {
    return respond(command, context, "Approval resolution is not available on this Telegram route yet.");
  }
  try {
    const result = await context.resolveApprovalToken(normalizedToken, decision);
    return respond(
      command,
      context,
      decision === "approve"
        ? `Approved ${result.approvalId}. GoatCitadel will resume any waiting work it can safely resume.`
        : `Rejected ${result.approvalId}. GoatCitadel will keep the requested action blocked.`,
    );
  } catch (error) {
    return respond(command, context, `Could not resolve approval token: ${(error as Error).message}`);
  }
}

function respond(command: string, context: TelegramCommandContext, text: string): TelegramCommandResult {
  return {
    handled: true,
    command,
    response: sendMessage(context.chatId, text),
  };
}

function sendMessage(chatId: string, text: string): TelegramWebhookSendMessage {
  return {
    method: "sendMessage",
    chat_id: chatId,
    text,
  };
}

function readSkillBindings(
  config: Record<string, unknown>,
): Array<{ skillId: string; alias: string; enabled: boolean }> {
  const raw = config.channelSkillBindings;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      skillId: readString(item.skillId) ?? "",
      alias: readString(item.alias) ?? readString(item.skillId) ?? "",
      enabled: item.enabled !== false,
    }))
    .filter((item) => item.skillId && item.alias);
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
