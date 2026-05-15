import { describe, expect, it } from "vitest";
import {
  isLoopbackDevOrigin,
  isTailnetDevOrigin,
  isTailnetOrPrivateHost,
  resolveTailnetShortHostAllowlist,
} from "./cors-origin-guard.js";

describe("cors origin guard loop20 tails", () => {
  it("rejects malformed and non-http origins before host classification", () => {
    const allowlist = new Set<string>(["bld"]);

    expect(isTailnetDevOrigin("not a url", allowlist)).toBe(false);
    expect(isTailnetDevOrigin("ftp://bld:5173", allowlist)).toBe(false);
    expect(isTailnetDevOrigin("https://bld", allowlist)).toBe(false);
    expect(isLoopbackDevOrigin("ws://localhost:5173")).toBe(false);
    expect(isLoopbackDevOrigin(":: definitely not a url ::")).toBe(false);
  });

  it("accepts tailnet and private hosts only through the dev-port gate", () => {
    const allowlist = new Set<string>();

    expect(isTailnetDevOrigin("https://node.tail.ts.net:4173", allowlist)).toBe(true);
    expect(isTailnetDevOrigin("http://10.2.3.4:5173", allowlist)).toBe(true);
    expect(isTailnetDevOrigin("http://172.20.0.4:5173", allowlist)).toBe(true);
    expect(isTailnetDevOrigin("http://192.168.0.20:4173", allowlist)).toBe(true);
    expect(isTailnetDevOrigin("http://100.88.0.9:5173", allowlist)).toBe(true);
    expect(isTailnetDevOrigin("http://203.0.113.5:5173", allowlist)).toBe(false);
    expect(isTailnetDevOrigin("http://192.168.0.20:8080", allowlist)).toBe(false);
  });

  it("filters short-host allowlist entries and direct host classification", () => {
    const allowlist = resolveTailnetShortHostAllowlist({
      GOATCITADEL_TAILNET_DEV_HOSTS: " bld, bad.name, With-Case, under_score, ",
      GATEWAY_HOST: "edge-node",
    });

    expect([...allowlist].sort()).toEqual(["bld", "edge-node", "with-case"]);
    expect(isTailnetOrPrivateHost(" WITH-CASE ", allowlist)).toBe(true);
    expect(isTailnetOrPrivateHost("under_score", allowlist)).toBe(false);
    expect(isTailnetOrPrivateHost("", allowlist)).toBe(false);
    expect(isTailnetOrPrivateHost("localhost", allowlist)).toBe(true);
    expect(isTailnetOrPrivateHost("172.32.0.1", allowlist)).toBe(false);
    expect(isTailnetOrPrivateHost("100.128.0.1", allowlist)).toBe(false);
    expect(isTailnetOrPrivateHost("999.1.1.1", allowlist)).toBe(false);
  });
});
