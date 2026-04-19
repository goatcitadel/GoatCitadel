import type { ChannelTypingResult } from "@goatcitadel/contracts";

type TelegramTypingRequest = {
  connectionId: string;
  target: string;
  token: string;
  chatId: string;
  threadId?: string;
  durationMs?: number;
  signal?: AbortSignal;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
};

const TELEGRAM_TYPING_MIN_MS = 1_000;
const TELEGRAM_TYPING_MAX_MS = 5_000;

export async function sendTelegramTypingIndicator(input: TelegramTypingRequest): Promise<ChannelTypingResult> {
  const response = await input.fetcher(`https://api.telegram.org/bot${input.token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      action: "typing",
      message_thread_id: parseOptionalPositiveInt(input.threadId),
    }),
    signal: input.signal,
  });
  const payload = parseJsonRecord(await response.text());
  if (!response.ok || payload.ok === false) {
    throw new Error(
      `telegram.typing failed (${response.status})${payload.description ? `: ${payload.description}` : ""}`,
    );
  }

  const durationMs = clampTelegramTypingDuration(input.durationMs);
  return {
    channelKey: "telegram",
    connectionId: input.connectionId,
    target: input.target,
    supported: true,
    status: "sent",
    expiresAt: new Date(Date.now() + durationMs).toISOString(),
  };
}

function clampTelegramTypingDuration(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TELEGRAM_TYPING_MAX_MS;
  }
  return Math.min(TELEGRAM_TYPING_MAX_MS, Math.max(TELEGRAM_TYPING_MIN_MS, Math.trunc(value)));
}

function parseOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
