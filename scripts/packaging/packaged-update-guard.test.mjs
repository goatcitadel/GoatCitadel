import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const launcherPath = path.join(repoRoot, "bin", "goatcitadel.mjs");

test("packaged update refuses the source-bootstrap updater without deleting the payload", () => {
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-packaged-update-"));
  const appRoot = path.join(installRoot, "app");
  const sentinelPath = path.join(appRoot, "keep-me.txt");

  try {
    fs.mkdirSync(path.join(appRoot, "gateway", "dist"), { recursive: true });
    fs.mkdirSync(path.join(appRoot, "mission-control", "dist"), { recursive: true });
    fs.mkdirSync(path.join(appRoot, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(appRoot, "release-manifest.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(appRoot, "gateway", "dist", "main.js"), "\n", "utf8");
    fs.writeFileSync(path.join(appRoot, "mission-control", "dist", "index.html"), "\n", "utf8");
    fs.writeFileSync(path.join(appRoot, "runtime", "ui-static-server.mjs"), "\n", "utf8");
    fs.writeFileSync(sentinelPath, "preserve\n", "utf8");

    const result = spawnSync(process.execPath, [launcherPath, "update", "--install-dir", installRoot], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /managed by the packaged installer/);
    assert.match(result.stderr, /run it to update in place/);
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "preserve\n");
  } finally {
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
});
