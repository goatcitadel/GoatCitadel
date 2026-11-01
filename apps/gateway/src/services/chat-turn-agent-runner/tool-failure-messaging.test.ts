import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  MEMORY_CONSENT_BLOCKED_REASON,
  answerCoversMemoryConsentBlocks,
  buildGovernanceBlockGuidance,
  buildMemoryConsentBlockGuidance,
  buildPathBridgeFailureGuidance,
  buildPolicyBlockedRecoveryText,
  buildToolFailureAppendixText,
  isRecoveredWebReadFailure,
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

  it("treats a switched-off web or browser run as a policy block, not a web failure", () => {
    for (const run of [
      toolRun({
        toolName: "browser.search",
        error: "blocked: tool browser.search is in a tool group switched off by the operator (Web search)",
      }),
      toolRun({
        toolName: "http.get",
        error: "Current deny-wins policy blocks http.get.",
        result: { policyRevalidation: { status: "blocked", reasonCodes: ["tool_group_off"] } },
      }),
    ]) {
      const text = buildToolFailureAppendixText([run]);

      expect(text, run.toolName).toContain("was blocked by policy");
      expect(text, run.toolName).not.toMatch(/failed while I was working|URL|narrower query/);
    }
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

  it("tells the model a switched-off group is the operator's switch, not tools.deny", () => {
    const guidance = buildGovernanceBlockGuidance({
      toolName: "channel.send",
      status: "blocked",
      error: "blocked: tool channel.send is in a tool group switched off by the operator (Messaging)",
    });

    expect(guidance).toContain("channel.send is switched off");
    expect(guidance).toContain("Capabilities › Tools");
    expect(guidance).toContain("Only the operator can switch that group back on");
    expect(guidance).toMatch(/not a pending approval/i);
    expect(guidance).not.toContain("tools.deny");
    expect(guidance).not.toMatch(RETRY_INVITATION);
  });

  it("recognises a switched-off group from the run's policy revalidation reason codes", () => {
    // The Chat runner re-probes before the call and writes its own error, so the engine's sentence never reaches it.
    for (const error of [
      "Current deny-wins policy blocks channel.send.",
      "Current deny-wins policy narrowed channel.send after capability admission.",
      "Capability profile profile-1 does not authorize channel.send.",
    ]) {
      const guidance = buildGovernanceBlockGuidance({
        toolName: "channel.send",
        status: "blocked",
        error,
        result: { policyRevalidation: { status: "blocked", reasonCodes: ["tool_group_off"] } },
      });

      expect(guidance, error).toContain("channel.send is switched off");
      expect(guidance, error).toContain("Capabilities › Tools");
      expect(guidance, error).not.toContain("tools.deny");
    }
  });

  it("keeps the tools.deny wording when the tool is denied as well as switched off", () => {
    // The engine reports policy_deny first for a denied tool, because switching the group on would not run it.
    const denied = buildGovernanceBlockGuidance({
      toolName: "fs.write",
      status: "blocked",
      error: "tool denied by policy",
    });
    expect(denied).toContain("tools.deny");
    expect(denied).not.toContain("switched off");

    expect(
      buildGovernanceBlockGuidance({
        toolName: "fs.write",
        status: "blocked",
        error: "Current deny-wins policy blocks fs.write.",
        result: { policyRevalidation: { status: "blocked", reasonCodes: ["policy_deny", "tool_group_off"] } },
      }),
    ).toBeUndefined();
  });

  it("ignores revalidation reason codes that are not about a switched-off group, and malformed ones", () => {
    for (const result of [
      { policyRevalidation: { status: "blocked", reasonCodes: ["current_deny"] } },
      { policyRevalidation: { status: "blocked", reasonCodes: "tool_group_off" } },
      { policyRevalidation: "tool_group_off" },
      {},
    ]) {
      expect(
        buildGovernanceBlockGuidance({
          toolName: "channel.send",
          status: "blocked",
          error: "Current deny-wins policy blocks channel.send.",
          result,
        }),
      ).toBeUndefined();
    }
  });

  it("gives no switched-off guidance to a run that settled as failed", () => {
    expect(
      buildGovernanceBlockGuidance({
        toolName: "channel.send",
        status: "failed",
        error: "tool channel.send is in a tool group switched off by the operator (Messaging)",
      }),
    ).toBeUndefined();
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

  it("sends the operator to Capabilities › Tools, not Settings > Tools, when every block is a switched-off group", () => {
    const text = buildPolicyBlockedRecoveryText([
      toolRun({
        toolName: "channel.send",
        error: "blocked: tool channel.send is in a tool group switched off by the operator (Messaging)",
      }),
      toolRun({
        toolRunId: "run-2",
        toolName: "channel.react",
        error: "Current deny-wins policy blocks channel.react.",
        result: { policyRevalidation: { status: "blocked", reasonCodes: ["tool_group_off"] } },
      }),
    ]);

    expect(text).toContain("channel.send is switched off");
    expect(text).toContain("channel.react is switched off");
    expect(text).toContain("switch tool groups back on in Capabilities › Tools");
    expect(text).not.toContain("Settings > Tools");
    expect(text).not.toContain("tools.deny");
  });

  it("sends the operator to Capabilities › Tools for a switched-off web or browser tool too", () => {
    const text = buildPolicyBlockedRecoveryText([
      toolRun({
        toolName: "browser.interact",
        error: "blocked: tool browser.interact is in a tool group switched off by the operator (Browser)",
      }),
    ]);

    expect(text).toContain("browser.interact is switched off");
    expect(text).toContain("switch tool groups back on in Capabilities › Tools");
    expect(text).not.toMatch(/narrower|specific URL/i);
  });

  it("keeps the Settings > Tools pointer when a switched-off block is mixed with another policy block", () => {
    const text = buildPolicyBlockedRecoveryText([
      toolRun({
        toolName: "channel.send",
        error: "tool channel.send is in a tool group switched off by the operator (Messaging)",
      }),
      toolRun({ toolRunId: "run-2", toolName: "fs.delete", error: "tool denied by policy" }),
    ]);

    expect(text).toContain("Settings > Tools");
    expect(text).toContain("channel.send is switched off");
    expect(text).toContain("tools.deny");
  });

  it("says plainly that nothing was saved when a memory write fails before storing anything (#566, #571)", () => {
    // memory.write is all-or-nothing since #571, so an error it raises means no part of the note was kept.
    const text = buildPolicyBlockedRecoveryText([
      toolRun({ toolName: "memory.write", status: "failed", error: "execution error: content is required" }),
    ]);

    expect(text).toContain("I didn't save that to memory");
    expect(text).toContain("content is required");
    expect(text).toContain("Nothing was saved");
    expect(text).not.toMatch(/part of it may|sticking point|narrower|specific URL|keep going/i);
  });

  it("stays cautious unless the error is known to come before any write (#575)", () => {
    // Review on #575: audit persistence runs after the tool commits, so only a known pre-write error (a missing
    // required argument) proves nothing was kept; anything else may have failed after the note was stored.
    for (const error of [
      "tool timed out after 30000ms",
      "execution aborted by caller",
      "execution error: EACCES: permission denied, open audit.log",
    ]) {
      const text = buildPolicyBlockedRecoveryText([toolRun({ toolName: "memory.upsert", status: "failed", error })]);

      expect(text, error).toContain("can't confirm");
      expect(text, error).toContain("Library > Memory");
      expect(text, error).not.toMatch(/nothing was saved/i);
    }
  });

  it("leaves a memory write failure mixed with other tool failures to the general message", () => {
    expect(
      buildPolicyBlockedRecoveryText([
        toolRun({ toolName: "memory.write", status: "failed", error: "execution error: namespace is required" }),
        toolRun({ toolRunId: "run-2", toolName: "browser.search", status: "failed", error: "timeout" }),
      ]),
    ).toBeUndefined();
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

    expect(guidance).toContain("user's own message uses an accepted consent phrasing");
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

describe("buildPolicyBlockedRecoveryText path-bridge blocks", () => {
  function pathBridgeRun(reasonCode: string, overrides: Partial<ChatToolRunRecord> = {}): ChatToolRunRecord {
    return toolRun({
      toolName: "shell.exec",
      args: { command: "git status", cwd: "/work/repo" },
      error: PATH_BRIDGE_REASON,
      result: { workspacePathBridge: { status: "blocked", reasonCode, snapshotId: "snap-1" } },
      ...overrides,
    });
  }

  it("keeps the repair guidance for a repairable reason instead of blaming tool policy", () => {
    const text = buildPolicyBlockedRecoveryText([pathBridgeRun("invalid_path")]);

    expect(text).toContain("I stopped instead of retrying shell.exec.");
    expect(text).toContain("Retry with an absolute folder path inside the workspace.");
    expect(text).not.toMatch(/tool policy|Settings > Tools|not caused by the input/i);
  });

  it("names missing Git as the thing to repair", () => {
    const text = buildPolicyBlockedRecoveryText([pathBridgeRun("git_unavailable")]);

    expect(text).toContain("Install or repair Git on the Gateway host");
    expect(text).not.toMatch(/tool policy|Settings > Tools/i);
  });

  it("explains a jail boundary as fixed", () => {
    const text = buildPolicyBlockedRecoveryText([pathBridgeRun("outside_jail")]);

    expect(text).toContain("outside the workspace folders");
    expect(text).not.toMatch(/Settings > Tools/i);
  });

  it("leaves path-bridge blocks mixed with policy blocks to the generic recovery text", () => {
    expect(
      buildPolicyBlockedRecoveryText([
        pathBridgeRun("invalid_path"),
        toolRun({ toolRunId: "run-2", toolName: "fs.delete", error: "blocked: tool denied by policy" }),
      ]),
    ).toBeUndefined();
  });
});

describe("memory-consent appendix", () => {
  const consentRun = toolRun({ toolName: "memory.write", error: MEMORY_CONSENT_BLOCKED_REASON });

  it("gives a consent note instead of the policy appendix", () => {
    const text = buildToolFailureAppendixText([consentRun]);

    expect(text).toContain("Note: nothing was saved to memory.");
    expect(text).toContain('"Remember that …"');
    expect(text).not.toMatch(/blocked by policy|keep going|narrower/i);
  });

  it("treats an answer that already talks about memory as covering consent-only blocks", () => {
    expect(answerCoversMemoryConsentBlocks("I didn't save that to memory.", [consentRun])).toBe(true);
    expect(answerCoversMemoryConsentBlocks("Your favourite colour is teal.", [consentRun])).toBe(false);
    expect(
      answerCoversMemoryConsentBlocks("I didn't save that to memory.", [
        consentRun,
        toolRun({ toolRunId: "run-2", toolName: "fs.delete", error: "blocked: tool denied by policy" }),
      ]),
    ).toBe(false);
  });
});

describe("buildPolicyBlockedRecoveryText guidance for several blocks", () => {
  it("keeps the guidance for every distinct governance block", () => {
    const text = buildPolicyBlockedRecoveryText([
      toolRun({ toolName: "fs.delete", error: "blocked: tool denied by policy" }),
      toolRun({ toolRunId: "run-2", toolName: "memory.write", error: "blocked: denied by a Citadel Ward" }),
      toolRun({ toolRunId: "run-3", toolName: "fs.delete", error: "blocked: tool denied by policy" }),
    ]);

    expect(text).toContain("tool policy blocked fs.delete, memory.write.");
    expect(text).toContain("Why: fs.delete is denied by the operator's tool policy.");
    expect(text).toContain("Why: memory.write is denied by a Citadel Ward.");
    expect(text?.match(/Why: fs\.delete/g)).toHaveLength(1);
  });
});

describe("isRecoveredWebReadFailure", () => {
  const blockedPage = toolRun({ toolRunId: "gallup", toolName: "browser.navigate", status: "failed" });
  const skippedHost = toolRun({ toolRunId: "skip", toolName: "browser.navigate", status: "blocked" });
  const readPage = toolRun({
    toolRunId: "adp",
    toolName: "browser.navigate",
    status: "executed",
    result: { url: "https://www.adpresearch.com/a", textSnippet: "People are working less. Who and why? ".repeat(4) },
  });
  const search = toolRun({ toolRunId: "search", toolName: "browser.search", status: "executed" });

  it("treats failed web reads as recovered once another page in the turn was read", () => {
    const runs = [search, blockedPage, skippedHost, readPage];

    expect(isRecoveredWebReadFailure(blockedPage, runs)).toBe(true);
    expect(isRecoveredWebReadFailure(skippedHost, runs)).toBe(true);
  });

  it("keeps the failure when no page was read, or the failure is not a web lookup or is a switched-off group", () => {
    const shell = toolRun({ toolRunId: "shell", toolName: "shell.exec", status: "blocked" });
    const post = toolRun({ toolRunId: "post", toolName: "http.post", status: "failed" });
    const click = toolRun({ toolRunId: "click", toolName: "browser.interact", status: "failed" });
    const switchedOff = toolRun({
      toolRunId: "off",
      toolName: "browser.navigate",
      status: "blocked",
      error: "blocked: tool group switched off",
      result: { policyRevalidation: { reasonCodes: ["tool_group_off"] } },
    });

    expect(isRecoveredWebReadFailure(blockedPage, [search, blockedPage])).toBe(false);
    expect(isRecoveredWebReadFailure(shell, [shell, readPage])).toBe(false);
    // A failed web action is not recovered by reading another page.
    expect(isRecoveredWebReadFailure(post, [post, readPage])).toBe(false);
    expect(isRecoveredWebReadFailure(click, [click, readPage])).toBe(false);
    expect(isRecoveredWebReadFailure(switchedOff, [switchedOff, readPage])).toBe(false);
  });

  it("keeps the failure when the only other read returned no page text, or policy denied the lookup", () => {
    const urlOnly = toolRun({
      toolRunId: "url-only",
      toolName: "browser.navigate",
      status: "executed",
      result: { url: "https://example.com/empty", finalUrl: "https://example.com/empty" },
    });
    const denied = toolRun({
      toolRunId: "denied",
      toolName: "browser.navigate",
      status: "blocked",
      error: "Current deny-wins policy blocks browser.navigate.",
      result: { policyRevalidation: { reasonCodes: ["policy_deny"] } },
    });

    expect(isRecoveredWebReadFailure(blockedPage, [blockedPage, urlOnly])).toBe(false);
    expect(isRecoveredWebReadFailure(denied, [denied, readPage])).toBe(false);
  });
});
