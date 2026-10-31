import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import type {
  ApprovalRequest,
  ChatThreadTurnRecord,
  ChatToolRunRecord,
  CodeModeReadiness,
} from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { formatDuration } from "@goatcitadel/mission-control-shared/content/format";
import { nullWhenMissing } from "../inbox/inbox-record-read";
import { CODE_MODE_READINESS_KEY, useCodeModeReadiness } from "./useCodeModeReadiness";
import { enableCodeMode } from "./enable-code-mode";
import { ChatCodeModeKeepAsTool } from "./ChatCodeModeKeepAsTool";
import { ChatCodeModeRequestDetails } from "./ChatCodeModeRequestDetails";
import {
  NOT_RUN,
  failureLine,
  failureReason,
  readEntries,
  readsLine,
  text,
  type CodeModeRequestArgs,
} from "./code-mode-request-copy";

const ApprovalDecisionBar = lazy(async () => ({
  default: (await import("./ChatApprovalRendererBody")).ApprovalDecisionBar,
}));

const CODE_MODE_REQUEST = "code_mode.request";
const CHANGED_NOTE = "This request was updated. Choose again.";

/** The newest code_mode.request run in the turn, or undefined. */
function findRequestRun(turn: ChatThreadTurnRecord): ChatToolRunRecord | undefined {
  return [...turn.toolRuns].reverse().find((run) => run.toolName === CODE_MODE_REQUEST);
}

/**
 * The one-click Code Mode request inside a reply: a flat row that reads "Run code to {goal}", asks once, then reports
 * what happened. It renders nothing when the turn made no such request. Its approval is owned here, not by the
 * generic approval card.
 */
export function ChatCodeModeRequestCard(props: {
  turn: ChatThreadTurnRecord;
  workspaceId: string;
  onRefreshThread(): void;
}) {
  const run = findRequestRun(props.turn);
  if (!run) return null;
  const attachmentNames = new Map(
    (props.turn.userMessage?.attachments ?? []).map((attachment) => [attachment.attachmentId, attachment.fileName]),
  );
  return (
    <RequestRow
      key={run.toolRunId}
      run={run}
      attachmentNames={attachmentNames}
      workspaceId={props.workspaceId}
      onRefreshThread={props.onRefreshThread}
    />
  );
}

