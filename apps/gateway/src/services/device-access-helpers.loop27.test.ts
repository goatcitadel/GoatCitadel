import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ValidationError } from "@goatcitadel/contracts";
import {
  assertCompanionSigningPublicKeyPem,
  hashSensitiveToken,
  inferBrowserFromUserAgent,
  inferPlatformFromUserAgent,
  mapAuthDeviceGrantRow,
  mapAuthDeviceRequestRow,
  mapDeviceAccessStatusResponse,
  normalizeCompanionSigningPublicKeyPem,
  normalizeDeviceAccessDeviceType,
  normalizeDeviceAccessLabel,
  normalizeOptionalDeviceAccessText,
  timingSafeStringEqual,
  toDeviceAccessGrantRecord,
} from "./device-access-helpers.js";

describe("device access helper branch coverage", () => {
  it("normalizes labels, platforms, browsers, and optional text without inventing device claims", () => {
    expect(normalizeDeviceAccessDeviceType("tablet")).toBe("tablet");
    expect(normalizeDeviceAccessDeviceType("watch")).toBe("unknown");
    expect(normalizeOptionalDeviceAccessText("  abcdef  ", 3)).toBe("abc");
    expect(normalizeOptionalDeviceAccessText("     ", 3)).toBeUndefined();
    expect(hashSensitiveToken("device-secret")).toMatch(/^[a-f0-9]{64}$/);

    expect(inferPlatformFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("iPhone");
    expect(inferPlatformFromUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("iPad");
    expect(inferPlatformFromUserAgent("Mozilla/5.0 (Linux; Android 15)")).toBe("Android");
    expect(inferPlatformFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(inferPlatformFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("macOS");
    expect(inferPlatformFromUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux");
    expect(inferPlatformFromUserAgent("")).toBeUndefined();
    expect(inferPlatformFromUserAgent("UnknownDevice/1.0")).toBeUndefined();

    expect(inferBrowserFromUserAgent("Mozilla/5.0 Edg/124.0")).toBe("Edge");
    expect(inferBrowserFromUserAgent("Mozilla/5.0 Chrome/124.0 Safari/537.36")).toBe("Chrome");
    expect(inferBrowserFromUserAgent("Mozilla/5.0 Firefox/125.0")).toBe("Firefox");
    expect(inferBrowserFromUserAgent("Mozilla/5.0 Version/17.0 Safari/605.1.15")).toBe("Safari");
    expect(inferBrowserFromUserAgent("curl/8.0")).toBeUndefined();

    expect(normalizeDeviceAccessLabel("  Desk console  ", { deviceType: "desktop" })).toBe("Desk console");
    expect(
      normalizeDeviceAccessLabel(undefined, {
        deviceType: "browser",
        platform: "Windows",
        userAgent: "Mozilla/5.0 Chrome/124.0 Safari/537.36",
      }),
    ).toBe("Windows Chrome");
    expect(normalizeDeviceAccessLabel(undefined, { deviceType: "mobile", platform: "Android" })).toBe("Android");
    expect(normalizeDeviceAccessLabel(undefined, { deviceType: "unknown" })).toBe("New device");
    expect(normalizeDeviceAccessLabel(undefined, { deviceType: "tablet" })).toBe("Tablet device");
  });

  it("maps partial database rows to truthful status and grant contract records", () => {
    const request = mapAuthDeviceRequestRow({
      request_id: "request-1",
      approval_id: "approval-1",
      status: "not-a-status",
      device_label: null,
      platform: 42,
      created_at: "2026-05-15T01:00:00.000Z",
      expires_at: "2026-05-15T01:10:00.000Z",
      approved_token_plaintext: "token",
      approved_token_expires_at: "2026-06-15T01:00:00.000Z",
    });

    expect(request).toMatchObject({
      requestId: "request-1",
      approvalId: "approval-1",
      status: "pending",
      deviceType: "unknown",
      createdAt: "2026-05-15T01:00:00.000Z",
      expiresAt: "2026-05-15T01:10:00.000Z",
    });
    expect(request.platform).toBeUndefined();
    expect(mapDeviceAccessStatusResponse(request)).toEqual({
      requestId: "request-1",
      approvalId: "approval-1",
      status: "pending",
      expiresAt: "2026-05-15T01:10:00.000Z",
      message: "Waiting for approval from another authenticated Mission Control session.",
    });

    // SECURITY: the mapper never reads the plaintext token from the persisted
    // record (it is no longer stored at rest). A token is only emitted when the
    // status handler injects a single-use delivery from the in-memory vault.
    expect(
      mapDeviceAccessStatusResponse(
        {
          ...request,
          status: "approved",
          resolvedAt: "2026-05-15T01:02:00.000Z",
        },
        { deviceToken: "handoff-token" },
      ),
    ).toMatchObject({
      status: "approved",
      deviceToken: "handoff-token",
      // Falls back to the record's non-secret expiry when the delivery omits it.
      deviceTokenExpiresAt: "2026-06-15T01:00:00.000Z",
      message: "Access approved. Finishing secure handoff to this device.",
    });
    // Even when the record still carries a stale plaintext, no delivery arg ⇒ no token.
    expect(
      mapDeviceAccessStatusResponse({
        ...request,
        status: "approved",
        resolvedAt: "2026-05-15T01:02:00.000Z",
      }),
    ).toEqual({
      requestId: "request-1",
      approvalId: "approval-1",
      status: "approved",
      expiresAt: "2026-05-15T01:10:00.000Z",
      resolvedAt: "2026-05-15T01:02:00.000Z",
      message: "Access approved. Finishing secure handoff to this device.",
    });
    expect(mapDeviceAccessStatusResponse({ ...request, status: "rejected" }).message).toContain("rejected");
    expect(mapDeviceAccessStatusResponse({ ...request, status: "expired" }).message).toContain("expired");

    expect(mapAuthDeviceRequestRow({ status: "approved" }).status).toBe("approved");

    const grant = mapAuthDeviceGrantRow({
      grant_id: "grant-1",
      request_id: "request-1",
      token_hash: "hash",
      device_label: "Tablet",
      device_type: "tablet",
      granted_by: "operator",
      created_at: "2026-05-15T01:03:00.000Z",
      metadata_json: "[not a record]",
    });
    expect(grant.metadata).toEqual({});
    expect(mapAuthDeviceGrantRow({ metadata_json: '{"trusted":true}' }).metadata).toEqual({ trusted: true });
    expect(toDeviceAccessGrantRecord(grant)).toMatchObject({
      grantId: "grant-1",
      requestId: "request-1",
      actorId: "device:grant-1",
      deviceType: "tablet",
      grantedBy: "operator",
    });
  });

  it("validates fixed-length comparisons and Ed25519 companion signing keys", () => {
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(normalizeCompanionSigningPublicKeyPem("-----BEGIN KEY-----\r\nvalue\r\n-----END KEY-----\r\n")).toBe(
      "-----BEGIN KEY-----\nvalue\n-----END KEY-----",
    );

    expect(() => assertCompanionSigningPublicKeyPem("")).toThrow(ValidationError);
    expect(() => assertCompanionSigningPublicKeyPem("not a pem")).toThrow(
      "Signing public key must be a valid PEM-encoded Ed25519 public key.",
    );
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      format: "pem",
      type: "spki",
    });
    expect(() => assertCompanionSigningPublicKeyPem(String(rsa))).toThrow(
      "Signing public key must use the Ed25519 algorithm.",
    );
    const ed25519 = generateKeyPairSync("ed25519").publicKey.export({
      format: "pem",
      type: "spki",
    });
    expect(() => assertCompanionSigningPublicKeyPem(String(ed25519))).not.toThrow();
  });
});
