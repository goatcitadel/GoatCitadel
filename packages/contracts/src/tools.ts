export type ToolRiskLevel = "safe" | "caution" | "danger" | "nuclear";

export type ToolCategory =
  | "session"
  | "memory"
  | "fs"
  | "http"
  | "shell"
  | "git"
  | "research"
  | "comms"
  | "knowledge"
  | "ops";

export type ToolPack = "core" | "devops" | "knowledge" | "comms";

export interface ToolInvokeConsentContext {
  operatorId?: string;
  source?: "ui" | "tui" | "agent";
  reason?: string;
}

const CAUTION_MUTATING_TOOL_NAMES = new Set([
  "fs.copy",
  "git.branch.create",
  "memory.write",
  "memory.upsert",
  "docs.ingest",
  "embeddings.index",
  "artifacts.create",
  "documents.create",
  "presentations.create",
]);

export function isKnownMutatingToolName(toolName: string): boolean {
  return (
    CAUTION_MUTATING_TOOL_NAMES.has(toolName) ||
    /\.(send|react|unsend)$/u.test(toolName) ||
    toolName === "webhook.send" ||
    toolName === "calendar.create_event"
  );
}
