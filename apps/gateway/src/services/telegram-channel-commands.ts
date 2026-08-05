import type { IntegrationConnection, PersonalityCatalogResponse } from "@goatcitadel/contracts";
import {
  DEFAULT_CHANNEL_TOOLSET_POSTURE,
  SHARED_CHANNEL_COMMANDS,
  normalizeChannelCommandInput,
} from "./channel-command-contract.js";
import {
  buildPersonalityOverlay,
  getPersonalityPreset,
  listPersonalityPresets,
  normalizePersonalityId,
} from "./channel-personalities.js";
import { createTelegramChannelSessionPatch } from "./telegram-channel-sessions.js";

export interface TelegramStopCommandOutcome {
  status: "cancelled" | "no_active_run" | "failed";
  sessionId?: string;
  turnId?: string;
  durableRunId?: string;
  durableCancelled?: boolean;
  error?: string;
}

export interface TelegramCommandContext {
  connection: Pick<IntegrationConnection, "connectionId" | "label" | "config" | "enabled" | "status">;
  chatId: string;
  threadId?: string;
  actorId: string;
  actorDisplayName?: string;
  content: string;
  personalityCatalog?: PersonalityCatalogResponse;
  isActiveRun?: () => Promise<boolean>;
  runChatCommand?: (commandText: string) => Promise<{ message: string }>;
  cancelActiveSession?: () => Promise<TelegramStopCommandOutcome>;
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

export async function handleTelegramChannelCommand(context: TelegramCommandContext): Promise<TelegramCommandResult> {
  const normalized = normalizeChannelCommandInput(context.content, { platform: "telegram" });
  if (!normalized.handled || !normalized.command || !normalized.name) {
    return { handled: false };
  }
  const command = normalized.command;
  const definition = SHARED_CHANNEL_COMMANDS.find((item) => item.name === normalized.name);
  if ((await context.isActiveRun?.()) && !definition?.bypassesActiveRunGuard) {
    return respond(
      command,
      context,
      "A GoatCitadel run is already active for this chat. Available now: /status, /stop, /approve, /deny.",
    );
  }

  switch (normalized.name) {
    case "start":
      return respond(command, context, renderStart(context));
    case "status":
      return respond(command, context, renderStatus(context));
    case "sethome": {
      // SECURITY (codex finding #5): `/sethome` mutates operator config
      // (`defaultChannelId`/`defaultChatId`) and reroutes future
      // background/scheduled deliveries. Approved pairings alone are not
      // enough — that's a chat-access boundary, not an operator boundary.
      // Require the actor to appear in the connection's operator
      // allowlist (`telegramOperatorActors` in connection.config).
      if (!isTelegramChannelOperator(context.connection.config, context.actorId)) {
        return {
          handled: true,
          command,
          response: sendMessage(
            context.chatId,
            [
              "Only operators can change the home channel.",
              "",
              "Ask an operator to add your Telegram actor ID to the operator allowlist in GoatCitadel settings.",
            ].join("\n"),
          ),
        };
      }
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
    }
    case "new":
      return {
        handled: true,
        command,
        configPatch: createTelegramChannelSessionPatch({
          config: context.connection.config,
          chatId: context.chatId,
          threadId: context.threadId,
          actorId: context.actorId,
        }),
        response: sendMessage(
          context.chatId,
          "New Telegram channel session started. The next normal message in this chat will route to a fresh GoatCitadel session.",
        ),
      };
    case "skills":
      return respond(command, context, renderSkills(context));
    case "skill":
      return respond(command, context, renderSkill(normalized.argText, context));
    case "memory":
    case "recall":
    case "search":
      return handleLookupCommand(command, context, normalized.commandText);
    case "tools":
      return respond(command, context, renderTools());
    case "personality":
      return handlePersonalityCommand(normalized.argText, context);
    case "stop":
      return handleStopCommand(command, context);
    case "approve":
    case "deny":
      return handleApprovalFallbackCommand(
        command,
        normalized.approvalToken,
        context,
        normalized.approvalDecision ?? "reject",
      );
    default:
      return { handled: false };
  }
}

async function handleLookupCommand(
  command: string,
  context: TelegramCommandContext,
  commandText: string,
): Promise<TelegramCommandResult> {
  if (!context.runChatCommand) {
    return respond(command, context, "Channel lookup is not available on this Telegram route yet.");
  }
  const result = await context.runChatCommand(commandText);
  return respond(command, context, result.message);
}

async function handleStopCommand(command: string, context: TelegramCommandContext): Promise<TelegramCommandResult> {
  if (!context.cancelActiveSession) {
    return respond(command, context, "Stop is not available on this Telegram route yet.");
  }
  try {
    const outcome = await context.cancelActiveSession();
    if (outcome.status === "no_active_run") {
      return respond(command, context, "No active Telegram channel run is currently running for this chat.");
    }
    if (outcome.status === "failed") {
      return respond(
        command,
        context,
        `Could not stop the active Telegram channel run: ${outcome.error ?? "unknown error"}`,
      );
    }
    const suffix = outcome.durableRunId
      ? outcome.durableCancelled === false
        ? ` Turn ${outcome.turnId ?? "unknown"} was cancelled, but linked durable run ${outcome.durableRunId} was already terminal or could not be cancelled.`
        : ` Linked durable run ${outcome.durableRunId} was cancelled too.`
      : "";
    return respond(command, context, `Stopped the active Telegram channel run.${suffix}`);
  } catch (error) {
    return respond(command, context, `Could not stop the active Telegram channel run: ${(error as Error).message}`);
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
  catalog?: PersonalityCatalogResponse,
): string | undefined {
  return buildPersonalityOverlay(readActiveChannelPersonality(config, chatId), catalog?.items);
}

function handlePersonalityCommand(argument: string, context: TelegramCommandContext): TelegramCommandResult {
  const requested = normalizePersonalityId(argument);
  if (!argument.trim()) {
    return respond(
      "/personality",
      context,
      [
        "Available personalities:",
        ...(context.personalityCatalog?.items ?? listPersonalityPresets()).map(
          (preset) => `- ${preset.id}: ${preset.description}`,
        ),
        "",
        "Use /personality <name> to set one for this chat, or /personality none to clear it.",
      ].join("\n"),
    );
  }

  const preset = getPersonalityPreset(requested, context.personalityCatalog?.items);
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
  const active = getPersonalityPreset(
    readActiveChannelPersonality(context.connection.config, context.chatId),
    context.personalityCatalog?.items,
  );
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
  token: string | undefined,
  context: TelegramCommandContext,
  decision: "approve" | "reject",
): Promise<TelegramCommandResult> {
  if (!token) {
    return respond(command, context, `Use ${command} <action-token> from an approval message.`);
  }
  if (!context.resolveApprovalToken) {
    return respond(command, context, "Approval resolution is not available on this Telegram route yet.");
  }
  try {
    const result = await context.resolveApprovalToken(token, decision);
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

// SECURITY (codex finding #5): Operator allowlist for Telegram-side commands
// that mutate operator config. The field is `telegramOperatorActors:
// string[]` (or legacy `operatorActorIds`) in connection.config. Empty/
// missing means "no Telegram user is an operator" — operators can still
// change `defaultChannelId` via Mission Control directly.
export function isTelegramChannelOperator(config: Record<string, unknown>, actorId: string): boolean {
  if (!actorId.trim()) {
    return false;
  }
  const candidates = [
    Array.isArray(config.telegramOperatorActors) ? config.telegramOperatorActors : undefined,
    Array.isArray((config as Record<string, unknown>).operatorActorIds)
      ? (config as Record<string, unknown>).operatorActorIds
      : undefined,
  ];
  for (const list of candidates) {
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry === "string" && entry.trim() === actorId.trim()) {
          return true;
        }
      }
    }
  }
  return false;
}
