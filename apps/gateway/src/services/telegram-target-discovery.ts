import { readBoundedResponseJson } from "./bounded-response-reader.js";

export interface TelegramDiscoveredTarget {
  id: string;
  label: string;
  chatId: string;
  kind: "private" | "group" | "supergroup" | "channel" | "unknown";
  setupCodeMatched?: boolean;
  lastMessageId?: number;
}

export async function discoverTelegramTargets(input: {
  token: string;
  setupCode?: string;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<TelegramDiscoveredTarget[]> {
  const response = await input.fetcher(`https://api.telegram.org/bot${input.token}/getUpdates`);
  const payload = await readBoundedResponseJson(response, {
    maxBytes: 256 * 1024,
    timeoutMs: 5_000,
    label: "Telegram getUpdates",
  });
  if (response.status < 200 || response.status >= 300 || !isRecord(payload) || payload.ok === false) {
    const description = isRecord(payload) && typeof payload.description === "string" ? payload.description : undefined;
    throw new Error(description ?? `Telegram getUpdates failed with HTTP ${response.status}.`);
  }
  return parseTelegramUpdateTargets(payload, input.setupCode);
}

export function parseTelegramUpdateTargets(payload: unknown, setupCode?: string): TelegramDiscoveredTarget[] {
  if (!isRecord(payload) || !Array.isArray(payload.result)) {
    return [];
  }
  const byChatId = new Map<string, TelegramDiscoveredTarget>();
  for (const update of payload.result) {
    const message = readTelegramMessage(update);
    const chat = isRecord(message?.chat) ? message.chat : undefined;
    const id = readChatId(chat);
    if (!id) {
      continue;
    }
    const text = typeof message?.text === "string" ? message.text : "";
    const current = byChatId.get(id);
    const discovered: TelegramDiscoveredTarget = {
      id: `telegram:${id}`,
      label: renderTelegramChatLabel(chat) ?? current?.label ?? id,
      chatId: id,
      kind: readTelegramChatKind(chat),
      setupCodeMatched: Boolean(current?.setupCodeMatched || (setupCode && text.includes(setupCode))),
      lastMessageId: typeof message?.message_id === "number" ? message.message_id : current?.lastMessageId,
    };
    byChatId.set(id, discovered);
  }
  return [...byChatId.values()].sort((left, right) => {
    if (left.setupCodeMatched !== right.setupCodeMatched) {
      return left.setupCodeMatched ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });
}

function readTelegramMessage(update: unknown): Record<string, unknown> | undefined {
  if (!isRecord(update)) {
    return undefined;
  }
  const candidates = [update.message, update.channel_post, update.edited_message, update.edited_channel_post];
  return candidates.find((candidate): candidate is Record<string, unknown> => isRecord(candidate));
}

function readChatId(chat: Record<string, unknown> | undefined): string | undefined {
  const id = chat?.id;
  return typeof id === "number" || typeof id === "string" ? String(id) : undefined;
}

function readTelegramChatKind(chat: Record<string, unknown> | undefined): TelegramDiscoveredTarget["kind"] {
  const type = chat?.type;
  return type === "private" || type === "group" || type === "supergroup" || type === "channel" ? type : "unknown";
}

function renderTelegramChatLabel(chat: Record<string, unknown> | undefined): string | undefined {
  const title = readString(chat, "title");
  if (title) {
    return title;
  }
  const username = readString(chat, "username");
  if (username) {
    return username.startsWith("@") ? username : `@${username}`;
  }
  const firstName = readString(chat, "first_name");
  const lastName = readString(chat, "last_name");
  return [firstName, lastName].filter(Boolean).join(" ").trim() || undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
