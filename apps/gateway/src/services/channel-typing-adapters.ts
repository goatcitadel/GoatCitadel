import { createHash } from "node:crypto";
import type { ChannelTypingInput, ChannelTypingResult, IntegrationConnection } from "@goatcitadel/contracts";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import type { ChannelSecretOwner } from "./channel-secret-resolution.js";
import { isConnectionUrlRemoteSafe } from "./connection-url-helpers.js";

/**
 * Provider typing indicators for channels that have no dedicated runtime service.
 * Every adapter returns a ChannelTypingResult and never throws: failures are reported
 * as `status: "unsupported"` with an operator-readable reason.
 */
export interface ChannelTypingAdapterArgs {
  connection: IntegrationConnection;
  input: ChannelTypingInput;
  resolveSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId: string,
    owner: ChannelSecretOwner,
  ): string | undefined;
  isAllowlisted(url: string): boolean;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** The slice of the integration-channel port the provider typing adapters need. */
export interface ChannelTypingAdapterDeps {
  resolveConnectionSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId: string,
    owner: ChannelSecretOwner,
  ): string | undefined;
  isConnectionUrlAllowlisted(urlValue: string): boolean;
  fetchWithDiagnosticsTimeout(url: string, init?: RequestInit): Promise<Response>;
}

/** Runs the provider typing adapter for the connection using the gateway-owned secret, allowlist and fetch ports. */
export function emitProviderTypingWithDeps(
  deps: ChannelTypingAdapterDeps,
  connection: IntegrationConnection,
  input: ChannelTypingInput,
): Promise<ChannelTypingResult> {
  return emitProviderTyping({
    connection,
    input,
    resolveSecret: (config, directKey, envKey, catalogId, owner) =>
      deps.resolveConnectionSecret(config, directKey, envKey, catalogId, owner),
    isAllowlisted: (url) => deps.isConnectionUrlAllowlisted(url),
    fetch: (url, init) => deps.fetchWithDiagnosticsTimeout(url, init),
  });
}

const MAX_RESPONSE_BYTES = 128 * 1024;
const RESPONSE_TIMEOUT_MS = 5_000;
const MATTERMOST_ID_PATTERN = /^[a-z0-9]{26}$/;
const WHATSAPP_DEFAULT_API_VERSION = "v23.0";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_TYPING_TTL_MS = 10_000;
const DISCORD_SNOWFLAKE_PATTERN = /^[0-9]{5,25}$/;

const mattermostUserIdCache = new Map<string, string>();
const matrixUserIdCache = new Map<string, string>();
const MATRIX_TYPING_TIMEOUT_MS = 10_000;
const MATRIX_ROOM_ID_PATTERN = /^![^\s:]+(?::\S+)?$/;

export function resetMattermostTypingUserCache(): void {
  mattermostUserIdCache.clear();
}

export function resetMatrixTypingUserCache(): void {
  matrixUserIdCache.clear();
}

/** Discord gateway-mode connections type through the persistent runtime; everything else uses REST. */
export function isDiscordGatewayMode(config: Record<string, unknown> | undefined): boolean {
  return readString(config?.runtimeMode) === "gateway";
}

export async function emitProviderTyping(args: ChannelTypingAdapterArgs): Promise<ChannelTypingResult> {
  try {
    switch (args.connection.key) {
      case "mattermost":
        return await emitMattermostTyping(args);
      case "matrix":
        return await emitMatrixTyping(args);
      case "whatsapp":
        return await emitWhatsAppTyping(args);
      case "discord":
        return await emitDiscordRestTyping(args);
      default:
        return unsupported(args, `${args.connection.label} has not wired a typing adapter yet.`);
    }
  } catch (error) {
    return unsupported(args, errorMessage(error));
  }
}

