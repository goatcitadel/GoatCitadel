import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";

type SessionRail = MissionThreadedRenderSurfaceInput["sessionRail"];

function matchesProject(session: ChatSessionRecord, selectedProjectId: string): boolean {
  if (selectedProjectId === "all" || selectedProjectId === "none") return !session.projectId;
  return session.projectId === selectedProjectId;
}

/** Nothing has been said, set or attached, and the list says no turn has ever started in it. */
function isUntouched(session: ChatSessionRecord): boolean {
  const activity = session.activity;
  // Without the activity summary a send that has only just started cannot be ruled out, so it is not reused.
  if (!activity || activity.latestTurn) return false;
  if (Object.values(activity.turnCounts).some((count) => count > 0)) return false;
  return (
    !session.lastMessagePreview &&
    session.tokenTotal === 0 &&
    !session.title?.trim() &&
    !session.folderId &&
    !session.folderName &&
    !session.tags?.length &&
    !session.pinnedGoal &&
    !session.pinned &&
    !session.delegationParent &&
    !session.lastHandoff &&
    !session.forkRelationships?.length &&
    !session.generatedArtifacts?.length
  );
}

/**
 * The most recently updated conversation that holds nothing yet: an active, untouched Chat conversation of this
 * workspace in the project the list is showing. When there is any doubt it is not reusable: reuse only saves a row.
 */
export function findReusableEmptyConversation(
  sessions: readonly ChatSessionRecord[],
  selectedProjectId: string,
  workspaceId?: string,
): ChatSessionRecord | undefined {
  if (!workspaceId) return undefined;
  let found: ChatSessionRecord | undefined;
  for (const session of sessions) {
    const reusable =
      session.workspaceId === workspaceId &&
      session.scope === "mission" &&
      session.mode === "chat" &&
      session.includeInHistory &&
      !session.channelConnectionId &&
      session.lifecycleStatus === "active" &&
      matchesProject(session, selectedProjectId) &&
      isUntouched(session);
    if (reusable && (!found || session.updatedAt > found.updatedAt)) found = session;
  }
  return found;
}

/** New: open the empty conversation already there, or create one when there is none or the list is not settled. */
export function startConversation(rail: SessionRail, workspaceId?: string): void {
  const settled = !rail.loading && !rail.creatingSession && !rail.loadingMoreSessions;
  const reusable = settled
    ? findReusableEmptyConversation(rail.missionSessions, rail.selectedProjectId, workspaceId)
    : undefined;
  if (reusable) rail.onSelectSession(reusable.sessionId);
  else void rail.onCreateSession();
}
