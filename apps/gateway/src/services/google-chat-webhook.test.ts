import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CHAT_CERTS_URL,
  GOOGLE_CHAT_ISSUER,
  GOOGLE_OIDC_CERTS_URL,
  createCachedGoogleChatCertFetcher,
  isGoogleChatWebhookPath,
  normalizeGoogleChatEvent,
  parseCacheControlMaxAge,
  verifyGoogleChatBearer,
  type GoogleChatCertFetcher,
} from "./google-chat-webhook.js";

// The verifier hands each cert map value to crypto. Google serves X.509 certificate PEMs, but
// crypto.createVerify also accepts a raw SPKI public key PEM, so these tests keep the generated
// public key PEM in the map instead of minting a self-signed certificate.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const KID = "test-kid-1";
const NOW_MS = Date.UTC(2026, 9, 16, 12, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const PROJECT_NUMBER = "123456789012";
const ENDPOINT_URL = "https://gateway.example.test/api/v1/integrations/connections/c/google-chat/webhook";

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signToken(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" },
): string {
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

function projectClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: GOOGLE_CHAT_ISSUER,
    aud: PROJECT_NUMBER,
    iat: NOW_S - 30,
    exp: NOW_S + 3600,
    ...overrides,
  };
}

function endpointClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: ENDPOINT_URL,
    email: GOOGLE_CHAT_ISSUER,
    email_verified: true,
    iat: NOW_S - 30,
    exp: NOW_S + 3600,
    ...overrides,
  };
}

function certFetcher(): GoogleChatCertFetcher & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ certs: { [KID]: PUBLIC_PEM } })) as never;
}

async function verify(
  authorizationHeader: string | undefined,
  options: {
    audienceType?: "project_number" | "endpoint_url";
    audience?: string;
    fetchCerts?: GoogleChatCertFetcher;
  } = {},
) {
  return verifyGoogleChatBearer({
    authorizationHeader,
    audienceType: options.audienceType ?? "project_number",
    audience: options.audience ?? PROJECT_NUMBER,
    fetchCerts: options.fetchCerts ?? certFetcher(),
    now: () => NOW_MS,
  });
}

