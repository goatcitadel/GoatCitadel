import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyEngineRequire = createRequire(path.join(root, "packages", "policy-engine", "package.json"));
const pptxgenjsPath = policyEngineRequire.resolve("pptxgenjs");
const pptxgenjsRequire = createRequire(pptxgenjsPath);
const imageSizePath = pptxgenjsRequire.resolve("image-size");

const malformedPayloads = {
  heif: [
    0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x24, 0x6d, 0x65, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x69, 0x70, 0x72, 0x70, 0x00, 0x00,
    0x00, 0x14, 0x69, 0x70, 0x63, 0x6f, 0x00, 0x00, 0x00, 0x00, 0x69, 0x73, 0x70, 0x65, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ],
  icns: [0x69, 0x63, 0x6e, 0x73, 0x00, 0x00, 0x00, 0x10, 0x69, 0x73, 0x33, 0x32, 0x00, 0x00, 0x00, 0x00],
  jxl: [
    0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a, 0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79,
    0x70, 0x6a, 0x78, 0x6c, 0x20, 0x00, 0x00, 0x00, 0x00, 0x6a, 0x78, 0x6c, 0x20, 0x00, 0x00, 0x00, 0x00, 0x6a, 0x78,
    0x6c, 0x70,
  ],
};

test("the patched image-size dependency terminates on no-progress parser payloads", () => {
  for (const [name, payload] of Object.entries(malformedPayloads)) {
    const childSource = `
      const { imageSize } = require(${JSON.stringify(imageSizePath)});
      try {
        imageSize(Uint8Array.from(${JSON.stringify(payload)}));
        process.stdout.write("terminated:return");
      } catch {
        process.stdout.write("terminated:throw");
      }
    `;
    const result = spawnSync(process.execPath, ["-e", childSource], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });

    assert.notEqual(result.error?.code, "ETIMEDOUT", `${name} payload blocked the Node.js event loop`);
    assert.equal(
      result.status,
      0,
      `${name} payload failed outside the parser contract: ${result.stderr || result.stdout}`,
    );
    assert.match(result.stdout, /^terminated:(return|throw)$/u);
  }
});

test("the patched image-size dependency preserves ordinary image detection", () => {
  const { imageSize } = pptxgenjsRequire(imageSizePath);
  const onePixelPng = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
  ]);

  assert.deepEqual(imageSize(onePixelPng), { height: 1, type: "png", width: 1 });
});

test("Trivy exceptions are limited and expire for review", () => {
  const ignoredEntries = readFileSync(path.join(root, ".trivyignore"), "utf8")
    .split(/\r?\n/u)
    .filter((line) => /^CVE-/u.test(line));

  assert.deepEqual(ignoredEntries, ["CVE-2025-71329 exp:2026-09-08", "CVE-2025-71330 exp:2026-09-08"]);
  const packageManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(packageManifest.pnpm?.patchedDependencies?.["image-size@1.2.1"], "patches/image-size@1.2.1.patch");
});
