/** Shared pure validators; the Library and Chat owners use the same implementation. */
import { canonicalJsonString } from "./canonical-json.js";

export const EXTERNAL_SOURCE_SCHEMA_VERSION = "goatcitadel.external-source.v1" as const;

/** Session incarnation identifiers follow the chat lifecycle column bound. */
export const EXTERNAL_SOURCE_SESSION_INCARNATION_MAX_LENGTH = 320;

export const EXTERNAL_SOURCE_LIMITS = Object.freeze({
  rootPathBytes: 2_048,
  activeRootsPerWorkspace: 16,
  directoryDepth: 12,
  directoryEntriesPerScan: 10_000,
  catalogItemsPerScan: 5_000,
  scanWallTimeMs: 60_000,
  concurrentFileReads: 4,
  sourceFileBytes: 16 * 1024 * 1024,
  jsonlLineBytes: 1024 * 1024,
  normalizedMessageBytes: 256 * 1024,
  messagesPerSessionItem: 10_000,
  messagesPerImport: 50_000,
  normalizedSessionArtifactBytes: 8 * 1024 * 1024,
  markdownItemBytes: 1024 * 1024,
  selectedItemsPerImport: 100,
  rawBytesPerPlan: 25 * 1024 * 1024,
  normalizedBytesPerImport: 25 * 1024 * 1024,
  stagingLeaseMs: 30 * 60 * 1000,
  lineageNodes: 10_000,
  lineageDepth: 64,
  defaultPageSize: 50,
  maxPageSize: 100,
  encodedCursorBytes: 8_192,
  canonicalJsonBytes: 64 * 1024,
});

const SHA256 = /^[a-f0-9]{64}$/u;

const UTF8 = new TextEncoder();

export function normalizeInputText(value: unknown, name: string, max: number, byteLimit = false): string {
  if (typeof value !== "string") throw new Error(`External source ${name} is invalid.`);
  const normalized = value.normalize("NFKC").trim();
  assertText(normalized, name, max, byteLimit);
  return normalized;
}

export function normalizePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`External source ${name} is invalid.`);
  return Number(value);
}

export function assertSha256(value: string): void {
  if (!SHA256.test(value)) throw new Error("External source SHA-256 is invalid.");
}

export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`External source ${name} is invalid.`);
}

export function assertIso(value: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new Error("External source timestamp is invalid.");
}

export function assertVersion(value: string): void {
  if (value !== EXTERNAL_SOURCE_SCHEMA_VERSION) throw new Error("External source schema version is unsupported.");
}

export function assertText(value: string, name: string, max: number, byteLimit = false): void {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value !== value.normalize("NFKC") ||
    containsAsciiControlCharacter(value) ||
    (byteLimit ? UTF8.encode(value).byteLength : value.length) > max
  )
    throw new Error(`External source ${name} is invalid.`);
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export function assertCanonicalJsonBytes(value: unknown, max: number): void {
  if (UTF8.encode(canonicalJsonString(value)).byteLength > max)
    throw new Error("External source canonical JSON exceeds its hard limit.");
}

export function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`External source ${name} is malformed.`);
}

export function assertExactKeys(value: object, keys: readonly string[], optional: ReadonlySet<string>): void {
  const actual = Object.keys(value);
  const allowed = new Set(keys);
  if (actual.some((key) => !allowed.has(key)) || keys.some((key) => !optional.has(key) && !actual.includes(key)))
    throw new Error("External source record contains unsupported or missing fields.");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
