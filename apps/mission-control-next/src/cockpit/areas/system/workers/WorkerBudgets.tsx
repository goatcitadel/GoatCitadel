import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { RemoteWorkerBudgetBalance, RemoteWorkerRegistryItem } from "@goatcitadel/contracts";
import {
  authorizeRemoteWorkerBudget,
  fetchRemoteWorkerBudgets,
  revokeRemoteWorkerBudget,
} from "@goatcitadel/mission-control-shared/api/remote-worker-budgets";
import { formatAbsoluteTime, formatMoney, plural } from "@goatcitadel/mission-control-shared/content/format";
import { useDraftLeave } from "../../../../features/native-routes/library/DraftLeaveDialog";
import { useSessionDraft } from "../../../../features/native-routes/library/session-drafts";
import { useWorkerBudgetAttempt } from "../../../../features/native-routes/ops/worker-budget-attempts";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { cockpitInputClass } from "../../../ui/input-class";
import { Section } from "../../../ui/Section";
import { TimeText } from "../../../ui/TimeText";
import { acknowledgementMatches, microusdToUsd, validateBudgetDraft, type BudgetDraft } from "./worker-budget-model";

const EMPTY: BudgetDraft = { requests: "", cost: "", minutes: "30" };
const money = (microusd: number) => formatMoney(microusdToUsd(microusd));

function grantState(balance: RemoteWorkerBudgetBalance): string {
  if (balance.grant.revokedAt) return "Revoked";
  return Date.parse(balance.grant.expiresAt) <= Date.now() ? "Expired" : "Authorized";
}

/**
 * A worker's spending budgets in this workspace. Authorizing reviews the exact limits first and keeps an unconfirmed
 * attempt (and its grant ID) across unmounts so a retry never creates a second grant; revoking asks first.
 */
