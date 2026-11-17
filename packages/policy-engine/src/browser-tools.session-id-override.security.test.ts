import { describe, expect, it, vi } from "vitest";
import {
  __browserPageStateModeForTests,
  __resolveBrowserSessionIdForTests,
  executeBrowserTool,
} from "./browser-tools.js";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";

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

  it("keeps browser read tools stateless by default", () => {
    expect(__browserPageStateModeForTests("browser.search")).toBe("stateless");
    expect(__browserPageStateModeForTests("browser.navigate")).toBe("stateless");
    expect(__browserPageStateModeForTests("browser.extract")).toBe("stateless");
    expect(__browserPageStateModeForTests("browser.screenshot")).toBe("stateless");
  });

  it("keeps persisted page state only for approved interaction", () => {
    expect(__browserPageStateModeForTests("browser.interact")).toBe("session");
  });

  describe("governed browser storage reads", () => {
    const config: ToolPolicyConfig = {
      profiles: {},
      tools: { allow: ["browser.storage.get"], deny: [] },
      agents: {},
      sandbox: {
        writeJailRoots: [],
        readOnlyRoots: [],
        networkAllowlist: ["example.com"],
        riskyShellPatterns: [],
        requireApprovalForRiskyShell: true,
      },
    };

    it.each([{}, { origin: "file:///tmp/test" }, { origin: "https://example.com/path" }])(
      "rejects requests without an exact web origin: %j",
      async (args) => {
        const assertBrowserSessionAccess = vi.fn();
        await expect(
          executeBrowserTool("browser.storage.get", args, config, {
            sessionId: "browser-session-1",
            assertBrowserSessionAccess,
          }),
        ).rejects.toThrow("requires one explicit HTTP or HTTPS origin");
        expect(assertBrowserSessionAccess).not.toHaveBeenCalled();
      },
    );

    it("checks the storage origin and waits for the async grant denial", async () => {
      const assertBrowserSessionAccess = vi.fn(async () => {
        await Promise.resolve();
        throw new Error("missing browser session grant");
      });
      await expect(
        executeBrowserTool(
          "browser.storage.get",
          { origin: "https://other.example", url: "https://example.com", browserSessionId: "other-session" },
          config,
          { sessionId: "browser-session-1", actorId: "agent-1", assertBrowserSessionAccess },
        ),
      ).rejects.toThrow("missing browser session grant");
      expect(assertBrowserSessionAccess).toHaveBeenCalledExactlyOnceWith({
        sessionId: "browser-session-1",
        actorId: "agent-1",
        requiredScope: "state",
        host: "other.example",
        toolName: "browser.storage.get",
        runId: undefined,
      });
    });
  });
});
