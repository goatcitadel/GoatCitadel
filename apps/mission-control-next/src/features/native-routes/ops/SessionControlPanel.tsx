import { useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SessionControlRequestRecord } from "@goatcitadel/contracts";
import {
  handoffSessionControl,
  revokeSessionControl,
} from "@goatcitadel/mission-control-shared/api/session-control-operator";
import { useSessionControlStatus } from "@goatcitadel/mission-control-shared/hooks/useSessionControlStatus";
import { deriveSessionControlBannerViewModel } from "@goatcitadel/threaded-surface-core";
import { NativeCard } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner, StatusChip } from "../primitives";
import "./session-control.css";

/**
 * HX-411 Ops session-control panel.
 *
 * Semantic cards (never raw JSON, never the control secret) for one Chat session:
 *  - pending external control requests, each with an operator "Hand off" action
 *    carrying the expected generation and the effective send / send+read caps;
 *  - the current external controller, with "Revoke" and "Emergency takeover".
 *
 * All calls use the operator's normal Mission Control auth via the operator client.
 * Truthful owner/generation/lease/reconnect state comes straight from the shipped
 * `GET .../control` projection.
 */
export function SessionControlPanel({ sessionId }: { sessionId: string | undefined }) {
  const normalizedSessionId = sessionId?.trim() ? sessionId.trim() : null;
  const status = useSessionControlStatus(normalizedSessionId);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [grantRead, setGrantRead] = useState<Record<string, boolean>>({});

  const reload = status.reload;
  const runAction = useCallback(
    async (key: string, operation: () => Promise<unknown>) => {
      setPendingAction(key);
      setActionError(null);
      try {
        await operation();
        await reload();
      } catch {
        setActionError("The control action was rejected. The session state may have changed — reload and retry.");
      } finally {
        setPendingAction(null);
      }
    },
    [reload],
  );

  const model = useMemo(() => deriveSessionControlBannerViewModel(status.data), [status.data]);
  const detail = status.data;
  const pendingRequests = detail && detail.control.ownerKind === "operator" ? detail.pendingRequests : ([] as const);

  const handleToggleRead = useCallback((requestId: string, next: boolean) => {
    setGrantRead((current) => ({ ...current, [requestId]: next }));
  }, []);

  const handleHandoff = useCallback(
    (request: SessionControlRequestRecord) => {
      const wantsRead = request.requestedCapabilities.length > 1 && grantRead[request.requestId] === true;
      void runAction(`handoff:${request.requestId}`, () =>
        handoffSessionControl(request.sessionId, {
          requestId: request.requestId,
          expectedGeneration: request.requestedGeneration,
          effectiveCapabilities: wantsRead ? ["send", "read"] : ["send"],
        }),
      );
    },
    [grantRead, runAction],
  );

  const handleRejectRequest = useCallback(
    (request: SessionControlRequestRecord) => {
      void runAction(`reject:${request.requestId}`, () =>
        revokeSessionControl(request.sessionId, { target: "request", requestId: request.requestId }),
      );
    },
    [runAction],
  );

  const handleRevoke = useCallback(
    (mode: "revoke" | "emergency_takeover") => {
      if (!normalizedSessionId) {
        return;
      }
      void runAction(mode, () =>
        revokeSessionControl(normalizedSessionId, {
          target: "current_controller",
          expectedGeneration: model.generation,
          mode,
        }),
      );
    },
    [model.generation, normalizedSessionId, runAction],
  );

  return (
    <NativeCard
      title="Session control"
      subtitle="Governed external attach state for the selected Chat session: pending requests, current controller, and operator handoff, revoke, and emergency takeover."
      density="compact"
      className="mc-next-session-control-panel"
      stats={[
        { label: "Owner", value: model.externalControlActive ? "External" : "Operator" },
        { label: "Generation", value: model.generation ? String(model.generation) : "—" },
        { label: "Pending", value: String(pendingRequests.length) },
      ]}
      actions={
        <NativeButton
          variant="outline"
          onClick={() => void reload()}
          disabled={!normalizedSessionId || status.loading}
          aria-label="Reload session control status"
        >
          <RefreshCw size={15} aria-hidden="true" />
          {status.loading ? "Reloading" : "Reload"}
        </NativeButton>
      }
    >
      {!normalizedSessionId ? (
        <EmptyState
          size="compact"
          title="No Chat session selected"
          description="Open a Chat session in this Ops view to inspect and manage its external control state."
        />
      ) : (
        <SessionControlBody
          loading={status.loading}
          hasData={Boolean(detail)}
          statusError={status.error}
          actionError={actionError}
          model={model}
          pendingRequests={pendingRequests}
          pendingAction={pendingAction}
          grantRead={grantRead}
          onToggleRead={handleToggleRead}
          onHandoff={handleHandoff}
          onRejectRequest={handleRejectRequest}
          onRevoke={handleRevoke}
        />
      )}
    </NativeCard>
  );
}

