import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { requirePackagingTarget, nodeArchiveName, nodeArchiveRoot } from "./lib/packaging-targets.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const filename = path.join(root, "scripts/packaging/build-bundle.mjs");
const source = fs.readFileSync(filename, "utf8");
const start = "async function installEmbeddedNodeRuntime(",
  end = "async function verifyNodeArchiveChecksum(";
assert.equal(source.split(start).length, 2);
assert.equal(source.split(end).length, 2);
const body = source.slice(source.indexOf(start), source.indexOf(end));

async function fixture(row) {
  const parent = fs.realpathSync(os.tmpdir());
  const temp = fs.mkdtempSync(path.join(parent, "gc-node-runtime-"));
  const execPath = path.join(temp, "owned-node.bin"),
    destinationDir = path.join(temp, "out");
  const bytes = Buffer.from("synthetic owned Node bytes; not executable\n");
  fs.writeFileSync(execPath, bytes);
  const fetches = [],
    downloadsForbidden = new Error("fixture stopped at exact archive fetch; no network");
  let unexpectedVerification = false,
    unexpectedExpansion = false;
  const install = vm.runInNewContext(
    "(" + body + ")",
    {
      fs,
      path,
      os: { tmpdir: () => temp },
      requirePackagingTarget,
      nodeArchiveName,
      nodeArchiveRoot,
      process: { platform: row.platform, arch: row.arch, version: "v22.23.4", execPath },
      args: {},
      fetch: async (url) => {
        fetches.push(url);
        throw downloadsForbidden;
      },
      verifyNodeArchiveChecksum: async () => {
        unexpectedVerification = true;
        throw new Error("unexpected verifier");
      },
      expandNodeRuntimeArchive: () => {
        unexpectedExpansion = true;
        throw new Error("unexpected expansion");
      },
    },
    { filename },
  );
  try {
    const promise = install({ target: row.target, nodeVersion: row.version ?? "22.23.4", destinationDir });
    if (row.local) {
      await promise;
      assert.deepEqual(fetches, [], "Matching native runtime must not fetch");
      const copied = path.join(destinationDir, requirePackagingTarget(row.target).nodeExecutableName);
      assert.deepEqual(fs.readFileSync(copied), bytes, "Actual owner copied the invoking executable bytes");
      const original = fs.statSync(execPath),
        clone = fs.statSync(copied);
      assert.equal(clone.nlink, 1);
      assert.notEqual(clone.ino, original.ino);
      if (row.platform !== "win32" && process.platform !== "win32") assert.equal(clone.mode & 0o777, 0o755);
    } else {
      await assert.rejects(promise, (error) => error === downloadsForbidden);
      const version = "v" + (row.version ?? "22.23.4").replace(/^v/u, "");
      assert.deepEqual(fetches, [
        "https://nodejs.org/dist/" + version + "/" + nodeArchiveName(version, requirePackagingTarget(row.target)),
      ]);
      assert.equal(
        fs.existsSync(path.join(destinationDir, requirePackagingTarget(row.target).nodeExecutableName)),
        false,
      );
    }
    assert.equal(unexpectedVerification, false);
    assert.equal(unexpectedExpansion, false);
  } finally {
    assert.match(path.basename(temp), /^gc-node-runtime-[a-z0-9]+$/iu);
    assert.equal(path.dirname(temp), parent);
    const stats = fs.lstatSync(temp);
    assert(stats.isDirectory() && !stats.isSymbolicLink());
    assert.equal(fs.realpathSync(temp), temp);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
for (const row of [
  {
    name: "Windows x64 exact version copies local executable without fetch",
    platform: "win32",
    arch: "x64",
    target: "windows-x64",
    local: true,
  },
  {
    name: "Windows x64 v-prefixed version copies local executable without fetch",
    platform: "win32",
    arch: "x64",
    target: "windows-x64",
    version: "v22.23.4",
    local: true,
  },
  {
    name: "Windows different target architecture retains archive download",
    platform: "win32",
    arch: "x64",
    target: "windows-arm64",
    local: false,
  },
  {
    name: "Windows different version retains archive download",
    platform: "win32",
    arch: "x64",
    target: "windows-x64",
    version: "22.23.5",
    local: false,
  },
  {
    name: "Linux matching runtime retains local copy",
    platform: "linux",
    arch: "x64",
    target: "linux-x64",
    local: true,
  },
  {
    name: "Darwin matching runtime retains local copy",
    platform: "darwin",
    arch: "arm64",
    target: "macos-arm64",
    local: true,
  },
  {
    name: "Linux different version retains archive download",
    platform: "linux",
    arch: "x64",
    target: "linux-x64",
    version: "22.23.5",
    local: false,
  },
  {
    name: "Darwin different architecture retains archive download",
    platform: "darwin",
    arch: "x64",
    target: "macos-arm64",
    local: false,
  },
])
  test(row.name, () => fixture(row));
