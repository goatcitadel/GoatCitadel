import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import {
  fetchBrowserErrandStatus,
  stopBrowserErrand,
  type BrowserErrandOutcome,
  type BrowserErrandStatus,
} from "@goatcitadel/mission-control-shared/api/browser-errands";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { presentBrowserErrand } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { AttachmentImage } from "../../ui/AttachmentImage";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";

const POLL_MS = 2_000;
const MAX_POLL_MS = 30_000;

/**
 * How long until the next status read, or false to stop. Failing reads back off (4 s, 8 s, ... up to 30 s) while the
 * tool run is open and stop once it has closed, so a dead Gateway or a lost sign-in is not asked every 2 s forever.
 * `consecutiveFailures` counts failed polls since the last good one; TanStack's own `fetchFailureCount` restarts at
 * every fetch, so it cannot carry a backoff across polls.
 */
export function errandPollInterval(state: {
  data: BrowserErrandStatus | null | undefined;
  status: string;
  consecutiveFailures: number;
  toolRunOpen: boolean;
}): number | false {
  if (state.data?.state === "finished") return false;
  if (state.data === null && !state.toolRunOpen) return false;
  if (state.status === "error") {
    return state.toolRunOpen ? Math.min(MAX_POLL_MS, POLL_MS * 2 ** state.consecutiveFailures) : false;
  }
  return POLL_MS;
}

const IMAGE_CLASS = "mt-2 max-h-56 w-auto max-w-full rounded-md border border-line bg-sunken";

const OUTCOME_COPY: Record<BrowserErrandOutcome, string> = {
  done: "The errand is done.",
  stopped: "You stopped the errand.",
  declined: "You declined a step, so the errand ended.",
  expired: "A step was never approved, so the errand ended.",
  failed: "The errand could not finish.",
  step_limit: "The errand reached its step limit before it finished.",
  time_limit: "The errand ran out of time before it finished.",
  window_closed: "The browser window was closed, so the errand ended.",
};

const OUTCOMES = new Set<string>(Object.keys(OUTCOME_COPY));
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The status the Gateway can no longer give (after a restart), read back from the tool run's own result. */
function statusFromResult(toolRunId: string, result: Record<string, unknown>): BrowserErrandStatus | undefined {
  const outcome = text(result.outcome);
  if (!outcome || !OUTCOMES.has(outcome)) return undefined;
  const finalAttachmentId = text(result.finalScreenshotAttachmentId);
  const summary = text(result.summary);
  return {
    errandId: "",
    toolRunId,
    state: "finished",
    stepCount: count(result.steps) ?? 0,
    stepText: "",
    modelRequests: count(result.modelRequests) ?? 0,
    outcome: outcome as BrowserErrandOutcome,
    ...(finalAttachmentId ? { finalAttachmentId } : {}),
    ...(summary ? { summary } : {}),
  };
}

/**
 * A `browser.errand` run inside a reply: the live step, the latest picture of the browser window and a Stop button
 * while the errand runs, then its answer, final picture and request count once it has finished. The Gateway's status
 * is the truth while it holds the errand; the tool run's own result stands in once it does not. The card is polled every
 * 2 s, so none of its text is a live region: a screen reader would hear every step.
 */
