import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  buildAnswerRecoveryNudge,
  buildDegradedAnswerFooter,
  buildFailedFileMutationsFooter,
  classifyAnswerGap,
  collectFailedFileMutations,
} from "./chat-agent-answer-recovery.js";

function toolRun(overrides: Partial<ChatToolRunRecord>): ChatToolRunRecord {
  return {
    toolRunId: overrides.toolRunId ?? "run-1",
    turnId: "turn-1",
    sessionId: "sess-1",
    toolName: overrides.toolName ?? "fs.write",
    status: overrides.status ?? "executed",
    startedAt: "2026-06-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("classifyAnswerGap", () => {
  it("returns none when visible text is present regardless of other signals", () => {
    expect(
      classifyAnswerGap({ hasVisibleText: true, hasReasoningText: true, toolCallCount: 3 }),
    ).toBe("none");
  });

  it("prefers tool_use_without_answer when tool calls exist and no visible text", () => {
    expect(
      classifyAnswerGap({ hasVisibleText: false, hasReasoningText: true, toolCallCount: 2 }),
    ).toBe("tool_use_without_answer");
  });

  it("returns reasoning_only when reasoning exists but no tools and no visible text", () => {
    expect(
      classifyAnswerGap({ hasVisibleText: false, hasReasoningText: true, toolCallCount: 0 }),
    ).toBe("reasoning_only");
  });

  it("returns empty when nothing is present", () => {
    expect(
      classifyAnswerGap({ hasVisibleText: false, hasReasoningText: false, toolCallCount: 0 }),
    ).toBe("empty");
  });
});

describe("buildAnswerRecoveryNudge", () => {
  it("produces distinct, tool-less instructions per gap", () => {
    const reasoning = buildAnswerRecoveryNudge("reasoning_only");
    const toolUse = buildAnswerRecoveryNudge("tool_use_without_answer");
    const empty = buildAnswerRecoveryNudge("empty");

    expect(reasoning).not.toBe(toolUse);
    expect(toolUse).not.toBe(empty);
    expect(reasoning).not.toBe(empty);

    for (const nudge of [reasoning, toolUse, empty]) {
      expect(nudge.length).toBeGreaterThan(0);
      // Every nudge must forbid further tool use so it is a final synthesis pass.
      expect(nudge.toLowerCase()).toContain("tool");
      expect(nudge.toLowerCase()).toContain("answer");
    }
  });

  it("returns an empty string for the none gap", () => {
    expect(buildAnswerRecoveryNudge("none")).toBe("");
  });
});

describe("buildDegradedAnswerFooter", () => {
  it("returns empty when the answer was recovered cleanly by a model pass", () => {
    expect(buildDegradedAnswerFooter({ reason: "budget", recoveredByModel: true })).toBe("");
  });

  it("returns one calm sentence when not recovered", () => {
    const footer = buildDegradedAnswerFooter({ reason: "budget", recoveredByModel: false });
    expect(footer.length).toBeGreaterThan(0);
    expect(footer.split("\n")).toHaveLength(1);
    expect(footer.toLowerCase()).toContain("incomplete");
  });
});

describe("collectFailedFileMutations", () => {
  it("returns failed file-mutating runs with path and error", () => {
    const failures = collectFailedFileMutations([
      toolRun({ toolName: "fs.write", status: "failed", args: { path: "/a.txt" }, error: "disk full" }),
    ]);
    expect(failures).toEqual([{ toolName: "fs.write", path: "/a.txt", error: "disk full" }]);
  });

  it("ignores read-only file tools and non-file tools", () => {
    const failures = collectFailedFileMutations([
      toolRun({ toolName: "fs.read", status: "failed", args: { path: "/a.txt" }, error: "nope" }),
      toolRun({ toolName: "browser.search", status: "failed", args: { query: "x" }, error: "nope" }),
      toolRun({ toolName: "code.search", status: "failed", args: { path: "/", query: "x" }, error: "nope" }),
    ]);
    expect(failures).toEqual([]);
  });

  it("suppresses a failure that a later successful write to the same path superseded", () => {
    const failures = collectFailedFileMutations([
      toolRun({
        toolRunId: "r1",
        toolName: "fs.write",
        status: "failed",
        args: { path: "/a.txt" },
        error: "transient",
      }),
      toolRun({ toolRunId: "r2", toolName: "fs.write", status: "executed", args: { path: "/a.txt" } }),
    ]);
    expect(failures).toEqual([]);
  });

  it("still reports a failure when only a different path later succeeded", () => {
    const failures = collectFailedFileMutations([
      toolRun({
        toolRunId: "r1",
        toolName: "fs.write",
        status: "failed",
        args: { path: "/a.txt" },
        error: "transient",
      }),
      toolRun({ toolRunId: "r2", toolName: "fs.write", status: "executed", args: { path: "/b.txt" } }),
    ]);
    expect(failures).toEqual([{ toolName: "fs.write", path: "/a.txt", error: "transient" }]);
  });

  it("reports blocked file mutations with a policy message and resolves move target paths", () => {
    const failures = collectFailedFileMutations([
      toolRun({ toolName: "fs.move", status: "blocked", args: { path: "/a.txt", targetPath: "/b.txt" } }),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.toolName).toBe("fs.move");
    expect(failures[0]?.path).toBe("/a.txt");
    expect(failures[0]?.error.toLowerCase()).toContain("blocked");
  });

  it("reports failures with no resolvable path (cannot be proven superseded)", () => {
    const failures = collectFailedFileMutations([
      toolRun({ toolName: "documents.create", status: "failed", args: {}, error: "render failed" }),
    ]);
    expect(failures).toEqual([{ toolName: "documents.create", error: "render failed" }]);
  });

  it("does not mutate the input array", () => {
    const input = [toolRun({ toolName: "fs.write", status: "failed", args: { path: "/a.txt" }, error: "x" })];
    const snapshot = [...input];
    collectFailedFileMutations(input);
    expect(input).toEqual(snapshot);
  });
});

describe("buildFailedFileMutationsFooter", () => {
  it("returns empty when there are no failures", () => {
    expect(buildFailedFileMutationsFooter([])).toBe("");
  });

  it("renders a singular heading and the failed mutations", () => {
    const footer = buildFailedFileMutationsFooter([{ toolName: "fs.write", path: "/a.txt", error: "disk full" }]);
    expect(footer).toContain("One file change did not complete:");
    expect(footer).toContain("`fs.write` `/a.txt`: disk full");
  });

  it("renders a count heading for multiple failures", () => {
    const footer = buildFailedFileMutationsFooter([
      { toolName: "fs.write", path: "/a.txt", error: "disk full" },
      { toolName: "fs.delete", error: "missing" },
    ]);
    expect(footer).toContain("2 file changes did not complete:");
  });
});
