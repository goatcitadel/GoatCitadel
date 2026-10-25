import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  MEMORY_CONSENT_BLOCKED_REASON,
  buildGovernanceBlockGuidance,
  buildMemoryConsentBlockGuidance,
  buildPathBridgeFailureGuidance,
  buildPolicyBlockedRecoveryText,
  buildToolFailureAppendixText,
} from "./tool-failure-messaging.js";

const PATH_BRIDGE_REASON = "blocked: workspace path was not freshly verified for execution";

function toolRun(overrides: Partial<ChatToolRunRecord>): ChatToolRunRecord {
  return {
    toolRunId: "run-1",
    turnId: "turn-1",
    sessionId: "sess-1",
    toolName: "shell.exec_background",
    status: "blocked",
    startedAt: "2026-10-15T18:53:41.170Z",
    ...overrides,
  } as ChatToolRunRecord;
}

describe("buildPathBridgeFailureGuidance", () => {
  it("explains an outside_jail block as a fixed boundary naming the working folder", () => {
    const guidance = buildPathBridgeFailureGuidance({
      args: { command: "Remove-Item ...", cwd: "C:\\Users\\example" },
      result: { workspacePathBridge: { status: "blocked", reasonCode: "outside_jail", snapshotId: "snap-1" } },
      error: PATH_BRIDGE_REASON,
    });

    expect(guidance).toContain("C:\\Users\\example");
    expect(guidance).toContain("outside the workspace folders");
    expect(guidance).toContain("Path-bridge reason: outside_jail.");
    expect(guidance).toMatch(/not a pending approval/i);
    expect(guidance).not.toMatch(/narrower|URL/i);
  });

  it("points at bridge health, not a fixed boundary, when no reason code is reported", () => {
    const guidance = buildPathBridgeFailureGuidance({ error: PATH_BRIDGE_REASON });

    expect(guidance).toMatch(/could not be verified/i);
    expect(guidance).toContain("path-bridge health");
    expect(guidance).not.toMatch(/fixed execution boundary|narrower|URL/i);
  });

  it("treats a symlink escape as a fixed jail boundary", () => {
    const guidance = buildPathBridgeFailureGuidance({
      args: { cwd: "C:\\repo\\linked" },
      result: { workspacePathBridge: { status: "blocked", reasonCode: "symlink_escape" } },
      error: PATH_BRIDGE_REASON,
    });

    expect(guidance).toContain("resolves through a link");
    expect(guidance).toMatch(/fixed execution boundary/i);
    expect(guidance).toContain("Path-bridge reason: symlink_escape.");
  });

  it.each([
    ["wsl_unavailable", "WSL"],
    ["wsl_conversion_failed", "WSL"],
    ["git_unavailable", "Git is not available"],
    ["git_not_repository", "repository binding"],
    ["git_verification_failed", "repository binding"],
    ["git_identity_mismatch", "repository binding"],
    ["canonicalization_failed", "stable path"],
    ["round_trip_mismatch", "stable path"],
    ["invalid_path", "absolute folder path"],
  ])("gives repair guidance, not a fixed-boundary claim, for %s", (reasonCode, expected) => {
    const guidance = buildPathBridgeFailureGuidance({
      args: { cwd: "C:\\repo" },
      result: { workspacePathBridge: { status: "blocked", reasonCode } },
      error: PATH_BRIDGE_REASON,
    });

    expect(guidance).toContain(expected);
    expect(guidance).not.toMatch(/fixed execution boundary|outside the workspace folders|narrower|URL/i);
  });

  it("ignores failures that are not path-bridge blocks", () => {
    expect(buildPathBridgeFailureGuidance({ error: "network profile blocked browser.search" })).toBeUndefined();
    expect(
      buildPathBridgeFailureGuidance({ result: { workspacePathBridge: { status: "verified" } }, error: "boom" }),
    ).toBeUndefined();
  });
});

