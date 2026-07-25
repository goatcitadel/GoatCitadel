/**
 * Deterministic JSON serialization used by durable evidence hashes.
 *
 * Object keys are recursively sorted, arrays retain order, and undefined
 * object members are omitted just like JSON.stringify. Keep this utility
 * dependency-free so storage, Gateway, and browser-safe contracts all hash the
 * same logical payload.
 */
export function canonicalJsonString(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot canonicalize a non-finite number in an evidence receipt manifest.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new Error("Cannot canonicalize a bigint in an evidence receipt manifest.");
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeArrayEntry(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined && typeof value[key] !== "function")
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return "null";
}

function canonicalizeArrayEntry(entry: unknown): string {
  return entry === undefined || typeof entry === "function" ? "null" : canonicalize(entry);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
