import { describe, expect, it } from "vitest";
import { describeWorkbenchError } from "./workbench-error-copy";

const creating = { worktreeCreation: true };

describe("describeWorkbenchError", () => {
  it("explains a project folder that is not a git repository", () => {
    const text =
      'API error 400: {"error":"Command failed: git worktree add --detach C:\\runtime\\.worktrees\\s1 HEAD fatal: not a git repository (or any of the parent directories): .git"}';
    expect(describeWorkbenchError(text, creating)).toEqual({
      summary:
        "This project's folder isn't a git repository, so the build editor can't make a worktree for it. Make the folder a git repository, then press Create worktree again.",
      technical: text,
    });
  });

  it.each([
    "spawn git ENOENT",
    "spawn git.exe ENOENT",
    "'git' is not recognized as an internal command",
    "git: command not found",
  ])("explains a missing git: %s", (text) => {
    const result = describeWorkbenchError(text, creating);
    expect(result.summary).toContain("Git isn't installed");
    expect(result.technical).toBe(text);
  });

  it("does not say git is missing when git reports a missing ref or path", () => {
    const text =
      'API error 400: {"error":"Command failed: git worktree add --detach C:\\x HEAD fatal: invalid reference: main not found"}';
    expect(describeWorkbenchError(text, creating).summary).not.toContain("Git isn't installed");
  });

  it("gives other actions the generic sentence for the same text", () => {
    const text = 'API error 400: {"error":"fatal: not a git repository"}';
    const result = describeWorkbenchError(text);
    expect(result.summary).not.toContain("worktree");
    expect(result.technical).toBe(text);
  });

  it("describes other API errors through the shared copy", () => {
    expect(describeWorkbenchError('API error 409: {"error":"x"}').summary).toBe(
      "This changed somewhere else. Refresh and try again.",
    );
  });

  it("keeps a raw command failure with a home path out of the sentence", () => {
    const text = "Command failed: git diff C:\\Users\\someone\\project\\src\\a.ts";
    const result = describeWorkbenchError(text);
    expect(result.summary).not.toContain("Users");
    expect(result.technical).toBe(text);
  });

  it("returns plain readable text unchanged", () => {
    expect(describeWorkbenchError("Choose a project first.")).toEqual({ summary: "Choose a project first." });
  });
});
