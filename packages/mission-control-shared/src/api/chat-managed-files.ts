import type {
  ChatApprovalModeState,
  ChatApprovalModeUpdate,
  ManagedProjectFileReceipt,
  ManagedProjectFilePublishRequest,
  ManagedProjectFilePublishResult,
  ManagedProjectFileRestoreRequest,
  ManagedProjectFileRevision,
} from "@goatcitadel/contracts";
import { getGatewayAccessRevision, getGatewayCallerScopeRevision } from "./access-scope.js";
import { buildGatewayUrl, getGatewayApiBaseUrl, readGatewayAuthHeaders, request } from "./client-core.js";

function sessionPath(sessionId: string): string {
  return `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`;
}

export function chatApprovalModeQueryKey(workspaceId: string, sessionId: string, projectId: string) {
  return [
    "chat-approval-mode",
    JSON.stringify([
      getGatewayApiBaseUrl(),
      getGatewayAccessRevision(),
      getGatewayCallerScopeRevision(),
      workspaceId,
      sessionId,
      projectId,
    ]),
  ] as const;
}

export function fetchChatApprovalMode(sessionId: string, signal?: AbortSignal): Promise<ChatApprovalModeState> {
  return request(`${sessionPath(sessionId)}/approval-mode`, { signal, cache: "no-store" });
}

export function updateChatApprovalMode(
  sessionId: string,
  input: ChatApprovalModeUpdate,
  signal?: AbortSignal,
): Promise<ChatApprovalModeState> {
  return request(`${sessionPath(sessionId)}/approval-mode`, {
    method: "PATCH",
    body: JSON.stringify(input),
    signal,
  });
}

export function fetchChatManagedFiles(
  sessionId: string,
  options: { prefix?: string; signal?: AbortSignal } = {},
): Promise<{ items: ManagedProjectFileRevision[]; publishAvailable?: boolean }> {
  const suffix = options.prefix ? `?${new URLSearchParams({ prefix: options.prefix })}` : "";
  return request(`${sessionPath(sessionId)}/managed-files${suffix}`, { signal: options.signal, cache: "no-store" });
}

export function publishChatManagedFile(
  sessionId: string,
  input: ManagedProjectFilePublishRequest,
  signal?: AbortSignal,
): Promise<ManagedProjectFilePublishResult> {
  return request(`${sessionPath(sessionId)}/managed-files/publish`, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}

export function restoreChatManagedFile(
  sessionId: string,
  input: ManagedProjectFileRestoreRequest,
  signal?: AbortSignal,
): Promise<ManagedProjectFileReceipt> {
  return request(`${sessionPath(sessionId)}/managed-files/restore`, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}

const maxBytes = 1024 * 1024;

export async function downloadChatManagedFile(
  sessionId: string,
  file: ManagedProjectFileRevision,
  signal: AbortSignal,
): Promise<Blob> {
  const { path, revisionId, byteLength, contentSha256, deleted } = file;
  const unavailable = () => new Error("The managed file download could not be verified.");
  if (deleted || !contentSha256 || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxBytes) {
    throw unavailable();
  }
  const query = new URLSearchParams({ path, revisionId });
  const route = `${sessionPath(sessionId)}/managed-files/download?${query}`;
  const baseUrl = getGatewayApiBaseUrl();
  const access = getGatewayAccessRevision();
  const caller = getGatewayCallerScopeRevision();
  const response = await fetch(buildGatewayUrl(route, baseUrl), {
    headers: readGatewayAuthHeaders(route),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: "no-store",
  });
  if (!response.ok || response.headers.get("content-type") !== "application/octet-stream" || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw unavailable();
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > byteLength) throw unavailable();
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    if (offset !== byteLength) throw unavailable();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const digestHex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    signal.throwIfAborted();
    if (
      digestHex !== contentSha256 ||
      getGatewayApiBaseUrl() !== baseUrl ||
      getGatewayAccessRevision() !== access ||
      getGatewayCallerScopeRevision() !== caller
    )
      throw unavailable();
    return new Blob([bytes], { type: "application/octet-stream" });
  } finally {
    bytes.fill(0);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
