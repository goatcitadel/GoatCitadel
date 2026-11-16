import type { ChatSessionRecord } from "@goatcitadel/contracts";
import {
  createAttachmentStorageKey,
  createDraftStorageKey,
  type MissionThreadedActiveSessionSurfaceProps,
  type MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";

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

/** Whether a stored attachment list holds anything; text that does not parse is kept as work, not discarded. */
function storedAttachmentsPresent(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return !Array.isArray(parsed) || parsed.length > 0;
  } catch {
    return true;
  }
}

/**
 * Unsent work under this conversation's local key (caller, workspace, conversation). Storage that cannot be read
 * counts as holding work: the conversation is then not reused and a new one is created.
 */
function holdsStoredWork(workspaceId: string, sessionId: string): boolean {
  try {
    const draft = window.localStorage.getItem(createDraftStorageKey(workspaceId, sessionId));
    if (draft?.trim()) return true;
    return storedAttachmentsPresent(window.localStorage.getItem(createAttachmentStorageKey(workspaceId, sessionId)));
  } catch {
    return true;
  }
}

/**
 * The most recently updated conversation that holds nothing yet: an active, untouched Chat conversation of this
 * workspace in the project the list is showing. When there is any doubt it is not reusable: reuse only saves a row.
 * One that holds unsent work is never reusable: the selected one while its text or attachments are in memory
 * (`unsentSessionId`), any other while a draft or attachments are stored for it.
 */
export function findReusableEmptyConversation(
  sessions: readonly ChatSessionRecord[],
  selectedProjectId: string,
  workspaceId?: string,
  unsentSessionId?: string | null,
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
      isUntouched(session) &&
      session.sessionId !== unsentSessionId &&
      !holdsStoredWork(workspaceId, session.sessionId);
    if (reusable && (!found || session.updatedAt > found.updatedAt)) found = session;
  }
  return found;
}

/** The open conversation while it holds typed text or attachments in memory: New must not reselect it. */
export function unsentConversationId(
  active: Pick<MissionThreadedActiveSessionSurfaceProps, "draft" | "pendingAttachments" | "selectedSessionId"> | null,
): string | null {
  // Optional reads: a partly built surface (a test double, a surface still hydrating) holds nothing yet.
  const typed = Boolean(active?.draft?.trim()) || (active?.pendingAttachments?.length ?? 0) > 0;
  return active && typed ? active.selectedSessionId : null;
}

/** New: open the empty conversation already there, or create one when there is none or the list is not settled. */
export function startConversation(rail: SessionRail, workspaceId?: string, unsentSessionId?: string | null): void {
  const settled = !rail.loading && !rail.creatingSession && !rail.loadingMoreSessions;
  const reusable = settled
    ? findReusableEmptyConversation(rail.missionSessions, rail.selectedProjectId, workspaceId, unsentSessionId)
    : undefined;
  if (reusable) rail.onSelectSession(reusable.sessionId);
  else void rail.onCreateSession();
}
