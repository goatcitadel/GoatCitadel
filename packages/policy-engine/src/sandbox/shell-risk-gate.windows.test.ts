import { describe, expect, it } from "vitest";
import { classifyShellRisk } from "./shell-risk-gate.js";

const patterns = ["rm", "rmdir", "del", "format", "shutdown", "git push", "git reset --hard"];

// Classification fixtures only. Never execute these commands.
describe("Windows shell risk regression corpus", () => {
  it.each([
    'powershell.exe -NoProfile -Command "Remove-Item -LiteralPath C:\\workspace\\temp -Recurse -Force"',
    "pwsh -Command \"& 'Remove-Item' -LiteralPath C:\\workspace\\temp -Recurse\"",
    'pwsh -Command "ri C:\\workspace\\temp -Recurse -Force"',
    'cmd.exe /c "rd /s /q C:\\workspace\\temp"',
    'cmd.exe /c "erase /f C:\\workspace\\temp\\file.txt"',
    'pwsh -Command "git status; git push origin main"',
    'pwsh -Command "git reset --hard HEAD"',
    'pwsh -Command "git.exe push origin main"',
    'pwsh -Command "git.exe reset --hard HEAD"',
    "pwsh -EncodedCommand " + Buffer.from("Remove-Item C:\\workspace\\temp -Recurse", "utf16le").toString("base64"),
    'pwsh -Command "Invoke-Expression $script"',
    'pwsh -Command "& $command"',
    'pwsh -File ./script.ps1 -Command "Get-Content ./safe.txt"',
    'pwsh -Command "& ./script.ps1"',
    'cmd /c "echo %DANGEROUS_COMMAND%"',
    'cmd /c "d^el ./temp.txt"',
    'pwsh -Command "Set-Alias wipe Remove-Item; wipe ./temp"',
    'cmd /c "call ./script.cmd"',
    'pwsh -Command "cmd /c del ./temp.txt"',
    '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Remove-Item ./temp"',
  ])("requires review for %s", (command) => {
    expect(classifyShellRisk(command, patterns).risky).toBe(true);
  });

  it.each([
    "git status --short",
    'pwsh -NoProfile -Command "Get-ChildItem -LiteralPath C:\\workspace"',
    "pwsh -Command \"Write-Output 'Remove-Item -Recurse'\"",
    "pwsh -Command \"Write-Output 'git push origin main'\"",
    "pwsh -Command \"Get-Content -LiteralPath 'C:\\workspace\\del.txt'\"",
  ])("keeps literal reads and quoted data non-risky: %s", (command) => {
    expect(classifyShellRisk(command, patterns).risky).toBe(false);
  });

  it("fails closed for oversized, malformed, or unsupported shell wrappers", () => {
    for (const command of [
      'pwsh -Command "unterminated',
      "pwsh -File ./script.ps1",
      'cmd -Command "echo safe"',
      'pwsh /c "Get-Content ./safe.txt"',
      "pwsh -EncodedCommand not-valid-base64",
      `pwsh -Command "${"x".repeat(33_000)}"`,
    ]) {
      expect(classifyShellRisk(command, patterns).risky).toBe(true);
    }
  });

  it("does not broaden an empty configured risk policy", () => {
    expect(classifyShellRisk('pwsh -Command "Remove-Item ./temp -Recurse"', [])).toEqual({ risky: false });
  });
});
