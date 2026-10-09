import { Bot, RefreshCw, ShieldOff } from "lucide-react";
import type { ChatProjectRecord } from "@goatcitadel/contracts";
import { NativeButton, NoticeBanner } from "../primitives";
import { defaultExpiryValue, formatGrantStatus, useProjectFanout } from "./use-project-fanout";

interface ProjectAutomaticFanoutCardProps { project: ChatProjectRecord; workspaceId: string; citadelId?: string; }
/** Classic presentation of the same guarded project fan-out owner used by Cockpit. */
export function ProjectAutomaticFanoutCard({ project, workspaceId, citadelId }: ProjectAutomaticFanoutCardProps) {
  const { grants, loading, busy, message, error, draft, setDraft, load, activeGrant, canCreate, createGrant, revoke, review, confirm, cancel } = useProjectFanout(project, workspaceId, citadelId);
  return (
    <section className="mc-next-project-control-section" aria-label="Automatic fan-out">
      <div className="mc-next-project-control-heading">
        <Bot size={16} />
        <strong>Automatic fan-out</strong>
      </div>
      <p className="mc-next-settings-field-note">
        Auto when useful is available only with this project’s active, expiring operator grant. A launch reserves every
        requested child slot and its cost ceiling before any child starts. Policy, approvals, paths, and budgets still
        win.
      </p>
      {project.lifecycleStatus !== "active" ? (
        <NoticeBanner
          tone="warning"
          message="Project archived: archived projects cannot authorize automatic fan-out."
        />
      ) : null}
      {error ? <NoticeBanner tone="error" message={error} /> : null}
      {message ? <NoticeBanner tone="success" message={message} /> : null}
      <div className="mc-next-settings-button-row">
        <NativeButton variant="secondary" disabled={loading || busy} onClick={() => void load()}>
          <RefreshCw size={16} />
          Refresh
        </NativeButton>
      </div>
      {grants.length > 0 ? (
        <div className="mc-next-settings-action-list" aria-label="Automatic fan-out grant history">
          {grants.map((grant) => (
            <div key={grant.grantId} className="mc-next-settings-action-row">
              <div className="mc-next-settings-action-copy">
                <strong>{grant.status === "active" ? "Active project grant" : `Grant ${grant.status}`}</strong>
                <p>{formatGrantStatus(grant)}</p>
                <p>{grant.reason}</p>
              </div>
              {grant.status === "active" ? (
                <NativeButton variant="destructive" disabled={busy} onClick={() => void revoke(grant)}>
                  <ShieldOff size={16} />
                  Revoke now
                </NativeButton>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {review ? <section aria-label="Review automatic fan-out" className="mc-next-project-controls"><strong>Review automatic fan-out</strong><p>{project.name} · Workspace {workspaceId} · Project {project.projectId} · Revision {project.revision}</p><p>Chat only · agent.fanout · subagent_fanout · caution</p><p>{review.input.maxActivations} child activations · $ {review.input.budgetUsd} ceiling · expires {review.input.expiresAt}</p><p>{review.input.reason}</p><p>The Gateway stamps the authenticated caller. Deny-wins, approvals, tool, host, and path policy remain authoritative. Until revoked is unavailable: the Gateway requires finite expiry.</p><NativeButton onClick={cancel}>Cancel</NativeButton><NativeButton disabled={busy} onClick={() => void confirm()}>Confirm automatic fan-out</NativeButton></section> : null}
      {canCreate ? (
        <div className="mc-next-project-controls">
          <label className="mc-next-settings-field">
            <span>Expires</span>
            <input
              aria-label="Automatic fan-out grant expiry"
              className="mc-next-settings-input"
              type="datetime-local"
              value={draft.expiresAt}
              onChange={(event) => setDraft((current) => ({ ...current, expiresAt: event.target.value }))}
            />
          </label>
          <label className="mc-next-settings-field">
            <span>Grant lifetime preset</span>
            <select
              aria-label="Grant lifetime preset"
              value=""
              onChange={(event) => {
                if (event.target.value)
                  setDraft((current) => ({ ...current, expiresAt: defaultExpiryValue(Number(event.target.value)) }));
              }}
            >
              <option value="">Choose a lifetime</option>
              <option value="1">1 hour</option>
              <option value="24">1 day</option>
              <option value="168">7 days</option>
              <option disabled value="indefinite">
                Until revoked — unavailable: Gateway requires expiry
              </option>
            </select>
          </label>
          <label className="mc-next-settings-field">
            <span>Maximum child activations</span>
            <input
              aria-label="Automatic fan-out child activation limit"
              className="mc-next-settings-input"
              type="number"
              min="1"
              step="1"
              value={draft.maxActivations}
              onChange={(event) => setDraft((current) => ({ ...current, maxActivations: event.target.value }))}
            />
          </label>
          <label className="mc-next-settings-field">
            <span>Budget ceiling (USD)</span>
            <input
              aria-label="Automatic fan-out budget ceiling"
              className="mc-next-settings-input"
              type="number"
              min="0.25"
              step="0.01"
              value={draft.budgetUsd}
              onChange={(event) => setDraft((current) => ({ ...current, budgetUsd: event.target.value }))}
            />
          </label>
          <label className="mc-next-settings-field">
            <span>Reason</span>
            <textarea
              aria-label="Automatic fan-out grant reason"
              className="mc-next-settings-textarea"
              value={draft.reason}
              onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))}
            />
          </label>
          <NativeButton disabled={busy || loading} onClick={() => void createGrant()}>
            <Bot size={16} />
            {busy ? "Saving..." : "Enable temporary automatic fan-out"}
          </NativeButton>
        </div>
      ) : activeGrant ? (
        <p className="mc-next-settings-field-note">
          Revoke the active grant before issuing a replacement. This prevents overlapping project authority.
        </p>
      ) : null}
    </section>
  );
}
