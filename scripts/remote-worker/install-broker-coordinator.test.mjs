// Frozen-contract test for the M2 availability-broker coordinator installer
// recipe (HX-501). It pins the security-critical recipe text and cross-checks
// every frozen constant against the broker's own native validation sources,
// mirroring how scripts/packaging/build-remote-worker-provisioner-windows-native.test.mjs
// pins the broker's single StartServiceW import.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptsDir = path.join(repoRoot, "scripts", "remote-worker");
const nativeSrcDir = path.join(repoRoot, "apps", "remote-worker-provisioner-windows-native", "src");

const readLf = (filePath) => fs.readFileSync(filePath, "utf8").replace(/\r\n/gu, "\n");

const common = readLf(path.join(scriptsDir, "broker-coordinator-common.ps1"));
const installer = readLf(path.join(scriptsDir, "install-broker-coordinator.ps1"));
const uninstaller = readLf(path.join(scriptsDir, "uninstall-broker-coordinator.ps1"));
const brokerHeader = readLf(path.join(nativeSrcDir, "availability_broker.hpp"));
const brokerValidation = readLf(path.join(nativeSrcDir, "availability_broker.cpp"));
const brokerRuntime = readLf(path.join(nativeSrcDir, "availability_broker_runtime.cpp"));
const packagingScript = readLf(
  path.join(repoRoot, "scripts", "packaging", "build-remote-worker-provisioner-windows-native.mjs"),
);

const allRecipeScripts = [
  ["broker-coordinator-common.ps1", common],
  ["install-broker-coordinator.ps1", installer],
  ["uninstall-broker-coordinator.ps1", uninstaller],
];

function extractCppWideLiteral(source, constantName) {
  const match = source.match(new RegExp(`${constantName}\\[\\]\\s*=\\s*\\n?\\s*L"((?:[^"\\\\]|\\\\.)*)"`, "u"));
  assert.ok(match, `native source must define ${constantName}`);
  return match[1];
}

function extractCppSidParts(source, constantName) {
  const blockMatch = source.match(new RegExp(`${constantName}[^;]+;`, "u"));
  assert.ok(blockMatch, `native source must define ${constantName}`);
  const parts = [...blockMatch[0].matchAll(/UINT32_C\((\d+)\)/gu)].map((entry) => Number(entry[1]));
  assert.equal(parts.length, 5, `${constantName} must carry the five service-SID sub-authorities`);
  assert.match(blockMatch[0], /80U,/u, `${constantName} must start with the service-account authority 80`);
  return `S-1-5-80-${parts.join("-")}`;
}

function extractPsString(source, constantName) {
  const match = source.match(new RegExp(`\\$script:${constantName} = "([^"]*)"`, "u"));
  assert.ok(match, `broker-coordinator-common.ps1 must define $script:${constantName}`);
  return match[1];
}

function deriveVirtualServiceAccountSid(serviceName) {
  const digest = crypto.createHash("sha1").update(Buffer.from(serviceName.toUpperCase(), "utf16le")).digest();
  const parts = [];
  for (let index = 0; index < 5; index += 1) {
    parts.push(digest.readUInt32LE(index * 4));
  }
  return `S-1-5-80-${parts.join("-")}`;
}

