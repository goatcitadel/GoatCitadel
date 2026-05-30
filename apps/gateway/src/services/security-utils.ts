import path from "node:path";
import { createHash } from "node:crypto";

export interface MemoryForgetCriteriaInput {
  itemIds?: string[];
  namespace?: string;
  query?: string;
}

export interface NormalizedMemoryForgetCriteria {
  hasItemIds: boolean;
  hasCriteria: boolean;
  itemIds: string[];
  namespace?: string;
  query?: string;
}

export interface OutsideRootPathWarning {
  fingerprint: string;
  baseName: string;
  normalizedPath: string;
}

export function normalizeMemoryForgetCriteria(input: MemoryForgetCriteriaInput = {}): NormalizedMemoryForgetCriteria {
  const itemIds = Array.isArray(input.itemIds)
    ? [...new Set(input.itemIds.map((itemId) => itemId.trim()).filter(Boolean))]
    : [];
  const namespace = input.namespace?.trim() || undefined;
  const query = input.query?.trim() || undefined;
  const hasItemIds = itemIds.length > 0;
  const hasCriteria = hasItemIds || Boolean(namespace) || Boolean(query);
  return {
    hasItemIds,
    hasCriteria,
    itemIds,
    namespace,
    query,
  };
}

export function assertSafeGitPositionalArg(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`${label} must not begin with '-' (interpreted as a git option): ${trimmed}`);
  }
  return trimmed;
}

export function serializePathWithinRoot(
  rootDir: string,
  fullPath: string,
  warnedOutsideRootPathFingerprints?: Set<string>,
  onOutsideRootPathWarning?: (warning: OutsideRootPathWarning) => void,
): string {
  const normalizedPath = path.resolve(fullPath);
  const relative = path.relative(rootDir, normalizedPath).replaceAll("\\", "/");
  if (relative && relative !== "." && !relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative)) {
    return relative.startsWith("./") ? relative : `./${relative}`;
  }
  const fingerprint = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 12);
  if (warnedOutsideRootPathFingerprints && !warnedOutsideRootPathFingerprints.has(fingerprint)) {
    warnedOutsideRootPathFingerprints.add(fingerprint);
    onOutsideRootPathWarning?.({
      fingerprint,
      baseName: path.basename(normalizedPath),
      normalizedPath,
    });
  }
  return "[outside-root]";
}
