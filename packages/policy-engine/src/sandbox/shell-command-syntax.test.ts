import { describe, expect, it } from "vitest";
import { detectShellScriptSyntax, formatShellScriptSyntaxError } from "./shell-command-syntax.js";

describe("detectShellScriptSyntax", () => {
  it("names the PowerShell script that failed with spawn ENOENT", () => {
    const command = [
      "$dir='C:\\personal-ai\\workspace\\artifacts'",
      "$html=Join-Path $dir 'report.html'",
      "$content=@'",
      "<!doctype html><html><body>Report</body></html>",
      "'@",
    ].join("\n");

    expect(detectShellScriptSyntax(command)?.construct).toMatch(/shell variable/u);
  });

  it.each([
    ["node a.js\nnode b.js", /multi-line/u],
    ["git status; git log", /separator/u],
    ["rg foo | head", /pipe/u],
    ["pnpm build && pnpm test", /&&/u],
    ["pnpm build || echo failed", /\|\|/u],
    ["node build.js > out.txt", /redirection/u],
    ["echo $(whoami)", /substitution/u],
    ["NODE_ENV=production node server.js", /environment assignment/u],
    ['& "C:\\Program Files\\app.exe" --flag', /call operator/u],
    ["node server.js &", /background or call operator/u],
    ["echo $HOME", /variable reference/u],
    ["node ${SCRIPT_DIR}/run.js", /variable reference/u],
  ])("flags %j", (command, construct) => {
    expect(detectShellScriptSyntax(command)?.construct).toMatch(construct);
  });

  it.each([
    "pnpm --filter @goatcitadel/gateway test -- src/routes/chat.routes.test.ts",
    "node -e \"console.log('a|b; c > d')\"",
    'pwsh -NoProfile -Command "Get-ChildItem | Select-Object -First 3; exit 0"',
    "sh -c 'ls | head && echo done'",
    "msedge --headless --print-to-pdf=C:\\out\\report.pdf C:\\out\\report.html",
    "git log --format=%H -n 5",
    "curl https://example.com/a?b=1&c=2",
  ])("allows one program with arguments: %j", (command) => {
    expect(detectShellScriptSyntax(command)).toBeUndefined();
  });

  it("explains how to run a script instead", () => {
    const message = formatShellScriptSyntaxError("shell.exec_background", { construct: "a pipe (|)" });

    expect(message).toContain("shell.exec_background runs one program with its arguments and does not start a shell");
    expect(message).toContain('pwsh -NoProfile -Command "<script>"');
    expect(message).toContain("pwsh -NoProfile -File script.ps1 or sh script.sh");
  });

  it("allows a literal dollar sign inside quotes or before a digit", () => {
    expect(detectShellScriptSyntax("node -e 'console.log(\"$HOME\")'")).toBeUndefined();
    expect(detectShellScriptSyntax('git commit -m "costs $5 now"')).toBeUndefined();
    expect(detectShellScriptSyntax("node price.js $5")).toBeUndefined();
  });
});
