import { X509Certificate, createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { BoundedResponseReadError, readBoundedResponseJson } from "./bounded-response-reader.js";
import { asRecord, asString, type JsonRecord } from "./webhook-json-helpers.js";

/**
 * Google Chat app inbound: Google-signed bearer JWT verification plus event
 * normalization for the classic Chat app event shape and the Workspace add-on
 * shape. The route owns the HTTP boundary; this module stays pure apart from
 * the default certificate fetcher, whose URLs are fixed Google constants.
 */

/**
 * `forceRefresh` asks a caching fetcher to bypass its cache once (used when a
 * token names a kid the cached set lacks, e.g. right after a key rotation).
 */
export type GoogleChatCertFetcher = (
  url: string,
  options?: { forceRefresh?: boolean },
) => Promise<{ certs: Record<string, string>; maxAgeSeconds?: number }>;

export type GoogleChatAudienceType = "project_number" | "endpoint_url";

export type GoogleChatVerificationFailureReason =
  | "missing_token"
  | "malformed"
  | "bad_alg"
  | "unknown_kid"
  | "bad_signature"
  | "bad_issuer"
  | "bad_audience"
  | "expired"
  | "bad_email";

export const GOOGLE_CHAT_ISSUER = "chat@system.gserviceaccount.com";
export const GOOGLE_CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";
export const GOOGLE_OIDC_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
export const GOOGLE_CHAT_AUDIENCE_TYPES: readonly GoogleChatAudienceType[] = ["project_number", "endpoint_url"];

const GOOGLE_OIDC_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;
/** Upper bound on exp - iat. Google-signed Chat tokens are valid for about one hour. */
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const DEFAULT_CERT_MAX_AGE_SECONDS = 60 * 60;
/** Minimum spacing between fetches of one URL when an unknown kid forces a refresh. */
const MIN_FORCED_REFRESH_INTERVAL_MS = 30_000;
const MAX_CERT_RESPONSE_BYTES = 64 * 1024;
const CERT_FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_CERT_URLS = new Set([GOOGLE_CHAT_CERTS_URL, GOOGLE_OIDC_CERTS_URL]);
const GOOGLE_CHAT_WEBHOOK_PATH = /^\/api\/v1\/integrations\/connections\/[^/]+\/google-chat\/webhook$/i;
const SPACE_NAME = /^spaces\/[^/]+$/;
const MESSAGE_NAME = /^spaces\/[^/]+\/messages\/[^/]+$/;
const IGNORED_EVENT_TYPES = new Set(["ADDED_TO_SPACE", "REMOVED_FROM_SPACE", "CARD_CLICKED"]);

export function isGoogleChatWebhookPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return GOOGLE_CHAT_WEBHOOK_PATH.test(pathname);
}

export function isGoogleChatAudienceType(value: unknown): value is GoogleChatAudienceType {
  return value === "project_number" || value === "endpoint_url";
}

type VerificationResult = { ok: true } | { ok: false; reason: GoogleChatVerificationFailureReason };

type DecodedJwt = {
  header: JsonRecord;
  claims: JsonRecord;
  signingInput: string;
  signature: Buffer;
};

export async function verifyGoogleChatBearer(input: {
  authorizationHeader: string | undefined;
  audienceType: GoogleChatAudienceType;
  audience: string;
  fetchCerts: GoogleChatCertFetcher;
  now?: () => number;
}): Promise<VerificationResult> {
  const token = readBearerToken(input.authorizationHeader);
  if (!token) {
    return { ok: false, reason: "missing_token" };
  }
  const decoded = decodeJwt(token);
  if (!decoded) {
    return { ok: false, reason: "malformed" };
  }
  if (decoded.header.alg !== "RS256") {
    return { ok: false, reason: "bad_alg" };
  }
  const kid = asString(decoded.header.kid);
  const certsUrl = input.audienceType === "project_number" ? GOOGLE_CHAT_CERTS_URL : GOOGLE_OIDC_CERTS_URL;
  if (!kid) {
    return { ok: false, reason: "unknown_kid" };
  }
  let pem = pickCert((await input.fetchCerts(certsUrl)).certs, kid);
  if (!pem) {
    // One bounded refetch that bypasses the cache: Google may have rotated keys since the cached set.
    pem = pickCert((await input.fetchCerts(certsUrl, { forceRefresh: true })).certs, kid);
  }
  if (!pem) {
    return { ok: false, reason: "unknown_kid" };
  }
  if (!verifyRs256(decoded, pem)) {
    return { ok: false, reason: "bad_signature" };
  }
  return checkClaims(decoded.claims, input.audienceType, input.audience, (input.now ?? Date.now)());
}

