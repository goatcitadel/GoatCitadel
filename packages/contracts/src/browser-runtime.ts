export type BrowserSessionStatus = "active" | "closed";
export type BrowserSessionGrantScope = "read" | "interact" | "state" | "admin";
export type BrowserSessionEventType =
  | "session_created"
  | "session_closed"
  | "grant_created"
  | "grant_revoked"
  | "grant_rotated"
  | "tool_access_granted"
  | "tool_guard_blocked";

export interface BrowserSessionRecord {
  sessionId: string;
  workspaceId?: string;
  label: string;
  status: BrowserSessionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface BrowserSessionGrantRecord {
  grantId: string;
  sessionId: string;
  actorId: string;
  scopes: BrowserSessionGrantScope[];
  allowedHosts: string[];
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface BrowserSessionEventRecord {
  eventId: string;
  sessionId: string;
  eventType: BrowserSessionEventType;
  actorId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface BrowserSessionCreateInput {
  workspaceId?: string;
  label?: string;
  actorId?: string;
}

export interface BrowserSessionGrantInput {
  actorId: string;
  scopes: BrowserSessionGrantScope[];
  allowedHosts?: string[];
  ttlSeconds?: number;
}

export interface BrowserSessionAccessCheck {
  sessionId: string;
  actorId: string;
  requiredScope: BrowserSessionGrantScope;
  host?: string;
  toolName?: string;
  runId?: string;
}

export interface UntrustedContentEnvelope {
  envelopeId: string;
  source: "browser.search" | "browser.navigate" | "browser.extract" | "browser.screenshot" | "unknown";
  canary: string;
  contentPreview: string;
  createdAt: string;
}

export interface BrowserContentGuardResult {
  ok: boolean;
  blocked: boolean;
  leakedCanaries: string[];
  reason?: string;
}
