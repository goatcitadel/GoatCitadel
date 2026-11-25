import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildReleaseManifest } from "./lib/package-renderers.mjs";
import { requirePackagingTarget } from "./lib/packaging-targets.mjs";

const scriptPath = fileURLToPath(new URL("./validate-windows-bundle.ps1", import.meta.url));
const target = requirePackagingTarget("windows-x64");
const AdmZip = createRequire(new URL("../../apps/gateway/package.json", import.meta.url))("adm-zip");

test(
  "Windows installer payload validator proves hashes and required PE architecture before promotion",
  { skip: process.platform === "win32" ? false : "Windows PowerShell and PE validation require Windows." },
  (context) => {
    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-installer-stage-"));
    const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-installer-archive-"));
    try {
      const requiredFiles = [
        "app/desktop/GoatCitadel-Mission-Control-Windows.exe",
        "app/gateway/dist/main.js",
        "app/mission-control/dist/index.html",
        "app/runtime/node/node.exe",
        "bin/goatcitadel.cmd",
        "app/\uE000.txt",
        "app/\u{10000}.txt",
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
      assert.match(valid.stdout, /GOATCITADEL_PROGRESS Hashing 0\/7/);
      assert.match(valid.stdout, /GOATCITADEL_PROGRESS Verified 7\/7/);
      const validCore = runValidator(stageRoot, { shell: "pwsh.exe" });
      if (validCore.error?.code === "ENOENT") {
        context.diagnostic("PowerShell 7 is unavailable on this test host.");
      } else {
        assert.equal(validCore.status, 0, validCore.stderr || validCore.stdout);
        assert.match(validCore.stdout, /GOATCITADEL_PROGRESS Verified 7\/7/);
      }
      const originalDesktopPath = manifest.payload.files[0].path;
      manifest.payload.files[0].path = originalDesktopPath.replace("app/desktop/", "app/Desktop/");
      writeManifest(stageRoot, manifest);
      assert.equal(runValidator(stageRoot).status, 0, "Windows directory casing aliases remain valid");
      manifest.payload.files[0].path = originalDesktopPath;
      writeManifest(stageRoot, manifest);

      const archive = new AdmZip();
      archive.addLocalFolder(path.join(stageRoot, "app"), "app");
      archive.addLocalFolder(path.join(stageRoot, "bin"), "bin");
      const baselineArchive = archive.toBuffer();
      let archiveCase = 0;
      const runArchive = (change = () => {}) => {
        const zip = new AdmZip(baselineArchive);
        change(zip);
        const archivePath = path.join(archiveRoot, `${archiveCase++}.zip`);
        zip.writeZip(archivePath);
        const destination = fs.mkdtempSync(path.join(archiveRoot, "stage-"));
        return { result: runValidator(destination, { archivePath }), destination, archivePath };
      };
      const streamed = runArchive();
      assert.equal(streamed.result.status, 0, streamed.result.stderr);
      assert.match(streamed.result.stdout, /GOATCITADEL_PROGRESS Extracting-and-hashing 7\/7/);
      assert.doesNotMatch(streamed.result.stdout, /GOATCITADEL_PROGRESS Hashing/);
      assert.deepEqual(
        fs.readFileSync(path.join(streamed.destination, "bin", "goatcitadel.cmd")),
        fs.readFileSync(path.join(stageRoot, "bin", "goatcitadel.cmd")),
      );
      const assertArchiveRejected = (change, pattern) => {
        const { result } = runArchive(change);
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout} ${result.stderr}`.replace(/\s+/gu, " "), pattern);
        assert.doesNotMatch(result.stdout, /GOATCITADEL_PROGRESS Verified/);
      };
      assertArchiveRejected(
        (zip) =>
          zip.updateFile(
            "bin/goatcitadel.cmd",
            Buffer.from("X".repeat(fs.statSync(path.join(stageRoot, "bin", "goatcitadel.cmd")).size)),
          ),
        /hash does not match/,
      );
      assertArchiveRejected((zip) => zip.deleteFile("bin/goatcitadel.cmd"), /missing a manifested payload file/);
      assertArchiveRejected((zip) => zip.addFile("app/unlisted.txt", Buffer.from("extra")), /unlisted file/);
      assertArchiveRejected(
        (zip) => zip.addFile("bin/GOATCITADEL.cmd", Buffer.from("collision")),
        /case-colliding path/,
      );
      assertArchiveRejected((zip) => zip.addFile("app/../escape", Buffer.from("escape")), /unsafe|unexpected root/);
      assertArchiveRejected((zip) => {
        zip.addFile("app/link", Buffer.from("target"));
        zip.getEntry("app/link").attr = 0xa1ff0000;
      }, /symlink, junction or special/);
      assert.notEqual(runValidator(stageRoot, { installedRoot: true, archivePath: streamed.archivePath }).status, 0);

      const firstPath = manifest.payload.files[0].path;
      manifest.payload.files[0].path = "app/../escape";
      writeManifest(stageRoot, manifest);
      assert.match(runValidator(stageRoot).stderr, /payload path is unsafe/);
      manifest.payload.files[0].path = firstPath;
      manifest.payload.files.reverse();
      writeManifest(stageRoot, manifest);
      assert.match(runValidator(stageRoot).stderr, /strictly path-sorted/);
      manifest.payload.files.reverse();
      writeManifest(stageRoot, manifest);
      fs.writeFileSync(path.join(stageRoot, "app", "unlisted.txt"), "unexpected");
      assert.match(runValidator(stageRoot).stderr, /unlisted file/);
      fs.rmSync(path.join(stageRoot, "app", "unlisted.txt"));
      const junction = path.join(stageRoot, "app", "linked-runtime");
      fs.symlinkSync(path.join(stageRoot, "app", "runtime"), junction, "junction");
      assert.match(runValidator(stageRoot).stderr, /symlink or junction/);
      fs.rmSync(junction);

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
      assert.match(
        `${wrongArchitecture.stdout}\n${wrongArchitecture.stderr}`,
        /targets machine 0xAA64; expected 0x8664/i,
      );
      writeMinimalPe(hostPath, 0x8664);
      hostRecord.sha256 = originalHostHash;
      writeManifest(stageRoot, manifest);

      const launcherPath = path.join(stageRoot, "bin", "goatcitadel.cmd");
      const originalLauncher = fs.readFileSync(launcherPath);
      fs.writeFileSync(launcherPath, "X".repeat(fs.statSync(launcherPath).size), "ascii");
      const corrupt = runValidator(stageRoot);
      assert.notEqual(corrupt.status, 0);
      assert.match(`${corrupt.stdout}\n${corrupt.stderr}`, /hash does not match its manifest\s+record/i);

      fs.writeFileSync(launcherPath, originalLauncher);
      fs.rmSync(hostPath);
      const missingHost = runValidator(stageRoot);
      assert.notEqual(missingHost.status, 0);
      assert.match(`${missingHost.stdout}\n${missingHost.stderr}`, /payload file is missing|required manifested file/i);
    } finally {
      fs.rmSync(stageRoot, { recursive: true, force: true });
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    }
  },
);

function runValidator(stageRoot, { installedRoot = false, archivePath, shell = "powershell.exe" } = {}) {
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
    "-ProgressOutput",
  ];
  if (installedRoot) {
    args.push("-InstalledRoot");
  }
  if (archivePath) args.push("-ArchivePath", archivePath);
  return spawnSync(shell, args, { encoding: "utf8", windowsHide: true });
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
