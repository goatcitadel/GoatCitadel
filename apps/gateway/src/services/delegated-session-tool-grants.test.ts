import { describe, expect, it } from "vitest";
import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { buildDelegatedSessionToolGrantCopies } from "./delegated-session-tool-grants.js";

function createGrant(
  input: Partial<ToolGrantRecord> & Pick<ToolGrantRecord, "grantId" | "toolPattern" | "decision">,
): ToolGrantRecord {
  return {
    grantId: input.grantId,
    toolPattern: input.toolPattern,
    decision: input.decision,
    scope: input.scope ?? "session",
    scopeRef: input.scopeRef ?? "parent-session",
    grantType: input.grantType ?? "persistent",
    constraints: input.constraints,
    createdBy: input.createdBy ?? "test",
    createdAt: input.createdAt ?? "2026-03-16T18:00:00.000Z",
    expiresAt: input.expiresAt,
    revokedAt: input.revokedAt,
    usesRemaining: input.usesRemaining,
  };
}

describe("buildDelegatedSessionToolGrantCopies", () => {
  it("inherits active durable session grants into delegated child sessions", () => {
    const copies = buildDelegatedSessionToolGrantCopies({
      parentSessionId: "parent-session",
      childSessionId: "child-session",
      parentGrants: [
        createGrant({
          grantId: "allow-file-read",
          toolPattern: "file.read_range",
          decision: "allow",
          constraints: {
            allowedPaths: ["src/**"],
            maxCallsPerHour: 20,
          },
        }),
        createGrant({
          grantId: "deny-browser-search",
          toolPattern: "browser.search",
          decision: "deny",
          grantType: "ttl",
          expiresAt: "2099-03-16T19:00:00.000Z",
        }),
        createGrant({
          grantId: "one-time-shell",
          toolPattern: "shell.exec",
          decision: "allow",
          grantType: "one_time",
          usesRemaining: 1,
        }),
      ],
      childGrants: [
        createGrant({
          grantId: "existing-bootstrap",
          toolPattern: "browser.navigate",
          decision: "allow",
          scopeRef: "child-session",
        }),
        createGrant({
          grantId: "existing-file-read",
          toolPattern: "file.read_range",
          decision: "allow",
          scopeRef: "child-session",
          constraints: {
            allowedPaths: ["src/**"],
            maxCallsPerHour: 20,
          },
        }),
      ],
    });

    expect(copies).toEqual([
      {
        toolPattern: "browser.search",
        decision: "deny",
        scope: "session",
        scopeRef: "child-session",
        grantType: "ttl",
        constraints: undefined,
        createdBy: "system-delegated-session-inherit",
        expiresAt: "2099-03-16T19:00:00.000Z",
        usesRemaining: undefined,
      },
    ]);
  });

  it("does not inherit allows that overlap an active deny", () => {
    const copies = buildDelegatedSessionToolGrantCopies({
      parentSessionId: "parent-session",
      childSessionId: "child-session",
      parentGrants: [
        createGrant({
          grantId: "allow-browser",
          toolPattern: "browser.*",
          decision: "allow",
        }),
        createGrant({
          grantId: "deny-browser-search",
          toolPattern: "browser.search",
          decision: "deny",
        }),
      ],
      childGrants: [
        createGrant({
          grantId: "deny-shell",
          toolPattern: "shell.*",
          decision: "deny",
          scopeRef: "child-session",
        }),
      ],
    });

    expect(copies).toEqual([
      {
        toolPattern: "browser.search",
        decision: "deny",
        scope: "session",
        scopeRef: "child-session",
        grantType: "persistent",
        constraints: undefined,
        createdBy: "system-delegated-session-inherit",
        expiresAt: undefined,
        usesRemaining: undefined,
      },
    ]);
  });

  it("keeps unrelated exact allows when a leading-wildcard deny is inherited", () => {
    const copies = buildDelegatedSessionToolGrantCopies({
      parentSessionId: "parent-session",
      childSessionId: "child-session",
      parentGrants: [
        createGrant({
          grantId: "allow-browser-navigate",
          toolPattern: "browser.navigate",
          decision: "allow",
        }),
        createGrant({
          grantId: "allow-webhook-send",
          toolPattern: "webhook.send",
          decision: "allow",
        }),
        createGrant({
          grantId: "deny-send",
          toolPattern: "*.send",
          decision: "deny",
        }),
      ],
    });

    expect(copies).toEqual([
      expect.objectContaining({
        toolPattern: "browser.navigate",
        decision: "allow",
      }),
      expect.objectContaining({
        toolPattern: "*.send",
        decision: "deny",
      }),
    ]);
  });

  it("does not inherit broad wildcard allows that overlap narrower wildcard denies", () => {
    const copies = buildDelegatedSessionToolGrantCopies({
      parentSessionId: "parent-session",
      childSessionId: "child-session",
      parentGrants: [
        createGrant({
          grantId: "allow-browser",
          toolPattern: "browser.*",
          decision: "allow",
        }),
        createGrant({
          grantId: "allow-shell",
          toolPattern: "shell.*",
          decision: "allow",
        }),
        createGrant({
          grantId: "deny-browser-search",
          toolPattern: "browser.search*",
          decision: "deny",
        }),
      ],
    });

    expect(copies).toEqual([
      expect.objectContaining({
        toolPattern: "shell.*",
        decision: "allow",
      }),
      expect.objectContaining({
        toolPattern: "browser.search*",
        decision: "deny",
      }),
    ]);
  });

  it("keeps disjoint wildcard allows when inherited denies do not overlap", () => {
    const copies = buildDelegatedSessionToolGrantCopies({
      parentSessionId: "parent-session",
      childSessionId: "child-session",
      parentGrants: [
        createGrant({
          grantId: "allow-browser",
          toolPattern: "browser.*",
          decision: "allow",
        }),
        createGrant({
          grantId: "deny-shell",
          toolPattern: "shell.*",
          decision: "deny",
        }),
      ],
    });

    expect(copies).toEqual([
      expect.objectContaining({
        toolPattern: "browser.*",
        decision: "allow",
      }),
      expect.objectContaining({
        toolPattern: "shell.*",
        decision: "deny",
      }),
    ]);
  });
});
