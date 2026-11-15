import { describe, expect, it } from "vitest";
import { describeWorkbenchError } from "./workbench-error-copy";

describe("describeWorkbenchError", () => {
  it("explains a project folder that is not a git repository", () => {
    const text =
      'API error 400: {"error":"Command failed: git worktree add --detach C:\\runtime\\.worktrees\\s1 HEAD fatal: not a git repository (or any of the parent directories): .git"}';
    expect(describeWorkbenchError(text)).toEqual({
      summary:
        "This project's folder isn't a git repository, so the build editor can't make a worktree for it. Make the folder a git repository, then press Create worktree again.",
      technical: text,
    });
  });

  it("explains a missing git", () => {
    const result = describeWorkbenchError("spawn git ENOENT");
    expect(result.summary).toBe(
      "Git isn't installed on the computer running GoatCitadel, so the build editor can't make a worktree. Install git, then press Create worktree again.",
    );
    expect(result.technical).toBe("spawn git ENOENT");
  });

  it("describes other API errors through the shared copy", () => {
    expect(describeWorkbenchError('API error 409: {"error":"x"}').summary).toBe(
      "This changed somewhere else. Refresh and try again.",
    );
  });

  it("returns plain text unchanged without technical details", () => {
    expect(describeWorkbenchError("Choose a project first.")).toEqual({ summary: "Choose a project first." });
  });
});
