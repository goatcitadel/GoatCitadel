import { describe, expect, it } from "vitest";
import {
  buildPlainApprovedToolFailureText,
  describeFailureCause,
  redactLocalHomePaths,
} from "./user-facing-failure-text.js";

const winHome = ["C:", "Users", "alice"].join("\\");

describe("redactLocalHomePaths", () => {
  it("replaces Windows and POSIX home prefixes so the username is not shown", () => {
    expect(redactLocalHomePaths(`scandir '${winHome}\\AppData\\Local\\workspace'`)).toBe(
      "scandir '~\\AppData\\Local\\workspace'",
    );
    expect(redactLocalHomePaths("open /home/bob/project/a.txt and /Users/carol/x")).toBe(
      "open ~/project/a.txt and ~/x",
    );
  });

  it("redacts a whole profile name that contains a space", () => {
    const spaced = ["C:", "Users", "Jane Doe", "AppData", "x"].join("\\");
    expect(redactLocalHomePaths(`scandir '${spaced}'`)).toBe("scandir '~\\AppData\\x'");
  });

  it("redacts a spaced profile name that ends the text or a quoted path", () => {
    const home = ["C:", "Users", "Jane Doe"].join("\\");
    expect(redactLocalHomePaths(home)).toBe("~");
    expect(redactLocalHomePaths(`scandir '${home}'`)).toBe("scandir '~'");
  });

  it("leaves text without a home path untouched", () => {
    expect(redactLocalHomePaths("scandir 'workspace/docs'")).toBe("scandir 'workspace/docs'");
  });
});

describe("buildPlainApprovedToolFailureText", () => {
  const raw = `execution error: ENOENT: no such file or directory, scandir '${winHome}\\AppData\\Local\\workspace'`;

  it("states a short cause without the tool id, error code or local path", () => {
    const text = buildPlainApprovedToolFailureText("fs.list", { message: raw, kind: "failed" });
    expect(text).toBe(
      "The approved action (Browse files) didn't work because the file or folder doesn't exist. Open Activity for technical details.",
    );
    expect(text).not.toMatch(/fs\.list|ENOENT|alice|Users/u);
  });

  it("falls back to generic wording for unknown tools and causes", () => {
    expect(buildPlainApprovedToolFailureText("vendor.thing", { message: "boom", kind: "failed" })).toBe(
      "The approved action didn't work. Open Activity for technical details.",
    );
  });

  it("keeps the manual reconciliation marking", () => {
    expect(buildPlainApprovedToolFailureText("channel.send", { message: "x", kind: "manual_reconciliation" })).toMatch(
      /manual reconciliation/u,
    );
  });

  it("maps common causes", () => {
    expect(describeFailureCause("EACCES: permission denied")).toBe("permission was denied");
    expect(describeFailureCause("weird")).toBeUndefined();
  });
});
