import { describe, expect, it } from "vitest";
import { isLoopbackDevOrigin, isTailnetDevOrigin } from "./cors-origin-guard.js";

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
