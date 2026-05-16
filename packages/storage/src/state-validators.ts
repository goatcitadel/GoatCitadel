import type { SafeParse, SafeParseResult } from "./load-and-sanitize.js";

export const parseJsonObject: SafeParse<Record<string, unknown>> = (value) => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { success: true, data: value as Record<string, unknown> };
  }
  return { success: false, error: { message: "expected JSON object" } };
};

export const parseJsonArray: SafeParse<unknown[]> = (value) => {
  if (Array.isArray(value)) {
    return { success: true, data: value };
  }
  return { success: false, error: { message: "expected JSON array" } };
};

export const parseStringRecord: SafeParse<Record<string, string>> = (
  value,
): SafeParseResult<Record<string, string>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { success: false, error: { message: "expected object of string values" } };
  }
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      return { success: false, error: { message: `${key}: expected string, got ${typeof v}` } };
    }
    out[key] = v;
  }
  return { success: true, data: out };
};