export function WorkerBudgets({
  workspaceId,
  workspaceName,
  worker,
}: {
  workspaceId: string;
  workspaceName: string;
  worker: RemoteWorkerRegistryItem;
}) {
  const admission = worker.admission.value;
  const name = admission?.workerLabel ?? "This worker";
  const key = "worker:" + workspaceId + ":" + worker.workerId + ":budget";
  const [items, setItems] = useState<RemoteWorkerBudgetBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [revoking, setRevoking] = useState<RemoteWorkerBudgetBalance | null>(null);
  const leave = useDraftLeave();
  const draft = useSessionDraft(key, EMPTY, admission?.workerGeneration, { label: "Worker budget", active: editing });
  const [attempt, setAttempt, clearAttempt] = useWorkerBudgetAttempt(key);
  const review = attempt?.request ?? null;
  const busy = useRef(false);
  const scope = workspaceId + ":" + worker.workerId + ":" + admission?.workerGeneration;
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = worker.posture.value === "active" && Boolean(admission);
  const epoch = useRef({ sequence: 0 });

  const reload = useCallback(async () => {
    const sequence = ++epoch.current.sequence;
    try {
      const result = await fetchRemoteWorkerBudgets(workspaceId, workspaceId);
      if (sequence !== epoch.current.sequence) return;
      setItems(result.filter((item) => item.grant.workerId === worker.workerId));
      setError(null);
    } catch {
      if (sequence === epoch.current.sequence) {
        setItems(null);
        setError("Worker budgets are unavailable. Refresh to try again.");
      }
    }
  }, [workspaceId, worker.workerId]);
  useEffect(() => {
    const lifecycle = epoch.current;
    setItems(null);
    void reload();
    return () => {
      lifecycle.sequence++;
    };
  }, [reload]);

  // A dispatched attempt whose grant now appears in the list was saved: clear it and the draft it came from.
  const acceptSaved = draft.acceptSaved;
  useEffect(() => {
    if (!attempt?.dispatched || !items) return;
    const recorded = items.find((item) => item.grant.grantId === attempt.request.grantId)?.grant;
    if (!recorded || !acknowledgementMatches(attempt.request, recorded)) return;
    clearAttempt(attempt.request.grantId);
    setReviewOpen(false);
    if (attempt.request.workerGeneration === admission?.workerGeneration) {
      if (acceptSaved(EMPTY, attempt.request.workerGeneration, attempt.submitted)) setEditing(false);
    }
  }, [items, attempt, clearAttempt, admission?.workerGeneration, acceptSaved]);

  const prepare = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!admission || busy.current) return;
    if (attempt?.dispatched) return setReviewOpen(true);
    if (draft.hasRemoteChanges) return setError("This worker changed since your draft started.");
    const result = validateBudgetDraft(draft.value);
    if (!result.ok) return setError(result.message);
    setError(null);
    setAttempt({
      submitted: draft.value,
      dispatched: false,
      request: {
        grantId: crypto.randomUUID(),
        registryWorkspaceId: workspaceId,
        executionWorkspaceId: workspaceId,
        workerId: worker.workerId,
        workerGeneration: admission.workerGeneration,
        maxRequests: result.limits.maxRequests,
        maxCostMicrousd: result.limits.maxCostMicrousd,
        expiresAt: new Date(Date.now() + result.limits.minutes * 60_000).toISOString(),
      },
    });
    setReviewOpen(true);
  };

  const authorize = async () => {
    if (!attempt || !review || busy.current || !active || review.workerGeneration !== admission?.workerGeneration)
      return;
    busy.current = true;
    const submitted = attempt.submitted,
      requestScope = scope;
    setAttempt({ ...attempt, dispatched: true });
    setPending(true);
    try {
      const confirmed = await authorizeRemoteWorkerBudget(review);
      if (!acknowledgementMatches(review, confirmed))
        throw new Error("Grant acknowledgement did not match the reviewed request");
      clearAttempt(review.grantId);
      if (!mounted.current || liveScope.current !== requestScope) return;
      setReviewOpen(false);
      if (draft.acceptSaved(EMPTY, review.workerGeneration, submitted)) setEditing(false);
      await reload();
    } catch {
      if (mounted.current && liveScope.current === requestScope)
        setError("The budget could not be confirmed. Retry this same authorization or refresh its status.");
    } finally {
      busy.current = false;
      if (mounted.current && liveScope.current === requestScope) setPending(false);
    }
  };

  const revoke = async (item: RemoteWorkerBudgetBalance) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setRevoking(null);
    try {
      await revokeRemoteWorkerBudget(workspaceId, item.grant.grantId, item.grant.revision);
      await reload();
    } catch {
      setError("Revocation could not be confirmed. Refresh and check the budget before retrying.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const field = (label: string, input: React.ReactNode) => (
    <label className="block text-sm text-fg-secondary">
      {label}
      <span className="mt-1 block">{input}</span>
    </label>
  );
  const setField = (name: keyof BudgetDraft) => (value: string) =>
    draft.setValue((current) => ({ ...current, [name]: value }));

  return (
    <Section
      title="Spending budgets"
      description="Request and dollar limits for this worker in the current workspace. Memory calls and retries count toward the same limit; uncertain provider charges stay reserved."
      actions={
        <Button size="sm" disabled={pending} onClick={() => void reload()}>
          Refresh budgets
        </Button>
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      ) : null}
      {items === null ? (
        <p className="text-sm text-fg-muted">Budgets are loading or unavailable.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-fg-muted">No spending has been authorized for this worker.</p>
      ) : (
        <ul className="divide-y divide-line-subtle">
          {items.map((item) => (
            <li key={item.grant.grantId} className="py-2 text-sm text-fg-secondary">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-fg">{grantState(item)}</span>
                {!item.grant.revokedAt ? (
                  <Button size="sm" disabled={pending} onClick={() => setRevoking(item)}>
                    Revoke budget
                  </Button>
                ) : null}
              </div>
              <p>
                {plural(item.availableRequests, "request")} and {money(item.availableCostMicrousd)} left ·{" "}
                {plural(item.heldRequests, "request")} and {money(item.heldCostMicrousd)} reserved ·{" "}
                {plural(item.settledRequests, "request")} and {money(item.settledCostMicrousd)} spent
              </p>
              <p className="text-xs text-fg-muted">
                <TimeText value={item.grant.expiresAt} prefix="Expires" />
              </p>
            </li>
          ))}
        </ul>
      )}
      {attempt?.dispatched ? (
        <p role="status" className="mt-2 text-sm text-fg-secondary">
          Authorization outcome unconfirmed.{" "}
          <Button size="sm" onClick={() => setReviewOpen(true)}>
            Review pending authorization
          </Button>
        </p>
      ) : null}
      {!editing && !attempt?.dispatched ? (
        <Button className="mt-2" size="sm" onClick={() => setEditing(true)}>
          {draft.isDirty ? "New budget · unsaved" : "New budget"}
        </Button>
      ) : editing ? (
        <div className="mt-3 space-y-3">
          {draft.hasRemoteChanges ? (
            <p className="text-sm text-status-waiting">
              This worker changed since your draft started.{" "}
              <Button size="sm" onClick={draft.rebaseToCurrent}>
                Start from the current version
              </Button>
            </p>
          ) : null}
          {!active ? (
            <p className="text-sm text-fg-secondary">Only an active worker can be given a spending budget.</p>
          ) : null}
          <form onSubmit={prepare}>
            <fieldset
              disabled={!active || pending || Boolean(attempt?.dispatched)}
              className="grid gap-3 sm:grid-cols-3"
            >
              {field(
                "Provider request limit",
                <input
                  className={cockpitInputClass}
                  type="number"
                  min="2"
                  max="100000"
                  step="1"
                  required
                  value={draft.value.requests}
                  onChange={(event) => setField("requests")(event.target.value)}
                />,
              )}
              {field(
                "Dollar limit (USD)",
                <input
                  className={cockpitInputClass}
                  type="number"
                  min="0"
                  max="1000000"
                  step="0.01"
                  required
                  value={draft.value.cost}
                  onChange={(event) => setField("cost")(event.target.value)}
                />,
              )}
              {field(
                "Expires after",
                <select
                  className={cockpitInputClass}
                  value={draft.value.minutes}
                  onChange={(event) => setField("minutes")(event.target.value)}
                >
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="240">4 hours</option>
                  <option value="1440">24 hours</option>
                </select>,
              )}
              <div className="flex flex-wrap gap-2 sm:col-span-3">
                <Button type="submit" variant="primary" size="sm">
                  Review budget
                </Button>
                <Button size="sm" onClick={() => leave.request(() => setEditing(false), [draft.key])}>
                  Close budget editor
                </Button>
              </div>
            </fieldset>
          </form>
        </div>
      ) : null}
      {leave.dialog}
      <Dialog
        open={reviewOpen && review !== null}
        onOpenChange={(open) => {
          if (open || pending) return;
          setReviewOpen(false);
          if (!attempt?.dispatched) setAttempt(null);
        }}
        title="Authorize worker spending"
        description="This permits provider requests within these limits. Run policy and task approvals still apply."
      >
        {review ? (
          <p className="text-sm text-fg-secondary">
            {name} (version {review.workerGeneration}) may make up to{" "}
            <strong className="text-fg">{plural(review.maxRequests, "provider request")}</strong> and spend up to{" "}
            <strong className="text-fg">{money(review.maxCostMicrousd)}</strong> in {workspaceName} until{" "}
            {formatAbsoluteTime(review.expiresAt)}.
          </p>
        ) : null}
        {review && review.workerGeneration !== admission?.workerGeneration ? (
          <p className="mt-2 text-sm text-status-waiting">
            This authorization was for an earlier version of the worker. Its outcome is unconfirmed; refresh budgets to
            check it. It cannot be retried for the current version.
          </p>
        ) : null}
        {error ? <p className="mt-2 text-sm text-status-failed">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button disabled={pending} onClick={() => setReviewOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} loadingLabel="Authorizing…" onClick={() => void authorize()}>
            Authorize budget
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => (open ? undefined : setRevoking(null))}
        title="Revoke this budget?"
      >
        {revoking ? (
          <p className="text-sm text-fg-secondary">
            {name} loses {plural(revoking.availableRequests, "remaining request")} and{" "}
            {money(revoking.availableCostMicrousd)} of remaining spend in {workspaceName}. Reserved charges stay
            reserved. This cannot be undone here; a new budget needs a new authorization.
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setRevoking(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => revoking && void revoke(revoking)}>
            Revoke budget
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}
