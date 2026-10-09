import { useCallback, useEffect, useRef, useState } from "react";
import type { AutonomousActivationGrantRecord, ChatProjectRecord } from "@goatcitadel/contracts";
import {
  createAutonomousActivationGrant,
  fetchAutonomousActivationGrants,
  fetchChatProjects,
  revokeAutonomousActivationGrant,
} from "@goatcitadel/mission-control-shared/api/client";
import { useProjectAccess } from "./use-project-access";

export function defaultExpiryValue(hours = 1): string {
  const future = new Date(Date.now() + hours * 60 * 60_000);
  future.setMinutes(future.getMinutes() - future.getTimezoneOffset());
  return future.toISOString().slice(0, 16);
}
export function formatGrantStatus(grant: AutonomousActivationGrantRecord): string {
  return `${grant.status} · ${grant.usedActivations}/${grant.maxActivations ?? "unlimited"} child activations used · ${grant.budgetUsd === undefined ? "no budget ceiling" : `$${(grant.usedBudgetUsd ?? 0).toFixed(2)}/$${grant.budgetUsd.toFixed(2)} reserved`} · expires ${new Date(grant.expiresAt).toLocaleString()}`;
}
export function useProjectFanout(project: ChatProjectRecord, workspaceId: string, citadelId?: string) {
  const access = useProjectAccess(JSON.stringify([citadelId, workspaceId, project]));
  const { current: isCurrent } = access;
  const [grants, setGrants] = useState<AutonomousActivationGrantRecord[]>([]);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    expiresAt: defaultExpiryValue(),
    maxActivations: "3",
    budgetUsd: "0.75",
    reason: "Temporary automatic fan-out for this project.",
  });
  const [review, setReview] = useState<{
    input: Parameters<typeof createAutonomousActivationGrant>[0];
    token: object;
  } | null>(null);
  const pending = useRef(false),
    reads = useRef(0);
  const scoped = useCallback(
    (items: AutonomousActivationGrantRecord[]) =>
      items.filter(
        (grant) =>
          grant.workspaceId === workspaceId &&
          grant.projectId === project.projectId &&
          grant.activationKinds.includes("subagent_fanout"),
      ),
    [workspaceId, project.projectId],
  );
  const load = useCallback(async () => {
    const read = ++reads.current;
    setLoading(true);
    try {
      const response = await fetchAutonomousActivationGrants(true);
      if (isCurrent() && read === reads.current) {
        setGrants(scoped(response.items ?? []));
        setError(null);
      }
    } catch (cause) {
      if (isCurrent() && read === reads.current)
        setError(cause instanceof Error ? cause.message : "Unable to load automatic fan-out grants.");
    } finally {
      if (isCurrent() && read === reads.current) setLoading(false);
    }
  }, [isCurrent, scoped]);
  useEffect(() => {
    setGrants([]);
    setReview(null);
    setMessage(null);
    setBusy(false);
    pending.current = false;
    void load();
  }, [access.identity, load]); // Each scope owns its completions.
  const activeGrant = grants.find((grant) => grant.status === "active");
  const canCreate = project.lifecycleStatus === "active" && project.workspaceId === workspaceId && !activeGrant;
  function createGrant() {
    if (!isCurrent() || loading || pending.current || !canCreate) return;
    const expiry = Date.parse(draft.expiresAt),
      maxActivations = Number(draft.maxActivations),
      budgetUsd = Number(draft.budgetUsd);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      setError("Choose a future expiry for this temporary project grant.");
      return;
    }
    if (!Number.isInteger(maxActivations) || maxActivations < 1) {
      setError("Maximum child activations must be a positive whole number.");
      return;
    }
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0.25) {
      setError("Budget ceiling must be at least $0.25 so one child can be reserved before dispatch.");
      return;
    }
    if (!draft.reason.trim()) {
      setError("A reason is required for temporary project authority.");
      return;
    }
    setError(null);
    setReview({
      token: access.token,
      input: {
        workspaceId,
        projectId: project.projectId,
        surfaces: ["chat"],
        maxRiskLevel: "caution",
        capabilityPatterns: ["agent.fanout"],
        toolPatterns: ["agent.fanout"],
        activationKinds: ["subagent_fanout"],
        maxActivations,
        budgetUsd,
        grantor: "operator",
        reason: draft.reason.trim(),
        expiresAt: new Date(expiry).toISOString(),
      },
    });
  }
  async function confirm() {
    if (!review || review.token !== access.token || !isCurrent() || pending.current || !canCreate) return;
    const captured = review;
    pending.current = true;
    setBusy(true);
    setReview(null);
    setError(null);
    setMessage(null);
    try {
      const [projects, currentGrants] = await Promise.all([
        fetchChatProjects("all", 300, workspaceId, citadelId, { signal: new AbortController().signal }),
        fetchAutonomousActivationGrants(true),
      ]);
      if (!isCurrent()) return;
      const fresh = projects.items.find(
        (item) => item.projectId === project.projectId && item.workspaceId === workspaceId,
      );
      if (!fresh || fresh.revision !== project.revision || fresh.lifecycleStatus !== "active")
        throw new Error("Project changed during review. Refresh the project before reviewing another grant.");
      if (scoped(currentGrants.items).some((grant) => grant.status === "active"))
        throw new Error("An active grant now exists. Refresh and review it before creating another.");
      if (Date.parse(captured.input.expiresAt) <= Date.now())
        throw new Error("Grant review expired. Choose a future expiry and review again.");
      const saved = await createAutonomousActivationGrant(captured.input);
      if (!isCurrent()) return;
      if (saved.projectId !== project.projectId || saved.workspaceId !== workspaceId)
        throw new Error("Grant response did not confirm this project. Refresh before retrying.");
      if (typeof window !== "undefined")
        window.dispatchEvent(new Event("goatcitadel:autonomous-activation-grants-changed"));
      setMessage("Automatic fan-out is now available only for this active project until the recorded expiry.");
      await load();
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : "Unable to create the project grant.");
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  async function revoke(grant: AutonomousActivationGrantRecord) {
    if (
      !isCurrent() ||
      pending.current ||
      !scoped(grants).some((item) => item.grantId === grant.grantId && item.status === "active")
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await revokeAutonomousActivationGrant(grant.grantId, {
        revokedBy: "operator",
        reason: "Revoked from the project automatic fan-out control.",
      });
      if (!isCurrent()) return;
      if (typeof window !== "undefined")
        window.dispatchEvent(new Event("goatcitadel:autonomous-activation-grants-changed"));
      setMessage("Grant revoked. Active fan-out aggregates were asked to stop durably.");
      await load();
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : "Unable to revoke the project grant.");
    } finally {
      if (isCurrent()) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return {
    grants,
    loading,
    busy,
    message,
    error,
    draft,
    setDraft,
    load,
    activeGrant,
    canCreate,
    createGrant,
    revoke,
    review,
    confirm,
    cancel: () => setReview(null),
  };
}
