import type { ChatGeneratedArtifactRecord, ChatSessionRecord } from "@goatcitadel/contracts";

export interface ChatLocationSelection {
  sessionId?: string | null;
  turnId?: string | null;
  artifactId?: string | null;
}

export interface ChatSelectionEvidence {
  selectedSessionId: string | null;
  sessions: readonly Pick<ChatSessionRecord, "sessionId" | "workspaceId" | "scope">[];
  active: {
    workspaceId: string;
    selectedSessionId: string | null;
    selectedTurnId: string | null;
    thread: { sessionId: string; turns: readonly { turnId: string }[] } | null;
    activeGeneratedArtifact?: Pick<ChatGeneratedArtifactRecord, "artifactId" | "workspaceId" | "sessionId" | "turnId"> | null;
  } | null;
}

/** This checks rendered owner evidence; it neither selects a conversation nor admits runtime work. */
export function chatSelectionMatches(selection: ChatLocationSelection, evidence: ChatSelectionEvidence, workspaceId: string) {
  const sessionId = selection.sessionId || null;
  if (evidence.selectedSessionId !== sessionId) return false;
  if (!sessionId) return !evidence.active && !selection.turnId && !selection.artifactId;
  const session = evidence.sessions.find((item) => item.sessionId === sessionId);
  if (!session || session.workspaceId !== workspaceId) return false;
  // A listed canonical session is sufficient for the selected-session URL even
  // when thread hydration fails. Deep targets need their independent owner data.
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
  return `/chat?${query}`;
}