function RequestRow({
  run,
  attachmentNames,
  workspaceId,
  onRefreshThread,
}: {
  run: ChatToolRunRecord;
  attachmentNames: ReadonlyMap<string, string>;
  workspaceId: string;
  onRefreshThread(): void;
}) {
  const queryClient = useQueryClient();
  const args = (run.args ?? {}) as CodeModeRequestArgs;
  const goal = text(args.goal) || "complete this step";
  const open = run.status === "approval_required" || run.status === "started";
  const approvalId = run.approvalId;
  const recordQuery = useQuery({
    // The same key as the generic approval card and the Inbox, so one decision refreshes all three.
    queryKey: ["approvals", "record", workspaceId, approvalId],
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(approvalId!, { workspaceId, signal })),
    enabled: Boolean(approvalId) && open,
    staleTime: 0,
  });
  const record: ApprovalRequest | undefined = recordQuery.data ?? undefined;
  // Read beside the record, so a request shows one loading line, and only while it may still be asked.
  const readiness = useCodeModeReadiness(open && Boolean(approvalId) && (!record || record.status === "pending"));

  // A request whose record is gone (404, expired) or never existed can never be decided: report it, don't wait.
  const recordMissing = open && (!approvalId || (recordQuery.isSuccess && recordQuery.data === null));
  const recordFailed = open && Boolean(approvalId) && recordQuery.isError && !record;
  // The approve call returns only after the code ran, and the approval_resolved event refetches the record first: the
  // row turns to "Running code…" and the decision buttons unmount before they hear back. So the row itself re-reads
  // the thread and the pending queue once the record settles, which lets the composer go.
  const settledStatus = open && record && record.status !== "pending" ? record.status : undefined;
  const refreshThread = useRef(onRefreshThread);
  refreshThread.current = onRefreshThread;
  useEffect(() => {
    if (!settledStatus) return;
    void queryClient.invalidateQueries({ queryKey: CODE_MODE_READINESS_KEY });
    refreshThread.current();
  }, [queryClient, settledStatus]);
  // A click checked against a record that changed meanwhile (the model's explanation lands a few seconds after the
  // request, perhaps while Code Mode is being turned on) is not sent, and the buttons remount for the new record, which
  // clears their error. The row keeps the note, with the error's link to its next step (an Inbox step) when it has one.
  const [note, setNote] = useState<ReactNode>("");
  // Turning Code Mode on changes what the row offers, so readiness is read again whatever the outcome: the button
  // turns to "Run it" once both switches are on, and the row still says Code Mode is off when only one went on.
  const turnOnCodeMode = async (progress: (message: string) => void) => {
    try {
      await enableCodeMode(progress);
    } finally {
      void queryClient.invalidateQueries({ queryKey: CODE_MODE_READINESS_KEY });
    }
  };
  // As in the generic approval card (CH-18): a decision replaces its buttons. If focus was inside and fell to <body>,
  // it moves once to the row's state line, which then says what happened.
  const focusWithin = useRef(false);
  const lineRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!focusWithin.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    focusWithin.current = false;
    lineRef.current?.focus({ preventScroll: true });
  });

  // The row's state line stays mounted in every state, so each change ("Running code…", the outcome) is announced.
  let line: ReactNode;
  let lineClass = "text-fg-secondary";
  let controls: ReactNode = null;
  let keepRunId = "";
  const readinessNow = readinessState(readiness);
  if (run.status === "executed" && run.result?.status !== "failed") {
    const duration = typeof run.result?.durationMs === "number" ? formatDuration(run.result.durationMs) : "";
    line = (
      <>
        Ran code to {goal}
        {duration ? <span className="text-fg-muted"> · {duration}</span> : null}
      </>
    );
    lineClass = "text-fg";
    keepRunId = text(run.result?.runId);
  } else if (run.status === "executed" || run.status === "failed") {
    const reason = failureReason(run);
    line = reason ? failureLine(reason) : NOT_RUN;
  } else if (
    run.status === "blocked" ||
    recordMissing ||
    (open && record && record.status !== "pending" && record.status !== "approved")
  ) {
    line = NOT_RUN;
  } else if (open && record?.status === "approved") {
    line = (
      <>
        <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
        Running code…
      </>
    );
    lineClass = "flex items-center gap-2 text-fg-secondary";
  } else {
    line = (
      <>
        Run code to {goal}
        {readinessNow === "off" ? <span className="text-fg-muted"> · Code Mode is off</span> : null}
        {readinessNow === "unsupported" ? (
          <span className="text-fg-muted"> · This computer can&apos;t run Code Mode</span>
        ) : null}
      </>
    );
    lineClass = "text-fg";
    controls = recordFailed ? (
      <p role="status" className="text-fg-muted">
        Couldn&apos;t load the request.{" "}
        <button
          type="button"
          className="font-medium text-accent hover:underline"
          onClick={() => void recordQuery.refetch()}
        >
          Try again
        </button>
      </p>
    ) : (
      <PendingRow
        reads={readsLine(readEntries(args), attachmentNames)}
        record={record}
        workspaceId={workspaceId}
        sessionId={run.sessionId}
        readiness={readinessNow}
        onRetryReadiness={() => void readiness.refetch()}
        turnOnCodeMode={turnOnCodeMode}
        note={note}
        onSettled={() => {
          setNote("");
          void queryClient.invalidateQueries({ queryKey: CODE_MODE_READINESS_KEY });
          void recordQuery.refetch();
          onRefreshThread();
        }}
        onInvalidated={(message, messageLine) => {
          setNote(messageLine ?? message ?? CHANGED_NOTE);
          void recordQuery.refetch();
          onRefreshThread();
        }}
      />
    );
  }

  return (
    // A group, not a landmark: every turn that asks adds one.
    <div
      role="group"
      aria-label="Code Mode request"
      className="space-y-1 text-sm"
      onFocusCapture={() => {
        focusWithin.current = true;
      }}
      onBlurCapture={(event) => {
        // A button disabled by its own click (the decision is being checked) loses focus too; the row keeps it.
        if (event.target instanceof HTMLButtonElement && event.target.disabled) return;
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focusWithin.current = false;
      }}
    >
      <p ref={lineRef} role="status" tabIndex={-1} className={`outline-none ${lineClass}`}>
        {line}
      </p>
      {controls}
      {keepRunId ? <ChatCodeModeKeepAsTool runId={keepRunId} goal={goal} workspaceId={workspaceId} /> : null}
      <ChatCodeModeRequestDetails run={run} args={args} workspaceId={workspaceId} />
    </div>
  );
}

