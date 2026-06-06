import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SkillBundleAssetKind,
  SkillBundleManifest,
  SkillBundleManifestAsset,
  SkillBundleManifestValidation,
} from "@goatcitadel/contracts";

export const SKILL_BUNDLE_MANIFEST_FILENAME = "goatcitadel.skill-bundle.json";

const MANIFEST_VERSION: SkillBundleManifest["manifestVersion"] = "goatcitadel.skill-bundle.v1";
const SCRIPT_DISPOSITION: SkillBundleManifest["scriptDisposition"] = "review_only_non_callable";
const HASH_RE = /^[a-f0-9]{64}$/;
const ROOT_METADATA_FILES = new Set(["HEARTBEAT.md", "MESSAGING.md", "RULES.md", "skill.json"]);
const ALLOWED_DIRS = new Set(["references", "templates", "scripts"]);

export function parseSkillBundleManifest(raw: string): SkillBundleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${SKILL_BUNDLE_MANIFEST_FILENAME}: ${(error as Error).message}`, { cause: error });
  }

  const errors = validateManifestShape(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid ${SKILL_BUNDLE_MANIFEST_FILENAME}: ${errors.join("; ")}`);
  }
  return parsed as SkillBundleManifest;
}

export function normalizeSkillBundleAssetPath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("asset path is required");
  }
  if (value.includes("\\") || value.includes("\0")) {
    throw new Error(`asset path must use portable POSIX separators: ${value}`);
  }
  if (path.posix.isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw new Error(`asset path must be relative: ${value}`);
  }
  const normalized = path.posix.normalize(value.trim());
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error(`asset path may not traverse directories: ${value}`);
  }
  return normalized;
}

export async function validateSkillBundleManifestDirectory(skillDir: string): Promise<SkillBundleManifestValidation> {
  const manifestPath = path.join(skillDir, SKILL_BUNDLE_MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return {
      status: "absent",
      assetsVerified: 0,
      assetPaths: [],
      warnings: [],
      errors: [],
    };
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  let manifest: SkillBundleManifest | undefined;
  try {
    manifest = parseSkillBundleManifest(raw);
  } catch (error) {
    errors.push((error as Error).message);
  }

  if (!manifest) {
    return {
      status: "invalid",
      manifestPath: SKILL_BUNDLE_MANIFEST_FILENAME,
      assetsVerified: 0,
      assetPaths: [],
      warnings,
      errors,
    };
  }

  let assetsVerified = 0;
  const assetPaths: string[] = [];
  const seenAssetPaths = new Set<string>();
  for (const asset of manifest.assets) {
    const normalized = validateAsset(asset, errors);
    if (!normalized) {
      continue;
    }
    if (seenAssetPaths.has(normalized)) {
      errors.push(`${normalized} is declared more than once in the manifest`);
      continue;
    }
    seenAssetPaths.add(normalized);
    assetPaths.push(normalized);
    const assetPath = path.join(skillDir, ...normalized.split("/"));
    try {
      const stat = await fs.stat(assetPath);
      if (!stat.isFile()) {
        errors.push(`${normalized} is not a file`);
        continue;
      }
      if (typeof asset.bytes === "number" && asset.bytes !== stat.size) {
        errors.push(`${normalized} byte size does not match manifest`);
      }
      const hash = await sha256File(assetPath);
      if (hash !== asset.sha256.toLowerCase()) {
        errors.push(`${normalized} sha256 does not match manifest`);
        continue;
      }
      assetsVerified += 1;
    } catch (error) {
      errors.push(`${normalized} could not be verified: ${(error as Error).message}`);
    }
  }

  if (!assetPaths.includes("SKILL.md")) {
    errors.push("manifest assets must include SKILL.md");
  }
  if (manifest.allowedDirectories) {
    const unknownAllowed = manifest.allowedDirectories.filter((dir) => !ALLOWED_DIRS.has(dir));
    if (unknownAllowed.length > 0) {
      warnings.push(`Manifest declares unsupported allowed directories: ${unknownAllowed.join(", ")}.`);
    }
  }

  return {
    status: errors.length > 0 ? "invalid" : "valid",
    manifestPath: SKILL_BUNDLE_MANIFEST_FILENAME,
    assetsVerified,
    assetPaths,
    scriptDisposition: manifest.scriptDisposition,
    warnings,
    errors,
  };
}

function validateManifestShape(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["manifest must be an object"];
  }
  const manifest = value as Partial<SkillBundleManifest>;
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    errors.push(`manifestVersion must be ${MANIFEST_VERSION}`);
  }
  if (manifest.scriptDisposition !== SCRIPT_DISPOSITION) {
    errors.push(`scriptDisposition must be ${SCRIPT_DISPOSITION}`);
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    errors.push("assets must be a non-empty array");
  } else if (manifest.assets.length > 200) {
    errors.push("assets may not contain more than 200 entries");
  } else {
    manifest.assets.forEach((asset, index) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
        errors.push(`assets[${index}] must be an object`);
      }
    });
  }
  if (manifest.allowedDirectories && !Array.isArray(manifest.allowedDirectories)) {
    errors.push("allowedDirectories must be an array when provided");
  }
  return errors;
}

function validateAsset(asset: SkillBundleManifestAsset, errors: string[]): string | undefined {
  let normalized: string;
  try {
    normalized = normalizeSkillBundleAssetPath(asset.path);
  } catch (error) {
    errors.push((error as Error).message);
    return undefined;
  }
  if (!HASH_RE.test(asset.sha256?.toLowerCase?.() ?? "")) {
    errors.push(`${normalized} must declare a lowercase sha256 hash`);
  }
  if (!isKnownKind(asset.kind)) {
    errors.push(`${normalized} has unsupported asset kind`);
  }
  if (!isSkillBundleAssetLocationAllowed(normalized, asset.kind)) {
    errors.push(`${normalized} is outside the skill bundle allowed paths for kind ${asset.kind}`);
  }
  const callable = (asset as { callable?: unknown }).callable;
  if (asset.kind === "script" && callable !== false) {
    errors.push(`${normalized} script assets must declare callable:false`);
  }
  if (asset.kind !== "script" && callable === true) {
    errors.push(`${normalized} may not declare callable:true`);
  }
  return normalized;
}

export function isSkillBundleAssetLocationAllowed(relativePath: string, kind: SkillBundleAssetKind): boolean {
  if (relativePath === "SKILL.md") {
    return kind === "skill";
  }
  if (ROOT_METADATA_FILES.has(relativePath)) {
    return kind === "metadata";
  }
  if (relativePath.startsWith("references/")) {
    return kind === "reference";
  }
  if (relativePath.startsWith("templates/")) {
    return kind === "template";
  }
  if (relativePath.startsWith("scripts/")) {
    return kind === "script";
  }
  return false;
}

function isKnownKind(value: unknown): value is SkillBundleAssetKind {
  return (
    value === "skill" || value === "reference" || value === "template" || value === "script" || value === "metadata"
  );
}

async function sha256File(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}
