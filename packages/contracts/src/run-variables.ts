import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";

export const RUN_VARIABLE_SCHEMA_VERSION = "goatcitadel.run-variables.v1" as const;
export const RUN_VARIABLE_MAX_FIELDS = 32;

export type RunVariableType =
  | "text"
  | "multiline"
  | "number"
  | "boolean"
  | "select"
  | "url"
  | "path"
  | "date"
  | "datetime";

export type RunVariableValue = string | number | boolean;
export type RunVariableBindings = Record<string, RunVariableValue>;

interface RunVariableFieldBase {
  id: string;
  label: string;
  description?: string;
  required?: boolean;
}

export interface RunVariableStringField extends RunVariableFieldBase {
  type: "text" | "multiline" | "url" | "path" | "date" | "datetime";
  default?: string;
  minLength?: number;
  maxLength?: number;
}

export interface RunVariableNumberField extends RunVariableFieldBase {
  type: "number";
  default?: number;
  minimum?: number;
  maximum?: number;
}

export interface RunVariableBooleanField extends RunVariableFieldBase {
  type: "boolean";
  default?: boolean;
}

export interface RunVariableSelectField extends RunVariableFieldBase {
  type: "select";
  default?: string;
  options: Array<{ value: string; label: string }>;
}

export type RunVariableField =
  | RunVariableStringField
  | RunVariableNumberField
  | RunVariableBooleanField
  | RunVariableSelectField;

export interface RunVariableSchema {
  version: typeof RUN_VARIABLE_SCHEMA_VERSION;
  fields: RunVariableField[];
}

export interface RunVariableValidationResult {
  schema: RunVariableSchema;
  schemaHash: string;
  bindings: RunVariableBindings;
  bindingsHash: string;
}

export interface RunTemplateInvocation {
  ownerKind: "prompt_pack" | "agent_preset";
  ownerId: string;
  ownerRevision: string;
  templateId?: string;
  schemaHash: string;
  values: RunVariableBindings;
}

export interface RunVariableEvidence {
  ownerKind: RunTemplateInvocation["ownerKind"];
  ownerId: string;
  ownerRevision: string;
  templateId?: string;
  schemaHash: string;
  bindingsHash: string;
  bindings: RunVariableBindings;
  resolvedInputHash: string;
}

const FIELD_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_DATETIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

export function normalizeRunVariableSchema(input: RunVariableSchema): RunVariableSchema {
  if (input.version !== RUN_VARIABLE_SCHEMA_VERSION) throw new TypeError("Unsupported run-variable schema version.");
  if (!Array.isArray(input.fields) || input.fields.length > RUN_VARIABLE_MAX_FIELDS) {
    throw new TypeError(`Run-variable schemas are limited to ${RUN_VARIABLE_MAX_FIELDS} fields.`);
  }
  const seen = new Set<string>();
  const fields = input.fields.map((field) => normalizeField(field, seen));
  const schema = { version: RUN_VARIABLE_SCHEMA_VERSION, fields } satisfies RunVariableSchema;
  // Validate defaults through the same path used for submitted bindings.
  validateRunVariableBindings(schema, {}, { applyDefaults: true, allowMissingRequired: true });
  return schema;
}

export function hashRunVariableSchema(schema: RunVariableSchema): string {
  return sha256Hex(canonicalJsonString(normalizeRunVariableSchema(schema)));
}

export function validateRunVariableBindings(
  schemaInput: RunVariableSchema,
  input: Record<string, unknown>,
  options: { applyDefaults?: boolean; allowMissingRequired?: boolean } = {},
): RunVariableValidationResult {
  const schema = normalizeSchemaWithoutDefaultRecursion(schemaInput);
  const declared = new Set(schema.fields.map((field) => field.id));
  const undeclared = Object.keys(input).filter((key) => !declared.has(key));
  if (undeclared.length > 0) throw new TypeError(`Undeclared run variable(s): ${undeclared.sort().join(", ")}.`);

  const bindings: RunVariableBindings = {};
  for (const field of schema.fields) {
    const supplied = Object.prototype.hasOwnProperty.call(input, field.id);
    const value = supplied ? input[field.id] : options.applyDefaults === false ? undefined : field.default;
    if (value === undefined || value === "") {
      if (field.required && !options.allowMissingRequired)
        throw new TypeError(`Missing required run variable: ${field.id}.`);
      continue;
    }
    bindings[field.id] = validateFieldValue(field, value);
  }
  const schemaHash = sha256Hex(canonicalJsonString(schema));
  return {
    schema,
    schemaHash,
    bindings,
    bindingsHash: sha256Hex(canonicalJsonString(bindings)),
  };
}

