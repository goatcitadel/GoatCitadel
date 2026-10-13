import { canonicalJsonString } from "./canonical-json.js";

/** Deliberately bounded JSON Schema subset for optional delegated handoffs. */
export type ChatDelegationResultSchema = Record<string, unknown>;
const MAX_SCHEMA_BYTES = 8192;
const MAX_RESULT_BYTES = 65536;
const COMMON = ["type", "description", "enum"];
const KEYS: Record<string, string[]> = {
  object: [...COMMON, "properties", "required", "additionalProperties"],
  array: [...COMMON, "items", "minItems", "maxItems"],
  string: [...COMMON, "minLength", "maxLength"],
  number: [...COMMON, "minimum", "maximum"],
  integer: [...COMMON, "minimum", "maximum"],
  boolean: COMMON,
  null: COMMON,
};
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function readChatDelegationResultSchema(value: unknown): ChatDelegationResultSchema {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (
      ++nodes > 128 ||
      depth > 6 ||
      !record(candidate) ||
      typeof candidate.type !== "string" ||
      !Object.hasOwn(KEYS, candidate.type)
    )
      invalid();
    const schema = candidate as Record<string, unknown>;
    const type = schema.type as string;
    if (Object.keys(schema).some((key) => !KEYS[type]!.includes(key))) invalid();
    if (schema.description !== undefined && (typeof schema.description !== "string" || schema.description.length > 500))
      invalid();
    if (
      schema.enum !== undefined &&
      (!Array.isArray(schema.enum) ||
        schema.enum.length < 1 ||
        schema.enum.length > 32 ||
        schema.enum.some((item) => item !== null && !["string", "number", "boolean"].includes(typeof item)))
    )
      invalid();
    if (type === "object") {
      if (
        !record(schema.properties) ||
        Object.keys(schema.properties).length > 32 ||
        schema.additionalProperties !== false
      )
        invalid();
      const properties = schema.properties as Record<string, unknown>;
      if (
        Object.keys(properties).some(
          (key) => key.length < 1 || key.length > 120 || ["__proto__", "constructor", "prototype"].includes(key),
        )
      )
        invalid();
      if (
        schema.required !== undefined &&
        (!Array.isArray(schema.required) ||
          schema.required.length > 32 ||
          schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)) ||
          new Set(schema.required).size !== schema.required.length)
      )
        invalid();
      for (const child of Object.values(properties)) visit(child, depth + 1);
    } else if (type === "array") {
      bound(schema.maxItems, 0, 128, true);
      bound(schema.minItems, 0, Number(schema.maxItems), false);
      visit(schema.items, depth + 1);
    } else if (type === "string") {
      bound(schema.maxLength, 0, 8192, true);
      bound(schema.minLength, 0, Number(schema.maxLength), false);
    } else if (type === "number" || type === "integer") {
      for (const field of [schema.minimum, schema.maximum])
        if (field !== undefined && (typeof field !== "number" || !Number.isFinite(field))) invalid();
      if (
        schema.minimum !== undefined &&
        schema.maximum !== undefined &&
        Number(schema.minimum) > Number(schema.maximum)
      )
        invalid();
    }
  };
  visit(value, 0);
  const json = canonicalJsonString(value);
  if (new TextEncoder().encode(json).length > MAX_SCHEMA_BYTES) invalid();
  return JSON.parse(json) as ChatDelegationResultSchema;
}

/** No coercion, defaults, schema fetching, regex evaluation or source excerpts. */
export function validateChatDelegationResult(schemaInput: ChatDelegationResultSchema, text: string): boolean {
  const schema = readChatDelegationResultSchema(schemaInput);
  if (new TextEncoder().encode(text).length > MAX_RESULT_BYTES) return false;
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    return false;
  }
  let nodes = 0;
  const check = (s: ChatDelegationResultSchema, value: unknown, depth: number): boolean => {
    if (++nodes > 8192 || depth > 7) return false;
    if (s.enum !== undefined && !(s.enum as unknown[]).some((item) => Object.is(item, value))) return false;
    switch (s.type) {
      case "object": {
        if (!record(value)) return false;
        const properties = s.properties as Record<string, ChatDelegationResultSchema>;
        return (
          Object.keys(value).every((key) => Object.hasOwn(properties, key)) &&
          ((s.required as string[] | undefined) ?? []).every((key) => Object.hasOwn(value, key)) &&
          Object.entries(value).every(([key, item]) => check(properties[key]!, item, depth + 1))
        );
      }
      case "array":
        return (
          Array.isArray(value) &&
          value.length <= Number(s.maxItems) &&
          value.length >= Number(s.minItems ?? 0) &&
          value.every((item) => check(s.items as ChatDelegationResultSchema, item, depth + 1))
        );
      case "string":
        return (
          typeof value === "string" &&
          [...value].length <= Number(s.maxLength) &&
          [...value].length >= Number(s.minLength ?? 0)
        );
      case "integer":
      case "number":
        return (
          typeof value === "number" &&
          Number.isFinite(value) &&
          (s.type !== "integer" || Number.isSafeInteger(value)) &&
          (s.minimum === undefined || value >= Number(s.minimum)) &&
          (s.maximum === undefined || value <= Number(s.maximum))
        );
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
      default:
        return false;
    }
  };
  return check(schema, result, 0);
}

function bound(value: unknown, min: number, max: number, required: boolean): void {
  if (value === undefined && !required) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid();
}
function invalid(): never {
  throw new Error("Delegated result schema is outside the bounded supported JSON Schema subset.");
}
