import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.status === 0) {
    return;
  }
  const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
}

function listTrackedPowerShellFiles() {
  const output = execFileSync("git", ["ls-files", "*.ps1"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function verifyActionlint() {
  const actionlint = process.env.ACTIONLINT_BIN || "actionlint";
  run(actionlint, []);
  console.log("[verify:workflows] actionlint passed.");
}

function verifyPowerShellParse() {
  const files = listTrackedPowerShellFiles();
  if (files.length === 0) {
    console.log("[verify:workflows] no tracked PowerShell files found.");
    return;
  }

  const powershell = process.env.PWSH_BIN || "pwsh";
  const filesJson = JSON.stringify(files);
  const script = `
$ErrorActionPreference = "Stop"
$paths = ConvertFrom-Json @'
${filesJson}
'@
foreach ($path in $paths) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $path), [ref] $tokens, [ref] $errors) > $null
  if ($errors.Count -gt 0) {
    Write-Error "PowerShell parse failed for $path"
    $errors | Format-List *
    exit 1
  }
}
Write-Output "PowerShell parse ok ($($paths.Count) files)"
`;
  run(powershell, ["-NoProfile", "-NonInteractive", "-Command", script]);
  console.log(`[verify:workflows] PowerShell parse passed for ${files.length} files.`);
}

try {
  verifyActionlint();
  verifyPowerShellParse();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
