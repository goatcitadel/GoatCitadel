/** Transport only: each entry retains its existing Gateway route and response contract. */
export const STARTUP_READ_BATCH_PATH = "/api/v1/startup-reads";
export const STARTUP_READ_BATCH_LIMIT = 16;
export const STARTUP_READ_BATCH_QUERY_LIMIT = 7000;
export const STARTUP_READ_BATCH_BODY_LIMIT = 4 * 1024 * 1024;
export interface StartupReadRequest { path: string; correlationId: string; originSurface?: string }
export interface StartupReadResponse { status: number; bodyText: string; headers: Record<string, string>; directReadRequired?: boolean }
export interface StartupReadBatchResponse { items: StartupReadResponse[] }
const STATIC_READ_PATH = /^\/api\/v1\/(?:workspaces|settings|agents|llm\/(?:config|models)|onboarding\/state|observe\/health|chat\/(?:projects|sessions|tools\/approvals)|inbox|durable\/runs|agentic\/runs|change-plans|capabilities\/autonomy-grants)$/u;
const RECORD_READ_PATH = /^\/api\/v1\/(?:citadels\/[^/]+\/structure|approvals\/[^/]+|agentic\/runs\/[^/]+\/tree|chat\/sessions\/[^/]+\/(?:core-state|control|goal|external-source-attachments|delegations\/latest-explorer))$/u;
const READ_QUERY_KEYS = new Set(["surface", "boardId", "parentRunId", "includeActivity", "includeExpired", "sessionIds", "folderId", "tag", "workspaceId", "citadelId", "sessionId", "projectId", "providerId", "limit", "cursor", "status", "mode", "view", "q", "search", "searchQuery", "historyView", "includeThread", "includeArchived", "includeHidden", "includeDisabled", "cacheOnly", "forceRefresh", "includeUnknown", "sessionIncarnation", "incarnationId", "runId", "turnId", "since", "until", "scope"]);
export function isStartupReadPath(path: string): boolean {
  if (!path.startsWith("/api/v1/") || path.length > 1024 || /[\\#\r\n]/u.test(path)) return false;
  const url = new URL(path, "http://startup-read.invalid");
  if (!STATIC_READ_PATH.test(url.pathname) && !RECORD_READ_PATH.test(url.pathname)) return false;
  return [...url.searchParams.keys()].every(key => READ_QUERY_KEYS.has(key));
}
export function isStartupReadRequest(input: unknown): input is StartupReadRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const item = input as Record<string, unknown>;
  return Object.keys(item).every(key => ["path", "correlationId", "originSurface"].includes(key)) &&
    typeof item.path === "string" && isStartupReadPath(item.path) &&
    typeof item.correlationId === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(item.correlationId) &&
    (item.originSurface === undefined || typeof item.originSurface === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(item.originSurface));
}
