import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import {
  localRuntimeActionLocked,
  readLocalRuntimeAttempt,
  readLocalRuntimeReview,
  startReviewedLocalRuntime,
  subscribeLocalRuntimeAttempt,
  type LocalRuntimeReview,
} from "./health-local-runtime-actions";

export function HealthLocalRuntimeActions({
  workspaceId,
  onRefresh,
}: {
  workspaceId: string;
  onRefresh?: () => unknown | Promise<unknown>;
}) {
  return <RuntimeStartReview key={workspaceId} workspaceId={workspaceId} onRefresh={onRefresh} />;
}

function RuntimeStartReview({
  workspaceId,
  onRefresh,
}: {
  workspaceId: string;
  onRefresh?: () => unknown | Promise<unknown>;
}) {
  const { navigate } = useCockpitRoute();
  const [review, setReview] = useState<LocalRuntimeReview>();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const readPending = useRef(false);
  const attempt = useSyncExternalStore(subscribeLocalRuntimeAttempt, readLocalRuntimeAttempt, () => undefined);
  const locked = localRuntimeActionLocked(attempt);
  const pending = attempt?.phase === "checking" || attempt?.phase === "starting";
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  async function loadReview() {
    if (readPending.current || pending) return;
    readPending.current = true;
    const request = ++generation.current;
    setLoading(true);
    setError(undefined);
    setReview(undefined);
    setOpen(true);
    try {
      const value = await readLocalRuntimeReview(workspaceId);
      if (generation.current === request) setReview(value);
    } catch (cause) {
      if (generation.current === request) setError(describeApiError(cause).summary.slice(0, 600));
    } finally {
      readPending.current = false;
      if (generation.current === request) setLoading(false);
    }
  }
  function closeReview(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) {
      generation.current += 1;
      setReview(undefined);
      setLoading(false);
      setError(undefined);
    }
  }
  async function confirmStart() {
    if (!review || locked || loading) return;
    const request = generation.current;
    setError(undefined);
    try {
      await startReviewedLocalRuntime(review, () => generation.current === request);
      if (generation.current !== request) return;
      setReview(undefined);
      setOpen(false);
      // Failed parent refresh must not relabel a verified owner action as failed.
      try {
        await onRefresh?.();
      } catch {
        /* The health query presents its own read error. */
      }
    } catch (cause) {
      if (generation.current === request) {
        setReview(undefined);
        setError(describeApiError(cause).summary.slice(0, 600));
      }
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <Button size="sm" disabled={loading || pending} onClick={() => void loadReview()}>
        {loading ? "Reading local runtime…" : locked ? "Inspect local runtime" : "Review local runtime start"}
      </Button>
      {attempt ? (
        <p role={attempt.phase === "uncertain" ? "alert" : "status"} className="text-xs text-fg-secondary">
          {attempt.workspaceId !== workspaceId ? "Host-wide runtime action from another workspace: " : ""}
          {attempt.message}
        </p>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={closeReview}
        title="Start the managed local runtime?"
        description="This starts the saved llama.cpp process on the Gateway host and affects every workspace using it."
      >
        <div className="space-y-3">
          {loading ? (
            <p role="status" className="text-sm text-fg-secondary">
              Reading saved configuration and current process ownership…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-status-failed">
              {error}
            </p>
          ) : null}
          {review ? (
            <>
              <dl className="grid gap-2 text-sm">
                <div>
                  <dt className="text-fg-muted">Saved endpoint</dt>
                  <dd className="break-all text-fg">{review.endpoint}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Saved model file</dt>
                  <dd className="break-all text-fg">{review.modelLabel}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Runtime binary</dt>
                  <dd className="break-all text-fg">{review.commandLabel}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Settings revision</dt>
                  <dd className="text-fg">{review.settingsRevision}</dd>
                </div>
              </dl>
              <p className="text-sm text-fg-secondary">{review.reason}</p>
              <p className="text-xs text-fg-muted">
                Uses the saved configuration without changing it. The Gateway checks process ownership and startup
                eligibility. This can consume local memory and GPU resources.
              </p>
              <p className="text-xs text-fg-muted">
                Configuration is checked again before and after the request. The current Start API cannot bind startup
                atomically to this revision; concurrent settings changes may prevent verification.
              </p>
            </>
          ) : null}
          {pending ? (
            <p role="status" className="text-sm text-fg-secondary">
              {attempt?.message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!review?.eligible || locked || loading}
              onClick={() => void confirmStart()}
            >
              {pending ? "Starting…" : "Confirm host-wide start"}
            </Button>
            <Button size="sm" disabled={loading || pending} onClick={() => void loadReview()}>
              Refresh review
            </Button>
            <Button size="sm" disabled={pending} onClick={() => closeReview(false)}>
              Cancel
            </Button>
            <a href="/settings/models?shell=cockpit#local-ai" className="text-sm text-accent underline"
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigate("/settings/models?shell=cockpit#local-ai");
              }}>
              Open Local AI settings
            </a>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
