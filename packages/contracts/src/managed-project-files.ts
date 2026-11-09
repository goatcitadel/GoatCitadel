export interface ManagedProjectFileScope {
  workspaceId: string;
  projectId: string;
}

export interface ManagedProjectFileTarget extends ManagedProjectFileScope {
  path: string;
}

export interface ManagedProjectFileRevision extends ManagedProjectFileTarget {
  revisionId: string;
  previousRevisionId: string | null;
  contentSha256: string | null;
  byteLength: number;
  deleted: boolean;
  canRestore: boolean;
}

export interface ManagedProjectFileReceipt extends ManagedProjectFileRevision {
  replayed: boolean;
}

export interface ManagedProjectFileRestoreRequest {
  path: string;
  expectedRevision: string;
  expectedModeRevision: string;
}

export function isManagedProjectFileTool(toolName: string): boolean {
  return toolName.startsWith("project.files.");
}

/** File bytes belong to managed storage and the active read caller, not tool evidence. */
export function projectManagedFileToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!isManagedProjectFileTool(toolName)) return args;
  return pickFileMetadata(args, ["path", "prefix", "limit", "expectedRevision"]);
}

export function projectManagedFileToolResult(
  toolName: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (!isManagedProjectFileTool(toolName)) return result;
  const metadata = [
    "kind",
    "workspaceId",
    "projectId",
    "path",
    "revisionId",
    "previousRevisionId",
    "contentSha256",
    "byteLength",
    "deleted",
    "canRestore",
    "replayed",
    "previewUnavailable",
  ];
  const projected = pickFileMetadata(result, metadata);
  if (Array.isArray(result.items)) {
    projected.items = result.items.map((item: unknown) => pickFileMetadata(item, metadata));
  }
  return projected;
}

function pickFileMetadata(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.flatMap((key) => {
      const entry = record[key];
      return entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
        ? [[key, entry]]
        : [];
    }),
  );
}
