import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { buildPathBridgeFailureGuidance, buildToolFailureAppendixText } from "./tool-failure-messaging.js";

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
    expect(guidance).toMatch(/not a pending approval/i);
    expect(guidance).not.toMatch(/narrower|URL/i);
  });

  it("recognizes the path-bridge block from the policy reason alone", () => {
    const guidance = buildPathBridgeFailureGuidance({ error: PATH_BRIDGE_REASON });

    expect(guidance).toMatch(/could not be verified/i);
    expect(guidance).not.toMatch(/narrower|URL/i);
  });

  it("names a non-jail reason code without calling it outside the workspace", () => {
    const guidance = buildPathBridgeFailureGuidance({
      args: { cwd: "C:\\repo\\linked" },
      result: { workspacePathBridge: { status: "blocked", reasonCode: "symlink_escape" } },
      error: PATH_BRIDGE_REASON,
    });

    expect(guidance).toContain("symlink escape");
    expect(guidance).not.toContain("outside the workspace folders");
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
