import fs from "node:fs";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;

export function assertDesktopArtifactProvenance(manifestPath, expected) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Desktop artifact manifest is missing: ${manifestPath}. Rebuild the desktop host before creating the bundle.`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Desktop artifact manifest is invalid JSON: ${manifestPath}`, { cause: error });
  }

  if (manifest.target !== expected.target) {
    throw new Error(
      `Desktop artifact target ${String(manifest.target)} does not match bundle target ${expected.target}.`,
    );
  }
  if (typeof manifest.sourceCommit !== "string" || !FULL_GIT_SHA.test(manifest.sourceCommit)) {
    throw new Error("Desktop artifact manifest is missing a lowercase full sourceCommit; rebuild the desktop host.");
  }
  if (manifest.sourceCommit !== expected.sourceCommit) {
    throw new Error(
      `Desktop artifact source commit ${manifest.sourceCommit} does not match bundle source commit ${expected.sourceCommit}; rebuild the desktop host.`,
    );
  }
  if (typeof manifest.sourceModified !== "boolean") {
    throw new Error("Desktop artifact manifest is missing sourceModified truth; rebuild the desktop host.");
  }
  if (manifest.sourceModified !== expected.sourceModified) {
    throw new Error(
      `Desktop artifact sourceModified=${manifest.sourceModified} does not match bundle sourceModified=${expected.sourceModified}; rebuild the desktop host.`,
    );
  }

  return manifest;
}