function pickCert(certs: Record<string, string>, kid: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(certs, kid) ? certs[kid] : undefined;
}

function checkClaims(
  claims: JsonRecord,
  audienceType: GoogleChatAudienceType,
  audience: string,
  nowMs: number,
): VerificationResult {
  const issuerOk =
    audienceType === "project_number" ? claims.iss === GOOGLE_CHAT_ISSUER : GOOGLE_OIDC_ISSUERS.has(String(claims.iss));
  if (!issuerOk) {
    return { ok: false, reason: "bad_issuer" };
  }
  if (typeof claims.aud !== "string" || claims.aud !== audience) {
    return { ok: false, reason: "bad_audience" };
  }
  const exp = claims.exp;
  const iat = claims.iat;
  if (typeof exp !== "number" || typeof iat !== "number" || !Number.isFinite(exp) || !Number.isFinite(iat)) {
    return { ok: false, reason: "malformed" };
  }
  const nbf = claims.nbf;
  if (nbf !== undefined && (typeof nbf !== "number" || !Number.isFinite(nbf))) {
    return { ok: false, reason: "malformed" };
  }
  // Google Chat tokens live about an hour; an inverted or overlong window is not a Google-issued token.
  if (exp <= iat || exp - iat > MAX_TOKEN_LIFETIME_SECONDS) {
    return { ok: false, reason: "malformed" };
  }
  const nowSeconds = nowMs / 1000;
  // Outside the validity window either way (expired, issued in the future, or not yet valid).
  if (
    nowSeconds > exp + CLOCK_SKEW_SECONDS ||
    iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    (typeof nbf === "number" && nbf > nowSeconds + CLOCK_SKEW_SECONDS)
  ) {
    return { ok: false, reason: "expired" };
  }
  if (audienceType === "endpoint_url" && (claims.email !== GOOGLE_CHAT_ISSUER || claims.email_verified !== true)) {
    return { ok: false, reason: "bad_email" };
  }
  return { ok: true };
}

function readBearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header?.trim() ?? "");
  return match?.[1];
}

function decodeJwt(token: string): DecodedJwt | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = parseJsonSegment(encodedHeader);
  const claims = parseJsonSegment(encodedClaims);
  if (!header || !claims || !/^[A-Za-z0-9_-]*$/.test(encodedSignature)) {
    return undefined;
  }
  return {
    header,
    claims,
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature: Buffer.from(encodedSignature, "base64url"),
  };
}

function parseJsonSegment(segment: string): JsonRecord | undefined {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonRecord) : undefined;
  } catch {
    return undefined;
  }
}

function verifyRs256(decoded: DecodedJwt, pem: string): boolean {
  if (decoded.signature.length === 0) {
    return false;
  }
  try {
    return createVerify("RSA-SHA256").update(decoded.signingInput).verify(toPublicKey(pem), decoded.signature);
  } catch {
    return false;
  }
}

function toPublicKey(pem: string): KeyObject {
  // Google publishes X.509 certificates; a raw SPKI public key PEM is accepted as well.
  return pem.includes("BEGIN CERTIFICATE") ? new X509Certificate(pem).publicKey : createPublicKey(pem);
}

/**
 * Per-URL certificate cache honoring the upstream max-age (default 1 h).
 * Create one per gateway route registration so cache state never leaks across
 * gateway instances or tests. Failures are not cached.
 */
export function createCachedGoogleChatCertFetcher(
  upstream: GoogleChatCertFetcher,
  now: () => number = Date.now,
): GoogleChatCertFetcher {
  const cache = new Map<
    string,
    { fetchedAt: number; expiresAt: number; value: Awaited<ReturnType<GoogleChatCertFetcher>> }
  >();
  return async (url, options) => {
    const cached = cache.get(url);
    // A forced refresh is honored at most once per MIN_FORCED_REFRESH_INTERVAL_MS per URL, so a
    // stream of tokens with made-up kids cannot turn into a stream of upstream fetches.
    const forced =
      options?.forceRefresh === true && (!cached || now() - cached.fetchedAt >= MIN_FORCED_REFRESH_INTERVAL_MS);
    if (cached && cached.expiresAt > now() && !forced) {
      return cached.value;
    }
    const value = await upstream(url);
    const maxAgeSeconds = value.maxAgeSeconds ?? DEFAULT_CERT_MAX_AGE_SECONDS;
    const fetchedAt = now();
    cache.set(url, { fetchedAt, expiresAt: fetchedAt + maxAgeSeconds * 1000, value });
    return value;
  };
}

