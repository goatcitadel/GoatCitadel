import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, RefreshCw, ShieldOff } from "lucide-react";
import type { AutonomousActivationGrantRecord, ChatProjectRecord } from "@goatcitadel/contracts";
import {
  createAutonomousActivationGrant,
  fetchAutonomousActivationGrants,
  revokeAutonomousActivationGrant,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeButton, NoticeBanner } from "../primitives";

interface ProjectAutomaticFanoutCardProps {
  project: ChatProjectRecord;
  workspaceId: string;
}

function defaultExpiryValue(): string {
  const future = new Date(Date.now() + 60 * 60_000);
  future.setMinutes(future.getMinutes() - future.getTimezoneOffset());
  return future.toISOString().slice(0, 16);
}

function formatGrantStatus(grant: AutonomousActivationGrantRecord): string {
  const activationUsage = `${grant.usedActivations}/${grant.maxActivations ?? "unlimited"} child activations used`;
  const budgetUsage =
    grant.budgetUsd === undefined
      ? "no budget ceiling"
      : `$${(grant.usedBudgetUsd ?? 0).toFixed(2)}/$${grant.budgetUsd.toFixed(2)} reserved`;
  return `${grant.status} · ${activationUsage} · ${budgetUsage} · expires ${new Date(grant.expiresAt).toLocaleString()}`;
}

/**
 * The project is the only UI that can create `subagent_fanout` authority.
 * The operator-gated Gateway still validates the exact active project and
 * stamps the authenticated operator identity; this card only collects the
 * deliberately narrow temporary limits.
 */
export function ProjectAutomaticFanoutCard({ project, workspaceId }: ProjectAutomaticFanoutCardProps) {
  const [grants, setGrants] = useState<AutonomousActivationGrantRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    expiresAt: defaultExpiryValue(),
    maxActivations: "3",
    budgetUsd: "0.75",
    reason: "Temporary automatic fan-out for this project.",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchAutonomousActivationGrants(true);
      setGrants(
        (response.items ?? []).filter(
          (grant) =>
            grant.workspaceId === workspaceId &&
            grant.projectId === project.projectId &&
            grant.activationKinds.includes("subagent_fanout"),
        ),
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load automatic fan-out grants.");
    } finally {
      setLoading(false);
    }
  }, [project.projectId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeGrant = useMemo(() => grants.find((grant) => grant.status === "active"), [grants]);
  const canCreate = project.lifecycleStatus === "active" && !activeGrant;

  const createGrant = async () => {
    const expiresAt = new Date(draft.expiresAt).toISOString();
    const maxActivations = Number(draft.maxActivations);
    const budgetUsd = Number(draft.budgetUsd);
    if (!Number.isInteger(maxActivations) || maxActivations < 1) {
      setError("Maximum child activations must be a positive whole number.");
      return;
    }
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0.25) {
      setError("Budget ceiling must be at least $0.25 so one child can be reserved before dispatch.");
      return;
    }
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      setError("Choose a future expiry for this temporary project grant.");
      return;
    }
    if (!draft.reason.trim()) {
      setError("A reason is required for temporary project authority.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await createAutonomousActivationGrant({
        workspaceId,
        projectId: project.projectId,
        surfaces: ["chat"],
        maxRiskLevel: "caution",
        capabilityPatterns: ["agent.fanout"],
        toolPatterns: ["agent.fanout"],
        activationKinds: ["subagent_fanout"],
        maxActivations,
        budgetUsd,
        // The Gateway replaces this with the authenticated operator identity.
        grantor: "operator",
        reason: draft.reason.trim(),
        expiresAt,
      });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("goatcitadel:autonomous-activation-grants-changed"));
      }
      setMessage("Automatic fan-out is now available only for this active project until the recorded expiry.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the project grant.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grant: AutonomousActivationGrantRecord) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await revokeAutonomousActivationGrant(grant.grantId, {
        revokedBy: "operator",
        reason: "Revoked from the project automatic fan-out control.",
      });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("goatcitadel:autonomous-activation-grants-changed"));
      }
      setMessage("Grant revoked. Active fan-out aggregates were asked to stop durably.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke the project grant.");
    } finally {
      setBusy(false);
    }
  };

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
