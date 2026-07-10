import { isDeepStrictEqual } from "node:util";
import type { CodeModeRunArtifactPreview } from "@goatcitadel/contracts";
import { projectPublicSecretValue } from "./public-secret-projection.js";

export function projectCapabilityPublicValue<T>(value: T): T {
  return projectPublicSecretValue(value);
}

export function projectCapabilityToolSchemaForPublic<T>(value: T): T {
  return projectJsonSchemaNode(value) as T;
}

export function projectCodeModeRunArtifactPreviewForPublic(
  preview: CodeModeRunArtifactPreview,
): CodeModeRunArtifactPreview {
  const { content, ...storedMetadata } = preview;
  const projected = projectCapabilityPublicValue(storedMetadata);
  const publicContent = projectCodeModeArtifactContent(content);
  return {
    ...projected,
    content: publicContent.value,
    publicProjection: {
      contentRedacted: publicContent.redacted,
      canonicalSha256RefersToStoredArtifact: true,
    },
  };
}

function projectCodeModeArtifactContent(content: string): { value: string; redacted: boolean } {
  try {
    const parsed = JSON.parse(content) as unknown;
    const projected = projectCapabilityPublicValue(parsed);
    const redacted = !isDeepStrictEqual(parsed, projected);
    return {
      value: redacted ? JSON.stringify(projected) : content,
      redacted,
    };
  } catch {
    const projected = projectCapabilityPublicValue(content);
    return {
      value: projected,
      redacted: projected !== content,
    };
  }
}

const JSON_SCHEMA_PROPERTY_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const JSON_SCHEMA_SINGLE_CHILD_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "schema",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const JSON_SCHEMA_ARRAY_CHILD_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const JSON_SCHEMA_SENSITIVE_VALUE_KEYS = new Set(["const", "default", "enum", "example", "examples"]);

function projectJsonSchemaNode(value: unknown, propertyName?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => projectJsonSchemaNode(item, propertyName));
  }
  if (!isRecord(value)) {
    return projectCapabilityPublicValue(value);
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (JSON_SCHEMA_PROPERTY_MAP_KEYS.has(key) && isRecord(child)) {
      output[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, projectJsonSchemaNode(schema, name)]),
      );
      continue;
    }
    if ((key === "dependentSchemas" || key === "dependencies") && isRecord(child)) {
      output[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, projectJsonSchemaDependency(schema, name)]),
      );
      continue;
    }
    if (key === "dependentRequired" && isRecord(child)) {
      output[key] = Object.fromEntries(
        Object.entries(child).map(([name, propertyNames]) => [
          name,
          Array.isArray(propertyNames)
            ? propertyNames.map((property) => projectCapabilityPublicValue(property))
            : projectCapabilityPublicValue(propertyNames),
        ]),
      );
      continue;
    }
    if (JSON_SCHEMA_SINGLE_CHILD_KEYS.has(key) && (isRecord(child) || Array.isArray(child))) {
      output[key] = projectJsonSchemaNode(child, propertyName);
      continue;
    }
    if (JSON_SCHEMA_ARRAY_CHILD_KEYS.has(key) && Array.isArray(child)) {
      output[key] = child.map((schema) => projectJsonSchemaNode(schema, propertyName));
      continue;
    }
    if (JSON_SCHEMA_SENSITIVE_VALUE_KEYS.has(key)) {
      output[key] = projectSchemaPropertyValue(propertyName ?? "schemaValue", child);
      continue;
    }
    output[key] = projectCapabilityPublicValue(child);
  }
  return output;
}

function projectSchemaPropertyValue(propertyName: string, value: unknown): unknown {
  const inheritedSensitiveProperty = isSensitiveSchemaPropertyName(propertyName);
  if (Array.isArray(value)) {
    return value.map((item) => projectSchemaPropertyValue(propertyName, item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        projectSchemaPropertyValue(inheritedSensitiveProperty ? propertyName : key, child),
      ]),
    );
  }
  const projected = projectCapabilityPublicValue({ [propertyName]: value }) as Record<string, unknown>;
  return projected[propertyName];
}

function projectJsonSchemaDependency(value: unknown, propertyName: string): unknown {
  if (Array.isArray(value)) {
    return value.map((property) => projectCapabilityPublicValue(property));
  }
  return projectJsonSchemaNode(value, propertyName);
}

function isSensitiveSchemaPropertyName(propertyName: string): boolean {
  const probe = "schema-sensitive-value";
  const projected = projectCapabilityPublicValue({ [propertyName]: probe }) as Record<string, unknown>;
  return projected[propertyName] !== probe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
