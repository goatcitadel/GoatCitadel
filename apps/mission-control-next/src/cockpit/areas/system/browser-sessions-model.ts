import type {
  BrowserSessionEventRecord,
  BrowserSessionEventSummary,
  BrowserSessionGrantRecord,
  BrowserSessionGrantScope,
  BrowserSessionRecord,
  BrowserSessionStateProjection,
} from "@goatcitadel/contracts";

export const GRANT_SCOPES: readonly { scope: BrowserSessionGrantScope; label: string; meaning: string }[] = [
  { scope: "read", label: "Read", meaning: "Read pages in this session." },
  { scope: "interact", label: "Interact", meaning: "Navigate, click and type, plus read." },
  { scope: "state", label: "State", meaning: "Change cookies and storage, plus interact and read." },
  { scope: "admin", label: "Admin", meaning: "Configure the browser context, plus every lower scope." },
];

/**
 * A grant the operator explicitly marks as never expiring: the request omits `ttlSeconds`, which the Gateway stores
 * as no expiry. It is never the default and is offered last, after the timed presets.
 */
export const NEVER_EXPIRES_TTL = 0;

/** Timed presets stay within the Gateway cap (seven days); one hour is the default policy. */
export const GRANT_TTL_PRESETS: readonly { seconds: number; label: string }[] = [
  { seconds: 15 * 60, label: "15 minutes" },
  { seconds: 60 * 60, label: "1 hour" },
  { seconds: 8 * 60 * 60, label: "8 hours" },
  { seconds: 24 * 60 * 60, label: "1 day" },
  { seconds: 7 * 24 * 60 * 60, label: "7 days (longest timed grant)" },
  { seconds: NEVER_EXPIRES_TTL, label: "Never expires (until revoked)" },
];
export const DEFAULT_GRANT_TTL_SECONDS = 60 * 60;

export type GrantDraft = { actorId: string; scopes: BrowserSessionGrantScope[]; hosts: string; ttlSeconds: number };
export type GrantRequest = {
  actorId: string;
  scopes: BrowserSessionGrantScope[];
  allowedHosts: string[];
  /** Null asks the Gateway for a grant that never expires. */
  ttlSeconds: number | null;
};
export type GrantDraftErrors = Partial<Record<"actorId" | "scopes" | "ttlSeconds", string>>;

export const EMPTY_GRANT_DRAFT: GrantDraft = {
  actorId: "",
  scopes: ["read"],
  hosts: "",
  ttlSeconds: DEFAULT_GRANT_TTL_SECONDS,
};

/** Mirrors the Gateway's host normalization so the review shows what will be stored. */
export function normalizeHost(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return value;
  }
}

export function parseHosts(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,;\n]/u)
        .map(normalizeHost)
        .filter(Boolean),
    ),
  ];
}

export function validateGrantDraft(
  draft: GrantDraft,
): { ok: true; request: GrantRequest } | { ok: false; errors: GrantDraftErrors } {
  const errors: GrantDraftErrors = {};
  const actorId = draft.actorId.trim();
  if (!actorId) errors.actorId = "Enter the actor this grant is for.";
  if (!draft.scopes.length) errors.scopes = "Choose at least one scope.";
  if (!GRANT_TTL_PRESETS.some((preset) => preset.seconds === draft.ttlSeconds))
    errors.ttlSeconds = "Choose a supported expiry.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    request: {
      actorId,
      scopes: [...draft.scopes],
      allowedHosts: parseHosts(draft.hosts),
      ttlSeconds: draft.ttlSeconds === NEVER_EXPIRES_TTL ? null : draft.ttlSeconds,
    },
  };
}

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item) => right.includes(item));

// Both timestamps come from the Gateway; the tolerance only absorbs rounding, never a different preset.
const EXPIRY_TOLERANCE_MS = 2 * 60 * 1000;