export async function emitMatrixTyping(args: ChannelTypingAdapterArgs): Promise<ChannelTypingResult> {
  try {
    const { connection, input } = args;
    const homeserver = readString(connection.config.homeserverUrl);
    const token = args.resolveSecret(
      connection.config,
      "accessToken",
      "accessTokenEnv",
      connection.catalogId,
      connection,
    );
    if (!homeserver) return unsupported(args, `${connection.label} is missing a Matrix homeserver URL.`);
    if (!token) return unsupported(args, `${connection.label} is missing a Matrix access token.`);
    const roomId = input.target.trim().replace(/^(?:matrix|room):/i, "");
    if (!MATRIX_ROOM_ID_PATTERN.test(roomId)) {
      return unsupported(args, "Matrix typing needs a room id target such as !room or !room:example.com.");
    }
    const apiBase = `${homeserver.replace(/\/+$/, "")}/_matrix/client/v3`;
    if (!isConnectionUrlRemoteSafe(apiBase)) {
      return unsupported(args, "Matrix homeserver must use HTTPS (plain HTTP is only allowed for localhost)");
    }
    const authHeaders = { Authorization: `Bearer ${token}` };

    const cacheKey = `${connection.connectionId}:${createHash("sha256").update(token).digest("hex")}`;
    let userId = matrixUserIdCache.get(cacheKey);
    if (!userId) {
      const whoamiUrl = `${apiBase}/account/whoami`;
      if (!args.isAllowlisted(whoamiUrl)) return unsupported(args, allowlistReason(whoamiUrl));
      const whoami = await args.fetch(whoamiUrl, { method: "GET", headers: authHeaders, signal: input.signal });
      const whoamiBody = await readBody(whoami, "Matrix typing");
      if (!whoami.ok) return unsupported(args, matrixHttpReason(whoami.status, whoamiBody, token));
      userId = readString(parseJsonRecord(whoamiBody).user_id);
      if (!userId) return unsupported(args, "Matrix did not return the bot user id.");
      matrixUserIdCache.set(cacheKey, userId);
    }

    const url = `${apiBase}/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`;
    if (!args.isAllowlisted(url)) return unsupported(args, allowlistReason(url));
    const response = await args.fetch(url, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ typing: true, timeout: MATRIX_TYPING_TIMEOUT_MS }),
      signal: input.signal,
    });
    const body = await readBody(response, "Matrix typing");
    if (!response.ok) {
      if (response.status === 401) matrixUserIdCache.delete(cacheKey);
      return unsupported(args, matrixHttpReason(response.status, body, token));
    }
    return sent(args);
  } catch (error) {
    return unsupported(args, errorMessage(error));
  }
}

function matrixHttpReason(status: number, body: string, token: string): string {
  const record = parseJsonRecord(body);
  const detail = [readString(record.errcode), readString(record.error)].filter(Boolean).join(": ");
  return `Matrix typing failed (${status})${detail ? `: ${detail.split(token).join("[redacted]")}` : ""}`;
}

export async function emitMattermostTyping(args: ChannelTypingAdapterArgs): Promise<ChannelTypingResult> {
  try {
    const { connection, input } = args;
    const serverUrl = readString(connection.config.serverUrl) ?? readString(connection.config.baseUrl);
    const token =
      args.resolveSecret(connection.config, "botToken", "botTokenEnv", connection.catalogId, connection) ??
      args.resolveSecret(connection.config, "token", "tokenEnv", connection.catalogId, connection);
    if (!serverUrl) return unsupported(args, `${connection.label} is missing a Mattermost server URL.`);
    if (!token) return unsupported(args, `${connection.label} is missing a Mattermost bot token.`);
    const channelId = parseMattermostChannelId(input.target);
    if (!channelId) {
      return unsupported(args, "Mattermost typing needs a channel id target (channel:<id> or a 26-character id).");
    }
    const apiBase = `${serverUrl.replace(/\/+$/, "")}/api/v4`;
    if (!isConnectionUrlRemoteSafe(apiBase)) {
      return unsupported(args, "Mattermost server must use HTTPS (plain HTTP is only allowed for localhost)");
    }
    const authHeaders = { Authorization: `Bearer ${token}` };

    const cacheKey = `${connection.connectionId}:${createHash("sha256").update(token).digest("hex")}`;
    let userId = mattermostUserIdCache.get(cacheKey);
    if (!userId) {
      const meUrl = `${apiBase}/users/me`;
      if (!args.isAllowlisted(meUrl)) return unsupported(args, allowlistReason(meUrl));
      const meResponse = await args.fetch(meUrl, { method: "GET", headers: authHeaders, signal: input.signal });
      const meBody = await readBody(meResponse, "Mattermost typing");
      if (!meResponse.ok) return unsupported(args, httpReason("Mattermost", meResponse.status, meBody));
      userId = readString(parseJsonRecord(meBody).id);
      if (!userId) return unsupported(args, "Mattermost did not return the bot user id.");
      mattermostUserIdCache.set(cacheKey, userId);
    }

    const url = `${apiBase}/users/${encodeURIComponent(userId)}/typing`;
    if (!args.isAllowlisted(url)) return unsupported(args, allowlistReason(url));
    const response = await args.fetch(url, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: channelId,
        ...(input.threadId ? { parent_id: input.threadId } : {}),
      }),
      signal: input.signal,
    });
    const body = await readBody(response, "Mattermost typing");
    if (!response.ok) {
      if (response.status === 401) mattermostUserIdCache.delete(cacheKey);
      return unsupported(args, httpReason("Mattermost", response.status, body));
    }
    return sent(args);
  } catch (error) {
    return unsupported(args, errorMessage(error));
  }
}

