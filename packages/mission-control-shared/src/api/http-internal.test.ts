import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inferDefaultGatewayBaseUrl,
  isPrivateOrCarrierGradeIpv4,
  isTrustedGatewayHost,
  normalizeAuthMode,
  parseApiError,
  unwrapApiResponse,
} from "./http-internal";

describe("http-internal helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("unwraps API envelopes and parses empty, JSON, and text error bodies", () => {
    expect(unwrapApiResponse<{ ok: boolean }>({ success: true, data: { ok: true } })).toEqual({ ok: true });
    expect(unwrapApiResponse<{ ok: string }>({ meta: { requestId: "r1" }, data: { ok: "meta" } })).toEqual({
      ok: "meta",
    });
    expect(unwrapApiResponse("plain")).toBe("plain");

    expect(parseApiError("")).toEqual({});
    expect(parseApiError(JSON.stringify({ error: "auth", authMode: "basic" }))).toEqual({
      body: { error: "auth", authMode: "basic" },
      authMode: "basic",
    });
    expect(parseApiError("not json")).toEqual({ body: "not json" });
  });

  it("classifies trusted gateway hosts and private IPv4 ranges", () => {
    expect(isPrivateOrCarrierGradeIpv4("192.168.1.10")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("172.31.255.255")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("100.64.0.1")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("100.127.255.255")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("172.15.0.1")).toBe(false);
    expect(isPrivateOrCarrierGradeIpv4("100.128.0.1")).toBe(false);
    expect(isPrivateOrCarrierGradeIpv4("1.2.3")).toBe(false);

    expect(isTrustedGatewayHost("")).toBe(false);
    expect(isTrustedGatewayHost("worker.ts.net")).toBe(true);
    expect(isTrustedGatewayHost("192.168.10.20")).toBe(true);
    expect(isTrustedGatewayHost("gateway.example.com", ".example.com")).toBe(true);
    expect(isTrustedGatewayHost("gateway.internal", "gateway.internal")).toBe(true);
    expect(isTrustedGatewayHost("unknown.example", ".trusted.test")).toBe(false);
  });

  it("infers default gateway origins from server and browser environments", () => {
    vi.stubGlobal("window", undefined);
    expect(inferDefaultGatewayBaseUrl()).toBe("http://127.0.0.1:8787");

    vi.stubGlobal("window", { location: { protocol: "https:", hostname: "localhost" } });
    expect(inferDefaultGatewayBaseUrl()).toBe("https://localhost:8787");

    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "" } });
    expect(inferDefaultGatewayBaseUrl()).toBe("http://127.0.0.1:8787");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("window", { location: { protocol: "https:", hostname: "public.example" } });
    expect(inferDefaultGatewayBaseUrl()).toBe("https://127.0.0.1:8787");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing inferred gateway host "public.example"'));
  });

  it("normalizes gateway auth mode only from object payloads", () => {
    expect(normalizeAuthMode({ authMode: "none" })).toBe("none");
    expect(normalizeAuthMode({ authMode: "token" })).toBe("token");
    expect(normalizeAuthMode({ authMode: "basic" })).toBe("basic");
    expect(normalizeAuthMode({ authMode: "oauth" })).toBeUndefined();
    expect(normalizeAuthMode([])).toBeUndefined();
    expect(normalizeAuthMode(null)).toBeUndefined();
  });
});
