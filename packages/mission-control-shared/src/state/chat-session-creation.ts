import { useSyncExternalStore } from "react";
import type { ChatMode, ChatSessionRecord } from "@goatcitadel/contracts";

/** Presentation admission only. Gateway create/status records remain authoritative. */
export interface ChatSessionCreation {
  state: "checking" | "pending" | "unknown" | "confirmed" | "error";
  message: string;
  mode: ChatMode;
  sessionId?: string;
}

const attempts = new Map<string, ChatSessionCreation>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  listeners.forEach((listener) => listener());
}

export function chatSessionCreationKey(installation: string, workspaceId: string) {
  return JSON.stringify([installation, "chat-session-create", workspaceId]);
}

export function chatSessionCreationBlocked(attempt: ChatSessionCreation | undefined) {
  return Boolean(attempt && ["checking", "pending", "unknown"].includes(attempt.state));
}

export function readChatSessionCreation(key: string) {
  return attempts.get(key);
}

export function beginChatSessionCreation(key: string, attempt: ChatSessionCreation) {
  if (chatSessionCreationBlocked(attempts.get(key))) return false;
  attempts.set(key, attempt);
  changed();
  return true;
}

export function publishChatSessionCreation(key: string, attempt: ChatSessionCreation) {
  if (attempts.get(key) === attempt) changed();
}

export function abandonChatSessionCreation(key: string, attempt: ChatSessionCreation) {
  // Only an undispatched preflight can release admission without an owner receipt.
  if (attempts.get(key) !== attempt || attempt.state !== "checking") return;
  attempts.delete(key);
  changed();
}

export function useChatSessionCreation(key: string) {
  useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => version,
    () => version,
  );
  return attempts.get(key);
}

export function assertChatSessionCreated(session: ChatSessionRecord, workspaceId: string, projectId?: string) {
  if (
    !session.sessionId?.trim() || session.workspaceId !== workspaceId || session.projectId !== projectId ||
    session.scope !== "mission" || session.mode !== "chat" || session.lifecycleStatus !== "active" ||
    session.includeInHistory !== true || !Number.isSafeInteger(session.revision) || session.revision < 1
  ) throw new Error("The Gateway did not acknowledge the requested new Chat conversation.");
}

export function resetChatSessionCreationForTests() {
  attempts.clear();
  changed();
}
