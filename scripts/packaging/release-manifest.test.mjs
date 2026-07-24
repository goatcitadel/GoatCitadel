import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildReleaseManifest, RELEASE_PAYLOAD_LIMITS, validateReleaseManifest } from "./lib/package-renderers.mjs";
import { requirePackagingTarget } from "./lib/packaging-targets.mjs";

const COMMIT = "a".repeat(40);
const DIGEST_A = "b".repeat(64);
const DIGEST_B = "c".repeat(64);
const TARGET = requirePackagingTarget("windows-x64");

test("release manifest schema v2 deterministically binds the exact app/bin payload", () => {
  const first = makeManifest([file("bin/goatcitadel.cmd", DIGEST_B, 2), file("app/gateway/dist/main.js", DIGEST_A, 3)]);
  const second = makeManifest([
    file("app/gateway/dist/main.js", DIGEST_A, 3),
    file("bin/goatcitadel.cmd", DIGEST_B, 2),
  ]);

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.product, "GoatCitadel");
  assert.deepEqual(first.payload.roots, ["app", "bin"]);
  assert.deepEqual(first.payload.detachedMetadataFiles, ["app/release-manifest.json"]);
  assert.deepEqual(first.payload.detachedMetadataTrees, ["app/release-evidence"]);
  assert.equal(first.payload.fileCount, 2);
  assert.equal(first.payload.totalBytes, 5);
  assert.deepEqual(
    first.payload.files.map((record) => record.path),
    ["app/gateway/dist/main.js", "bin/goatcitadel.cmd"],
  );
  assert.deepEqual(
    validateReleaseManifest(first, {
      targetInfo: TARGET,
      expectedVersion: "1.0.0",
      expectedCommit: COMMIT,
      requireCleanSource: true,
    }),
    { files: first.payload.files, fileCount: 2, totalBytes: 5 },
  );

  const utf8Ordered = makeManifest([file("app/😀.js", DIGEST_B), file("app/\uE000.js", DIGEST_A)]);
  assert.deepEqual(
    utf8Ordered.payload.files.map((record) => record.path),
    ["app/\uE000.js", "app/😀.js"],
    "payload paths must use UTF-8 byte lexical order rather than UTF-16 code-unit order",
  );
});

test("release manifest rejects dirty source when release trust requires a clean build", () => {
  const manifest = makeManifest([file("bin/goatcitadel.cmd")], { sourceModified: true });
  assert.throws(
    () =>
      validateReleaseManifest(manifest, {
        targetInfo: TARGET,
        expectedVersion: "1.0.0",
        expectedCommit: COMMIT,
        requireCleanSource: true,
      }),
    /modified source/i,
  );
});

test("release manifest rejects duplicate, case-colliding, unsafe, and detached metadata paths", () => {
  assert.throws(() => makeManifest([file("app/a.js"), file("app/a.js", DIGEST_B)]), /duplicate path/i);
  assert.throws(() => makeManifest([file("app/A.js"), file("app/a.js", DIGEST_B)]), /case-fold collision/i);
  for (const unsafePath of [
    "../outside.js",
    "app/../outside.js",
    "C:/outside.js",
    "/absolute.js",
    "app\\outside.js",
    "other/file.js",
    "app/release-manifest.json",
    "app/release-evidence/forged.json",
    "app/Release-Manifest.json",
    "app/Release-Evidence/forged.json",
    "app/\uD800.js",
  ]) {
    assert.throws(() => makeManifest([file(unsafePath)]), /unsafe|detached metadata/i, unsafePath);
  }
  assert.throws(
    () => makeManifest([file(`app/${"é".repeat(510)}.js`)]),
    /unsafe/i,
    "path limits must be enforced in UTF-8 bytes",
  );
});

test("release manifest rejects reordered records, forged summaries, and oversized files", () => {
  const manifest = makeManifest([file("app/a.js"), file("bin/a.cmd", DIGEST_B)]);
  manifest.payload.files.reverse();
  assert.throws(() => validateReleaseManifest(manifest, { targetInfo: TARGET }), /strictly path-sorted/i);

  const forgedSummary = makeManifest([file("app/a.js")]);
  forgedSummary.payload.totalBytes += 1;
  assert.throws(() => validateReleaseManifest(forgedSummary, { targetInfo: TARGET }), /count\/byte summaries/i);

  assert.throws(
    () => makeManifest([file("app/huge.bin", DIGEST_A, RELEASE_PAYLOAD_LIMITS.maxFileBytes + 1)]),
    /size is invalid/i,
  );
});

test("bundle manifest collection rejects links, enforces early bounds, and streams payload hashes", () => {
  const source = fs.readFileSync(new URL("./build-bundle.mjs", import.meta.url), "utf8");
  assert.match(source, /Release payload cannot contain a symlink or junction/);
  assert.match(source, /Release payload cannot contain a hard-linked file/);
  assert.match(source, /stats\.nlink !== 1/);
  assert.match(source, /openedStats\.nlink !== 1/);
  assert.match(source, /finalOpenedStats\.nlink !== 1/);
  assert.ok((source.match(/assertAnchoredPayloadFile\(bundleRootPath, filePath, relativePath\)/g) ?? []).length >= 3);
  assert.match(source, /fs\.realpathSync\.native\(candidate\)/);
  assert.match(source, /filePaths\.length >= RELEASE_PAYLOAD_LIMITS\.maxFiles/);
  assert.match(source, /totalBytes > RELEASE_PAYLOAD_LIMITS\.maxTotalBytes/);
  assert.ok(
    source.indexOf("filePaths.length >= RELEASE_PAYLOAD_LIMITS.maxFiles") <
      source.indexOf("async function buildPayloadFileRecord"),
  );
  assert.match(source, /for await \(const chunk of fs\.createReadStream/);
  assert.doesNotMatch(source, /createHash\("sha256"\)\.update\(fs\.readFileSync\(filePath\)\)/);
  assert.match(source, /isDetachedReleaseMetadataPath\(relativePath\)/);
});

function makeManifest(payloadFiles, { sourceModified = false } = {}) {
  return buildReleaseManifest({
    targetInfo: TARGET,
    version: "1.0.0",
    nodeVersion: "v22.22.2",
    payloadFiles,
    uiTarget: {
      packageName: "@goatcitadel/mission-control-next",
      packageDirName: "mission-control-next",
      displayName: "Mission Control Next",
    },
    includeDesktopHost: true,
    desktopArtifactName: TARGET.desktopArtifactName,
    sourceCommit: COMMIT,
    sourceModified,
  });
}

function file(filePath, sha256 = DIGEST_A, sizeBytes = 1) {
  return { path: filePath, sha256, sizeBytes };
}
