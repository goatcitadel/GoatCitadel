import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { summarizeTurnToolRuns, toolRunTarget } from "./chat-tool-run-summary";
import { summarizeShellCommand } from "./summarize-shell-command";
import {
  countLineChanges,
  countUnifiedDiffChanges,
  toolRunDuration,
  toolRunLineChanges,
} from "./chat-tool-run-change-stats";

const run = (toolName: string, args: Record<string, unknown> = {}, status: ChatToolRunRecord["status"] = "executed") =>
  ({
    toolRunId: `${toolName}-${JSON.stringify(args)}`,
    turnId: "t",
    sessionId: "s",
    toolName,
    status,
    args,
    startedAt: "2026-10-28T00:00:00.000Z",
    finishedAt: "2026-10-28T00:00:02.000Z",
  }) as ChatToolRunRecord;

describe("summarizeShellCommand", () => {
  it.each([
    ["cd app && FOO=1 pnpm test 2>&1 | tail -20", "pnpm test"],
    ['pnpm lint; echo "lint_exit=$?"', "pnpm lint"],
    ["cd app && pnpm lint && pnpm test && pnpm build", "pnpm lint + 2 commands"],
    ["git status", "git status"],
    ['grep -n "a && b" file.txt', 'grep -n "a && b" file.txt'],
  ])("reads %j as %j", (command, expected) => {
    expect(summarizeShellCommand(command)).toBe(expected);
  });
});

describe("toolRunTarget", () => {
  it("names a file, a command, a query and a host", () => {
    expect(toolRunTarget(run("fs.patch", { path: "C:\\repo\\src\\hero.css" }))?.label).toBe("hero.css");
    expect(toolRunTarget(run("fs.move", { from: "src/a.ts", to: "src/b.ts" }))?.label).toBe("a.ts");
    expect(toolRunTarget(run("shell.exec", { command: "cd app && pnpm test | tail -5" }))).toEqual({
      label: "pnpm test",
      full: "cd app && pnpm test | tail -5",
      kind: "command",
    });
    expect(toolRunTarget(run("browser.search", { query: "goat cheese" }))?.label).toBe("“goat cheese”");
    expect(toolRunTarget(run("browser.navigate", { url: "https://example.com/docs?x=1" }))?.label).toBe("example.com");
  });

  it("names nothing it cannot read safely", () => {
    expect(toolRunTarget(run("browser.navigate", { url: "javascript:alert(1)" }))).toBeUndefined();
    expect(toolRunTarget(run("tests.run"))).toBeUndefined();
    expect(toolRunTarget(run("fs.read", { path: 42 }))).toBeUndefined();
  });
});

describe("summarizeTurnToolRuns", () => {
  it("names a single target and counts the rest, in a fixed order", () => {
    const runs = [
      run("shell.exec", { command: "pnpm test" }),
      run("fs.read", { path: "a.ts" }),
      run("fs.read", { path: "b.ts" }),
      run("fs.patch", { path: "src/hero.css" }),
      run("shell.exec", { command: "pnpm lint" }, "failed"),
    ];
    expect(summarizeTurnToolRuns(runs, false)).toBe(
      "Changed hero.css, explored 2 files, ran 1 command, tried to run pnpm lint",
    );
  });

  it("speaks in the present tense for the call in progress", () => {
    const runs = [run("fs.read", { path: "a.ts" }), run("shell.exec", { command: "cd x && pnpm build" }, "started")];
    expect(summarizeTurnToolRuns(runs, true)).toBe("Explored a.ts, running pnpm build");
  });

  it("never describes a call that did not run as done", () => {
    expect(summarizeTurnToolRuns([run("fs.delete", { path: "important.txt" }, "blocked")], false)).toBe(
      "Tried to change important.txt",
    );
    expect(summarizeTurnToolRuns([run("slack.send", {}, "approval_required")], false)).toBe(
      "Awaiting approval to send 1 message",
    );
    // Recorded effect truth wins over status for calls whose point is an outside effect.
    expect(
      summarizeTurnToolRuns([{ ...run("slack.send", {}), effectOutcomeKind: "uncertain" } as ChatToolRunRecord], false),
    ).toBe("May have sent 1 message");
    expect(
      summarizeTurnToolRuns(
        [{ ...run("fs.delete", { path: "x.txt" }, "failed"), effectOutcomeKind: "uncertain" } as ChatToolRunRecord],
        false,
      ),
    ).toBe("May have changed x.txt");
    expect(
      summarizeTurnToolRuns(
        [{ ...run("fs.patch", { path: "a.css" }), effectOutcomeKind: "none" } as ChatToolRunRecord],
        false,
      ),
    ).toBe("Tried to change a.css");
    // A call a settled turn left unfinished did not happen either.
    expect(summarizeTurnToolRuns([run("fs.patch", { path: "a.css" }, "started")], false)).toBe("Tried to change a.css");
    // A Code Mode request settles as executed even when its code failed; its result says so.
    expect(
      summarizeTurnToolRuns(
        [
          {
            ...run("code_mode.request"),
            result: { status: "failed", error: "Code Mode is off." },
          } as ChatToolRunRecord,
        ],
        false,
      ),
    ).toBe("Tried to use 1 tool");
  });
});

describe("tool run change stats", () => {
  it("counts changed lines between old and new text", () => {
    expect(countLineChanges("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    expect(countLineChanges("", "one\ntwo")).toEqual({ added: 2, removed: 0 });
  });

  it("counts a unified diff without its file headers", () => {
    expect(countUnifiedDiffChanges("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n same")).toEqual({
      added: 2,
      removed: 1,
    });
  });

  it("counts hunk lines that look like file headers, across several hunks", () => {
    const diff = [
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,2 +1,2 @@",
      "--- old note",
      "+++ new note",
      " kept",
      "@@ -9 +9,0 @@",
      "-gone",
      "\\ No newline at end of file",
    ].join("\n");
    expect(countUnifiedDiffChanges(diff)).toEqual({ added: 1, removed: 2 });
  });

  it("reports changes only for an edit that ran", () => {
    const patch = { path: "x.css", oldText: "a {}\n", newText: "a { color: red; }\nb {}\n" };
    expect(toolRunLineChanges(run("fs.patch", patch))).toEqual({ added: 2, removed: 1 });
    expect(toolRunLineChanges(run("fs.patch", patch, "failed"))).toBeUndefined();
    expect(toolRunLineChanges(run("fs.read", { path: "x.css" }))).toBeUndefined();
  });

  it("formats a finished call's duration and nothing for an unfinished one", () => {
    expect(toolRunDuration(run("fs.read"))).toBe("2 s");
    expect(toolRunDuration(run("fs.read", {}, "failed"))).toBe("2 s");
    expect(toolRunDuration({ status: "executed", startedAt: "2026-10-28T00:00:00.000Z" })).toBeUndefined();
  });

  it("shows no duration for a call that waited on approval or has not run", () => {
    // Waiting: the recorded finish is the pause, not the work.
    expect(toolRunDuration({ ...run("fs.write", {}, "approval_required"), approvalId: "a-1" })).toBeUndefined();
    // Approved and run: the span includes the wait for the operator.
    expect(toolRunDuration({ ...run("fs.write"), approvalId: "a-1" })).toBeUndefined();
    expect(toolRunDuration(run("fs.delete", {}, "blocked"))).toBeUndefined();
  });
});
