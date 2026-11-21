import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { Dispatch, SetStateAction } from "react";
import { parseChatTimerDraft, type ChatTimerDraft } from "../chat-timer-form";

export interface FirstChatReminder {
  scope: string;
  draft: ChatTimerDraft;
  sessionId?: string;
}

export async function reviewChatTimer({
  draft,
  sessionId,
  scope,
  isScopeCurrent,
  firstReminder,
  ensureSession,
  setDraft,
  setUiError,
  openChatTimerPanel,
  send,
}: {
  draft: string;
  sessionId?: string | null;
  scope: string;
  isScopeCurrent: () => boolean;
  firstReminder: { current: FirstChatReminder | null };
  ensureSession: (onResolved?: (session: ChatSessionRecord) => void) => Promise<ChatSessionRecord>;
  setDraft: Dispatch<SetStateAction<string>>;
  setUiError: (message: string) => void;
  openChatTimerPanel: (draft: ChatTimerDraft) => void;
  send: () => Promise<void>;
}): Promise<void> {
  const parsed = parseChatTimerDraft(draft);
  if (!parsed) return send();
  if (sessionId) {
    setDraft("");
    openChatTimerPanel(parsed);
    return;
  }
  if (firstReminder.current?.scope === scope) return;
  const reminder: FirstChatReminder = { scope, draft: parsed };
  firstReminder.current = reminder;

  try {
    await ensureSession((created) => {
      if (firstReminder.current !== reminder || !isScopeCurrent()) return;
      reminder.sessionId = created.sessionId;
      setDraft((current) => (current === draft ? "" : current));
    });
    if (firstReminder.current === reminder && !reminder.sessionId) firstReminder.current = null;
  } catch (error) {
    if (firstReminder.current !== reminder) return;
    firstReminder.current = null;
    if (!isScopeCurrent() || (error instanceof DOMException && error.name === "AbortError")) return;
    setUiError(error instanceof Error ? error.message : "Could not open a Chat for this timer.");
  }
}
