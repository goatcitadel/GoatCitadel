import { redactStructuredSecrets, type McpServerRecord, type McpServerUpdateInput } from "@goatcitadel/contracts";
import { preserveKnownPublicProjectionSecretsForUpdate } from "./integration-connection-public-projection.js";
import { projectCredentialUrlsInText, projectPublicSecretValue } from "./public-secret-projection.js";

const ARGV_LIKE_KEY_PATTERN = /^(?:argv|args|execArgv|commandArgs|command_argv)$/i;
const SECRET_ARG_FLAG_PATTERN =
  /^--?(?:api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|authorization|proxy-authorization)(?:=|$)/i;
const SENSITIVE_SCHEMA_PROPERTY_PATTERN =
  /(?:^|[-_])(?:api[-_]?key|apikey|access[-_]?key|private[-_]?key|authorization|auth|bearer|cookie|credential|credentials|password|passwd|secret|signature|token)(?:[-_]|$)/i;
const SCHEMA_VALUE_KEYS = new Set(["const", "default", "enum", "example", "examples"]);
const MARKER = "[REDACTED]";

/**
 * Builds a detached MCP response projection. Runtime-owned server configuration and
 * invocation results remain untouched; only the value crossing an operator/model
 * boundary is sanitized.
 *
 * The shared structured projector owns key/value redaction. MCP adds two shapes the
 * generic projector cannot infer safely: secret flag/value pairs in stdio argv and
 * credentials encoded as URL path segments.
 */
export function projectMcpPublicValue<T>(value: T): T {
  const projected = projectPublicSecretValue(value);
  return projectMcpSpecificShapes(value, projected) as T;
}

export function preserveMcpServerSecretsForPublicUpdate(
  current: McpServerRecord,
  incoming: McpServerUpdateInput,
): McpServerUpdateInput {
  const editable = toMcpServerUpdateShape(current);
  const projected = projectMcpPublicValue(editable);
  const { args: rawArgs, ...editableRest } = editable;
  const { args: projectedArgs, ...projectedRest } = projected;
  const { args: incomingArgs, ...incomingRest } = incoming;
  const reconciled = preserveKnownPublicProjectionSecretsForUpdate(
    editableRest as Record<string, unknown>,
    projectedRest as Record<string, unknown>,
    incomingRest as Record<string, unknown>,
  ) as McpServerUpdateInput;
  if (incomingArgs === undefined) {
    return reconciled;
  }
  return {
    ...reconciled,
    args: reconcileMcpArgvForPublicUpdate(rawArgs ?? [], projectedArgs ?? [], incomingArgs),
  };
}

function toMcpServerUpdateShape(server: McpServerRecord): McpServerUpdateInput {
  return {
    label: server.label,
    command: server.command,
    args: server.args,
    url: server.url,
    authType: server.authType,
    oauth: server.oauth,
    enabled: server.enabled,
    category: server.category,
    trustTier: server.trustTier,
    costTier: server.costTier,
    policy: server.policy,
    verifiedAt: server.verifiedAt,
  };
}

function projectMcpSpecificShapes(original: unknown, projected: unknown, key?: string): unknown {
  if (Array.isArray(projected)) {
    if (key && ARGV_LIKE_KEY_PATTERN.test(key)) {
      return projectArgv(projected);
    }
    const originalItems = Array.isArray(original) ? original : [];
    return projected.map((item, index) => projectMcpSpecificShapes(originalItems[index], item));
  }
  if (!projected || typeof projected !== "object") {
    return typeof projected === "string" ? projectCredentialUrlsInText(projected) : projected;
  }

  const originalRecord =
    original && typeof original === "object" && !Array.isArray(original) ? (original as Record<string, unknown>) : {};
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(projected as Record<string, unknown>)) {
    if (shouldRestoreMcpMetadata(childKey, originalRecord[childKey])) {
      output[childKey] = projectMcpPublicValue(originalRecord[childKey]);
      continue;
    }
    if (childKey === "inputSchema" && originalRecord[childKey] && typeof originalRecord[childKey] === "object") {
      output[childKey] = projectJsonSchema(originalRecord[childKey]);
      continue;
    }
    output[childKey] = projectMcpSpecificShapes(originalRecord[childKey], child, childKey);
  }
  return output;
}

