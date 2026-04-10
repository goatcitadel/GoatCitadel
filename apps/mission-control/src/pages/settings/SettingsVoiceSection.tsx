import type {
  VoiceOperatorGuidance,
  VoiceRecoveryAction,
  VoiceRuntimeStatus,
  VoiceStatus,
  VoiceTalkSessionRecord,
} from "@goatcitadel/contracts";
import { FieldHelp } from "../../components/FieldHelp";
import { HelpHint } from "../../components/HelpHint";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";
import { GCSelect } from "../../components/ui";
import {
  describeVoiceRuntimeReadiness,
  describeVoiceState,
  formatTalkModeLabel,
  formatVoiceDate,
  formatVoiceLanguageScope,
} from "../settings-page-utils";

export type VoiceTalkMode = "push_to_talk" | "wake";

export interface SettingsVoiceSectionProps {
  voiceStatus: VoiceStatus | null;
  voiceRuntime: VoiceRuntimeStatus | null;
  voiceTalkSessions: VoiceTalkSessionRecord[];
  voiceActionInfo: string | null;
  voiceOperatorGuidance: VoiceOperatorGuidance;
  voiceRecoveryActions: VoiceRecoveryAction[];
  voiceBusy: boolean;
  installedVoiceModelIds: Set<string>;
  voiceTalkMode: VoiceTalkMode;
  onVoiceTalkModeChange: (mode: VoiceTalkMode) => void;
  voiceFile: File | null;
  onVoiceFileChange: (file: File | null) => void;
  voiceTranscriptResult: string | null;
  onInstallManagedVoiceRuntime: (modelId: string, repair: boolean) => Promise<void> | void;
  onSelectManagedVoiceModel: (modelId: string) => Promise<void> | void;
  onRemoveManagedVoiceModel: (modelId: string) => Promise<void> | void;
  onStartVoiceTalk: () => void;
  onStopVoiceTalk: () => void;
  onStartWake: () => void;
  onStopWake: () => void;
  onRunVoiceTranscribeTest: () => void;
  refreshVoiceRuntime: () => Promise<void> | void;
}