test("frozen identity constants match the availability-broker native source", () => {
  const brokerServiceName = extractCppWideLiteral(brokerHeader, "kAvailabilityBrokerServiceName");
  const brokerExecutableName = extractCppWideLiteral(brokerHeader, "kAvailabilityBrokerExecutableName");
  const signerServiceName = extractCppWideLiteral(brokerRuntime, "kTargetServiceName");
  const signerExecutableName = extractCppWideLiteral(brokerRuntime, "kTargetExecutableName");
  const programDataSuffix = extractCppWideLiteral(brokerRuntime, "kProgramDataSuffix").replace(/\\\\/gu, "\\");

  assert.equal(extractPsString(common, "BrokerServiceName"), brokerServiceName);
  assert.equal(extractPsString(common, "BrokerExecutableName"), brokerExecutableName);
  assert.equal(extractPsString(common, "SignerServiceName"), signerServiceName);
  assert.equal(extractPsString(common, "SignerExecutableName"), signerExecutableName);
  assert.equal(extractPsString(common, "ProgramDataSuffix"), programDataSuffix);
  assert.equal(programDataSuffix, "\\ProgramData\\GoatCitadel\\RemoteWorkerProvisioner\\bin\\");

  // The quoted DOS binary path is composed exactly the way the broker builds
  // its expectation (BuildQuotedPath over an uppercase drive), and the broker
  // compares it character-for-character (EqualPath is case-sensitive).
  assert.match(common, /BrokerQuotedBinaryPath = '"' \+ \$brokerImagePath \+ '"'/u);
  assert.match(common, /SignerQuotedBinaryPath = '"' \+ \$signerImagePath \+ '"'/u);
  assert.match(common, /ToUpperInvariant\(\) \+ ":"/u);
  assert.match(brokerRuntime, /BuildQuotedPath/u);
  assert.match(brokerRuntime, /drive - L'a' \+ L'A'/u);
});

test("the coordinator principal is the broker's pinned virtual service account", () => {
  const brokerSidFromNative = extractCppSidParts(brokerRuntime, "kBrokerServiceSidParts");
  const signerSidFromNative = extractCppSidParts(brokerRuntime, "kTargetServiceSidParts");
  const brokerServiceName = extractPsString(common, "BrokerServiceName");
  const signerServiceName = extractPsString(common, "SignerServiceName");

  // The frozen SID strings, the compiled native pins, and the deterministic
  // SHA-1 service-SID derivation must all agree.
  assert.equal(extractPsString(common, "BrokerServiceSid"), brokerSidFromNative);
  assert.equal(extractPsString(common, "SignerServiceSid"), signerSidFromNative);
  assert.equal(deriveVirtualServiceAccountSid(brokerServiceName), brokerSidFromNative);
  assert.equal(deriveVirtualServiceAccountSid(signerServiceName), signerSidFromNative);
  assert.equal(extractPsString(common, "CoordinatorPrincipalName"), `NT SERVICE\\${brokerServiceName}`);

  // The recipe materializes the principal through the unrestricted service
  // SID type and re-derives it defensively at preflight and verify time.
  assert.match(common, /Get-VirtualServiceAccountSid/u);
  assert.match(installer, /Test-RecipeCoordinatorDerivation/u);
  assert.match(installer, /wrong principal, refusing/u);
  assert.match(installer, /osTranslatedSid/u);
});

