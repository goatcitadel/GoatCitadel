import { describe, expect, it } from "vitest";
import { maskShellCredentials, previewLine } from "./inbox-preview-text.js";

// Built at run time so no credential-looking literal sits in the file.
const pw = ["pw", "zq9", "plain"].join("-");

describe("maskShellCredentials", () => {
  const cases: Array<[string, string, string]> = [
    [
      "curl user:password",
      `curl -u alice:${pw} https://example.invalid`,
      "curl -u alice:[REDACTED] https://example.invalid",
    ],
    [
      "curl --user",
      `curl --user alice:${pw} https://example.invalid`,
      "curl --user alice:[REDACTED] https://example.invalid",
    ],
    ["mysql glued -p", `mysql -u root -p${pw}`, "mysql -u root -p[REDACTED]"],
    ["psql env", `PGPASSWORD=${pw} psql -h host`, "PGPASSWORD=[REDACTED] psql -h host"],
    ["mysql env", `MYSQL_PWD=${pw} mysql`, "MYSQL_PWD=[REDACTED] mysql"],
    ["DB_PASS env", `DB_PASS=${pw} ./run`, "DB_PASS=[REDACTED] ./run"],
    ["DB_PASS echo", `echo DB_PASS=${pw} >> .env`, "echo DB_PASS=[REDACTED] >> .env"],
    ["sshpass", `sshpass -p ${pw} ssh host`, "sshpass -p [REDACTED] ssh host"],
    ["docker login", `docker login -u me -p ${pw}`, "docker login -u me -p [REDACTED]"],
    ["gh body", `gh secret set X --body ${pw}`, "gh secret set X --body [REDACTED]"],
    ["password flag with equals", `tool --password=${pw} run`, "tool --password=[REDACTED] run"],
    ["quoted env value", `API_TOKEN="${pw} two" ./run`, "API_TOKEN=[REDACTED] ./run"],
  ];
  it.each(cases)("masks %s", (_name, input, expected) => {
    const masked = maskShellCredentials(input);
    expect(masked).toBe(expected);
    expect(masked).not.toContain(pw);
  });

  it("leaves a command with none of these forms unchanged, and keeps -p as a port for ssh and psql", () => {
    for (const command of [
      "pnpm test --filter api",
      "ssh -p 2222 host",
      "psql -p 5432 -h host",
      "mysql -p mydb",
      "echo COLOR=1",
    ]) {
      expect(maskShellCredentials(command)).toBe(command);
    }
  });

  it("finishes quickly on a 10,000 character adversarial line", () => {
    const lines = [
      `${"PASS".repeat(2500)}`,
      `${"-u a:".repeat(2000)}`,
      `${'API_KEY="'.repeat(1100)}`,
      `${"mysql ".repeat(1600)}`,
    ];
    const started = performance.now();
    for (const line of lines) maskShellCredentials(line);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("previewLine", () => {
  it("shows a cut line as cut short, not as the whole command", () => {
    const hidden = `pnpm test${"\u200B".repeat(175)} && rm -rf build`;
    expect(previewLine("Command", hidden, { shell: true })).toBe("Command: pnpm test && rm -rf build");
    const long = previewLine("Command", `echo ${"x".repeat(400)}`, { shell: true })!;
    expect(long.endsWith(" (cut short)")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(240);
    const multi = previewLine("Command", `echo ${"x".repeat(400)}\nsecond`, { shell: true })!;
    expect(multi.endsWith(" (cut short) (and 1 more line)")).toBe(true);
  });

  it("makes unusual spaces plain and removes soft hyphens and joiners", () => {
    expect(previewLine("Command", "echo\u00A0a\u3000b", { shell: true })).toBe("Command: echo a b");
    expect(previewLine("Command", "ec\u00ADho a\u200Db", { shell: true })).toBe("Command: echo ab");
  });

  it("masks credential forms in a command but not in code", () => {
    expect(previewLine("Command", `sshpass -p ${pw} ssh host`, { shell: true })).toBe(
      "Command: sshpass -p [REDACTED] ssh host",
    );
    expect(previewLine("Code", "const a = 1;")).toBe("Code: const a = 1;");
  });
});
