import { useSyncExternalStore } from "react";
import type { ChatSessionWorkbenchFileResponse } from "@goatcitadel/contracts";
export type WorkbenchSessionDraft = {
  sessionId: string;
  base: ChatSessionWorkbenchFileResponse;
  content: string;
};
// App-lifetime editor input only. File contents never enter browser storage.
const drafts = new Map<string, WorkbenchSessionDraft>();
const subscribers = new Set<() => void>();
let version = 0;
let unloadTarget: Window | undefined;
export const workbenchDraftKey = (sessionId: string, path: string) =>
  JSON.stringify([sessionId, path]);
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (drafts.size) {
    event.preventDefault();
    event.returnValue = "";
  }
};
function changed() {
  version += 1;
  if (drafts.size && !unloadTarget && typeof window !== "undefined") {
    unloadTarget = window;
    unloadTarget.addEventListener("beforeunload", beforeUnload);
  }
  if (!drafts.size && unloadTarget) {
    unloadTarget.removeEventListener("beforeunload", beforeUnload);
    unloadTarget = undefined;
  }
  for (const subscriber of subscribers) subscriber();
}
export function useWorkbenchDraftVersion() {
  return useSyncExternalStore(
    (listener) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    () => version,
    () => version,
  );
}
export function getWorkbenchDraft(sessionId: string, path: string) {
  return drafts.get(workbenchDraftKey(sessionId, path));
}
export function listWorkbenchDrafts(sessionId: string | null) {
  return [...drafts.values()].filter((entry) => entry.sessionId === sessionId);
}
export function updateWorkbenchDraft(
  sessionId: string,
  file: ChatSessionWorkbenchFileResponse,
  content: string,
) {
  const key = workbenchDraftKey(sessionId, file.path),
    base = drafts.get(key)?.base ?? file;
  if (content === base.content) drafts.delete(key);
  else drafts.set(key, { sessionId, base, content });
  changed();
}
export function discardWorkbenchSessionDraft(sessionId: string, path: string) {
  drafts.delete(workbenchDraftKey(sessionId, path));
  changed();
}
export function acknowledgeWorkbenchDraft(
  sessionId: string,
  file: ChatSessionWorkbenchFileResponse,
  submitted: string,
) {
  const key = workbenchDraftKey(sessionId, file.path),
    current = drafts.get(key);
  if (
    current &&
    current.content !== submitted &&
    current.content !== file.content
  )
    drafts.set(key, { ...current, base: file });
  else drafts.delete(key);
  changed();
  return !drafts.has(key);
}
export function rebaseWorkbenchDraft(
  sessionId: string,
  file: ChatSessionWorkbenchFileResponse,
) {
  const key = workbenchDraftKey(sessionId, file.path),
    current = drafts.get(key);
  if (!current) return;
  if (current.content === file.content) drafts.delete(key);
  else drafts.set(key, { ...current, base: file });
  changed();
}
export function __resetWorkbenchSessionDraftsForTests() {
  drafts.clear();
  changed();
}