export async function emitWhatsAppTyping(args: ChannelTypingAdapterArgs): Promise<ChannelTypingResult> {
  try {
    const { connection, input } = args;
    const messageId = readString(input.messageId);
    if (!messageId) {
      return unsupported(
        args,
        "WhatsApp typing indicators are tied to an inbound message; no message id was supplied.",
      );
    }
    const accessToken =
      args.resolveSecret(connection.config, "accessToken", "accessTokenEnv", connection.catalogId, connection) ??
      args.resolveSecret(connection.config, "token", "tokenEnv", connection.catalogId, connection);
    const phoneNumberId = readString(connection.config.phoneNumberId) ?? readString(connection.config.senderId);
    if (!accessToken) return unsupported(args, `${connection.label} is missing a WhatsApp access token.`);
    if (!phoneNumberId) return unsupported(args, `${connection.label} is missing a WhatsApp phone number id.`);
    const baseUrl = normalizeWhatsAppBaseUrl(
      readString(connection.config.baseUrl),
      readString(connection.config.apiVersion),
    );
    const url = `${baseUrl}/${encodeURIComponent(phoneNumberId)}/messages`;
    if (!args.isAllowlisted(url)) return unsupported(args, allowlistReason(url));
    const response = await args.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
      signal: input.signal,
    });
    const body = await readBody(response, "WhatsApp typing");
    const apiError = parseJsonRecord(body).error;
    if (!response.ok || (apiError && typeof apiError === "object")) {
      const detail =
        apiError && typeof apiError === "object"
          ? readString((apiError as Record<string, unknown>).message)
          : undefined;
      return unsupported(
        args,
        `WhatsApp typing failed (${response.status})${detail ? `: ${detail}` : body.trim() ? `: ${body.trim().slice(0, 200)}` : ""}`,
      );
    }
    return sent(args);
  } catch (error) {
    return unsupported(args, errorMessage(error));
  }
}

/**
 * Discord typing over REST for bridge-mode connections (bot token, no gateway session):
 * POST /channels/{channel.id}/typing. A user target first opens the DM channel with
 * POST /users/@me/channels. Discord expires the indicator after 10 seconds.
 */