describe("verifyGoogleChatBearer", () => {
  it("accepts a valid project-number token signed by the chat service account certs", async () => {
    const fetchCerts = certFetcher();
    await expect(verify(`Bearer ${signToken(projectClaims())}`, { fetchCerts })).resolves.toEqual({ ok: true });
    expect(fetchCerts).toHaveBeenCalledWith(GOOGLE_CHAT_CERTS_URL);
  });

  it("accepts a valid endpoint-url token with the chat service account email", async () => {
    const fetchCerts = certFetcher();
    await expect(
      verify(`Bearer ${signToken(endpointClaims())}`, {
        audienceType: "endpoint_url",
        audience: ENDPOINT_URL,
        fetchCerts,
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchCerts).toHaveBeenCalledWith(GOOGLE_OIDC_CERTS_URL);
  });

  it("accepts the bare accounts.google.com issuer in endpoint-url mode", async () => {
    await expect(
      verify(`Bearer ${signToken(endpointClaims({ iss: "accounts.google.com" }))}`, {
        audienceType: "endpoint_url",
        audience: ENDPOINT_URL,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects a wrong audience", async () => {
    await expect(verify(`Bearer ${signToken(projectClaims({ aud: "999" }))}`)).resolves.toEqual({
      ok: false,
      reason: "bad_audience",
    });
  });

  it("rejects a wrong issuer", async () => {
    await expect(verify(`Bearer ${signToken(projectClaims({ iss: "https://accounts.google.com" }))}`)).resolves.toEqual(
      { ok: false, reason: "bad_issuer" },
    );
  });

  it("rejects an expired token beyond the 60 second skew", async () => {
    await expect(verify(`Bearer ${signToken(projectClaims({ iat: NOW_S - 7200, exp: NOW_S - 61 }))}`)).resolves.toEqual(
      { ok: false, reason: "expired" },
    );
    await expect(verify(`Bearer ${signToken(projectClaims({ iat: NOW_S - 7200, exp: NOW_S - 30 }))}`)).resolves.toEqual(
      { ok: true },
    );
  });

  it("rejects a token issued in the future beyond the skew", async () => {
    await expect(verify(`Bearer ${signToken(projectClaims({ iat: NOW_S + 600 }))}`)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects an unknown kid", async () => {
    await expect(
      verify(`Bearer ${signToken(projectClaims(), { alg: "RS256", kid: "rotated-away", typ: "JWT" })}`),
    ).resolves.toEqual({ ok: false, reason: "unknown_kid" });
  });

  it("rejects alg none with an empty signature", async () => {
    const unsigned = `${base64Url(JSON.stringify({ alg: "none", kid: KID }))}.${base64Url(JSON.stringify(projectClaims()))}.`;
    await expect(verify(`Bearer ${unsigned}`)).resolves.toEqual({ ok: false, reason: "bad_alg" });
  });

  it("rejects HS256 even with a kid that exists", async () => {
    const forged = signToken(projectClaims(), { alg: "HS256", kid: KID, typ: "JWT" });
    await expect(verify(`Bearer ${forged}`)).resolves.toEqual({ ok: false, reason: "bad_alg" });
  });

  it("rejects a tampered payload", async () => {
    const [header, , signature] = signToken(projectClaims()).split(".");
    const tamperedPayload = base64Url(JSON.stringify(projectClaims({ aud: PROJECT_NUMBER, sub: "attacker" })));
    await expect(verify(`Bearer ${header}.${tamperedPayload}.${signature}`)).resolves.toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects endpoint-url tokens with the wrong or unverified email", async () => {
    await expect(
      verify(`Bearer ${signToken(endpointClaims({ email: "someone@example.com" }))}`, {
        audienceType: "endpoint_url",
        audience: ENDPOINT_URL,
      }),
    ).resolves.toEqual({ ok: false, reason: "bad_email" });
    await expect(
      verify(`Bearer ${signToken(endpointClaims({ email_verified: false }))}`, {
        audienceType: "endpoint_url",
        audience: ENDPOINT_URL,
      }),
    ).resolves.toEqual({ ok: false, reason: "bad_email" });
  });

  it("rejects a missing header or a non-bearer header", async () => {
    await expect(verify(undefined)).resolves.toEqual({ ok: false, reason: "missing_token" });
    await expect(verify("Basic abc")).resolves.toEqual({ ok: false, reason: "missing_token" });
    await expect(verify("Bearer ")).resolves.toEqual({ ok: false, reason: "missing_token" });
  });

  it("rejects malformed tokens", async () => {
    await expect(verify("Bearer not-a-jwt")).resolves.toEqual({ ok: false, reason: "malformed" });
    await expect(verify("Bearer a.b.c")).resolves.toEqual({ ok: false, reason: "malformed" });
  });
});

describe("unknown kid certificate refresh", () => {
  const ROTATED_KID = "rotated-in";

  it("refetches once, bypassing the cache, when a token names a kid the cached set lacks", async () => {
    let nowMs = NOW_MS;
    const upstream = vi
      .fn<GoogleChatCertFetcher>()
      .mockResolvedValueOnce({ certs: { [KID]: PUBLIC_PEM }, maxAgeSeconds: 3600 })
      .mockResolvedValue({ certs: { [KID]: PUBLIC_PEM, [ROTATED_KID]: PUBLIC_PEM }, maxAgeSeconds: 3600 });
    const fetchCerts = createCachedGoogleChatCertFetcher(upstream, () => nowMs);
    const verifyAt = (token: string) =>
      verifyGoogleChatBearer({
        authorizationHeader: `Bearer ${token}`,
        audienceType: "project_number",
        audience: PROJECT_NUMBER,
        fetchCerts,
        now: () => nowMs,
      });

    await expect(verifyAt(signToken(projectClaims()))).resolves.toEqual({ ok: true });
    expect(upstream).toHaveBeenCalledTimes(1);

    nowMs += 120_000;
    const rotated = signToken(projectClaims({ iat: nowMs / 1000 - 10 }), { alg: "RS256", kid: ROTATED_KID });
    await expect(verifyAt(rotated)).resolves.toEqual({ ok: true });
    expect(upstream).toHaveBeenCalledTimes(2);
    // The refreshed set is cached: the rotated kid now verifies without another fetch.
    await expect(verifyAt(rotated)).resolves.toEqual({ ok: true });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("bounds forced refreshes so a stream of unknown kids cannot hammer Google", async () => {
    let nowMs = NOW_MS;
    const upstream = vi.fn<GoogleChatCertFetcher>(async () => ({ certs: { [KID]: PUBLIC_PEM } }));
    const fetchCerts = createCachedGoogleChatCertFetcher(upstream, () => nowMs);
    const verifyKid = (kid: string) =>
      verifyGoogleChatBearer({
        authorizationHeader: `Bearer ${signToken(projectClaims({ iat: nowMs / 1000 - 10 }), { alg: "RS256", kid })}`,
        audienceType: "project_number",
        audience: PROJECT_NUMBER,
        fetchCerts,
        now: () => nowMs,
      });

    // First fetch populates the cache; the unknown kid gets no forced refresh inside the minimum interval.
    await expect(verifyKid("unknown-1")).resolves.toEqual({ ok: false, reason: "unknown_kid" });
    expect(upstream).toHaveBeenCalledTimes(1);
    nowMs += 31_000;
    await expect(verifyKid("unknown-2")).resolves.toEqual({ ok: false, reason: "unknown_kid" });
    expect(upstream).toHaveBeenCalledTimes(2);
    await expect(verifyKid("unknown-3")).resolves.toEqual({ ok: false, reason: "unknown_kid" });
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

describe("createCachedGoogleChatCertFetcher", () => {
  it("caches certs per URL for maxAge and refetches after expiry", async () => {
    let nowMs = NOW_MS;
    const upstream = vi.fn(async (url: string) => ({ certs: { [url]: PUBLIC_PEM }, maxAgeSeconds: 120 }));
    const cached = createCachedGoogleChatCertFetcher(upstream, () => nowMs);

    await cached(GOOGLE_CHAT_CERTS_URL);
    await cached(GOOGLE_CHAT_CERTS_URL);
    await cached(GOOGLE_OIDC_CERTS_URL);
    expect(upstream).toHaveBeenCalledTimes(2);

    nowMs += 121_000;
    await cached(GOOGLE_CHAT_CERTS_URL);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("defaults to a one hour cache when no max-age is given and does not cache failures", async () => {
    let nowMs = NOW_MS;
    const upstream = vi
      .fn<GoogleChatCertFetcher>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ certs: { [KID]: PUBLIC_PEM } });
    const cached = createCachedGoogleChatCertFetcher(upstream, () => nowMs);

    await expect(cached(GOOGLE_CHAT_CERTS_URL)).rejects.toThrow("network down");
    await cached(GOOGLE_CHAT_CERTS_URL);
    nowMs += 59 * 60_000;
    await cached(GOOGLE_CHAT_CERTS_URL);
    expect(upstream).toHaveBeenCalledTimes(2);
    nowMs += 2 * 60_000;
    await cached(GOOGLE_CHAT_CERTS_URL);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("parses Cache-Control max-age", () => {
    expect(parseCacheControlMaxAge("public, max-age=19523, must-revalidate, no-transform")).toBe(19523);
    expect(parseCacheControlMaxAge("no-store")).toBeUndefined();
    expect(parseCacheControlMaxAge(null)).toBeUndefined();
  });
});

describe("normalizeGoogleChatEvent", () => {
  const connectionId = "11111111-1111-1111-1111-111111111111";

  it("normalizes a classic MESSAGE event and prefers argumentText over text", () => {
    const normalized = normalizeGoogleChatEvent({
      connectionId,
      payload: {
        type: "MESSAGE",
        eventTime: "2026-10-16T12:00:00.000Z",
        space: { name: "spaces/S", type: "ROOM" },
        user: { name: "users/123", displayName: "Ada", email: "ada@example.com", type: "HUMAN" },
        message: {
          name: "spaces/S/messages/M",
          text: "@GoatCitadel  deploy status?",
          argumentText: "  deploy status?",
          thread: { name: "spaces/S/threads/T" },
          sender: { name: "users/123", displayName: "Ada", email: "ada@example.com", type: "HUMAN" },
        },
      },
    });
    expect(normalized).toEqual({
      kind: "message",
      eventId: "spaces/S/messages/M",
      space: "spaces/S",
      threadName: "spaces/S/threads/T",
      actorId: "users/123",
      displayName: "Ada",
      content: "deploy status?",
      metadata: expect.objectContaining({ email: "ada@example.com" }),
    });
  });

  it("falls back to text when argumentText is blank", () => {
    const normalized = normalizeGoogleChatEvent({
      connectionId,
      payload: {
        type: "MESSAGE",
        space: { name: "spaces/DM", type: "DM" },
        message: {
          name: "spaces/DM/messages/1",
          text: "hello there",
          argumentText: "   ",
          sender: { name: "users/9", type: "HUMAN" },
        },
      },
    });
    expect(normalized).toMatchObject({ kind: "message", content: "hello there", space: "spaces/DM" });
  });

  it("normalizes the Workspace add-on event shape", () => {
    const normalized = normalizeGoogleChatEvent({
      connectionId,
      payload: {
        commonEventObject: { hostApp: "CHAT" },
        chat: {
          user: { name: "users/456", displayName: "Grace", email: "grace@example.com", type: "HUMAN" },
          eventTime: "2026-10-16T12:00:00.000Z",
          messagePayload: {
            space: { name: "spaces/AAA", type: "SPACE" },
            message: {
              name: "spaces/AAA/messages/BBB",
              text: "status",
              thread: { name: "spaces/AAA/threads/CCC" },
              sender: { name: "users/456", displayName: "Grace", email: "grace@example.com", type: "HUMAN" },
            },
          },
        },
      },
    });
    expect(normalized).toMatchObject({
      kind: "message",
      eventId: "spaces/AAA/messages/BBB",
      space: "spaces/AAA",
      threadName: "spaces/AAA/threads/CCC",
      actorId: "users/456",
      displayName: "Grace",
      content: "status",
      metadata: expect.objectContaining({ email: "grace@example.com" }),
    });
  });

  it("ignores messages sent by a bot (self-echo)", () => {
    expect(
      normalizeGoogleChatEvent({
        connectionId,
        payload: {
          type: "MESSAGE",
          space: { name: "spaces/S" },
          message: { name: "spaces/S/messages/M", text: "echo", sender: { name: "users/app", type: "BOT" } },
        },
      }),
    ).toMatchObject({ kind: "ignore", reason: "bot_sender" });
  });

  it("ignores lifecycle and card events", () => {
    for (const type of ["ADDED_TO_SPACE", "REMOVED_FROM_SPACE", "CARD_CLICKED"]) {
      expect(normalizeGoogleChatEvent({ connectionId, payload: { type, space: { name: "spaces/S" } } })).toMatchObject({
        kind: "ignore",
        eventType: type,
      });
    }
  });

  it("ignores payloads without a message resource name or text", () => {
    expect(normalizeGoogleChatEvent({ connectionId, payload: "nope" })).toMatchObject({ kind: "ignore" });
    expect(
      normalizeGoogleChatEvent({
        connectionId,
        payload: { type: "MESSAGE", message: { text: "hi", sender: { name: "users/1" } } },
      }),
    ).toMatchObject({ kind: "ignore" });
    expect(
      normalizeGoogleChatEvent({
        connectionId,
        payload: {
          type: "MESSAGE",
          space: { name: "spaces/S" },
          message: { name: "spaces/S/messages/M", sender: { name: "users/1" } },
        },
      }),
    ).toMatchObject({ kind: "ignore" });
  });
});

describe("isGoogleChatWebhookPath", () => {
  it("matches only the connection-scoped Google Chat webhook path", () => {
    expect(isGoogleChatWebhookPath("/api/v1/integrations/connections/abc/google-chat/webhook")).toBe(true);
    expect(isGoogleChatWebhookPath("/api/v1/integrations/connections/abc/google-chat/webhook?x=1")).toBe(true);
    expect(isGoogleChatWebhookPath("/api/v1/integrations/connections/abc/google-chat/other")).toBe(false);
  });
});
