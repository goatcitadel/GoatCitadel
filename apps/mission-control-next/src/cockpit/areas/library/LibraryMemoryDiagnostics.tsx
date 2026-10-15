import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MemoryRetrievalBenchmarkResponse } from "@goatcitadel/contracts";
import { useMemoryOperatorSnapshot } from "@goatcitadel/mission-control-shared/hooks/useMemoryOperatorSnapshot";
import { fetchSettings, fetchEvidenceEnvelopes } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useLibraryOperation } from "./use-library-operation";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { ADMIN_STATE } from "./memory-diagnostics-vocabulary";
import { readableValues, type Review } from "./memory-diagnostics-shared";
import { MemoryQualityView } from "./LibraryMemoryQuality";
import { MemoryGraphView } from "./LibraryMemoryGraph";
import { MemoryMaintenanceView } from "./LibraryMemoryMaintenance";

export function LibraryMemoryDiagnostics({ workspaceId }: { workspaceId: string }) {
  const access = useLibraryOperation(JSON.stringify(["memory-diagnostics", workspaceId]));
  return <MemoryDiagnostics key={access.identity} workspaceId={workspaceId} />;
}
function MemoryDiagnostics({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["memory-diagnostics", workspaceId]));
  const [view, setView] = useState<"quality" | "graph" | "maintenance">("quality");
  const memory = useMemoryOperatorSnapshot(workspaceId, { view, itemDetailsOpen: false });
  const data = memory.data;
  const evidence = useQuery({
    queryKey: ["library", "memory-evidence", operation.identity],
    queryFn: () => fetchEvidenceEnvelopes({ workspaceId, limit: 12 }),
    enabled: view === "quality",
    staleTime: 0,
  });
  const [review, setReview] = useState<Review>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const [receipt, setReceipt] = useSessionViewState<string | undefined>(
    operation.presentationScope + ":receipt",
    undefined,
  );
  const recall = useSessionDraft(
    operation.presentationScope + ":recall",
    { prompt: "What prior workspace context should be reused before this task continues?" },
    undefined,
    { label: "Memory recall probe" },
  );
  const [benchmark, setBenchmark] = useState<MemoryRetrievalBenchmarkResponse>();
  const disabled = busy || operation.locked || memory.loading || !data?.memoryAdminEnabled;
  function request(next: Review) {
    if (!disabled) {
      setReceipt(undefined);
      setError(undefined);
      setReview(next);
    }
  }
  async function submit() {
    if (!review || disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await operation.run(
        review.revision,
        async () => {
          const settings = await fetchSettings();
          if (
            !settings.features.memoryLifecycleAdminV1Enabled ||
            (review.maintenance &&
              (!settings.features.memoryMaintenanceV1Enabled || !settings.features.durableKernelV1Enabled))
          )
            throw new Error("Current runtime settings do not permit this operation.");
          await review.check();
        },
        review.apply,
      );
      if (result) {
        setReceipt(result);
        setReview(undefined);
        await memory.reload();
      }
    } catch (cause) {
      if (operation.current()) setError(describeApiError(cause).summary);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="grid min-w-0 max-w-full grid-cols-1 gap-3 rounded-lg border border-line p-3 wrap-anywhere"
      aria-label="Memory diagnostics and maintenance"
    >
      <h2 className="font-display text-lg">Memory diagnostics and maintenance</h2>
      <nav aria-label="Memory diagnostic views" className="flex flex-wrap gap-2">
        {(["quality", "graph", "maintenance"] as const).map((value) => (
          <Button key={value} variant={view === value ? "primary" : "secondary"} onClick={() => setView(value)}>
            {value === "graph"
              ? "Entities and decisions"
              : value === "quality"
                ? "Memory quality"
                : "Memory maintenance"}
          </Button>
        ))}
      </nav>
      <Button disabled={memory.loading} onClick={() => void memory.reload()}>
        Refresh memory diagnostics
      </Button>
      {memory.loading ? <p role="status">Reading canonical memory diagnostics…</p> : null}
      {memory.error ? <Callout tone="error">{memory.error}</Callout> : null}
      {data && !data.memoryAdminEnabled ? (
        <Callout>Memory administration is {ADMIN_STATE[data.memoryAdminState]}. Changes stay locked.</Callout>
      ) : null}
      {Object.entries(data?.sectionErrors ?? {})
        .filter(([, value]) => value)
        .map(([key, value]) => (
          <Callout key={key} tone="warning">
            {key.replace(/([A-Z])/g, " $1")}: {value}
          </Callout>
        ))}
      {receipt ? <Callout>{receipt}</Callout> : null}
      {error ? <Callout tone="error">{error}</Callout> : null}
      {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
      {view === "quality" ? (
        <MemoryQualityView
          workspaceId={workspaceId}
          data={data}
          evidence={evidence}
          disabled={disabled}
          request={request}
          recallPrompt={recall.value.prompt}
          onRecallPromptChange={(prompt) => recall.setValue({ prompt })}
          benchmark={benchmark}
          onBenchmark={(result) => {
            if (operation.current()) setBenchmark(result);
          }}
        />
      ) : null}
      {view === "graph" ? (
        <MemoryGraphView workspaceId={workspaceId} data={data} disabled={disabled} request={request} />
      ) : null}
      {view === "maintenance" ? (
        <MemoryMaintenanceView
          workspaceId={workspaceId}
          data={data}
          disabled={disabled}
          request={request}
          presentationScope={operation.presentationScope}
          ownerScope={operation.identity}
          onInspectRun={(runId) => memory.setSelectedRunId(runId)}
        />
      ) : null}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(undefined);
        }}
        title={review?.label ?? "Review memory operation"}
      >
        <div className="grid min-w-0 max-w-full grid-cols-1 gap-3">
          <p>Applies to this workspace.</p>
          <p>{review?.consequence}</p>
          {review?.values ? (
            <dl>
              {Object.entries(review.values).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                  <dd>{readableValues(value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {error ? <Callout tone="error">{error}</Callout> : null}
          <Button disabled={disabled} onClick={() => void submit()}>
            Confirm memory operation
          </Button>
          <Button disabled={busy} variant="secondary" onClick={() => setReview(undefined)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
