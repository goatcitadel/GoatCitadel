#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeDirectorySafely } from "./safe-cleanup.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

const PACKAGE_NAME = "GoatCitadel.MissionControl.Windows";
const APPLICATION_ID = "App";
const DISPLAY_NAME = "GoatCitadel Mission Control";
const IDENTITY_FILE_NAME = "GoatCitadel-Mission-Control-Windows-Identity.msix";
const WINDOWS_SDK_BIN = path.join(
  process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  "Windows Kits",
  "10",
  "bin",
);
const WINDOWS_SDK_APP_CERT_KIT = path.join(
  process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  "Windows Kits",
  "10",
  "App Certification Kit",
);

const args = parseArgs(process.argv.slice(2));

if (args.emitPlan) {
  console.log(
    [
      "Stage B package identity lane:",
      "1. Build/sign the WinUI host with pnpm package:windows-host.",
      "2. Build/sign the sparse external-location identity package with pnpm package:windows-msix --cert-path <pfx> --cert-password <password>.",
      "3. Build the Windows bundle so app/identity/GoatCitadel-Mission-Control-Windows-Identity.msix is included.",
      "4. Build the Inno installer and register the package with Add-AppxPackage -ExternalLocation during install.",
      "5. Smoke install, verify Get-AppxPackage, protocol manifest registration, signed package verification, and uninstall cleanup.",
    ].join("\n"),
  );
  process.exit(0);
}

if (process.platform !== "win32") {
  throw new Error("The Windows package identity MSIX builder must run on Windows.");
}

const version = toMsixVersion(args.version ?? packageJson.version);
const publisher = args.publisher ?? process.env.GOATCITADEL_WINDOWS_MSIX_PUBLISHER ?? "CN=GoatCitadel";
const outDir = path.resolve(args.outDir ?? path.join(repoRoot, "artifacts", "installers", "windows-msix"));
const contentDir = path.join(outDir, "identity-content");
const packagePath = path.join(outDir, IDENTITY_FILE_NAME);
const manifestPath = path.join(contentDir, "AppxManifest.xml");

await main();

