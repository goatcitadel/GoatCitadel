import { useEffect, useMemo, useState } from "react";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import type {
  ChatMode,
  ChatPlanningMode,
  ChatSessionPrefsPatch,
  ChatSpeedMode,
  ChatSubagentPolicy,
  ChatThinkingLevel,
} from "@goatcitadel/contracts";
import { ChatTraceCard } from "@goatcitadel/mission-control-shared/components/ChatTraceCard";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { IdentifierChip } from "@goatcitadel/mission-control-shared/components/IdentifierChip";
import { GeneratedArtifactViewer } from "@goatcitadel/mission-control-shared/components/chat/GeneratedArtifactViewer";
import { AssistantMessageRenderer } from "@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer";
import { StatusChip } from "../native-routes/primitives";
import { ChatCapabilityProfileRunDetail } from "./ChatCapabilityProfilePanel";

type DrawerTab = "context" | "documents" | "trace" | "assist" | "session";

const SUBAGENT_AUTO_ACK_STORAGE_PREFIX = "mc-next:subagent-auto-ack:";

function readSubagentAutoAckFromStorage(sessionId: string | null): boolean {
  if (!sessionId || typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(`${SUBAGENT_AUTO_ACK_STORAGE_PREFIX}${sessionId}`) === "1";
  } catch {
    // localStorage access can throw in privacy modes; treat as unacknowledged
    // and ignore the failure - the consent modal will simply ask again.
    return false;
  }
}

function writeSubagentAutoAckToStorage(sessionId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(`${SUBAGENT_AUTO_ACK_STORAGE_PREFIX}${sessionId}`, "1");
  } catch {
    // localStorage write may fail (privacy mode, quota); intentionally ignore
    // and accept that the consent modal re-appears next time. This is a
    // best-effort, non-fatal UI acknowledgement, not a runtime invariant.
  }
}

function formatSelectionSource(value?: string | null): string {
  return value ? `Selection: ${value}` : "Selection pending";
}

function formatRouteSummary(props: MissionThreadedContextDockProps): string {
  const parts = [props.selectedProviderId, props.selectedModel].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "Route pending";
}

function formatThreadedSecuritySummary(permissionOverrideActive?: boolean): string {
  const overrideCopy = permissionOverrideActive
    ? "A local operator override is active for this session, so normal prompts may be reduced while the override lasts."
    : "No local operator override is active for this session.";
  return `${overrideCopy} Deny-wins policy, approval gates, auth boundaries, path jails, provenance, and health checks remain enforced. The code capability is governed trusted-code execution; this drawer does not claim hostile-code sandboxing.`;
}

function formatTrustRouteSummary(props: MissionThreadedContextDockProps): string | null {
  if (!props.trust?.requestedProviderModelSummary && !props.trust?.effectiveProviderModelSummary) {
    return null;
  }
  const requested = props.trust.requestedProviderModelSummary
    ? `requested ${props.trust.requestedProviderModelSummary}`
    : "requested route pending";
  const effective = props.trust.effectiveProviderModelSummary
    ? `effective ${props.trust.effectiveProviderModelSummary}`
    : "effective route pending";
  return `${requested}; ${effective}`;
}

function formatContextValue(value?: string | null, fallback = "Not set"): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function getContextBlockerSummary(props: MissionThreadedContextDockProps): string {
  if (props.routePreflight?.blockedReason) {
    return props.routePreflight.blockedReason;
  }
  if (props.routePreflight?.degradedReason) {
    return props.routePreflight.degradedReason;
  }
  if (props.codeModeNeedsProjectBinding) {
    return "Build posture needs a project binding.";
  }
  if (!props.streamEnabled) {
    return "Streaming is off.";
  }
  return "None";
}

