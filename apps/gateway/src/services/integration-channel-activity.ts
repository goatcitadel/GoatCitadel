import type { ChannelActivityEffectResult, ChannelActivityInput, IntegrationConnection } from "@goatcitadel/contracts";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import { resolveChannelConfigTarget } from "./channel-config.js";
import type { IntegrationChannelPort } from "./integration-channel-service.js";
import { sendTelegramTypingIndicator } from "./telegram-typing.js";
export async function emitChannelActivityImpl(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  options: {
    emoji?: string;
    activityReactions: string[];
    typing: boolean;
  },
): Promise<ChannelActivityEffectResult[]> {
  const effects: ChannelActivityEffectResult[] = [
    await publishChannelActivitySignal(deps, connection, input, options.emoji),
  ];

  const staleReactions =
    input.phase === "clear"
      ? options.activityReactions
      : options.activityReactions.filter((reaction) => reaction !== options.emoji);
  if (staleReactions.length > 0 && supportsActivityReactionClear(connection.key)) {
    effects.push(await clearActivityReactions(deps, connection, input, staleReactions));
  }

  if (input.phase !== "clear" && options.emoji && supportsActivityReaction(connection.key)) {
    effects.push(await sendActivityReaction(deps, connection, input, options.emoji));
  }

  if (options.typing) {
    effects.push(await sendActivityTyping(deps, connection, input));
  }

  if (connection.key === "whatsapp" && (input.phase === "seen" || options.typing)) {
    effects.push(await sendWhatsAppReadReceipt(deps, connection, input, { typing: options.typing }));
  }

  return effects;
}

async function publishChannelActivitySignal(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  emoji: string | undefined,
): Promise<ChannelActivityEffectResult> {
  await deps.publishRealtime(
    "channel_activity_updated",
    "channels",
    {
      type: "channel_activity",
      phase: input.phase,
      emoji,
      label: input.label,
      connectionId: connection.connectionId,
      channelKey: connection.key,
      target: input.target,
      messageId: input.messageId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      status: input.phase === "clear" ? "clear" : "active",
      updatedAt: new Date().toISOString(),
    },
    {
      eventClass: "ui_notification",
      eventAuthority: "derived_projection",
      links: {
        sessionId: input.sessionId,
        turnId: input.turnId,
        messageId: input.messageId,
        connectorId: connection.connectionId,
      },
      correlationId: input.correlationId,
    },
  );
  return { effect: "mission_control", supported: true, status: "sent" };
}

