import { describe, it, expect } from "vitest";
import { CuratorScopeGuard } from "./curator-scope-guard.js";

describe("CuratorScopeGuard", () => {
  it("allows skill + memory operations", () => {
    const guard = new CuratorScopeGuard();
    expect(() => guard.assertScopeAllowed("skill")).not.toThrow();
    expect(() => guard.assertScopeAllowed("memory")).not.toThrow();
  });

  it("rejects shell tool dispatch", () => {
    const guard = new CuratorScopeGuard();
    expect(() => guard.assertScopeAllowed("shell")).toThrow(/scope/i);
  });

  it("rejects web fetch", () => {
    const guard = new CuratorScopeGuard();
    expect(() => guard.assertScopeAllowed("web")).toThrow(/scope/i);
  });

  it("rejects any unknown operation kind", () => {
    const guard = new CuratorScopeGuard();
    expect(() => guard.assertScopeAllowed("network")).toThrow(/scope/i);
    expect(() => guard.assertScopeAllowed("fs:write:/etc/passwd")).toThrow(/scope/i);
  });

  it("records violations to a sink for audit", () => {
    const violations: Array<{ attemptedKind: string }> = [];
    const guard = new CuratorScopeGuard({ recordViolation: (v) => violations.push(v) });
    try {
      guard.assertScopeAllowed("shell");
    } catch {
      // expected — we only care about recorded violations below
    }
    expect(violations).toEqual([
      {
        attemptedKind: "shell",
        reason: "Only 'skill' and 'memory' scopes allowed in curator/improvement background runs",
      },
    ]);
  });
});