function SessionControlBody({
  loading,
  hasData,
  statusError,
  actionError,
  model,
  pendingRequests,
  pendingAction,
  grantRead,
  onToggleRead,
  onHandoff,
  onRejectRequest,
  onRevoke,
}: {
  loading: boolean;
  hasData: boolean;
  statusError: string | null;
  actionError: string | null;
  model: ReturnType<typeof deriveSessionControlBannerViewModel>;
  pendingRequests: readonly SessionControlRequestRecord[];
  pendingAction: string | null;
  grantRead: Record<string, boolean>;
  onToggleRead: (requestId: string, next: boolean) => void;
  onHandoff: (request: SessionControlRequestRecord) => void;
  onRejectRequest: (request: SessionControlRequestRecord) => void;
  onRevoke: (mode: "revoke" | "emergency_takeover") => void;
}) {
  if (loading && !hasData) {
    return (
      <div aria-busy="true" aria-live="polite">
        <EmptyState size="compact" title="Loading canonical session control state…" />
      </div>
    );
  }
  if (statusError && !hasData) {
    return <NoticeBanner tone="error" message={`Session control status unavailable: ${statusError}`} />;
  }

  return (
    <div className="mc-next-session-control-stack">
      {statusError ? <NoticeBanner tone="warning" message={`${statusError} Showing the last canonical read.`} /> : null}
      {actionError ? <NoticeBanner tone="error" message={actionError} /> : null}

      {model.externalControlActive ? (
        <ExternalControllerCard model={model} pendingAction={pendingAction} onRevoke={onRevoke} />
      ) : (
        <section className="mc-next-session-control-owner" aria-label="Operator ownership">
          <StatusChip tone="success">Operator owned</StatusChip>
          <StatusChip tone="muted">{model.generationLabel}</StatusChip>
          <p>The operator holds the current mutation generation. Ordinary Chat send is enabled.</p>
        </section>
      )}

      <div className="mc-next-session-control-requests">
        <h4>Pending control requests ({pendingRequests.length})</h4>
        {pendingRequests.length === 0 ? (
          <EmptyState
            size="compact"
            title="No pending requests"
            description="An external session_control_client has not requested control of this session."
          />
        ) : (
          <ul role="list">
            {pendingRequests.map((request) => (
              <PendingRequestCard
                key={request.requestId}
                request={request}
                pendingAction={pendingAction}
                grantRead={grantRead[request.requestId] === true}
                onToggleRead={onToggleRead}
                onHandoff={onHandoff}
                onRejectRequest={onRejectRequest}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ExternalControllerCard({
  model,
  pendingAction,
  onRevoke,
}: {
  model: ReturnType<typeof deriveSessionControlBannerViewModel>;
  pendingAction: string | null;
  onRevoke: (mode: "revoke" | "emergency_takeover") => void;
}) {
  const busy = pendingAction === "revoke" || pendingAction === "emergency_takeover";
  return (
    <section
      className="mc-next-session-control-external"
      data-tone={model.tone}
      aria-label="Current external controller"
    >
      <div className="mc-next-session-control-external-head">
        <div className="mc-next-session-control-chip-row">
          <StatusChip tone="warning">{model.ownerLabel}</StatusChip>
          <StatusChip tone={model.tone === "external-stale" ? "critical" : "live"}>
            {model.leaseStateLabel ?? "External"}
          </StatusChip>
          <StatusChip tone="muted">{model.generationLabel}</StatusChip>
          {model.capabilitiesLabel ? <StatusChip tone="default">{model.capabilitiesLabel}</StatusChip> : null}
        </div>
        <div className="mc-next-session-control-external-actions">
          <NativeButton
            variant="outline"
            onClick={() => onRevoke("revoke")}
            disabled={busy}
            aria-label="Revoke external control"
          >
            {pendingAction === "revoke" ? "Revoking…" : "Revoke"}
          </NativeButton>
          <NativeButton
            variant="destructive"
            onClick={() => onRevoke("emergency_takeover")}
            disabled={busy}
            aria-label="Emergency takeover"
          >
            {pendingAction === "emergency_takeover" ? "Taking over…" : "Emergency takeover"}
          </NativeButton>
        </div>
      </div>
      <dl className="mc-next-session-control-meta">
        <MetaRow label="Client" value={model.clientInstanceId} />
        <MetaRow label="Companion" value={model.companionSessionId} />
        <MetaRow label="Token fingerprint" value={model.tokenFingerprint ? `…${model.tokenFingerprint}` : null} />
        <MetaTime label="Last heartbeat" value={model.lastHeartbeatAt} />
        <MetaTime label="Lease expires" value={model.leaseExpiresAt} />
        <MetaTime label="Reconnect window" value={model.reconnectExpiresAt} />
      </dl>
    </section>
  );
}

function PendingRequestCard({
  request,
  pendingAction,
  grantRead,
  onToggleRead,
  onHandoff,
  onRejectRequest,
}: {
  request: SessionControlRequestRecord;
  pendingAction: string | null;
  grantRead: boolean;
  onToggleRead: (requestId: string, next: boolean) => void;
  onHandoff: (request: SessionControlRequestRecord) => void;
  onRejectRequest: (request: SessionControlRequestRecord) => void;
}) {
  const readRequested = request.requestedCapabilities.length > 1;
  const handoffBusy = pendingAction === `handoff:${request.requestId}`;
  const rejectBusy = pendingAction === `reject:${request.requestId}`;
  const busy = handoffBusy || rejectBusy;
  return (
    <li className="mc-next-session-control-request" role="listitem">
      <div className="mc-next-session-control-chip-row">
        <StatusChip tone="warning">Pending request</StatusChip>
        <StatusChip tone="muted">{`Expects generation ${request.requestedGeneration}`}</StatusChip>
        <StatusChip tone="default">{readRequested ? "Requested: Send + Read" : "Requested: Send"}</StatusChip>
      </div>
      <dl className="mc-next-session-control-meta">
        <MetaRow label="Client" value={request.clientInstanceId} />
        <MetaRow label="Companion" value={request.companionSessionId} />
        <MetaRow label="Token fingerprint" value={`…${request.tokenFingerprint}`} />
        <MetaTime label="Requested" value={request.createdAt} />
        <MetaTime label="Expires" value={request.expiresAt} />
      </dl>
      {readRequested ? (
        <label className="mc-next-session-control-read-toggle">
          <input
            type="checkbox"
            checked={grantRead}
            disabled={busy}
            onChange={(event) => onToggleRead(request.requestId, event.target.checked)}
          />
          Also grant read (transcript + event stream)
        </label>
      ) : (
        <p className="mc-next-session-control-hint">This client requested send only; read cannot be granted.</p>
      )}
      <div className="mc-next-session-control-request-actions">
        <NativeButton
          variant="default"
          onClick={() => onHandoff(request)}
          disabled={busy}
          aria-label={`Hand off control to ${request.clientInstanceId}`}
        >
          {handoffBusy ? "Handing off…" : "Hand off"}
        </NativeButton>
        <NativeButton
          variant="ghost"
          onClick={() => onRejectRequest(request)}
          disabled={busy}
          aria-label={`Reject request from ${request.clientInstanceId}`}
        >
          {rejectBusy ? "Rejecting…" : "Reject"}
        </NativeButton>
      </div>
    </li>
  );
}

function MetaRow({ label, value }: { label: string; value: string | null }) {
  if (!value) {
    return null;
  }
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MetaTime({ label, value }: { label: string; value: string | null }) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  const display = Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <time dateTime={value}>{display}</time>
      </dd>
    </div>
  );
}
