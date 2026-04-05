import { describe, expect, it } from "vitest";
import { isSuspiciousEncodedPath } from "./path-guard.js";

describe("gateway encoded-path guard", () => {
  it("accepts normal API paths", () => {
    expect(isSuspiciousEncodedPath("/api/v1/sessions?limit=50")).toBe(false);
    expect(isSuspiciousEncodedPath("/health")).toBe(false);
  });

  it("rejects encoded traversal-like sequences", () => {
    expect(isSuspiciousEncodedPath("/api/v1/%2e%2e/secrets")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/%252e%252e/secrets")).toBe(true);
  });

  it("rejects encoded slash/backslash segments", () => {
    expect(isSuspiciousEncodedPath("/api/v1/channels/%2Ffoo/inbound")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/channels/%5Cfoo/inbound")).toBe(true);
  });

  it("rejects malformed encoded paths", () => {
    expect(isSuspiciousEncodedPath("/api/v1/%zz/inbound")).toBe(true);
  });

  it("rejects Windows UNC, ADS, and reserved-device path segments", () => {
    expect(isSuspiciousEncodedPath("//server/share/secrets.txt")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/file.txt::$DATA")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/CON/logs")).toBe(true);
    expect(isSuspiciousEncodedPath("/C:/Windows/System32/drivers/etc/hosts")).toBe(true);
  });
});