describe("buildToolFailureAppendixText", () => {
  it("does not suggest a URL or narrower query when only policy blocks occurred", () => {
    const text = buildToolFailureAppendixText([
      toolRun({ status: "blocked", failureGuidance: "The working folder is outside the workspace folders." }),
    ]);

    expect(text).toContain("Note: exec background was blocked by policy");
    expect(text).toContain("parts of this answer may be incomplete.");
    expect(text).toContain("Best next move: The working folder is outside the workspace folders.");
    expect(text).not.toMatch(/URL|narrower query/);
    expect(text).toContain('Say "keep going"');
  });

  it("keeps the URL/query hint for a failed run", () => {
    const text = buildToolFailureAppendixText([toolRun({ toolName: "browser.search", status: "failed" })]);

    expect(text).toContain("Note: search failed while I was working");
    expect(text).toContain("give me a specific URL or narrower query");
  });

  it("keeps the URL/query hint for a blocked web tool", () => {
    const text = buildToolFailureAppendixText([toolRun({ toolName: "browser.search", status: "blocked" })]);

    expect(text).toContain("give me a specific URL or narrower query");
  });

  it("treats a blocked docs.search as a policy block, not a web tool", () => {
    const text = buildToolFailureAppendixText([toolRun({ toolName: "docs.search", status: "blocked" })]);

    expect(text).toContain("Note: search was blocked by policy");
    expect(text).not.toMatch(/URL|narrower query/);
  });

  it("uses the multi-tool opening for several tools", () => {
    const text = buildToolFailureAppendixText([
      toolRun({ toolName: "shell.exec", status: "blocked" }),
      toolRun({ toolName: "fs.delete", status: "blocked" }),
    ]);

    expect(text).toContain("Note: a few tools were blocked by policy");
    expect(text).not.toMatch(/URL|narrower query/);
  });

  it("returns undefined when nothing failed", () => {
    expect(buildToolFailureAppendixText([])).toBeUndefined();
  });
});

