#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const brandDir = path.join(repoRoot, "apps", "mission-control-next", "public", "brand");
const sourcePath = path.join(brandDir, "source", "goatcitadel-logo-source.png");

async function main() {
  let sharp;
  try {
    ({ default: sharp } = await import("sharp"));
  } catch {
    throw new Error("Missing dependency 'sharp'. Run: pnpm add -D sharp");
  }

  try {
    await fs.access(sourcePath);
  } catch {
    throw new Error(`Source logo not found at ${sourcePath}`);
  }

  await fs.mkdir(brandDir, { recursive: true });

  const image = sharp(sourcePath);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error("Invalid source image dimensions.");
  }

  const markRegionHeight = Math.max(1, Math.round(height * 0.68));
  const markSquare = Math.min(width, markRegionHeight);
  const markLeft = Math.max(0, Math.floor((width - markSquare) / 2));
  const markTop = 0;

  const wordmarkTop = Math.max(0, Math.round(height * 0.62));
  const wordmarkHeight = Math.max(1, height - wordmarkTop);

  const lockupPath = path.join(brandDir, "goatcitadel-lockup.png");
  const markPath = path.join(brandDir, "goatcitadel-mark.png");
  const wordmarkPath = path.join(brandDir, "goatcitadel-wordmark.png");
  const appleTouchPath = path.join(brandDir, "apple-touch-icon.png");
  const favicon32Path = path.join(brandDir, "favicon-32x32.png");
  const favicon16Path = path.join(brandDir, "favicon-16x16.png");

  await sharp(sourcePath)
    .resize({ width: 1200, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(lockupPath);

  await sharp(sourcePath)
    .extract({ left: markLeft, top: markTop, width: markSquare, height: markSquare })
    .resize(512, 512, { fit: "cover" })
    .png({ compressionLevel: 9 })
    .toFile(markPath);

  await sharp(sourcePath)
    .extract({ left: 0, top: wordmarkTop, width, height: wordmarkHeight })
    .resize({ width: 1200, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(wordmarkPath);

  await sharp(markPath).resize(180, 180, { fit: "cover" }).png({ compressionLevel: 9 }).toFile(appleTouchPath);
  await sharp(markPath).resize(32, 32, { fit: "cover" }).png({ compressionLevel: 9 }).toFile(favicon32Path);
  await sharp(markPath).resize(16, 16, { fit: "cover" }).png({ compressionLevel: 9 }).toFile(favicon16Path);

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: path.relative(repoRoot, sourcePath).replaceAll("\\", "/"),
    outputs: [
      path.relative(repoRoot, lockupPath).replaceAll("\\", "/"),
      path.relative(repoRoot, markPath).replaceAll("\\", "/"),
      path.relative(repoRoot, wordmarkPath).replaceAll("\\", "/"),
      path.relative(repoRoot, appleTouchPath).replaceAll("\\", "/"),
      path.relative(repoRoot, favicon32Path).replaceAll("\\", "/"),
      path.relative(repoRoot, favicon16Path).replaceAll("\\", "/"),
    ],
  };
  await fs.writeFile(path.join(brandDir, "asset-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log("Brand assets generated:");
  for (const output of manifest.outputs) {
    console.log(`- ${output}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
