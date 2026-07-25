/**
 * HX-411 operator Chat controller-banner projection (content-free).
 *
 * Derives a semantic, secret-free view model from the shipped operator
 * `GET /api/v1/chat/sessions/:sessionId/control` detail response. This is the
 * single source of truth for the Chat surface banner AND for whether an ordinary
 * operator send must fail closed while an external `session_control_client` owns
 * the session generation. It mirrors server truth — it never optimistically
 * re-enables send because SSE dropped or a heartbeat is late — and it never reads
 * or surfaces the control secret. Only content-free identifiers, generations,
 * lease/reconnect timestamps, capability labels, and reason codes are projected.
 */
import type { SessionControlDetailResponse } from "@goatcitadel/contracts";

export type SessionControlBannerTone = "operator" | "external-live" | "external-stale";

export interface SessionControlBannerViewModel {
  /** True when an external companion currently owns the session's mutation authority. */
  readonly externalControlActive: boolean;
  /**
   * True when the operator's Chat send must fail closed. Mirrors the server:
   * external ownership (live OR stale) blocks ordinary operator mutation until an
   * explicit revoke / emergency takeover creates a new operator generation.
   */
  readonly sendLocked: boolean;
  readonly tone: SessionControlBannerTone;
  /** Human owner label, e.g. "External controller" or "Operator". */
  readonly ownerLabel: string;
  /** Canonical current generation for CAS on operator revoke / emergency takeover. */
  readonly generation: number;
  /** e.g. "Generation 4". */
  readonly generationLabel: string;
  /** Lease/liveness label, e.g. "Live lease" / "Stale — reconnect window open". Null when operator-owned. */
  readonly leaseStateLabel: string | null;
  /** Effective external capability label, e.g. "Send" / "Send + Read". Null when operator-owned. */
  readonly capabilitiesLabel: string | null;
  /** Content-free client-instance identity of the bound controller. Null when operator-owned. */
  readonly clientInstanceId: string | null;
  /** Content-free companion-session identity of the bound controller. Null when operator-owned. */
  readonly companionSessionId: string | null;
  /** Public last-eight token fingerprint (never the secret or full hash). Null when operator-owned. */
  readonly tokenFingerprint: string | null;
  /** ISO last-heartbeat truth. Null when operator-owned. */
  readonly lastHeartbeatAt: string | null;
  /** ISO token/live-lease expiry truth. Null when operator-owned. */
  readonly leaseExpiresAt: string | null;
  /** ISO reconnect-window expiry truth. Null when operator-owned. */
  readonly reconnectExpiresAt: string | null;
  /** Exact reason operator send is disabled, or null when send is allowed. */
  readonly sendLockReason: string | null;
  /** Pending external control requests visible to the operator (operator-owned only). */
  readonly pendingRequestCount: number;
}

/** In-flight operator control action, surfaced so the banner can disable its buttons. */
export type SessionControlBannerActionPending = "revoke" | "emergency_takeover";

/**
 * Data + operator-action handlers the host hands to the Chat surface so it can
 * render the controller banner. Kept content-free: the model never carries a
 * secret and the surface only invokes operator-auth actions.
 */
export interface MissionThreadedSessionControlBannerProps {
  readonly model: SessionControlBannerViewModel;
  readonly onRevoke: () => void;
  readonly onEmergencyTakeover: () => void;
  readonly actionPending: SessionControlBannerActionPending | null;
  readonly actionError: string | null;
  /** Non-fatal status-read caveat (the banner still trusts the last canonical read). */
  readonly statusError: string | null;
}

const OPERATOR_VIEW_MODEL: SessionControlBannerViewModel = Object.freeze({
  externalControlActive: false,
  sendLocked: false,
  tone: "operator",
  ownerLabel: "Operator",
  generation: 0,
  generationLabel: "Generation unknown",
  leaseStateLabel: null,
  capabilitiesLabel: null,
  clientInstanceId: null,
  companionSessionId: null,
  tokenFingerprint: null,
  lastHeartbeatAt: null,
  leaseExpiresAt: null,
  reconnectExpiresAt: null,
  sendLockReason: null,
  pendingRequestCount: 0,
});

/**
 * Project the operator control-detail response into the banner view model.
 *
 * Absence (no detail yet / read failed) is treated as operator-owned and does NOT
 * lock send: a missing projection must never silently strand the operator, and the
 * server itself remains the authority that fails a real external-owned send closed.
 */
export function deriveSessionControlBannerViewModel(
  detail: SessionControlDetailResponse | null | undefined,
): SessionControlBannerViewModel {
  if (!detail) {
    return OPERATOR_VIEW_MODEL;
  }
  const control = detail.control;
  if (control.ownerKind === "operator") {
    return Object.freeze({
      ...OPERATOR_VIEW_MODEL,
      generation: control.generation,
      generationLabel: `Generation ${control.generation}`,
      pendingRequestCount: detail.pendingRequests.length,
    });
  }

  const isStale = control.leaseState === "external_stale";
  // Capabilities are exactly ["send"] or ["send","read"]; length distinguishes them.
  const capabilitiesLabel = control.capabilities.length > 1 ? "Send + Read" : "Send";
  const leaseStateLabel = isStale ? "Stale — reconnect window open" : "Live lease";
  const sendLockReason = isStale
    ? `An external controller (generation ${control.generation}) still owns this session but its lease is stale. Operator send stays disabled until you revoke or take over — an ordinary disconnect never returns ownership on its own.`
    : `An external controller (generation ${control.generation}) owns this session. Operator send is disabled until you revoke or take over.`;

  return Object.freeze({
    externalControlActive: true,
    sendLocked: true,
    tone: isStale ? "external-stale" : "external-live",
    ownerLabel: "External controller",
    generation: control.generation,
    generationLabel: `Generation ${control.generation}`,
    leaseStateLabel,
    capabilitiesLabel,
    clientInstanceId: control.boundExternalController.clientInstanceId,
    companionSessionId: control.boundExternalController.companionSessionId,
    tokenFingerprint: control.boundExternalController.tokenFingerprint,
    lastHeartbeatAt: control.lastHeartbeatAt,
    leaseExpiresAt: control.leaseExpiresAt,
    reconnectExpiresAt: control.reconnectExpiresAt,
    sendLockReason,
    pendingRequestCount: 0,
  });
}
