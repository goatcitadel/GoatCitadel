import { createHash } from "node:crypto";
import { readBoundedResponseJson } from "../sandbox/network-guard.js";

/**
 * Minimal QQ Bot Open Platform client for outbound text.
 *
 * Token mint and message send take separate transports so the caller can mark only the send as an
 * external side effect. Error text never includes the app secret or the access token, and response
 * bodies are read through the bounded reader.
 */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const QQBOT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
// QQ's 2026-08-10 API changelog unified all API call domains under api.bot.qq.com. The changelog does not
// mention the token endpoint or the sandbox host, so those stay on bots.qq.com and sandbox.api.sgroup.qq.com
// (unverified; revisit if QQ publishes a unified sandbox host).
const QQBOT_API_BASE = "https://api.bot.qq.com";
const QQBOT_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
const QQBOT_RESPONSE_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 10_000 } as const;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_SECONDS = 7_200;
const TARGET_ERROR = "QQBot target must be group:, user:, channel: or dm:";

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

function cacheKey(appId: string, appSecret: string): string {
  return createHash("sha256").update(`${appId}\n${appSecret}`).digest("hex");
}

export async function getQqbotAccessToken(input: {
  appId: string;
  appSecret: string;
  fetcher: Fetcher;
  now?: () => number;
}): Promise<string> {
  const now = input.now ?? Date.now;
  const key = cacheKey(input.appId, input.appSecret);
  const cached = tokenCache.get(key);
  if (cached && now() < cached.expiresAtMs) {
    return cached.token;
  }
  const scrub = (text: string) => scrubSecrets(text, [input.appSecret]);
  let response: Response;
  try {
    response = await input.fetcher(QQBOT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: input.appId, clientSecret: input.appSecret }),
    });
  } catch (error) {
    throw scrubbedFailure("QQBot token request failed", error, scrub);
  }
  const body = await readQqbotBody(response);
  if (!response.ok) {
    throw new Error(`QQBot token request failed (${response.status})${describeQqbotError(body, scrub)}`);
  }
  const token = typeof body.access_token === "string" ? body.access_token.trim() : "";
  if (!token) {
    throw new Error("QQBot token response had no access_token");
  }
  const expiresIn = Number(body.expires_in);
  const ttlSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_TTL_SECONDS;
  tokenCache.set(key, { token, expiresAtMs: now() + ttlSeconds * 1000 - TOKEN_EXPIRY_MARGIN_MS });
  return token;
}

/** Drops a cached token (used after QQ reports it invalid or expired). */
export function clearQqbotAccessToken(input: { appId: string; appSecret: string }): void {
  tokenCache.delete(cacheKey(input.appId, input.appSecret));
}

// UNVERIFIED: these token-rejected codes are from QQ docs memory, not a live capture. The HTTP 401 branch below is
// the reliable signal; confirm or correct the codes against a real rejected-token response.
const TOKEN_REJECTED_CODES = new Set([11242, 11243, 11244]);

export async function qqbotSendText(input: {
  token: string;
  sandbox: boolean;
  target: string;
  content: string;
  replyMsgId?: string;
  msgSeq: number;
  fetcher: Fetcher;
  /** Mints a fresh token after QQ rejects the current one; the send is retried at most once. */
  refreshToken?: () => Promise<string>;
}): Promise<{ messageId: string }> {
  const { path, body } = buildSendRequest(input);
  const base = input.sandbox ? QQBOT_SANDBOX_API_BASE : QQBOT_API_BASE;
  let token = input.token;
  let retried = false;
  for (;;) {
    const result = await attemptSend(token);
    if (result.kind === "sent") return { messageId: result.messageId };
    if (!retried && input.refreshToken) {
      retried = true;
      token = await input.refreshToken();
      continue;
    }
    throw result.error;
  }

  async function attemptSend(
    accessToken: string,
  ): Promise<{ kind: "sent"; messageId: string } | { kind: "rejected"; error: Error }> {
    const scrub = (text: string) => scrubSecrets(text, [accessToken]);
    let response: Response;
    try {
      response = await input.fetcher(`${base}${path}`, {
        method: "POST",
        headers: { Authorization: `QQBot ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw scrubbedFailure("QQBot send failed", error, scrub);
    }
    const parsed = await readQqbotBody(response);
    if (!response.ok) {
      const error = new Error(`QQBot send failed (${response.status})${describeQqbotError(parsed, scrub)}`);
      if (response.status === 401 || TOKEN_REJECTED_CODES.has(Number(parsed.code))) {
        return { kind: "rejected", error };
      }
      throw error;
    }
    const messageId = typeof parsed.id === "string" ? parsed.id.trim() : "";
    if (!messageId) {
      throw new Error("QQBot send returned no message id");
    }
    return { kind: "sent", messageId };
  }
}

function buildSendRequest(input: { target: string; content: string; replyMsgId?: string; msgSeq: number }): {
  path: string;
  body: Record<string, unknown>;
} {
  const match = /^(group|user|channel|dm):(.+)$/s.exec(input.target.trim());
  const id = match?.[2]?.trim();
  if (!match || !id) {
    throw new Error(TARGET_ERROR);
  }
  const encoded = encodeURIComponent(id);
  const replyId = input.replyMsgId?.trim();
  const reply = replyId ? { msg_id: replyId } : {};
  switch (match[1]) {
    case "group":
      return {
        path: `/v2/groups/${encoded}/messages`,
        body: { content: input.content, msg_type: 0, ...reply, msg_seq: input.msgSeq },
      };
    case "user":
      return {
        path: `/v2/users/${encoded}/messages`,
        body: { content: input.content, msg_type: 0, ...reply, msg_seq: input.msgSeq },
      };
    case "channel":
      return { path: `/channels/${encoded}/messages`, body: { content: input.content, ...reply } };
    default:
      return { path: `/dms/${encoded}/messages`, body: { content: input.content, ...reply } };
  }
}

async function readQqbotBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await readBoundedResponseJson(response, QQBOT_RESPONSE_LIMITS);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    // Non-JSON or oversized bodies: surface only the HTTP status.
    return {};
  }
}

function describeQqbotError(body: Record<string, unknown>, scrub: (text: string) => string): string {
  const code = typeof body.code === "number" || typeof body.code === "string" ? String(body.code) : undefined;
  const message = typeof body.message === "string" ? body.message : undefined;
  const detail = [code, message ? scrub(message) : undefined].filter(Boolean).join(": ");
  return detail ? `: ${detail}` : "";
}

/** The cause is a scrubbed copy so an unscrubbed original (which may hold a secret) is never serialized. */
function scrubbedFailure(label: string, error: unknown, scrub: (text: string) => string): Error {
  const message = scrub(error instanceof Error ? error.message : String(error));
  return new Error(`${label}: ${message}`, { cause: new Error(message) });
}

function scrubSecrets(text: string, secrets: string[]): string {
  return secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc), text);
}
