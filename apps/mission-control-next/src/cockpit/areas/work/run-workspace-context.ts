import type { ChatSessionWorkbenchRecord } from "@goatcitadel/contracts";
import {
  fetchChatSessionStatus,
  fetchChatSessionWorkbench,
  fetchChatSessionWorkbenchFile,
  fetchChatSessionWorkbenchTree,
} from "@goatcitadel/mission-control-shared/api/chat";
import type { ObserveRunTraceResponse } from "@goatcitadel/mission-control-shared/api/durable";
import { durableRunWorkspaceId } from "../../data/durable-run-scope";

export const MAX_WORKSPACE_PREVIEW_BYTES = 64 * 1024;

/** Consume the Gateway's resolved identity; never infer a session from side records. */
export function runWorkspaceSession(trace: ObserveRunTraceResponse, workspaceId: string): string | null {
  const lifecycle = trace.lifecycle?.state === "available" ? trace.lifecycle.response : undefined;
  const sessionId = lifecycle?.canonical.sessionId;
  if (!sessionId || trace.runId !== trace.run.runId || lifecycle?.canonical.runId !== trace.runId
    || durableRunWorkspaceId(trace.run) !== workspaceId) return null;
  const recordedSessions = [trace.run.payload.sessionId, trace.run.metadata?.sessionId,
    lifecycle.session?.sessionId, trace.session?.item?.sessionId];
  if (recordedSessions.some((value) => value !== undefined && value !== sessionId)) return null;
  return sessionId;
}

export interface WorkspaceInspectionScope {
  workspaceId: string;
  sessionId: string;
  isCurrent: () => boolean;
}

function assertCurrent(scope: WorkspaceInspectionScope) {
  if (!scope.isCurrent()) throw new Error("This inspection is no longer active.");
}

async function verifySession(scope: WorkspaceInspectionScope) {
  assertCurrent(scope);
  const session = await fetchChatSessionStatus(scope.sessionId);
  assertCurrent(scope);
  if (session.sessionId !== scope.sessionId || session.workspaceId !== scope.workspaceId) {
    throw new Error("The conversation no longer has matching workspace evidence. Refresh the run before inspecting it.");
  }
}

function workbenchIdentity(state: ChatSessionWorkbenchRecord): string {
  return JSON.stringify([state.sessionId, state.projectId, state.worktreePath, state.baseRef, state.worktreeStatus]);
}

function assertWorkbench(scope: WorkspaceInspectionScope, state: ChatSessionWorkbenchRecord, expected?: ChatSessionWorkbenchRecord) {
  if (state.sessionId !== scope.sessionId || (expected && workbenchIdentity(state) !== workbenchIdentity(expected))) {
    throw new Error("The conversation's project or worktree changed. Refresh its context before inspecting more files.");
  }
}

export function canInspectWorkspaceFiles(state: ChatSessionWorkbenchRecord): boolean {
  return state.worktreeStatus === "ready" && Boolean(state.projectId?.trim() && state.worktreePath?.trim());
}

export async function readRunWorkspaceContext(scope: WorkspaceInspectionScope) {
  await verifySession(scope);
  const { state } = await fetchChatSessionWorkbench(scope.sessionId, { preview: true });
  assertCurrent(scope);
  assertWorkbench(scope, state);
  await verifySession(scope);
  return state;
}

async function verifyWorkbench(scope: WorkspaceInspectionScope, expected: ChatSessionWorkbenchRecord) {
  const state = await readRunWorkspaceContext(scope);
  assertWorkbench(scope, state, expected);
  if (!canInspectWorkspaceFiles(state)) throw new Error("This conversation has no ready project worktree to inspect.");
}

export async function readRunWorkspaceTree(scope: WorkspaceInspectionScope, expected: ChatSessionWorkbenchRecord) {
  await verifyWorkbench(scope, expected);
  const result = await fetchChatSessionWorkbenchTree(scope.sessionId, { preview: true });
  assertCurrent(scope);
  assertWorkbench(scope, result.state, expected);
  await verifyWorkbench(scope, expected);
  return result;
}

export async function readRunWorkspaceFile(scope: WorkspaceInspectionScope, expected: ChatSessionWorkbenchRecord, path: string) {
  await verifyWorkbench(scope, expected);
  const result = await fetchChatSessionWorkbenchFile(scope.sessionId, path, { preview: true });
  assertCurrent(scope);
  assertWorkbench(scope, result.state, expected);
  if (result.path !== path) throw new Error("The returned file does not match the selected path.");
  await verifyWorkbench(scope, expected);
  if (typeof result.content !== "string" || new TextEncoder().encode(result.content).byteLength > MAX_WORKSPACE_PREVIEW_BYTES) {
    throw new Error("This file exceeds the 64 KiB preview limit. Open the conversation's workbench to inspect it.");
  }
  return result;
}