async function main() {
  removeDirectory(contentDir);
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(manifestPath, renderIdentityManifest({ publisher, version }), "utf8");

  const makeAppx = resolveWindowsSdkTool("makeappx.exe", { allowAppCertificationKit: true });
  run(makeAppx, ["pack", "/o", "/d", contentDir, "/nv", "/p", packagePath]);

  const signing = materializeSigningInput();
  let signed = false;
  try {
    if (signing) {
      const signtool = resolveWindowsSdkTool("signtool.exe");
      run(signtool, [
        "sign",
        "/fd",
        "SHA256",
        "/f",
        signing.certPath,
        "/p",
        signing.password,
        "/tr",
        "http://timestamp.digicert.com",
        "/td",
        "SHA256",
        packagePath,
      ]);
      run(signtool, ["verify", "/pa", packagePath]);
      signed = true;
    } else if (!args.allowUnsigned) {
      throw new Error(
        "Signing is required for package:windows-msix. Pass --cert-path/--cert-password, set WINDOWS_SIGN_CERT_BASE64/WINDOWS_SIGN_CERT_PASSWORD, or pass --allow-unsigned for local manifest-only proof.",
      );
    } else {
      console.warn(
        "Built unsigned Windows identity package for local proof only. Do not publish unsigned MSIX assets.",
      );
    }
  } finally {
    signing?.cleanup?.();
  }

  const sha256 = await sha256File(packagePath);
  fs.writeFileSync(`${packagePath}.sha256`, `${sha256} *${path.basename(packagePath)}\n`, "utf8");
  fs.writeFileSync(
    path.join(outDir, "identity-manifest.json"),
    `${JSON.stringify(
      {
        id: "mission-control-windows-identity-package",
        kind: "msix-external-location-identity",
        fileName: path.basename(packagePath),
        packageName: PACKAGE_NAME,
        publisher,
        applicationId: APPLICATION_ID,
        version,
        processorArchitecture: "neutral",
        executable: "app/desktop/GoatCitadel-Mission-Control-Windows.exe",
        protocol: "goatcitadel",
        signed,
        sha256,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`Built Windows identity package: ${packagePath}`);
}

function parseArgs(argv) {
  const parsed = { allowUnsigned: false, emitPlan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--allow-unsigned") {
      parsed.allowUnsigned = true;
      continue;
    }
    if (value === "--emit-plan") {
      parsed.emitPlan = true;
      continue;
    }
    if (value === "--cert-path") {
      parsed.certPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--cert-password") {
      parsed.certPassword = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--out-dir") {
      parsed.outDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--publisher") {
      parsed.publisher = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--version") {
      parsed.version = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function renderIdentityManifest({ publisher: packagePublisher, version: packageVersion }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  IgnorableNamespaces="uap uap10 rescap"
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">
  <Identity
    Name="${escapeXml(PACKAGE_NAME)}"
    Publisher="${escapeXml(packagePublisher)}"
    Version="${escapeXml(packageVersion)}"
    ProcessorArchitecture="neutral" />
  <Properties>
    <DisplayName>${escapeXml(DISPLAY_NAME)}</DisplayName>
    <PublisherDisplayName>GoatCitadel</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <uap10:AllowExternalContent>true</uap10:AllowExternalContent>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <rescap:Capability Name="unvirtualizedResources" />
  </Capabilities>
  <Applications>
    <Application
      Id="${escapeXml(APPLICATION_ID)}"
      Executable="app\\desktop\\GoatCitadel-Mission-Control-Windows.exe"
      uap10:TrustLevel="mediumIL"
      uap10:RuntimeBehavior="win32App">
      <uap:VisualElements
        AppListEntry="none"
        DisplayName="${escapeXml(DISPLAY_NAME)}"
        Description="${escapeXml(DISPLAY_NAME)}"
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png" />
      <Extensions>
        <uap:Extension Category="windows.protocol">
          <uap:Protocol Name="goatcitadel" />
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
`;
}

function materializeSigningInput() {
  const certPassword = args.certPassword ?? process.env.WINDOWS_SIGN_CERT_PASSWORD;
  if (args.certPath) {
    if (!certPassword) {
      throw new Error("--cert-password or WINDOWS_SIGN_CERT_PASSWORD is required when --cert-path is provided.");
    }
    return { certPath: path.resolve(args.certPath), password: certPassword };
  }

  if (!process.env.WINDOWS_SIGN_CERT_BASE64) {
    return null;
  }
  if (!certPassword) {
    throw new Error("WINDOWS_SIGN_CERT_PASSWORD is required when WINDOWS_SIGN_CERT_BASE64 is provided.");
  }

  const certPath = path.join(os.tmpdir(), `goatcitadel-msix-signing-${process.pid}-${Date.now()}.pfx`);
  fs.writeFileSync(certPath, Buffer.from(process.env.WINDOWS_SIGN_CERT_BASE64, "base64"));
  return {
    certPath,
    password: certPassword,
    cleanup: () => fs.rmSync(certPath, { force: true }),
  };
}

function resolveWindowsSdkTool(toolName, { allowAppCertificationKit = false } = {}) {
  const candidates = [];
  if (fs.existsSync(WINDOWS_SDK_BIN)) {
    for (const versionDir of fs.readdirSync(WINDOWS_SDK_BIN, { withFileTypes: true })) {
      if (!versionDir.isDirectory()) {
        continue;
      }
      candidates.push(path.join(WINDOWS_SDK_BIN, versionDir.name, "x64", toolName));
    }
  }
  if (allowAppCertificationKit) {
    candidates.push(path.join(WINDOWS_SDK_APP_CERT_KIT, toolName));
  }

  const existing = candidates
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  if (existing.length === 0) {
    throw new Error(`${toolName} was not found in the Windows SDK.`);
  }
  return existing[0];
}

function toMsixVersion(value) {
  const normalized = value.replace(/^v/i, "").split(/[+-]/)[0];
  const parts = normalized.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65535) ||
    parts.length < 1 ||
    parts.length > 4
  ) {
    throw new Error(`Invalid MSIX version: ${value}`);
  }
  while (parts.length < 4) {
    parts.push(0);
  }
  return parts.join(".");
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} exited with code ${result.status}`);
  }
}

function removeDirectory(targetPath) {
  removeDirectorySafely(targetPath, {
    repoRoot,
    allowedRoot: outDir,
    cwd: process.cwd(),
  });
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