/** What the row may offer: run, turn Code Mode on and run, Deny only, or nothing until it knows. */
type ReadinessState = "checking" | "failed" | "ready" | "off" | "unsupported";

/**
 * Code Mode readiness for the buttons. Only an answer read since this row mounted counts: a cached one from an earlier
 * request may predate Code Mode being turned on or off. A failed read offers no run (the server would only refuse it
 * and spend the approval), and a host that can't run the sandbox is never offered the switch.
 */
function readinessState(query: UseQueryResult<CodeModeReadiness>): ReadinessState {
  if (query.isError) return query.isFetching ? "checking" : "failed"; // refetch-guard: allow a failed read has no record to keep
  if (!query.isFetchedAfterMount || !query.data) return "checking";
  const { reason, sandboxSupported } = query.data;
  if (reason === "sandbox_unsupported" || sandboxSupported === false) return "unsupported";
  return reason === "code_mode_off" || reason === "sandbox_off" ? "off" : "ready";
}

/** The controls under a pending request's line: what it reads, then the decision once readiness is known. */
function PendingRow(props: {
  /** The files the code may read, by name; empty when it reads none. */
  reads: string;
  record: ApprovalRequest | undefined;
  workspaceId: string;
  sessionId: string;
  readiness: ReadinessState;
  onRetryReadiness(): void;
  turnOnCodeMode(progress: (message: string) => void): Promise<void>;
  /** Why the last click was not sent, kept while the buttons remount; empty when there is nothing to say. */
  note: ReactNode;
  onSettled(): void;
  onInvalidated(message?: string, line?: ReactNode): void;
}) {
  const { record, readiness } = props;
  const off = readiness === "off";
  const unsupported = readiness === "unsupported";
  return (
    <div className="space-y-2">
      {props.reads ? <p className="text-fg-muted wrap-anywhere">Reads {props.reads}</p> : null}
      {/* Loading lines are not announced; the row's status line and the outcomes below are. */}
      {!record || readiness === "checking" ? (
        <p className="text-fg-muted">Checking the request…</p>
      ) : (
        <Suspense fallback={<p className="text-fg-muted">Loading approval controls…</p>}>
          {readiness === "failed" ? (
            <p role="status" className="text-fg-muted">
              Couldn&apos;t check Code Mode.{" "}
              <button
                type="button"
                className="font-medium text-accent hover:underline"
                onClick={props.onRetryReadiness}
              >
                Try again
              </button>
            </p>
          ) : null}
          <ApprovalDecisionBar
            approval={record}
            workspaceId={props.workspaceId}
            sessionId={props.sessionId}
            compact
            reviewedInPlace
            approveLabel={off ? "Turn on Code Mode and run" : "Run it"}
            approveDanger={off}
            withholdApprove={unsupported || readiness === "failed"}
            prepareApprove={off ? props.turnOnCodeMode : undefined}
            onResolved={props.onSettled}
            onInvalidated={props.onInvalidated}
          />
        </Suspense>
      )}
      {props.note && record ? (
        <p role="status" className="text-fg-muted">
          {props.note}
        </p>
      ) : null}
    </div>
  );
}
