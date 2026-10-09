import { describe, expect, it } from "vitest";
import type { BrowserSessionEventRecord, BrowserSessionGrantRecord } from "@goatcitadel/contracts";
import {
  buildSessionPosture,
  describeContext,
  describeReceiptState,
  DEFAULT_GRANT_TTL_SECONDS,
  GRANT_TTL_PRESETS,
  describeEventPayload,
  grantMatchesRequest,
  isGrantActive,
  NEVER_EXPIRES_TTL,
  normalizeHost,
  validateGrantDraft,
} from "./browser-sessions-model";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const grant: BrowserSessionGrantRecord = {
  grantId: "g-1",
  sessionId: "s-1",
  actorId: "agent",
  scopes: ["read", "interact"],
  allowedHosts: ["example.com"],
  createdAt: "2026-10-07T11:00:00.000Z",
  expiresAt: "2026-10-07T13:00:00.000Z",
};

describe("grant drafts", () => {
  it("defaults to one hour and never offers a timed grant beyond the Gateway's seven-day cap", () => {
    expect(DEFAULT_GRANT_TTL_SECONDS).toBe(3600);
    const timed = GRANT_TTL_PRESETS.filter((preset) => preset.seconds !== NEVER_EXPIRES_TTL);
    expect(Math.max(...timed.map((preset) => preset.seconds))).toBe(7 * 24 * 60 * 60);
    expect(timed.every((preset) => preset.seconds > 0)).toBe(true);
  });

  it("builds the exact request with Gateway-normalized hosts", () => {
    expect(
      validateGrantDraft({
        actorId: " agent ",
        scopes: ["read"],
        hosts: "https://Example.com/path, docs.example.com;",
        ttlSeconds: 3600,
      }),
    ).toEqual({
      ok: true,
      request: {
        actorId: "agent",
        scopes: ["read"],
        allowedHosts: ["example.com", "docs.example.com"],
        ttlSeconds: 3600,
      },
    });
  });

  it("names a missing actor, missing scopes and an unsupported expiry", () => {
    // 5 seconds matches no preset (0 is now the explicit "never expires" choice).
    expect(validateGrantDraft({ actorId: " ", scopes: [], hosts: "", ttlSeconds: 5 })).toEqual({
      ok: false,
      errors: {
        actorId: "Enter the actor this grant is for.",
        scopes: "Choose at least one scope.",
        ttlSeconds: "Choose a supported expiry.",
      },
    });
  });

  it("normalizes hosts the way the Gateway does", () => {
    expect(normalizeHost("HTTPS://Docs.Example.com:8443/a")).toBe("docs.example.com");
    expect(normalizeHost(" example.com ")).toBe("example.com");
  });
});

describe("receipt freshness, posture and context", () => {
  it("checks the receipt's expiry against the requested duration", () => {
    const request = {
      actorId: "agent",
      scopes: ["interact", "read"] as BrowserSessionGrantRecord["scopes"],
      allowedHosts: ["example.com"],
      ttlSeconds: 7200,
    };
    expect(grantMatchesRequest(grant, request, "s-1")).toBe(true);
    expect(grantMatchesRequest(grant, { ...request, ttlSeconds: 15 * 60 }, "s-1")).toBe(false);
  });

  it("names a receipt that is no longer active instead of calling it new", () => {
    expect(describeReceiptState(grant, NOW)).toBe("active");
    expect(describeReceiptState({ ...grant, revokedAt: "2026-10-07T11:30:00.000Z" }, NOW)).toBe("revoked");
    expect(describeReceiptState({ ...grant, expiresAt: "2026-10-07T11:00:00.000Z" }, NOW)).toBe("expired");
  });

  it("summarizes tool posture from grants and retained evidence without claiming a live browser", () => {
    const posture = buildSessionPosture(
      "active",
      [
        grant,
        { ...grant, grantId: "g-2", scopes: ["admin"], allowedHosts: [] },
        { ...grant, grantId: "g-3", revokedAt: "x" },
      ],
      { recentEventCount: 4, guardBlockCount: 2, grantedAccessCount: 1, lastAccessAt: "2026-10-07T11:00:00.000Z" },
      NOW,
    );
    expect(posture).toEqual({
      callable: "Grants allow governed tool use",
      activeGrantCount: 2,
      highestScope: "admin",
      hostPosture: "At least one grant allows every host",
      guardBlockCount: 2,
      grantedAccessCount: 1,
      lastAccessAt: "2026-10-07T11:00:00.000Z",
    });
    expect(
      buildSessionPosture("closed", [grant], { recentEventCount: 0, guardBlockCount: 0, grantedAccessCount: 0 }, NOW)
        .callable,
    ).toBe("Closed: no tool can use this session");
    expect(
      buildSessionPosture("active", [], { recentEventCount: 0, guardBlockCount: 0, grantedAccessCount: 0 }, NOW),
    ).toMatchObject({
      callable: "No active grant: tools cannot use this session",
      highestScope: "None",
      hostPosture: "No active hosts",
    });
  });

  it("states configured context without values", () => {
    expect(
      describeContext({
        locale: "en-US",
        timezoneId: "UTC",
        geolocationConfigured: true,
        extraHTTPHeadersCount: 2,
        httpCredentialsConfigured: true,
      }),
    ).toBe("Locale en-US · timezone UTC · geolocation configured · 2 headers configured · credentials configured");
    expect(
      describeContext({ geolocationConfigured: false, extraHTTPHeadersCount: 0, httpCredentialsConfigured: false }),
    ).toBe("No browser context overrides");
  });
});

