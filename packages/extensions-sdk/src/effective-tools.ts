import type {
  CompactToolDirectorySnapshot,
  EffectiveToolGrantSummary,
  ToolSchemaRef,
} from "@goatcitadel/contracts";

export interface EffectiveToolSnapshotValidationResult {
  ok: boolean;
  errors: string[];
  callableToolCount: number;
  schemaRefCount: number;
}

export interface EffectiveToolSchemaDereferenceResult<TSchema = unknown> {
  ref: ToolSchemaRef;
  schema: TSchema;
}

export type EffectiveToolSchemaFetcher<TSchema = unknown> = (ref: ToolSchemaRef) => Promise<TSchema> | TSchema;

export function validateCompactToolDirectorySnapshot(
  snapshot: unknown,
): EffectiveToolSnapshotValidationResult {
  const errors: string[] = [];
  const candidate = snapshot as Partial<CompactToolDirectorySnapshot> | undefined;
  if (!candidate || typeof candidate !== "object") {
    errors.push("snapshot must be an object");
    return { ok: false, errors, callableToolCount: 0, schemaRefCount: 0 };
  }
  if (candidate.version !== "compact-tool-directory.v1") {
    errors.push("snapshot.version must be compact-tool-directory.v1");
  }
  if (candidate.source !== "callable_catalog") {
    errors.push("snapshot.source must be callable_catalog");
  }
  if (!Array.isArray(candidate.tools)) {
    errors.push("snapshot.tools must be an array");
  }
  const tools = Array.isArray(candidate.tools) ? candidate.tools : [];
  tools.forEach((tool, index) => {
    validateEffectiveToolSummary(tool, `tools.${index}`, errors);
  });
  const schemaRefKeys = new Set(
    tools
      .map((tool) => tool?.schemaRef)
      .filter(isToolSchemaRef)
      .map((ref) => ref.refId),
  );
  return {
    ok: errors.length === 0,
    errors,
    callableToolCount: tools.length,
    schemaRefCount: schemaRefKeys.size,
  };
}

export function listEffectiveCallableTools(snapshot: CompactToolDirectorySnapshot): EffectiveToolGrantSummary[] {
  assertValidCompactToolDirectorySnapshot(snapshot);
  return [...snapshot.tools];
}

export function findEffectiveToolByName(
  snapshot: CompactToolDirectorySnapshot,
  toolName: string,
): EffectiveToolGrantSummary | undefined {
  assertValidCompactToolDirectorySnapshot(snapshot);
  const normalized = toolName.trim();
  return snapshot.tools.find((tool) => tool.toolName === normalized);
}

export function buildToolSchemaRefIndex(snapshot: CompactToolDirectorySnapshot): Map<string, ToolSchemaRef> {
  assertValidCompactToolDirectorySnapshot(snapshot);
  const refs = new Map<string, ToolSchemaRef>();
  for (const tool of snapshot.tools) {
    refs.set(tool.schemaRef.refId, tool.schemaRef);
    refs.set(tool.toolName, tool.schemaRef);
  }
  return refs;
}

export async function dereferenceEffectiveToolSchema<TSchema = unknown>(
  snapshot: CompactToolDirectorySnapshot,
  toolNameOrRefId: string,
  fetcher: EffectiveToolSchemaFetcher<TSchema>,
): Promise<EffectiveToolSchemaDereferenceResult<TSchema>> {
  const ref = buildToolSchemaRefIndex(snapshot).get(toolNameOrRefId.trim());
  if (!ref) {
    throw new Error(`Unknown compact tool schema ref: ${toolNameOrRefId}`);
  }
  return {
    ref,
    schema: await fetcher(ref),
  };
}

function assertValidCompactToolDirectorySnapshot(snapshot: CompactToolDirectorySnapshot): void {
  const validation = validateCompactToolDirectorySnapshot(snapshot);
  if (!validation.ok) {
    throw new Error(`Invalid compact tool directory snapshot: ${validation.errors.join("; ")}`);
  }
}

function validateEffectiveToolSummary(value: unknown, path: string, errors: string[]): void {
  const tool = value as Partial<EffectiveToolGrantSummary> | undefined;
  if (!tool || typeof tool !== "object") {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const field of ["capabilityId", "toolName", "title", "summary", "riskLabel"] as const) {
    if (typeof tool[field] !== "string" || !tool[field]?.trim()) {
      errors.push(`${path}.${field} must be a non-empty string`);
    }
  }
  for (const field of ["readOnly", "deterministic", "codeModeAllowed"] as const) {
    if (typeof tool[field] !== "boolean") {
      errors.push(`${path}.${field} must be a boolean`);
    }
  }
  if (!isToolSchemaRef(tool.schemaRef)) {
    errors.push(`${path}.schemaRef must be a ToolSchemaRef`);
  }
}

function isToolSchemaRef(value: unknown): value is ToolSchemaRef {
  const ref = value as Partial<ToolSchemaRef> | undefined;
  return Boolean(
    ref &&
      typeof ref.refId === "string" &&
      ref.refId.trim() &&
      typeof ref.toolName === "string" &&
      ref.toolName.trim() &&
      typeof ref.schemaHash === "string" &&
      ref.schemaHash.trim() &&
      typeof ref.schemaUri === "string" &&
      ref.schemaUri.trim(),
  );
}
