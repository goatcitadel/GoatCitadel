import { describe, expect, it } from "vitest";
import { approvalTargetLine } from "./approval-target.js";

const cp = (point: number) => String.fromCodePoint(point);
const shell = (command: string) => approvalTargetLine("shell.exec", { toolName: "shell.exec", command });
const code = (value: string) => approvalTargetLine("code_mode.run", { codePreview: value });

describe("approvalTargetLine", () => {
  it("names a path, an address, a command or code", () => {
    expect(approvalTargetLine("documents.create", { toolName: "documents.create", path: "notes/ut14-note.txt" })).toBe(
      "Path: notes/ut14-note.txt",
    );
    expect(
      approvalTargetLine("http.get", { toolName: "http.get", target: "https://user:pw@example.invalid/a?token=x" }),
    ).toBe("Target: https://example.invalid");
    expect(approvalTargetLine("http.get", { toolName: "http.get", target: "not a url" })).toBeUndefined();
    expect(shell("pnpm test")).toBe("Command: pnpm (details below)");
    expect(approvalTargetLine("custom.fetch", { toolName: "custom.fetch", command: "ignored" })).toBeUndefined();
    expect(code("x".repeat(200))!.length).toBe(160);
  });

  it("gives nothing when the preview names nothing", () => {
    expect(approvalTargetLine("documents.create", undefined)).toBeUndefined();
    expect(approvalTargetLine("documents.create", { path: "   " })).toBeUndefined();
  });

  it("shows model-written text as one plain line with control characters removed", () => {
    expect(approvalTargetLine("documents.create", { path: `a${cp(0x202e)}b${cp(7)}c${cp(9)}d` })).toBe("Path: ab c d");
    expect(code("\n\nconst a = 1;\nconst b = 2;")).toBe("Code: const a = 1; (and 1 more line)");
  });
});

describe("a code preview that cannot hide a harmful tail", () => {
  it("removes invisible padding before cutting, so the tail stays in view", () => {
    expect(code("echo ok" + cp(0x34f).repeat(160) + "; rm -rf ~")).toBe("Code: echo ok; rm -rf ~");
    expect(code(`echo${cp(0xa0)}ok`)).toBe("Code: echo ok");
    expect(code(`ec${cp(0xad)}ho ok`)).toBe("Code: echo ok");
    expect(code(`echo${cp(0x200d)} ok`)).toBe("Code: echo ok");
    const filler = [0xfe0f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800].map(cp).join("");
    expect(code("echo ok" + filler.repeat(40) + "; rm -rf ~")).toBe("Code: echo ok; rm -rf ~");
  });

  it("redacts a secret that has an invisible character inside it", () => {
    const token = ["sk", "test".repeat(6)].join("-");
    const split = token.slice(0, 8) + cp(0x200b) + token.slice(8);
    const line = code(`use ${split}`)!;
    expect(line).not.toContain(token.slice(8));
    expect(line).toContain("[REDACTED]");
  });

  it("says in words that a long line was cut, and never splits a surrogate pair", () => {
    const line = code("a".repeat(300))!;
    expect(line.endsWith(`${cp(0x2026)} (cut short)`)).toBe(true);
    expect(line.length).toBeLessThanOrEqual(160);
    const emoji = code(cp(0x1f600).repeat(300))!;
    const whole = Array.from(emoji).every(
      (ch) => ch.length === 2 || ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff,
    );
    expect(whole).toBe(true);
  });

  it("says how many more lines a code preview has", () => {
    expect(code("\n\nrun()\n\nb\nc")).toBe("Code: run() (and 2 more lines)");
  });
});

describe("a shell command heading", () => {
  it.each([
    ["pnpm test", "Command: pnpm (details below)"],
    ["/usr/bin/mysql -pPW", "Command: mysql (details below)"],
    ['"C:\\Program Files\\MySQL\\bin\\mysql.exe" -pPW', "Command (details below)"],
    ['API_KEY="my secret" node x', "Command (details below)"],
    ['$env:TOKEN="PW"; mysql -pX', "Command (details below)"],
    ["PGPASSWORD=PW psql", "Command (details below)"],
    ["--password=PW tool", "Command (details below)"],
    ["pnpm test\nrm -rf ~/x", "Command: pnpm (2 lines, details below)"],
    ["\n\nls\n\na\nb", "Command: ls (3 lines, details below)"],
  ])("never shows the arguments of %j", (command, heading) => {
    expect(shell(command)).toBe(heading);
    expect(shell(command)).not.toMatch(/PW|secret/u);
  });

  it("caps the program name", () => {
    expect(shell("a".repeat(100))).toBe(`Command: ${"a".repeat(40)} (details below)`);
  });

  it("answers at once for a very long single token", () => {
    const started = Date.now();
    expect(shell("a".repeat(200_000))).toBe("Command (details below)");
    expect(shell("KEY".repeat(100_000) + "=x")).toBe("Command (details below)");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
