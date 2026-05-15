import { describe, expect, it } from "vitest";
import {
  buildCompanionSigningPayload,
  decodeBase64Url,
  isCompanionSessionCurrentlyActive,
  isCompanionSessionOperatorActive,
  isCompanionSessionRefreshable,
  isRecord,
  mapCompanionSessionRow,
  normalizeCompanionAuditEvent,
  normalizeCompanionNonce,
  normalizeCompanionRequestPath,
  normalizeCompanionSignature,
  toCompanionSessionAdminRecord,
  toCompanionSessionInfoResponse,
  type CompanionSessionRecord,
} from "./companion-auth-helpers.js";

describe("companion auth helpers", () => {
  it("maps database rows with safe defaults and response projections", () => {
    const session = mapCompanionSessionRow({
      session_id: "session-1",
      grant_id: "grant-1",
      access_token_hash: "access-hash",
      refresh_token_hash: "refresh-hash",
      signing_public_key_pem: "pem",
      metadata_json: '{"scope":"mobile"}',
      device_label: "Pixel",
      device_type: "phone",
      platform: "android",
      last_seen_at: "2026-05-14T00:00:00.000Z",
      revoked_at: "2026-05-15T00:00:00.000Z",
      grant_expires_at: "2026-05-16T00:00:00.000Z",
      grant_revoked_at: "2026-05-17T00:00:00.000Z",
    });

    expect(session).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        grantId: "grant-1",
        metadata: { scope: "mobile" },
        deviceLabel: "Pixel",
        deviceType: "phone",
        platform: "android",
        signatureAlgorithm: "ed25519",
      }),
    );
    expect(toCompanionSessionInfoResponse(session)).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        grantId: "grant-1",
        actorId: "companion:session-1",
        deviceLabel: "Pixel",
        deviceType: "unknown",
        metadata: { scope: "mobile" },
      }),
    );
    expect(toCompanionSessionAdminRecord(session)).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        revokedAt: "2026-05-15T00:00:00.000Z",
        grantExpiresAt: "2026-05-16T00:00:00.000Z",
        grantRevokedAt: "2026-05-17T00:00:00.000Z",
      }),
    );

    expect(mapCompanionSessionRow({ metadata_json: "not json", signature_algorithm: "other" })).toEqual(
      expect.objectContaining({
        sessionId: "",
        metadata: {},
        deviceLabel: "New device",
        deviceType: "unknown",
        platform: undefined,
        lastSeenAt: undefined,
        signatureAlgorithm: "ed25519",
      }),
    );
  });

  it("evaluates active, refreshable, and operator-active session windows", () => {
    const active = session({
      accessTokenExpiresAt: "2026-05-14T12:10:00.000Z",
      refreshTokenExpiresAt: "2026-05-14T13:00:00.000Z",
      grantExpiresAt: "2026-05-14T14:00:00.000Z",
    });
    const now = "2026-05-14T12:00:00.000Z";

    expect(isCompanionSessionCurrentlyActive(active, now)).toBe(true);
    expect(isCompanionSessionRefreshable(active, now)).toBe(true);
    expect(isCompanionSessionOperatorActive(active, now)).toBe(true);

    expect(isCompanionSessionCurrentlyActive(session({ revokedAt: "2026-05-14T11:00:00.000Z" }), now)).toBe(false);
    expect(isCompanionSessionCurrentlyActive(session({ grantRevokedAt: "2026-05-14T11:00:00.000Z" }), now)).toBe(false);
    expect(isCompanionSessionCurrentlyActive(session({ accessTokenExpiresAt: "not a date" }), now)).toBe(false);
    expect(isCompanionSessionCurrentlyActive(session({ accessTokenExpiresAt: now }), now)).toBe(false);
    expect(isCompanionSessionCurrentlyActive(session({ grantExpiresAt: now }), now)).toBe(false);
    expect(isCompanionSessionCurrentlyActive(session({ grantExpiresAt: "not a date" }), now)).toBe(true);

    expect(isCompanionSessionRefreshable(session({ refreshTokenExpiresAt: "not a date" }), now)).toBe(false);
    expect(isCompanionSessionRefreshable(session({ refreshTokenExpiresAt: now }), now)).toBe(false);
    expect(isCompanionSessionRefreshable(session({ grantExpiresAt: now }), now)).toBe(false);
    expect(isCompanionSessionOperatorActive(session({ refreshTokenExpiresAt: "not a date" }), now)).toBe(false);
    expect(isCompanionSessionOperatorActive(session({ refreshTokenExpiresAt: now }), now)).toBe(false);
    expect(isCompanionSessionOperatorActive(session({ grantExpiresAt: now }), now)).toBe(false);
  });

  it("normalizes audit event, record, nonce, signature, and request path inputs", () => {
    expect(normalizeCompanionAuditEvent("auth.companion_session.refresh")).toBe("auth.companion_session.refresh");
    expect(normalizeCompanionAuditEvent("unknown")).toBe("auth.companion_request.accepted");
    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);

    expect(normalizeCompanionNonce(" abcDEF12._~- ")).toBe("abcDEF12._~-");
    expect(() => normalizeCompanionNonce("short")).toThrow("Companion request nonce is invalid.");
    expect(() => normalizeCompanionNonce("bad nonce value")).toThrow("Companion request nonce is invalid.");
    expect(() => normalizeCompanionNonce("a".repeat(2048))).toThrow("Companion request nonce is invalid.");

    expect(normalizeCompanionSignature(" abcDEF_1234567890- ")).toBe("abcDEF_1234567890-");
    expect(() => normalizeCompanionSignature("short")).toThrow("Companion request signature is invalid.");
    expect(() => normalizeCompanionSignature("bad signature!")).toThrow("Companion request signature is invalid.");
    expect(() => normalizeCompanionSignature("a".repeat(8192))).toThrow("Companion request signature is invalid.");

    expect(normalizeCompanionRequestPath(" /api/v1/chat ")).toBe("/api/v1/chat");
    expect(normalizeCompanionRequestPath("https://goatcitadel.local/api/v1/chat")).toBe("/api/v1/chat");
    expect(() => normalizeCompanionRequestPath("")).toThrow("Companion request path is required.");
    expect(normalizeCompanionRequestPath("relative/path")).toBe("/relative/path");
    expect(() => normalizeCompanionRequestPath("/api/v1/chat?x=1")).toThrow(
      "Companion signed mutations must not include query parameters.",
    );
  });

  it("decodes signatures and builds canonical signing payloads", () => {
    const encoded = Buffer.from("signed").toString("base64url");
    expect(decodeBase64Url(encoded).toString("utf8")).toBe("signed");

    const payload = buildCompanionSigningPayload({
      method: " post ",
      path: "/api/v1/chat",
      timestamp: " 2026-05-14T12:00:00.000Z ",
      nonce: "nonce-1234",
      body: { z: 1, a: { c: 3, b: 2 }, list: [{ y: 2, x: 1 }] },
    });

    const [method, path, timestamp, nonce, bodyHash] = payload.split("\n");
    expect(method).toBe("POST");
    expect(path).toBe("/api/v1/chat");
    expect(timestamp).toBe("2026-05-14T12:00:00.000Z");
    expect(nonce).toBe("nonce-1234");
    expect(bodyHash).toHaveLength(64);
    expect(
      buildCompanionSigningPayload({
        method: "POST",
        path: "/api/v1/chat",
        timestamp,
        nonce,
        body: { list: [{ x: 1, y: 2 }], a: { b: 2, c: 3 }, z: 1 },
      }),
    ).toBe(payload);
    expect(
      buildCompanionSigningPayload({
        method: "GET",
        path: "/api/v1/ping",
        timestamp,
        nonce,
        body: undefined,
      })
        .split("\n")
        .at(-1),
    ).toHaveLength(64);
  });
});

function session(overrides: Partial<CompanionSessionRecord> = {}): CompanionSessionRecord {
  return {
    sessionId: "session-1",
    grantId: "grant-1",
    accessTokenHash: "access",
    accessTokenExpiresAt: "2026-05-14T13:00:00.000Z",
    refreshTokenHash: "refresh",
    refreshTokenExpiresAt: "2026-05-14T14:00:00.000Z",
    signingPublicKeyPem: "pem",
    signatureAlgorithm: "ed25519",
    createdAt: "2026-05-14T10:00:00.000Z",
    lastRotatedAt: "2026-05-14T10:00:00.000Z",
    metadata: {},
    deviceLabel: "Pixel",
    deviceType: "phone",
    ...overrides,
  };
}
