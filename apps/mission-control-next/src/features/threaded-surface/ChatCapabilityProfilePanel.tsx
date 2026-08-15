import type {
  ChatRoutedContextInspection,
  ChatTurnCapabilityProfilePreview,
  ChatTurnCapabilityProfileRecord,
  ChatWorkspaceSnapshotRecord,
  WorkPassportBaseline,
  WorkPassportDomain,
  WorkPassportRecord,
} from "@goatcitadel/contracts";
import { WORK_PASSPORT_DOMAINS } from "@goatcitadel/contracts";
import type { ChatCapabilityProfileInspection } from "@goatcitadel/threaded-surface-core";
import {
  fetchWorkPassportBaseline,
  updateWorkPassportBaseline,
} from "@goatcitadel/mission-control-shared/api/work-passport";
import { useEffect, useId, useState } from "react";
import { StatusChip } from "../native-routes/primitives";

function shortHash(value: string | undefined, size = 12): string {
  if (!value) {
    return "not recorded";
  }
  return value.length > size ? `${value.slice(0, size)}…` : value;
}

function formatRoute(providerId?: string, model?: string): string {
  return [providerId, model].filter(Boolean).join(" / ") || "route unresolved";
}

function formatLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function readinessTone(status: "ready" | "missing" | "blocked" | "unknown") {
  return status === "ready" ? "success" : status === "missing" || status === "blocked" ? "critical" : "muted";
}

