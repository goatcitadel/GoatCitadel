import type { MissionThreadedSessionControlBannerProps } from "@goatcitadel/threaded-surface-core";
import { NativeButton, StatusChip } from "../native-routes/primitives";

/**
 * HX-411 Chat controller banner.
 *
 * Rendered above the timeline/composer whenever an external `session_control_client`
 * owns the current Chat session. It shows truthful, content-free controller
 * identity, generation, lease/liveness, and reconnect state, states the exact
 * reason operator send is disabled (the composer is failed closed in parallel),
 * and keeps the operator's revoke + emergency-takeover actions available. Reads
 * and approvals stay available elsewhere in the surface. It never renders the
 * control secret — only public identifiers, a last-eight token fingerprint,
 * generations, and timestamps.
 */
export function SessionControlBanner({
  model,
  onRevoke,
  onEmergencyTakeover,
  actionPending,
  actionError,
  statusError,
}: MissionThreadedSessionControlBannerProps) {
  if (!model.externalControlActive) {
    return null;
  }
  const busy = actionPending !== null;

  return (
    <section
      className="mc-next-session-control-banner"
      data-tone={model.tone}
      role="status"
      aria-live="polite"
      aria-label="External session control active"
    >
      <div className="mc-next-session-control-banner-head">
        <div className="mc-next-session-control-banner-title">
          <StatusChip tone="warning">{model.ownerLabel}</StatusChip>
          <StatusChip tone={model.tone === "external-stale" ? "critical" : "live"}>
            {model.leaseStateLabel ?? "External"}
          </StatusChip>
          <StatusChip tone="muted">{model.generationLabel}</StatusChip>
          {model.capabilitiesLabel ? <StatusChip tone="default">{model.capabilitiesLabel}</StatusChip> : null}
        </div>
        <div className="mc-next-session-control-banner-actions">
          <NativeButton
            variant="outline"
            onClick={onRevoke}
            disabled={busy}
            aria-label="Revoke external session control"
          >
            {actionPending === "revoke" ? "Revoking…" : "Revoke"}
          </NativeButton>
          <NativeButton
            variant="destructive"
            onClick={onEmergencyTakeover}
            disabled={busy}
            aria-label="Emergency takeover of this session"
          >
            {actionPending === "emergency_takeover" ? "Taking over…" : "Emergency takeover"}
          </NativeButton>
        </div>
      </div>

      {model.sendLockReason ? <p className="mc-next-session-control-banner-reason">{model.sendLockReason}</p> : null}

      <dl className="mc-next-session-control-banner-meta">
        {model.clientInstanceId ? (
          <div>
            <dt>Client</dt>
            <dd>{model.clientInstanceId}</dd>
          </div>
        ) : null}
        {model.companionSessionId ? (
          <div>
            <dt>Companion</dt>
            <dd>{model.companionSessionId}</dd>
          </div>
        ) : null}
        {model.tokenFingerprint ? (
          <div>
            <dt>Token fingerprint</dt>
            <dd>…{model.tokenFingerprint}</dd>
          </div>
        ) : null}
        {model.lastHeartbeatAt ? (
          <div>
            <dt>Last heartbeat</dt>
            <dd>
              <time dateTime={model.lastHeartbeatAt}>{formatTimestamp(model.lastHeartbeatAt)}</time>
            </dd>
          </div>
        ) : null}
        {model.leaseExpiresAt ? (
          <div>
            <dt>Lease expires</dt>
            <dd>
              <time dateTime={model.leaseExpiresAt}>{formatTimestamp(model.leaseExpiresAt)}</time>
            </dd>
          </div>
        ) : null}
        {model.reconnectExpiresAt ? (
          <div>
            <dt>Reconnect window</dt>
            <dd>
              <time dateTime={model.reconnectExpiresAt}>{formatTimestamp(model.reconnectExpiresAt)}</time>
            </dd>
          </div>
        ) : null}
      </dl>

      <p className="mc-next-session-control-banner-note">
        Reads and approvals stay available. Only mutation controls are disabled while an external client owns this
        session.
      </p>

      {statusError ? (
        <p className="mc-next-session-control-banner-caveat" role="note">
          {statusError} Showing the last canonical control read.
        </p>
      ) : null}
      {actionError ? (
        <p className="mc-next-session-control-banner-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </section>
  );
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}
