import { describe, expect, it } from "vitest";
import {
  assertHostAllowed,
  assertHostAllowedInDangerProfile,
  evaluateDangerousHostBypass,
  evaluateHostEgress,
  isHostAllowed,
} from "./sandbox/network-guard.js";

const OPENAI_CHAT_URL = new URL("/v1/chat/completions", "https://api.openai.com").toString();
const EXAMPLE_WILDCARD = `*.${new URL("https://example.com").hostname}`;
const LOCALHOST_HOST = new URL("http://localhost").hostname;

describe("isHostAllowed", () => {
  it("matches exact host", () => {
    expect(isHostAllowed(OPENAI_CHAT_URL, [new URL("https://api.openai.com").hostname])).toBe(true);
  });

  it("does not treat dots in exact allowlist hosts as wildcard characters", () => {
    expect(
      isHostAllowed("https://apixopenai.com/v1/chat/completions", [new URL("https://api.openai.com").hostname]),
    ).toBe(false);
  });

  it("matches wildcard host", () => {
    expect(isHostAllowed("https://foo.example.com/path", [EXAMPLE_WILDCARD])).toBe(true);
  });

  it("rejects host not on allowlist", () => {
    expect(isHostAllowed("evil.com", [EXAMPLE_WILDCARD])).toBe(false);
  });

  it("blocks metadata host even when wildcard allowlist matches", () => {
    expect(isHostAllowed("http://169.254.169.254/latest/meta-data", ["*"])).toBe(false);
  });

  it("blocks private RFC1918 host even when wildcard allowlist matches", () => {
    expect(isHostAllowed("http://192.168.1.20/api", ["*"])).toBe(false);
  });

  it("allows explicit localhost loopback entry", () => {
    expect(isHostAllowed("http://localhost:11434/v1/models", [LOCALHOST_HOST])).toBe(true);
  });

  it("blocks localhost when only wildcard pattern is present", () => {
    expect(isHostAllowed("http://localhost:8787/health", ["*"])).toBe(false);
  });

  it("fails closed for public hosts when allowlist is empty", () => {
    expect(isHostAllowed(OPENAI_CHAT_URL, [])).toBe(false);
  });

  it("marks unknown public hosts as approval-required in the egress decision", () => {
    expect(evaluateHostEgress(OPENAI_CHAT_URL, [])).toMatchObject({
      allowed: false,
      approvalState: "approval_required",
    });
  });

  it("marks reserved hosts as blocked in the egress decision", () => {
    expect(evaluateHostEgress("http://169.254.169.254/latest/meta-data", ["*"])).toMatchObject({
      allowed: false,
      approvalState: "blocked",
    });
  });

  it("blocks private and metadata hosts when allowlist is empty", () => {
    expect(isHostAllowed("http://192.168.1.20/api", [])).toBe(false);
    expect(isHostAllowed("http://169.254.169.254/latest/meta-data", [])).toBe(false);
    expect(isHostAllowed("http://localhost:8787/health", [])).toBe(false);
  });

  it("fails closed for empty host inputs", () => {
    expect(evaluateHostEgress("   ", ["*"])).toMatchObject({
      hostname: "",
      allowed: false,
      approvalState: "blocked",
      reason: "Host is empty.",
    });
  });

  it("parses host:port strings and explicit loopback patterns", () => {
    expect(evaluateHostEgress("example.com:443/v1/models", ["example.com:443"])).toMatchObject({
      allowed: true,
      hostname: "example.com",
    });
    expect(evaluateHostEgress("localhost:8787", ["localhost:8787"])).toMatchObject({
      allowed: true,
      matchedAllowlistPattern: "localhost:8787",
    });
    expect(evaluateHostEgress("127.0.0.1:11434", ["127.0.0.1:11434"])).toMatchObject({
      allowed: true,
      matchedAllowlistPattern: "127.0.0.1:11434",
    });
    expect(evaluateHostEgress("[::1]:11434", ["[::1]:11434"])).toMatchObject({
      allowed: true,
      hostname: "::1",
      matchedAllowlistPattern: "[::1]:11434",
    });
  });

  it("fails closed for malformed URL-like and hostname inputs", () => {
    for (const host of [
      "https://exa mple.com/path",
      "http://999.999.999.999/path",
      "999.999.999.999",
      "1.2.3.999",
      "1.2.3.4.5",
      "example.com:not-a-port",
      "exa mple.com:443/v1/models",
    ]) {
      expect(evaluateHostEgress(host, ["*"]), host).toMatchObject({
        allowed: false,
        approvalState: "blocked",
      });
    }
  });

  it("blocks every private, malformed, multicast, and unique-local address family", () => {
    for (const host of [
      "10.0.0.5",
      "127.0.0.1",
      "0.0.0.0",
      "169.254.8.9",
      "192.168.1.5",
      "172.16.2.3",
      "224.0.0.1",
      "[::]",
      "[::1]",
      "[fc00::1]",
      "[fd00::1]",
      "[fe80::1]",
      "[fe90::1]",
      "[fea0::1]",
      "[feb0::1]",
    ]) {
      expect(evaluateHostEgress(host, ["*"]), host).toMatchObject({
        allowed: false,
        approvalState: "blocked",
      });
    }
  });

  it("allows public IPs and blocks non-loopback local hostnames even when matched", () => {
    expect(evaluateHostEgress("8.8.8.8", ["*"])).toMatchObject({
      allowed: true,
      approvalState: "not_required",
    });
    expect(evaluateHostEgress("printer.local", ["printer.local"])).toMatchObject({
      allowed: false,
      approvalState: "blocked",
      matchedAllowlistPattern: "printer.local",
    });
  });

  it("uses dangerous-profile bypass only for public unallowlisted hosts", () => {
    expect(evaluateDangerousHostBypass(OPENAI_CHAT_URL, ["api.openai.com"])).toMatchObject({
      blocked: false,
      shouldAudit: false,
    });
    expect(evaluateDangerousHostBypass("http://192.168.1.20/api", ["*"])).toMatchObject({
      blocked: true,
      shouldAudit: false,
    });
    expect(evaluateDangerousHostBypass("https://unlisted.example", [])).toMatchObject({
      blocked: false,
      shouldAudit: true,
      hostname: "unlisted.example",
      reason: "Danger profile bypassed network allowlist for https://unlisted.example",
    });
  });

  it("throws from strict guards and permits dangerous-profile public bypasses", () => {
    expect(() => assertHostAllowed(OPENAI_CHAT_URL, [])).toThrow(/not yet allowlisted/i);
    expect(() => assertHostAllowed(OPENAI_CHAT_URL, ["api.openai.com"])).not.toThrow();
    expect(() => assertHostAllowedInDangerProfile("https://unlisted.example", [])).not.toThrow();
    expect(() => assertHostAllowedInDangerProfile("http://169.254.169.254/latest", ["*"])).toThrow(
      /metadata|reserved|private/i,
    );
  });
});