export function SettingsVoiceSection(props: SettingsVoiceSectionProps) {
  const {
    voiceStatus,
    voiceRuntime,
    voiceTalkSessions,
    voiceActionInfo,
    voiceOperatorGuidance,
    voiceRecoveryActions,
    voiceBusy,
    installedVoiceModelIds,
    voiceTalkMode,
    onVoiceTalkModeChange,
    voiceFile,
    onVoiceFileChange,
    voiceTranscriptResult,
    onInstallManagedVoiceRuntime,
    onSelectManagedVoiceModel,
    onRemoveManagedVoiceModel,
    onStartVoiceTalk,
    onStopVoiceTalk,
    onStartWake,
    onStopWake,
    onRunVoiceTranscribeTest,
    refreshVoiceRuntime,
  } = props;

  return (
    <section id="settings-voice" className="settings-v2-section">
      <Panel
        className="settings-v2-panel"
        title="Voice Runtime"
        subtitle={
          <>
            Local-first voice controls with no required cloud API key.{" "}
            <HelpHint
              label="Voice runtime help"
              text="Talk Mode and Wake use your local voice runtime. Whisper.cpp is the default offline transcription provider."
            />
          </>
        }
      >
        <FieldHelp>
          Voice tools are local-first and best treated like a hardware/runtime surface: inspect state first, then run
          talk, wake, or transcription tests intentionally.
        </FieldHelp>
        <div className="voice-status-grid">
          <article className="voice-status-card">
            <h4>Speech To Text</h4>
            <p>
              <strong>Provider:</strong> {voiceStatus?.stt.provider ?? "unknown"}
            </p>
            <p>
              <strong>State:</strong> {voiceStatus?.stt.state ?? "unknown"}
            </p>
            <p>
              <strong>Managed runtime:</strong> {voiceStatus?.stt.runtimeReady ? "ready" : "not ready"}
            </p>
            <p>
              <strong>Active model:</strong> {voiceStatus?.stt.modelId ?? "none"}
            </p>
            <p className="table-subtext">{describeVoiceState(voiceStatus?.stt.state)}</p>
            <p className="table-subtext">Updated: {formatVoiceDate(voiceStatus?.stt.updatedAt)}</p>
          </article>
          <article className="voice-status-card">
            <h4>Talk Mode</h4>
            <p>
              <strong>State:</strong> {voiceStatus?.talk.state ?? "unknown"}
            </p>
            <p>
              <strong>Mode:</strong> {formatTalkModeLabel(voiceStatus?.talk.mode)}
            </p>
            <p>
              <strong>Active session:</strong> {voiceStatus?.talk.activeSessionId ?? "none"}
            </p>
            <p className="table-subtext">{describeVoiceState(voiceStatus?.talk.state)}</p>
            <p className="table-subtext">Updated: {formatVoiceDate(voiceStatus?.talk.updatedAt)}</p>
          </article>
          <article className="voice-status-card">
            <h4>Wake Listener</h4>
            <p>
              <strong>Enabled:</strong> {voiceStatus?.wake.enabled ? "yes" : "no"}
            </p>
            <p>
              <strong>State:</strong> {voiceStatus?.wake.state ?? "unknown"}
            </p>
            <p>
              <strong>Model:</strong> {voiceStatus?.wake.model ?? "unknown"}
            </p>
            <p className="table-subtext">{describeVoiceState(voiceStatus?.wake.state)}</p>
            <p className="table-subtext">Updated: {formatVoiceDate(voiceStatus?.wake.updatedAt)}</p>
          </article>
          <article className="voice-status-card">
            <h4>Managed Runtime</h4>
            <p>
              <strong>Readiness:</strong> {describeVoiceRuntimeReadiness(voiceRuntime?.readiness)}
            </p>
            <p>
              <strong>Source:</strong> {voiceRuntime?.source ?? "unknown"}
            </p>
            <p>
              <strong>Binary:</strong> {voiceRuntime?.binaryReady ? "ready" : "missing"}
            </p>
            <p>
              <strong>Audio helper:</strong> {voiceRuntime?.ffmpegReady ? "ready" : "missing"}
            </p>
            <p className="table-subtext">
              {voiceRuntime?.selectedModelId
                ? `Selected model: ${voiceRuntime.selectedModelId}`
                : "No managed model selected yet."}
            </p>
            {voiceRuntime?.binaryPath ? <p className="table-subtext">Binary path: {voiceRuntime.binaryPath}</p> : null}
          </article>
          <article className="voice-status-card">
            <h4>Recent Talk Sessions</h4>
            {voiceTalkSessions.length === 0 ? (
              <p className="table-subtext">No talk sessions recorded yet.</p>
            ) : (
              <ul className="compact-list">
                {voiceTalkSessions.slice(0, 5).map((session) => (
                  <li key={session.talkSessionId}>
                    <strong>{formatTalkModeLabel(session.mode)}</strong> · {session.state}
                    <div className="table-subtext">
                      started {formatVoiceDate(session.startedAt ?? session.createdAt)}
                      {session.stoppedAt ? ` · stopped ${formatVoiceDate(session.stoppedAt)}` : ""}
                    </div>
                    <div className="table-subtext">
                      session {session.talkSessionId}
                      {session.sessionId ? ` · chat ${session.sessionId}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
        {voiceStatus?.stt.lastError ? <p className="error">Last STT error: {voiceStatus.stt.lastError}</p> : null}
        {voiceRuntime?.lastError ? <p className="error">Last runtime error: {voiceRuntime.lastError}</p> : null}
        {voiceActionInfo ? <p className="status-banner">{voiceActionInfo}</p> : null}
        <article className="voice-help-card">
          <h4>Operator posture</h4>
          <FieldHelp>{voiceOperatorGuidance.postureSummary}</FieldHelp>
          {voiceOperatorGuidance.recommendedActions.length > 0 ? (
            <ul className="voice-help-list">
              {voiceOperatorGuidance.recommendedActions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          ) : null}
        </article>
        <article className="voice-help-card">
          <h4>Recovery Next Steps</h4>
          {voiceRecoveryActions.length > 0 ? (
            <div className="workflow-status-stack">
              {voiceRecoveryActions.map((action) => (
                <div key={action.id}>
                  <p className="office-subtitle">
                    <strong>{action.title}</strong> <StatusChip tone={action.tone}>{action.tone}</StatusChip>
                  </p>
                  <FieldHelp>{action.description}</FieldHelp>
                  <div className="controls-row">
                    {action.id === "repair-runtime" ? (
                      <button
                        type="button"
                        onClick={() =>
                          void onInstallManagedVoiceRuntime(voiceRuntime?.selectedModelId ?? "base.en", true)
                        }
                        disabled={voiceBusy}
                       className="gc-button">
                        Repair Voice Runtime
                      </button>
                    ) : null}
                    {action.id === "install-starter-model" ? (
                      <button
                        type="button"
                        onClick={() => void onInstallManagedVoiceRuntime("base.en", true)}
                        disabled={voiceBusy}
                       className="gc-button">
                        Install Starter Model
                      </button>
                    ) : null}
                    {action.id === "activate-installed-model" && action.modelId ? (
                      <button
                        type="button"
                        onClick={() => void onSelectManagedVoiceModel(action.modelId!)}
                        disabled={voiceBusy}
                       className="gc-button">
                        Activate {action.modelId}
                      </button>
                    ) : null}
                    {action.id === "stop-talk-session" ? (
                      <button
                        type="button"
                        onClick={onStopVoiceTalk}
                        disabled={voiceBusy || voiceStatus?.talk.state !== "running"}
                       className="gc-button">
                        Stop Talk Mode
                      </button>
                    ) : null}
                    {action.id === "stop-wake-listener" ? (
                      <button type="button" onClick={onStopWake} disabled={voiceBusy || !voiceStatus?.wake.enabled} className="gc-button">
                        Disable Wake
                      </button>
                    ) : null}
                    {action.id === "refresh-runtime-state" ? (
                      <button type="button" onClick={() => void refreshVoiceRuntime()} disabled={voiceBusy} className="gc-button">
                        Refresh Voice Status
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              <FieldHelp>No operator recovery steps are active. Voice looks ready for the proof-lane run.</FieldHelp>
              <FieldHelp>
                Use the System page voice proof draft to record the next transcription, talk, and wake validation pass.
              </FieldHelp>
            </>
          )}
        </article>
        <article className="voice-help-card">
          <h4>Managed Voice Runtime</h4>
          <ul className="voice-help-list">
            <li>
              <strong>Install / Repair Voice Runtime:</strong> Downloads or repairs the managed whisper.cpp runtime, the
              audio normalization helper, and a selected starter model.
            </li>
            <li>
              <strong>Download model:</strong> Adds another local whisper model without changing the active one.
            </li>
            <li>
              <strong>Activate model:</strong> Switches GoatCitadel to use that installed model for local transcription.
            </li>
            <li>
              <strong>Remove model:</strong> Deletes an inactive installed model from your local GoatCitadel home.
            </li>
            <li>
              <strong>Start Talk Mode:</strong> Creates a talk session and begins live listening flow using the selected
              mode.
            </li>
            <li>
              <strong>Stop Talk Mode:</strong> Stops the current talk session and clears active session state.
            </li>
            <li>
              <strong>Enable Wake:</strong> Turns on wake-word listener mode (for hands-free trigger workflows).
            </li>
            <li>
              <strong>Disable Wake:</strong> Turns wake-word listener off immediately.
            </li>
            <li>
              <strong>Refresh Voice Status:</strong> Re-reads current runtime status from gateway without changing
              state.
            </li>
            <li>
              <strong>Run Local Transcription:</strong> Uploads your selected audio file for one-shot local STT test.
            </li>
          </ul>
          <p className="office-subtitle">
            GoatCitadel now manages whisper.cpp locally by default. Advanced overrides like{" "}
            <code>GOATCITADEL_WHISPER_CPP_BIN</code> and <code>GOATCITADEL_WHISPER_CPP_MODEL_PATH</code> are still
            available for custom setups.
          </p>
        </article>
        <div className="controls-row">
          <button
            type="button"
            onClick={() => void onInstallManagedVoiceRuntime(voiceRuntime?.selectedModelId ?? "base.en", true)}
            disabled={voiceBusy}
           className="gc-button">
            {voiceRuntime?.readiness === "ready" ? "Repair Voice Runtime" : "Install Voice Runtime"}
          </button>
          <button type="button" onClick={() => void refreshVoiceRuntime()} disabled={voiceBusy} className="gc-button">
            Refresh Voice Status
          </button>
        </div>
        <div className="voice-model-catalog">
          {(voiceRuntime?.catalog ?? []).map((model) => {
            const installed = installedVoiceModelIds.has(model.id);
            const active = voiceRuntime?.selectedModelId === model.id;
            return (
              <article key={model.id} className="voice-model-card">
                <div className="voice-model-card__head">
                  <div>
                    <h4>{model.label}</h4>
                    <p className="table-subtext">
                      {formatVoiceLanguageScope(model.languageScope)} | {model.approxSizeLabel}
                    </p>
                  </div>
                  <div className="voice-model-card__badges">
                    {model.recommended ? <StatusChip tone="live">Recommended</StatusChip> : null}
                    {model.defaultInstall ? <StatusChip tone="muted">Starter</StatusChip> : null}
                    {installed ? (
                      <StatusChip tone="success">Installed</StatusChip>
                    ) : (
                      <StatusChip tone="warning">Available</StatusChip>
                    )}
                    {active ? <StatusChip tone="live">Active</StatusChip> : null}
                  </div>
                </div>
                <div className="voice-model-card__actions">
                  {!installed ? (
                    <button
                      type="button"
                      onClick={() => void onInstallManagedVoiceRuntime(model.id, false)}
                      disabled={voiceBusy}
                     className="gc-button">
                      Download model
                    </button>
                  ) : null}
                  {installed && !active ? (
                    <button type="button" onClick={() => void onSelectManagedVoiceModel(model.id)} disabled={voiceBusy} className="gc-button">
                      Activate model
                    </button>
                  ) : null}
                  {installed && !active ? (
                    <button type="button" onClick={() => void onRemoveManagedVoiceModel(model.id)} disabled={voiceBusy} className="gc-button">
                      Remove model
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
        <div className="controls-row">
          <label htmlFor="voiceTalkMode">Talk mode</label>
          <GCSelect
            id="voiceTalkMode"
            value={voiceTalkMode}
            onChange={(value) => onVoiceTalkModeChange(value as VoiceTalkMode)}
            options={[
              { value: "push_to_talk", label: "Push to talk" },
              { value: "wake", label: "Wake triggered" },
            ]}
          />
          <button
            type="button"
            onClick={onStartVoiceTalk}
            disabled={voiceBusy || voiceStatus?.talk.state === "running"}
           className="gc-button">
            Start Talk Mode
          </button>
          <button type="button" onClick={onStopVoiceTalk} disabled={voiceBusy || voiceStatus?.talk.state !== "running"} className="gc-button">
            Stop Talk Mode
          </button>
        </div>
        <div className="controls-row">
          <button type="button" onClick={onStartWake} disabled={voiceBusy || voiceStatus?.wake.enabled} className="gc-button">
            Enable Wake
          </button>
          <button type="button" onClick={onStopWake} disabled={voiceBusy || !voiceStatus?.wake.enabled} className="gc-button">
            Disable Wake
          </button>
        </div>
        <div className="controls-row">
          <label htmlFor="voiceTestFile">Transcription test file</label>
          <input
            id="voiceTestFile"
            type="file"
            accept="audio/*"
            onChange={(event) => onVoiceFileChange(event.target.files?.[0] ?? null)}
          />
          <button type="button" onClick={onRunVoiceTranscribeTest} disabled={voiceBusy || !voiceFile} className="gc-button">
            Run Local Transcription
          </button>
        </div>
        {voiceTranscriptResult ? <pre>{voiceTranscriptResult}</pre> : null}
      </Panel>
    </section>
  );
}