/** A grant receipt confirms the review only when session, actor, scopes, hosts and the expiry duration match. */
export function grantMatchesRequest(
  grant: BrowserSessionGrantRecord,
  request: GrantRequest,
  sessionId: string,
): boolean {
  const duration = grant.expiresAt ? Date.parse(grant.expiresAt) - Date.parse(grant.createdAt) : Number.NaN;
  // A never-expiring request matches only a receipt with no expiry; a timed one only the same duration.
  const expiryMatches =
    request.ttlSeconds === null
      ? !grant.expiresAt
      : Math.abs(duration - request.ttlSeconds * 1000) <= EXPIRY_TOLERANCE_MS;
  return (
    grant.sessionId === sessionId &&
    grant.actorId === request.actorId &&
    sameSet(grant.scopes, request.scopes) &&
    sameSet(grant.allowedHosts, request.allowedHosts) &&
    expiryMatches
  );
}

export function sameGrantScope(left: BrowserSessionGrantRecord, right: BrowserSessionGrantRecord): boolean {
  return (
    left.actorId === right.actorId &&
    sameSet(left.scopes, right.scopes) &&
    sameSet(left.allowedHosts, right.allowedHosts) &&
    left.expiresAt === right.expiresAt
  );
}

export function isGrantActive(grant: BrowserSessionGrantRecord, now = Date.now()): boolean {
  if (grant.revokedAt) return false;
  return !grant.expiresAt || Date.parse(grant.expiresAt) > now;
}

/** A replayed receipt can name a grant that has since been revoked or has expired. */
export function describeReceiptState(
  grant: BrowserSessionGrantRecord,
  now = Date.now(),
): "active" | "revoked" | "expired" {
  if (grant.revokedAt) return "revoked";
  return isGrantActive(grant, now) ? "active" : "expired";
}

const SCOPE_RANK: Record<BrowserSessionGrantScope, number> = { read: 1, interact: 2, state: 3, admin: 4 };

/** Tool posture from records and retained evidence. A record never shows that a browser is open or bound. */
export function buildSessionPosture(
  status: BrowserSessionRecord["status"],
  grants: BrowserSessionGrantRecord[],
  summary: BrowserSessionEventSummary,
  now = Date.now(),
) {
  const active = grants.filter((grant) => isGrantActive(grant, now));
  const scopes = active.flatMap((grant) => grant.scopes).sort((a, b) => SCOPE_RANK[b] - SCOPE_RANK[a]);
  const hosts = new Set(active.flatMap((grant) => grant.allowedHosts));
  return {
    callable:
      status === "closed"
        ? "Closed: no tool can use this session"
        : active.length
          ? "Grants allow governed tool use"
          : "No active grant: tools cannot use this session",
    activeGrantCount: active.length,
    highestScope: scopes[0] ?? "None",
    hostPosture: !active.length
      ? "No active hosts"
      : active.some((grant) => grant.allowedHosts.length === 0)
        ? "At least one grant allows every host"
        : [...hosts].join(", "),
    guardBlockCount: summary.guardBlockCount,
    grantedAccessCount: summary.grantedAccessCount,
    lastAccessAt: summary.lastAccessAt,
  };
}

export function describeContext(context: BrowserSessionStateProjection["state"]["context"]): string {
  return (
    [
      context.locale ? `Locale ${context.locale}` : undefined,
      context.timezoneId ? `timezone ${context.timezoneId}` : undefined,
      context.geolocationConfigured ? "geolocation configured" : undefined,
      context.extraHTTPHeadersCount > 0 ? `${context.extraHTTPHeadersCount} headers configured` : undefined,
      context.httpCredentialsConfigured ? "credentials configured" : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || "No browser context overrides"
  );
}

/** Lists are read with this cap; reaching it means more records may exist. */
export const LIST_LIMIT = 200;

const SENSITIVE_PAYLOAD_KEY = /cookie|storage|localstorage|sessionstorage|domvalue|pagevalue|screenshot|html|content/i;

/** Event payloads show only non-state fields; browser state values are counted, never shown. */
export function describeEventPayload(event: BrowserSessionEventRecord): string {
  const visible = Object.entries(event.payload)
    .filter(([key, value]) => !SENSITIVE_PAYLOAD_KEY.test(key) && value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  const hidden = Object.keys(event.payload).filter((key) => SENSITIVE_PAYLOAD_KEY.test(key)).length;
  const parts = [...visible, ...(hidden ? [`${hidden} browser state value${hidden === 1 ? "" : "s"} hidden`] : [])];
  return parts.length ? parts.join(" · ") : "No payload detail recorded.";
}

export function formatTime(iso?: string): string | undefined {
  const date = iso ? new Date(iso) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : undefined;
}
