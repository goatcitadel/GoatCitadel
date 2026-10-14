/** Shared pure query construction; no request, state or runtime authority. */
export function codeModeRunScopeParams(input?: {
  sessionId?: string;
  turnId?: string;
  workspaceId?: string;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (input?.sessionId) {
    params.set("sessionId", input.sessionId);
  }
  if (input?.turnId) {
    params.set("turnId", input.turnId);
  }
  if (input?.workspaceId) {
    params.set("workspaceId", input.workspaceId);
  }
  return params;
}
