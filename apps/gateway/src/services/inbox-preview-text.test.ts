import { describe, expect, it } from "vitest";
import { codeRunSummary, shellCommandSummary } from "./inbox-preview-text.js";

// Built at run time so no credential-looking literal sits in the file.
const pw = ["pw", "zq9", "plain"].join("-");
const BACKSLASH = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const NOTE = "(open it to see the full command)";

describe("shellCommandSummary", () => {
  it("names only the program", () => {
    expect(shellCommandSummary("pnpm test")).toBe(`Command: pnpm ${NOTE}`);
    expect(shellCommandSummary(`/usr/bin/mysql -p${pw} db`)).toBe(`Command: mysql ${NOTE}`);
    expect(shellCommandSummary(`${["tools", "mysql.exe"].join(BACKSLASH)} -p${pw}`)).toBe(`Command: mysql.exe ${NOTE}`);
    expect(shellCommandSummary(`  \t git status`)).toBe(`Command: git ${NOTE}`);
  });

  it("names the program of a command that keeps going after a Windows home path", () => {
    const home = ["C:", "Users", "me"].join(BACKSLASH);
    expect(shellCommandSummary(`type ${home} && del important.txt`)).toBe(`Command: type ${NOTE}`);
  });

  it("names no program when the first word is not a plain program name", () => {
    const quoted = `"${["C:", "Program Files", "MySQL", "bin", "mysql.exe"].join(BACKSLASH)}" -p${pw}`;
    for (const command of [
      quoted,
      `PGPASSWORD=${pw} psql`,
      `$env:TOKEN="${pw}"; x`,
      `-p${pw} mysql`,
      `${"a".repeat(25)} run`,
      "",
      "   ",
    ]) {
      expect(shellCommandSummary(command)).toBe(command.trim() ? `Command ${NOTE}` : undefined);
    }
  });

  it("says how very long a longer command has", () => {
    expect(shellCommandSummary(`echo one${NL}echo two${NL}${NL}echo three`)).toBe(`Command: echo, 3 lines ${NOTE}`);
    expect(shellCommandSummary(`PGPASSWORD=${pw} psql${NL}select 1`)).toBe(`Command, 2 lines ${NOTE}`);
    expect(shellCommandSummary(`echo ${"x".repeat(20_000)}${NL}echo two`)).toBe(`Command: echo, very long ${NOTE}`);
  });

  it("returns at once for a huge or adversarial command", () => {
    const started = performance.now();
    expect(shellCommandSummary(`${'"'.repeat(200_000)}x`)).toBe(`Command, very long ${NOTE}`);
    expect(shellCommandSummary(`${"a".repeat(5_000_000)}`)).toBe(`Command, very long ${NOTE}`);
    expect(shellCommandSummary(`echo ${"y".repeat(5_000_000)}`)).toBe(`Command: echo, very long ${NOTE}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("never shows a password from any of these", () => {
    for (const command of [
      `curl -u alice:${pw} https://example.invalid`,
      `mysql -u root -p${pw} db`,
      `sshpass -p ${pw} ssh host`,
      `openssl enc -k ${pw}`,
      `echo ${pw} | docker login --password-stdin`,
    ]) {
      expect(shellCommandSummary(command)).not.toContain(pw);
    }
  });
});

describe("codeRunSummary", () => {
  it("says how very long of code will run, and shows none of it", () => {
    const code = ["const a = 1;", `const key = "${pw}";`, "run(a);", "done();"].join(NL);
    expect(codeRunSummary(code)).toBe("Code to run, 4 lines (open it to see the code)");
    expect(codeRunSummary(`run("${pw}");`)).toBe("Code to run, 1 line (open it to see the code)");
    expect(codeRunSummary(`${"x".repeat(20_000)}${NL}y`)).toBe("Code to run, very long (open it to see the code)");
    expect(codeRunSummary("  ")).toBeUndefined();
    expect(codeRunSummary(code)).not.toContain(pw);
  });
});
