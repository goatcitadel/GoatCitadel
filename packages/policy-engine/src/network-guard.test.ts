import { describe, expect, it } from "vitest";
import { evaluateHostEgress, isHostAllowed } from "./sandbox/network-guard.js";

const OPENAI_CHAT_URL = new URL("/v1/chat/completions", "https://api.openai.com").toString();
const EXAMPLE_WILDCARD = `*.${new URL("https://example.com").hostname}`;
const LOCALHOST_HOST = new URL("http://localhost").hostname;

describe("isHostAllowed", () => {
  it("matches exact host", () => {
    expect(isHostAllowed(OPENAI_CHAT_URL, [new URL("https://api.openai.com").hostname])).toBe(true);
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
});
