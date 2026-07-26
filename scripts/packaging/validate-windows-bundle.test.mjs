import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildReleaseManifest } from "./lib/package-renderers.mjs";
import { requirePackagingTarget } from "./lib/packaging-targets.mjs";

const scriptPath = fileURLToPath(new URL("./validate-windows-bundle.ps1", import.meta.url));
const target = requirePackagingTarget("windows-x64");

test(
  "Windows installer payload validator proves hashes and required PE architecture before promotion",
  { skip: process.platform === "win32" ? false : "Windows PowerShell and PE validation require Windows." },
  () => {
    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-installer-stage-"));
    try {
      const requiredFiles = [
        "app/desktop/GoatCitadel-Mission-Control-Windows.exe",
        "app/gateway/dist/main.js",
        "app/mission-control/dist/index.html",
        "app/runtime/node/node.exe",
        "bin/goatcitadel.cmd",
      ];
      for (const relativePath of requiredFiles) {
        const filePath = path.join(stageRoot, ...relativePath.split("/"));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (relativePath.endsWith(".exe")) {
          writeMinimalPe(filePath, 0x8664);
        } else {
          fs.writeFileSync(filePath, `${relativePath}\n`, "utf8");
        }
      }
      const payloadFiles = requiredFiles.map((relativePath) => {
        const filePath = path.join(stageRoot, ...relativePath.split("/"));
        return {
          path: relativePath,
          sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
          sizeBytes: fs.statSync(filePath).size,
        };
      });
      const manifest = buildReleaseManifest({
        targetInfo: target,
        version: "1.0.0",
        nodeVersion: "v22.22.2",
        payloadFiles,
        uiTarget: {
          packageName: "@goatcitadel/mission-control-next",
          packageDirName: "mission-control-next",
          displayName: "Mission Control Next",
        },
        includeDesktopHost: true,
        desktopArtifactName: target.desktopArtifactName,
        sourceCommit: "a".repeat(40),
        sourceModified: false,
      });
      fs.writeFileSync(
        path.join(stageRoot, "app", "release-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      fs.writeFileSync(path.join(stageRoot, ".goatcitadel-transaction"), "installer transaction\n", "utf8");

      const valid = runValidator(stageRoot);
      assert.equal(valid.status, 0, valid.stderr || valid.stdout);
      assert.match(valid.stdout, /Validated staged GoatCitadel bundle windows-x64 1\.0\.0/);

      // Installed-root validation runs while Inno's own root artifacts and the custom
      // transaction directories coexist with app/ and bin/. Those root siblings are not
      // payload-manifest inputs and must not create a false rejection.
      fs.writeFileSync(path.join(stageRoot, ".goatcitadel-install"), "installer ownership\n", "utf8");
      fs.writeFileSync(path.join(stageRoot, "unins000.dat"), "Inno uninstall fixture\n", "utf8");
      fs.mkdirSync(path.join(stageRoot, ".goatcitadel-install-stage"));
      fs.mkdirSync(path.join(stageRoot, ".goatcitadel-install-backup"));
      const validInstalledRoot = runValidator(stageRoot, { installedRoot: true });
      assert.equal(validInstalledRoot.status, 0, validInstalledRoot.stderr || validInstalledRoot.stdout);
      assert.match(validInstalledRoot.stdout, /Validated installed GoatCitadel bundle windows-x64 1\.0\.0/);
      fs.rmSync(path.join(stageRoot, ".goatcitadel-install-stage"), { recursive: true });
      fs.rmSync(path.join(stageRoot, ".goatcitadel-install-backup"), { recursive: true });
      fs.rmSync(path.join(stageRoot, ".goatcitadel-install"));
      fs.rmSync(path.join(stageRoot, "unins000.dat"));

      const hostPath = path.join(stageRoot, "app", "desktop", target.desktopArtifactName);
      const hostRecord = manifest.payload.files.find(
        (record) => record.path === "app/desktop/GoatCitadel-Mission-Control-Windows.exe",
      );
      assert.ok(hostRecord);
      const originalHostHash = hostRecord.sha256;
      writeMinimalPe(hostPath, 0xaa64);
      hostRecord.sha256 = createHash("sha256").update(fs.readFileSync(hostPath)).digest("hex");
      writeManifest(stageRoot, manifest);
      const wrongArchitecture = runValidator(stageRoot);
      assert.notEqual(wrongArchitecture.status, 0);
      assert.match(`${wrongArchitecture.stdout}\n${wrongArchitecture.stderr}`, /targets machine 0xAA64; expected 0x8664/i);
      writeMinimalPe(hostPath, 0x8664);
      hostRecord.sha256 = originalHostHash;
      writeManifest(stageRoot, manifest);

      const launcherPath = path.join(stageRoot, "bin", "goatcitadel.cmd");
      const originalLauncher = fs.readFileSync(launcherPath);
      fs.writeFileSync(launcherPath, "X".repeat(fs.statSync(launcherPath).size), "ascii");
      const corrupt = runValidator(stageRoot);
      assert.notEqual(corrupt.status, 0);
      assert.match(`${corrupt.stdout}\n${corrupt.stderr}`, /hash does not match its manifest record/i);

      fs.writeFileSync(launcherPath, originalLauncher);
      fs.rmSync(hostPath);
      const missingHost = runValidator(stageRoot);
      assert.notEqual(missingHost.status, 0);
      assert.match(`${missingHost.stdout}\n${missingHost.stderr}`, /payload file is missing|required manifested file/i);
    } finally {
      fs.rmSync(stageRoot, { recursive: true, force: true });
    }
  },
);

function runValidator(stageRoot, { installedRoot = false } = {}) {
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-StageRoot",
    stageRoot,
    "-Target",
    "windows-x64",
    "-Version",
    "1.0.0",
  ];
  if (installedRoot) {
    args.push("-InstalledRoot");
  }
  return spawnSync(
    "powershell.exe",
    args,
    { encoding: "utf8", windowsHide: true },
  );
}

function writeMinimalPe(filePath, machine) {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(machine, 68);
  fs.writeFileSync(filePath, bytes);
}

function writeManifest(stageRoot, manifest) {
  fs.writeFileSync(
    path.join(stageRoot, "app", "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}
