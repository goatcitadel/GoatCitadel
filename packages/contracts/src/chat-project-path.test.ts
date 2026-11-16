import { describe, expect, it } from "vitest";
import { PROJECT_WORKSPACE_PATH_RULE, projectWorkspacePathProblem } from "./chat.js";

describe("projectWorkspacePathProblem", () => {
  it.each([
    "/absolute",
    "../escape",
    "..",
    "safe/../escape",
    "safe/..",
    "C:/Windows/Temp/x",
    "C:\\x",
    "c:x",
    "\\\\server\\share",
  ])("refuses %s with the plain rule", (value) => {
    expect(projectWorkspacePathProblem(value)).toBe(PROJECT_WORKSPACE_PATH_RULE);
  });

  it.each(["repo", "nested/repo", "nested\\repo", "a..b/c", "  projects/website  "])("accepts %s", (value) => {
    expect(projectWorkspacePathProblem(value)).toBeUndefined();
  });

  it("leaves an empty value to the required check", () => {
    expect(projectWorkspacePathProblem("   ")).toBeUndefined();
  });
});