test("the broker SCM DACL, demand-start configuration, and privilege list are frozen to the broker's validation law", () => {
  // availability_broker.cpp kAdministratorServiceMask.
  const SERVICE_QUERY_CONFIG = 0x0001;
  const SERVICE_QUERY_STATUS = 0x0004;
  const SERVICE_START = 0x0010;
  const SERVICE_STOP = 0x0020;
  const READ_CONTROL = 0x00020000;
  const SYNCHRONIZE = 0x00100000;
  const administratorMask =
    SERVICE_START | SERVICE_STOP | SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | READ_CONTROL | SYNCHRONIZE;
  assert.equal(administratorMask, 0x00120035);
  const SERVICE_ALL_ACCESS = 0x000f01ff;

  const serviceObjectSddl = extractPsString(common, "ServiceObjectSddl");
  assert.equal(serviceObjectSddl, "O:SYD:P(A;;0x000f01ff;;;SY)(A;;0x00120035;;;BA)");
  assert.ok(serviceObjectSddl.includes(`0x${SERVICE_ALL_ACCESS.toString(16).padStart(8, "0")}`));
  assert.ok(serviceObjectSddl.includes(`0x${administratorMask.toString(16).padStart(8, "0")}`));
  assert.match(
    brokerValidation,
    /SERVICE_START \| SERVICE_STOP \| SERVICE_QUERY_CONFIG \|\n\s*SERVICE_QUERY_STATUS \| READ_CONTROL \| SYNCHRONIZE/u,
  );
  assert.match(brokerValidation, /system_ace\.mask == SERVICE_ALL_ACCESS/u);
  assert.match(brokerValidation, /snapshot\.service_ace_count != 2U/u);
  assert.match(brokerValidation, /service_dacl_protected/u);

  // Demand-start law: the broker validates SERVICE_DEMAND_START for itself
  // and for the signer target; the recipe creates both with it and pins the
  // rest of the exact configuration.
  assert.equal([...brokerValidation.matchAll(/SERVICE_DEMAND_START/gu)].length, 2);
  assert.match(common, /\$script:ExpectedStartType = 3\s+# SERVICE_DEMAND_START/u);
  assert.match(common, /\$script:ExpectedServiceType = 16\s+# SERVICE_WIN32_OWN_PROCESS/u);
  assert.match(common, /\$script:ExpectedErrorControl = 1\s+# SERVICE_ERROR_NORMAL/u);
  assert.match(common, /ServiceWin32OwnProcess = 0x00000010u/u);
  assert.match(common, /ServiceDemandStart = 0x00000003u/u);
  assert.match(common, /ServiceErrorNormal = 0x00000001u/u);
  assert.match(common, /"LocalSystem",\n\s+null\);/u);
  assert.equal(extractPsString(common, "ExpectedServiceAccount"), "LocalSystem");
  assert.match(brokerValidation, /kLocalSystemAccount\[\] = L"LocalSystem"/u);

  // Unrestricted service SID type and the exact single-privilege multi-string.
  assert.match(common, /\$script:ExpectedServiceSidType = 3\s+# SERVICE_SID_TYPE_UNRESTRICTED/u);
  assert.match(common, /ServiceSidTypeUnrestricted = 3u/u);
  assert.match(brokerValidation, /SERVICE_SID_TYPE_UNRESTRICTED/u);
  assert.equal(extractCppWideLiteral(brokerValidation, "kRequiredPrivileges"), "SeChangeNotifyPrivilege\\0");
  assert.equal(extractPsString(common, "ExpectedRequiredPrivilege"), "SeChangeNotifyPrivilege");
  assert.ok(common.includes('string multiSz = "SeChangeNotifyPrivilege\\0";'));
});

test("the protected image and directory ACLs pin the broker's exact masks and SID order", () => {
  // availability_broker_runtime.cpp kProtectedFullMask / kProtectedReadMask.
  const FILE_ALL_ACCESS = 0x001f01ff;
  const FILE_GENERIC_READ = 0x00120089;
  const FILE_GENERIC_EXECUTE = 0x001200a0;
  const protectedReadMask = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
  assert.equal(protectedReadMask, 0x001200a9);
  assert.match(brokerRuntime, /kProtectedReadMask = 0x001200A9U/u);
  assert.match(brokerRuntime, /kProtectedFullMask = 0x001F01FFU/u);

  const brokerSid = extractPsString(common, "BrokerServiceSid");
  const signerSid = extractPsString(common, "SignerServiceSid");
  assert.equal(
    extractPsString(common, "SignerImageSddl"),
    `O:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001200a9;;;${signerSid})(A;;0x001200a9;;;BA)`,
  );
  assert.equal(
    extractPsString(common, "BrokerImageSddl"),
    `O:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001200a9;;;${brokerSid})(A;;0x001200a9;;;BA)`,
  );
  assert.equal(extractPsString(common, "ProtectedDirectorySddl"), "O:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001200a9;;;BA)");
  assert.equal(extractPsString(common, "SharedRootSddl"), "O:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001f01ff;;;BA)");
  assert.equal(FILE_ALL_ACCESS, 0x001f01ff);
  // The broker's exact three-ACE order for the signer image: SYSTEM full,
  // then the signer service SID, then Administrators, all read-only.
  assert.match(brokerRuntime, /system\.bytes\.data\(\), service\.bytes\.data\(\), administrators\.bytes\.data\(\)/u);
  assert.match(brokerRuntime, /kProtectedFullMask, kProtectedReadMask, kProtectedReadMask/u);

  // 64 MiB image bound, single hard link, and single-stream closure.
  assert.match(brokerRuntime, /kMaximumProtectedExecutableBytes = 64U \* 1024U \* 1024U/u);
  assert.match(common, /\$script:MaximumImageBytes = 67108864/u);
  assert.equal(64 * 1024 * 1024, 67108864);
  assert.match(brokerRuntime, /NumberOfLinks != 1U/u);
  assert.match(installer, /GetFileHardLinkCount/u);
  assert.match(brokerRuntime, /ValidateOnlyUnnamedDataStream/u);
  assert.ok(installer.includes("-ne ':$DATA'"));
  // The descriptors are applied through exact Win32 owner+protected-DACL
  // composition, never through icacls or inherited ACEs.
  assert.match(common, /ProtectedDaclSecurityInformation = 0x80000000u/u);
  assert.match(common, /SetNamedSecurityInfoW/u);
  assert.doesNotMatch(common, /icacls/u);
  assert.doesNotMatch(installer, /icacls/u);
});

test("the SHA-256 pin flow is mandatory, package-anchored, and fail-closed", () => {
  assert.match(installer, /No SHA-256 pin source: provide -PackageResultPath/u);
  assert.match(installer, /availability\.targetServiceSha256/u);
  assert.match(installer, /internally inconsistent/u);
  assert.match(installer, /conflicts with the package result/u);
  assert.match(installer, /Image hash mismatch for the staged/u);
  assert.match(installer, /the package-verified pin is authoritative/u);
  // Destination re-verification happens after the copy and again after the
  // descriptors are applied.
  const copyIndex = installer.indexOf("Copy-Item -LiteralPath");
  const destinationRecheck = installer.indexOf("does not match the pin");
  const postProtectionRecheck = installer.indexOf("drifted after protection");
  assert.ok(copyIndex >= 0 && destinationRecheck > copyIndex && postProtectionRecheck > destinationRecheck);
  assert.match(installer, /ValidatePattern\("\^\[0-9a-fA-F\]\{64\}\$"\)/u);
});

test("the refusal branches are frozen", () => {
  assert.match(installer, /already exists; this recipe never reconfigures an existing service/u);
  assert.match(installer, /already exists; refusing to compose over a pre-existing tree/u);
  assert.match(installer, /not SYSTEM or Administrators; an untrusted principal may have planted it, refusing/u);
  assert.match(installer, /must run from an elevated administrator context/u);
  assert.match(installer, /ProgramData is relocated/u);
  assert.match(installer, /carries alternate data streams/u);
  assert.match(installer, /wrong principal, refusing/u);
  assert.match(installer, /only runs on Windows/u);
  assert.match(uninstaller, /refusing to delete a service this recipe did not compose/u);
  // Refusals exit 2 and are distinct from failures (exit 1).
  for (const [, source] of [allRecipeScripts[1], allRecipeScripts[2]]) {
    assert.match(source, /"REFUSED: \{0\}" -f \$Message/u);
    assert.match(source, /\$exitCode = 2/u);
    assert.match(source, /exit \$exitCode/u);
  }
  // Preflight mode is read-only and collects every refusal; install mode
  // fails fast before any mutation.
  assert.match(installer, /READ-ONLY: every check below only queries/u);
  assert.match(installer, /\$Preflight/u);
  const preflightScmIndex = installer.indexOf('"preflight-scm-clean"');
  const stageIndex = installer.indexOf('"stage"');
  const installServicesIndex = installer.indexOf('"install-services"');
  assert.ok(preflightScmIndex >= 0 && stageIndex > preflightScmIndex && installServicesIndex > stageIndex);
});

test("nothing in the repo wires the untrusted helper to start the broker or signer", () => {
  // The recipe scripts issue no service start of any kind. (Start-Sleep is
  // the only Start-* verb allowed.)
  for (const [name, source] of allRecipeScripts) {
    assert.doesNotMatch(source, /Start-Service\b/u, `${name} must not call Start-Service`);
    assert.doesNotMatch(source, /StartServiceW/u, `${name} must not reference StartServiceW`);
    assert.doesNotMatch(source, /::StartService/u, `${name} must not P/Invoke a service start`);
    assert.doesNotMatch(source, /\bsc(\.exe)?\s+start\b/iu, `${name} must not shell out to sc start`);
    const startVerbs = [...source.matchAll(/Start-(\w+)/gu)].map((entry) => entry[1]);
    assert.deepEqual(
      [...new Set(startVerbs)].filter((verb) => verb !== "Sleep"),
      [],
      `${name} may only use Start-Sleep`,
    );
  }

  // The broker binary keeps the repo's only StartServiceW call, with the
  // exact no-operand shape (mirrors the packaging contract test).
  assert.equal([...brokerRuntime.matchAll(/\bStartServiceW\s*\(/gu)].length, 1);
  assert.match(brokerRuntime, /StartServiceW\(target, 0U, nullptr\)/u);

  // The deterministic package proof still pins StartServiceW to the
  // availability broker only: neither the signer service closure nor the
  // untrusted client closure may import it.
  assert.match(packagingScript, /availabilityAuthorityImports = Object\.freeze\(\["StartServiceW"\]\)/u);
  const serviceSliceStart = packagingScript.indexOf("service: Object.freeze({");
  const clientSliceStart = packagingScript.indexOf("client: Object.freeze({");
  const availabilitySliceStart = packagingScript.indexOf("availability: Object.freeze({");
  assert.ok(
    serviceSliceStart >= 0 && clientSliceStart > serviceSliceStart && availabilitySliceStart > clientSliceStart,
  );
  const serviceSlice = packagingScript.slice(serviceSliceStart, clientSliceStart);
  const clientSlice = packagingScript.slice(clientSliceStart, availabilitySliceStart);
  assert.ok(!serviceSlice.includes('"StartServiceW"'), "the signer closure must not import StartServiceW");
  assert.ok(!clientSlice.includes('"StartServiceW"'), "the client closure must not import StartServiceW");
  for (const forbidden of ["CreateServiceW", "ChangeServiceConfig2W", "ControlService", "DeleteService"]) {
    assert.ok(
      !clientSlice.includes(`"${forbidden}"`),
      `the untrusted client closure must stay query-only (no ${forbidden})`,
    );
  }
});

test("the recipe is production-dark: services stay stopped and the client is never deployed", () => {
  assert.match(installer, /a production-dark install must leave it SERVICE_STOPPED/u);
  assert.match(installer, /a production-dark install must leave no process/u);
  assert.match(common, /\$script:ServiceStoppedState = 1\s+# SERVICE_STOPPED/u);
  assert.match(installer, /startsAnyService = \$false/u);
  assert.match(installer, /deploysUntrustedClient = \$false/u);
  // Only the two service images are copied; the untrusted client executable
  // is named solely to document that it is never deployed.
  const copyCount = [...installer.matchAll(/Copy-Item -LiteralPath/gu)].length;
  assert.equal(copyCount, 2);
  assert.doesNotMatch(installer, /Copy-Item[^\n]*Client/u);
  assert.match(common, /\$script:ClientExecutableName = "GoatCitadelRemoteWorkerProvisionerClient\.exe"/u);
  assert.match(common, /never deploys the\s+untrusted client executable/u);
  // ERROR_SERVICE_NEVER_STARTED stays documented for the held installed-host
  // broker contract proof: the broker requires NO_ERROR status metadata.
  assert.match(common, /\$script:ServiceNeverStartedExitCode = 1077/u);
  assert.match(installer, /ERROR_SERVICE_NEVER_STARTED \(1077\)/u);
  assert.match(brokerValidation, /win32_exit_code != NO_ERROR/u);
});

test("uninstall is identity-bound, restore-then-delete ordered, and preserves shared roots", () => {
  const identityIndex = uninstaller.indexOf('"preflight-footprint-identity"');
  const stopIndex = uninstaller.indexOf('"stop-services"');
  const deleteIndex = uninstaller.indexOf('"delete-services"');
  const removeIndex = uninstaller.indexOf('"remove-files"');
  assert.ok(identityIndex >= 0 && stopIndex > identityIndex && deleteIndex > stopIndex && removeIndex > deleteIndex);
  assert.match(uninstaller, /not the pinned image path/u);
  const restoreIndex = uninstaller.indexOf("# Restore an administrator-writable descriptor");
  const fileRemovalIndex = uninstaller.indexOf("Remove-Item -LiteralPath $filePath -Force");
  assert.ok(restoreIndex >= 0 && fileRemovalIndex > restoreIndex);
  assert.match(uninstaller, /UninstallRestoreSddl/u);
  assert.equal(extractPsString(common, "UninstallRestoreSddl"), "O:BAD:P(A;;0x001f01ff;;;SY)(A;;0x001f01ff;;;BA)");
  assert.match(uninstaller, /GoatCitadel root preserved \(contains sibling content\)/u);
  assert.match(uninstaller, /did not reach SERVICE_STOPPED within/u);
  assert.match(uninstaller, /delete pending \(SCM releases on last handle close\)/u);
  assert.match(uninstaller, /post-uninstall residue/u);
  // The installer's mid-run rollback mirrors the same rigor.
  assert.match(installer, /Invoke-RecipeRollback/u);
  assert.match(installer, /rollback: failed to delete service/u);
});

test("evidence bundles are machine-readable, always written, and never deleted", () => {
  assert.match(common, /goatcitadel\.remote-worker\.broker-coordinator-install\/1/u);
  assert.match(common, /goatcitadel\.remote-worker\.broker-coordinator-uninstall\/1/u);
  assert.match(common, /ConvertTo-Json -InputObject \$Payload -Depth 8/u);
  assert.match(installer, /broker-coordinator-install-evidence\.json/u);
  assert.match(uninstaller, /broker-coordinator-uninstall-evidence\.json/u);
  for (const [name, source] of [allRecipeScripts[1], allRecipeScripts[2]]) {
    assert.match(source, /Refusing to reuse an existing evidence output root/u);
    assert.match(source, /finally\s*\{/u);
    assert.doesNotMatch(source, /Remove-Item[^\n]*OutputRoot/u, `${name} must never delete its evidence root`);
    assert.match(source, /steps = \$script:Steps\.ToArray\(\)/u);
    assert.match(source, /cleanupFailures = \$script:CleanupFailures\.ToArray\(\)/u);
    assert.match(source, /refusals = \$script:Refusals\.ToArray\(\)/u);
  }
});

test("the scripts stay Windows PowerShell 5.1 compatible", () => {
  for (const [name, source] of allRecipeScripts) {
    assert.match(source, /^#Requires -Version 5\.1/u, `${name} must require PowerShell 5.1`);
    assert.doesNotMatch(source, /\?\?/u, `${name}: null-coalescing is PowerShell 7 only`);
    assert.doesNotMatch(source, /\$\w+\?\./u, `${name}: null-conditional access is PowerShell 7 only`);
    assert.doesNotMatch(source, /&&|\|\|/u, `${name}: pipeline chain operators are PowerShell 7 only`);
    assert.match(source, /Set-StrictMode -Version Latest/u);
  }
});

test("the scripts AST-parse cleanly under available PowerShell engines", { timeout: 240_000 }, (t) => {
  const scriptPaths = allRecipeScripts.map(([name]) => path.join(scriptsDir, name));
  const quoted = scriptPaths.map((entry) => `'${entry.replace(/'/gu, "''")}'`).join(", ");
  const parseCommand = [
    "$failures = 0;",
    `foreach ($scriptPath in @(${quoted})) {`,
    "  $tokens = $null; $errors = $null;",
    "  [void][System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors);",
    "  if ($errors -and $errors.Count -gt 0) {",
    '    $errors | ForEach-Object { [Console]::Error.WriteLine(("{0}: {1}" -f $scriptPath, $_.Message)) };',
    "    $failures = $failures + 1;",
    "  }",
    "}",
    "if ($failures -gt 0) { exit 3 } else { exit 0 }",
  ].join(" ");

  const engines = [];
  for (const candidate of ["pwsh", "powershell"]) {
    const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) {
      engines.push(candidate);
    }
  }
  if (engines.length === 0) {
    t.skip("no PowerShell engine is available on this host");
    return;
  }
  for (const engine of engines) {
    const result = spawnSync(engine, ["-NoProfile", "-NonInteractive", "-Command", parseCommand], {
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${engine} reported parse errors:\n${result.stderr ?? ""}${result.stdout ?? ""}`);
  }
});
