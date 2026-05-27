import { describe, expect, it } from "vitest";
import { BrowserContentGuardService } from "./browser-content-guard.js";

describe("BrowserContentGuardService", () => {
  it("blocks values that leak an active browser canary", () => {
    const guard = new BrowserContentGuardService();
    const envelope = guard.createEnvelope("browser.extract", "untrusted page text");

    expect(guard.scan({ text: "ordinary answer" })).toMatchObject({ ok: true, blocked: false });
    expect(guard.scan({ toolArgs: { content: envelope.canary } })).toMatchObject({
      ok: false,
      blocked: true,
      reason: "browser_content_canary_leak",
    });
  });
});