async function sendActivityReaction(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  emoji: string,
): Promise<ChannelActivityEffectResult> {
  try {
    switch (connection.key) {
      case "slack":
        await sendSlackReaction(deps, connection, input, emoji);
        break;
      case "discord":
        await sendDiscordReaction(deps, connection, input, emoji);
        break;
      case "telegram":
        await setTelegramReaction(deps, connection, input, emoji);
        break;
      case "whatsapp":
        await sendWhatsAppReaction(deps, connection, input, emoji);
        break;
      default:
        return { effect: "reaction", supported: false, status: "unsupported" };
    }
    return { effect: "reaction", supported: true, status: "sent" };
  } catch (error) {
    return {
      effect: "reaction",
      supported: true,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function clearActivityReactions(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  reactions: string[],
): Promise<ChannelActivityEffectResult> {
  try {
    switch (connection.key) {
      case "slack":
        await clearSlackReactions(deps, connection, input, reactions);
        break;
      case "discord":
        await clearDiscordReactions(deps, connection, input, reactions);
        break;
      case "telegram":
        if (input.phase === "clear") {
          await setTelegramReaction(deps, connection, input, undefined);
        }
        break;
      case "whatsapp":
        if (input.phase === "clear") {
          await sendWhatsAppReaction(deps, connection, input, "");
        }
        break;
      default:
        return { effect: "reaction_clear", supported: false, status: "unsupported" };
    }
    return { effect: "reaction_clear", supported: true, status: "cleared" };
  } catch (error) {
    return {
      effect: "reaction_clear",
      supported: true,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendActivityTyping(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
): Promise<ChannelActivityEffectResult> {
  if (connection.key === "discord") {
    const result = await deps.discordRuntimeService.sendTyping(
      connection.connectionId,
      input.target,
      undefined,
      input.signal,
    );
    return {
      effect: "typing",
      supported: result.supported,
      status: result.status === "sent" ? "sent" : "unsupported",
      detail: result.reason,
    };
  }
  if (connection.key === "telegram") {
    return sendTelegramActivityTyping(deps, connection, input);
  }
  if (connection.key === "whatsapp") {
    return { effect: "typing", supported: true, status: "sent", detail: "Sent with WhatsApp read receipt." };
  }
  return { effect: "typing", supported: false, status: "unsupported" };
}

async function sendTelegramActivityTyping(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
): Promise<ChannelActivityEffectResult> {
  const token = resolveChannelSecret(deps, connection, ["botToken", "token"]);
  const chatId =
    normalizeActivityTarget(input.target, "telegram") ?? resolveChannelConfigTarget("telegram", connection.config);
  if (!token) {
    return {
      effect: "typing",
      supported: false,
      status: "unsupported",
      detail: `${connection.label} is missing a Telegram bot token.`,
    };
  }
  if (!chatId) {
    return {
      effect: "typing",
      supported: false,
      status: "unsupported",
      detail: `${connection.label} is missing a Telegram chat target.`,
    };
  }
  const telegramApiUrl = `https://api.telegram.org/bot${token}/sendChatAction`;
  if (!deps.isConnectionUrlAllowlisted(telegramApiUrl)) {
    return {
      effect: "typing",
      supported: false,
      status: "unsupported",
      detail: "Telegram API host is not in the current outbound allowlist.",
    };
  }
  try {
    await sendTelegramTypingIndicator({
      connectionId: connection.connectionId,
      target: input.target,
      token,
      chatId,
      threadId: input.threadId,
      signal: input.signal,
      fetcher: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
    });
    return { effect: "typing", supported: true, status: "sent" };
  } catch (error) {
    return {
      effect: "typing",
      supported: true,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
function supportsActivityReaction(channelKey: string): boolean {
  return ["discord", "slack", "telegram", "whatsapp"].includes(channelKey);
}

function supportsActivityReactionClear(channelKey: string): boolean {
  return ["discord", "slack", "telegram", "whatsapp"].includes(channelKey);
}

async function sendSlackReaction(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  emoji: string,
): Promise<void> {
  const token = resolveChannelSecret(deps, connection, ["botToken", "token"]);
  const channel =
    normalizeActivityTarget(input.target, "slack") ?? resolveChannelConfigTarget("slack", connection.config);
  const name = normalizeSlackActivityReaction(emoji);
  if (!token) {
    throw new Error(`${connection.label} is missing a Slack bot token.`);
  }
  if (!channel) {
    throw new Error(`${connection.label} is missing a Slack channel target.`);
  }
  await postSlackReaction(
    deps,
    token,
    "https://slack.com/api/reactions.add",
    {
      channel,
      timestamp: input.messageId,
      name,
    },
    input.signal,
  );
}

async function clearSlackReactions(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  reactions: string[],
): Promise<void> {
  const token = resolveChannelSecret(deps, connection, ["botToken", "token"]);
  const channel =
    normalizeActivityTarget(input.target, "slack") ?? resolveChannelConfigTarget("slack", connection.config);
  if (!token) {
    throw new Error(`${connection.label} is missing a Slack bot token.`);
  }
  if (!channel) {
    throw new Error(`${connection.label} is missing a Slack channel target.`);
  }
  for (const reaction of reactions) {
    await postSlackReaction(
      deps,
      token,
      "https://slack.com/api/reactions.remove",
      {
        channel,
        timestamp: input.messageId,
        name: normalizeSlackActivityReaction(reaction),
      },
      input.signal,
      { ignoreMissing: true },
    );
  }
}

async function postSlackReaction(
  deps: IntegrationChannelPort,
  token: string,
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  options: { ignoreMissing?: boolean } = {},
): Promise<void> {
  assertAllowlisted(deps, url);
  const response = await deps.fetchWithDiagnosticsTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal,
  });
  const payload = parseJsonRecord(
    await readBoundedResponseText(response, {
      maxBytes: 128 * 1024,
      timeoutMs: 5_000,
      label: "Slack activity",
    }),
  );
  if (options.ignoreMissing && payload.error === "no_reaction") {
    return;
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(`slack.activity failed (${response.status})${payload.error ? `: ${payload.error}` : ""}`);
  }
}

async function sendDiscordReaction(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  emoji: string,
): Promise<void> {
  await discordReactionRequest(deps, connection, input, emoji, "PUT");
}

async function clearDiscordReactions(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  reactions: string[],
): Promise<void> {
  for (const reaction of reactions) {
    await discordReactionRequest(deps, connection, input, reaction, "DELETE");
  }
}

async function discordReactionRequest(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  emoji: string,
  method: "PUT" | "DELETE",
): Promise<void> {
  const token = resolveChannelSecret(deps, connection, ["botToken", "token"]);
  const channelId =
    normalizeActivityTarget(input.target, "discord") ?? resolveChannelConfigTarget("discord", connection.config);
  if (!token) {
    throw new Error(`${connection.label} is missing a Discord bot token.`);
  }
  if (!channelId) {
    throw new Error(`${connection.label} is missing a Discord channel target.`);
  }
  const url =
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}` +
    `/messages/${encodeURIComponent(input.messageId)}/reactions/${encodeURIComponent(emoji.trim())}/@me`;
  assertAllowlisted(deps, url);
  const response = await deps.fetchWithDiagnosticsTimeout(url, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
    },
    signal: input.signal,
  });
  if (!response.ok && !(method === "DELETE" && response.status === 404)) {
    const bodyText = await readBoundedResponseText(response, {
      maxBytes: 128 * 1024,
      timeoutMs: 5_000,
      label: "Discord activity",
    });
    throw new Error(`discord.activity failed (${response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
}

async function setTelegramReaction(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  emoji: string | undefined,
): Promise<void> {
  const token = resolveChannelSecret(deps, connection, ["botToken", "token"]);
  const chatId =
    normalizeActivityTarget(input.target, "telegram") ?? resolveChannelConfigTarget("telegram", connection.config);
  if (!token) {
    throw new Error(`${connection.label} is missing a Telegram bot token.`);
  }
  if (!chatId) {
    throw new Error(`${connection.label} is missing a Telegram chat target.`);
  }
  const url = `https://api.telegram.org/bot${token}/setMessageReaction`;
  assertAllowlisted(deps, url);
  const response = await deps.fetchWithDiagnosticsTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: Number.parseInt(input.messageId, 10),
      reaction: emoji ? [{ type: "emoji", emoji }] : [],
    }),
    signal: input.signal,
  });
  const payload = parseJsonRecord(
    await readBoundedResponseText(response, {
      maxBytes: 128 * 1024,
      timeoutMs: 5_000,
      label: "Telegram activity",
    }),
  );
  if (!response.ok || payload.ok === false) {
    throw new Error(
      `telegram.activity failed (${response.status})${payload.description ? `: ${payload.description}` : ""}`,
    );
  }
}

async function sendWhatsAppReaction(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  emoji: string,
): Promise<void> {
  await postWhatsAppMessage(deps, connection, input, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizeActivityTarget(input.target, "whatsapp") ?? resolveChannelConfigTarget("whatsapp", connection.config),
    type: "reaction",
    reaction: {
      message_id: input.messageId,
      emoji,
    },
  });
}

async function sendWhatsAppReadReceipt(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  options: { typing: boolean },
): Promise<ChannelActivityEffectResult> {
  try {
    await postWhatsAppMessage(deps, connection, input, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: input.messageId,
      ...(options.typing ? { typing_indicator: { type: "text" } } : {}),
    });
    return { effect: "read_receipt", supported: true, status: "sent" };
  } catch (error) {
    return {
      effect: "read_receipt",
      supported: true,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function postWhatsAppMessage(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  input: ChannelActivityInput,
  payload: Record<string, unknown>,
): Promise<void> {
  const accessToken = resolveChannelSecret(deps, connection, ["accessToken", "token"]);
  const phoneNumberId =
    readConfigString(connection.config, "phoneNumberId") ?? readConfigString(connection.config, "senderId");
  const baseUrl = normalizeWhatsAppBaseUrl(
    readConfigString(connection.config, "baseUrl"),
    readConfigString(connection.config, "apiVersion"),
  );
  if (!accessToken) {
    throw new Error(`${connection.label} is missing a WhatsApp access token.`);
  }
  if (!phoneNumberId) {
    throw new Error(`${connection.label} is missing a WhatsApp phone number id.`);
  }
  if (payload.type === "reaction" && !payload.to) {
    throw new Error(`${connection.label} is missing a WhatsApp target.`);
  }
  const url = `${baseUrl}/${encodeURIComponent(phoneNumberId)}/messages`;
  assertAllowlisted(deps, url);
  const response = await deps.fetchWithDiagnosticsTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: input.signal,
  });
  const bodyText = await readBoundedResponseText(response, {
    maxBytes: 128 * 1024,
    timeoutMs: 5_000,
    label: "WhatsApp activity",
  });
  const body = parseJsonRecord(bodyText);
  const errorBody = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : {};
  if (!response.ok || Object.keys(errorBody).length > 0) {
    const detail = readOptionalString(errorBody.message) ?? bodyText.trim();
    throw new Error(`whatsapp.activity failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
}

function resolveChannelSecret(
  deps: IntegrationChannelPort,
  connection: IntegrationConnection,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const secret = deps.resolveConnectionSecret(connection.config, key, `${key}Env`, connection.catalogId);
    if (secret) {
      return secret;
    }
  }
  return undefined;
}

function normalizeActivityTarget(value: string | undefined, channelKey: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  switch (channelKey) {
    case "discord":
      return trimmed.replace(/^(discord:|channel:)/i, "").trim();
    case "slack":
      return trimmed.replace(/^(slack:|channel:)/i, "").trim();
    case "telegram":
      return trimmed.replace(/^(telegram:|chat:)/i, "").trim();
    case "whatsapp":
      return trimmed.replace(/^(whatsapp:|wa:)/i, "").trim();
    default:
      return trimmed;
  }
}

function normalizeSlackActivityReaction(emoji: string): string {
  switch (emoji) {
    case "👀":
      return "eyes";
    case "🧠":
      return "brain";
    case "🔧":
      return "hammer_and_wrench";
    case "⚠️":
    case "⚠":
      return "warning";
    case "❌":
      return "x";
    default:
      return emoji.trim().replace(/^:/, "").replace(/:$/, "");
  }
}

function validateWhatsAppBaseUrl(url: string): void {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const isAllowedMetaHost =
      hostname === "graph.facebook.com" ||
      hostname.endsWith(".facebook.com") ||
      hostname === "facebook.com" ||
      hostname.endsWith(".meta.com") ||
      hostname === "meta.com";

    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

    if (!isAllowedMetaHost && !isLoopback) {
      throw new Error(`WhatsApp outbound URL host "${parsed.hostname}" is not an allowed Meta or localhost domain.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not an allowed Meta or localhost domain")) {
      throw error;
    }
    throw new Error(`Invalid WhatsApp baseUrl: ${url}`, { cause: error });
  }
}

function normalizeWhatsAppBaseUrl(baseUrl: string | undefined, apiVersion: string | undefined): string {
  let result: string;
  if (baseUrl?.trim()) {
    result = baseUrl.trim().replace(/\/+$/, "");
  } else {
    const version = apiVersion?.trim() || "v23.0";
    result = `https://graph.facebook.com/${version.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  }
  validateWhatsAppBaseUrl(result);
  return result;
}

function readConfigString(config: Record<string, unknown>, key: string): string | undefined {
  return readOptionalString(config[key]);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function assertAllowlisted(deps: IntegrationChannelPort, url: string): void {
  if (!deps.isConnectionUrlAllowlisted(url)) {
    throw new Error(`Activity provider URL is not in the current outbound allowlist: ${new URL(url).origin}`);
  }
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
