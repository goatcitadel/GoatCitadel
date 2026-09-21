import { describe, expect, it } from "vitest";
import { isOpenCodeJsonInvocation, parseOpenCodeRunOutput, readOpenCodeRunSummary } from "./opencode.js";

const event = (type: string, part: unknown, extra = {}) =>
  JSON.stringify({ type, sessionID: "ses_demo", part, ...extra });
const patch = "--- a/retry.ts\n+++ b/retry.ts\n@@ -1 +1 @@\n-return false;\n+return true;";
const tool = (
  status = "completed",
  metadata: unknown = { filediff: { file: "retry.ts", patch, additions: 1, deletions: 1 } },
) => ({
  type: "tool",
  callID: "call_edit",
  tool: "edit",
  state: {
    status,
    title: "retry.ts",
    input: { filePath: "retry.ts" },
    metadata,
    error: status === "error" ? "Permission rejected" : undefined,
  },
});

describe("OpenCode output projection", () => {
  it("retains ordered structured reports without treating them as verified effects", () => {
    const result = parseOpenCodeRunOutput(
      [
        event("step_start", { type: "step-start" }),
        event("tool_use", tool()),
        event("text", { type: "text", text: "Updated the retry logic." }),
        event("step_finish", { type: "step-finish", reason: "stop" }),
      ].join("\n"),
    );
    expect(result).toMatchObject({
      sessionId: "ses_demo",
      text: "Updated the retry logic.",
      finishReason: "stop",
      truncated: false,
    });
    expect(result?.steps).toHaveLength(1);
    expect(result?.files).toEqual([{ path: "retry.ts", patch, additions: 1, deletions: 1, truncated: false }]);
    expect(result).not.toHaveProperty("success");
  });

  it("does not promote errors, proposed edits, or unrelated session events to file changes", () => {
    const result = parseOpenCodeRunOutput(
      [
        event("tool_use", tool("error")),
        event("tool_use", tool("running")),
        event("tool_use", tool(), { sessionID: "ses_other" }),
        event("error", undefined, { error: { name: "APIError", data: { message: "Provider unavailable" } } }),
      ].join("\n"),
    );
    expect(result?.files).toEqual([]);
    expect(result?.error).toBe("Provider unavailable");
    expect(result?.truncated).toBe(true);
  });

  it("deduplicates tool completions and bounds file patches, tool counts, and malformed output", () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      event("tool_use", {
        ...tool(),
        callID: `call_${i}`,
        state: { ...tool().state, metadata: { files: [{ filePath: `file-${i}.ts`, patch: "x".repeat(5000) }] } },
      }),
    );
    const result = parseOpenCodeRunOutput([...lines, lines[0], "{incomplete"].join("\n"));
    expect(result?.steps).toHaveLength(12);
    expect(result?.files).toHaveLength(6);
    expect(result?.files[0]?.patch).toHaveLength(1200);
    expect(result?.files[0]?.truncated).toBe(true);
    expect(result?.truncated).toBe(true);
    expect(JSON.stringify(readOpenCodeRunSummary(result)).length).toBeLessThan(12000);
  });

  it("ignores non-protocol content and does not render private reasoning", () => {
    expect(parseOpenCodeRunOutput("ordinary command output")).toBeUndefined();
    expect(parseOpenCodeRunOutput(event("reasoning", { text: "private reasoning" }))).toBeUndefined();
    expect(readOpenCodeRunSummary({ engine: "opencode", version: 1, steps: "bad", files: [] })).toBeUndefined();
  });

  it("identifies only direct JSON runs, with Windows paths and explicit argument terminators", () => {
    expect(
      isOpenCodeJsonInvocation("C:\\Program Files\\OpenCode\\opencode.exe", ["run", "--format", "json", "--", "task"]),
    ).toBe(true);
    expect(isOpenCodeJsonInvocation("opencode", ["run", "--format=json", "task"])).toBe(true);
    expect(isOpenCodeJsonInvocation("echo", ["run", "--format=json", "opencode"])).toBe(false);
    expect(isOpenCodeJsonInvocation("opencode", ["run", "--", "--format", "json"])).toBe(false);
  });
});
