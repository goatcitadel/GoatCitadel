import { describe, expect, it } from "vitest";
import { assertAuthTokenIsNotPlaceholder, evaluateAuthTokenSafety } from "./startup-guard.js";

// Regression coverage for CODEX_FINDING #1: the Docker compose snippet
// shipped a known default token (`change-this-goatcitadel-token`), and
// historically the gateway would accept it as a valid operator token if
// the env var was left unset. We now refuse to boot if the configured
// token matches a known placeholder or fails minimal entropy checks.

describe("evaluateAuthTokenSafety (codex #1)", () => {
  it("rejects the documented placeholder token", () => {
    expect(evaluateAuthTokenSafety("change-this-goatcitadel-token")).toMatchObject({ ok: false });
    expect(evaluateAuthTokenSafety("CHANGE-THIS-GOATCITADEL-TOKEN")).toMatchObject({ ok: false });
  });

  it("rejects other obvious placeholders case-insensitively", () => {
    for (const placeholder of [
      "changeme",
      "password",
      "secret",
      "token",
      "admin",
      "test",
      "example",
      "placeholder",
      "goatcitadel",
    ]) {
      expect(evaluateAuthTokenSafety(placeholder), placeholder).toMatchObject({ ok: false });
      expect(evaluateAuthTokenSafety(placeholder.toUpperCase()), placeholder).toMatchObject({ ok: false });
    }
  });

  it("rejects empty/whitespace-only tokens", () => {
    expect(evaluateAuthTokenSafety("")).toMatchObject({ ok: false });
    expect(evaluateAuthTokenSafety("   ")).toMatchObject({ ok: false });
    expect(evaluateAuthTokenSafety(undefined)).toMatchObject({ ok: false });
  });

  it("rejects tokens shorter than 24 characters", () => {
    expect(evaluateAuthTokenSafety("abc")).toMatchObject({ ok: false, reason: expect.stringContaining("at least 24") });
    expect(evaluateAuthTokenSafety("0123456789012345678901")).toMatchObject({ ok: false }); // 22 chars
  });

  it("rejects low-entropy tokens (few distinct chars)", () => {
    expect(evaluateAuthTokenSafety("aaaaaaaaaaaaaaaaaaaaaaaa")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("entropy"),
    });
  });

  it("accepts a real random-looking token", () => {
    expect(evaluateAuthTokenSafety("7e9d34a8-9c2f-4f17-b3a1-1c2d3e4f5a6b")).toMatchObject({ ok: true });
    expect(evaluateAuthTokenSafety("Yh92Pq7XaR4Bz1NkLm3WvT8sJfDeQu05")).toMatchObject({ ok: true });
  });
});

describe("assertAuthTokenIsNotPlaceholder (codex #1)", () => {
  it("throws on the documented placeholder", () => {
    expect(() =>
      assertAuthTokenIsNotPlaceholder({
        mode: "token",
        allowLoopbackBypass: false,
        token: { value: "change-this-goatcitadel-token", queryParam: "access_token" },
        basic: { username: "", password: "" },
      }),
    ).toThrow(/placeholder/);
  });

  it("does NOT throw when auth mode is basic", () => {
    expect(() =>
      assertAuthTokenIsNotPlaceholder({
        mode: "basic",
        allowLoopbackBypass: false,
        token: { value: "change-this-goatcitadel-token", queryParam: "access_token" },
        basic: { username: "operator", password: "valid-long-password" },
      }),
    ).not.toThrow();
  });

  it("does NOT throw when auth mode is none", () => {
    expect(() =>
      assertAuthTokenIsNotPlaceholder({
        mode: "none",
        allowLoopbackBypass: false,
        token: { value: "change-this-goatcitadel-token", queryParam: "access_token" },
        basic: { username: "", password: "" },
      }),
    ).not.toThrow();
  });
});
