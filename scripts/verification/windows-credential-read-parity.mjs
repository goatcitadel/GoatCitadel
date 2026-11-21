import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

// Run from a Windows development machine with an x64 helper built by MSVC and the Windows SDK.
// cl /std:c++20 /EHsc /O1 /MT /DWIN32_LEAN_AND_MEAN /DNOMINMAX /Fo<scratch-object> /Fe<scratch-exe> apps\mission-control-windows\Native\credential_read.cpp /link windowsapp.lib
// node scripts/verification/windows-credential-read-parity.mjs <absolute-scratch-exe>
const helper = process.argv[2];
const installedOnly = process.argv[3] === "--installed-only";
const installed = installedOnly || process.argv[3] === "--installed";
if (process.platform !== "win32" || !helper || !isAbsolute(helper)) {
  throw new Error("Pass the absolute path to the compiled Windows credential reader.");
}

const installedService = join(dirname(dirname(helper)), "gateway", "dist", "services", "secret-store-service.js");
const source = readFileSync(installed ? installedService : new URL("../../apps/gateway/src/services/secret-store-service.ts", import.meta.url), "utf8");
const legacyScript = /const WINDOWS_CREDENTIAL_READ_ARGS = \[[^`]+`([^`]+)`\s*\];/u.exec(source)?.[1];
if (!legacyScript) throw new Error("The Gateway's PowerShell read script could not be identified.");

const powerShellArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
const subprocessOptions = { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 };
const helperEnvKeys = new Set([
  "path", "pathext", "home", "userprofile", "systemroot", "windir", "temp", "tmp", "tmpdir", "lang", "lc_all", "comspec",
]);
const helperEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => helperEnvKeys.has(key.toLowerCase())));

const profile = () => `goatcitadel.desktop.${randomBytes(32).toString("hex")}.${randomUUID()}`;
const firstProfile = profile();
const secondProfile = profile();
const absentProfile = profile();
const fixtures = [
  { resource: firstProfile, account: "fixture:shared", value: "synthetic first profile" },
  { resource: secondProfile, account: "fixture:shared", value: "synthetic second profile" },
  { resource: firstProfile, account: "fixture:unicode", value: "synthetic é 漢字 🐐" },
  { resource: firstProfile, account: "fixture:blank", value: "   " },
  { resource: firstProfile, account: "fixture:empty", value: "" },
];

const fixturePrelude = String.raw`$ErrorActionPreference = 'Stop'
[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
[Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
$vault = [Windows.Security.Credentials.PasswordVault]::new()
$entries = [Console]::In.ReadToEnd() | ConvertFrom-Json
`;
const setupScript = fixturePrelude + String.raw`
try {
  foreach ($row in $entries) {
    try { $vault.Add([Windows.Security.Credentials.PasswordCredential]::new($row[0], $row[1], $row[2])) }
    catch { if ($row[2] -ne '') { throw } }
  }
} catch { exit 2 }
exit 0
`;
const cleanupScript = fixturePrelude + String.raw`
$failed = $false
foreach ($row in $entries) {
  try { $item = $vault.Retrieve($row[0], $row[1]); $vault.Remove($item) }
  catch { if ($_.Exception.GetBaseException().HResult -ne -2147023728) { $failed = $true } }
}
if ($failed) { exit 2 }
exit 0
`;

function runFixtureAction(script, entries) {
  // Windows PowerShell may use a legacy console encoding. Keep the fixture input ASCII.
  const input = JSON.stringify(entries.map(({ resource, account, value }) => [resource, account, value]))
    .replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const result = spawnSync("powershell", [...powerShellArgs, script], {
    ...subprocessOptions, input, timeout: 60_000,
  });
  // Report only protocol outcomes. Windows PowerShell errors can contain input fragments.
  return { exit: result.status, timeout: result.error?.code === "ETIMEDOUT", stdoutBytes: result.stdout?.length, stderrBytes: result.stderr?.length };
}

function readCredential(command, args, { resource, account }, timeout = 10_000) {
  const start = performance.now();
  const result = spawnSync(command, args, {
    ...subprocessOptions, timeout,
    env: { ...helperEnv, GOATCITADEL_SECRET_SERVICE: resource, GOATCITADEL_SECRET_ACCOUNT: account },
  });
  const state = result.error?.code === "ETIMEDOUT" ? "timeout"
    : result.status === 3 ? "missing" : result.status === 0 ? "found" : "unavailable";
  return {
    value: state === "found" ? result.stdout.trim() || undefined : undefined,
    state,
    milliseconds: Math.round(performance.now() - start),
    silent: result.stderr === "",
    stdoutEmpty: result.stdout === "",
  };
}

function summarize(read, expectedValue) {
  return { state: read.state, expectedValue: read.value === expectedValue, milliseconds: read.milliseconds, silent: read.silent };
}

function verify(label, lookup, expectedState, expectedValue) {
  const prior = readCredential("powershell", [...powerShellArgs, legacyScript], lookup);
  const native = readCredential(helper, [], lookup);
  const nativeExpected = native.state === expectedState && native.value === expectedValue && native.silent;
  const parity = native.state === prior.state && native.value === prior.value;
  const result = { label, legacy: summarize(prior, expectedValue), native: summarize(native, expectedValue), parity };
  // The extended diagnostic budget lets us distinguish startup timeouts from encoding drift.
  if (prior.state === "timeout") {
    result.legacyExtended = summarize(readCredential("powershell", [...powerShellArgs, legacyScript], lookup, 30_000), expectedValue);
  }
  console.log(JSON.stringify(result));
  if (!nativeExpected || !parity) process.exitCode = 1;
}

async function verifyInstalledService() {
  const { SecretStoreService } = await import(pathToFileURL(installedService).href);
  const timings = [];
  let legacyUnavailable = 0;
  const trace = channel("goatcitadel.windows-credential-read");
  const record = ({ backend, outcome, durationMs }) => timings.push({ backend, outcome, durationMs });
  trace.subscribe(record);
  try {
    for (const backend of ["native", "powershell"]) {
      process.env.GOATCITADEL_NATIVE_WINDOWS_CREDENTIAL_READ = backend === "native" ? "1" : "0";
      for (const lookup of [fixtures[2], { resource: absentProfile, account: fixtures[2].account }]) {
        process.env.GOATCITADEL_WINDOWS_PROFILE_RESOURCE = lookup.resource;
        let value;
        try {
          value = await new SecretStoreService().getSecretAsync(lookup.account);
        } catch (error) {
          if (!installedOnly || backend !== "powershell" || error.code !== "SECRET_STORE_UNAVAILABLE"
            || timings.at(-1)?.backend !== backend) throw error;
          legacyUnavailable += 1;
          continue;
        }
        if (value !== lookup.value || timings.at(-1)?.backend !== backend) {
          throw new Error("Installed Gateway returned the wrong fixture value or selected the wrong credential backend.");
        }
      }
    }
    console.log(JSON.stringify({ installedGatewayReads: timings, legacyUnavailable }));
  } finally {
    trace.unsubscribe(record);
  }
}

function verifyStandaloneReads() {
  verify("first profile", fixtures[0], "found", fixtures[0].value);
  verify("second profile", fixtures[1], "found", fixtures[1].value);
  verify("unicode", fixtures[2], "found", fixtures[2].value);
  verify("whitespace normalizes to an empty result", fixtures[3], "found", undefined);
  const empty = readCredential(helper, [], fixtures[4]);
  const emptyState = empty.state === "found" ? "found" : "missing";
  verify("literal empty fixture (missing if the vault rejects storing it)", fixtures[4], emptyState, undefined);
  verify("other profile", { resource: absentProfile, account: fixtures[0].account }, "missing", undefined);
  verify("missing account", { resource: firstProfile, account: "fixture:missing" }, "missing", undefined);

  const unavailable = readCredential(helper, [], { resource: "", account: fixtures[0].account });
  const timeout = readCredential(helper, [], fixtures[0], 1);
  console.log(JSON.stringify({
    unavailable: summarize(unavailable, undefined), timeout: summarize(timeout, undefined),
    unavailableStdoutEmpty: unavailable.stdoutEmpty, timeoutStdoutEmpty: timeout.stdoutEmpty,
  }));
  if (unavailable.state !== "unavailable" || !unavailable.silent || !unavailable.stdoutEmpty || timeout.state !== "timeout") {
    process.exitCode = 1;
  }
}

try {
  const setup = runFixtureAction(setupScript, fixtures);
  if (setup.exit !== 0) throw new Error(`Disposable credential setup failed (${JSON.stringify(setup)}).`);
  if (!installedOnly) verifyStandaloneReads();
  if (installed) await verifyInstalledService();
} finally {
  const lookupKeys = fixtures.map(({ resource, account }) => ({ resource, account }));
  const removed = runFixtureAction(cleanupScript, lookupKeys);
  const verified = lookupKeys.every((lookup) => readCredential(helper, [], lookup).state === "missing");
  console.log(JSON.stringify({ cleanup: removed.exit === 0 && verified, cleanupAction: removed, verifiedMissing: verified }));
  if (removed.exit !== 0 || !verified) process.exitCode = 1;
}