function projectArgv(argv: unknown[]): unknown[] {
  let redactNext = false;
  return argv.map((entry) => {
    if (redactNext) {
      redactNext = false;
      return MARKER;
    }
    if (typeof entry !== "string") {
      return entry;
    }
    if (!SECRET_ARG_FLAG_PATTERN.test(entry)) {
      return projectCredentialUrlsInText(entry);
    }
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex >= 0) {
      return `${entry.slice(0, equalsIndex + 1)}${MARKER}`;
    }
    redactNext = true;
    return entry;
  });
}

function reconcileMcpArgvForPublicUpdate(raw: string[], projected: string[], incoming: string[]): string[] {
  if (incoming.length === 0) {
    return [];
  }

  const reconciled = [...incoming];
  for (let index = 0; index < incoming.length; index += 1) {
    const publicEntry = incoming[index] ?? "";
    if (!containsMcpRedactionMarker(publicEntry)) {
      continue;
    }
    const normalizedPublicEntry = normalizeMcpRedactionMarkers(publicEntry);

    const rawEntry = raw[index];
    const projectedEntry = projected[index];
    if (rawEntry === undefined || projectedEntry === undefined || normalizedPublicEntry !== projectedEntry) {
      return [...raw];
    }

    const equalsIndex = rawEntry.indexOf("=");
    if (
      equalsIndex >= 0 &&
      SECRET_ARG_FLAG_PATTERN.test(rawEntry) &&
      projectedEntry === `${rawEntry.slice(0, equalsIndex + 1)}${MARKER}`
    ) {
      reconciled[index] = rawEntry;
      continue;
    }

    const anchorIndex = index - 1;
    const rawAnchor = raw[anchorIndex];
    if (
      anchorIndex >= 0 &&
      rawAnchor !== undefined &&
      SECRET_ARG_FLAG_PATTERN.test(rawAnchor) &&
      !rawAnchor.includes("=") &&
      projected[anchorIndex] === rawAnchor &&
      incoming[anchorIndex] === rawAnchor &&
      projectedEntry === MARKER &&
      normalizedPublicEntry === MARKER
    ) {
      reconciled[index] = rawEntry;
      continue;
    }

    return [...raw];
  }

  return reconciled;
}

function containsMcpRedactionMarker(value: string): boolean {
  return /\[REDACTED\]/i.test(value);
}

function normalizeMcpRedactionMarkers(value: string): string {
  return value.replace(/\[REDACTED\]/gi, MARKER);
}

function shouldRestoreMcpMetadata(key: string, value: unknown): boolean {
  switch (key) {
    case "authReadiness":
      return (
        typeof value === "string" &&
        ["not_required", "needs_auth", "ready", "expired", "missing_oauth_config"].includes(value)
      );
    case "authState":
      return Boolean(value && typeof value === "object" && !Array.isArray(value));
    case "requiresGatewayAuth":
      return typeof value === "boolean";
    case "needsAuth":
    case "redactedSecretCount":
    case "tokenRefreshSkewSeconds":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return false;
  }
}

function projectJsonSchema(value: unknown, sensitiveProperty = false): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => projectJsonSchema(entry, sensitiveProperty));
  }
  if (!value || typeof value !== "object") {
    return redactStructuredSecrets(value, { redactEnvAssignmentsAsWhole: true }).value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      output[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([propertyName, propertySchema]) => [
          propertyName,
          projectJsonSchema(propertySchema, SENSITIVE_SCHEMA_PROPERTY_PATTERN.test(propertyName)),
        ]),
      );
      continue;
    }
    if (sensitiveProperty && SCHEMA_VALUE_KEYS.has(key.toLowerCase())) {
      output[key] = redactSchemaValue(child);
      continue;
    }
    const nested = projectJsonSchema(child, sensitiveProperty);
    output[key] = redactStructuredSecrets({ [key]: nested }, { redactEnvAssignmentsAsWhole: true }).value[key];
  }
  return output;
}

function redactSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(() => MARKER);
  }
  return MARKER;
}
