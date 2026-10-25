import { afterEach, describe, expect, it } from "vitest";
import { isAllowedGatewayOrigin, isLoopbackDevOrigin, isTailnetDevOrigin } from "./cors-origin-guard.js";

describe("cors origin guard", () => {
  it("accepts loopback dev origins on arbitrary ports", () => {
    expect(isLoopbackDevOrigin("http://127.0.0.1:62949")).toBe(true);
    expect(isLoopbackDevOrigin("http://localhost:4173")).toBe(true);
    expect(isLoopbackDevOrigin("https://localhost:8443")).toBe(true);
    expect(isLoopbackDevOrigin("http://[::1]:5173")).toBe(true);
  });

  it("rejects non-loopback origins from loopback helper", () => {
    expect(isLoopbackDevOrigin("http://192.168.0.20:5173")).toBe(false);
    expect(isLoopbackDevOrigin("not-a-url")).toBe(false);
  });

  it("keeps tailnet dev origin guard limited to approved dev ports", () => {
    const allowlist = new Set<string>(["bld"]);
    expect(isTailnetDevOrigin("http://127.0.0.1:5173", allowlist)).toBe(true);
    expect(isTailnetDevOrigin("http://127.0.0.1:62949", allowlist)).toBe(false);
    expect(isTailnetDevOrigin("http://bld:5173", allowlist)).toBe(true);
  });
});

describe("isAllowedGatewayOrigin", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("falls back to defaults on a blank env and normalises configured origins", () => {
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "   ";
    expect(isAllowedGatewayOrigin("http://localhost:5173")).toBe(true);
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "https://ops.example.com/";
    expect(isAllowedGatewayOrigin("https://ops.example.com")).toBe(true);
    expect(isAllowedGatewayOrigin("https://evil.example.com")).toBe(false);
  });

  it("allows loopback dev origins outside production only, and tailnet only when opted in", () => {
    delete process.env.GOATCITADEL_ALLOWED_ORIGINS;
    process.env.NODE_ENV = "development";
    expect(isAllowedGatewayOrigin("http://127.0.0.1:62949")).toBe(true);
    process.env.NODE_ENV = "production";
    expect(isAllowedGatewayOrigin("http://127.0.0.1:62949")).toBe(false);
    expect(isAllowedGatewayOrigin("http://host.tailnet.ts.net:5173")).toBe(false);
    process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "1";
    expect(isAllowedGatewayOrigin("http://host.tailnet.ts.net:5173")).toBe(true);
  });
});