describe("grant receipts and state", () => {
  const request = {
    actorId: "agent",
    scopes: ["interact", "read"] as const,
    allowedHosts: ["example.com"],
    ttlSeconds: 7200,
  };

  it("accepts only the reviewed session, actor, scopes, hosts and an expiry", () => {
    expect(grantMatchesRequest(grant, { ...request, scopes: [...request.scopes] }, "s-1")).toBe(true);
    expect(
      grantMatchesRequest({ ...grant, sessionId: "s-2" }, { ...request, scopes: [...request.scopes] }, "s-1"),
    ).toBe(false);
    expect(
      grantMatchesRequest({ ...grant, actorId: "other" }, { ...request, scopes: [...request.scopes] }, "s-1"),
    ).toBe(false);
    expect(
      grantMatchesRequest({ ...grant, scopes: ["admin"] }, { ...request, scopes: [...request.scopes] }, "s-1"),
    ).toBe(false);
    expect(
      grantMatchesRequest({ ...grant, allowedHosts: [] }, { ...request, scopes: [...request.scopes] }, "s-1"),
    ).toBe(false);
    expect(
      grantMatchesRequest({ ...grant, expiresAt: undefined }, { ...request, scopes: [...request.scopes] }, "s-1"),
    ).toBe(false);
  });

  it("treats revoked and expired grants as inactive", () => {
    expect(isGrantActive(grant, NOW)).toBe(true);
    expect(isGrantActive({ ...grant, revokedAt: "2026-10-07T11:30:00.000Z" }, NOW)).toBe(false);
    expect(isGrantActive({ ...grant, expiresAt: "2026-10-07T11:59:59.000Z" }, NOW)).toBe(false);
    expect(isGrantActive({ ...grant, expiresAt: undefined }, NOW)).toBe(true);
  });

  it("hides browser state values in event payloads and says how many were hidden", () => {
    const event: BrowserSessionEventRecord = {
      eventId: "e-1",
      sessionId: "s-1",
      eventType: "tool_access_granted",
      payload: { toolName: "browser.navigate", cookieValue: "secret", localStorageDump: "x", scopes: ["read"] },
      createdAt: "now",
    };
    expect(describeEventPayload(event)).toBe(
      "toolName: browser.navigate · scopes: read · 2 browser state values hidden",
    );
    expect(describeEventPayload({ ...event, payload: {} })).toBe("No payload detail recorded.");
  });
});

describe("never-expiring grants", () => {
  const neverPreset = GRANT_TTL_PRESETS.find((preset) => preset.seconds === NEVER_EXPIRES_TTL);

  it("offers an explicit, never-default 'Never expires' choice after the timed presets", () => {
    expect(neverPreset?.label).toMatch(/Never expires/);
    expect(GRANT_TTL_PRESETS.at(-1)).toBe(neverPreset);
    expect(DEFAULT_GRANT_TTL_SECONDS).not.toBe(NEVER_EXPIRES_TTL);
  });

  it("asks the Gateway for no expiry and accepts only a receipt without one", () => {
    const parsed = validateGrantDraft({ actorId: "agent", scopes: ["read"], hosts: "", ttlSeconds: NEVER_EXPIRES_TTL });
    expect(parsed.ok && parsed.request.ttlSeconds).toBeNull();
    if (!parsed.ok) throw new Error("expected a valid draft");
    const permanent = { ...grant, scopes: ["read" as const], allowedHosts: [], expiresAt: undefined };
    expect(grantMatchesRequest(permanent, parsed.request, "s-1")).toBe(true);
    expect(grantMatchesRequest({ ...permanent, expiresAt: grant.expiresAt }, parsed.request, "s-1")).toBe(false);
    const timed = validateGrantDraft({ actorId: "agent", scopes: ["read"], hosts: "", ttlSeconds: 3600 });
    if (!timed.ok) throw new Error("expected a valid draft");
    expect(grantMatchesRequest(permanent, timed.request, "s-1")).toBe(false);
  });
});
