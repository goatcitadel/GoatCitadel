import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "research-artifact-powerpoint.ps1");

test("PowerPoint proof is read-only, hidden, ownership-aware, and non-destructive", async () => {
  const source = await fs.readFile(scriptPath, "utf8");
  assert.match(source, /Presentations\.Open\(\$resolvedDeck, -1, 0, 0\)/u);
  assert.match(source, /GOATCITADEL_VERIFY_RESEARCH_DECK/u);
  assert.match(source, /ccg-competitive-landscape-2026-v2\.pptx/u);
  assert.match(source, /-not \$existingPowerPointProcessIds\.Contains\(\$powerPointProcessId\)/u);
  assert.match(source, /if \(\$ownsApplicationProcess[^]*\$application\.Quit\(\)/u);
  assert.match(source, /\$presentation\.Close\(\)/u);
  assert.match(source, /\$slide\.Export\(\$slidePath, "PNG", 1600, 900\)/u);
  assert.match(source, /sampledColors\.Count -lt 2/u);
  assert.match(source, /contact-sheet\.png/u);
  assert.match(source, /\$cellHeight = \$thumbHeight \+ \$labelHeight/u);
  assert.match(source, /\(\$row \* \$cellHeight\) \+ \$labelHeight/u);
  assert.match(source, /function Get-PortableRelativePath/u);
  assert.match(source, /function Get-Sha256Hex/u);
  assert.doesNotMatch(source, /\[System\.IO\.Path\]::GetRelativePath/u);
  assert.doesNotMatch(source, /\bGet-FileHash\b/u);
  assert.doesNotMatch(source, /\b(?:Stop-Process|taskkill|Kill\(|Remove-Item)\b/iu);
});

test("PowerPoint proof parses as valid PowerShell", { skip: process.platform !== "win32" }, () => {
  const escaped = scriptPath.replaceAll("'", "''");
  const command = [
    "$tokens = $null",
    "$errors = $null",
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors)`,
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
  ].join("; ");
  const parsed = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, `${parsed.stdout}\n${parsed.stderr}`);
});
