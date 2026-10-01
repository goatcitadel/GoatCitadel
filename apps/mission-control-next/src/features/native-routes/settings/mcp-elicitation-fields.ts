import { canonicalJsonString, type McpElicitationRequest } from "@goatcitadel/contracts";

export interface McpResponseField {
  key: string;
  title: string;
  description: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  enum?: Array<string | number | boolean>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}
type Fields = { fields: McpResponseField[]; unavailable?: undefined } | { fields: []; unavailable: string };
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const allowed = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const unsafe = /(?:password|passwd|secret|token|credential|authorization|api.?key|private.?key)/i;

/** Deliberately small form subset. Unsupported schemas never fall back to an unchecked accept action. */
export function mcpElicitationFields(request: McpElicitationRequest): Fields {
  const unavailable = {
    fields: [] as [],
    unavailable:
      "This request cannot be accepted here because its schema is unsupported, incomplete, redacted or asks for sensitive information. Decline or cancel remain available.",
  };
  if (
    !object(request.prompt) ||
    !object(request.requestedSchema) ||
    !object(request.policy) ||
    !object(request.protocol) ||
    typeof request.prompt.text !== "string" ||
    request.prompt.truncated ||
    request.prompt.redactedSecretCount ||
    request.requestedSchema.truncated ||
    request.requestedSchema.redactedSecretCount ||
    request.protocol.message !== request.prompt.text ||
    request.protocol.method !== "elicitation/create" ||
    request.policy.sensitiveInformationAllowed !== false ||
    request.policy.requiresOperatorResponse !== true
  )
    return unavailable;
  const schema = request.requestedSchema.value;
  if (
    !object(schema) ||
    schema.type !== "object" ||
    !object(schema.properties) ||
    !allowed(schema, ["type", "properties", "required", "additionalProperties", "title", "description"]) ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false) ||
    canonicalJsonString(request.protocol.requestedSchema) !== canonicalJsonString(schema)
  )
    return unavailable;
  const entries = Object.entries(schema.properties);
  const properties = schema.properties;
  if (
    entries.length > 20 ||
    !Array.isArray(schema.required ?? []) ||
    (schema.required as unknown[] | undefined)?.some(
      (key) => typeof key !== "string" || !Object.hasOwn(properties, key),
    )
  )
    return unavailable;
  const fields: McpResponseField[] = [];
  for (const [key, raw] of entries) {
    if (
      !key ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      key.length > 100 ||
      unsafe.test(key) ||
      !object(raw) ||
      !["string", "number", "integer", "boolean"].includes(String(raw.type)) ||
      !allowed(raw, ["type", "title", "description", "enum", "minLength", "maxLength", "minimum", "maximum"])
    )
      return unavailable;
    if (
      (raw.title !== undefined && typeof raw.title !== "string") ||
      (raw.description !== undefined && typeof raw.description !== "string")
    )
      return unavailable;
    if (unsafe.test(`${raw.title ?? ""} ${raw.description ?? ""}`)) return unavailable;
    for (const constraint of ["minLength", "maxLength", "minimum", "maximum"])
      if (raw[constraint] !== undefined && (typeof raw[constraint] !== "number" || !Number.isFinite(raw[constraint])))
        return unavailable;
    if ((raw.minLength !== undefined || raw.maxLength !== undefined) && raw.type !== "string") return unavailable;
    if ((raw.minimum !== undefined || raw.maximum !== undefined) && !["number", "integer"].includes(String(raw.type)))
      return unavailable;
    if (
      [raw.minLength, raw.maxLength].some(
        (value) => value !== undefined && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2000),
      )
    )
      return unavailable;
    if (
      raw.enum !== undefined &&
      (!Array.isArray(raw.enum) ||
        raw.enum.length < 1 ||
        raw.enum.length > 20 ||
        raw.enum.some((value) => value === "" || !primitiveMatches(raw.type, value)))
    )
      return unavailable;
    if (
      Number(raw.minLength ?? 0) > Number(raw.maxLength ?? 2000) ||
      Number(raw.minimum ?? -Infinity) > Number(raw.maximum ?? Infinity)
    )
      return unavailable;
    fields.push({
      ...raw,
      key,
      type: raw.type as McpResponseField["type"],
      title: (raw.title as string | undefined)?.slice(0, 160) || key,
      description: (raw.description as string | undefined)?.slice(0, 600) || "",
      required: (schema.required as string[] | undefined)?.includes(key) ?? false,
    } as McpResponseField);
  }
  return { fields };
}
function primitiveMatches(type: unknown, value: unknown) {
  return type === "string"
    ? typeof value === "string" && value.length <= 2000
    : type === "boolean"
      ? typeof value === "boolean"
      : typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value));
}
export function mcpResponseContent(
  request: McpElicitationRequest,
  values: Record<string, string>,
): Record<string, unknown> {
  const schema = mcpElicitationFields(request);
  if (schema.unavailable) throw new Error(schema.unavailable);
  const content: Record<string, unknown> = {};
  if (Object.keys(values).some((key) => !schema.fields.some((field) => field.key === key)))
    throw new Error("The response contains an unknown field.");
  for (const field of schema.fields) {
    const raw = values[field.key] ?? "";
    if (!raw && !field.required) continue;
    if (!raw && field.required) throw new Error(`${field.title} is required.`);
    const numeric = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) ? Number(raw) : undefined;
    const value =
      field.type === "string"
        ? raw
        : field.type === "boolean"
          ? raw === "true"
            ? true
            : raw === "false"
              ? false
              : undefined
          : numeric;
    if (!primitiveMatches(field.type, value) || (field.enum && !field.enum.some((entry) => entry === value)))
      throw new Error(`Choose a valid value for ${field.title}.`);
    if (
      typeof value === "string" &&
      (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? 2000))
    )
      throw new Error(`${field.title} has an invalid length.`);
    if (typeof value === "number" && (value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity)))
      throw new Error(`${field.title} is outside the requested range.`);
    content[field.key] = value;
  }
  if (new TextEncoder().encode(JSON.stringify(content)).length > 16 * 1024)
    throw new Error("The response exceeds the Gateway's 16 KiB limit.");
  return content;
}