export function resolveRunVariableTemplate(
  template: string,
  schema: RunVariableSchema,
  bindings: RunVariableBindings,
): string {
  const validation = validateRunVariableBindings(schema, bindings);
  const declared = new Map(validation.schema.fields.map((field) => [field.id, field]));
  return template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/giu, (match, rawId: string) => {
    const id = rawId.toLowerCase();
    if (!declared.has(id)) throw new TypeError(`Template references undeclared run variable: ${id}.`);
    if (!Object.prototype.hasOwnProperty.call(validation.bindings, id)) {
      throw new TypeError(`Template variable ${id} has no validated value.`);
    }
    return String(validation.bindings[id]);
  });
}

/** Resolve legacy `<LABEL>` placeholders through the same declared schema. */
export function resolveLegacyRunVariableTemplate(
  template: string,
  schema: RunVariableSchema,
  bindings: RunVariableBindings,
): string {
  const validation = validateRunVariableBindings(schema, bindings);
  const declared = new Set(validation.schema.fields.map((field) => field.id));
  return template.replace(/<([^<>\r\n]+)>/gu, (_match, rawLabel: string) => {
    const id = normalizeLegacyPlaceholderId(rawLabel);
    if (!declared.has(id)) throw new TypeError(`Template references undeclared run variable: ${id}.`);
    if (!Object.prototype.hasOwnProperty.call(validation.bindings, id)) {
      throw new TypeError(`Template variable ${id} has no validated value.`);
    }
    return String(validation.bindings[id]);
  });
}

export function buildRunVariableEvidence(
  invocation: RunTemplateInvocation,
  schema: RunVariableSchema,
  resolvedInput: string,
): RunVariableEvidence {
  const validation = validateRunVariableBindings(schema, invocation.values);
  if (validation.schemaHash !== invocation.schemaHash)
    throw new TypeError("Run-variable schema changed; reopen the form.");
  return {
    ownerKind: invocation.ownerKind,
    ownerId: invocation.ownerId,
    ownerRevision: invocation.ownerRevision,
    ...(invocation.templateId ? { templateId: invocation.templateId } : {}),
    schemaHash: validation.schemaHash,
    bindingsHash: validation.bindingsHash,
    bindings: validation.bindings,
    resolvedInputHash: sha256Hex(resolvedInput),
  };
}

export function legacyPlaceholderSchema(placeholders: readonly string[]): RunVariableSchema {
  const ids = new Set<string>();
  return normalizeRunVariableSchema({
    version: RUN_VARIABLE_SCHEMA_VERSION,
    fields: placeholders.map((placeholder, index) => {
      const normalized = normalizeLegacyPlaceholderId(placeholder);
      let id = /^[a-z]/u.test(normalized) ? normalized.slice(0, 64) : `value_${index + 1}`;
      while (ids.has(id)) id = `${id.slice(0, 59)}_${index + 1}`;
      ids.add(id);
      return { id, label: placeholder.replace(/^<|>$/gu, "").trim() || id, type: "text", required: true };
    }),
  });
}

