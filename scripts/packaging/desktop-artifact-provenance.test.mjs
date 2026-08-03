import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertDesktopArtifactProvenance } from "./lib/desktop-artifact-provenance.mjs";

const COMMIT = "a".repeat(40);

function withManifest(manifest, assertion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-desktop-provenance-"));
  const manifestPath = path.join(root, "desktop-manifest.json");
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    assertion(manifestPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("accepts a desktop artifact bound to the exact bundle source", () => {
  const manifest = { target: "windows-x64", sourceCommit: COMMIT, sourceModified: false };
  withManifest(manifest, (manifestPath) => {
    assert.deepEqual(
      assertDesktopArtifactProvenance(manifestPath, {
        target: "windows-x64",
        sourceCommit: COMMIT,
        sourceModified: false,
      }),
      manifest,
    );
  });
});

test("rejects legacy, stale, wrong-target, and dirty-state-mismatched desktop artifacts", () => {
  const expected = { target: "windows-x64", sourceCommit: COMMIT, sourceModified: false };
  for (const [manifest, message] of [
    [{ target: "windows-x64" }, /missing a lowercase full sourceCommit/u],
    [{ ...expected, sourceCommit: "b".repeat(40) }, /does not match bundle source commit/u],
    [{ ...expected, target: "windows-arm64" }, /does not match bundle target/u],
    [{ ...expected, sourceModified: true }, /does not match bundle sourceModified/u],
  ]) {
    withManifest(manifest, (manifestPath) => {
      assert.throws(() => assertDesktopArtifactProvenance(manifestPath, expected), message);
    });
  }
});

test("rejects a missing or malformed desktop artifact manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-desktop-provenance-"));
  try {
    const manifestPath = path.join(root, "desktop-manifest.json");
    assert.throws(
      () =>
        assertDesktopArtifactProvenance(manifestPath, {
          target: "windows-x64",
          sourceCommit: COMMIT,
          sourceModified: false,
        }),
      /manifest is missing/u,
    );
    fs.writeFileSync(manifestPath, "{not-json", "utf8");
    assert.throws(
      () =>
        assertDesktopArtifactProvenance(manifestPath, {
          target: "windows-x64",
          sourceCommit: COMMIT,
          sourceModified: false,
        }),
      /invalid JSON/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
