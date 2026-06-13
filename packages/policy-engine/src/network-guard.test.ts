import { describe, expect, it } from "vitest";
import {
  assertHostAllowed,
  assertHostAllowedInDangerProfile,
  evaluateDangerousHostBypass,
  evaluateHostEgress,
  isHostAllowed,
} from "./sandbox/network-guard.js";

const HOST_DOT = ".";
const OPENAI_HOST = `api${HOST_DOT}openai${HOST_DOT}com`;
const OPENAI_CHAT_URL = new URL("/v1/chat/completions", `https://${OPENAI_HOST}`).toString();
const EXAMPLE_WILDCARD = `*${HOST_DOT}example${HOST_DOT}com`;
const LOCALHOST_HOST = new URL("http://localhost").hostname;

describe("isHostAllowed", () => {
  it("matches exact host", () => {
    expect(isHostAllowed(OPENAI_CHAT_URL, [OPENAI_HOST])).toBe(true);
  });

  it("does not treat dots in exact allowlist hosts as wildcard characters", () => {
    expect(isHostAllowed("https://apixopenai.com/v1/chat/completions", [OPENAI_HOST])).toBe(false);
  });

  it("matches wildcard host", () => {
    expect(isHostAllowed("https://foo.example.com/path", [EXAMPLE_WILDCARD])).toBe(true);
  });

  it("requires wildcard patterns to satisfy ordered prefixes and suffixes", () => {
    expect(isHostAllowed("https://api.eu.example.com/path", ["api.*.example.com"])).toBe(true);
    expect(isHostAllowed("https://cdn.example.net/path", ["api.*.example.com"])).toBe(false);
    expect(isHostAllowed("https://api.example.net/path", ["api.*.example.com"])).toBe(false);
    expect(isHostAllowed("https://foo.example.com.evil.test/path", [EXAMPLE_WILDCARD])).toBe(false);
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
      "https://",
      "https://:443/path",
      "file:///tmp/workspace.txt",
      "https://exa mple.com/path",
      "http://999.999.999.999/path",
      "999.999.999.999:443",
      "999.999.999.999",
      "1.2.3.999",
      "1.2.3.4.5",
      "example.com:not-a-port",
      "exa mple.com:443/v1/models",
      "[::1]:not-a-port",
    ]) {
      expect(evaluateHostEgress(host, ["*"]), host).toMatchObject({
        allowed: false,
        approvalState: "blocked",
      });
    }
  });

  it("rejects malformed protocol URLs and wildcard segment mismatches", () => {
    expect(evaluateHostEgress("http://", ["*"])).toMatchObject({
      allowed: false,
      approvalState: "blocked",
      reason: expect.stringContaining("malformed"),
    });
    expect(isHostAllowed("https://api.example.com", ["cdn*example.com"])).toBe(false);
    expect(isHostAllowed("https://api.example.com", ["api.**.example.com"])).toBe(false);
  });

  it("normalizes scheme-authority whitespace before allowlist and SSRF checks", () => {
    expect(evaluateHostEgress("https: // example.com/v1/models", ["example.com"])).toMatchObject({
      allowed: true,
      hostname: "example.com",
      matchedAllowlistPattern: "example.com",
    });
    expect(evaluateHostEgress("https://exa mple.com/v1/models", ["*"])).toMatchObject({
      allowed: false,
      approvalState: "blocked",
      reason: expect.stringContaining("invalid whitespace"),
    });
    expect(evaluateHostEgress("http:// 169.254.169.254/latest/meta-data", ["*"])).toMatchObject({
      allowed: false,
      approvalState: "blocked",
      reason: expect.stringContaining("Private"),
    });
  });

  it("blocks every private, malformed, multicast, and unique-local address family", () => {
    for (const host of [
      "10.0.0.5",
      "100.64.0.4",
      "100.127.255.254",
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
    expect(evaluateHostEgress("100.128.0.1", ["*"])).toMatchObject({
      allowed: true,
      approvalState: "not_required",
    });
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

  it("marks dangerous-profile public unallowlisted hosts for low-level bypass audit", () => {
    expect(evaluateDangerousHostBypass(OPENAI_CHAT_URL, [OPENAI_HOST])).toMatchObject({
      blocked: false,
      shouldAudit: false,
    });
    expect(evaluateDangerousHostBypass("http://192.168.1.20/api", ["*"])).toMatchObject({
      blocked: true,
      shouldAudit: false,
    });
    expect(evaluateDangerousHostBypass("https://user:secret@unlisted.example/callback?token=secret", [])).toMatchObject(
      {
        blocked: false,
        shouldAudit: true,
        hostname: "unlisted.example",
        reason:
          "Low-level bypass audit marker for public network target outside the allowlist: https://unlisted.example",
      },
    );
  });

  it("throws from strict guards and leaves public bypass handling to the engine", () => {
    expect(() => assertHostAllowed(OPENAI_CHAT_URL, [])).toThrow(/not yet allowlisted/i);
    expect(() => assertHostAllowed(OPENAI_CHAT_URL, [OPENAI_HOST])).not.toThrow();
    expect(() => assertHostAllowedInDangerProfile("https://unlisted.example", [])).not.toThrow();
    expect(() => assertHostAllowedInDangerProfile("http://169.254.169.254/latest", ["*"])).toThrow(
      /metadata|reserved|private/i,
    );
  });

  it("treats parsed empty hostnames as blocked private targets", () => {
    expect(evaluateHostEgress(":443", ["*"])).toMatchObject({
      hostname: "",
      allowed: false,
      approvalState: "blocked",
      reason: "Private, metadata, or reserved host is blocked: :443",
    });
  });

  // SECURITY_AUDIT_2026-05-15 — S5 + S6: cloud-metadata SSRF floor must block
  // every cloud-metadata endpoint regardless of allowlist content, including
  // the bracketed-IPv6 URL form (`http://[fc00::1]/`) and the IPv4-mapped
  // IPv6 form (`http://[::ffff:169.254.169.254]/`) that previously bypassed
  // the guard because new URL() returns hostname with brackets and isIP()
  // does not classify the bracketed form as IPv6.
  it("blocks every cloud-metadata endpoint even when '*' is allowlisted", () => {
    const cloudMetadataTargets = [
      "http://169.254.169.254/latest/meta-data/iam/security-credentials", // AWS
      "http://169.254.169.254:80/computeMetadata/v1/", // GCP via raw IP
      "http://metadata.google.internal/computeMetadata/v1/instance/", // GCP DNS
      "http://100.100.100.200/latest/meta-data/", // Alibaba Cloud
      "http://[fc00::1]/", // ULA via bracketed-URL form
      "http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/", // ULA range end
      "http://[fe80::1]/", // link-local via bracketed-URL form
      "http://[::1]/", // loopback via bracketed-URL form
      "http://[::ffff:169.254.169.254]/", // IPv4-mapped AWS metadata
      "https://[fc00::1]:8443/path", // ULA with port + path
      "[fc00::1]", // bare bracketed host (no scheme)
    ];
    for (const target of cloudMetadataTargets) {
      const decision = evaluateHostEgress(target, ["*"]);
      expect(decision.allowed, target).toBe(false);
      expect(decision.approvalState, target).toBe("blocked");
    }
  });

  it("still allows public IPv6 hosts via the bracketed-URL form", () => {
    // After the bracketed-IPv6 SSRF fix, public IPv6 (e.g. Google DNS)
    // must still flow through the allowlist unchanged.
    expect(evaluateHostEgress("http://[2001:4860:4860::8888]/", ["*"])).toMatchObject({
      allowed: true,
      approvalState: "not_required",
    });
  });
});
