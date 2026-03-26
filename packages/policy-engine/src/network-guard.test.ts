import { describe, expect, it } from "vitest";
import { isHostAllowed } from "./sandbox/network-guard.js";

describe("isHostAllowed", () => {
  it("matches exact host", () => {
    expect(isHostAllowed("api.openai.com", ["api.openai.com"]))
      .toBe(true);
  });

  it("matches wildcard host", () => {
    expect(isHostAllowed("https://foo.example.com/path", ["*.example.com"]))
      .toBe(true);
  });

  it("rejects host not on allowlist", () => {
    expect(isHostAllowed("evil.com", ["*.example.com"]))
      .toBe(false);
  });

  it("blocks metadata host even when wildcard allowlist matches", () => {
    expect(isHostAllowed("http://169.254.169.254/latest/meta-data", ["*"]))
      .toBe(false);
  });

  it("blocks private RFC1918 host even when wildcard allowlist matches", () => {
    expect(isHostAllowed("http://192.168.1.20/api", ["*"]))
      .toBe(false);
  });

  it("allows explicit localhost loopback entry", () => {
    expect(isHostAllowed("http://localhost:11434/v1/models", ["localhost"]))
      .toBe(true);
  });

  it("blocks localhost when only wildcard pattern is present", () => {
    expect(isHostAllowed("http://localhost:8787/health", ["*"]))
      .toBe(false);
  });

  it("fails closed for public hosts when allowlist is empty", () => {
    expect(isHostAllowed("https://api.openai.com/v1/chat/completions", []))
      .toBe(false);
  });

  it("blocks private and metadata hosts when allowlist is empty", () => {
    expect(isHostAllowed("http://192.168.1.20/api", []))
      .toBe(false);
    expect(isHostAllowed("http://169.254.169.254/latest/meta-data", []))
      .toBe(false);
    expect(isHostAllowed("http://localhost:8787/health", []))
      .toBe(false);
  });
});
