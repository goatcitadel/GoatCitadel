import { CONNECTED_WORKER_ENV } from "../../../apps/remote-worker/src/worker-environment.ts";
import { WORKER_HOST_IMAGE } from "../build-remote-worker-windows-host.mjs";

export function renderWorkerWindowsLauncher() {
  const allowed = Object.values(CONNECTED_WORKER_ENV).filter(
    (name) => name !== CONNECTED_WORKER_ENV.clientKeyFile && name !== CONNECTED_WORKER_ENV.hostControl,
  );
  return [
    "#Requires -Version 5.1",
    "Set-StrictMode -Version Latest",
    '$ErrorActionPreference = "Stop"',
    'if ($args.Count -ne 0) { throw "Configure the worker through its documented environment settings." }',
    `$allowed = @(${allowed.map((name) => `'${name}'`).join(", ")})`,
    "$start = New-Object System.Diagnostics.ProcessStartInfo",
    "$start.UseShellExecute = $false",
    "$start.CreateNoWindow = $true",
    "$start.RedirectStandardInput = $true",
    "$root = Split-Path -Parent $PSScriptRoot",
    `$start.FileName = Join-Path $root "bin\\${WORKER_HOST_IMAGE}"`,
    '$start.Arguments = "--foreground"',
    "$start.WorkingDirectory = $root",
    "$start.EnvironmentVariables.Clear()",
    '$start.EnvironmentVariables["SystemRoot"] = [Environment]::GetFolderPath("Windows")',
    "foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {",
    '  if (-not $entry.Key.StartsWith("GOATCITADEL_CONNECTED_WORKER_")) { continue }',
    '  if ($entry.Key -cnotin $allowed) { throw "Unsupported packaged-worker setting." }',
    "  $start.EnvironmentVariables[$entry.Key] = [string]$entry.Value",
    "}",
    'if (-not $start.EnvironmentVariables["GOATCITADEL_CONNECTED_WORKER_PROTECTED_KEY_FILE"]) { throw "A protected key reference is required." }',
    "$child = $null",
    "try {",
    "  $child = [Diagnostics.Process]::Start($start)",
    "  $child.WaitForExit()",
    "  $code = $child.ExitCode",
    "} finally {",
    "  if ($null -ne $child) {",
    '    if (-not $child.HasExited) { $child.Kill(); if (-not $child.WaitForExit(5000)) { throw "Worker termination is unresolved." } }',
    "    $child.Dispose()",
    "  }",
    "}",
    "exit $code",
    "",
  ].join("\r\n");
}
