import { createHash, createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readBoundedResponseJson, type FetchBodyReadLimits } from "../sandbox/network-guard.js";

/**
 * Google Chat app (service-account) client: mints chat.bot access tokens with
 * a signed JWT-bearer grant and sends/deletes app messages through the Chat
 * API. Network access is injected so the executor keeps every call behind its
 * allowlisted fetch; nothing here ever puts key material into an error.
 */

export const GOOGLE_CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CHAT_API_BASE = "https://chat.googleapis.com/v1";
export const GOOGLE_CHAT_SPACE_NAME_PATTERN = /^spaces\/[^/]+$/;
export const GOOGLE_CHAT_THREAD_NAME_PATTERN = /^spaces\/[^/]+\/threads\/[^/]+$/;
export const GOOGLE_CHAT_MESSAGE_NAME_PATTERN = /^spaces\/[^/]+\/messages\/[^/]+$/;

const MALFORMED_KEY_MESSAGE = "Google Chat service-account key is malformed";
const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_SECONDS = 60;
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Token and Chat message responses are small JSON documents; larger bodies fail closed. */
const GOOGLE_RESPONSE_READ_LIMITS: FetchBodyReadLimits = { maxBytes: 64 * 1024, timeoutMs: 15_000 };

export type GoogleChatTokenFetcher = (url: string, init: RequestInit) => Promise<Response>;

type ServiceAccountKey = {
  clientEmail: string;
  privateKey: KeyObject;
  privateKeyId?: string;
  tokenUri: string;
  cacheKey: string;
};

const tokenCache = new Map<string, { accessToken: string; expiresAtMs: number }>();

/** Test seam: the token cache is process-wide, so tests reset it between cases. */
export function resetGoogleChatAccessTokenCache(): void {
  tokenCache.clear();
}

export async function getGoogleChatAccessToken(
  keyJson: string,
  fetcher: GoogleChatTokenFetcher,
  now: () => number = Date.now,
): Promise<string> {
  const key = parseServiceAccountKey(keyJson);
  const cached = tokenCache.get(key.cacheKey);
  if (cached && cached.expiresAtMs > now()) {
    return cached.accessToken;
  }
  const issuedAt = Math.floor(now() / 1000);
  const assertion = signAssertion(key, issuedAt);
  const response = await fetcher(key.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
  });
  if (!response.ok) {
    await discardBody(response);
    throw new Error(`Google Chat service-account token request failed (${response.status})`);
  }
  const body = await readJsonRecord(response);
  const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
  const expiresIn =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : TOKEN_LIFETIME_SECONDS;
  if (!accessToken) {
    throw new Error("Google Chat service-account token response is invalid");
  }
  tokenCache.set(key.cacheKey, {
    accessToken,
    expiresAtMs: now() + Math.max(0, expiresIn - TOKEN_REFRESH_MARGIN_SECONDS) * 1000,
  });
  return accessToken;
}

export type GoogleChatApiFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function sendGoogleChatAppMessage(input: {
  keyJson: string;
  space: string;
  body: Record<string, unknown>;
  threadName?: string;
  tokenFetch: GoogleChatTokenFetcher;
  apiFetch: GoogleChatApiFetch;
}): Promise<string> {
  if (!GOOGLE_CHAT_SPACE_NAME_PATTERN.test(input.space)) {
    throw new Error("Google Chat app sends require a space target (spaces/{space})");
  }
  if (input.threadName !== undefined && !GOOGLE_CHAT_THREAD_NAME_PATTERN.test(input.threadName)) {
    throw new Error("Google Chat thread must be a thread resource name (spaces/{space}/threads/{thread})");
  }
  const accessToken = await getGoogleChatAccessToken(input.keyJson, input.tokenFetch);
  const url = new URL(`${GOOGLE_CHAT_API_BASE}/${input.space}/messages`);
  if (input.threadName) {
    url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  }
  const response = await input.apiFetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(input.threadName ? { ...input.body, thread: { name: input.threadName } } : input.body),
  });
  if (!response.ok) {
    await discardBody(response);
    throw new Error(`google-chat.send failed (${response.status})`);
  }
  const name = (await readJsonRecord(response)).name;
  if (typeof name !== "string" || !GOOGLE_CHAT_MESSAGE_NAME_PATTERN.test(name)) {
    throw new Error("google-chat.send returned no message name");
  }
  return name;
}