export async function emitDiscordRestTyping(args: ChannelTypingAdapterArgs): Promise<ChannelTypingResult> {
  try {
    const { connection, input } = args;
    const token =
      args.resolveSecret(connection.config, "botToken", "botTokenEnv", connection.catalogId, connection) ??
      args.resolveSecret(connection.config, "token", "tokenEnv", connection.catalogId, connection);
    if (!token) {
      return unsupported(
        args,
        `${connection.label} has no Discord bot token; Discord webhooks cannot send typing indicators.`,
      );
    }
    const target = parseDiscordTypingTarget(
      readString(input.target) ?? readString(connection.config.defaultChannelId) ?? "",
    );
    if (!target) {
      return unsupported(args, "Discord typing needs a channel or user id target (channel:<id>, user:<id>, or an id).");
    }
    const authHeaders = { Authorization: `Bot ${token}` };
    let channelId = target.id;
    if (target.kind === "user") {
      const dmUrl = `${DISCORD_API_BASE}/users/@me/channels`;
      if (!args.isAllowlisted(dmUrl)) return unsupported(args, allowlistReason(dmUrl));
      const dmResponse = await args.fetch(dmUrl, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ recipient_id: target.id }),
        signal: input.signal,
      });
      const dmBody = await readBody(dmResponse, "Discord typing");
      if (!dmResponse.ok) return unsupported(args, httpReason("Discord", dmResponse.status, dmBody));
      const dmChannelId = readString(parseJsonRecord(dmBody).id);
      if (!dmChannelId) return unsupported(args, "Discord did not return a DM channel id.");
      channelId = dmChannelId;
    }
    const url = `${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/typing`;
    if (!args.isAllowlisted(url)) return unsupported(args, allowlistReason(url));
    const response = await args.fetch(url, { method: "POST", headers: authHeaders, signal: input.signal });
    const body = await readBody(response, "Discord typing");
    if (!response.ok) return unsupported(args, httpReason("Discord", response.status, body));
    return { ...sent(args), expiresAt: new Date(Date.now() + DISCORD_TYPING_TTL_MS).toISOString() };
  } catch (error) {
    return unsupported(args, errorMessage(error));
  }
}

export function validateWhatsAppBaseUrl(url: string): void {
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

export function normalizeWhatsAppBaseUrl(baseUrl: string | undefined, apiVersion: string | undefined): string {
  let result: string;
  if (baseUrl?.trim()) {
    result = baseUrl.trim().replace(/\/+$/, "");
  } else {
    const version = apiVersion?.trim() || WHATSAPP_DEFAULT_API_VERSION;
    result = `https://graph.facebook.com/${version.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  }
  validateWhatsAppBaseUrl(result);
  return result;
}

function parseMattermostChannelId(target: string): string | undefined {
  const trimmed = target.trim();
  const candidate = /^channel:/i.test(trimmed) ? trimmed.slice("channel:".length).trim() : trimmed;
  return MATTERMOST_ID_PATTERN.test(candidate) ? candidate : undefined;
}

function parseDiscordTypingTarget(target: string): { kind: "channel" | "user"; id: string } | undefined {
  const trimmed = target.trim();
  const mention = trimmed.match(/^<(#|@!?)(\d+)>$/);
  let kind: "channel" | "user" = "channel";
  let id = trimmed;
  if (mention) {
    kind = mention[1] === "#" ? "channel" : "user";
    id = mention[2] ?? "";
  } else if (/^channel:/i.test(trimmed)) {
    id = trimmed.slice("channel:".length).trim();
  } else if (/^(user|discord):/i.test(trimmed)) {
    kind = "user";
    id = trimmed.slice(trimmed.indexOf(":") + 1).trim();
  }
  return DISCORD_SNOWFLAKE_PATTERN.test(id) ? { kind, id } : undefined;
}

function sent(args: ChannelTypingAdapterArgs): ChannelTypingResult {
  return {
    channelKey: args.connection.key,
    connectionId: args.connection.connectionId,
    target: args.input.target,
    supported: true,
    status: "sent",
  };
}

function unsupported(args: ChannelTypingAdapterArgs, reason: string): ChannelTypingResult {
  return {
    channelKey: args.connection.key,
    connectionId: args.connection.connectionId,
    target: args.input.target,
    supported: false,
    status: "unsupported",
    reason,
  };
}

function allowlistReason(url: string): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // keep the raw value
  }
  return `Typing provider URL is not in the current outbound allowlist: ${origin}`;
}

function httpReason(provider: string, status: number, body: string): string {
  const detail = readString(parseJsonRecord(body).message) ?? body.trim().slice(0, 200);
  return `${provider} typing failed (${status})${detail ? `: ${detail}` : ""}`;
}

async function readBody(response: Response, label: string): Promise<string> {
  return readBoundedResponseText(response, { maxBytes: MAX_RESPONSE_BYTES, timeoutMs: RESPONSE_TIMEOUT_MS, label });
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
