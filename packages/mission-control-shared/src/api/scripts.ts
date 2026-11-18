import type { ScriptInventoryItem, ScriptInventoryResponse, ScriptRetentionUpdate } from "@goatcitadel/contracts";
import { request } from "./client-core.js";
export function fetchScripts(workspaceId: string, signal?: AbortSignal): Promise<ScriptInventoryResponse> {
  return request(`/api/v1/scripts?${new URLSearchParams({ workspaceId })}`, { signal, cache: "no-store" });
}
export function updateScriptRetention(input: ScriptRetentionUpdate): Promise<ScriptInventoryItem> {
  return request("/api/v1/scripts/retention", { method: "PATCH", body: JSON.stringify(input) });
}
export function fetchScriptPreview(
  workspaceId: string,
  id: string,
  signal?: AbortSignal,
): Promise<{ content: string; truncated?: boolean }> {
  return request(`/api/v1/scripts/${encodeURIComponent(id)}/preview?${new URLSearchParams({ workspaceId })}`, {
    signal,
    cache: "no-store",
  });
}
