import { createHash } from "node:crypto";
import { readBoundedResponseJson } from "../sandbox/network-guard.js";
import type { Fetcher } from "./qqbot-client.js";

/**
 * Minimal WeCom (WeChat Work) server API client for outbound application text.
 *
 * The access token travels in the request URL query, so every error message is built without the URL
 * and is scrubbed of the token and corp secret. Token mint and message send take separate transports so
 * the caller can mark only the send as an external side effect.
 */
const WECOM_API_BASE = "https://qyapi.weixin.qq.com";
const WECOM_RESPONSE_LIMITS = { maxBytes: 64 * 1024, timeoutMs: 10_000 } as const;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_SECONDS = 7_200;
const MAX_TEXT_BYTES = 2048;
const TOKEN_REJECTED_ERRCODES = new Set([40014, 42001]);

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

function cacheKey(corpId: string, secret: string): string {
  return createHash("sha256").update(`${corpId}\n${secret}`).digest("hex");
}

/** Drops a cached token (used after WeCom reports it invalid or expired). */
export function clearWecomAccessToken(input: { corpId: string; secret: string }): void {
  tokenCache.delete(cacheKey(input.corpId, input.secret));
}

export async function getWecomAccessToken(input: {
  corpId: string;
  secret: string;
  fetcher: Fetcher;
  now?: () => number;
}): Promise<string> {
  const now = input.now ?? Date.now;
  const key = cacheKey(input.corpId, input.secret);
  const cached = tokenCache.get(key);
  if (cached && now() < cached.expiresAtMs) {
    return cached.token;
  }
  const url = `${WECOM_API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(input.corpId)}&corpsecret=${encodeURIComponent(input.secret)}`;
  let response: Response;
  try {
    response = await input.fetcher(url, { method: "GET" });
  } catch (error) {
    throw scrubbedFailure("WeCom gettoken request failed", error, [input.secret, input.corpId]);
  }
  const body = await readWecomBody(response);
  if (!response.ok) {
    throw new Error(`WeCom gettoken request failed (${response.status})`);
  }
  const errcode = readErrcode(body);
  if (errcode !== 0) {
    throw new Error(`WeCom gettoken failed (errcode ${errcode})`);
  }
  const token = typeof body.access_token === "string" ? body.access_token.trim() : "";
  if (!token) {
    throw new Error("WeCom gettoken response had no access_token");
  }
  const expiresIn = Number(body.expires_in);
  const ttlSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_TTL_SECONDS;
  tokenCache.set(key, { token, expiresAtMs: now() + ttlSeconds * 1000 - TOKEN_EXPIRY_MARGIN_MS });
  return token;
}

export async function wecomSendText(input: {
  token: string;
  agentId: string;
  target: string;
  content: string;
  fetcher: Fetcher;
  /** Mints a fresh token after WeCom rejects the current one; the send is retried at most once. */
  refreshToken?: () => Promise<string>;
}): Promise<{ messageId: string | undefined }> {
  if (Buffer.byteLength(input.content, "utf8") > MAX_TEXT_BYTES) {
    throw new Error("WeCom text messages are limited to 2048 bytes");
  }
  const agentId = Number(input.agentId.trim());
  if (!Number.isInteger(agentId) || agentId < 0) {
    throw new Error("WeCom agent id must be numeric");
  }
  const recipient = parseTarget(input.target);
  const payload = JSON.stringify({
    ...recipient.field,
    msgtype: "text",
    agentid: agentId,
    text: { content: input.content },
  });

  let token = input.token;
  let retried = false;
  for (;;) {
    const body = await postMessage(token, payload);
    const errcode = readErrcode(body);
    if (errcode === 0) {
      const invalid = readInvalidRecipient(body);
      if (invalid) {
        throw new Error(`WeCom send failed: invalid recipient (${invalid})`);
      }
      const msgid = typeof body.msgid === "string" ? body.msgid.trim() : "";
      return { messageId: msgid || undefined };
    }
    if (TOKEN_REJECTED_ERRCODES.has(errcode) && !retried && input.refreshToken) {
      retried = true;
      token = await input.refreshToken();
      continue;
    }
    const errmsg = typeof body.errmsg === "string" ? scrub(body.errmsg, [token]) : "";
    throw new Error(`WeCom send failed (errcode ${errcode}${errmsg ? `: ${errmsg}` : ""})`);
  }

  async function postMessage(accessToken: string, requestBody: string): Promise<Record<string, unknown>> {
    const url = `${WECOM_API_BASE}/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    let response: Response;
    try {
      response = await input.fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      });
    } catch (error) {
      throw scrubbedFailure("WeCom send request failed", error, [accessToken]);
    }
    const parsed = await readWecomBody(response);
    if (!response.ok) {
      throw new Error(`WeCom send request failed (${response.status})`);
    }
    return parsed;
  }
}

function parseTarget(target: string): { field: Record<string, string> } {
  const trimmed = target.trim();
  const match = /^(user|party|tag):(.*)$/s.exec(trimmed);
  const id = (match ? match[2] : trimmed)?.trim() ?? "";
  if (!id) {
    throw new Error("WeCom target is required: user:<id>, party:<id>, tag:<id> or a bare user id");
  }
  // WeCom treats "@all" as the whole corp and "a|b|c" as a fan-out; a single send targets exactly one id.
  if (id.includes("|") || id.toLowerCase() === "@all") {
    throw new Error("WeCom target must be a single id: @all and multiple ids separated by | are not allowed");
  }
  switch (match?.[1]) {
    case "party":
      return { field: { toparty: id } };
    case "tag":
      return { field: { totag: id } };
    default:
      return { field: { touser: id } };
  }
}

function readErrcode(body: Record<string, unknown>): number {
  const value = Number(body.errcode);
  // A body without errcode (non-JSON or oversized) is not a success.
  return Number.isInteger(value) ? value : -1;
}

function readInvalidRecipient(body: Record<string, unknown>): string | undefined {
  for (const key of ["invaliduser", "invalidparty", "invalidtag"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return key;
    }
  }
  return undefined;
}

async function readWecomBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await readBoundedResponseJson(response, WECOM_RESPONSE_LIMITS);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The cause is a scrubbed copy so the credential-bearing URL can never be serialized. */
function scrubbedFailure(label: string, error: unknown, secrets: string[]): Error {
  const message = scrub(error, secrets);
  return new Error(`${label}: ${message}`, { cause: new Error(message) });
}

function scrub(error: unknown, secrets: string[]): string {
  const text = error instanceof Error ? error.message : String(error);
  const withoutParams = text.replace(/(access_token|corpsecret)=[^&\s"']*/gi, "$1=[redacted]");
  return secrets.reduce((acc, secret) => (secret ? acc.split(secret).join("[redacted]") : acc), withoutParams);
}
