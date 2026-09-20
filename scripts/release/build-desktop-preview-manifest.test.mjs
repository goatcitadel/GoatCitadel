import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { assemblePreview } from "./build-desktop-preview-manifest.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { inputDir: path.join(root, "input"), outputDir: path.join(root, "output"),
    commit: "a".repeat(40), sequence: 123001, tag: "preview-123-1",
    version: "0.1.0-preview.123001.0", fastRunId: 111, buildRunId: 123 };
  for (const target of ["windows-x64", "windows-arm64"]) {
    const directory = path.join(input.inputDir, target);
    fs.mkdirSync(directory, { recursive: true });
    const name = "GoatCitadel-Setup-" + target + ".exe";
    const bytes = Buffer.from(target);
    fs.writeFileSync(path.join(directory, name), bytes);
    fs.writeFileSync(path.join(directory, name + ".sha256"), createHash("sha256").update(bytes).digest("hex") + " *" + name + "\n");
    fs.writeFileSync(path.join(directory, "release-manifest.json"), JSON.stringify({
      sourceCommit: input.commit, sourceModified: false, version: input.version, target }));
    fs.writeFileSync(path.join(directory, "preview-proof.json"), JSON.stringify({
      sourceCommit: input.commit, buildSequence: input.sequence, target, desktop: "success", installerSmoke: "success" }));
  }
  return input;
}
test("complete exact-commit inputs produce an unsigned immutable manifest and notes", async (t) => {
  const input = fixture(t);
  const manifest = await assemblePreview(input);
  assert.equal(manifest.publisherSigned, false);
  assert.equal(manifest.assets["windows-x64"].sizeBytes, "windows-x64".length);
  assert.equal(fs.readdirSync(input.outputDir).length, 6);
  await assert.rejects(assemblePreview(input), /exist/);
});
for (const fault of ["missing architecture", "dirty source", "wrong commit", "failed smoke", "bad checksum"]) {
  test("rejects " + fault + " before staging any release", async (t) => {
    const input = fixture(t);
    const directory = path.join(input.inputDir, "windows-arm64");
    if (fault === "missing architecture") fs.unlinkSync(path.join(directory, "release-manifest.json"));
    if (fault === "dirty source" || fault === "wrong commit") {
      const file = path.join(directory, "release-manifest.json");
      const manifest = JSON.parse(fs.readFileSync(file));
      if (fault === "dirty source") manifest.sourceModified = true;
      else manifest.sourceCommit = "b".repeat(40);
      fs.writeFileSync(file, JSON.stringify(manifest));
    }
    if (fault === "failed smoke") {
      const file = path.join(directory, "preview-proof.json");
      const proof = JSON.parse(fs.readFileSync(file));
      proof.installerSmoke = "failed";
      fs.writeFileSync(file, JSON.stringify(proof));
    }
    if (fault === "bad checksum") fs.appendFileSync(path.join(directory, "GoatCitadel-Setup-windows-arm64.exe"), "tampered");
    await assert.rejects(assemblePreview(input));
    assert.equal(fs.existsSync(input.outputDir), false);
  });
}
