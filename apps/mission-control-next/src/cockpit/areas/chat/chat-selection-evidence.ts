import type { ChatGeneratedArtifactRecord, ChatSessionRecord, ChatHistoryWindowResponse } from "@goatcitadel/contracts";

export interface ChatLocationSelection {
  sessionId?: string | null;
  turnId?: string | null;
  artifactId?: string | null;
  messageId?: string;
  sequence?: number;
}

export interface ChatSelectionEvidence {
  selectedSessionId: string | null;
  sessions: readonly Pick<ChatSessionRecord, "sessionId" | "workspaceId" | "scope">[];
  active: {
    workspaceId: string;
    selectedSessionId: string | null;
    selectedTurnId: string | null;
    thread: { sessionId: string; turns: readonly { turnId: string }[] } | null;
    historicalWindow?: ChatHistoryWindowResponse | null;
    activeGeneratedArtifact?: Pick<ChatGeneratedArtifactRecord, "artifactId" | "workspaceId" | "sessionId" | "turnId"> | null;
  } | null;
}

/** This checks rendered owner evidence; it neither selects a conversation nor admits runtime work. */
export function chatSelectionMatches(selection: ChatLocationSelection, evidence: ChatSelectionEvidence, workspaceId: string) {
  const sessionId = selection.sessionId || null;
  if (evidence.selectedSessionId !== sessionId) return false;
  if (!sessionId) return !evidence.active && !selection.turnId && !selection.artifactId && !selection.messageId && selection.sequence === undefined;
  const session = evidence.sessions.find((item) => item.sessionId === sessionId);
  if (!session || session.workspaceId !== workspaceId) return false;
  // A listed canonical session is sufficient for the selected-session URL even
  // when thread hydration fails. Deep targets need their independent owner data.
  if (selection.messageId !== undefined || selection.sequence !== undefined) {
    if (selection.turnId || selection.artifactId) return false;
    const active = evidence.active;
    const anchor = active?.historicalWindow?.anchor;
    return Boolean(active && active.workspaceId === workspaceId && active.selectedSessionId === sessionId && anchor && anchor.state === "found"
      && anchor.workspaceId === workspaceId && anchor.sessionId === sessionId && anchor.messageId === selection.messageId
      && Number.isSafeInteger(selection.sequence) && selection.sequence! > 0 && anchor.sequence === selection.sequence);
  }
  if (!selection.turnId && !selection.artifactId) return true;
  const active = evidence.active;
  if (!active || active.workspaceId !== workspaceId || active.selectedSessionId !== sessionId) return false;
  if (!active.thread || active.thread.sessionId !== sessionId) return false;
  if (selection.turnId && (active.selectedTurnId !== selection.turnId || !active.thread.turns.some((turn) => turn.turnId === selection.turnId))) return false;
  const artifact = active.activeGeneratedArtifact;
  if (!selection.artifactId) return !artifact;
  return Boolean(artifact && artifact.artifactId === selection.artifactId && artifact.workspaceId === workspaceId &&
    artifact.sessionId === sessionId && artifact.turnId === selection.turnId);
}

export function chatSelectionHref(selection: ChatLocationSelection) {
  const query = new URLSearchParams({ shell: "cockpit" });
  for (const key of ["sessionId", "turnId", "artifactId"] as const) if (selection[key]) query.set(key, selection[key]!);
  if (selection.messageId && Number.isSafeInteger(selection.sequence) && selection.sequence! > 0) {
    query.set("messageId", selection.messageId); query.set("sequence", String(selection.sequence));
  }
  return `/chat?${query}`;
}
