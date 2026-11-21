import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

/** Loads operator-reviewed local instrumentation, never code produced by a benchmarked model. */
export async function loadReviewedNativeSessions({
  providerConfig,
  providerConfigBaseDir,
  root,
  manifest,
  maxCostUsd,
}) {
  const specification = providerConfig.nativeSessionsModule;
  if (!specification) return providerConfig.reviewedNativeSessions ?? {};
  if (providerConfig.reviewedNativeSessions) throw new Error("Select one reviewed native-session source.");
  if (typeof specification.path !== "string" || !/^[a-f0-9]{64}$/u.test(specification.sha256 ?? ""))
    throw new Error("A reviewed native-session module path and full SHA-256 are required.");
  const filename = await fs.realpath(path.resolve(providerConfigBaseDir ?? process.cwd(), specification.path));
  const info = await fs.stat(filename);
  if (!info.isFile() || info.size > 1024 * 1024 || !filename.endsWith(".mjs"))
    throw new Error("Use a bounded reviewed .mjs native-session module.");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (digest(await fs.readFile(filename)) !== specification.sha256)
    throw new Error("Native-session module changed after review.");
  const url = pathToFileURL(filename);
  url.searchParams.set("sha256", specification.sha256);
  const imported = await import(url.href);
  if (
    digest(await fs.readFile(filename)) !== specification.sha256 ||
    typeof imported.createReviewedNativeSessions !== "function"
  )
    throw new Error("The reviewed native-session module or its factory is unavailable.");
  return imported.createReviewedNativeSessions({ providerConfig, root, manifest, maxCostUsd });
}
