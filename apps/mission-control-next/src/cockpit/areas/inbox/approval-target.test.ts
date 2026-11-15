import { describe, expect, it } from "vitest";
import { approvalTargetLine } from "./approval-target";

const cp = (point: number) => String.fromCodePoint(point);
const shell = (command: string) => approvalTargetLine("shell.exec", { toolName: "shell.exec", command });

describe("approvalTargetLine", () => {
  it("names a path, an address, a command or code", () => {
    expect(approvalTargetLine("documents.create", { toolName: "documents.create", path: "notes/ut14-note.txt" })).toBe(
      "Path: notes/ut14-note.txt",
    );
    expect(
      approvalTargetLine("http.get", { toolName: "http.get", target: "https://user:pw@example.invalid/a?token=x" }),
    ).toBe("Target: https://example.invalid");
    expect(approvalTargetLine("http.get", { toolName: "http.get", target: "not a url" })).toBeUndefined();
    expect(shell("pnpm test")).toBe("Command: pnpm test");
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
    expect(approvalTargetLine("documents.create", { path: `a${cp(0x202e)}b${cp(7)}c${cp(9)}d` })).toBe("Path: ab c d");
    expect(approvalTargetLine("code_mode.run", { codePreview: "\n\nconst a = 1;\nconst b = 2;" })).toBe(
      "Code: const a = 1; const b = 2;",
    );
  });
});

describe("a heading that cannot hide a harmful tail", () => {
  it("removes invisible padding before cutting, so the tail stays in view", () => {
    expect(shell("echo ok" + cp(0x34f).repeat(160) + "; rm -rf ~")).toBe("Command: echo ok; rm -rf ~");
    expect(shell(`echo${cp(0xa0)}ok`)).toBe("Command: echo ok");
    expect(shell(`ec${cp(0xad)}ho ok`)).toBe("Command: echo ok");
    expect(shell(`echo${cp(0x200d)} ok`)).toBe("Command: echo ok");
    const filler = [0xfe0f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800].map(cp).join("");
    expect(shell("echo ok" + filler.repeat(40) + "; rm -rf ~")).toBe("Command: echo ok; rm -rf ~");
  });

  it("says in words that a long line was cut", () => {
    const line = shell("echo " + "a".repeat(300))!;
    expect(line.endsWith(`${cp(0x2026)} (cut short)`)).toBe(true);
    expect(line.length).toBeLessThanOrEqual(160);
  });

  it("says how many more lines a multi-line command has", () => {
    expect(shell("pnpm test\nrm -rf ~/projects")).toBe("Command: pnpm test (and 1 more line)");
    expect(shell("\n\npnpm test\n\nb\nc")).toBe("Command: pnpm test (and 2 more lines)");
  });
});

describe("a command that carries a credential the shared redactor misses", () => {
  it.each([
    ["curl -u name:pw https://example.invalid", "curl"],
    ["curl --user=name:pw https://example.invalid", "curl"],
    ["mysql -ppw -h db", "mysql"],
    ["mysql -p pw", "mysql"],
    ["sshpass -p pw ssh host", "sshpass"],
    ["docker login -p pw", "docker"],
    ["mysql --password=pw", "mysql"],
    ["gh secret set X --body value", "gh"],
    ["tool --token abc", "tool"],
    ["PGPASSWORD=pw psql -h db", "psql"],
    ["API_KEY=abc node run.js", "node"],
  ])("shows only the first word of %j", (command, word) => {
    expect(shell(command)).toBe(`Command: ${word} (details below)`);
  });

  it("leaves a plain command as it is", () => {
    expect(shell("curl -s https://example.invalid")).toBe("Command: curl -s https://example.invalid");
    expect(shell("pnpm test --filter app")).toBe("Command: pnpm test --filter app");
  });
});
