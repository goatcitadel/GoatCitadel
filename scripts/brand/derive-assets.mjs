#!/usr/bin/env node
// Regenerates every GoatCitadel icon from the two SVG marks (and the lockup
// raster for README-style assets). Run: pnpm brand:derive
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildIcns, buildIco } from "./icon-containers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const brandDir = path.join(repoRoot, "apps", "mission-control-next", "public", "brand");
const sourceDir = path.join(brandDir, "source");
const lockupSourcePath = path.join(sourceDir, "goatcitadel-logo-source.png");
const markSourcePath = path.join(sourceDir, "goatcitadel-mark.svg");
const traySourcePath = path.join(sourceDir, "goatcitadel-mark-tray.svg");
const tauriIconDir = path.join(repoRoot, "apps", "mission-control-desktop", "src-tauri", "icons");
const winuiAssetDir = path.join(repoRoot, "apps", "mission-control-windows", "Assets");

// Frames at or below this edge use the heavier tray mark; the full mark's
// ridges, eyes and gate dot turn to noise there.
const SMALL_FRAME_MAX = 24;
const SVG_VIEWBOX_EDGE = 100;
const PNG_OPTIONS = { compressionLevel: 9, adaptiveFiltering: false };

async function loadSharp() {
  try {
    const { default: sharp } = await import("sharp");
    return sharp;
  } catch {
    throw new Error("Missing dependency 'sharp'. Run: pnpm install");
  }
}

async function readSource(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch {
    throw new Error(`Brand source not found at ${filePath}`);
  }
}

function createRenderer(sharp, markSvg, traySvg) {
  const svgFor = (size) => (size <= SMALL_FRAME_MAX ? traySvg : markSvg);
  // Rasterize at the target density so small frames are hinted by librsvg
  // rather than downscaled from a large bitmap.
  const pipeline = (size, svg = svgFor(size)) =>
    sharp(svg, { density: (72 * size) / SVG_VIEWBOX_EDGE }).resize(size, size, { fit: "fill" });

  return {
    png: (size, svg) => pipeline(size, svg).png(PNG_OPTIONS).toBuffer(),
    rgba: (size, svg) => pipeline(size, svg).ensureAlpha().raw().toBuffer(),
    markSvg,
    traySvg,
  };
}

async function icoFrames(render, sizes, svg) {
  return Promise.all(
    sizes.map(async (size) =>
      size === 256 ? { size, png: await render.png(size, svg) } : { size, rgba: await render.rgba(size, svg) },
    ),
  );
}

async function icnsFrames(render, sizes) {
  // macOS draws its own chrome around Dock icons; always use the full mark.
  return Promise.all(sizes.map(async (size) => ({ size, png: await render.png(size, render.markSvg) })));
}

function planOutputs(render) {
  const web = (name) => path.join(brandDir, name);
  const tauri = (name) => path.join(tauriIconDir, name);
  const winui = (name) => path.join(winuiAssetDir, name);
  const appIco = async () => buildIco(await icoFrames(render, [16, 24, 32, 48, 64, 128, 256]));

  return [
    [web("goatcitadel-mark.png"), () => render.png(512)],
    [web("apple-touch-icon.png"), () => render.png(180)],
    [web("favicon-32x32.png"), () => render.png(32, render.traySvg)],
    [web("favicon-16x16.png"), () => render.png(16)],
    [web("favicon.svg"), async () => render.markSvg],
    [tauri("icon.png"), () => render.png(512)],
    [tauri("icon.ico"), appIco],
    [tauri("icon.icns"), async () => buildIcns(await icnsFrames(render, [16, 32, 64, 128, 256, 512, 1024]))],
    [tauri("tray.png"), () => render.png(32, render.traySvg)],
    [winui("app.ico"), appIco],
    [winui("tray.ico"), async () => buildIco(await icoFrames(render, [16, 20, 24, 32], render.traySvg))],
    [winui("Square44x44Logo.png"), () => render.png(44)],
    [winui("Square150x150Logo.png"), () => render.png(150)],
    [winui("StoreLogo.png"), () => render.png(50)],
  ];
}

async function writeLockupAssets(sharp) {
  const image = sharp(await readSource(lockupSourcePath));
  const { width = 0, height = 0 } = await image.metadata();
  if (width <= 0 || height <= 0) {
    throw new Error("Invalid lockup source image dimensions.");
  }
  const wordmarkTop = Math.max(0, Math.round(height * 0.62));
  const lockupPath = path.join(brandDir, "goatcitadel-lockup.png");
  const wordmarkPath = path.join(brandDir, "goatcitadel-wordmark.png");

  await image
    .clone()
    .resize({ width: 1200, fit: "inside", withoutEnlargement: true })
    .png(PNG_OPTIONS)
    .toFile(lockupPath);
  await image
    .clone()
    .extract({ left: 0, top: wordmarkTop, width, height: Math.max(1, height - wordmarkTop) })
    .resize({ width: 1200, fit: "inside", withoutEnlargement: true })
    .png(PNG_OPTIONS)
    .toFile(wordmarkPath);
  return [lockupPath, wordmarkPath];
}

const toRepoPath = (filePath) => path.relative(repoRoot, filePath).replaceAll("\\", "/");

async function main() {
  const sharp = await loadSharp();
  const render = createRenderer(sharp, await readSource(markSourcePath), await readSource(traySourcePath));

  await Promise.all([brandDir, tauriIconDir, winuiAssetDir].map((dir) => fs.mkdir(dir, { recursive: true })));

  const lockupOutputs = await writeLockupAssets(sharp);
  const iconOutputs = await Promise.all(
    planOutputs(render).map(async ([filePath, produce]) => {
      await fs.writeFile(filePath, await produce());
      return filePath;
    }),
  );

  const manifest = {
    sources: [lockupSourcePath, markSourcePath, traySourcePath].map(toRepoPath),
    outputs: [...lockupOutputs, ...iconOutputs].map(toRepoPath),
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
