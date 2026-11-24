import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FollowThroughAction, FollowThroughItem, FollowThroughActionInput } from "@goatcitadel/contracts";
import { fetchFollowThrough, requestFollowThroughAction } from "@goatcitadel/mission-control-shared/api/follow-through";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { subscribeRefresh } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { ChatFollowThrough } from "./ChatFollowThrough";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
const FollowThroughSetup = lazy(async () => ({
  default: (await import("./ChatFollowThroughSetupControl")).ChatFollowThroughSetupControl,
}));
const pendingRunAttempts = new Map<string, symbol>();

export function ChatFollowThroughControl(props: { sessionId: string; workspaceId: string }) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const access = useProjectAccess(props.workspaceId),
    identity = JSON.stringify([
      getGatewayApiBaseUrl(),
      access.identity,
      activeCitadelId,
      activeWorkspaceId,
      props.workspaceId,
      props.sessionId,
    ]);
  if (activeWorkspaceId && activeWorkspaceId !== props.workspaceId) return null;
  return <FollowThroughSession key={identity} identity={identity} {...props} />;
}
function FollowThroughSession({
  sessionId,
  workspaceId,
  identity,
}: {
  sessionId: string;
  workspaceId: string;
  identity: string;
}) {
  const route = useCockpitRoute(),
    query = useQuery({
      queryKey: ["chat", "follow-through", identity],
      queryFn: () => fetchFollowThrough(sessionId, workspaceId),
      staleTime: 15_000,
    });
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [limit, setLimit] = useState(10);
  const [setupOpen, setSetupOpen] = useState(false),
    [setupSeen, setSetupSeen] = useState(false),
    setupButton = useRef<HTMLButtonElement>(null);
  const storageKey = `goatcitadel.follow-through.pending.v1:${identity}`;
  const [unconfirmed, setUnconfirmed] = useState<FollowThroughActionInput | undefined>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as FollowThroughActionInput | null;
      return value?.sessionId === sessionId &&
        value.workspaceId === workspaceId &&
        value.action === "run_now" &&
        value.owner?.kind === "schedule" &&
        typeof value.owner.ownerId === "string" &&
        Number.isSafeInteger(value.expectedRevision) &&
        value.expectedRevision > 0 &&
        Number.isSafeInteger(value.expectedExecutionGeneration) &&
        value.expectedExecutionGeneration! >= 0 &&
        /^[A-Za-z0-9_-]{16,100}$/u.test(value.operationId ?? "")
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  });
  const mounted = useRef(true),
    lock = useRef(false);
  const { refetch } = query;
  useLayoutEffect(() => {
    mounted.current = true;
    const unsub = (["chat", "system", "approvals"] as const).map((topic) =>
      subscribeRefresh(topic, () => void refetch()),
    );
    return () => {
      mounted.current = false;
      unsub.forEach((callback) => callback());
    };
  }, [refetch]);
  function remember(input: FollowThroughActionInput | undefined) {
    setUnconfirmed(input);
    try {
      if (input) sessionStorage.setItem(storageKey, JSON.stringify(input));
      else sessionStorage.removeItem(storageKey);
    } catch {
      // Keep the exact request in the mounted panel when browser storage is unavailable.
    }
  }
  async function perform(input: FollowThroughActionInput) {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(undefined);
    // A retry of a request whose outcome was never confirmed settles nothing
    // about that first send, even when the retry itself is refused.
    const retryingUnconfirmed = input.action === "run_now" && unconfirmed?.operationId === input.operationId;
    const attempt = input.action === "run_now" ? Symbol() : undefined;
    const clearPendingRun = () => {
      // An older panel may still be waiting for a response to the same operation.
      if (mounted.current && pendingRunAttempts.get(storageKey) === attempt) remember(undefined);
    };
    try {
      if (attempt) {
        pendingRunAttempts.set(storageKey, attempt);
        remember(input);
      }
      const result = await requestFollowThroughAction(input);
      if (result.sessionId !== sessionId || result.workspaceId !== workspaceId)
        throw new Error("The follow-through scope changed. Refresh before acting.");
      if (input.action === "run_now") {
        if (
          !result.actionReceipt ||
          result.actionReceipt.operationId !== input.operationId ||
          !result.actionReceipt.runId
        )
          throw new Error(
            "The recorded run could not be confirmed. Keep the exact request while you check the schedule.",
          );
        clearPendingRun();
      }
      if (mounted.current) await query.refetch();
    } catch (cause) {
      // A clean refusal of a first send (for example a stale revision)
      // recorded nothing, so keeping the exact request would lock every action.
      const refused = !retryingUnconfirmed && isDefiniteRefusal(cause, input.action);
      if (attempt && refused) clearPendingRun();
      if (mounted.current) {
        setError(
          refused
            ? `${describeApiError(cause).summary} Nothing ran. Refresh follow-through, then choose again.`
            : `${describeApiError(cause).summary} Refresh to inspect the recorded outcome before trying another action.`,
        );
        void query.refetch();
      }
    } finally {
      if (attempt && pendingRunAttempts.get(storageKey) === attempt) pendingRunAttempts.delete(storageKey);
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function act(item: FollowThroughItem, action: FollowThroughAction, heartbeatIntervalSeconds?: number) {
    if (unconfirmed) return;
    await perform({
      sessionId,
      workspaceId,
      owner: item.owner,
      action,
      expectedRevision: item.revision,
      operationId: crypto.randomUUID(),
      ...(action === "cancel_run" ? { expectedRunId: item.activeRunId } : {}),
      ...(action === "run_now" ? { expectedExecutionGeneration: item.executionGeneration } : {}),
      ...(action === "set_heartbeat_interval" ? { heartbeatIntervalSeconds } : {}),
    });
  }
  return (
    <div className="min-w-0 space-y-3">
      {query.isPending ? <p>Checking follow-through…</p> : null}
      <ChatFollowThrough
        items={(query.data?.items ?? []).slice(0, limit)}
        pending={pending || Boolean(unconfirmed)}
        error={error ?? (query.error ? describeApiError(query.error).summary : undefined)}
        onAction={act}
        onOpenOwner={route.navigate}
      />
      {unconfirmed ? (
        <div role="status" className="space-y-2">
          <p>
            A run request is awaiting confirmation. Retrying keeps its exact identity and cannot request a second
            execution.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => void perform(unconfirmed)}>
              Retry exact run request
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => route.navigate(`/work/schedules?jobId=${encodeURIComponent(unconfirmed.owner.ownerId)}`)}
            >
              Inspect recorded run
            </Button>
          </div>
        </div>
      ) : null}
      {query.data?.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      {query.data?.truncated ? <p>Showing a bounded set. Open Work for the remaining schedules.</p> : null}
      {(query.data?.items.length ?? 0) > limit ? (
        <Button size="sm" onClick={() => setLimit(limit + 10)}>
          Show more follow-through
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" disabled={pending || query.isFetching} onClick={() => void query.refetch()}>
        Refresh follow-through
      </Button>
      <Button
        ref={setupButton}
        size="sm"
        variant="secondary"
        onClick={() => {
          setSetupSeen(true);
          setSetupOpen(true);
        }}
      >
        Set up follow-through
      </Button>
      {setupSeen ? (
        <Suspense fallback={<p>Opening follow-through setup…</p>}>
          <FollowThroughSetup
            open={setupOpen}
            sessionId={sessionId}
            workspaceId={workspaceId}
            onCreated={() => void query.refetch()}
            onClose={() => {
              setSetupOpen(false);
              setupButton.current?.focus();
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
/**
 * True when the Gateway answered with a client error that settled nothing: the
 * request was refused before any run was recorded. Run now conflicts require
 * an explicit pre-admission refusal because a receipt can fail after admission.
 */
function isDefiniteRefusal(error: unknown, action: FollowThroughAction): boolean {
  if (!isApiRequestError(error) || error.kind === "network" || error.kind === "protocol") return false;
  const status = error.status ?? 0;
  if (status < 400 || status >= 500 || status === 408 || status === 429) return false;
  if (status !== 409) return true;
  const body = error.body as { error?: unknown; code?: unknown } | undefined;
  if (action === "run_now") return body?.code === "FOLLOW_THROUGH_RUN_NOT_ADMITTED";
  return !(typeof body?.error === "string" && body.error.includes("Idempotency-Key"));
}
