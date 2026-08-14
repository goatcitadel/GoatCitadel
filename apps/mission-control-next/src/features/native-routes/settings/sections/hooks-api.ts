import type { HookCreateInput, HookRecord, HookRunRecord, HookUpdateInput } from "@goatcitadel/contracts";
import { request } from "@goatcitadel/mission-control-shared/api/client-core";

const ID = /^[a-zA-Z0-9._:-]{1,256}$/u;

function workspacePath(workspaceId: string): string {
  const value = workspaceId.trim();
  if (!ID.test(value)) throw new Error("Hook request requires a valid workspace scope.");
  return `/api/v1/workspaces/${encodeURIComponent(value)}/hooks`;
}

function hookPath(workspaceId: string, hookId: string): string {
  if (!ID.test(hookId.trim())) throw new Error("Hook request requires a valid hook id.");
  return `${workspacePath(workspaceId)}/${encodeURIComponent(hookId.trim())}`;
}

/**
 * Settings-local bridge for the public shared hook client. Keeping the bridge
 * on the UI side lets a linked worktree run `pnpm dev` against the currently
 * installed shared-client artifact while the shared package is rebuilt.
 */
export async function fetchWorkspaceHooks(workspaceId: string, limit = 200): Promise<{ items: HookRecord[] }> {
  return await request(`${workspacePath(workspaceId)}?limit=${Math.max(1, Math.min(500, Math.floor(limit)))}`);
}

export async function fetchWorkspaceHookRuns(workspaceId: string, limit = 200): Promise<{ items: HookRunRecord[] }> {
  return await request(`${workspacePath(workspaceId)}/runs?limit=${Math.max(1, Math.min(500, Math.floor(limit)))}`);
}

export async function createWorkspaceHook(workspaceId: string, input: Omit<HookCreateInput, "workspaceId">): Promise<HookRecord> {
  return await request(workspacePath(workspaceId), { method: "POST", body: JSON.stringify(input) });
}

export async function updateWorkspaceHook(workspaceId: string, hookId: string, input: HookUpdateInput): Promise<HookRecord> {
  return await request(hookPath(workspaceId, hookId), { method: "PATCH", body: JSON.stringify(input) });
}

export async function deleteWorkspaceHook(workspaceId: string, hookId: string): Promise<{ deleted: boolean }> {
  return await request(hookPath(workspaceId, hookId), { method: "DELETE" });
}

export async function testWorkspaceHook(workspaceId: string, hookId: string): Promise<HookRunRecord> {
  return await request(`${hookPath(workspaceId, hookId)}/test`, { method: "POST" });
}

export async function redriveWorkspaceHookRun(workspaceId: string, runId: string): Promise<HookRunRecord> {
  if (!ID.test(runId.trim())) throw new Error("Hook request requires a valid run id.");
  return await request(`${workspacePath(workspaceId)}/runs/${encodeURIComponent(runId.trim())}/redrive`, { method: "POST" });
}
