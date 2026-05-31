import type {
  BrowserSessionCreateInput,
  BrowserSessionEventRecord,
  BrowserSessionGrantInput,
  BrowserSessionGrantRecord,
  BrowserSessionRecord,
  BrowserSessionStateProjection,
  BrowserSessionStatus,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export interface BrowserSessionListQuery {
  workspaceId?: string;
  status?: BrowserSessionStatus | "all";
  limit?: number;
}

export interface BrowserSessionGrantListQuery {
  status?: "active" | "revoked" | "all";
  limit?: number;
}

export function fetchBrowserSessions(query: BrowserSessionListQuery = {}): Promise<BrowserSessionRecord[]> {
  const params = new URLSearchParams();
  if (query.workspaceId?.trim()) {
    params.set("workspaceId", query.workspaceId.trim());
  }
  if (query.status) {
    params.set("status", query.status);
  }
  if (typeof query.limit === "number" && Number.isFinite(query.limit)) {
    params.set("limit", String(Math.max(1, Math.min(500, Math.trunc(query.limit)))));
  }
  const suffix = params.toString();
  return request<BrowserSessionRecord[]>(`/api/v1/browser-sessions${suffix ? `?${suffix}` : ""}`);
}

export function createBrowserSession(input: BrowserSessionCreateInput): Promise<BrowserSessionRecord> {
  return request<BrowserSessionRecord>("/api/v1/browser-sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchBrowserSession(sessionId: string): Promise<BrowserSessionRecord> {
  return request<BrowserSessionRecord>(`/api/v1/browser-sessions/${encodeURIComponent(sessionId)}`);
}

export function fetchBrowserSessionState(sessionId: string): Promise<BrowserSessionStateProjection> {
  return request<BrowserSessionStateProjection>(`/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/state`);
}

export function closeBrowserSession(sessionId: string): Promise<BrowserSessionRecord> {
  return request<BrowserSessionRecord>(`/api/v1/browser-sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export function createBrowserSessionGrant(
  sessionId: string,
  input: BrowserSessionGrantInput,
): Promise<BrowserSessionGrantRecord> {
  return request<BrowserSessionGrantRecord>(`/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/grants`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchBrowserSessionGrants(
  sessionId: string,
  query: BrowserSessionGrantListQuery = {},
): Promise<BrowserSessionGrantRecord[]> {
  const params = new URLSearchParams();
  if (query.status) {
    params.set("status", query.status);
  }
  if (typeof query.limit === "number" && Number.isFinite(query.limit)) {
    params.set("limit", String(Math.max(1, Math.min(500, Math.trunc(query.limit)))));
  }
  const suffix = params.toString();
  return request<BrowserSessionGrantRecord[]>(
    `/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/grants${suffix ? `?${suffix}` : ""}`,
  );
}

export function revokeBrowserSessionGrant(sessionId: string, grantId: string): Promise<BrowserSessionGrantRecord> {
  return request<BrowserSessionGrantRecord>(
    `/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE" },
  );
}

export function rotateBrowserSessionGrant(sessionId: string, grantId: string): Promise<BrowserSessionGrantRecord> {
  return request<BrowserSessionGrantRecord>(
    `/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/grants/${encodeURIComponent(grantId)}/rotate`,
    { method: "POST" },
  );
}

export function fetchBrowserSessionEvents(sessionId: string, limit = 100): Promise<BrowserSessionEventRecord[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  return request<BrowserSessionEventRecord[]>(
    `/api/v1/browser-sessions/${encodeURIComponent(sessionId)}/events?limit=${safeLimit}`,
  );
}
