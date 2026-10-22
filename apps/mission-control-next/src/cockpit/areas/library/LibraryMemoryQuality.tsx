import type { UseQueryResult } from "@tanstack/react-query";
import type { MemoryRetrievalBenchmarkResponse } from "@goatcitadel/contracts";
import {
  fetchEvidenceEnvelopes,
  runMemoryRetrievalBenchmark,
  fetchMemoryQualityIssues,
  patchMemoryQualityIssue,
  runMemoryQualityScan,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { formatDuration, plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Callout } from "../../ui/Callout";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { StatusBadge } from "../../ui/StatusBadge";
import {
  evidenceKindLabel,
  feedbackKindLabel,
  feedbackStatusLabel,
  presentIssueSeverity,
  presentIssueStatus,
  signatureLabel,
} from "./memory-diagnostics-vocabulary";
import { same, stamp, type MemorySnapshot, type RequestReview } from "./memory-diagnostics-shared";

type QualityIssue = MemorySnapshot["memoryQualityIssues"][number];

/** The "Memory quality" view: write evidence, quality issues, recall feedback and the recall probe. */
export function MemoryQualityView({
  workspaceId,
  data,
  evidence,
  disabled,
  request,
  recallPrompt,
  onRecallPromptChange,
  benchmark,
  onBenchmark,
}: {
  workspaceId: string;
  data: MemorySnapshot | null;
  evidence: UseQueryResult<Awaited<ReturnType<typeof fetchEvidenceEnvelopes>>>;
  disabled: boolean;
  request: RequestReview;
  recallPrompt: string;
  onRecallPromptChange: (prompt: string) => void;
  benchmark: MemoryRetrievalBenchmarkResponse | undefined;
  onBenchmark: (result: MemoryRetrievalBenchmarkResponse) => void;
}) {
  return (
    <>
      <h3 className="font-semibold">Write records</h3>
      <Button onClick={() => void evidence.refetch()}>Check again</Button>
      {evidence.error ? <Callout tone="error">{describeApiError(evidence.error).summary}</Callout> : null}
      <ul className="grid min-w-0 max-w-full grid-cols-1 gap-2">
        {evidence.data?.items.map((item) => (
          <li key={item.envelopeId}>
            {evidenceKindLabel(item.eventKind)} · {signatureLabel(item.signatureStatus)} · {stamp(item.createdAt)}
            <TechnicalDetails label="Write record provenance">
              <p>
                {item.envelopeId} · {item.contentHash} · {item.createdAt}
              </p>
            </TechnicalDetails>
          </li>
        ))}
      </ul>
      <h3 className="font-semibold">Quality issues</h3>
      <Button
        disabled={disabled}
        onClick={() =>
          request({
            label: "Scan memory quality",
            consequence: "Inspect workspace memory and record quality findings. This does not approve a memory write.",
            revision: "scan",
            check: async () => {},
            apply: async () => {
              const result = await runMemoryQualityScan({ workspaceId });
              if (result.workspaceId !== workspaceId) throw new Error("Foreign quality scan receipt.");
              return "Quality scan recorded " + plural(result.issueCount, "issue") + ".";
            },
          })
        }
      >
        Review quality scan
      </Button>
      <ul className="grid min-w-0 max-w-full grid-cols-1 divide-y divide-line-subtle">
        {data?.memoryQualityIssues
          .filter((item) => item.workspaceId === workspaceId)
          .map((item) => (
            <QualityIssueItem
              key={item.issueId}
              item={item}
              workspaceId={workspaceId}
              disabled={disabled}
              request={request}
            />
          ))}
      </ul>
      <h3 className="font-semibold">Recall feedback</h3>
      <ul>
        {data?.memoryFeedback.map((item) => (
          <li key={item.feedbackId}>
            {feedbackKindLabel(item.kind)} · {feedbackStatusLabel(item.status)} · {stamp(item.createdAt)}
            <TechnicalDetails label="Feedback provenance">
              <pre className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">
                {JSON.stringify(item, null, 2)}
              </pre>
            </TechnicalDetails>
          </li>
        ))}
      </ul>
      <h3 className="font-semibold">Recall probe</h3>
      <Field label="Recall prompt">
        {(props) => (
          <textarea
            {...props}
            className="min-h-20 min-w-0 w-full max-w-full rounded-md border border-line bg-canvas p-2"
            value={recallPrompt}
            onChange={(event) => onRecallPromptChange(event.target.value)}
          />
        )}
      </Field>
      <Button
        disabled={disabled || !recallPrompt.trim()}
        onClick={() =>
          request({
            label: "Run recall probe",
            consequence: recallPrompt,
            revision: recallPrompt,
            check: async () => {},
            apply: async () => {
              const result = await runMemoryRetrievalBenchmark({
                prompts: [recallPrompt],
                workspace: workspaceId,
                relationScope: "self",
                maxContextTokens: 4000,
              });
              onBenchmark(result);
              return "Recall benchmark completed; this measures retrieval and does not promote memory.";
            },
          })
        }
      >
        Review recall probe
      </Button>
      {benchmark ? <RecallProbeResult benchmark={benchmark} /> : null}
    </>
  );
}

function QualityIssueItem({
  item,
  workspaceId,
  disabled,
  request,
}: {
  item: QualityIssue;
  workspaceId: string;
  disabled: boolean;
  request: RequestReview;
}) {
  return (
    <li className="py-3">
      <h4>{item.summary}</h4>
      <div className="flex flex-wrap items-center gap-1">
        <StatusBadge status={presentIssueSeverity(item.severity)} />
        <StatusBadge status={presentIssueStatus(item.status)} />
        <span className="text-sm text-fg-secondary">Updated {stamp(item.updatedAt)}</span>
      </div>
      <p>{item.rationale}</p>
      <TechnicalDetails label="Quality issue provenance">
        <pre className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">
          {JSON.stringify(
            {
              targetKind: item.targetKind,
              targetRef: item.targetRef,
              evidenceRefs: item.evidenceRefs,
              updatedAt: item.updatedAt,
            },
            null,
            2,
          )}
        </pre>
      </TechnicalDetails>
      {(["resolved", "dismissed", "open"] as const)
        .filter((status) => status !== item.status)
        .map((status) => (
          <Button
            key={status}
            disabled={disabled}
            onClick={() =>
              request({
                label:
                  status === "open"
                    ? "Reopen quality issue"
                    : status === "resolved"
                      ? "Resolve quality issue"
                      : "Dismiss quality issue",
                consequence: item.summary,
                revision: item.updatedAt,
                check: async () =>
                  same(
                    (await fetchMemoryQualityIssues({ workspaceId, status: "all", limit: 200 })).items.find(
                      (row) => row.issueId === item.issueId,
                    ),
                    item,
                  ),
                apply: async () => {
                  const next = await patchMemoryQualityIssue(item.issueId, { status });
                  if (next.issueId !== item.issueId || next.workspaceId !== workspaceId || next.status !== status)
                    throw new Error("Quality receipt mismatch.");
                  return "Quality issue " + presentIssueStatus(status).label.toLowerCase() + ".";
                },
              })
            }
          >
            {status === "open" ? "Review reopen" : "Review " + status}
          </Button>
        ))}
    </li>
  );
}

function RecallProbeResult({ benchmark }: { benchmark: MemoryRetrievalBenchmarkResponse }) {
  return (
    <section aria-label="Recall probe result">
      <p>
        {plural(benchmark.itemCount, "probe")} · {formatDuration(benchmark.avgLatencyMs)} on average · overlap{" "}
        {benchmark.avgOverlapScore.toFixed(2)}
      </p>
      <p>{benchmark.semanticCoverageNote}</p>
      {benchmark.warnings.map((warning) => (
        <Callout key={warning} tone="warning">
          {warning}
        </Callout>
      ))}
      <TechnicalDetails label="Recall details">
        <pre className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">{JSON.stringify(benchmark, null, 2)}</pre>
      </TechnicalDetails>
    </section>
  );
}