export async function deleteGoogleChatAppMessage(input: {
  keyJson: string;
  messageName: string;
  tokenFetch: GoogleChatTokenFetcher;
  apiFetch: GoogleChatApiFetch;
}): Promise<string> {
  assertGoogleChatMessageName(input.messageName);
  const accessToken = await getGoogleChatAccessToken(input.keyJson, input.tokenFetch);
  const response = await input.apiFetch(`${GOOGLE_CHAT_API_BASE}/${input.messageName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await discardBody(response);
  if (!response.ok) {
    throw new Error(`google-chat.unsend failed (${response.status})`);
  }
  return input.messageName;
}

/** Reads a message's thread so a reply to a message name lands in that thread. */
export async function readGoogleChatMessageThread(input: {
  keyJson: string;
  messageName: string;
  tokenFetch: GoogleChatTokenFetcher;
  apiFetch: GoogleChatApiFetch;
}): Promise<string> {
  assertGoogleChatMessageName(input.messageName);
  const accessToken = await getGoogleChatAccessToken(input.keyJson, input.tokenFetch);
  const response = await input.apiFetch(`${GOOGLE_CHAT_API_BASE}/${input.messageName}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await discardBody(response);
    throw new Error(`google-chat.send could not read the reply message thread (${response.status})`);
  }
  const thread = (await readJsonRecord(response)).thread;
  const name = thread && typeof thread === "object" ? (thread as Record<string, unknown>).name : undefined;
  if (typeof name !== "string" || !GOOGLE_CHAT_THREAD_NAME_PATTERN.test(name)) {
    throw new Error("google-chat.send could not resolve the reply message thread");
  }
  return name;
}

export function assertGoogleChatMessageName(messageName: string): void {
  if (!GOOGLE_CHAT_MESSAGE_NAME_PATTERN.test(messageName)) {
    throw new Error("Google Chat messageId must be a message resource name (spaces/{space}/messages/{message})");
  }
}

function parseServiceAccountKey(keyJson: string): ServiceAccountKey {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(keyJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(MALFORMED_KEY_MESSAGE);
    }
    parsed = value as Record<string, unknown>;
  } catch {
    throw new Error(MALFORMED_KEY_MESSAGE);
  }
  const clientEmail = readString(parsed.client_email);
  const privateKeyPem = readString(parsed.private_key);
  const privateKeyId = readString(parsed.private_key_id);
  const tokenUri = readString(parsed.token_uri) ?? GOOGLE_OAUTH_TOKEN_URL;
  if (!clientEmail || !privateKeyPem || !tokenUri.startsWith("https://")) {
    throw new Error(MALFORMED_KEY_MESSAGE);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    // Node's decoder errors never echo the PEM, but keep the message fixed anyway.
    throw new Error(MALFORMED_KEY_MESSAGE);
  }
  const keyIdentity = privateKeyId ?? createHash("sha256").update(privateKeyPem).digest("hex");
  return {
    clientEmail,
    privateKey,
    privateKeyId,
    tokenUri,
    cacheKey: createHash("sha256").update(`${clientEmail}\n${keyIdentity}`).digest("hex"),
  };
}

function signAssertion(key: ServiceAccountKey, issuedAt: number): string {
  const header = { alg: "RS256", typ: "JWT", ...(key.privateKeyId ? { kid: key.privateKeyId } : {}) };
  const claims = {
    iss: key.clientEmail,
    scope: GOOGLE_CHAT_BOT_SCOPE,
    aud: key.tokenUri,
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  try {
    const signature = createSign("RSA-SHA256").update(signingInput).sign(key.privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  } catch {
    throw new Error(MALFORMED_KEY_MESSAGE);
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Bounded JSON read: size and timeout limits throw; an empty or unparseable body reads as {}. */
async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await readBoundedResponseJson(response, GOOGLE_RESPONSE_READ_LIMITS);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {};
    }
    throw error;
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Releases a body we do not need without buffering it. */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
