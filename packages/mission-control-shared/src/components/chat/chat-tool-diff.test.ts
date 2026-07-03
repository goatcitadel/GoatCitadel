import { describe, expect, it } from "vitest";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";

import { extractUnifiedDiffFromToolRun, parseUnifiedDiffLines } from "./chat-tool-diff";

function createToolRun(result: Record<string, unknown> | undefined): ChatToolRunRecord {
  return {
    toolRunId: "tool-1",
    turnId: "turn-1",
    sessionId: "session-1",
    toolName: "fs.patch",
    status: "executed",
    startedAt: "2026-05-15T00:00:00.000Z",
    finishedAt: "2026-05-15T00:00:01.000Z",
    result,
  };
}

const REALISTIC_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 function foo() {
-  return 1;
+  return 2;
+  // added a comment
 }
diff --git a/src/bar.ts b/src/bar.ts
index 3333333..4444444 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,2 +10,2 @@
-const bar = "old";
+const bar = "new";
`;

describe("extractUnifiedDiffFromToolRun", () => {
  it("detects a qualifying diff on result.patch", () => {
    const run = createToolRun({ patch: REALISTIC_DIFF });
    expect(extractUnifiedDiffFromToolRun(run)).toBe(REALISTIC_DIFF);
  });

  it("detects a qualifying diff on result.diff", () => {
    const run = createToolRun({ diff: REALISTIC_DIFF });
    expect(extractUnifiedDiffFromToolRun(run)).toBe(REALISTIC_DIFF);
  });

  it("detects a qualifying diff on result.unifiedDiff", () => {
    const run = createToolRun({ unifiedDiff: REALISTIC_DIFF });
    expect(extractUnifiedDiffFromToolRun(run)).toBe(REALISTIC_DIFF);
  });

  it("detects a qualifying full unified diff on result.output", () => {
    const run = createToolRun({ output: REALISTIC_DIFF });
    expect(extractUnifiedDiffFromToolRun(run)).toBe(REALISTIC_DIFF);
  });

  it("returns the first qualifying candidate when multiple fields are present", () => {
    const run = createToolRun({ patch: REALISTIC_DIFF, diff: "some other diff-shaped text" });
    expect(extractUnifiedDiffFromToolRun(run)).toBe(REALISTIC_DIFF);
  });

  it("does not match plain text with a stray '+ something' line and no hunk/file headers", () => {
    const plainText = [
      "Summary of changes:",
      "+ something was added here",
      "- something was removed there",
      "No headers of any kind in this blob.",
    ].join("\n");
    const run = createToolRun({ output: plainText });
    expect(extractUnifiedDiffFromToolRun(run)).toBeNull();
  });

  it("does not match a markdown bullet list", () => {
    const markdown = ["## Changes", "- Added feature X", "- Removed feature Y", "+ Bonus: also did Z"].join("\n");
    const run = createToolRun({ output: markdown });
    expect(extractUnifiedDiffFromToolRun(run)).toBeNull();
  });

  it("does not match text with only a hunk header but no file headers", () => {
    const hunkOnly = ["@@ -1,3 +1,4 @@", "+added line", "-removed line"].join("\n");
    const run = createToolRun({ output: hunkOnly });
    expect(extractUnifiedDiffFromToolRun(run)).toBeNull();
  });

  it("does not match text with file headers but no hunk header", () => {
    const headersOnly = ["--- a/file.ts", "+++ b/file.ts", "+added line", "-removed line"].join("\n");
    const run = createToolRun({ output: headersOnly });
    expect(extractUnifiedDiffFromToolRun(run)).toBeNull();
  });

  it("returns null when result is undefined", () => {
    const run = createToolRun(undefined);
    expect(extractUnifiedDiffFromToolRun(run)).toBeNull();
  });

  it("returns null when result is an empty object", () => {
    const run = createToolRun({});
    expect(extractUnifiedDiffFromToolRun(run)).toBeNull();
  });

  it("returns null when result has non-string candidate values", () => {
    const run = createToolRun({
      patch: 12345,
      diff: { nested: true },
      unifiedDiff: null,
      output: ["not", "a", "string"],
    });
    expect(extractUnifiedDiffFromToolRun(run)).toBeNull();
  });

  it("returns null when result is not an object (defensive against unknown/Record widening)", () => {
    const run = { ...createToolRun(undefined), result: "just a string" as unknown as Record<string, unknown> };
    expect(extractUnifiedDiffFromToolRun(run)).toBeNull();
  });
});

describe("parseUnifiedDiffLines", () => {
  it("classifies meta before add/del: '+++ b/x' and '--- a/x' are meta, not add/del", () => {
    const diff = ["--- a/x", "+++ b/x", "@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");
    const { lines } = parseUnifiedDiffLines(diff);
    expect(lines.map((line) => line.kind)).toEqual(["meta", "meta", "hunk", "del", "add"]);
  });

  it("classifies 'diff ' and 'index ' prefixed lines as meta", () => {
    const diff = ["diff --git a/x b/x", "index 111..222 100644", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b"].join(
      "\n",
    );
    const { lines } = parseUnifiedDiffLines(diff);
    expect(lines.map((line) => line.kind)).toEqual(["meta", "meta", "meta", "meta", "hunk", "del", "add"]);
  });

  it("classifies unprefixed lines as ctx (context)", () => {
    const diff = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " unchanged line", "-old", "+new"].join("\n");
    const { lines } = parseUnifiedDiffLines(diff);
    expect(lines.map((line) => line.kind)).toEqual(["meta", "meta", "hunk", "ctx", "del", "add"]);
  });

  it("preserves line text verbatim (including the leading +/-/space marker)", () => {
    const diff = ["@@ -1,1 +1,1 @@", "-old value", "+new value"].join("\n");
    const { lines } = parseUnifiedDiffLines(diff);
    expect(lines.map((line) => line.text)).toEqual(["@@ -1,1 +1,1 @@", "-old value", "+new value"]);
  });

  it("parses a realistic multi-file diff end to end", () => {
    const { lines, truncatedCount } = parseUnifiedDiffLines(REALISTIC_DIFF);
    expect(truncatedCount).toBe(0);
    const kinds = lines.map((line) => line.kind);
    expect(kinds[0]).toBe("meta"); // diff --git
    expect(kinds[1]).toBe("meta"); // index
    expect(kinds[2]).toBe("meta"); // ---
    expect(kinds[3]).toBe("meta"); // +++
    expect(kinds[4]).toBe("hunk"); // @@
    expect(kinds).toContain("add");
    expect(kinds).toContain("del");
    expect(kinds).toContain("ctx");
    // second file's headers must also classify as meta, not add/del
    const secondDiffGitIndex = lines.findIndex((line, index) => index > 4 && line.text.startsWith("diff --git"));
    expect(secondDiffGitIndex).toBeGreaterThan(4);
    expect(lines[secondDiffGitIndex]!.kind).toBe("meta");
    expect(lines[secondDiffGitIndex + 1]!.kind).toBe("meta"); // index
    expect(lines[secondDiffGitIndex + 2]!.kind).toBe("meta"); // ---
    expect(lines[secondDiffGitIndex + 3]!.kind).toBe("meta"); // +++
  });

  it("defaults maxLines to 400 and truncates beyond it", () => {
    const bodyLines = Array.from({ length: 500 }, (_, index) => `+line ${index}`);
    const diff = ["--- a/x", "+++ b/x", "@@ -1,500 +1,500 @@", ...bodyLines].join("\n");
    const { lines, truncatedCount } = parseUnifiedDiffLines(diff);
    expect(lines).toHaveLength(400);
    // total lines = 3 header/hunk lines + 500 body lines = 503; 503 - 400 = 103
    expect(truncatedCount).toBe(103);
  });

  it("honors an explicit maxLines override with correct truncatedCount", () => {
    const bodyLines = Array.from({ length: 20 }, (_, index) => `+line ${index}`);
    const diff = ["@@ -1,20 +1,20 @@", ...bodyLines].join("\n");
    const { lines, truncatedCount } = parseUnifiedDiffLines(diff, 5);
    expect(lines).toHaveLength(5);
    expect(truncatedCount).toBe(16); // 21 total lines - 5 = 16
  });

  it("reports truncatedCount 0 when the diff is exactly at maxLines", () => {
    const diff = ["@@ -1,1 +1,1 @@", "-a", "+b"].join("\n");
    const { lines, truncatedCount } = parseUnifiedDiffLines(diff, 3);
    expect(lines).toHaveLength(3);
    expect(truncatedCount).toBe(0);
  });

  it("returns an empty lines array and zero truncatedCount for an empty diff string", () => {
    const { lines, truncatedCount } = parseUnifiedDiffLines("");
    expect(lines).toEqual([{ kind: "ctx", text: "" }]);
    expect(truncatedCount).toBe(0);
  });
});
