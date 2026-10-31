import { lazy, Suspense, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import type { ApprovalRequest, ChatThreadTurnRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import {
  fetchCodeModeRun,
  keepCodeModeRun,
  promoteCapabilityCandidate,
  resolveApproval,
} from "@goatcitadel/mission-control-shared/api/client";
import { formatDuration } from "@goatcitadel/mission-control-shared/content/format";
import { nullWhenMissing } from "../inbox/inbox-record-read";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { CODE_MODE_READINESS_KEY, useCodeModeReadiness } from "./useCodeModeReadiness";
import { enableCodeMode } from "./enable-code-mode";

const ApprovalDecisionBar = lazy(async () => ({
  default: (await import("./ChatApprovalRendererBody")).ApprovalDecisionBar,
}));

const CODE_MODE_REQUEST = "code_mode.request";
const NOT_RUN = "Not run";

type Args = { goal?: unknown; source?: unknown; reads?: unknown };
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function firstSentence(message: string): string {
  const match = /^[^.!?\n]*[.!?]?/.exec(message.trim());
  return match?.[0]?.trim() || NOT_RUN;
}

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
  return (
    <RequestRow key={run.toolRunId} run={run} workspaceId={props.workspaceId} onRefreshThread={props.onRefreshThread} />
  );
}

function RequestRow({
  run,
  workspaceId,
  onRefreshThread,
}: {
  run: ChatToolRunRecord;
  workspaceId: string;
  onRefreshThread(): void;
}) {
  const queryClient = useQueryClient();
  const args = (run.args ?? {}) as Args;
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
  const pending = open && record?.status === "pending";
  const readiness = useCodeModeReadiness(pending);

  // A request whose record is gone (404, expired) or never existed can never be decided: report it, don't wait.
  const recordMissing = open && (!approvalId || (recordQuery.isSuccess && recordQuery.data === null));
  const recordFailed = open && Boolean(approvalId) && recordQuery.isError && !record;

  let body: ReactElement;
  let live = false;
  let keepRunId = "";
  if (run.status === "executed" && run.result?.status !== "failed") {
    const duration = typeof run.result?.durationMs === "number" ? formatDuration(run.result.durationMs) : "";
    body = (
      <p className="text-fg">
        Ran code to {goal}
        {duration ? <span className="text-fg-muted"> · {duration}</span> : null}
      </p>
    );
    keepRunId = text(run.result?.runId);
  } else if (run.status === "executed" || run.status === "failed") {
    const reason = text(run.result?.error) || text(run.error);
    body = <p className="text-fg-secondary">{reason ? firstSentence(reason) : NOT_RUN}</p>;
  } else if (
    run.status === "blocked" ||
    recordMissing ||
    (open && record && record.status !== "pending" && record.status !== "approved")
  ) {
    body = <p className="text-fg-secondary">{NOT_RUN}</p>;
  } else if (open && record?.status === "approved") {
    live = true;
    body = (
      <p className="flex items-center gap-2 text-fg-secondary">
        <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
        Running code…
      </p>
    );
  } else if (recordFailed) {
    body = (
      <div className="space-y-2">
        <p className="text-fg">Run code to {goal}</p>
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
      </div>
    );
  } else {
    body = (
      <PendingRow
        goal={goal}
        record={record}
        workspaceId={workspaceId}
        sessionId={run.sessionId}
        reason={readiness.data?.reason}
        readinessKnown={!readiness.isPending}
        onSettled={() => {
          void queryClient.invalidateQueries({ queryKey: CODE_MODE_READINESS_KEY });
          void recordQuery.refetch();
          onRefreshThread();
        }}
      />
    );
  }

  return (
    <section aria-label="Code Mode request" aria-live={live ? "polite" : undefined} className="space-y-1 text-sm">
      {body}
      {keepRunId ? <KeepAsTool runId={keepRunId} goal={goal} workspaceId={workspaceId} /> : null}
      <RequestDetails run={run} args={args} workspaceId={workspaceId} />
    </section>
  );
}

const toolName = (goal: string): string => {
  const titled = goal.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
  return titled.slice(0, 60).trim() || "Saved Code Mode tool";
};

/**
 * Stages the finished run as a tool, then promotes it in the same click: the button label is the consent, so a
 * lifecycle approval raised by the promotion is approved here. A Change Plan, or a promotion that is not available,
 * leaves the tool saved for review in Capabilities.
 */
function KeepAsTool({ runId, goal, workspaceId }: { runId: string; goal: string; workspaceId: string }) {
  const [state, setState] = useState<"idle" | "keeping" | "kept" | "failed">("idle");
  if (state === "kept") {
    return (
      <p className="text-fg-secondary">
        Saved as a tool for review{" "}
        <NativeOwnerLink href="/capabilities/skills" scope={workspaceId}>
          Open Capabilities
        </NativeOwnerLink>
      </p>
    );
  }
  const keep = async () => {
    setState("keeping");
    let staged: Awaited<ReturnType<typeof keepCodeModeRun>>;
    try {
      staged = await keepCodeModeRun(runId, { name: toolName(goal), summary: goal.slice(0, 200) });
    } catch {
      setState("failed");
      return;
    }
    try {
      const outcome = await promoteCapabilityCandidate(staged.candidateId, staged.revision, staged.versionId);
      if (outcome.pendingApproval) await resolveApproval(outcome.pendingApproval.approvalId, "approve");
    } catch {
      // The tool is staged; promotion stays available from Capabilities.
    }
    setState("kept");
  };
  return (
    <p className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="font-medium text-accent hover:underline disabled:opacity-60"
        disabled={state === "keeping"}
        onClick={() => void keep()}
      >
        Keep as a tool
      </button>
      {state === "failed" ? (
        <span role="status" className="text-fg-muted">
          Couldn&apos;t save it. Try again.
        </span>
      ) : null}
    </p>
  );
}

function PendingRow(props: {
  goal: string;
  record: ApprovalRequest | undefined;
  workspaceId: string;
  sessionId: string;
  reason: "code_mode_off" | "sandbox_off" | "sandbox_unsupported" | undefined;
  readinessKnown: boolean;
  onSettled(): void;
}) {
  const { goal, record, reason } = props;
  const off = reason === "code_mode_off" || reason === "sandbox_off";
  const unsupported = reason === "sandbox_unsupported";
  return (
    <div className="space-y-2">
      <p className="text-fg">
        Run code to {goal}
        {off ? <span className="text-fg-muted"> · Code Mode is off</span> : null}
        {unsupported ? <span className="text-fg-muted"> · This computer can&apos;t run Code Mode</span> : null}
      </p>
      {!record ? (
        <p role="status" className="text-fg-muted">
          Checking the request…
        </p>
      ) : !props.readinessKnown ? (
        <p role="status" className="text-fg-muted">
          Checking Code Mode…
        </p>
      ) : (
        <Suspense fallback={<p role="status">Loading approval controls…</p>}>
          <ApprovalDecisionBar
            approval={record}
            workspaceId={props.workspaceId}
            sessionId={props.sessionId}
            compact
            reviewedInPlace
            approveLabel={off ? "Turn on Code Mode and run" : "Run it"}
            approveDanger={off}
            withholdApprove={unsupported}
            prepareApprove={off ? enableCodeMode : undefined}
            onResolved={props.onSettled}
            onInvalidated={props.onSettled}
          />
        </Suspense>
      )}
    </div>
  );
}

function RequestDetails({ run, args, workspaceId }: { run: ChatToolRunRecord; args: Args; workspaceId: string }) {
  const reads = Array.isArray(args.reads)
    ? args.reads.filter((entry): entry is string => typeof entry === "string")
    : [];
  const source = text(args.source);
  const runId = text(run.result?.runId);
  return (
    <details className="text-xs text-fg-secondary">
      <summary className="cursor-pointer font-medium">Details</summary>
      <div className="mt-2 space-y-2">
        {reads.length ? (
          <div>
            <p className="font-medium">Reads</p>
            <ul className="list-disc pl-5">
              {reads.map((entry) => (
                <li key={entry} className="wrap-anywhere">
                  {entry}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {source ? (
          <details>
            <summary className="cursor-pointer font-medium">Code</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-2 font-mono text-xs text-fg">
              {source}
            </pre>
          </details>
        ) : null}
        <TechnicalDetails>
          <div className="space-y-1 font-mono text-xs wrap-anywhere">
            {run.approvalId ? <p>Approval: {run.approvalId}</p> : null}
            {runId ? <p>Run: {runId}</p> : null}
            {runId ? (
              <CodeHash runId={runId} workspaceId={workspaceId} sessionId={run.sessionId} turnId={run.turnId} />
            ) : null}
          </div>
        </TechnicalDetails>
      </div>
    </details>
  );
}

function CodeHash(props: { runId: string; workspaceId: string; sessionId: string; turnId: string }) {
  const query = useQuery({
    queryKey: ["code-mode", "run", props.workspaceId, props.runId],
    queryFn: () =>
      fetchCodeModeRun(props.runId, {
        workspaceId: props.workspaceId,
        sessionId: props.sessionId,
        turnId: props.turnId,
      }),
    staleTime: 60_000,
  });
  return query.data?.codeHash ? <p>Code hash: {query.data.codeHash}</p> : null;
}
