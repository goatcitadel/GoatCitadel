import fs from "node:fs/promises";
import path from "node:path";

const ARTIFACT_KEYS = Object.freeze(["diagnostics", "screenshots", "traces", "logs", "perf", "playwright"]);

export function emptyBrowserEvidenceArtifacts(overrides = {}) {
  return Object.fromEntries(ARTIFACT_KEYS.map((key) => [key, [...new Set(overrides[key] ?? [])]]));
}

export function mergeBrowserEvidenceArtifacts(left, right) {
  return emptyBrowserEvidenceArtifacts(
    Object.fromEntries(ARTIFACT_KEYS.map((key) => [key, [...(left?.[key] ?? []), ...(right?.[key] ?? [])]])),
  );
}

export async function captureBrowserActionCheckpoint(context, input) {
  const checkpointPath = path.join(
    context.artifactRoot,
    "screenshots",
    `${safeSlug(input.bundleId)}--${safeSlug(input.stepId)}.png`,
  );
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await input.page.screenshot({ path: checkpointPath, fullPage: false });
  return relativeToRun(context, checkpointPath);
}

export async function retainFailedBrowserVideo(context, input) {
  if (!input.video) return null;
  const videoPath = path.join(context.artifactRoot, "playwright", `${safeSlug(input.slug)}-failure.webm`);
  await fs.mkdir(path.dirname(videoPath), { recursive: true });
  await input.video.saveAs(videoPath);
  await input.video.delete().catch(() => undefined);
  return relativeToRun(context, videoPath);
}

export async function discardBrowserVideo(video) {
  if (video) await video.delete().catch(() => undefined);
}

function safeSlug(value) {
  return (
    String(value)
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 160) || "checkpoint"
  );
}

function relativeToRun(context, filePath) {
  return path.relative(context.artifactRoot, filePath).replaceAll("\\", "/");
}