describe("buildGovernanceBlockGuidance", () => {
  const RETRY_INVITATION = /narrower|more explicit input|safe fallback path|retry .* with/i;

  it("names sandbox.operatorWriteRoots for a write-jail block and does not suggest a fallback path", () => {
    const guidance = buildGovernanceBlockGuidance({
      toolName: "fs.delete",
      status: "blocked",
      error: "Path is outside write jail: C:\\Users\\example\\AppData\\Local\\Temp\\old.log",
    });

    expect(guidance).toContain("sandbox.operatorWriteRoots");
    expect(guidance).toContain("allowDelete");
    expect(guidance).toMatch(/not a pending approval/i);
    expect(guidance).not.toMatch(RETRY_INVITATION);
  });

  it("names tools.deny for a policy deny", () => {
    const guidance = buildGovernanceBlockGuidance({
      toolName: "fs.delete",
      status: "blocked",
      error: "tool denied by policy",
    });

    expect(guidance).toContain("tools.deny");
    expect(guidance).toContain("fs.delete");
    expect(guidance).toMatch(/operator must remove/i);
    expect(guidance).not.toMatch(RETRY_INVITATION);
  });

  it("names tools.allow and the permission profile when the tool is outside the resolved policy", () => {
    const guidance = buildGovernanceBlockGuidance({
      toolName: "shell.exec_background",
      status: "blocked",
      error: "tool not available in resolved policy",
    });

    expect(guidance).toContain("tools.allow");
    expect(guidance).toContain("profile's tool patterns");
    expect(guidance).toContain("tools.allow cannot lift a profile ceiling");
    expect(guidance).not.toMatch(RETRY_INVITATION);
  });

  it("names the Citadel Ward for a Ward deny", () => {
    const guidance = buildGovernanceBlockGuidance({
      toolName: "fs.write",
      status: "blocked",
      error: "tool fs.write denied by a Citadel Ward",
    });

    expect(guidance).toContain("Citadel Ward");
    expect(guidance).not.toMatch(RETRY_INVITATION);
  });

  it("keeps write-root guidance for a run that settled as failed", () => {
    const guidance = buildGovernanceBlockGuidance({
      toolName: "fs.write",
      status: "failed",
      error: "Path is outside write jail: /tmp/old.log",
    });

    expect(guidance).toContain("sandbox.operatorWriteRoots");
  });

  it("does not give policy-decision guidance to a run that settled as failed", () => {
    expect(
      buildGovernanceBlockGuidance({ toolName: "fs.delete", status: "failed", error: "tool denied by policy" }),
    ).toBeUndefined();
    expect(
      buildGovernanceBlockGuidance({
        toolName: "fs.delete",
        status: "failed",
        error: "tool not available in resolved policy",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for errors that are not governance blocks", () => {
    expect(
      buildGovernanceBlockGuidance({ toolName: "fs.read", status: "blocked", error: "ENOENT: no such file" }),
    ).toBeUndefined();
    expect(buildGovernanceBlockGuidance({ toolName: "fs.read", status: "blocked" })).toBeUndefined();
  });
});

describe("buildPolicyBlockedRecoveryText", () => {
  it("names the blocked tool and Settings > Tools without inviting a retry or echoing the raw reason", () => {
    const text = buildPolicyBlockedRecoveryText([
      toolRun({ toolName: "memory.write", error: "sandbox policy blocked memory.write" }),
      toolRun({ toolRunId: "run-2", toolName: "memory.write", error: "sandbox policy blocked memory.write" }),
    ]);

    expect(text).toContain("tool policy blocked memory.write.");
    expect(text).toContain("Settings > Tools");
    expect(text).not.toMatch(/narrower|specific URL|keep going/i);
    expect(text).not.toContain("sandbox policy blocked");
  });

  it("keeps setting-specific governance guidance for the last block", () => {
    const text = buildPolicyBlockedRecoveryText([toolRun({ toolName: "fs.delete", error: "tool denied by policy" })]);

    expect(text).toContain("Why: fs.delete is denied by the operator's tool policy.");
    expect(text).toContain("tools.deny");
  });

  it("explains a memory-consent block as a consent check, not tool policy or a bad input", () => {
    const text = buildPolicyBlockedRecoveryText([
      toolRun({ toolName: "memory.write", error: MEMORY_CONSENT_BLOCKED_REASON }),
      toolRun({ toolRunId: "run-2", toolName: "memory.write", error: MEMORY_CONSENT_BLOCKED_REASON }),
    ]);

    expect(text).toContain("I didn't save that to memory.");
    expect(text).toContain('"Remember that …"');
    expect(text).not.toMatch(/tool policy|Settings > Tools|narrower|specific URL/i);
  });

  it("leaves mixed consent and policy blocks, and other runner guards, to the generic recovery text", () => {
    expect(
      buildPolicyBlockedRecoveryText([
        toolRun({ toolName: "memory.write", error: MEMORY_CONSENT_BLOCKED_REASON }),
        toolRun({ toolRunId: "run-2", toolName: "memory.write", error: "blocked: tool denied by policy" }),
      ]),
    ).toBeUndefined();
    expect(
      buildPolicyBlockedRecoveryText([
        toolRun({
          toolName: "fs.search",
          error: "execution skipped: fs.search requires query; unable to infer a safe query from the prompt",
        }),
      ]),
    ).toBeUndefined();
  });

  it("leaves mixed failures, web tool blocks, and empty lists to the generic recovery text", () => {
    expect(
      buildPolicyBlockedRecoveryText([
        toolRun({ toolName: "memory.write", error: "blocked: tool denied by policy" }),
        toolRun({ toolRunId: "run-2", toolName: "fs.read", status: "failed", error: "ENOENT" }),
      ]),
    ).toBeUndefined();
    expect(
      buildPolicyBlockedRecoveryText([
        toolRun({ toolName: "browser.navigate", error: "blocked: host not allowlisted" }),
      ]),
    ).toBeUndefined();
    expect(buildPolicyBlockedRecoveryText([])).toBeUndefined();
  });
});

describe("buildMemoryConsentBlockGuidance", () => {
  it("tells the model the check reads the user's message, so a different input will not pass it", () => {
    const guidance = buildMemoryConsentBlockGuidance({ status: "blocked", error: MEMORY_CONSENT_BLOCKED_REASON });

    expect(guidance).toContain("user's own message explicitly asks for it");
    expect(guidance).toContain('a bare "yes" does not pass the check');
    expect(guidance).not.toMatch(/narrower, more explicit input/);
  });

  it("ignores other blocks and failed runs", () => {
    expect(
      buildMemoryConsentBlockGuidance({ status: "blocked", error: "blocked: tool denied by policy" }),
    ).toBeUndefined();
    expect(buildMemoryConsentBlockGuidance({ status: "failed", error: MEMORY_CONSENT_BLOCKED_REASON })).toBeUndefined();
  });
});
