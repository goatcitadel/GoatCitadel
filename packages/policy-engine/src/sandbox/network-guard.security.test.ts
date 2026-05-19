import { describe, expect, it } from "vitest";
import {
  assertHostAllowed,
  assertNotPrivateOrReservedHost,
  evaluateHostEgress,
  redactUrlForError,
} from "./network-guard.js";

// Regression coverage for CODEX_FINDING #25b (BlueBubbles/Zalo channel URL
// secrets leaked via thrown allowlist errors) and #26 (Telegram bot token
// embedded in `api.telegram.org/bot<token>/...` leaked via thrown
// allowlist errors). The fix is centralised in network-guard's
// `redactUrlForError` so every reason string strips userinfo, path, and
// query before propagating up through `commsInvoke` or any other caller
// that surfaces `error.message` to a tool transcript / audit record.

describe("network-guard URL redaction (codex #25b, #26)", () => {
  it("strips path-embedded secrets from telegram bot URLs", () => {
    expect(redactUrlForError("https://api.telegram.org/bot123456:ABC-XYZ-secret-token/sendMessage")).toBe(
      "https://api.telegram.org",
    );
  });

  it("strips query-string secrets from bridge URLs", () => {
    expect(redactUrlForError("http://127.0.0.1:1234/api/v1/messages?password=hunter2&from=me")).toBe(
      "http://127.0.0.1:1234",
    );
  });

  it("strips userinfo from URLs", () => {
    expect(redactUrlForError("https://username:supersecret@example.com/path")).toBe("https://example.com");
  });

  it("falls back gracefully on bare host:port input", () => {
    expect(redactUrlForError("api.telegram.org/bot12345:secret/sendMessage")).toBe("api.telegram.org");
  });

  it("returns marker for empty input", () => {
    expect(redactUrlForError("")).toBe("<empty>");
    expect(redactUrlForError("   ")).toBe("<empty>");
  });

  it("never surfaces query/path in evaluateHostEgress reason strings", () => {
    const decision = evaluateHostEgress("https://api.attacker.example/path?password=hunter2", []);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).not.toContain("hunter2");
    expect(decision.reason).not.toContain("password");
    expect(decision.reason).not.toContain("/path");
  });

  it("never surfaces malformed URL path or query data in reason strings", () => {
    const decision = evaluateHostEgress("http://bad host/path?token=secret", []);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).not.toContain("token=secret");
    expect(decision.reason).not.toContain("/path");
    expect(decision.reason).not.toContain("secret");

    let captured: unknown;
    try {
      assertNotPrivateOrReservedHost("http://bad host/private?password=hunter2");
    } catch (error) {
      captured = (error as Error).message;
    }
    expect(typeof captured).toBe("string");
    expect(captured as string).not.toContain("hunter2");
    expect(captured as string).not.toContain("password");
    expect(captured as string).not.toContain("/private");
  });

  it("never surfaces query/path in assertHostAllowed thrown errors", () => {
    let captured: unknown;
    try {
      assertHostAllowed("https://api.telegram.org/bot12345:secret-token/sendMessage", []);
    } catch (error) {
      captured = (error as Error).message;
    }
    expect(typeof captured).toBe("string");
    expect(captured as string).not.toContain("secret-token");
    expect(captured as string).not.toContain("/bot");
    expect(captured as string).not.toContain("sendMessage");
  });
});

// Regression coverage for CODEX_FINDING #11 (Firecrawl scrape redirect
// bypasses allowlist) and #12 (Firecrawl ingest enum sourceType cast). The
// shared building block is `assertNotPrivateOrReservedHost`, used by the
// Firecrawl ingestion backend and by `fetchWithDiagnosticsTimeout`.

describe("assertNotPrivateOrReservedHost (codex #11, #12, #13, #23)", () => {
  it("rejects AWS metadata IPv4", () => {
    expect(() => assertNotPrivateOrReservedHost("http://169.254.169.254/latest/meta-data/")).toThrow(/Private/);
  });

  it("rejects Alibaba metadata", () => {
    expect(() => assertNotPrivateOrReservedHost("http://100.100.100.200/")).toThrow(/Private/);
  });

  it("rejects loopback IPv4", () => {
    expect(() => assertNotPrivateOrReservedHost("http://127.0.0.1:2375/version")).toThrow(/Private/);
  });

  it("rejects RFC1918 hosts", () => {
    expect(() => assertNotPrivateOrReservedHost("http://10.0.0.1/")).toThrow(/Private/);
    expect(() => assertNotPrivateOrReservedHost("http://192.168.1.1/")).toThrow(/Private/);
    expect(() => assertNotPrivateOrReservedHost("http://172.16.0.1/")).toThrow(/Private/);
  });

  it("rejects documentation, benchmarking, and deprecated special IPv4 ranges", () => {
    expect(() => assertNotPrivateOrReservedHost("http://192.0.0.8/")).toThrow(/Private/);
    expect(() => assertNotPrivateOrReservedHost("http://192.0.2.10/")).toThrow(/Private/);
    expect(() => assertNotPrivateOrReservedHost("http://192.88.99.1/")).toThrow(/Private/);
    expect(() => assertNotPrivateOrReservedHost("http://198.18.0.1/")).toThrow(/Private/);
    expect(() => assertNotPrivateOrReservedHost("http://198.51.100.10/")).toThrow(/Private/);
    expect(() => assertNotPrivateOrReservedHost("http://203.0.113.10/")).toThrow(/Private/);
  });

  it("rejects IPv4-mapped IPv6 metadata", () => {
    expect(() => assertNotPrivateOrReservedHost("http://[::ffff:169.254.169.254]/")).toThrow(/Private/);
  });

  it("rejects documentation and deprecated site-local IPv6 ranges", () => {
    expect(() => assertNotPrivateOrReservedHost("http://[2001:db8::1]/")).toThrow(/Private/);
    expect(() => assertNotPrivateOrReservedHost("http://[fec0::1]/")).toThrow(/Private/);
  });

  it("rejects `localhost`", () => {
    expect(() => assertNotPrivateOrReservedHost("http://localhost/")).toThrow(/Private/);
  });

  it("accepts public hostnames", () => {
    expect(() => assertNotPrivateOrReservedHost("https://example.com/")).not.toThrow();
    expect(() => assertNotPrivateOrReservedHost("https://api.firecrawl.dev/v2/scrape")).not.toThrow();
  });

  it("does not leak the source URL on failure", () => {
    let captured: unknown;
    try {
      assertNotPrivateOrReservedHost("http://169.254.169.254/latest/meta-data/iam/security-credentials?token=secret");
    } catch (error) {
      captured = (error as Error).message;
    }
    expect(typeof captured).toBe("string");
    expect(captured as string).not.toContain("security-credentials");
    expect(captured as string).not.toContain("token=secret");
    expect(captured as string).not.toContain("/latest");
  });
});