export function parseCacheControlMaxAge(header: string | null | undefined): number | undefined {
  const match = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(header ?? "");
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Default fetcher: only the two fixed Google certificate URLs, never a config-derived URL. */
export const fetchGoogleChatCertsFromGoogle: GoogleChatCertFetcher = async (url) => {
  if (!ALLOWED_CERT_URLS.has(url)) {
    throw new Error("Refusing to fetch Google certificates from an unexpected URL.");
  }
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Google certificate fetch failed (${response.status}).`);
  }
  let body: unknown;
  try {
    body = await readBoundedResponseJson(response, {
      maxBytes: MAX_CERT_RESPONSE_BYTES,
      timeoutMs: CERT_FETCH_TIMEOUT_MS,
      label: "Google certificate",
    });
  } catch (error) {
    if (error instanceof BoundedResponseReadError && error.code === "body_limit") {
      throw new Error("Google certificate response is too large.", { cause: error });
    }
    throw error;
  }
  const parsed = asRecord(body);
  const certs: Record<string, string> = {};
  for (const [kid, pem] of Object.entries(parsed)) {
    if (typeof pem === "string" && pem.includes("-----BEGIN")) {
      certs[kid] = pem;
    }
  }
  return { certs, maxAgeSeconds: parseCacheControlMaxAge(response.headers.get("cache-control")) };
};

export type GoogleChatEventNormalization =
  | {
      kind: "message";
      eventId: string;
      space: string;
      threadName?: string;
      actorId: string;
      displayName?: string;
      content: string;
      metadata: Record<string, unknown>;
    }
  | { kind: "ignore"; eventType?: string; reason: string };

export function normalizeGoogleChatEvent(input: {
  connectionId: string;
  payload: unknown;
}): GoogleChatEventNormalization {
  const payload = asRecord(input.payload);
  const addOn = asRecord(payload.chat);
  const isAddOn = Object.keys(addOn).length > 0;
  const messagePayload = asRecord(addOn.messagePayload);
  const eventType = isAddOn
    ? Object.keys(messagePayload).length > 0
      ? "MESSAGE"
      : (Object.keys(addOn).find((key) => key.endsWith("Payload")) ?? "UNKNOWN")
    : asString(payload.type);
  if (!eventType) {
    return { kind: "ignore", reason: "missing_event_type" };
  }
  if (IGNORED_EVENT_TYPES.has(eventType)) {
    return { kind: "ignore", eventType, reason: "non_message_event" };
  }
  if (eventType !== "MESSAGE") {
    return { kind: "ignore", eventType, reason: "unsupported_event" };
  }

  const message = asRecord(isAddOn ? messagePayload.message : payload.message);
  const spaceRecord = asRecord(isAddOn ? messagePayload.space : payload.space);
  const sender = asRecord(
    Object.keys(asRecord(message.sender)).length > 0 ? message.sender : isAddOn ? addOn.user : payload.user,
  );
  if (asString(sender.type) === "BOT") {
    return { kind: "ignore", eventType, reason: "bot_sender" };
  }
  const eventId = asString(message.name);
  const space = asString(asRecord(message.space).name) ?? asString(spaceRecord.name);
  const actorId = asString(sender.name);
  if (!eventId || !MESSAGE_NAME.test(eventId) || !space || !SPACE_NAME.test(space)) {
    return { kind: "ignore", eventType, reason: "missing_message_identity" };
  }
  if (!actorId) {
    return { kind: "ignore", eventType, reason: "missing_sender" };
  }
  // argumentText strips the @mention of the app; fall back to the full text in DMs.
  const content = asString(message.argumentText) ?? asString(message.text);
  if (!content) {
    return { kind: "ignore", eventType, reason: "empty_content" };
  }
  const metadata: Record<string, unknown> = {
    eventShape: isAddOn ? "workspace_add_on" : "chat_app",
  };
  const email = asString(sender.email);
  if (email) metadata.email = email;
  const spaceType = asString(spaceRecord.type) ?? asString(spaceRecord.spaceType);
  if (spaceType) metadata.spaceType = spaceType;
  const eventTime = asString(isAddOn ? addOn.eventTime : payload.eventTime);
  if (eventTime) metadata.eventTime = eventTime;
  return {
    kind: "message",
    eventId,
    space,
    threadName: asString(asRecord(message.thread).name),
    actorId,
    displayName: asString(sender.displayName),
    content,
    metadata,
  };
}
