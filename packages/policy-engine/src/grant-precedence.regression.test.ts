/**
 * P0-4 governance/safety regression — tool-grant precedence and pattern parsing.
 *
 * Covers gaps flagged in review that the existing `engine.test.ts` suite leaves thin:
 *   1. Declared tool-grant parsing: how grant `toolPattern` matches the requested tool
 *      (exact, glob, the `*` catch-all), and that revoked / expired / used-up grants are
 *      NOT parsed as live grants.
 *   2. Glob / alias command allowlist edge cases: `matchesToolPattern` literal-vs-glob
 *      behaviour for regex-special characters, mid-string wildcards, and oversized input.
 *   3. Allow-vs-block precedence when multiple rules match: deny-wins across the SAME and
 *      DIFFERENT scopes, the static `deny` config overriding an open `*` profile, and a
 *      grant-deny overriding a grant-allow regardless of which the engine sees first.
 *
 * The harness mirrors `engine.test.ts` (a hand-rolled `Storage` stub + a `danger: ["*"]`
 * profile) so these tests exercise the real `ToolPolicyEngine.evaluateAccess` path rather
 * than re-implementing the rules.
 */
import { describe, expect, it, vi } from "vitest";
import type { ToolGrantRecord, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { ToolPolicyEngine } from "./engine.js";
import { matchesAnyToolPattern, matchesToolPattern } from "./tool-patterns.js";

function createStorageStub(): Storage {
  return {
    approvals: {
      create: vi.fn((input: { kind: string; riskLevel: string }) => ({
        approvalId: "approval-1",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        createdAt: "2026-06-18T12:00:00.000Z",
        explanationStatus: "not_requested",
      })),
      get: vi.fn(),
    },
    approvalEvents: { append: vi.fn() },
    audit: { append: vi.fn(async () => undefined) },
    toolAccessDecisions: {
      record: vi.fn(),
      countToolCallsInLastHourInScope: vi.fn(() => 0),
      countWritesInLastHourInScope: vi.fn(() => 0),
    },
    toolGrants: {
      list: vi.fn(() => []),
      consumeOne: vi.fn(() => true),
    },
    pendingApprovalActions: {
      upsertPending: vi.fn(),
      find: vi.fn(() => undefined),
      markResolved: vi.fn(),
    },
    db: {
      prepare: vi.fn(() => ({ run: vi.fn() })),
    },
  } as unknown as Storage;
}

/** A `danger: ["*"]` profile in `approve_risky` mode: every tool is in-profile, but any
 *  non-safe tool needs approval unless an explicit allow-grant covers it. This isolates the
 *  grant machinery from profile membership. */
const baseConfig: ToolPolicyConfig = {
  profiles: { danger: ["*"] },
  tools: { profile: "danger", approvalMode: "approve_risky", allow: [], deny: [] },
  agents: {},
  sandbox: {
    writeJailRoots: ["./workspace"],
    readOnlyRoots: ["./skills"],
    networkAllowlist: ["localhost"],
    riskyShellPatterns: [],
    requireApprovalForRiskyShell: true,
  },
};

function grant(overrides: Partial<ToolGrantRecord> & Pick<ToolGrantRecord, "toolPattern" | "decision">): ToolGrantRecord {
  return {
    grantId: overrides.grantId ?? `grant-${overrides.toolPattern}-${overrides.decision}`,
    toolPattern: overrides.toolPattern,
    decision: overrides.decision,
    scope: overrides.scope ?? "session",
    scopeRef: overrides.scopeRef ?? "session-1",
    grantType: overrides.grantType ?? "persistent",
    createdBy: overrides.createdBy ?? "operator-test",
    createdAt: overrides.createdAt ?? "2026-06-18T12:00:00.000Z",
    ...overrides,
  } as ToolGrantRecord;
}

/** Wire a fixed set of grants into the stub via the `list(scope, scopeRef, limit)` path
 *  (the engine filters by active-ness and scope/pattern match itself). */
function withGrants(storage: Storage, grants: ToolGrantRecord[]): void {
  vi.mocked(storage.toolGrants.list).mockImplementation((scope?: string, scopeRef?: string) =>
    grants.filter((g) => g.scope === scope && g.scopeRef === scopeRef),
  );
}

const baseRequest = {
  agentId: "agent-1",
  sessionId: "session-1",
  workspaceId: "workspace-1",
} as const;

describe("matchesToolPattern (grant/allowlist pattern parsing)", () => {
  it("matches an exact tool name and rejects near-misses", () => {
    expect(matchesToolPattern("fs.read", "fs.read")).toBe(true);
    expect(matchesToolPattern("fs.read", "fs.readme")).toBe(false);
    expect(matchesToolPattern("fs.read", "fs.write")).toBe(false);
  });

  it("treats `*` alone as a catch-all but a dotted glob as a namespace prefix", () => {
    expect(matchesToolPattern("*", "anything.at.all")).toBe(true);
    expect(matchesToolPattern("git.*", "git.commit")).toBe(true);
    expect(matchesToolPattern("git.*", "git.branch.create")).toBe(true);
    // A namespace glob must not leak across the namespace boundary.
    expect(matchesToolPattern("git.*", "github.commit")).toBe(false);
    expect(matchesToolPattern("git.*", "fs.read")).toBe(false);
  });

  it("supports mid-string and multi-segment wildcards", () => {
    expect(matchesToolPattern("browser.*.get", "browser.cookies.get")).toBe(true);
    expect(matchesToolPattern("browser.*.get", "browser.storage.get")).toBe(true);
    expect(matchesToolPattern("browser.*.get", "browser.cookies.set")).toBe(false);
  });

  it("treats regex metacharacters in the pattern literally, not as regex", () => {
    // `.` is a literal dot here — it must not match an arbitrary character.
    expect(matchesToolPattern("fs.read", "fsXread")).toBe(false);
    // A `+` in the pattern is literal; it only matches a literal `+`.
    expect(matchesToolPattern("tool+name", "tool+name")).toBe(true);
    expect(matchesToolPattern("tool+name", "toolname")).toBe(false);
    expect(matchesToolPattern("a(b)", "a(b)")).toBe(true);
  });

  it("rejects empty, whitespace-only, and over-long patterns or tool names", () => {
    expect(matchesToolPattern("", "fs.read")).toBe(false);
    expect(matchesToolPattern("   ", "fs.read")).toBe(false);
    expect(matchesToolPattern("fs.read", "")).toBe(false);
    const tooLong = `${"a".repeat(513)}`;
    expect(matchesToolPattern(tooLong, "fs.read")).toBe(false);
    expect(matchesToolPattern("*", tooLong)).toBe(false);
  });

  it("matchesAnyToolPattern returns true when any allowlist entry matches", () => {
    expect(matchesAnyToolPattern(["fs.read", "git.*"], "git.commit")).toBe(true);
    expect(matchesAnyToolPattern(["fs.read", "git.*"], "shell.exec")).toBe(false);
    expect(matchesAnyToolPattern([], "fs.read")).toBe(false);
  });
});

describe("declared tool-grant parsing", () => {
  it("honours an allow-grant whose glob pattern covers the requested tool", () => {
    const storage = createStorageStub();
    withGrants(storage, [grant({ grantId: "grant-fs-glob", toolPattern: "fs.*", decision: "allow" })]);
    const engine = new ToolPolicyEngine(baseConfig, storage);

    const evaluation = engine.evaluateAccess({ ...baseRequest, toolName: "fs.write", args: { path: "./workspace/x" } });

    expect(evaluation.allowed).toBe(true);
    expect(evaluation.matchedGrantId).toBe("grant-fs-glob");
  });

  it("ignores a grant whose pattern does not cover the requested tool", () => {
    const storage = createStorageStub();
    // A grant for `git.*` must not satisfy an `fs.write` request.
    withGrants(storage, [grant({ grantId: "grant-git", toolPattern: "git.*", decision: "allow" })]);
    const engine = new ToolPolicyEngine(baseConfig, storage);

    const evaluation = engine.evaluateAccess({ ...baseRequest, toolName: "fs.write", args: { path: "./workspace/x" } });

    // Still in-profile (danger:["*"]) so allowed, but with NO matching grant → approval is
    // required because the non-grant danger path falls back to approve_risky.
    expect(evaluation.matchedGrantId).toBeUndefined();
    expect(evaluation.requiresApproval).toBe(true);
  });

  it.each([
    ["revoked", { revokedAt: "2026-06-18T12:30:00.000Z" }],
    ["expired", { expiresAt: "2000-01-01T00:00:00.000Z" }],
    ["used-up", { usesRemaining: 0 }],
  ])("does not parse a %s grant as a live allow", (_label, lifecycle) => {
    const storage = createStorageStub();
    withGrants(storage, [
      grant({ grantId: "grant-dead", toolPattern: "shell.exec", decision: "allow", ...lifecycle } as Partial<ToolGrantRecord> & Pick<ToolGrantRecord, "toolPattern" | "decision">),
    ]);
    const engine = new ToolPolicyEngine(baseConfig, storage);

    const evaluation = engine.evaluateAccess({ ...baseRequest, toolName: "shell.exec", args: { command: "echo hi" } });

    // The dead grant must not short-circuit approval — no live allow-grant remains.
    expect(evaluation.matchedGrantId).toBeUndefined();
    expect(evaluation.requiresApproval).toBe(true);
  });

  it("blocks an allow-grant whose constraints reject the request (host out of allowlist)", () => {
    const storage = createStorageStub();
    withGrants(storage, [
      grant({
        grantId: "grant-host-bound",
        toolPattern: "http.get",
        decision: "allow",
        constraints: { allowedHosts: ["allowed.example"] },
      }),
    ]);
    const engine = new ToolPolicyEngine(
      { ...baseConfig, sandbox: { ...baseConfig.sandbox, networkAllowlist: ["allowed.example", "blocked.example"] } },
      storage,
    );

    const evaluation = engine.evaluateAccess({
      ...baseRequest,
      toolName: "http.get",
      args: { url: "https://blocked.example/data" },
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("grant_constraints_block");
    expect(evaluation.matchedGrantId).toBe("grant-host-bound");
  });
});

describe("allow-vs-block precedence (multiple matching rules)", () => {
  it("deny-wins when an allow and a deny grant match at the same scope", () => {
    const storage = createStorageStub();
    withGrants(storage, [
      grant({ grantId: "grant-allow", toolPattern: "shell.exec", decision: "allow" }),
      grant({ grantId: "grant-deny", toolPattern: "shell.exec", decision: "deny" }),
    ]);
    const engine = new ToolPolicyEngine(baseConfig, storage);

    const evaluation = engine.evaluateAccess({ ...baseRequest, toolName: "shell.exec", args: { command: "rm x" } });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toEqual(["grant_deny"]);
    expect(evaluation.matchedGrantId).toBe("grant-deny");
  });

  it("deny-wins is order-independent (deny listed before the allow still blocks)", () => {
    const storage = createStorageStub();
    withGrants(storage, [
      grant({ grantId: "grant-deny-first", toolPattern: "shell.*", decision: "deny" }),
      grant({ grantId: "grant-allow-second", toolPattern: "shell.exec", decision: "allow" }),
    ]);
    const engine = new ToolPolicyEngine(baseConfig, storage);

    const evaluation = engine.evaluateAccess({ ...baseRequest, toolName: "shell.exec", args: { command: "rm x" } });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.matchedGrantId).toBe("grant-deny-first");
  });

  it("a broad deny grant beats a more-specific allow grant across different scopes", () => {
    const storage = createStorageStub();
    // Allow scoped tightly to the task; deny scoped broadly to the workspace. Deny must win
    // regardless of specificity — there is no "most-specific allow overrides deny".
    withGrants(storage, [
      grant({ grantId: "task-allow", toolPattern: "fs.delete", decision: "allow", scope: "task", scopeRef: "task-1" }),
      grant({
        grantId: "workspace-deny",
        toolPattern: "fs.*",
        decision: "deny",
        scope: "workspace",
        scopeRef: "workspace-1",
      }),
    ]);
    const engine = new ToolPolicyEngine(baseConfig, storage);

    const evaluation = engine.evaluateAccess({
      ...baseRequest,
      taskId: "task-1",
      toolName: "fs.delete",
      args: { path: "./workspace/secret" },
    });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toEqual(["grant_deny"]);
    expect(evaluation.matchedGrantId).toBe("workspace-deny");
  });

  it("the static `deny` config blocks a tool even though the profile is `*`", () => {
    const storage = createStorageStub();
    const engine = new ToolPolicyEngine(
      { ...baseConfig, tools: { ...baseConfig.tools, deny: ["shell.exec"] } },
      storage,
    );

    const evaluation = engine.evaluateAccess({ ...baseRequest, toolName: "shell.exec", args: { command: "echo hi" } });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("policy_deny");
  });

  it("a `deny` config glob blocks the whole namespace ahead of any allow-grant", () => {
    const storage = createStorageStub();
    // Even with a live allow-grant for the exact tool, the config-level deny glob wins:
    // the deny-set is checked before grants are resolved.
    withGrants(storage, [grant({ grantId: "grant-allow", toolPattern: "git.commit", decision: "allow" })]);
    const engine = new ToolPolicyEngine(
      { ...baseConfig, tools: { ...baseConfig.tools, deny: ["git.*"] } },
      storage,
    );

    const evaluation = engine.evaluateAccess({ ...baseRequest, toolName: "git.commit", args: {} });

    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasonCodes).toContain("policy_deny");
    // The deny-set short-circuits before a grant is ever matched.
    expect(evaluation.matchedGrantId).toBeUndefined();
  });

  it("a matching allow-grant suppresses the approval a bare danger tool would otherwise need", () => {
    const storage = createStorageStub();
    withGrants(storage, [grant({ grantId: "grant-allow-commit", toolPattern: "git.commit", decision: "allow" })]);
    const engine = new ToolPolicyEngine(baseConfig, storage);

    const granted = engine.evaluateAccess({ ...baseRequest, toolName: "git.commit", args: {} });
    expect(granted.allowed).toBe(true);
    expect(granted.matchedGrantId).toBe("grant-allow-commit");

    // Control: the same danger tool WITHOUT a grant requires approval under approve_risky.
    const ungranted = createStorageStub();
    const ungrantedEngine = new ToolPolicyEngine(baseConfig, ungranted);
    const ungrantedEval = ungrantedEngine.evaluateAccess({ ...baseRequest, toolName: "git.commit", args: {} });
    expect(ungrantedEval.requiresApproval).toBe(true);
    expect(ungrantedEval.matchedGrantId).toBeUndefined();
  });
});
