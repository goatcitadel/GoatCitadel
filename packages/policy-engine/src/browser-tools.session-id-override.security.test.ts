import { describe, expect, it } from "vitest";
import { __resolveBrowserSessionIdForTests } from "./browser-tools.js";

// Regression coverage for CODEX_FINDING #24: `resolveBrowserSessionId`
// previously trusted caller-supplied `args.browserSessionId` /
// `args.sessionId` over the execution-context session id. An attacker
// who could influence tool arguments could target ANY in-memory bucket
// in the global `browserSessionStates` map, including buckets holding
// authenticated cookies for another chat session. We now ignore both
// override fields and derive the bucket strictly from the execution
// context.

describe("resolveBrowserSessionId (codex #24)", () => {
  it("returns the execution-context session id", () => {
    expect(__resolveBrowserSessionIdForTests({}, { sessionId: "chat-session-1" })).toBe("chat-session-1");
  });

  it("ignores args.browserSessionId override", () => {
    expect(
      __resolveBrowserSessionIdForTests({ browserSessionId: "other-chat-session" }, { sessionId: "chat-session-1" }),
    ).toBe("chat-session-1");
  });

  it("ignores args.sessionId override", () => {
    expect(
      __resolveBrowserSessionIdForTests({ sessionId: "other-chat-session" }, { sessionId: "chat-session-1" }),
    ).toBe("chat-session-1");
  });

  it("ignores both overrides simultaneously", () => {
    expect(
      __resolveBrowserSessionIdForTests({ browserSessionId: "x", sessionId: "y" }, { sessionId: "chat-session-1" }),
    ).toBe("chat-session-1");
  });

  it("returns undefined when no execution-context session id is present", () => {
    expect(__resolveBrowserSessionIdForTests({ browserSessionId: "would-be-overridden" }, {})).toBeUndefined();
  });
});