function normalizeLegacyPlaceholderId(value: string): string {
  return value
    .replace(/^<|>$/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function normalizeSchemaWithoutDefaultRecursion(input: RunVariableSchema): RunVariableSchema {
  if (input.version !== RUN_VARIABLE_SCHEMA_VERSION) throw new TypeError("Unsupported run-variable schema version.");
  if (!Array.isArray(input.fields) || input.fields.length > RUN_VARIABLE_MAX_FIELDS) {
    throw new TypeError(`Run-variable schemas are limited to ${RUN_VARIABLE_MAX_FIELDS} fields.`);
  }
  const seen = new Set<string>();
  return { version: RUN_VARIABLE_SCHEMA_VERSION, fields: input.fields.map((field) => normalizeField(field, seen)) };
}

function normalizeField(field: RunVariableField, seen: Set<string>): RunVariableField {
  const id = field.id.trim().toLowerCase();
  if (!FIELD_ID.test(id)) throw new TypeError(`Invalid run-variable field id: ${field.id}.`);
  if (seen.has(id)) throw new TypeError(`Duplicate run-variable field id: ${id}.`);
  seen.add(id);
  const label = field.label.trim();
  if (!label || label.length > 120) throw new TypeError(`Invalid label for run variable ${id}.`);
  const base = {
    id,
    label,
    ...(field.description?.trim() ? { description: field.description.trim().slice(0, 500) } : {}),
    ...(field.required ? { required: true } : {}),
  };
  if (field.type === "select") {
    if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 100) {
      throw new TypeError(`Select run variable ${id} requires 1-100 options.`);
    }
    const optionValues = new Set<string>();
    const options = field.options.map((option) => {
      const value = option.value.trim();
      const optionLabel = option.label.trim();
      if (!value || !optionLabel || optionValues.has(value))
        throw new TypeError(`Invalid option for run variable ${id}.`);
      optionValues.add(value);
      return { value, label: optionLabel };
    });
    return { ...base, type: "select", options, ...(field.default !== undefined ? { default: field.default } : {}) };
  }
  if (field.type === "number") {
    if (field.minimum !== undefined && !Number.isFinite(field.minimum))
      throw new TypeError(`Invalid minimum for ${id}.`);
    if (field.maximum !== undefined && !Number.isFinite(field.maximum))
      throw new TypeError(`Invalid maximum for ${id}.`);
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
      throw new TypeError(`Minimum exceeds maximum for ${id}.`);
    }
    return {
      ...base,
      type: "number",
      ...(field.default !== undefined ? { default: field.default } : {}),
      ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
      ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
    };
  }
  if (field.type === "boolean") {
    return { ...base, type: "boolean", ...(field.default !== undefined ? { default: field.default } : {}) };
  }
  if (!["text", "multiline", "url", "path", "date", "datetime"].includes(field.type)) {
    throw new TypeError(`Unsupported run-variable type for ${id}.`);
  }
  const minLength = field.minLength;
  const maxLength = field.maxLength ?? (field.type === "multiline" ? 32_000 : 4_000);
  if (minLength !== undefined && (!Number.isInteger(minLength) || minLength < 0))
    throw new TypeError(`Invalid minimum length for ${id}.`);
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 100_000 || (minLength ?? 0) > maxLength) {
    throw new TypeError(`Invalid maximum length for ${id}.`);
  }
  return {
    ...base,
    type: field.type,
    ...(field.default !== undefined ? { default: field.default } : {}),
    ...(minLength !== undefined ? { minLength } : {}),
    maxLength,
  };
}

function validateFieldValue(field: RunVariableField, value: unknown): RunVariableValue {
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new TypeError(`Run variable ${field.id} must be boolean.`);
    return value;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new TypeError(`Run variable ${field.id} must be finite.`);
    if (field.minimum !== undefined && value < field.minimum)
      throw new TypeError(`Run variable ${field.id} is below its minimum.`);
    if (field.maximum !== undefined && value > field.maximum)
      throw new TypeError(`Run variable ${field.id} exceeds its maximum.`);
    return value;
  }
  if (typeof value !== "string") throw new TypeError(`Run variable ${field.id} must be text.`);
  if (field.type === "select") {
    if (!field.options.some((option) => option.value === value))
      throw new TypeError(`Run variable ${field.id} is not an allowed option.`);
    return value;
  }
  if (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? 4_000)) {
    throw new TypeError(`Run variable ${field.id} violates its length bounds.`);
  }
  if (field.type === "url") {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new TypeError(`Run variable ${field.id} must be an absolute HTTP(S) URL.`);
    }
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new TypeError(`Run variable ${field.id} must be an absolute HTTP(S) URL.`);
  }
  if (field.type === "date" && (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) {
    throw new TypeError(`Run variable ${field.id} must be an ISO date.`);
  }
  if (field.type === "datetime" && (!ISO_DATETIME_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value)))) {
    throw new TypeError(`Run variable ${field.id} must be an ISO datetime with a timezone offset.`);
  }
  return value;
}