export function ChatBrowserErrandCard(props: {
  toolRunId: string;
  /** The tool run's result, once it has one. */
  fallbackResult?: Record<string, unknown>;
  /** Whether the tool run is still going (started, or waiting on an approval). */
  toolRunOpen?: boolean;
}) {
  const { toolRunId, fallbackResult, toolRunOpen = false } = props;
  const queryClient = useQueryClient();
  const queryKey = ["browser-errands", "status", toolRunId] as const;
  const failures = useRef(0);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      try {
        const status = await fetchBrowserErrandStatus(toolRunId, { signal });
        failures.current = 0;
        return status;
      } catch (error) {
        failures.current += 1;
        throw error;
      }
    },
    staleTime: 0,
    // One read per poll, so the backoff below is the only retry.
    retry: false,
    // Polls until the errand finishes. A tool run that already ended stops asking once the Gateway has nothing on it.
    refetchInterval: (current) =>
      errandPollInterval({
        data: current.state.data,
        status: current.state.status,
        consecutiveFailures: failures.current,
        toolRunOpen,
      }),
  });
  const [stopError, setStopError] = useState<string>();
  const stop = useMutation({
    mutationFn: (errandId: string) => stopBrowserErrand(errandId),
    onMutate: () => setStopError(undefined),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey }),
    onError: (error) => setStopError(describeApiError(error).summary),
  });

  const fromResult = fallbackResult ? statusFromResult(toolRunId, fallbackResult) : undefined;
  const view = query.data ?? fromResult;
  if (!view) {
    if (query.isError) {
      return <p className="mt-3 text-sm text-status-failed">{describeApiError(query.error).summary}</p>;
    }
    return query.isPending || toolRunOpen ? (
      <p className="mt-3 text-xs text-fg-muted">Starting the browser errand…</p>
    ) : null;
  }

  const presentation = presentBrowserErrand(view.state, view.outcome);
  const finished = view.state === "finished";
  const answer = fallbackResult && view.outcome === "done" ? text(fallbackResult.answer) : undefined;
  const resultText =
    answer ?? view.summary ?? text(fallbackResult?.summary) ?? (view.outcome ? OUTCOME_COPY[view.outcome] : undefined);
  const requests = Math.max(view.modelRequests, count(fallbackResult?.modelRequests) ?? 0);
  const imageId = finished
    ? (view.finalAttachmentId ?? text(fallbackResult?.finalScreenshotAttachmentId))
    : view.thumbnailAttachmentId;
  const canStop = !finished && view.errandId !== "";

  return (
    <section aria-label="Browser errand" className="mt-3 border-t border-line-subtle pt-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Globe aria-hidden="true" className="size-4 text-fg-muted" />
          <h3 className="font-semibold text-fg">Browser errand</h3>
          <StatusBadge status={presentation} />
        </div>
        {canStop ? (
          <Button size="sm" disabled={stop.isPending} onClick={() => stop.mutate(view.errandId)}>
            {stop.isPending ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </div>
      {finished ? (
        resultText ? (
          <p className="mt-2 whitespace-pre-wrap text-fg-secondary">{resultText}</p>
        ) : null
      ) : (
        <>
          <p className="mt-2 text-fg-secondary">
            {view.state === "waiting_on_you"
              ? "Waiting for your decision before the next step."
              : view.state === "taken_over"
                ? "Paused so you can use the browser window."
                : view.stepText || "Getting started…"}
          </p>
          {view.stepCount > 0 ? <p className="mt-1 text-xs text-fg-muted">Step {view.stepCount}</p> : null}
        </>
      )}
      {imageId ? (
        <AttachmentImage
          attachmentId={imageId}
          alt={finished ? "Final view of the browser window" : "Latest view of the browser window"}
          className={IMAGE_CLASS}
        />
      ) : null}
      {finished && requests > 0 ? (
        <p className="mt-2 text-xs text-fg-muted">{plural(requests, "model request")}</p>
      ) : null}
      {stopError ? <p className="mt-2 text-xs text-status-failed">{stopError}</p> : null}
    </section>
  );
}

/** One card for each browser.errand run in a turn. */
export function ChatBrowserErrandCards({ toolRuns }: { toolRuns: readonly ChatToolRunRecord[] }) {
  return toolRuns
    .filter((run) => run.toolName === "browser.errand")
    .map((run) => (
      <ChatBrowserErrandCard
        key={run.toolRunId}
        toolRunId={run.toolRunId}
        fallbackResult={run.result}
        toolRunOpen={run.status === "started" || run.status === "approval_required"}
      />
    ));
}
