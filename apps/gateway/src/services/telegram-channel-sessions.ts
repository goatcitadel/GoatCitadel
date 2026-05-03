import { randomBytes, createHash } from "node:crypto";
import { resolveSessionRoute } from "@goatcitadel/gateway-core";

export interface TelegramChannelSessionScope {
  account?: string;
  peer?: string;
  room?: string;
  threadId?: string;
}

export interface TelegramChannelSessionPatchInput {
  config: Record<string, unknown>;
  chatId: string;
  threadId?: string;
  actorId: string;
  now?: Date;
}

interface TelegramChannelSessionRecord {
  nonce: string;
  chatId: string;
  threadId?: string;
  actorId: string;
  rotatedAt: string;
}

const TELEGRAM_CHANNEL_SESSION_KEY = "telegramChannelSessions";
const SESSION_NONCE_PREFIX = "tg_";

export function createTelegramChannelSessionPatch(input: TelegramChannelSessionPatchInput): Record<string, unknown> {
  const now = input.now ?? new Date();
  const current = readRecord(input.config[TELEGRAM_CHANNEL_SESSION_KEY]);
  const scopeKey = buildTelegramChannelSessionScope({ room: input.chatId, threadId: input.threadId });
  const record: TelegramChannelSessionRecord = {
    nonce: createSessionNonce(),
    chatId: input.chatId,
    threadId: input.threadId,
    actorId: input.actorId,
    rotatedAt: now.toISOString(),
  };
  return {
    [TELEGRAM_CHANNEL_SESSION_KEY]: {
      ...current,
      [scopeKey]: record,
    },
    telegramChannelSessionUpdatedAt: record.rotatedAt,
  };
}

export function applyTelegramChannelSessionRotation(
  config: Record<string, unknown>,
  route: TelegramChannelSessionScope,
): TelegramChannelSessionScope {
  const target = route.room ?? route.peer;
  if (!target) {
    return route;
  }
  const record = readSessionRecord(config, { room: target, threadId: route.threadId });
  if (!record) {
    return route;
  }
  if (route.threadId) {
    return {
      ...route,
      threadId: appendSessionNonce(route.threadId, record.nonce),
    };
  }
  if (route.room) {
    return {
      ...route,
      room: appendSessionNonce(route.room, record.nonce),
    };
  }
  return {
    ...route,
    peer: appendSessionNonce(route.peer ?? target, record.nonce),
  };
}

export function resolveTelegramChannelSessionId(
  config: Record<string, unknown>,
  route: TelegramChannelSessionScope & { account: string },
): string | undefined {
  const routed = applyTelegramChannelSessionRotation(config, route);
  try {
    return resolveSessionRoute({
      channel: "telegram",
      account: route.account,
      peer: routed.peer,
      room: routed.room,
      threadId: routed.threadId,
    }).sessionId;
  } catch {
    return undefined;
  }
}

export function buildTelegramChannelSessionScope(
  route: Pick<TelegramChannelSessionScope, "peer" | "room" | "threadId">,
): string {
  const target = route.room ?? route.peer;
  if (!target) {
    return "unknown";
  }
  return route.threadId ? `${hashScopeSegment(target)}:${hashScopeSegment(route.threadId)}` : hashScopeSegment(target);
}

function readSessionRecord(
  config: Record<string, unknown>,
  route: Pick<TelegramChannelSessionScope, "peer" | "room" | "threadId">,
): TelegramChannelSessionRecord | undefined {
  const sessions = readRecord(config[TELEGRAM_CHANNEL_SESSION_KEY]);
  const record = readRecord(sessions[buildTelegramChannelSessionScope(route)]);
  const nonce = readString(record.nonce);
  const chatId = readString(record.chatId);
  const actorId = readString(record.actorId);
  const rotatedAt = readString(record.rotatedAt);
  if (!nonce || !chatId || !actorId || !rotatedAt || !/^tg_[a-zA-Z0-9_-]{8,32}$/.test(nonce)) {
    return undefined;
  }
  return {
    nonce,
    chatId,
    actorId,
    rotatedAt,
    threadId: readString(record.threadId),
  };
}

function appendSessionNonce(value: string, nonce: string): string {
  return `${value}~${nonce}`;
}

function createSessionNonce(): string {
  return `${SESSION_NONCE_PREFIX}${randomBytes(9).toString("base64url")}`;
}

function hashScopeSegment(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 24);
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
