import { randomBytes } from "node:crypto";

export interface TelegramPairingDecision {
  authorized: boolean;
  configPatch?: Record<string, unknown>;
  response?: {
    method: "sendMessage";
    chat_id: string;
    text: string;
  };
}

interface TelegramPairingPendingRecord {
  code: string;
  actorId: string;
  chatId: string;
  displayName?: string;
  createdAt: string;
  expiresAt: string;
}

interface TelegramPairingApprovedRecord {
  actorId: string;
  displayName?: string;
  approvedAt: string;
}

const PAIRING_TTL_MS = 60 * 60 * 1000;
const MAX_PENDING_CODES = 12;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function authorizeTelegramChannelActor(input: {
  config: Record<string, unknown>;
  chatId: string;
  actorId: string;
  actorDisplayName?: string;
  now?: Date;
}): TelegramPairingDecision {
  if (readBoolean(input.config.telegramAllowAllUsers) || readBoolean(input.config.allowAllTelegramUsers)) {
    return { authorized: true };
  }
  const pairing = readPairingState(input.config);
  if (pairing.approved.some((item) => item.actorId === input.actorId)) {
    return { authorized: true };
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const notExpired = pairing.pending.filter((item) => Date.parse(item.expiresAt) > nowMs).slice(0, MAX_PENDING_CODES);
  const existing = notExpired.find((item) => item.actorId === input.actorId && item.chatId === input.chatId);
  const pending = existing ?? createPendingPairing(input, now);
  const nextPending = existing ? notExpired : [pending, ...notExpired].slice(0, MAX_PENDING_CODES);
  const droppedExpired = notExpired.length !== pairing.pending.length;

  return {
    authorized: false,
    configPatch:
      existing && !droppedExpired
        ? undefined
        : {
            telegramPairing: {
              approved: pairing.approved,
              pending: nextPending,
            },
          },
    response: {
      method: "sendMessage",
      chat_id: input.chatId,
      text: [
        "Hi. I do not recognize this Telegram user yet.",
        "",
        `Pairing code: ${pending.code}`,
        "",
        "Approve it from GoatCitadel Mission Control or the channel pairing API, then try again.",
        "Remote terminal, file, web, and connector actions remain approval-gated after pairing.",
      ].join("\n"),
    },
  };
}

export function approveTelegramPairingCode(
  config: Record<string, unknown>,
  code: string,
  now: Date = new Date(),
): {
  approved: boolean;
  configPatch?: Record<string, unknown>;
  actorId?: string;
  displayName?: string;
} {
  const normalizedCode = code.trim().toUpperCase();
  if (!normalizedCode) {
    return { approved: false };
  }
  const pairing = readPairingState(config);
  const nowMs = now.getTime();
  const pending = pairing.pending.filter((item) => Date.parse(item.expiresAt) > nowMs);
  const match = pending.find((item) => item.code === normalizedCode);
  if (!match) {
    return { approved: false };
  }
  const approved: TelegramPairingApprovedRecord[] = [
    {
      actorId: match.actorId,
      displayName: match.displayName,
      approvedAt: now.toISOString(),
    },
    ...pairing.approved.filter((item) => item.actorId !== match.actorId),
  ];
  return {
    approved: true,
    actorId: match.actorId,
    displayName: match.displayName,
    configPatch: {
      telegramPairing: {
        approved,
        pending: pending.filter((item) => item.code !== normalizedCode),
      },
    },
  };
}

function readPairingState(config: Record<string, unknown>): {
  approved: TelegramPairingApprovedRecord[];
  pending: TelegramPairingPendingRecord[];
} {
  const root = readRecord(config.telegramPairing);
  return {
    approved: readArray(root.approved).flatMap(readApprovedRecord),
    pending: readArray(root.pending).flatMap(readPendingRecord),
  };
}

function readApprovedRecord(value: unknown): TelegramPairingApprovedRecord[] {
  const record = readRecord(value);
  const actorId = readString(record.actorId);
  const approvedAt = readString(record.approvedAt);
  if (!actorId || !approvedAt) {
    return [];
  }
  return [{ actorId, approvedAt, displayName: readString(record.displayName) }];
}

function readPendingRecord(value: unknown): TelegramPairingPendingRecord[] {
  const record = readRecord(value);
  const code = readString(record.code);
  const actorId = readString(record.actorId);
  const chatId = readString(record.chatId);
  const createdAt = readString(record.createdAt);
  const expiresAt = readString(record.expiresAt);
  if (!code || !actorId || !chatId || !createdAt || !expiresAt) {
    return [];
  }
  return [{ code, actorId, chatId, createdAt, expiresAt, displayName: readString(record.displayName) }];
}

function createPendingPairing(
  input: {
    chatId: string;
    actorId: string;
    actorDisplayName?: string;
  },
  now: Date,
): TelegramPairingPendingRecord {
  return {
    code: createPairingCode(),
    actorId: input.actorId,
    chatId: input.chatId,
    displayName: input.actorDisplayName,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
  };
}

function createPairingCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes)
    .map((byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length])
    .join("");
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true || (typeof value === "string" && ["true", "1", "yes", "on"].includes(value.toLowerCase()));
}