export function ChatCapabilityProfilePreflight({
  profile,
  workspaceId,
  onBaselineUpdated,
}: {
  profile: ChatTurnCapabilityProfilePreview;
  workspaceId?: string;
  onBaselineUpdated?: () => Promise<void>;
}) {
  const [profileDetailsOpen, setProfileDetailsOpen] = useState(false);
  const profileDetailsId = useId();
  const blocked = profile.blockedReasons.length > 0;
  const blockedReadiness = profile.authReadiness.filter(
    (item) => item.status === "missing" || item.status === "blocked",
  );
  const ready = !blocked && blockedReadiness.length === 0;

  return (
    <section
      className="mc-next-capability-profile mc-next-capability-profile-preflight"
      aria-label="Capability profile before send"
      data-profile-fingerprint={profile.fingerprint}
    >
      <div className="mc-next-capability-profile-head">
        <StatusChip tone={ready ? "success" : "warning"}>
          {ready ? "Capabilities ready" : "Profile needs review"}
        </StatusChip>
        <p aria-live="polite">
          {profile.selectedTools.length} tools · {profile.trustedSkills.length} skills · memory {profile.memory.mode}
          {profile.approval.toolsRequiringApproval.length > 0
            ? ` · ${profile.approval.toolsRequiringApproval.length} approval-gated`
            : " · no selected tool approvals"}
        </p>
      </div>
      {profile.workPassport ? (
        <WorkPassportPanel
          passport={profile.workPassport}
          workspaceId={workspaceId}
          onBaselineUpdated={onBaselineUpdated}
        />
      ) : null}
      {profile.workspaceSnapshot ? <WorkspaceSnapshotReceipt snapshot={profile.workspaceSnapshot} /> : null}
      <details
        className="mc-next-capability-profile-disclosure"
        open={profileDetailsOpen}
        onToggle={(event) => setProfileDetailsOpen(event.currentTarget.open)}
      >
        <summary aria-expanded={profileDetailsOpen} aria-controls={profileDetailsId}>
          Inspect proposed profile
        </summary>
        <div id={profileDetailsId} className="mc-next-capability-profile-detail">
          <dl className="mc-next-capability-profile-facts">
            <div>
              <dt>Route</dt>
              <dd>{formatRoute(profile.providerId, profile.model)}</dd>
            </div>
            <div>
              <dt>Fingerprint</dt>
              <dd title={profile.fingerprint}>{shortHash(profile.fingerprint)}</dd>
            </div>
            <div>
              <dt>Fallbacks</dt>
              <dd>{profile.fallbackCount === 0 ? "Frozen off" : `${profile.fallbackCount} allowed`}</dd>
            </div>
            <div>
              <dt>Memory scope</dt>
              <dd>
                {profile.memory.mode} · {profile.memory.retrievalMode}
              </dd>
            </div>
          </dl>
          <CapabilitySelectionLists
            tools={profile.selectedTools.map((tool) => ({
              label: `${tool.canonicalName} → ${tool.modelName}`,
              detail: tool.requiresApproval ? "approval required" : "policy-ready",
            }))}
            skills={profile.trustedSkills.map((skill) => ({
              label: skill.skillId,
              detail: skill.trustLabel ?? "trust label pending",
            }))}
          />
          <div className="mc-next-capability-profile-readiness" aria-label="Proposed auth readiness">
            {profile.authReadiness.map((item) => (
              <StatusChip key={`${item.kind}:${item.ref}`} tone={readinessTone(item.status)}>
                {item.kind} · {item.status}
              </StatusChip>
            ))}
          </div>
          {profile.blockedReasons.length > 0 ? (
            <ul className="mc-next-capability-profile-alerts" aria-label="Capability profile blockers">
              {profile.blockedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </section>
  );
}

export function ChatCapabilityProfileRunDetail({ inspection }: { inspection?: ChatCapabilityProfileInspection }) {
  if (!inspection || inspection.status === "idle") {
    return null;
  }
  if (inspection.status !== "verified" || !inspection.profile) {
    const tone = inspection.status === "legacy_missing" || inspection.status === "not_found" ? "muted" : "warning";
    return (
      <section
        className="mc-next-context-card mc-next-capability-profile mc-next-capability-profile-run-detail"
        aria-label="Persisted capability profile"
        data-integrity-status={inspection.status}
      >
        <div className="mc-next-capability-profile-head">
          <div>
            <p className="mc-next-panel-kicker">Capability profile</p>
            <h4>Immutable turn boundary</h4>
          </div>
          <StatusChip tone={inspection.status === "loading" ? "muted" : tone}>
            {inspection.status === "loading" ? "Loading" : formatLabel(inspection.status)}
          </StatusChip>
        </div>
        <p role={inspection.status === "invalid" || inspection.status === "forbidden" ? "alert" : "status"}>
          {inspection.status === "loading" ? "Checking the scoped persisted profile…" : inspection.message}
        </p>
        {inspection.mismatchFields.length > 0 ? (
          <p className="mc-next-capability-profile-warning">
            Mismatch: {inspection.mismatchFields.join(", ")}. Profile detail remains hidden.
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <VerifiedCapabilityProfile
      profile={inspection.profile}
      routedContext={inspection.routedContext}
      message={inspection.message}
    />
  );
}

function VerifiedCapabilityProfile({
  profile,
  routedContext,
  message,
}: {
  profile: ChatTurnCapabilityProfileRecord;
  routedContext?: ChatRoutedContextInspection;
  message?: string;
}) {
  const [profileDetailsOpen, setProfileDetailsOpen] = useState(false);
  const profileDetailsId = useId();
  const blockedDecisions = profile.governance.policyDecisions.filter((decision) => !decision.allowed);
  const approvalDecisions = profile.governance.policyDecisions.filter((decision) => decision.requiresApproval);
  return (
    <section
      className="mc-next-context-card mc-next-capability-profile mc-next-capability-profile-run-detail"
      aria-label="Persisted capability profile"
      data-integrity-status="verified"
      data-profile-id={profile.profileId}
    >
      <div className="mc-next-capability-profile-head">
        <div>
          <p className="mc-next-panel-kicker">Capability profile</p>
          <h4>Immutable turn boundary</h4>
        </div>
        <StatusChip tone="success">Exact profile match</StatusChip>
      </div>
      <p>{message}</p>
      <div className="mc-next-capability-profile-hash">
        <span>Profile hash</span>
        <code>{profile.hashes.profileHash}</code>
      </div>
      <div className="mc-next-capability-profile-chip-row">
        <StatusChip tone="success">
          {formatRoute(profile.selection.effectiveProviderId, profile.selection.effectiveModel)}
        </StatusChip>
        <StatusChip tone="muted">{profile.selection.tools.length} tools</StatusChip>
        <StatusChip tone="muted">{profile.selection.trustedSkills.length} skills</StatusChip>
        <StatusChip tone={profile.selection.allowedFallbacks.length === 0 ? "success" : "warning"}>
          {profile.selection.allowedFallbacks.length === 0
            ? "Fallback frozen off"
            : `${profile.selection.allowedFallbacks.length} fallbacks`}
        </StatusChip>
      </div>
      {profile.selection.workPassport ? <WorkPassportPanel passport={profile.selection.workPassport} /> : null}
      {profile.selection.workspaceSnapshot ? (
        <WorkspaceSnapshotReceipt snapshot={profile.selection.workspaceSnapshot} />
      ) : null}
      {routedContext ? <RoutedContextReceipt routedContext={routedContext} /> : null}
      <details
        className="mc-next-capability-profile-disclosure"
        open={profileDetailsOpen}
        onToggle={(event) => setProfileDetailsOpen(event.currentTarget.open)}
      >
        <summary aria-expanded={profileDetailsOpen} aria-controls={profileDetailsId}>
          Inspect frozen selections and governance
        </summary>
        <div id={profileDetailsId} className="mc-next-capability-profile-detail">
          <dl className="mc-next-capability-profile-facts">
            <div>
              <dt>Profile</dt>
              <dd>{profile.profileId}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{profile.createdAt}</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{profile.selection.mode}</dd>
            </div>
            <div>
              <dt>Web</dt>
              <dd>{profile.selection.webMode}</dd>
            </div>
            <div>
              <dt>Memory</dt>
              <dd>
                {profile.selection.memory.mode} · {profile.selection.memory.retrievalMode}
              </dd>
            </div>
            <div>
              <dt>Thinking</dt>
              <dd>
                {profile.selection.thinkingLevel} · {profile.selection.speedMode}
              </dd>
            </div>
            <div>
              <dt>Subagents</dt>
              <dd>{formatLabel(profile.selection.subagentPolicy)}</dd>
            </div>
            <div>
              <dt>Tool autonomy</dt>
              <dd>{formatLabel(profile.selection.toolAutonomy)}</dd>
            </div>
          </dl>
          <CapabilitySelectionLists
            tools={profile.selection.tools.map((tool) => ({
              label: `${tool.canonicalName} → ${tool.modelName}`,
              detail: `definition ${shortHash(tool.definitionHash)}`,
            }))}
            skills={profile.selection.trustedSkills.map((skill) => ({
              label: skill.skillId,
              detail:
                [
                  skill.trustLabel,
                  skill.commitSha ? `commit ${shortHash(skill.commitSha)}` : undefined,
                  skill.treeSha256 ? `tree ${shortHash(skill.treeSha256)}` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ") || "provenance pending",
            }))}
          />
          <section className="mc-next-capability-profile-subsection" aria-label="Frozen policy posture">
            <h5>Policy and approvals</h5>
            <div className="mc-next-capability-profile-chip-row">
              <StatusChip tone="muted">{profile.governance.permission.profileId}</StatusChip>
              <StatusChip tone={approvalDecisions.length > 0 ? "warning" : "success"}>
                {formatLabel(profile.governance.approval.mode)}
              </StatusChip>
              <StatusChip tone={blockedDecisions.length > 0 ? "warning" : "success"}>
                {blockedDecisions.length} policy-blocked
              </StatusChip>
              <StatusChip tone="muted">{profile.governance.activeGrants.length} active grants</StatusChip>
            </div>
            {profile.governance.policyDecisions.length > 0 ? (
              <ul className="mc-next-capability-profile-list">
                {profile.governance.policyDecisions.map((decision) => (
                  <li key={decision.toolName}>
                    <strong>{decision.toolName}</strong>
                    <span>
                      {decision.allowed ? "allowed" : "blocked"}
                      {decision.requiresApproval ? " · approval required" : ""}
                      {decision.reasonCodes.length > 0 ? ` · ${decision.reasonCodes.join(", ")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No selected-tool policy decisions were recorded.</p>
            )}
          </section>
          <section className="mc-next-capability-profile-subsection" aria-label="Frozen auth readiness">
            <h5>Auth and runtime readiness</h5>
            <div className="mc-next-capability-profile-readiness">
              {profile.governance.authReadiness.map((item) => (
                <StatusChip key={`${item.kind}:${item.ref}`} tone={readinessTone(item.status)}>
                  {item.kind} · {item.ref} · {item.status}
                </StatusChip>
              ))}
            </div>
          </section>
        </div>
      </details>
    </section>
  );
}

function WorkspaceSnapshotReceipt({ snapshot }: { snapshot: ChatWorkspaceSnapshotRecord }) {
  const captured = snapshot.status === "captured" && Boolean(snapshot.git && snapshot.project);
  return (
    <section
      className="mc-next-capability-profile-subsection"
      aria-label="Workspace snapshot"
      data-workspace-snapshot-status={snapshot.status}
    >
      <div className="mc-next-capability-profile-head">
        <div>
          <p className="mc-next-panel-kicker">Workspace snapshot</p>
          <h5>Point-in-time context</h5>
        </div>
        <StatusChip tone={captured ? "success" : "warning"}>{captured ? "Captured" : "Unavailable"}</StatusChip>
      </div>
      {captured ? (
        <dl className="mc-next-capability-profile-facts">
          <div>
            <dt>Project</dt>
            <dd>
              {snapshot.project!.projectId} · revision {snapshot.project!.projectRevision}
            </dd>
          </div>
          <div>
            <dt>Git HEAD</dt>
            <dd title={snapshot.git!.headSha}>{shortHash(snapshot.git!.headSha)}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd>{snapshot.git!.branch ?? "detached or unavailable"}</dd>
          </div>
          <div>
            <dt>Tracked changes</dt>
            <dd>{snapshot.git!.trackedChangeCount}</dd>
          </div>
          <div>
            <dt>Untracked changes</dt>
            <dd>{snapshot.git!.untrackedChangeCount}</dd>
          </div>
          <div>
            <dt>Captured</dt>
            <dd>{snapshot.capturedAt}</dd>
          </div>
        </dl>
      ) : (
        <p role="status">
          Snapshot unavailable ({formatLabel(snapshot.reasonCode ?? "unknown")}). Repository health was not inferred.
        </p>
      )}
      <p>
        This immutable receipt describes one turn only. It contains no file content, grants no folder authority, and a
        refresh applies only to a new turn.
      </p>
    </section>
  );
}

function WorkPassportPanel({
  passport,
  workspaceId,
  onBaselineUpdated,
}: {
  passport: WorkPassportRecord;
  workspaceId?: string;
  onBaselineUpdated?: () => Promise<void>;
}) {
  const [baseline, setBaseline] = useState<WorkPassportBaseline>(passport.baseline);
  const [roleLabel, setRoleLabel] = useState(passport.baseline.roleLabel ?? "");
  const [domains, setDomains] = useState<WorkPassportDomain[]>(passport.baseline.primaryDomains);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceDetailsId = useId();

  useEffect(() => {
    setBaseline(passport.baseline);
    setRoleLabel(passport.baseline.roleLabel ?? "");
    setDomains(passport.baseline.primaryDomains);
  }, [passport.baseline]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void fetchWorkPassportBaseline(workspaceId)
      .then((response) => {
        if (cancelled) return;
        setBaseline(response.baseline);
        setRoleLabel(response.baseline.roleLabel ?? "");
        setDomains(response.baseline.primaryDomains);
      })
      .catch(() => {
        if (!cancelled) setMessage("Could not refresh the workspace baseline.");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const saveBaseline = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setMessage(null);
    let saved = false;
    try {
      const response = await updateWorkPassportBaseline({
        workspaceId,
        roleLabel: roleLabel.trim() || undefined,
        primaryDomains: domains,
      });
      setBaseline(response.baseline);
      saved = true;
      await onBaselineUpdated?.();
      setMessage("Baseline saved. The turn profile was refreshed.");
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setMessage(saved ? `Baseline saved, but the turn profile refresh failed: ${detail}` : detail);
    } finally {
      setBusy(false);
    }
  };

  const toggleDomain = (domain: WorkPassportDomain) => {
    setDomains((current) =>
      current.includes(domain) ? current.filter((item) => item !== domain) : [...current, domain].slice(0, 8),
    );
  };

  return (
    <section className="mc-next-work-passport" aria-label="Work Passport">
      <div className="mc-next-work-passport-summary">
        <div>
          <p className="mc-next-panel-kicker">Work Passport</p>
          <strong>{formatLabel(passport.boundary)}</strong>
          <span>
            {passport.taskSignals.length > 0
              ? passport.taskSignals.map((signal) => formatLabel(signal.domain)).join(" · ")
              : "Task domain is unclear"}
          </span>
        </div>
        <div className="mc-next-capability-profile-chip-row">
          <StatusChip
            tone={
              passport.consequence === "high" ? "critical" : passport.consequence === "moderate" ? "warning" : "muted"
            }
          >
            {passport.consequence} consequence
          </StatusChip>
          <StatusChip tone={passport.review.posture === "self_check" ? "success" : "warning"}>
            {formatLabel(passport.review.posture)}
          </StatusChip>
        </div>
      </div>
      <p>{passport.review.reason}</p>
      <details
        className="mc-next-capability-profile-disclosure mc-next-work-passport-disclosure"
        open={evidenceOpen}
        onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}
      >
        <summary aria-expanded={evidenceOpen} aria-controls={evidenceDetailsId}>
          Review evidence and correct baseline
        </summary>
        <div id={evidenceDetailsId} className="mc-next-work-passport-detail">
          <section aria-label="Work Passport evidence requirements">
            <h5>Before relying on this work</h5>
            <ul>
              {passport.evidenceRequirements.map((requirement) => (
                <li key={requirement}>{requirement}</li>
              ))}
            </ul>
          </section>
          <section aria-label="Work Passport baseline">
            <h5>Operator-defined baseline</h5>
            <p>
              {baseline.configured
                ? `${baseline.roleLabel ?? "Workspace role"} · ${baseline.primaryDomains.map(formatLabel).join(", ") || "no primary domains"}`
                : `${baseline.roleLabel ? `${baseline.roleLabel} · ` : ""}Choose at least one primary domain. Until then, GoatCitadel will not claim a boundary crossing.`}
            </p>
            {workspaceId ? (
              <div className="mc-next-work-passport-editor">
                <label>
                  Role label
                  <input
                    type="text"
                    value={roleLabel}
                    maxLength={120}
                    placeholder="e.g. Product engineer"
                    onChange={(event) => setRoleLabel(event.currentTarget.value)}
                  />
                </label>
                <fieldset>
                  <legend>Primary work domains</legend>
                  <div className="mc-next-work-passport-domain-grid">
                    {WORK_PASSPORT_DOMAINS.map((domain) => (
                      <label key={domain}>
                        <input
                          type="checkbox"
                          checked={domains.includes(domain)}
                          onChange={() => toggleDomain(domain)}
                        />
                        {formatLabel(domain)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="mc-next-work-passport-actions">
                  <button
                    type="button"
                    className="mc-next-composer-inline-button"
                    disabled={busy}
                    onClick={() => void saveBaseline()}
                  >
                    {busy ? "Saving…" : "Save baseline"}
                  </button>
                  <span aria-live="polite">{message}</span>
                </div>
              </div>
            ) : null}
          </section>
          <p className="mc-next-work-passport-limitation">{passport.limitations.join(" ")}</p>
        </div>
      </details>
    </section>
  );
}

function RoutedContextReceipt({ routedContext }: { routedContext: ChatRoutedContextInspection }) {
  return (
    <section className="mc-next-capability-profile-subsection" aria-label="Routed context receipt">
      <h5>Routed context</h5>
      <div className="mc-next-capability-profile-chip-row">
        <StatusChip tone="success">{routedContext.includedCount} included</StatusChip>
        <StatusChip tone={routedContext.truncatedCount > 0 ? "warning" : "muted"}>
          {routedContext.truncatedCount} truncated
        </StatusChip>
        <StatusChip tone="muted">{routedContext.omittedCount} omitted</StatusChip>
        <StatusChip tone="muted">{routedContext.alreadyAttachedCount} already attached</StatusChip>
      </div>
      <dl className="mc-next-capability-profile-facts">
        <div>
          <dt>Snapshot</dt>
          <dd>{shortHash(routedContext.snapshotHash)}</dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd>{shortHash(routedContext.sourceRequestHash)}</dd>
        </div>
        <div>
          <dt>Content</dt>
          <dd>{shortHash(routedContext.contentHash)}</dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd>
            {routedContext.budget.usedTokens} / {routedContext.budget.effectiveBudgetTokens} tokens
          </dd>
        </div>
      </dl>
      <ul className="mc-next-capability-profile-list">
        {routedContext.entries.map((entry) => (
          <li key={`${entry.index}:${entry.kind}:${entry.sourceHash}`}>
            <strong>
              Source {entry.index + 1} · {formatLabel(entry.kind)}
            </strong>
            <span>
              {formatLabel(entry.disposition)} · {entry.admittedTokens} tokens · {entry.admittedBytes} bytes · source{" "}
              {shortHash(entry.sourceHash)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CapabilitySelectionLists({
  tools,
  skills,
}: {
  tools: Array<{ label: string; detail: string }>;
  skills: Array<{ label: string; detail: string }>;
}) {
  return (
    <div className="mc-next-capability-profile-columns">
      <section className="mc-next-capability-profile-subsection" aria-label="Selected tools">
        <h5>Selected tools</h5>
        {tools.length > 0 ? (
          <ul className="mc-next-capability-profile-list">
            {tools.map((tool) => (
              <li key={tool.label}>
                <strong>{tool.label}</strong>
                <span>{tool.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No callable tools selected.</p>
        )}
      </section>
      <section className="mc-next-capability-profile-subsection" aria-label="Trusted skills">
        <h5>Trusted skills</h5>
        {skills.length > 0 ? (
          <ul className="mc-next-capability-profile-list">
            {skills.map((skill) => (
              <li key={skill.label}>
                <strong>{skill.label}</strong>
                <span>{skill.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No runtime skills selected.</p>
        )}
      </section>
    </div>
  );
}
