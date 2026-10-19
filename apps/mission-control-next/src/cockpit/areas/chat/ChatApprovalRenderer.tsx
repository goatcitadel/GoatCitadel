import {
  hasUnsettledChatContextMutation,
  CHAT_CONTEXT_RELOAD_NOTE,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { readCockpitHistory, subscribeCockpitHistory } from "../../app/cockpit-history";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { OutsideRootWriteGrantOptions } from "./OutsideRootWriteGrantOptions";

type RendererCode = typeof import("./ChatApprovalRendererBody");
type DecisionProps = ComponentProps<RendererCode["ApprovalDecisionBar"]>;
type ChatApprovalRendererProps = Omit<DecisionProps, "approval"> & {
  approvalId: string;
  approval?: ApprovalRequest | null;
  recordPending: boolean;
  /** Recovery while the record is missing or failed to load; see `ApprovalRecordRecovery`. */
  recovery?: RecordRecovery;
};

type RecordRecovery = {
  /** The record read failed, as opposed to returning no record. */
  failed: boolean;
  retrying: boolean;
  onRetry: () => void;
  /** Denies the pending request by id. Denying is the safe choice, so it never waits for the full record. */
  onDeny?: () => void;
  denying: boolean;
};

/** A missing or unreadable record still leaves a way forward: read it again, or deny by id. */
function ApprovalRecordRecovery({ pending, recovery }: { pending: boolean; recovery?: RecordRecovery }) {
  return (
    <div className="space-y-2">
      <p role="status">
        {pending
          ? "Checking the current approval…"
          : !recovery
            ? "Current approval unavailable. Open the persisted record before deciding."
            : recovery.failed
              ? "The approval record couldn’t load, so approving is unavailable. Try again, or deny the request."
              : "The approval record wasn’t found. It may have been decided or expired elsewhere. Check again, or deny the request."}
      </p>
      {recovery && !pending ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={recovery.retrying} loadingLabel="Checking…" onClick={recovery.onRetry}>
            {recovery.failed ? "Try again" : "Check again"}
          </Button>
          {recovery.onDeny ? (
            <Button size="sm" loading={recovery.denying} loadingLabel="Denying…" onClick={recovery.onDeny}>
              Deny
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Shared code only; records, callbacks and decision attempts stay with their existing owners.
let rendererLoad: Promise<RendererCode> | undefined;
function loadRendererCode() {
  rendererLoad ??= import("./ChatApprovalRendererBody").catch((cause) => {
    rendererLoad = undefined;
    throw cause;
  });
  return rendererLoad;
}

type Owner = { scope: string };
type LoadState = { owner: Owner; code: RendererCode } | { owner: Owner; failed: true };
type ReloadReview = { owner: Owner; history: string; url: string; trigger: HTMLButtonElement };

/** The canonical GET and native request facts remain outside this code-only boundary. */
export function ChatApprovalRenderer({
  approvalId,
  approval,
  recordPending,
  recovery,
  ...decisionProps
}: ChatApprovalRendererProps) {
  const callerRevision = useSyncExternalStore(
    subscribeGatewayCallerScope,
    getGatewayCallerScopeRevision,
    getGatewayCallerScopeRevision,
  );
  const accessRevision = useSyncExternalStore(
    subscribeGatewayAccessChange,
    getGatewayAccessRevision,
    getGatewayAccessRevision,
  );
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const gateway = getGatewayApiBaseUrl();
  const scope = JSON.stringify([
    gateway,
    callerRevision,
    accessRevision,
    decisionProps.workspaceId,
    decisionProps.sessionId,
    approvalId,
  ]);
  const owner = useMemo<Owner>(() => ({ scope }), [scope]);
  const committedOwner = useRef(owner);
  const mounted = useRef(true);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const activeReview = useRef<ReloadReview | undefined>(undefined);
  const returnFocus = useRef<ReloadReview | undefined>(undefined);
  const [review, setReview] = useState<ReloadReview>();
  const [state, setState] = useState<LoadState>();
  const current = useCallback(
    () =>
      mounted.current &&
      committedOwner.current === owner &&
      getGatewayApiBaseUrl() === gateway &&
      getGatewayCallerScopeRevision() === callerRevision &&
      getGatewayAccessRevision() === accessRevision,
    [owner, gateway, callerRevision, accessRevision],
  );
  const currentReview = (saved: ReloadReview) =>
    saved.owner === owner && current() && readCockpitHistory() === saved.history && window.location.href === saved.url;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeReview.current = undefined;
      returnFocus.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    committedOwner.current = owner;
    activeReview.current = undefined;
    returnFocus.current = undefined;
    setReview(undefined);
  }, [owner, history]);
  useEffect(() => {
    if (!approvalId) return;
    let active = true;
    const owned = () => active && current();
    // Load with the signal, in parallel with the owner's existing canonical record read.
    void loadRendererCode().then(
      (code) => {
        if (owned()) setState({ owner, code });
      },
      () => {
        if (owned()) setState({ owner, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [approvalId, owner, current]);
  const ownedState = state?.owner === owner ? state : undefined;
  const code = ownedState && "code" in ownedState ? ownedState.code : undefined;
  const failed = Boolean(ownedState && "failed" in ownedState);
  const record = approval?.approvalId === approvalId ? approval : undefined;
  const hasRecord = Boolean(record);
  useLayoutEffect(() => {
    if (hasRecord && failed) return;
    activeReview.current = undefined;
    returnFocus.current = undefined;
    setReview(undefined);
  }, [hasRecord, failed]);
  const closeReview = (saved: ReloadReview | undefined) => {
    if (!saved || activeReview.current !== saved) return;
    activeReview.current = undefined;
    setReview((value) => (value === saved ? undefined : value));
  };
  const openReview = (trigger: HTMLButtonElement) => {
    if (!failed || !record || !current() || activeReview.current) return;
    const saved = { owner, history: readCockpitHistory(), url: window.location.href, trigger };
    activeReview.current = saved;
    returnFocus.current = saved;
    setReview(saved);
  };
  const reload = (saved: ReloadReview | undefined) => {
    if (hasUnsettledChatContextMutation()) return;
    if (!saved || activeReview.current !== saved || !failed || !record || !currentReview(saved)) return;
    // Consume this exact consent before reload; repeat/stale handlers have no effect.
    activeReview.current = undefined;
    returnFocus.current = undefined;
    setReview((value) => (value === saved ? undefined : value));
    window.location.reload();
  };
  return (
    <div aria-busy={Boolean(record && !code && !failed)}>
      {!record ? (
        <ApprovalRecordRecovery pending={recordPending} recovery={recovery} />
      ) : (
        <>
          {record.status !== "pending" ? <p role="status">Decision recorded. Check follow-on work below.</p> : null}
          {failed ? (
            <div role="alert" className="min-h-10 space-y-2">
              <p>
                Approval details could not load. Reload the app or inspect the persisted record. No decision was sent by
                this load.
              </p>
              <Button size="sm" onClick={(event) => openReview(event.currentTarget)}>
                Reload app
              </Button>
            </div>
          ) : !code ? (
            <p role="status" className="min-h-10">
              {record.status === "pending" ? "Loading approval controls…" : "Loading follow-on work…"}
            </p>
          ) : record.status === "pending" ? (
            <>
              <code.ApprovalDecisionBar key={scope} {...decisionProps} approval={record} />
              {decisionProps.sessionId ? (
                <OutsideRootWriteGrantOptions
                  key={`folder-${scope}`}
                  approval={record}
                  workspaceId={decisionProps.workspaceId}
                  sessionId={decisionProps.sessionId}
                  onResolved={decisionProps.onResolved}
                />
              ) : null}
            </>
          ) : (
            <code.ApprovalSettlement key={scope} approval={record} workspaceId={decisionProps.workspaceId} />
          )}
        </>
      )}
      <Dialog
        open={Boolean(review && failed && record && currentReview(review))}
        onOpenChange={(open) => {
          if (!open) closeReview(review);
        }}
        title="Reload app?"
        description="Reloading keeps the recorded conversation and approval. Unsent question answers and unsaved edits may be lost. Reloading does not submit an answer or an approval decision."
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (review && activeReview.current === review && currentReview(review))
            cancelButton.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const saved = returnFocus.current;
          returnFocus.current = undefined;
          if (
            saved &&
            currentReview(saved) &&
            saved.trigger.isConnected &&
            (document.activeElement === document.body || document.activeElement === saved.trigger)
          )
            saved.trigger.focus({ preventScroll: true });
        }}
      >
        <div className="flex justify-end gap-2">
          <Button ref={cancelButton} onClick={() => closeReview(review)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={hasUnsettledChatContextMutation() || !review || !currentReview(review)}
            title={hasUnsettledChatContextMutation() ? CHAT_CONTEXT_RELOAD_NOTE : undefined}
            onClick={() => reload(review)}
          >
            Reload app
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
