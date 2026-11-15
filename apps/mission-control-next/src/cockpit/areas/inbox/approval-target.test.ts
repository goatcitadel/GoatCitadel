import { describe, expect, it } from "vitest";
import { approvalTargetLine } from "./approval-target";

describe("approvalTargetLine", () => {
  it("names a path, an address, a command or code", () => {
    expect(approvalTargetLine("documents.create", { toolName: "documents.create", path: "notes/ut14-note.txt" })).toBe(
      "Path: notes/ut14-note.txt",
    );
    expect(
      approvalTargetLine("http.get", { toolName: "http.get", target: "https://user:pw@example.invalid/a?token=x" }),
    ).toBe("Target: https://example.invalid");
    expect(approvalTargetLine("http.get", { toolName: "http.get", target: "not a url" })).toBeUndefined();
    expect(approvalTargetLine("shell.exec", { toolName: "shell.exec", command: "pnpm test\npnpm lint" })).toBe(
      "Command: pnpm test",
    );
    expect(approvalTargetLine("custom.fetch", { toolName: "custom.fetch", command: "ignored" })).toBeUndefined();
    expect(approvalTargetLine("code_mode.run", { codePreview: "x".repeat(200) })!.length).toBe(160);
  });

  it("gives nothing when the preview names nothing", () => {
    expect(approvalTargetLine("documents.create", undefined)).toBeUndefined();
    expect(approvalTargetLine("documents.create", { path: "   " })).toBeUndefined();
  });

  it("shows model-written text as one plain line with secrets and control characters removed", () => {
    const token = ["sk", "test".repeat(6)].join("-");
    const line = approvalTargetLine("shell.exec", {
      toolName: "shell.exec_background",
      command: `curl -H "Authorization: Bearer ${token}" https://example.invalid`,
    })!;
    expect(line).not.toContain(token);
    expect(line).toContain("[REDACTED]");
    expect(approvalTargetLine("documents.create", { path: "a‮b\u0007c\td" })).toBe("Path: a b c d");
    expect(approvalTargetLine("code_mode.run", { codePreview: "\n\nconst a = 1;\nconst b = 2;" })).toBe(
      "Code: const a = 1; const b = 2;",
    );
  });
});
