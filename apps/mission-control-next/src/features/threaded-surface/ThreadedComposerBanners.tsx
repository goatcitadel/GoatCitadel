import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { StatusChip } from "../native-routes/primitives";
import { describeThreadedUiError } from "./threaded-error-copy";
import { ChatCapabilityProfilePreflight } from "./ChatCapabilityProfilePanel";
import { ComposerDelegationApproval, ComposerCoworkStop } from "./ThreadedComposerDelegation";

interface ComposerBannersProps {
  props: MissionThreadedActiveSessionSurfaceProps;
  composerActionDisabled: boolean | undefined;
  delegatedScopeActionDisabled: boolean | undefined;
  scopeCandidateId: string;
  onScopeCandidateChange: (value: string) => void;
}

export function ThreadedComposerBanners({
  props,
  composerActionDisabled,
  delegatedScopeActionDisabled,
  scopeCandidateId,
  onScopeCandidateChange,
}: ComposerBannersProps) {
  const mappedError = describeThreadedUiError(props.streamError, props.streamErrorSource ?? "other");
  const capabilityProfile = props.routePreflight?.capabilityProfile;
  return (
    <>
      {props.editingTurnId ? (
        <div className="mc-next-composer-banner">
          Branching from turn {props.editingTurnId.slice(-6)}.
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onCancelEdit}>
            Cancel branch
          </button>
        </div>
      ) : null}

      {props.planningMode === "advisory" ? (
        <div className="mc-next-composer-banner planning">
          Planning mode is on. GoatCitadel will respond with a plan/spec instead of executing tool work automatically.
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onTogglePlanningMode}>
            Turn planning off
          </button>
        </div>
      ) : null}

      {props.streamError ? (
        <div className="mc-next-composer-banner error" role="alert">
          <div>
            <strong>{mappedError?.summary ?? props.streamError}</strong>
            {mappedError?.raw ? <p>{mappedError.raw}</p> : null}
          </div>
          <div className="mc-next-composer-action-row">
            {props.onSendRetainedPromptAsChat ? (
              <button
                type="button"
                className="mc-next-composer-inline-button primary"
                disabled={props.sending || !props.canSend}
                onClick={props.onSendRetainedPromptAsChat}
              >
                Send as chat
              </button>
            ) : null}
            <button type="button" className="mc-next-composer-inline-button" onClick={props.onDismissError}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {props.presetApplyWarning ? (
        <div className="mc-next-composer-banner warning">
          <StatusChip tone="warning">Preset</StatusChip>
          <p>{props.presetApplyWarning}</p>
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onDismissPresetWarning}>
            Dismiss
          </button>
        </div>
      ) : null}

      {props.routePreflightLoading && !props.routePreflight ? (
        <div className="mc-next-composer-banner info mc-next-technical-detail">
          <StatusChip tone="muted">Route</StatusChip>
          <p>Checking the selected provider/model route before send.</p>
        </div>
      ) : null}

      {capabilityProfile ? (
        <ChatCapabilityProfilePreflight
          profile={capabilityProfile}
          workspaceId={props.workspaceId}
          onBaselineUpdated={props.onWorkPassportBaselineChanged}
        />
      ) : null}

      {props.routeBoundaryAckRequired && !props.routeBoundaryAcknowledged ? (
        <div className="mc-next-composer-banner warning">
          <StatusChip tone="warning">Confirm</StatusChip>
          <p>If the primary route fails, this run may continue on another runtime boundary.</p>
          <button type="button" className="mc-next-composer-inline-button" onClick={props.onAcknowledgeRouteBoundary}>
            Acknowledge fallback
          </button>
        </div>
      ) : null}

      {props.workspaceSnapshotRequest ? (
        <div className="mc-next-composer-banner info" aria-label="Workspace snapshot unavailable">
          <StatusChip tone="warning">Unavailable</StatusChip>
          <p>
            <strong>Workspace snapshot is temporarily unavailable.</strong> Remove this saved request before sending.
          </p>
          <div className="mc-next-composer-action-row">
            <button
              type="button"
              className="mc-next-composer-inline-button"
              disabled={composerActionDisabled}
              onClick={props.onToggleWorkspaceSnapshot}
            >
              Remove snapshot
            </button>
          </div>
        </div>
      ) : null}

      {props.delegatedScopeControls ? (
        <section className="mc-next-composer-banner info" aria-label="Request additional delegated scope">
          <StatusChip tone={props.delegatedScopeControls.pendingApprovalId ? "warning" : "muted"}>
            Governed scope
          </StatusChip>
          <div>
            <strong>Request additional scope for {props.delegatedScopeControls.stepLabel}.</strong>
            <p>
              Choose an eligible server-owned workspace path. Approval expands only this delegated run&apos;s frozen
              scope; Chat cannot grant arbitrary host-folder access.
            </p>
            {props.delegatedScopeControls.pendingApprovalId ? (
              <p role="status">Waiting for the canonical scope-expansion approval decision.</p>
            ) : props.delegatedScopeControls.loading ? (
              <p role="status">Loading eligible workspace paths…</p>
            ) : props.delegatedScopeControls.candidates.length > 0 ? (
              <div className="mc-next-composer-action-row">
                <label>
                  Eligible workspace path
                  <select
                    aria-label="Eligible workspace path"
                    value={scopeCandidateId}
                    disabled={props.delegatedScopeControls.requesting || delegatedScopeActionDisabled}
                    onChange={(event) => onScopeCandidateChange(event.target.value)}
                  >
                    {props.delegatedScopeControls.candidates.map((candidate) => (
                      <option key={candidate.candidateId} value={candidate.candidateId}>
                        {candidate.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="mc-next-composer-inline-button primary"
                  disabled={
                    !scopeCandidateId || props.delegatedScopeControls.requesting || delegatedScopeActionDisabled
                  }
                  onClick={() => props.delegatedScopeControls?.onRequest(scopeCandidateId)}
                >
                  {props.delegatedScopeControls.requesting ? "Requesting…" : "Request additional scope"}
                </button>
              </div>
            ) : (
              <p role="status">No additional eligible workspace paths are available.</p>
            )}
            {props.delegatedScopeControls.error ? <p role="alert">{props.delegatedScopeControls.error}</p> : null}
            {!props.delegatedScopeControls.pendingApprovalId ? (
              <button
                type="button"
                className="mc-next-composer-inline-button"
                disabled={props.delegatedScopeControls.loading || props.delegatedScopeControls.requesting}
                onClick={props.delegatedScopeControls.onReload}
              >
                Refresh eligible paths
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <ComposerDelegationApproval props={props} />

      <ComposerCoworkStop props={props} />

      {props.liveVoiceActive || props.liveVoiceState === "error" ? (
        <section
          className="mc-next-composer-live-voice"
          data-state={props.liveVoiceState ?? "idle"}
          role="status"
          aria-live="polite"
        >
          <StatusChip tone={props.liveVoiceState === "error" ? "critical" : "success"}>OpenAI Realtime</StatusChip>
          <p>{props.liveVoiceStatusLabel ?? "OpenAI Realtime voice"}</p>
          <div className="mc-next-composer-action-row">
            {props.liveVoiceActive ? (
              <button
                type="button"
                className="mc-next-composer-inline-button"
                disabled={props.historicalReadOnly}
                onClick={props.onToggleLiveVoiceMute}
              >
                {props.liveVoiceMuted ? "Unmute mic" : "Mute mic"}
              </button>
            ) : null}
            <button
              type="button"
              className="mc-next-composer-inline-button primary"
              disabled={props.historicalReadOnly || (!props.liveVoiceActive && !props.liveVoiceAvailable)}
              title={!props.liveVoiceActive ? (props.liveVoiceUnavailableReason ?? undefined) : undefined}
              onClick={props.onToggleLiveVoice}
            >
              {props.liveVoiceActive ? "Stop live voice" : "Start live voice"}
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
