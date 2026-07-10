import { projectPublicSecretValue } from "./public-secret-projection.js";

const IMPORT_PROVENANCE_REFERENCE_KEYS = new Set(["repoUrl", "repositoryUrl", "sourceRef", "sourceUrl", "upstreamUrl"]);
const IMPORT_REFERENCE_ECHO_KEYS = new Set(["matchedTerms", "query"]);
const IMPORT_REFERENCE_PATTERN = /^(?:(?:git\+)?https?|ssh|git|file):\/\/|^[^@\s]+@[^:\s]+:/i;

/**
 * Creates a detached public projection of import provenance references.
 *
 * Only the structured URL/reference owners are projected. Imported Markdown,
 * descriptions, operator notes, and other authored content remain byte-identical.
 */
export function projectImportProvenanceReferencesForPublic<T>(value: T): T {
  return projectImportProvenanceValue(value, undefined) as T;
}

function projectImportProvenanceValue(value: unknown, key: string | undefined): unknown {
  if (typeof value === "string") {
    return key && shouldProjectReference(key, value) ? projectReferenceString(key, value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => projectImportProvenanceValue(item, key));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      projectImportProvenanceValue(child, childKey),
    ]),
  );
}

function shouldProjectReference(key: string, value: string): boolean {
  return (
    IMPORT_PROVENANCE_REFERENCE_KEYS.has(key) ||
    (IMPORT_REFERENCE_ECHO_KEYS.has(key) && IMPORT_REFERENCE_PATTERN.test(value.trim()))
  );
}

function projectReferenceString(key: string, value: string): string {
  const projected = projectPublicSecretValue({ [key]: value });
  return typeof projected[key] === "string" ? projected[key] : value;
}
