import { useEffect, useMemo, useState } from "react";

function formatRemainingDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function InlineApprovalPrompt({
  approvalId,
  kind,
  toolName,
  reason,
  riskLevel,
  expiresAt,
  codeHash,
  wrapperManifestHash,
  capabilitySnapshotId,
  inspectPath,
  requestedOutputIntent,
  saveCandidateOnSuccess,
  remainingCount,
  affectedResources,
  codePreview,
  pending,
  compact = false,
  approvalsHref,
  workspaceAllowAvailable,
  persistentAllowAvailable = true,
  onApproveOnce,
  onApproveInSession,
  onApproveInWorkspace,
  onDeny,
}: {
  approvalId: string;
  kind?: string;
  toolName?: string;
  reason?: string;
  riskLevel?: "safe" | "caution" | "danger" | "nuclear";
  expiresAt?: string;
  codeHash?: string;
  wrapperManifestHash?: string;
  capabilitySnapshotId?: string;
  inspectPath?: string;
  requestedOutputIntent?: string;
  saveCandidateOnSuccess?: boolean;
  remainingCount?: number;
  affectedResources?: string[];
  codePreview?: string;
  pending?: boolean;
  compact?: boolean;
  approvalsHref?: string;
  workspaceAllowAvailable?: boolean;
  persistentAllowAvailable?: boolean;
  onApproveOnce: () => void;
  onApproveInSession: () => void;
  onApproveInWorkspace: () => void;
  onDeny: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [confirmWorkspaceAllow, setConfirmWorkspaceAllow] = useState(false);

  useEffect(() => {
    if (!expiresAt) {
      return undefined;
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return undefined;
    }
    const interval = globalThis.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => globalThis.clearInterval(interval);
  }, [expiresAt]);

  const expiryState = useMemo(() => {
    if (!expiresAt) {
      return { expired: false, label: undefined as string | undefined };
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return { expired: false, label: undefined as string | undefined };
    }
    const remainingMs = expiresAtMs - now;
    if (remainingMs <= 0) {
      return { expired: true, label: "Approval expired, rerun the action." };
    }
    return {
      expired: false,
      label: `Expires in ${formatRemainingDuration(remainingMs)}`,
    };
  }, [expiresAt, now]);

  const actionsDisabled = pending || expiryState.expired;
  const isUrgent = expiryState.expired === false && expiresAt != null;
  const remainingMs = expiresAt ? Date.parse(expiresAt) - now : Infinity;
  const isLowTime = remainingMs > 0 && remainingMs < 120_000;

  const riskSummary = buildRiskSummary(riskLevel);
  const decisionSummary = buildDecisionSummary({ toolName, kind, riskLevel });
  const resourceSummary = buildResourceSummary(affectedResources);
  const codeModeApproval = kind === "code_mode.run" || Boolean(codeHash || wrapperManifestHash || capabilitySnapshotId);
  useEffect(() => {
    if (actionsDisabled || !workspaceAllowAvailable || !persistentAllowAvailable || codeModeApproval) {
      setConfirmWorkspaceAllow(false);
    }
  }, [actionsDisabled, codeModeApproval, persistentAllowAvailable, workspaceAllowAvailable]);

  const scopeSummary =
    persistentAllowAvailable && !codeModeApproval
      ? "Allow once resumes just this request. Session allow keeps the same tool available in this chat session. Workspace allow creates a narrow reusable grant inside the current workspace."
      : "Allow once resumes only this approval. Persistent grants are not available for governed Code Mode runs.";

  return (
    <div
      className={`chat-approval-card${expiryState.expired ? " is-expired" : ""}${isLowTime ? " is-low-time" : ""}`}
      role="alert"
    >
      <div className="chat-approval-header">
        <p className="chat-approval-title">Approval required</p>
        {typeof remainingCount === "number" && remainingCount > 0 ? (
          <span className="chat-approval-countdown">+{remainingCount} more waiting</span>
        ) : null}
        {isUrgent && !expiryState.expired ? (
          <span className={`chat-approval-countdown${isLowTime ? " is-low-time" : ""}`}>{expiryState.label}</span>
        ) : null}
        {expiryState.expired ? <span className="chat-approval-countdown is-expired">{expiryState.label}</span> : null}
      </div>
      {toolName ? <p className="chat-approval-tool">{toolName}</p> : null}
      {riskSummary ? <p className="chat-approval-reason">{riskSummary}</p> : null}
      {!compact && kind ? <p className="chat-approval-reason">Action type: {kind}</p> : null}
      {reason ? <p className="chat-approval-reason">{reason}</p> : null}
      <p className="chat-approval-reason">{decisionSummary}</p>
      {!compact && requestedOutputIntent ? (
        <p className="chat-approval-reason">Expected result: {requestedOutputIntent}</p>
      ) : null}
      {!compact && resourceSummary ? <p className="chat-approval-reason">Touches: {resourceSummary}</p> : null}
      {saveCandidateOnSuccess ? (
        <p className="chat-approval-reason">On success, GoatCitadel will stage a candidate skill for review.</p>
      ) : null}
      {!compact ? <p className="chat-approval-reason">{scopeSummary}</p> : null}
      <div className="chat-approval-actions">
        <button
          type="button"
          className="gc-button chat-approval-allow"
          disabled={actionsDisabled}
          onClick={onApproveOnce}
        >
          Allow once
        </button>
        {persistentAllowAvailable && !codeModeApproval ? (
          <>
            <button
              type="button"
              className="gc-button chat-approval-allow"
              disabled={actionsDisabled}
              onClick={onApproveInSession}
            >
              Allow in session
            </button>
            <button
              type="button"
              className="gc-button chat-approval-allow"
              disabled={actionsDisabled || !workspaceAllowAvailable}
              onClick={() => setConfirmWorkspaceAllow(true)}
              title={
                workspaceAllowAvailable
                  ? "Allow this exact tool for the current workspace."
                  : "Workspace context is required."
              }
            >
              Allow in workspace
            </button>
          </>
        ) : null}
        <button type="button" className="gc-button chat-approval-deny" disabled={actionsDisabled} onClick={onDeny}>
          Deny
        </button>
      </div>
      {confirmWorkspaceAllow ? (
        <div className="chat-approval-confirm">
          <p className="chat-approval-reason">
            Workspace allow is broader than session allow and stays active until you revoke it.
          </p>
          <div className="chat-approval-actions">
            <button
              type="button"
              className="gc-button chat-approval-allow"
              disabled={actionsDisabled}
              onClick={onApproveInWorkspace}
            >
              Confirm workspace allow
            </button>
            <button
              type="button"
              className="gc-button chat-approval-deny"
              disabled={actionsDisabled}
              onClick={() => setConfirmWorkspaceAllow(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {codePreview || codeHash || wrapperManifestHash || capabilitySnapshotId || inspectPath ? (
        <details className="approval-technical-details">
          <summary>Technical details</summary>
          {codePreview ? <pre className="chat-approval-id">{codePreview}</pre> : null}
          {codeHash ? <p className="chat-approval-id">Code hash: {codeHash}</p> : null}
          {wrapperManifestHash ? <p className="chat-approval-id">Wrapper hash: {wrapperManifestHash}</p> : null}
          {capabilitySnapshotId ? <p className="chat-approval-id">Snapshot: {capabilitySnapshotId}</p> : null}
          {inspectPath ? <p className="chat-approval-id">Inspect: {inspectPath}</p> : null}
        </details>
      ) : null}
      {approvalsHref ? (
        <p className="chat-approval-id">
          <a href={approvalsHref}>Open persisted approval record</a>
        </p>
      ) : null}
      <p className="chat-approval-id">{approvalId}</p>
    </div>
  );
}

function buildRiskSummary(riskLevel?: "safe" | "caution" | "danger" | "nuclear"): string | null {
  switch (riskLevel) {
    case "safe":
      return "Safe risk. Review is still required because this run already paused for confirmation.";
    case "caution":
      return "Caution risk. This action writes state or crosses a policy boundary, but it should still be reversible.";
    case "danger":
      return "Danger risk. This action can change data or external state in ways that may require manual cleanup.";
    case "nuclear":
      return "Nuclear risk. This action is expensive, destructive, or difficult to reverse once executed.";
    default:
      return null;
  }
}

function buildDecisionSummary(input: {
  toolName?: string;
  kind?: string;
  riskLevel?: "safe" | "caution" | "danger" | "nuclear";
}): string {
  const subject = input.toolName ?? input.kind ?? "This action";
  switch (input.riskLevel) {
    case "safe":
      return `${subject} is ready to continue as soon as you approve it.`;
    case "caution":
      return `${subject} will continue immediately after approval and may create a reversible write or runtime change.`;
    case "danger":
      return `${subject} will continue immediately after approval and may mutate project, account, or integration state.`;
    case "nuclear":
      return `${subject} will continue immediately after approval and should be treated like a high-blast-radius operation.`;
    default:
      return `${subject} is paused until you explicitly approve or deny it.`;
  }
}

function buildResourceSummary(resources?: string[]): string | null {
  if (!resources || resources.length === 0) {
    return null;
  }
  const visible = resources.slice(0, 4);
  const suffix = resources.length > visible.length ? `, +${resources.length - visible.length} more` : "";
  return `${visible.join(", ")}${suffix}`;
}