function getProjectSummary(props: MissionThreadedContextDockProps): string {
  const projectOptions = props.projectOptions ?? [];
  const sessionProjectId = props.selectedSession?.projectId?.trim();
  const matchedProjectOption = sessionProjectId
    ? projectOptions.find((project) => project.value === sessionProjectId)?.label
    : undefined;
  return matchedProjectOption ?? props.selectedSession?.projectName ?? sessionProjectId ?? "No project bound";
}

function formatPreferenceDraftFields(patch: ChatSessionPrefsPatch): string {
  const fields = Object.keys(patch)
    .filter((key) => key !== "expectedRevision")
    .map((key) => key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
  return fields.length > 0 ? fields.join(", ") : "session preferences";
}

function ThreadedDocumentsPanel({ props }: { props: MissionThreadedContextDockProps }) {
  const documents = props.documents;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedNote = documents?.notes.find((note) => `personal_note:${note.noteId}` === selectedKey);
  const selectedArtifact = documents?.artifacts.find(
    (artifact) => `generated_artifact:${artifact.artifactId}` === selectedKey,
  );
  const editable = Boolean(selectedNote || selectedArtifact?.kind === "markdown" || selectedArtifact?.kind === "text");
  const selectedRef = selectedNote
    ? { kind: "personal_note" as const, ref: selectedNote.noteId, label: selectedNote.title }
    : selectedArtifact
      ? { kind: "generated_artifact" as const, ref: selectedArtifact.artifactId, label: selectedArtifact.title }
      : null;
  const included = selectedRef
    ? documents?.includedRefs.some((ref) => ref.kind === selectedRef.kind && ref.ref === selectedRef.ref) === true
    : false;

  useEffect(() => {
    setDraft(selectedNote?.body ?? selectedArtifact?.content ?? "");
    setError(null);
  }, [selectedArtifact?.artifactId, selectedArtifact?.content, selectedNote?.body, selectedNote?.noteId]);

  if (!documents?.enabled) {
    return <p className="mc-next-context-empty">Document editing is unavailable in this runtime.</p>;
  }

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The document action failed.");
      await documents.onRefresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mc-next-context-section-stack">
      <section className="mc-next-context-card">
        <div className="mc-next-context-card-title-row">
          <div>
            <p className="mc-next-panel-kicker">Documents</p>
            <h4>Notes and generated artifacts</h4>
          </div>
          <button
            type="button"
            className="mc-next-panel-button"
            disabled={documents.loading}
            onClick={() => void documents.onRefresh()}
          >
            Refresh
          </button>
        </div>
        <p>Opening a document never adds it to model context. Use “Include in next turn” explicitly.</p>
        <div className="mc-next-context-actions" role="list" aria-label="Chat documents">
          {documents.notes.map((note) => (
            <button
              key={note.noteId}
              type="button"
              className="mc-next-panel-button"
              aria-pressed={selectedKey === `personal_note:${note.noteId}`}
              onClick={() => setSelectedKey(`personal_note:${note.noteId}`)}
            >
              Note · {note.title} · r{note.revision}
            </button>
          ))}
          {documents.artifacts.map((artifact) => (
            <button
              key={artifact.artifactId}
              type="button"
              className="mc-next-panel-button"
              aria-pressed={selectedKey === `generated_artifact:${artifact.artifactId}`}
              onClick={() => setSelectedKey(`generated_artifact:${artifact.artifactId}`)}
            >
              Artifact · {artifact.title} · {artifact.kind} v{artifact.version}
            </button>
          ))}
        </div>
      </section>

      {selectedRef ? (
        <section className="mc-next-context-card">
          <p className="mc-next-panel-kicker">{selectedNote ? "Personal note" : "Generated artifact"}</p>
          <h4>{selectedRef.label}</h4>
          <div className="mc-next-context-actions">
            <button
              type="button"
              className="mc-next-panel-button"
              aria-pressed={included}
              onClick={() => documents.onToggleInclude(selectedRef)}
            >
              {included ? "Included in next turn" : "Include in next turn"}
            </button>
          </div>
          {editable ? (
            <>
              <label className="mc-next-context-field">
                <span>Document content</span>
                <textarea
                  value={draft}
                  rows={12}
                  maxLength={256 * 1024}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <div className="mc-next-context-actions">
                <button
                  type="button"
                  className="mc-next-panel-button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (selectedNote) await documents.onSaveNote(selectedNote, draft);
                      else if (selectedArtifact) {
                        const saved = await documents.onSaveArtifact(selectedArtifact, draft);
                        setSelectedKey(`generated_artifact:${saved.artifactId}`);
                      }
                    })
                  }
                >
                  Save directly
                </button>
                <button
                  type="button"
                  className="mc-next-panel-button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await documents.onCreateProposal({
                        targetKind: selectedNote ? "personal_note" : "generated_artifact",
                        targetId: selectedRef.ref,
                        baseRevision: selectedNote?.revision,
                        baseContentHash: selectedArtifact?.contentHash,
                        proposedContent: draft,
                      });
                    })
                  }
                >
                  Create review proposal
                </button>
              </div>
            </>
          ) : (
            <p role="status">
              {selectedArtifact?.kind ?? "This document"} is read-only. Only notes and generated Markdown/text artifacts
              can be edited.
            </p>
          )}
          <details className="mc-next-context-detail-disclosure" open>
            <summary>Safe preview</summary>
            {selectedNote ? <AssistantMessageRenderer role="assistant" content={draft} /> : null}
            {selectedArtifact ? (
              <GeneratedArtifactViewer artifact={{ ...selectedArtifact, content: draft }} compact />
            ) : null}
          </details>
          {error ? <p role="alert">{error}</p> : null}
        </section>
      ) : null}

      {documents.proposals.length > 0 ? (
        <section className="mc-next-context-card">
          <p className="mc-next-panel-kicker">Patch proposals</p>
          <h4>Review before apply</h4>
          {documents.proposals.map((proposal) => (
            <details key={proposal.proposalId} className="mc-next-context-detail-disclosure">
              <summary>
                {proposal.targetKind} · {proposal.state}
              </summary>
              <p>
                {proposal.authorKind} provenance · {proposal.turnId ?? proposal.authorId}
              </p>
              <pre className="generated-artifact-code-block">{proposal.derivedDiff}</pre>
              {proposal.conflictReason ? <p role="alert">{proposal.conflictReason}</p> : null}
              {proposal.state === "pending" ? (
                <div className="mc-next-context-actions">
                  <button
                    type="button"
                    className="mc-next-panel-button"
                    disabled={busy}
                    onClick={() => void run(() => documents.onApplyProposal(proposal.proposalId))}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="mc-next-panel-button"
                    disabled={busy}
                    onClick={() => void run(() => documents.onRejectProposal(proposal.proposalId))}
                  >
                    Reject
                  </button>
                </div>
              ) : null}
              {proposal.state === "conflicted" ? (
                <button
                  type="button"
                  className="mc-next-panel-button"
                  onClick={() => {
                    setSelectedKey(`${proposal.targetKind}:${proposal.targetId}`);
                    setDraft(proposal.proposedContent);
                  }}
                >
                  Load for rebase
                </button>
              ) : null}
            </details>
          ))}
        </section>
      ) : null}
    </div>
  );
}

