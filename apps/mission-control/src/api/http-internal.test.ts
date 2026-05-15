import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  inferDefaultGatewayBaseUrl,
  inferOriginSurface,
  isApiRequestError,
  isPrivateOrCarrierGradeIpv4,
  isTrustedGatewayHost,
  normalizeAuthMode,
  normalizeHttpMethod,
  parseApiError,
  shouldRetrySafeRequest,
  unwrapApiResponse,
} from "./http-internal";

describe("http-internal helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("unwraps response envelopes and normalizes retryable request failures", () => {
    expect(unwrapApiResponse({ success: true, data: { ok: true } })).toEqual({ ok: true });
    expect(unwrapApiResponse({ meta: { requestId: "req-1" }, data: ["item"] })).toEqual(["item"]);
    expect(unwrapApiResponse({ ok: true })).toEqual({ ok: true });
    expect(normalizeHttpMethod()).toBe("GET");
    expect(normalizeHttpMethod("patch")).toBe("PATCH");

    const httpError = new ApiRequestError("try again", {
      kind: "http",
      method: "GET",
      path: "/api/v1/tasks",
      status: 503,
    });
    const networkError = new ApiRequestError("offline", {
      kind: "network",
      method: "HEAD",
      path: "/api/v1/health",
    });

    expect(isApiRequestError(httpError)).toBe(true);
    expect(shouldRetrySafeRequest("GET", httpError)).toBe(true);
    expect(shouldRetrySafeRequest("HEAD", networkError)).toBe(true);
    expect(shouldRetrySafeRequest("POST", httpError)).toBe(false);
    expect(shouldRetrySafeRequest("GET")).toBe(false);
  });

  it("classifies private gateway hosts and explicit allowlist entries", () => {
    expect(isPrivateOrCarrierGradeIpv4("not-an-ip")).toBe(false);
    expect(isPrivateOrCarrierGradeIpv4("999.1.1.1")).toBe(false);
    expect(isPrivateOrCarrierGradeIpv4("10.1.2.3")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("127.0.0.1")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("192.168.1.5")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("172.20.1.5")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("100.100.1.5")).toBe(true);
    expect(isPrivateOrCarrierGradeIpv4("8.8.8.8")).toBe(false);

    expect(isTrustedGatewayHost("")).toBe(false);
    expect(isTrustedGatewayHost("LOCALHOST")).toBe(true);
    expect(isTrustedGatewayHost("gateway.example.com", "gateway.example.com,.corp.example")).toBe(true);
    expect(isTrustedGatewayHost("api.corp.example", "gateway.example.com,.corp.example")).toBe(true);
    expect(isTrustedGatewayHost("public.example.com")).toBe(false);
  });

  it("infers safe gateway origins and falls back from untrusted browser hosts", () => {
    vi.stubGlobal("window", {
      location: {
        protocol: "https:",
        hostname: "laptop.ts.net",
      },
    });
    expect(inferDefaultGatewayBaseUrl()).toBe("https://laptop.ts.net:8787");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("window", {
      location: {
        protocol: "https:",
        hostname: "evil.example.com",
      },
    });
    expect(inferDefaultGatewayBaseUrl()).toBe("https://127.0.0.1:8787");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing inferred gateway host "evil.example.com"'));
  });

  it("maps origin surfaces and parses auth-aware API errors", () => {
    expect(inferOriginSurface("/api/v1/chat/sessions")).toBe("chat");
    expect(inferOriginSurface("/api/v1/addons")).toBe("addons");
    expect(inferOriginSurface("/api/v1/voice/speak")).toBe("voice");
    expect(inferOriginSurface("/api/v1/mcp/servers")).toBe("mcp");
    expect(inferOriginSurface("/api/v1/integrations/slack")).toBe("integrations");
    expect(inferOriginSurface("/api/v1/workspaces")).toBe("app");

    expect(normalizeAuthMode(null)).toBeUndefined();
    expect(normalizeAuthMode([])).toBeUndefined();
    expect(normalizeAuthMode({ authMode: "token" })).toBe("token");
    expect(normalizeAuthMode({ authMode: "unknown" })).toBeUndefined();

    expect(parseApiError("")).toEqual({});
    expect(parseApiError('{"authMode":"basic","message":"login"}')).toEqual({
      body: { authMode: "basic", message: "login" },
      authMode: "basic",
    });
    expect(parseApiError("plain failure")).toEqual({ body: "plain failure" });
  });
});
