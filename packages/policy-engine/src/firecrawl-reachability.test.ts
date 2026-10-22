import { afterEach, describe, expect, it } from "vitest";
import {
  FIRECRAWL_UNREACHABLE_COOLDOWN_MS,
  FirecrawlUnavailableError,
  isFirecrawlConnectFailure,
  isFirecrawlCoolingDown,
  recordFirecrawlConnectFailure,
  recordFirecrawlSuccess,
  resetFirecrawlReachabilityForTests,
} from "./firecrawl-reachability.js";

const LOCAL = "http://127.0.0.1:3002";

describe("firecrawl reachability cooldown", () => {
  afterEach(() => {
    resetFirecrawlReachabilityForTests();
  });

  it("cools down for five minutes after a connect failure", () => {
    expect(FIRECRAWL_UNREACHABLE_COOLDOWN_MS).toBe(300_000);
    recordFirecrawlConnectFailure(LOCAL, 0);
    expect(isFirecrawlCoolingDown(LOCAL, 299_999)).toBe(true);
    expect(isFirecrawlCoolingDown(LOCAL, 300_000)).toBe(false);
  });

  it("clears an active cooldown on success", () => {
    recordFirecrawlConnectFailure(LOCAL, 0);
    recordFirecrawlSuccess(LOCAL);
    expect(isFirecrawlCoolingDown(LOCAL, 1)).toBe(false);
  });

  it("keys cooldowns per base URL and ignores trailing slashes", () => {
    recordFirecrawlConnectFailure(LOCAL, 0);
    expect(isFirecrawlCoolingDown("https://api.firecrawl.dev", 1)).toBe(false);
    expect(isFirecrawlCoolingDown(`${LOCAL}/`, 1)).toBe(true);
  });

  it("formats the unavailable error message", () => {
    const error = new FirecrawlUnavailableError(LOCAL);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`Firecrawl at ${LOCAL} is unreachable; skipping it for 5 minutes.`);
  });
});

describe("isFirecrawlConnectFailure", () => {
  it("matches the guard-wrapped refused connection (name TypeError, 'fetch failed', no cause)", () => {
    const wrapped = new Error("fetch failed");
    wrapped.name = "TypeError";
    expect(isFirecrawlConnectFailure(wrapped)).toBe(true);
  });

  it("matches the guard's own timeout", () => {
    expect(isFirecrawlConnectFailure(new Error("fetchAllowlisted timed out"))).toBe(true);
  });

  it("matches the AbortSignal.timeout fallback (TimeoutError)", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(isFirecrawlConnectFailure(timeout)).toBe(true);
  });

  it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"])(
    "matches an unwrapped TypeError with cause.code %s",
    (code) => {
      const error = Object.assign(new TypeError("anything"), { cause: { code } });
      expect(isFirecrawlConnectFailure(error)).toBe(true);
    },
  );

  it("does not match an unrelated cause code", () => {
    const error = Object.assign(new TypeError("anything"), { cause: { code: "ERR_INVALID_URL" } });
    expect(isFirecrawlConnectFailure(error)).toBe(false);
  });

  it("does not match an HTTP status error", () => {
    expect(isFirecrawlConnectFailure(new Error("Firecrawl search failed (500 Internal Server Error)."))).toBe(false);
  });

  it("does not match non-errors", () => {
    expect(isFirecrawlConnectFailure("fetch failed")).toBe(false);
    expect(isFirecrawlConnectFailure(undefined)).toBe(false);
  });

  it("returns false when the caller signal is aborted, even for a connect-shaped error", () => {
    const controller = new AbortController();
    controller.abort(new Error("turn cancelled"));
    const wrapped = new Error("fetch failed");
    wrapped.name = "TypeError";
    expect(isFirecrawlConnectFailure(new Error("turn cancelled"), controller.signal)).toBe(false);
    expect(isFirecrawlConnectFailure(wrapped, controller.signal)).toBe(false);
    expect(isFirecrawlConnectFailure(new Error("fetchAllowlisted timed out"), controller.signal)).toBe(false);
  });

  it("still classifies a connect failure when the caller signal is not aborted", () => {
    const controller = new AbortController();
    expect(isFirecrawlConnectFailure(new Error("fetchAllowlisted timed out"), controller.signal)).toBe(true);
  });
});
