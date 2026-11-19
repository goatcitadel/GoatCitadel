import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { directoryExists } from "./installed-profile-recovery.mjs";

export function inspectLocalProfileStorage(activeRoot, storedRoot = activeRoot, env = process.env) {
  const fileEnv = parseEnv(readProfileFile(path.join(storedRoot, ".env")) ?? "");
  const effectiveEnv = { ...fileEnv, ...env };
  const configDir = path.join(storedRoot, "config");
  const canonical = directoryExists(configDir) ? readConfig(path.join(configDir, "goatcitadel.json")) : null;
  const split = directoryExists(configDir) ? readConfig(path.join(configDir, "assistant.config.json")) : null;

  const directories = new Set(["data/postgres"]);
  for (const assistant of [canonical?.assistant ?? {}, split ?? {}]) {
    const database = assistant.database;
    const postgres = database?.postgres;
    const driver = effectiveEnv.GOATCITADEL_DATABASE_DRIVER?.trim().toLowerCase() || database?.driver;
    const mode = effectiveEnv.GOATCITADEL_POSTGRES_MODE?.trim().toLowerCase() || postgres?.mode;
    if (driver !== "sqlite" && (mode === "external" || postgres?.connectionString || postgres?.connectionStringEnv
      || effectiveEnv.GOATCITADEL_POSTGRES_CONNECTION_STRING || effectiveEnv.GOATCITADEL_POSTGRES_CONNECTION_STRING_ENV)) {
      throw new Error("Reset and restore needs a local database. This profile uses an external PostgreSQL connection.");
    }
    const dataDir = database?.bundledPostgres?.dataDir;
    if (dataDir) directories.add(dataDir);
  }
  if (effectiveEnv.GOATCITADEL_BUNDLED_POSTGRES_DATA_DIR) {
    directories.add(effectiveEnv.GOATCITADEL_BUNDLED_POSTGRES_DATA_DIR.trim());
  }

  return [...new Set([...directories].map((value) => {
    const relative = path.relative(activeRoot, path.resolve(activeRoot, value));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Reset and restore needs bundled PostgreSQL storage inside this install's profile.");
    }
    let prefix = storedRoot;
    for (const part of relative.split(path.sep)) {
      prefix = path.join(prefix, part);
      directoryExists(prefix);
    }
    return prefix;
  }))];
}

export function stopProfilePostgres(directories) {
  for (const directory of directories) {
    const pidFile = path.join(directory, "postmaster.pid");
    if (readProfileFile(pidFile, 4096) === undefined) continue;
    if (readProfileFile(path.join(directory, ".goatcitadel-native-bundled-postgres"), 4096) === undefined) {
      throw new Error("Stop this install's bundled PostgreSQL container before resetting or restoring.");
    }
    runWindowsProfileHelper(STOP_POSTGRES, { GOAT_PROFILE_PG_DATA: directory }, 50_000,
      "Could not verify and stop this profile's bundled PostgreSQL. Stop it from its own management tool and retry.");
  }
}

export function retireProfileCredentials(resource) {
  runWindowsProfileHelper(RETIRE_CREDENTIALS, { GOAT_PROFILE_VAULT_RESOURCE: resource }, 15_000,
    "Could not remove saved sign-ins for an expired backup.");
}

function readConfig(file) {
  const raw = readProfileFile(file);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("A profile's database settings could not be read. Check its configuration before switching profiles.");
  }
}

function readProfileFile(file, maxBytes = 4 * 1024 * 1024) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("Could not safely read the profile's local storage settings.");
  return fs.readFileSync(file, "utf8");
}

function runWindowsProfileHelper(script, variables, timeout, failureMessage) {
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    env: { ...process.env, ...variables }, windowsHide: true, stdio: "ignore", timeout,
  });
  if (result.status !== 0) throw new Error(failureMessage);
}

const STOP_POSTGRES = String.raw`
$ErrorActionPreference = 'Stop'
$data = [IO.Path]::GetFullPath($env:GOAT_PROFILE_PG_DATA)
$pidFile = Join-Path $data 'postmaster.pid'
if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { exit 0 }
$lines = @(Get-Content -LiteralPath $pidFile -TotalCount 3)
if ($lines.Count -ne 3 -or $lines[0] -notmatch '^\d{1,10}$' -or $lines[2] -notmatch '^\d{1,12}$') { exit 1 }
$serverPid = [int]$lines[0]
if ($serverPid -le 0 -or [IO.Path]::GetFullPath($lines[1]) -ne $data) { exit 1 }
$server = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"
if ($null -eq $server) { exit 0 }
$startedAt = [DateTimeOffset]::new($server.CreationDate).ToUnixTimeSeconds()
$lockTime = [long]$lines[2]
# A stale lock with a reused PID must never stop the replacement process.
if ($startedAt -gt ($lockTime + 2)) { exit 0 }
if ($server.Name -ne 'postgres.exe' -or -not $server.ExecutablePath -or ($lockTime - $startedAt) -gt 120) { exit 1 }
if ($server.CommandLine -notmatch '(?:^|\s)-D\s+(?:"([^"]+)"|(\S+))(?=\s|$)') { exit 1 }
$actualData = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
if ([IO.Path]::GetFullPath($actualData) -ne $data) { exit 1 }
$pgCtl = Join-Path ([IO.Path]::GetDirectoryName($server.ExecutablePath)) 'pg_ctl.exe'
if (-not (Test-Path -LiteralPath $pgCtl -PathType Leaf)) { exit 1 }
if ((Get-Content -LiteralPath $pidFile -TotalCount 1) -ne $lines[0]) { exit 1 }
& $pgCtl -D $data -w -t 30 stop -m fast
if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $pidFile)) { exit 1 }
exit 0
`;

const RETIRE_CREDENTIALS = String.raw`
$ErrorActionPreference = 'Stop'
$resource = $env:GOAT_PROFILE_VAULT_RESOURCE
if ($resource -cnotmatch '^goatcitadel\.desktop\.[a-f0-9]{64}\.[a-f0-9-]{36}$') { exit 1 }
[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
$vault = [Windows.Security.Credentials.PasswordVault]::new()
try { $entries = @($vault.FindAllByResource($resource)) } catch {
  if ($_.Exception.GetBaseException().HResult -eq -2147023728) { exit 0 }
  throw
}
foreach ($entry in $entries) { $vault.Remove($entry) }
exit 0
`;
