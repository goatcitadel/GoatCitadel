/** A workspace inventory reference. Bytes and execution evidence stay with their original owner. */
export interface ScriptInventoryItem {
  id: string;
  workspaceId: string;
  title: string;
  kind: "generated" | "managed" | "workspace" | "tool" | "code";
  sourceId: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  projectId?: string;
  path?: string;
  revision?: string;
  createdAt?: string;
  retention: "temporary" | "permanent";
  retentionVersion: number;
  /** No expiry is invented from a temporary label. */
  expiresAt: null;
}
export interface ScriptInventoryResponse {
  items: ScriptInventoryItem[];
  coverage: string;
}
export interface ScriptRetentionUpdate {
  workspaceId: string;
  id: string;
  retention: ScriptInventoryItem["retention"];
  expectedVersion: number;
}
