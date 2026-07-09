import { describe, expect, it } from "vitest";
import { assertSafeRedirectTransition, isHttpRequestSafeToRetry } from "./http-request-policy.js";

describe("HTTP request policy", () => {
  it.each([undefined, "GET", "get", "HEAD", "head"])('allows automatic retry for safe method "%s"', (method) => {
    expect(isHttpRequestSafeToRetry(method ? { method } : undefined)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])('denies automatic retry for mutation method "%s"', (method) => {
    expect(isHttpRequestSafeToRetry({ method })).toBe(false);
  });

  it.each(["Proxy-Authorization", "X-Auth-Token", "X-Amz-Security-Token"])(
    'blocks cross-origin credential header "%s"',
    (headerName) => {
      expect(() =>
        assertSafeRedirectTransition("https://source.example/start", "https://destination.example/end", {
          headers: { [headerName]: "fixture-secret" },
        }),
      ).toThrow(/cross-origin redirect blocked/i);
    },
  );

  it("denies arbitrary custom headers across origins", () => {
    expect(() =>
      assertSafeRedirectTransition("https://source.example/start", "https://destination.example/end", {
        headers: { "X-Custom-Metadata": "fixture-value" },
      }),
    ).toThrow(/cross-origin redirect blocked/i);
  });

  it("allows only explicitly trusted, code-owned headers across origins", () => {
    expect(() =>
      assertSafeRedirectTransition(
        "https://source.example/start",
        "https://destination.example/end",
        { headers: { Accept: "text/html", "User-Agent": "GoatCitadel/1.0" } },
        ["accept", "user-agent"],
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeRedirectTransition(
        "https://source.example/start",
        "https://destination.example/end",
        { headers: { Accept: "text/html", "X-Custom-Metadata": "fixture-secret" } },
        ["accept", "user-agent"],
      ),
    ).toThrow(/cross-origin redirect blocked/i);
    expect(() =>
      assertSafeRedirectTransition(
        "https://source.example/start",
        "https://destination.example/end",
        { headers: { Authorization: "Bearer fixture-secret" } },
        ["authorization"],
      ),
    ).toThrow(/cross-origin redirect blocked/i);
  });
});
