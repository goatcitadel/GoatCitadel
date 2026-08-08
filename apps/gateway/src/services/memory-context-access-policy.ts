import { createHash } from "node:crypto";
import { MEMORY_CONTEXT_ACCESS_POLICY_VERSION, type MemoryContextAccessReceipt } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

export async function resolveMemoryContextAccessReceipt(
  storage: Storage,
  sessionIdInput?: string,
): Promise<MemoryContextAccessReceipt> {
  const sessionId = sessionIdInput?.trim();
  let sessionKind: MemoryContextAccessReceipt["sessionKind"];
  let failClosed = true;
  if (sessionId) {
    try {
      const session = await storage.sessions.getBySessionId(sessionId);
      if (
        session.sessionId === sessionId &&
        (session.kind === "dm" || session.kind === "group" || session.kind === "thread")
      ) {
        sessionKind = session.kind;
        failClosed = false;
      }
    } catch {
      // Missing or inconsistent canonical session truth intentionally fails closed.
    }
  }
  const mode = sessionKind === "dm" && !failClosed ? "workspace_private" : "session_only";
  const fingerprint = createHash("sha256")
    .update(
      [
        MEMORY_CONTEXT_ACCESS_POLICY_VERSION,
        mode,
        sessionId ?? "",
        sessionKind ?? "unknown",
        failClosed ? "fail_closed" : "canonical",
      ].join("|"),
    )
    .digest("hex");
  return {
    policyVersion: MEMORY_CONTEXT_ACCESS_POLICY_VERSION,
    mode,
    sessionKind,
    failClosed,
    fingerprint,
  };
}

export async function resolveTrustedMemoryUsageWorkspaceId(
  storage: Storage,
  sessionId?: string,
): Promise<string | undefined> {
  if (!sessionId) {
    return undefined;
  }
  try {
    return (await storage.chatSessionMeta.get(sessionId))?.workspaceId;
  } catch {
    return undefined;
  }
}
