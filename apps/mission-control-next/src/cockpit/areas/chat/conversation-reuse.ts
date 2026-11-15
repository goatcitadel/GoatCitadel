import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";

type SessionRail = MissionThreadedRenderSurfaceInput["sessionRail"];

function matchesProject(session: ChatSessionRecord, selectedProjectId: string): boolean {
  if (selectedProjectId === "all" || selectedProjectId === "none") return !session.projectId;
  return session.projectId === selectedProjectId;
}

/** The most recently updated conversation that holds nothing yet, in the project the list is showing. */
export function findReusableEmptyConversation(
  sessions: readonly ChatSessionRecord[],
  selectedProjectId: string,
): ChatSessionRecord | undefined {
  let found: ChatSessionRecord | undefined;
  for (const session of sessions) {
    const empty =
      !session.lastMessagePreview &&
      session.tokenTotal === 0 &&
      session.lifecycleStatus === "active" &&
      !session.pinned &&
      matchesProject(session, selectedProjectId);
    if (empty && (!found || session.updatedAt > found.updatedAt)) found = session;
  }
  return found;
}

/** New: open the empty conversation already there, or create one when there is none. */
export function startConversation(rail: SessionRail): void {
  const reusable = findReusableEmptyConversation(rail.missionSessions, rail.selectedProjectId);
  if (reusable) rail.onSelectSession(reusable.sessionId);
  else void rail.onCreateSession();
}
