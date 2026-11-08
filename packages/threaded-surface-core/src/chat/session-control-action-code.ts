import type { ChatSessionRecord } from "@goatcitadel/contracts";
import {
  ApiRequestError,
  archiveChatSession,
  assignChatSessionProject,
  deleteChatSession,
  importChatProject,
  pinChatSession,
  restoreChatSession,
  unpinChatSession,
  updateChatSession,
} from "@goatcitadel/mission-control-shared/api/client";
import type { ChatSessionControlsInput } from "./useChatSessionControls";
import { formatSessionLabel } from "./useMissionControlSurfaceState";

export type SessionActionContext = Pick<
  ChatSessionControlsInput,
  | "workspaceId"
  | "historyView"
  | "loadSidebar"
  | "refreshSessionAggregate"
  | "setSessionMetadataConflictDraft"
  | "setError"
  | "setQueuedOutbound"
  | "setThread"
  | "setSelectedSessionId"
  | "setHistoryView"
  | "nextSessionAfterRemoval"
  | "onSessionRemoved"
> & { current: () => boolean };

function isSessionRevisionConflict(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 409;
}

async function refreshConflict(
  context: SessionActionContext,
  sessionId: string,
  message: string,
  preserveSelection = false,
) {
  const refresh = preserveSelection
    ? context.refreshSessionAggregate?.(sessionId, { preserveSelection })
    : context.refreshSessionAggregate?.(sessionId);
  await (refresh ??
    context.loadSidebar(context.historyView, {
      bypassCache: true,
      ...(preserveSelection ? { preserveSelection } : { preferredSessionId: sessionId }),
    }));
  if (context.current()) context.setError(message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function renameSession(context: SessionActionContext, session: ChatSessionRecord, renameTitle: string) {
  try {
    await updateChatSession(session.sessionId, {
      expectedRevision: session.revision,
      title: renameTitle.trim() || undefined,
    });
    if (!context.current()) return;
    context.setSessionMetadataConflictDraft?.(null);
    await context.loadSidebar(context.historyView, { bypassCache: true, preferredSessionId: session.sessionId });
  } catch (error) {
    if (!context.current()) return;
    if (isSessionRevisionConflict(error)) {
      context.setSessionMetadataConflictDraft?.({ sessionId: session.sessionId, kind: "rename", renameTitle });
      await refreshConflict(
        context,
        session.sessionId,
        "This chat changed elsewhere. Your rename draft is preserved; review it and retry.",
      );
    } else context.setError(errorMessage(error));
  }
}

export async function saveSessionOrganization(
  context: SessionActionContext,
  session: ChatSessionRecord,
  folderName: string,
  tagsValue: string,
): Promise<boolean> {
  let saved = false;
  try {
    await updateChatSession(session.sessionId, {
      expectedRevision: session.revision,
      folderName: folderName.trim() || "",
      tags: tagsValue
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    });
    saved = true;
    if (!context.current()) return true;
    context.setSessionMetadataConflictDraft?.(null);
    await context.loadSidebar(context.historyView, { bypassCache: true, preserveSelection: true });
  } catch (error) {
    if (!context.current()) return saved;
    if (saved) {
      context.setError("Folder and tags were saved, but the conversation list could not refresh.");
    } else if (isSessionRevisionConflict(error)) {
      context.setSessionMetadataConflictDraft?.({
        sessionId: session.sessionId,
        kind: "organization",
        folderName,
        tagsValue,
      });
      const message = "This chat changed elsewhere. Your organization draft is preserved; review it and retry.";
      try {
        await refreshConflict(context, session.sessionId, message, true);
      } catch {
        // Preserve the write conflict result if reading the current version also fails.
        if (context.current()) context.setError(message);
      }
    } else context.setError(errorMessage(error));
  }
  return saved;
}

export async function toggleSessionPin(context: SessionActionContext, session: ChatSessionRecord) {
  try {
    const toggle = session.pinned ? unpinChatSession : pinChatSession;
    await toggle(session.sessionId, session.revision);
    if (context.current())
      await context.loadSidebar(context.historyView, { bypassCache: true, preferredSessionId: session.sessionId });
  } catch (error) {
    if (!context.current()) return;
    if (isSessionRevisionConflict(error)) {
      await refreshConflict(
        context,
        session.sessionId,
        "This chat changed elsewhere. Review the latest state, then click pin again.",
      );
    } else context.setError(errorMessage(error));
  }
}

function removeFromCurrentView(
  context: SessionActionContext,
  sessionId: string,
  label: string,
  kind: "archived" | "deleted",
) {
  const nextSessionId = context.nextSessionAfterRemoval?.(sessionId) ?? null;
  context.setQueuedOutbound((current) => current.filter((item) => item.sessionId !== sessionId));
  context.setThread(null);
  context.setSelectedSessionId((current) => (current === sessionId ? nextSessionId : current));
  context.onSessionRemoved?.({ sessionId, nextSessionId, label, kind });
  return nextSessionId;
}

export async function toggleSessionArchive(context: SessionActionContext, session: ChatSessionRecord) {
  try {
    const restoring = session.lifecycleStatus === "archived";
    const toggle = restoring ? restoreChatSession : archiveChatSession;
    await toggle(session.sessionId, session.revision);
    if (!context.current()) return;
    const nextSessionId =
      !restoring && context.historyView === "active"
        ? removeFromCurrentView(context, session.sessionId, formatSessionLabel(session), "archived")
        : null;
    if (restoring && context.historyView === "archived") {
      context.setHistoryView("active");
      context.setSelectedSessionId(session.sessionId);
      await context.loadSidebar("active", { bypassCache: true, preferredSessionId: session.sessionId });
    } else {
      await context.loadSidebar(context.historyView, {
        bypassCache: true,
        preferredSessionId: nextSessionId ?? undefined,
      });
    }
  } catch (error) {
    if (!context.current()) return;
    if (isSessionRevisionConflict(error)) {
      await refreshConflict(
        context,
        session.sessionId,
        "This chat changed elsewhere. Review the latest state, then click archive or restore again.",
      );
    } else context.setError(errorMessage(error));
  }
}

export async function deleteSession(
  context: SessionActionContext,
  reviewed: Pick<ChatSessionRecord, "sessionId" | "revision"> & { label: string },
) {
  try {
    await deleteChatSession(reviewed.sessionId, reviewed.revision);
    if (!context.current()) return;
    const nextSessionId = removeFromCurrentView(context, reviewed.sessionId, reviewed.label, "deleted");
    await context.loadSidebar(undefined, { preferredSessionId: nextSessionId ?? undefined });
  } catch (error) {
    if (!context.current()) return;
    if (isSessionRevisionConflict(error)) {
      await refreshConflict(
        context,
        reviewed.sessionId,
        "This chat changed elsewhere. Review the latest state, then request deletion again.",
      );
    } else context.setError(errorMessage(error));
  }
}

export async function assignSessionProject(context: SessionActionContext, session: ChatSessionRecord, value: string) {
  try {
    await assignChatSessionProject(session.sessionId, value === "none" ? undefined : value, session.revision);
    if (context.current())
      await context.loadSidebar(context.historyView, { bypassCache: true, preserveSelection: true });
  } catch (error) {
    if (!context.current()) return;
    if (isSessionRevisionConflict(error)) {
      await refreshConflict(
        context,
        session.sessionId,
        "This chat changed elsewhere. Review the latest state, then choose the project again.",
        true,
      );
    } else context.setError(errorMessage(error));
  }
}

export type CodeProjectSourceInput = Pick<
  Parameters<typeof importChatProject>[0],
  "sourceType" | "name" | "sourcePath" | "repoUrl" | "ref"
>;

export async function importSessionCodeProject(
  context: SessionActionContext,
  session: ChatSessionRecord,
  input: CodeProjectSourceInput,
) {
  try {
    const result = await importChatProject({ workspaceId: context.workspaceId, ...input });
    if (!context.current())
      throw new DOMException("The conversation changed before the imported project could be assigned.", "AbortError");
    await assignChatSessionProject(session.sessionId, result.project.projectId, session.revision);
    if (context.current()) await context.loadSidebar();
    return result.project;
  } catch (error) {
    if (!context.current()) throw error;
    if (isSessionRevisionConflict(error)) {
      await refreshConflict(
        context,
        session.sessionId,
        "This chat changed elsewhere. The imported project is available; review the latest state and assign it again.",
      );
    } else context.setError(errorMessage(error));
    throw error;
  }
}