export function ThreadedContextDrawer({
  surface,
  props,
  permissionSummary,
  permissionOverrideActive,
  onCopyTrustReport,
}: {
  surface: ChatMode;
  props: MissionThreadedContextDockProps;
  permissionSummary?: string;
  permissionOverrideActive?: boolean;
  onCopyTrustReport?: (sessionId?: string | null, turnId?: string | null) => void;
}) {
  const [activeTab, setActiveTab] = useState<DrawerTab>("context");
  const projectOptions = useMemo(() => props.projectOptions ?? [], [props.projectOptions]);
  const [pendingSubagentAuto, setPendingSubagentAuto] = useState<ChatSubagentPolicy | null>(null);
  const thinkingLevel: ChatThinkingLevel = props.prefs?.thinkingLevel ?? "standard";
  const speedMode: ChatSpeedMode = props.prefs?.speedMode ?? "standard";
  const subagentPolicy: ChatSubagentPolicy = props.prefs?.subagentPolicy ?? "ask_when_useful";
  const planningMode: ChatPlanningMode = props.prefs?.planningMode ?? props.planningMode ?? "off";
  const planningEnabled = planningMode === "advisory";
  const trustRouteSummary = formatTrustRouteSummary(props);
  const selectionSummary =
    props.trust?.selectionSourceSummary ?? formatSelectionSource(props.routePreflight?.selectionSource);
  const streamSummary = `${props.streamEnabled ? "On" : "Off"} · ${
    props.visualStreamMode === "smooth" ? "Smooth" : "Instant"
  }`;
  const handleSubagentPolicyChange = (next: ChatSubagentPolicy) => {
    if (next === "auto_when_useful" && !readSubagentAutoAckFromStorage(props.selectedSessionId)) {
      setPendingSubagentAuto(next);
      return;
    }
    void props.onPrefPatch({ subagentPolicy: next });
  };

  return (
    <div className="mc-next-context-drawer" data-mode={surface}>
      <div className="mc-next-context-drawer-head">
        <p className="mc-next-panel-kicker">Working Context</p>
        <h3>Thread grounding</h3>
      </div>
      <div
        className="mc-next-panel-tab-row mc-next-context-tab-row"
        role="tablist"
        aria-label="Context drawer panels"
        data-layout="balanced-grid"
      >
        {(["context", "documents", "trace", "assist", "session"] as DrawerTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`mc-next-panel-tab${activeTab === tab ? " active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "context"
              ? "Context"
              : tab === "documents"
                ? "Documents"
                : tab === "trace"
                  ? "Trace"
                  : tab === "assist"
                    ? "Assist"
                    : "Session"}
          </button>
        ))}
      </div>

      {props.preferenceConflictDraft ? (
        <div className="mc-next-context-card" role="status" aria-live="polite">
          <p className="mc-next-panel-kicker">Unsaved preference draft</p>
          <p>
            The server preferences changed elsewhere. The latest server state remains canonical. Pending:{" "}
            {formatPreferenceDraftFields(props.preferenceConflictDraft)}.
          </p>
          <div className="mc-next-context-actions">
            <button
              type="button"
              className="mc-next-panel-button"
              onClick={() => void props.onRetryPreferenceConflictDraft()}
            >
              Retry preference changes
            </button>
            <button type="button" className="mc-next-panel-button" onClick={props.onDiscardPreferenceConflictDraft}>
              Discard preference draft
            </button>
          </div>
        </div>
      ) : null}

      {props.proactivePolicyConflict && props.proactivePolicyDraft ? (
        <div className="mc-next-context-card" role="status" aria-live="polite">
          <p className="mc-next-panel-kicker">Unsaved policy draft</p>
          <p>The server policy changed elsewhere. The latest server state remains canonical.</p>
          <button
            type="button"
            className="mc-next-panel-button"
            onClick={() => void props.onProactivePolicyPatch(props.proactivePolicyDraft!)}
          >
            Retry preserved changes
          </button>
        </div>
      ) : null}

      {activeTab === "context" ? (
        <div className="mc-next-context-section-stack">
          <section className="mc-next-context-card">
            <p className="mc-next-panel-kicker">Context</p>
            <h4>{formatRouteSummary(props)}</h4>
            <dl className="mc-next-context-summary-grid">
              <div>
                <dt>Workspace scope</dt>
                <dd>{formatContextValue(props.selectedSession?.workspaceId, "default")}</dd>
              </div>
              <div>
                <dt>Project</dt>
                <dd>{getProjectSummary(props)}</dd>
              </div>
              <div>
                <dt>Memory</dt>
                <dd>{props.selectedTurn?.trace.memoryMode ?? props.prefs?.memoryMode ?? "Session default"}</dd>
              </div>
              <div>
                <dt>Current blocker</dt>
                <dd>{getContextBlockerSummary(props)}</dd>
              </div>
            </dl>
            <div className="mc-next-context-chip-row">
              <StatusChip tone={props.streamEnabled ? "success" : "muted"}>Streaming: {streamSummary}</StatusChip>
              <StatusChip tone={planningEnabled ? "success" : "muted"}>
                {planningEnabled ? "Planning on" : "Planning off"}
              </StatusChip>
            </div>
            <details className="mc-next-context-detail-disclosure">
              <summary>Runtime controls</summary>
              <div className="mc-next-context-actions">
                <button
                  type="button"
                  className="mc-next-panel-button"
                  onClick={() => props.onStreamEnabledChange(!props.streamEnabled)}
                >
                  {props.streamEnabled ? "Disable streaming" : "Enable streaming"}
                </button>
                <div className="mc-next-visual-stream-toggle" role="group" aria-label="Visual stream mode">
                  {(["smooth", "instant"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`mc-next-panel-button${props.visualStreamMode === mode ? " active" : ""}`}
                      aria-pressed={props.visualStreamMode === mode}
                      onClick={() => props.onVisualStreamModeChange(mode)}
                    >
                      {mode === "smooth" ? "Smooth" : "Instant"}
                    </button>
                  ))}
                </div>
                {props.selectedProviderId ? (
                  <button
                    type="button"
                    className="mc-next-panel-button"
                    onClick={() =>
                      void props.onPrefPatch({
                        providerId: props.selectedProviderId,
                        model: props.selectedModel,
                      })
                    }
                  >
                    Reapply route
                  </button>
                ) : null}
                <button
                  type="button"
                  className="mc-next-panel-button"
                  aria-pressed={props.planningMode === "advisory"}
                  onClick={() =>
                    void props.onPrefPatch({
                      planningMode: props.planningMode === "advisory" ? "off" : "advisory",
                    })
                  }
                >
                  {props.planningMode === "advisory" ? "Turn planning off" : "Turn planning on"}
                </button>
              </div>
            </details>
            {props.routePreflight?.degradedReason ? <p>{props.routePreflight.degradedReason}</p> : null}
            {props.routePreflight?.blockedReason ? <p>{props.routePreflight.blockedReason}</p> : null}
            {onCopyTrustReport && props.selectedSessionId ? (
              <div className="mc-next-context-actions">
                <button
                  type="button"
                  className="mc-next-panel-button"
                  onClick={() => onCopyTrustReport(props.selectedSessionId, props.selectedTurn?.turnId)}
                >
                  Copy trust report
                </button>
              </div>
            ) : null}
          </section>

          {props.trust ? (
            <section className="mc-next-context-card">
              <p className="mc-next-panel-kicker">Policy and security</p>
              <h4>{props.trust.gatewayLabel}</h4>
              <div className="mc-next-context-truth-compact">
                <StatusChip tone="muted">{permissionSummary ?? "Policy pending"}</StatusChip>
                <StatusChip tone="muted">{selectionSummary}</StatusChip>
                {props.trust.fallbackSummary ? (
                  <StatusChip tone="warning">{props.trust.fallbackSummary}</StatusChip>
                ) : null}
              </div>
              <details className="mc-next-context-detail-disclosure">
                <summary>Inspect policy detail</summary>
                <div className="mc-next-context-truth-copy">
                  <p>
                    <strong>Gateway:</strong> {props.trust.gatewayDetail ?? props.trust.gatewayLabel}
                  </p>
                  <p>
                    <strong>Policy:</strong> {permissionSummary ?? "Policy state unavailable."}
                  </p>
                  <p>
                    <strong>Security:</strong> {formatThreadedSecuritySummary(permissionOverrideActive)}
                  </p>
                  {trustRouteSummary ? (
                    <p>
                      <strong>Route:</strong> {trustRouteSummary}
                    </p>
                  ) : null}
                </div>
              </details>
            </section>
          ) : null}

          <ChatCapabilityProfileRunDetail inspection={props.capabilityProfileInspection} />

          {props.activeGeneratedArtifact ? (
            <section className="mc-next-context-card">
              <div className="mc-next-panel-list-head">
                <strong>{props.activeGeneratedArtifact.title}</strong>
                {props.onCloseGeneratedArtifact ? (
                  <button type="button" className="mc-next-panel-button" onClick={props.onCloseGeneratedArtifact}>
                    Close
                  </button>
                ) : null}
              </div>
              <GeneratedArtifactViewer artifact={props.activeGeneratedArtifact} compact />
            </section>
          ) : null}
        </div>
      ) : null}

      {activeTab === "documents" ? <ThreadedDocumentsPanel props={props} /> : null}

      {activeTab === "trace" ? (
        <div className="mc-next-context-section-stack">
          {props.selectedTurn ? (
            <>
              <section className="mc-next-context-card">
                <p className="mc-next-panel-kicker">Turn trace</p>
                <h4>Selected turn</h4>
                <IdentifierChip value={props.selectedTurn.turnId} label="Turn" />
                <div className="mc-next-context-chip-row">
                  <StatusChip
                    tone={
                      props.selectedTurn.trace.status === "failed"
                        ? "critical"
                        : props.selectedTurn.trace.status === "completed"
                          ? "success"
                          : "warning"
                    }
                  >
                    {props.selectedTurn.trace.status}
                  </StatusChip>
                  {props.selectedTurn.trace.routing.fallbackUsed ? (
                    <StatusChip tone="warning">Fallback used</StatusChip>
                  ) : null}
                </div>
                <p>{props.selectedTurn.trace.failure?.message ?? "No failure recorded for this turn."}</p>
                {props.onExportRunBundle ? (
                  <div className="mc-next-context-actions">
                    <button type="button" className="mc-next-panel-button" onClick={props.onExportRunBundle}>
                      Export run bundle
                    </button>
                  </div>
                ) : null}
              </section>
              <ChatCapabilityProfileRunDetail inspection={props.capabilityProfileInspection} />
              <ChatTraceCard
                trace={props.selectedTurn.trace}
                workspaceId={props.selectedSession.workspaceId ?? "default"}
                defaultCollapsed={false}
              />
            </>
          ) : (
            <section className="mc-next-context-card">
              <p>No turn is selected yet. Select a turn in the timeline to inspect execution details.</p>
            </section>
          )}
        </div>
      ) : null}

      {activeTab === "assist" ? (
        <div className="mc-next-context-section-stack">
          <section className="mc-next-context-card">
            <p className="mc-next-panel-kicker">Run shape</p>
            <label className="mc-next-context-field">
              <span>Thinking</span>
              <select
                value={thinkingLevel}
                onChange={(event) => void props.onPrefPatch({ thinkingLevel: event.target.value as ChatThinkingLevel })}
                aria-label="Thinking level"
              >
                <option value="off">No thinking</option>
                <option value="minimal">Minimal</option>
                <option value="standard">Standard</option>
                <option value="extended">Extended</option>
                <option value="deep">Deep</option>
                <option value="max">Maximum (supported models only)</option>
                <option value="ultra">Ultra (supported models only)</option>
              </select>
            </label>
            <label className="mc-next-context-field">
              <span>Speed</span>
              <select
                value={speedMode}
                onChange={(event) => void props.onPrefPatch({ speedMode: event.target.value as ChatSpeedMode })}
                aria-label="Speed mode"
              >
                <option value="standard">Standard</option>
                <option value="fast">Fast</option>
              </select>
            </label>
            <label className="mc-next-context-field">
              <span>Subagents</span>
              <select
                value={subagentPolicy}
                onChange={(event) => handleSubagentPolicyChange(event.target.value as ChatSubagentPolicy)}
                aria-label="Subagent policy"
              >
                <option value="off">No subagents</option>
                <option value="ask_when_useful">Ask before delegating</option>
                <option value="auto_when_useful">Auto-delegate to subagents</option>
              </select>
            </label>
            <div className="mc-next-context-actions">
              <button
                type="button"
                className={`mc-next-panel-button${planningEnabled ? " active" : ""}`}
                aria-pressed={planningEnabled}
                onClick={() => void props.onPrefPatch({ planningMode: planningEnabled ? "off" : "advisory" })}
              >
                {planningEnabled ? "Planning on" : "Turn planning on"}
              </button>
            </div>
          </section>

          <section className="mc-next-context-card">
            <p className="mc-next-panel-kicker">Assist posture</p>
            <div className="mc-next-context-chip-row">
              <StatusChip tone="muted">{props.capabilitySuggestions.length} capability suggestions</StatusChip>
              <StatusChip tone="muted">{props.specialistSuggestions.length} specialist suggestions</StatusChip>
              <StatusChip tone="muted">{props.learnedMemory.length} learned memory</StatusChip>
            </div>
          </section>

          {props.capabilitySuggestions.length > 0 ? (
            <section className="mc-next-context-card">
              <p className="mc-next-panel-kicker">Capability suggestions</p>
              <ul className="mc-next-context-list">
                {props.capabilitySuggestions.map((suggestion) => (
                  <li key={`${suggestion.kind}-${suggestion.title}`}>
                    <strong>{suggestion.title}</strong>
                    <p>{suggestion.summary}</p>
                    <button
                      type="button"
                      className="mc-next-panel-button"
                      onClick={() => props.onCapabilitySuggestionAction(suggestion)}
                    >
                      Review suggestion
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {props.delegationSuggestion ? (
            <section className="mc-next-context-card">
              <p className="mc-next-panel-kicker">Subagents</p>
              <strong>{props.delegationSuggestion.mode}</strong>
              <p>{props.delegationSuggestion.objective}</p>
              <div className="mc-next-context-chip-row">
                {props.delegationSuggestion.roles.map((role) => (
                  <StatusChip key={role} tone="muted">
                    {role}
                  </StatusChip>
                ))}
              </div>
              <div className="mc-next-context-actions">
                <button
                  type="button"
                  className="mc-next-panel-button primary"
                  onClick={() => void props.onAcceptDelegation()}
                >
                  Use subagents
                </button>
              </div>
            </section>
          ) : null}

          {props.specialistSuggestions.length > 0 ? (
            <section className="mc-next-context-card">
              <p className="mc-next-panel-kicker">Specialists</p>
              <ul className="mc-next-context-list">
                {props.specialistSuggestions.map((suggestion) => (
                  <li key={suggestion.candidateId}>
                    <strong>{suggestion.title}</strong>
                    <p>{suggestion.summary}</p>
                    <div className="mc-next-context-actions">
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        onClick={() => void props.onCreateSpecialistDraft(suggestion)}
                      >
                        Draft
                      </button>
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        onClick={() => void props.onActivateCatalogSpecialist(suggestion)}
                      >
                        Activate
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {props.learnedMemory.length > 0 ? (
            <section className="mc-next-context-card">
              <p className="mc-next-panel-kicker">Learned memory</p>
              <ul className="mc-next-context-list">
                {props.learnedMemory.slice(0, 8).map((item) => (
                  <li key={item.itemId}>
                    <strong>{item.content}</strong>
                    <p>{item.status}</p>
                    <div className="mc-next-context-actions">
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        onClick={() => void props.onUpdateMemoryStatus(item.itemId, "active")}
                      >
                        Keep active
                      </button>
                      <button
                        type="button"
                        className="mc-next-panel-button"
                        onClick={() => void props.onUpdateMemoryStatus(item.itemId, "superseded")}
                      >
                        Mark stale
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mc-next-panel-button"
                onClick={() => void props.onRebuildLearnedMemory()}
              >
                Rebuild learned memory
              </button>
            </section>
          ) : null}
        </div>
      ) : null}

      {activeTab === "session" ? (
        <div className="mc-next-context-section-stack">
          <section className="mc-next-context-card">
            <p className="mc-next-panel-kicker">Session</p>
            <label className="mc-next-context-field">
              <span>Rename</span>
              <input
                value={props.renameTitle}
                onChange={(event) => props.onRenameTitleChange(event.target.value)}
                placeholder={props.selectedSession.title ?? "Session title"}
              />
            </label>
            <label className="mc-next-context-field">
              <span>Folder</span>
              <input
                value={props.folderName}
                onChange={(event) => props.onFolderNameChange(event.target.value)}
                placeholder="Folder"
              />
            </label>
            <label className="mc-next-context-field">
              <span>Tags</span>
              <input
                value={props.tagsValue}
                onChange={(event) => props.onTagsValueChange(event.target.value)}
                placeholder="tag-one, tag-two"
              />
            </label>
            <label className="mc-next-context-field">
              <span>Project</span>
              <select
                value={props.selectedSessionProjectValue}
                onChange={(event) => void props.onAssignProject(event.target.value)}
              >
                {projectOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="mc-next-context-actions">
              <button
                type="button"
                className="mc-next-panel-button primary"
                onClick={() => void props.onRenameSession()}
              >
                Save title
              </button>
              <button type="button" className="mc-next-panel-button" onClick={() => void props.onSaveOrganization()}>
                Save organization
              </button>
              <button type="button" className="mc-next-panel-button" onClick={() => void props.onTogglePinSession()}>
                {props.selectedSession.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                className="mc-next-panel-button"
                onClick={() => void props.onToggleArchiveSession()}
              >
                {props.selectedSession.lifecycleStatus === "archived" ? "Restore" : "Archive"}
              </button>
            </div>
            <div className="mc-next-context-actions">
              <button type="button" className="mc-next-panel-button" onClick={props.onExportSnapshot}>
                Export snapshot
              </button>
              <button type="button" className="mc-next-panel-button danger" onClick={props.onDeleteSession}>
                Delete session
              </button>
            </div>
          </section>

          <section className="mc-next-context-card">
            <p className="mc-next-panel-kicker">External binding</p>
            <label className="mc-next-context-field">
              <span>Connection</span>
              <input
                value={props.integrationConnectionId}
                onChange={(event) => props.onIntegrationConnectionIdChange(event.target.value)}
                placeholder="Connection id"
              />
            </label>
            <label className="mc-next-context-field">
              <span>Target</span>
              <input
                value={props.integrationTarget}
                onChange={(event) => props.onIntegrationTargetChange(event.target.value)}
                placeholder="Target thread / channel"
              />
            </label>
            <button type="button" className="mc-next-panel-button" onClick={() => void props.onSaveExternalBinding()}>
              Save binding
            </button>
          </section>
        </div>
      ) : null}

      <ConfirmModal
        open={pendingSubagentAuto !== null}
        title="Allow Chat to auto-delegate to subagents?"
        message="Auto-delegation lets Chat split runs across multiple subagents without asking each time. You will still see the run plan and can stop it. This persists for this session."
        confirmLabel="Allow auto-delegation"
        cancelLabel="Keep asking"
        danger
        onCancel={() => setPendingSubagentAuto(null)}
        onConfirm={() => {
          if (pendingSubagentAuto && props.selectedSessionId) {
            writeSubagentAutoAckToStorage(props.selectedSessionId);
            void props.onPrefPatch({ subagentPolicy: pendingSubagentAuto });
          }
          setPendingSubagentAuto(null);
        }}
      />
    </div>
  );
}
