import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { publishStagedGallery } from "../packages/policy-engine/scripts/screenshot-gallery-publisher.mjs";

test("gallery publication preserves the current gallery when staging validation fails", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-gallery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  const stagedOutputDir = path.join(root, "staging");
  await fs.mkdir(outputDir);
  await fs.mkdir(stagedOutputDir);
  await fs.writeFile(path.join(outputDir, "existing.png"), "existing");
  await fs.writeFile(path.join(stagedOutputDir, "index.html"), "index");

  await assert.rejects(
    publishStagedGallery({
      stagedOutputDir,
      outputDir,
      backupDir: path.join(root, "backup"),
      expectedFiles: ["index.html", "chat.png"],
    }),
    /chat\.png/u,
  );
  assert.equal(await fs.readFile(path.join(outputDir, "existing.png"), "utf8"), "existing");
});

test("gallery publication replaces the current gallery only after every artifact validates", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-gallery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "output");
  const stagedOutputDir = path.join(root, "staging");
  const backupDir = path.join(root, "backup");
  await fs.mkdir(outputDir);
  await fs.mkdir(stagedOutputDir);
  await fs.writeFile(path.join(outputDir, "existing.png"), "existing");
  await fs.writeFile(path.join(stagedOutputDir, "index.html"), "index");
  await fs.writeFile(path.join(stagedOutputDir, "chat.png"), "chat");

  await publishStagedGallery({
    stagedOutputDir,
    outputDir,
    backupDir,
    expectedFiles: ["index.html", "chat.png"],
  });

  assert.equal(await fs.readFile(path.join(outputDir, "chat.png"), "utf8"), "chat");
  await assert.rejects(fs.access(path.join(outputDir, "existing.png")), { code: "ENOENT" });
  await assert.rejects(fs.access(backupDir), { code: "ENOENT" });
});
