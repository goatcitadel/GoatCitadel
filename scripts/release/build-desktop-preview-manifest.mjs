#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function assemblePreview({ inputDir, outputDir, commit, sequence, tag, version, fastRunId, buildRunId }) {
  if (!/^[a-f0-9]{40}$/u.test(commit) || !Number.isSafeInteger(sequence) || sequence <= 0
    || !/^preview-\d+-\d+$/u.test(tag) || version !== "0.1.0-preview." + sequence + ".0"
    || !/^\d+$/u.test(String(fastRunId)) || !/^\d+$/u.test(String(buildRunId))) {
    throw new Error("Invalid immutable Preview identity.");
  }
  const entries = [];
  for (const target of ["windows-x64", "windows-arm64"]) {
    const directory = path.join(inputDir, target);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "release-manifest.json"), "utf8"));
    const proof = JSON.parse(fs.readFileSync(path.join(directory, "preview-proof.json"), "utf8"));
    if (manifest.sourceCommit !== commit || manifest.sourceModified !== false || manifest.version !== version
      || manifest.target !== target || proof.sourceCommit !== commit || proof.target !== target
      || proof.buildSequence !== sequence || proof.desktop !== "success" || proof.installerSmoke !== "success") {
      throw new Error("Preview requires successful exact-commit desktop and installer evidence: " + target);
    }
    const name = "GoatCitadel-Setup-" + target + ".exe";
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 2 * 1024 ** 3) {
      throw new Error("Invalid installer: " + target);
    }
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    const sha256 = hash.digest("hex");
    const checksum = fs.readFileSync(file + ".sha256", "utf8").trim();
    if (checksum !== sha256 + " *" + name) throw new Error("Installer checksum does not match: " + target);
    entries.push({ target, file, name, sha256, sizeBytes: stat.size });
  }
  // Create only after both architectures pass. Never overwrite a staged release.
  fs.mkdirSync(outputDir, { recursive: false });
  for (const entry of entries) {
    fs.copyFileSync(entry.file, path.join(outputDir, entry.name), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(entry.file + ".sha256", path.join(outputDir, entry.name + ".sha256"), fs.constants.COPYFILE_EXCL);
  }
  const metadata = {
    schemaVersion: 1, product: "GoatCitadel", repository: "goatcitadel/GoatCitadel",
    channel: "preview", publisherSigned: false, version, sourceCommit: commit, buildSequence: sequence, tag,
    evidence: {
      fast: "https://github.com/goatcitadel/GoatCitadel/actions/runs/" + fastRunId,
      desktopAndInstaller: "https://github.com/goatcitadel/GoatCitadel/actions/runs/" + buildRunId,
    },
    assets: Object.fromEntries(entries.map(({ target, name, sha256, sizeBytes }) =>
      [target, { name, sha256, sizeBytes }])),
  };
  fs.writeFileSync(path.join(outputDir, "desktop-update.json"), JSON.stringify(metadata, null, 2) + "\n");
  const notes = [
    "# GoatCitadel " + version, "", "**Unsigned Windows Preview.** Download and run the installer manually.",
    "SHA-256 verifies download integrity; it does not establish publisher signing.", "",
    "Source commit: " + commit, "Build sequence: " + sequence, "",
    "[Changes in this commit](https://github.com/goatcitadel/GoatCitadel/commit/" + commit + ")",
    "[Fast verification](" + metadata.evidence.fast + ")",
    "[Desktop and installer checks](" + metadata.evidence.desktopAndInstaller + ")", "",
    "The installer preserves your profile. Back up before upgrading: a prior application build does not undo forward database migrations.", "",
  ].join("\n");
  fs.writeFileSync(path.join(outputDir, "release-notes.md"), notes);
  return metadata;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await assemblePreview({
    inputDir: process.argv[2], outputDir: process.argv[3], commit: process.env.PREVIEW_COMMIT,
    sequence: Number(process.env.PREVIEW_SEQUENCE), tag: process.env.PREVIEW_TAG, version: process.env.PREVIEW_VERSION,
    fastRunId: process.env.FAST_RUN_ID, buildRunId: process.env.GITHUB_RUN_ID,
  });
}
