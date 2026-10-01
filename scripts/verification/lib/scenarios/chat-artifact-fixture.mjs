/** Seed a completed, visible Chat artifact without sharing a mutable Inbox fixture. */
export async function seedVisibleChatArtifact(gatewayUrl, { requestJson, assertOk }) {
  const seed = await requestJson(gatewayUrl, "/api/v1/dev/verification/seed", {
    method: "POST",
    body: {
      workspaceName: "Chat artifact verification workspace",
      sessionTitle: "Chat artifact verification conversation",
      sessionCount: 1,
      longThreadTurns: 2,
    },
  });
  assertOk(seed, "seed isolated Chat artifact conversation");
  const { workspaceId, sessionId } = seed.body ?? {};
  if (!workspaceId || !sessionId) throw new Error("The artifact seed did not return its workspace and conversation.");

  const threadPath = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/thread`;
  const initialThread = await requestJson(gatewayUrl, threadPath);
  assertOk(initialThread, "read isolated Chat artifact conversation");
  const turnId = initialThread.body?.selectedTurnId ?? initialThread.body?.activeLeafTurnId;
  if (!turnId) throw new Error("The artifact conversation has no selected completed turn.");

  const created = await requestJson(gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/generated-artifact`,
    { method: "POST", body: { supersedeLatest: true } });
  assertOk(created, "save isolated Chat artifact");
  const owner = await requestJson(gatewayUrl,
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/generated-artifacts?workspaceId=${encodeURIComponent(workspaceId)}`);
  assertOk(owner, "read isolated Chat artifacts");
  const artifact = owner.body?.items?.find((item) => item.workspaceId === workspaceId && item.sessionId === sessionId
    && item.turnId === turnId && item.artifactId && item.title);
  if (!artifact) throw new Error("The isolated Chat artifact is absent from its workspace owner list.");

  const projected = await requestJson(gatewayUrl, threadPath);
  assertOk(projected, "read isolated Chat artifact projection");
  const visibleTurn = projected.body?.turns?.find((turn) => turn.turnId === turnId && turn.branch?.isSelectedPath);
  if (!visibleTurn?.generatedArtifacts?.some((item) => item.artifactId === artifact.artifactId)) {
    throw new Error("The isolated Chat artifact is absent from the selected conversation path.");
  }
  return { workspaceId, sessionId, artifact, turn: visibleTurn };
}
