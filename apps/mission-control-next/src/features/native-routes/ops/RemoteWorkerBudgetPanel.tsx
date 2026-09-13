import { useWorkerBudgetAttempt } from "./worker-budget-attempts";
import { useSessionDraft } from "../library/session-drafts";
import { useDraftLeave } from "../library/DraftLeaveDialog";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { RemoteWorkerBudgetBalance, RemoteWorkerRegistryItem } from "@goatcitadel/contracts";
import {
  authorizeRemoteWorkerBudget,
  fetchRemoteWorkerBudgets,
  revokeRemoteWorkerBudget,
} from "@goatcitadel/mission-control-shared/api/remote-worker-budgets";
import { GCModal } from "@goatcitadel/mission-control-shared/components/ui/GCModal";
import { NativeButton } from "../primitives";
import "./remote-worker-budgets.css";

const dollars = (microusd: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(
    microusd / 1_000_000,
  );

export function RemoteWorkerBudgetPanel({
  workspaceId,
  worker,
}: {
  workspaceId: string;
  worker: RemoteWorkerRegistryItem;
}) {
  const [items, setItems] = useState<RemoteWorkerBudgetBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const leave = useDraftLeave();
  const draft = useSessionDraft(
    "worker:" + workspaceId + ":" + worker.workerId + ":budget",
    { requests: "", cost: "", minutes: "30" },
    worker.admission.value?.workerGeneration,
    { label: "Worker budget", active: editing },
  );
  const { requests, cost, minutes } = draft.value;
  const setRequests = (requests: string) => draft.setValue((value) => ({ ...value, requests }));
  const setCost = (cost: string) => draft.setValue((value) => ({ ...value, cost }));
  const setMinutes = (minutes: string) => draft.setValue((value) => ({ ...value, minutes }));
  const mutationBusy = useRef(false);
  const [attempt, setAttempt, clearAttempt] = useWorkerBudgetAttempt(
    "worker:" + workspaceId + ":" + worker.workerId + ":budget",
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const review = attempt?.request ?? null;
  const scope = workspaceId + ":" + worker.workerId + ":" + worker.admission.value?.workerGeneration;
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const epoch = useRef({ sequence: 0 });
  const admission = worker.admission.value;
  const active = worker.posture.value === "active" && Boolean(admission);
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

  const acceptBudgetSaved = draft.acceptSaved;
  useEffect(() => {
    if (!attempt?.dispatched || !items) return;
    const recorded = items.find((item) => item.grant.grantId === attempt.request.grantId)?.grant;
    if (
      !recorded ||
      Object.entries(attempt.request).some(([key, value]) => recorded[key as keyof typeof recorded] !== value)
    )
      return;
    clearAttempt(attempt.request.grantId);
    setReviewOpen(false);
    if (attempt.request.workerGeneration === admission?.workerGeneration) {
      const cleared = acceptBudgetSaved(
        { requests: "", cost: "", minutes: "30" },
        attempt.request.workerGeneration,
        attempt.submitted,
      );
      if (cleared) setEditing(false);
    }
  }, [items, attempt, clearAttempt, admission?.workerGeneration, acceptBudgetSaved]);

  const prepare = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!admission || mutationBusy.current) return;
    if (attempt?.dispatched) {
      setReviewOpen(true);
      return;
    }
    if (draft.hasRemoteChanges) {
      setError("The worker generation changed. Review the current generation before authorizing this retained input.");
      return;
    }
    const maxRequests = Number(requests),
      maxCostMicrousd = Math.round(Number(cost) * 1_000_000);
    if (
      !requests ||
      !cost ||
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 2 ||
      !Number.isSafeInteger(maxCostMicrousd) ||
      maxCostMicrousd < 0
    ) {
      setError("Enter a request limit of at least 2 and a dollar limit.");
      return;
    }
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
        maxRequests,
        maxCostMicrousd,
        expiresAt: new Date(Date.now() + Number(minutes) * 60_000).toISOString(),
      },
    });
    setReviewOpen(true);
  };

  const authorize = async () => {
    if (
      !attempt ||
      !review ||
      mutationBusy.current ||
      !active ||
      review.workerGeneration !== admission?.workerGeneration
    )
      return;
    mutationBusy.current = true;
    const submitted = attempt.submitted;
    const requestScope = scope;
    setAttempt({ ...attempt, dispatched: true });
    setPending(true);
    try {
      const confirmed = await authorizeRemoteWorkerBudget(review);
      if (
        !confirmed ||
        !Number.isSafeInteger(confirmed.revision) ||
        confirmed.revision < 1 ||
        Object.entries(review).some(([key, value]) => confirmed[key as keyof typeof confirmed] !== value)
      )
        throw new Error("Grant acknowledgement did not match the reviewed request");
      clearAttempt(review.grantId);
      if (!mounted.current || liveScope.current !== requestScope) return;
      setReviewOpen(false);
      const cleared = draft.acceptSaved({ requests: "", cost: "", minutes: "30" }, review.workerGeneration, submitted);
      if (cleared) setEditing(false);
      await reload();
    } catch {
      if (mounted.current && liveScope.current === requestScope)
        setError("The budget could not be confirmed. Retry this same authorization or refresh its status.");
    } finally {
      mutationBusy.current = false;
      if (mounted.current && liveScope.current === requestScope) setPending(false);
    }
  };
  const revoke = async (item: RemoteWorkerBudgetBalance) => {
    if (mutationBusy.current) return;
    mutationBusy.current = true;
    setPending(true);
    try {
      await revokeRemoteWorkerBudget(workspaceId, item.grant.grantId, item.grant.revision);
      await reload();
    } catch {
      setError("Revocation could not be confirmed. Refresh and check the grant before retrying.");
    } finally {
      mutationBusy.current = false;
      setPending(false);
    }
  };
  return (
    <section className="mc-next-remote-workers__section mc-worker-budget" aria-label="Worker spending budget">
      <div className="mc-worker-budget__heading">
        <h3>Spending budget</h3>
        <NativeButton variant="ghost" disabled={pending} onClick={() => void reload()}>
          Refresh budgets
        </NativeButton>
      </div>
      <p>
        Set a request and dollar limit for this worker in the current workspace. Memory calls and retries count toward
        the same limit. Uncertain provider charges remain reserved.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {items === null ? (
        <p>Budget balances are loading or unavailable.</p>
      ) : items.length === 0 ? (
        <p>No spending has been authorized for this worker.</p>
      ) : (
        <ul className="mc-worker-budget__list">
          {items.map((item) => (
            <li key={item.grant.grantId}>
              <strong>
                {item.grant.revokedAt
                  ? "Revoked"
                  : Date.parse(item.grant.expiresAt) <= Date.now()
                    ? "Expired"
                    : "Authorized"}{" "}
                · Generation {item.grant.workerGeneration}
              </strong>
              <span>
                {item.availableRequests} requests and {dollars(item.availableCostMicrousd)} available
              </span>
              <span>
                {item.heldRequests} requests / {dollars(item.heldCostMicrousd)} reserved · {item.settledRequests}{" "}
                requests / {dollars(item.settledCostMicrousd)} settled
              </span>
              <span>Expires {new Date(item.grant.expiresAt).toLocaleString()}</span>
              {!item.grant.revokedAt ? (
                <NativeButton variant="ghost" disabled={pending} onClick={() => void revoke(item)}>
                  Revoke budget
                </NativeButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {attempt?.dispatched ? (
        <p role="status">
          Authorization outcome unconfirmed.{" "}
          <NativeButton variant="outline" onClick={() => setReviewOpen(true)}>
            Review pending authorization
          </NativeButton>
        </p>
      ) : null}
      {!editing && !attempt?.dispatched ? (
        <NativeButton onClick={() => setEditing(true)}>New budget{draft.isDirty ? " · Unsaved" : ""}</NativeButton>
      ) : editing ? (
        <>
          {draft.hasRemoteChanges ? (
            <p role="alert">
              Worker generation changed.{" "}
              <NativeButton variant="outline" onClick={draft.rebaseToCurrent}>
                Review current generation
              </NativeButton>
            </p>
          ) : null}
          <form onSubmit={prepare}>
            <fieldset disabled={!active || pending || Boolean(attempt?.dispatched)}>
              <label>
                Provider request limit
                <input
                  type="number"
                  min="2"
                  max="100000"
                  step="1"
                  required
                  value={requests}
                  onChange={(event) => setRequests(event.target.value)}
                />
              </label>
              <label>
                Dollar limit (USD)
                <input
                  type="number"
                  min="0"
                  max="1000000"
                  step="0.01"
                  required
                  value={cost}
                  onChange={(event) => setCost(event.target.value)}
                />
              </label>
              <label>
                Expires after
                <select value={minutes} onChange={(event) => setMinutes(event.target.value)}>
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="240">4 hours</option>
                  <option value="1440">24 hours</option>
                </select>
              </label>
              <NativeButton type="submit">Review budget</NativeButton>
            </fieldset>
          </form>
          <NativeButton variant="ghost" onClick={() => leave.request(() => setEditing(false), [draft.key])}>
            Close budget editor
          </NativeButton>
        </>
      ) : null}
      {leave.dialog}
      {!active ? <p>A current admitted worker is required to authorize spending.</p> : null}
      <GCModal
        className="mc-worker-budget-modal"
        open={reviewOpen && review !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setReviewOpen(false);
            if (!attempt?.dispatched) setAttempt(null);
          }
        }}
        title="Authorize worker spending"
        description="This grant permits provider requests within the selected limits. Execution policy and task approvals still apply."
        confirmLabel="Authorize budget"
        confirmPending={pending}
        dismissDisabled={pending}
        onConfirm={authorize}
      >
        {review ? (
          <p>
            Authorize {worker.admission.value?.workerLabel ?? worker.workerId}, generation {review.workerGeneration}, to
            make up to <strong>{review.maxRequests} provider requests</strong> and spend up to{" "}
            <strong>{dollars(review.maxCostMicrousd)}</strong> in workspace {workspaceId} until{" "}
            {new Date(review.expiresAt).toLocaleString()}.
          </p>
        ) : null}
        {review && review.workerGeneration !== admission?.workerGeneration ? (
          <p role="alert">
            This authorization targets generation {review.workerGeneration}. Its outcome remains unconfirmed; refresh
            budgets to inspect the recorded grant. It cannot be retried for the new generation.
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </GCModal>
    </section>
  );
}
