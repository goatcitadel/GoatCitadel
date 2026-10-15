import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  canonicalJsonString,
  type MemoryRetrievalBenchmarkResponse,
  type MemoryMaintenancePolicyRecord,
} from "@goatcitadel/contracts";
import { useMemoryOperatorSnapshot } from "@goatcitadel/mission-control-shared/hooks/useMemoryOperatorSnapshot";
import {
  fetchSettings,
  fetchEvidenceEnvelopes,
  runMemoryRetrievalBenchmark,
  fetchMemoryQualityIssues,
  patchMemoryQualityIssue,
  runMemoryQualityScan,
  fetchMemoryDecisions,
  addMemoryDecisionRetrospective,
  fetchMemoryMaintenanceStatus,
  fetchMemoryMaintenanceRecommendations,
  acceptMemoryMaintenanceRecommendation,
  rejectMemoryMaintenanceRecommendation,
  runMemoryMaintenanceNow,
  patchMemoryMaintenancePolicy,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  buildMemoryMaintenancePolicyPatch,
  toMemoryMaintenancePolicyDraft,
} from "@goatcitadel/mission-control-shared/content/memory-helpers";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useLibraryOperation } from "./use-library-operation";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { StatusBadge } from "../../ui/StatusBadge";
import { TimeText } from "../../ui/TimeText";
import { formatDuration, plural } from "@goatcitadel/mission-control-shared/content/format";
import {
  ADMIN_STATE,
  RUN_MODE,
  authorityLabel,
  evidenceKindLabel,
  feedbackKindLabel,
  feedbackStatusLabel,
  freeformLabel,
  maintenancePolicySentence,
  maintenanceSourceLabel,
  presentIssueSeverity,
  presentIssueStatus,
  presentMaintenanceRun,
  presentRecommendation,
  retrospectiveLabel,
  signatureLabel,
  structuredScopeLabel,
  structuredStatusLabel,
} from "./memory-diagnostics-vocabulary";

type Review = {
  label: string;
  consequence: string;
  revision: string;
  values?: Record<string, unknown>;
  maintenance?: boolean;
  check: () => Promise<void>;
  apply: () => Promise<string>;
};
function readableValues(value: unknown): string {
  if (Array.isArray(value)) return value.map(readableValues).join(", ");
  if (value && typeof value === "object")
    return Object.entries(value)
      .map(([key, entry]) => `${key.replace(/([A-Z])/g, " $1")}: ${readableValues(entry)}`)
      .join("; ");
  return value == null ? "Default" : String(value);
}
const stamp = (value?: string) => (value ? <TimeText value={value} /> : "Not recorded");
/** One labelled fact in a diagnostics record. */
const Fact = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="flex min-w-0 flex-wrap gap-x-2">
    <dt className="text-fg-secondary">{term}</dt>
    <dd className="min-w-0">{children}</dd>
  </div>
);
const FACTS = "grid min-w-0 grid-cols-1 gap-1 text-sm";
function same(actual: unknown, reviewed: unknown) {
  if (canonicalJsonString(actual) !== canonicalJsonString(reviewed))
    throw new Error("The reviewed record changed. Refresh and review the current record.");
}
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
        <>
          <h3 className="font-semibold">Write evidence</h3>
          <Button onClick={() => void evidence.refetch()}>Refresh write evidence</Button>
          {evidence.error ? <Callout tone="error">{describeApiError(evidence.error).summary}</Callout> : null}
          <ul className="grid min-w-0 max-w-full grid-cols-1 gap-2">
            {evidence.data?.items.map((item) => (
              <li key={item.envelopeId}>
                {evidenceKindLabel(item.eventKind)} · {signatureLabel(item.signatureStatus)} · {stamp(item.createdAt)}
                <TechnicalDetails label="Write evidence provenance">
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
                consequence:
                  "Inspect workspace memory and record quality findings. This does not approve a memory write.",
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
          <ul className="grid min-w-0 max-w-full grid-cols-1 gap-3">
            {data?.memoryQualityIssues
              .filter((item) => item.workspaceId === workspaceId)
              .map((item) => (
                <li key={item.issueId} className="rounded-md border border-line p-3">
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
                              if (
                                next.issueId !== item.issueId ||
                                next.workspaceId !== workspaceId ||
                                next.status !== status
                              )
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
                value={recall.value.prompt}
                onChange={(event) => recall.setValue({ prompt: event.target.value })}
              />
            )}
          </Field>
          <Button
            disabled={disabled || !recall.value.prompt.trim()}
            onClick={() =>
              request({
                label: "Run recall probe",
                consequence: recall.value.prompt,
                revision: recall.value.prompt,
                check: async () => {},
                apply: async () => {
                  const result = await runMemoryRetrievalBenchmark({
                    prompts: [recall.value.prompt],
                    workspace: workspaceId,
                    relationScope: "self",
                    maxContextTokens: 4000,
                  });
                  if (operation.current()) setBenchmark(result);
                  return "Recall benchmark completed; this measures retrieval and does not promote memory.";
                },
              })
            }
          >
            Review recall probe
          </Button>
          {benchmark ? (
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
              <TechnicalDetails label="Recall evidence">
                <pre className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">
                  {JSON.stringify(benchmark, null, 2)}
                </pre>
              </TechnicalDetails>
            </section>
          ) : null}
        </>
      ) : null}
      {view === "graph" ? (
        <>
          <h3 className="font-semibold">Entities</h3>
          <ul className="grid min-w-0 max-w-full grid-cols-1 gap-2">
            {data?.memoryEntities.map((item) => (
              <li key={item.id} className="rounded-md border border-line p-3">
                <h4>{item.title}</h4>
                <p>{item.summary}</p>
                <dl className={FACTS}>
                  <Fact term="Type">{freeformLabel(item.entityType, "Not typed")}</Fact>
                  <Fact term="Scope">{structuredScopeLabel(item.scope)}</Fact>
                  <Fact term="Source">{authorityLabel(item.authority)}</Fact>
                  <Fact term="Status">{structuredStatusLabel(item.status)}</Fact>
                  <Fact term="Aliases">{item.aliases.join(", ") || "None"}</Fact>
                </dl>
                <TechnicalDetails label="Entity provenance">
                  <pre className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">
                    {JSON.stringify(item.sourceRefs, null, 2)}
                  </pre>
                  <p>
                    {item.id} · {item.updatedAt}
                  </p>
                </TechnicalDetails>
              </li>
            ))}
          </ul>
          <h3 className="font-semibold">Relations</h3>
          <ul>
            {data?.memoryRelations.map((item) => (
              <li key={item.id}>
                <h4>{item.title}</h4>
                <p>
                  {data.memoryEntities.find((entity) => entity.id === item.fromEntityId)?.title ?? "Unknown entity"} →{" "}
                  {freeformLabel(item.relationType, "Related to")} →
                  {data.memoryEntities.find((entity) => entity.id === item.toEntityId)?.title ?? "Unknown entity"}
                </p>
                <dl className={FACTS}>
                  <Fact term="Status">{structuredStatusLabel(item.status)}</Fact>
                  <Fact term="Scope">{structuredScopeLabel(item.scope)}</Fact>
                  {item.degradedReason ? <Fact term="Degraded because">{item.degradedReason}</Fact> : null}
                </dl>
                <TechnicalDetails label="Relation provenance">
                  <pre className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">
                    {JSON.stringify(item.sourceRefs, null, 2)}
                  </pre>
                  <p>
                    {item.id} · {item.updatedAt}
                  </p>
                </TechnicalDetails>
              </li>
            ))}
          </ul>
          <h3 className="font-semibold">Decision journal</h3>
          <ul className="grid min-w-0 max-w-full grid-cols-1 gap-2">
            {data?.memoryDecisions.map((item) => (
              <li key={item.id} className="rounded-md border border-line p-3">
                <h4>{item.title}</h4>
                <p>{item.decision}</p>
                <dl className={FACTS}>
                  <Fact term="Rationale">{item.rationale}</Fact>
                  <Fact term="Alternatives">{item.alternatives.join(", ") || "None recorded"}</Fact>
                  <Fact term="Expected outcome">{item.expectedOutcome ?? "Not recorded"}</Fact>
                  <Fact term="Review due">{stamp(item.reviewAt)}</Fact>
                  <Fact term="Status">{structuredStatusLabel(item.status)}</Fact>
                  <Fact term="Scope">{structuredScopeLabel(item.scope)}</Fact>
                  {item.retrospective ? (
                    <Fact term="Retrospective">
                      {retrospectiveLabel(item.retrospective.outcome)} · {item.retrospective.notes}
                    </Fact>
                  ) : null}
                </dl>
                <TechnicalDetails label="Decision provenance">
                  <pre className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">
                    {JSON.stringify(item.sourceRefs, null, 2)}
                  </pre>
                  <p>
                    {item.id} · {item.updatedAt}
                  </p>
                </TechnicalDetails>
                <Button
                  disabled={disabled}
                  onClick={() =>
                    request({
                      label: "Record decision retrospective",
                      consequence:
                        "Record a review with outcome unknown for " +
                        item.title +
                        ". This does not claim the decision was validated.",
                      revision: item.updatedAt,
                      check: async () =>
                        same(
                          (await fetchMemoryDecisions({ workspaceId, status: "all", limit: 500 })).items.find(
                            (row) => row.id === item.id,
                          ),
                          item,
                        ),
                      apply: async () => {
                        const next = await addMemoryDecisionRetrospective(item.id, {
                          outcome: "unknown",
                          notes: "Reviewed from Mission Control Library memory panel.",
                        });
                        if (next.id !== item.id || next.workspaceId !== workspaceId)
                          throw new Error("Decision receipt mismatch.");
                        return "Decision review recorded with outcome unknown.";
                      },
                    })
                  }
                >
                  Review decision retrospective
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {view === "maintenance" ? (
        <>
          {!data?.maintenanceEnabled || !data.maintenanceDurableReady ? (
            <Callout>
              Memory maintenance requires the maintenance and durable execution features. Controls remain locked.
            </Callout>
          ) : (
            <>
              {data.maintenanceStatus?.policy ? (
                <MemoryPolicy
                  policy={data.maintenanceStatus.policy}
                  scope={operation.presentationScope}
                  disabled={disabled}
                  request={request}
                />
              ) : null}
              <Button
                disabled={disabled}
                onClick={() =>
                  request({
                    label: "Run memory maintenance",
                    consequence:
                      "Queue a durable maintenance run under the current policy. Admission is separate from completed work.",
                    revision: data.maintenanceStatus?.policy.revision ?? "",
                    maintenance: true,
                    check: async () =>
                      same((await fetchMemoryMaintenanceStatus(workspaceId)).policy, data.maintenanceStatus?.policy),
                    apply: async () => {
                      const admitted = await runMemoryMaintenanceNow({ workspaceId, triggerSource: "manual" });
                      if (admitted.workspaceId !== workspaceId || !admitted.runId || !admitted.durableRunId)
                        throw new Error("Maintenance receipt does not identify this workspace and durable run.");
                      return "Maintenance admitted. Read its canonical run below to verify progress and effects.";
                    },
                  })
                }
              >
                Review maintenance run
              </Button>
              <h3 className="font-semibold">Maintenance recommendations</h3>
              <ul className="grid min-w-0 max-w-full grid-cols-1 gap-2">
                {data.maintenanceRecommendations.map((item) => (
                  <li key={item.recommendationId} className="rounded-md border border-line p-3">
                    <h4>{item.summary}</h4>
                    <p>{item.rationale}</p>
                    <div className="flex flex-wrap items-center gap-1">
                      <StatusBadge status={presentRecommendation(item.status)} />
                      <span className="text-sm text-fg-secondary">Updated {stamp(item.updatedAt)}</span>
                    </div>
                    <dl className={FACTS}>
                      {Object.entries(item.proposedPatch).map(([key, value]) => (
                        <div key={key}>
                          <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                          <dd>{readableValues(value)}</dd>
                        </div>
                      ))}
                    </dl>
                    <TechnicalDetails label="Recommendation exact values">
                      <pre className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">
                        {JSON.stringify(item.proposedPatch, null, 2)}
                      </pre>
                      <p>
                        {item.revision} · {item.updatedAt}
                      </p>
                    </TechnicalDetails>
                    {(["accept", "reject"] as const).map((action) => (
                      <Button
                        key={action}
                        disabled={disabled || item.status !== "queued"}
                        onClick={() =>
                          request({
                            label:
                              action === "accept"
                                ? "Accept maintenance recommendation"
                                : "Reject maintenance recommendation",
                            consequence:
                              item.summary +
                              (action === "accept"
                                ? ". Apply its reviewed policy changes."
                                : ". Leave the policy unchanged."),
                            revision: item.revision,
                            values: item.proposedPatch,
                            maintenance: true,
                            check: async () => {
                              same(
                                (await fetchMemoryMaintenanceRecommendations(workspaceId, 100)).items.find(
                                  (row) => row.recommendationId === item.recommendationId,
                                ),
                                item,
                              );
                              same(
                                (await fetchMemoryMaintenanceStatus(workspaceId)).policy,
                                data.maintenanceStatus?.policy,
                              );
                            },
                            apply: async () => {
                              if (action === "accept") {
                                const result = await acceptMemoryMaintenanceRecommendation(item.recommendationId, {
                                  expectedRevision: item.revision,
                                  expectedPolicyRevision: data.maintenanceStatus!.policy.revision,
                                });
                                if (
                                  result.recommendation.recommendationId !== item.recommendationId ||
                                  result.recommendation.workspaceId !== workspaceId ||
                                  result.recommendation.status !== "applied" ||
                                  result.policy.workspaceId !== workspaceId ||
                                  result.policy.revision === data.maintenanceStatus!.policy.revision
                                )
                                  throw new Error("Recommendation acceptance receipt mismatch.");
                              } else {
                                const result = await rejectMemoryMaintenanceRecommendation(item.recommendationId, {
                                  expectedRevision: item.revision,
                                });
                                if (
                                  result.recommendationId !== item.recommendationId ||
                                  result.workspaceId !== workspaceId ||
                                  result.status !== "rejected"
                                )
                                  throw new Error("Recommendation rejection receipt mismatch.");
                              }
                              return (
                                "Recommendation " +
                                action +
                                " receipt returned. Refreshed policy and recommendation below are canonical."
                              );
                            },
                          })
                        }
                      >
                        Review {action} recommendation
                      </Button>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3 className="font-semibold">Maintenance history</h3>
          <ul>
            {data?.maintenanceRuns.map((run) => (
              <li key={run.runId}>
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge status={presentMaintenanceRun(run.status)} />
                  <span className="text-sm text-fg-secondary">Started {stamp(run.createdAt)}</span>
                </div>
                {(run.summary ?? run.error) ? <p>{run.summary ?? run.error}</p> : null}
                <Button onClick={() => memory.setSelectedRunId(run.runId)}>Inspect maintenance run</Button>
                {run.durableRunId ? (
                  <NativeOwnerLink
                    className="inline-flex min-h-11 max-w-full items-center wrap-anywhere"
                    scope={operation.identity}
                    href={"/work/runs/" + encodeURIComponent(run.durableRunId) + "?shell=cockpit"}
                  >
                    Open durable maintenance run
                  </NativeOwnerLink>
                ) : null}
              </li>
            ))}
          </ul>
          {data?.selectedRunProvenance ? (
            <section
              className="grid min-w-0 max-w-full grid-cols-1 gap-2 wrap-anywhere"
              aria-label="Maintenance run provenance"
            >
              <div className="flex flex-wrap items-center gap-1">
                <StatusBadge status={presentMaintenanceRun(data.selectedRunProvenance.run.status)} />
                <span>{data.selectedRunProvenance.run.summary}</span>
              </div>
              <h4>Sources</h4>
              <ul className="grid min-w-0 grid-cols-1 gap-2">
                {data.selectedRunProvenance.sources.map((source) => (
                  <li className="min-w-0" key={source.sourceId}>
                    <p className="whitespace-pre-wrap wrap-anywhere">
                      {maintenanceSourceLabel(source.sourceKind)} · {source.excerpt}
                    </p>
                    <TechnicalDetails label="Source reference">
                      <p>
                        {source.sourceRef} · {source.modifiedAt}
                      </p>
                    </TechnicalDetails>
                  </li>
                ))}
              </ul>
              <h4>Changes</h4>
              <ul className="grid min-w-0 grid-cols-1 gap-2">
                {data.selectedRunProvenance.changes.map((change) => (
                  <li className="min-w-0" key={change.changeId}>
                    <p className="whitespace-pre-wrap wrap-anywhere">{change.summary}</p>
                    <TechnicalDetails label="Change provenance">
                      <p>
                        {change.targetKind} · {change.targetRef} · {change.beforeRef} → {change.afterRef} ·{" "}
                        {change.createdAt}
                      </p>
                    </TechnicalDetails>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
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
function MemoryPolicy({
  policy,
  scope,
  disabled,
  request,
}: {
  policy: MemoryMaintenancePolicyRecord;
  scope: string;
  disabled: boolean;
  request: (review: Review) => void;
}) {
  const draft = useSessionDraft(scope + ":policy", toMemoryMaintenancePolicyDraft(policy), policy.revision, {
    label: "Memory maintenance policy",
  });
  return (
    <details>
      <summary className="min-h-11">Edit maintenance policy{draft.isDirty ? " · Unsaved" : ""}</summary>
      <div className="grid min-w-0 max-w-full grid-cols-1 gap-3">
        <label className="flex min-h-11 min-w-0 items-center gap-2">
          <input
            className="shrink-0"
            type="checkbox"
            checked={draft.value.enabled}
            onChange={(event) => draft.setValue((value) => ({ ...value, enabled: event.target.checked }))}
          />{" "}
          Maintenance enabled
        </label>
        <Field label="Maintenance run mode">
          {(props) => (
            <select
              {...props}
              className="min-w-0 w-full max-w-full"
              value={draft.value.runMode}
              onChange={(event) =>
                draft.setValue((value) => ({ ...value, runMode: event.target.value as typeof value.runMode }))
              }
            >
              {(Object.keys(RUN_MODE) as (keyof typeof RUN_MODE)[]).map((mode) => (
                <option key={mode} value={mode}>
                  {RUN_MODE[mode]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {(["providerId", "model"] as const).map((key) => (
          <Field key={key} label={key === "providerId" ? "Maintenance provider" : "Maintenance model"}>
            {(props) => (
              <input
                {...props}
                className="min-w-0 w-full max-w-full rounded-md border border-line bg-canvas p-2"
                value={draft.value[key]}
                onChange={(event) => draft.setValue((value) => ({ ...value, [key]: event.target.value }))}
              />
            )}
          </Field>
        ))}
        {draft.hasRemoteChanges ? (
          <Callout tone="warning">
            The policy changed. Your draft remains separate. Review current policy before rebasing.
            <p>
              Current: {maintenancePolicySentence(policy.enabled, policy.runMode)}{" "}
              {policy.providerId || policy.model
                ? "It uses a chosen provider and model."
                : "It uses the default provider and model."}
            </p>
            <Button onClick={draft.rebaseToCurrent}>Use current policy revision and keep draft</Button>
          </Callout>
        ) : null}
        <Button
          disabled={disabled || draft.hasRemoteChanges || !draft.isDirty}
          onClick={() => {
            const patch = buildMemoryMaintenancePolicyPatch(draft.value);
            request({
              label: "Save maintenance policy",
              consequence:
                maintenancePolicySentence(draft.value.enabled, draft.value.runMode) +
                " " +
                (draft.value.providerId || draft.value.model
                  ? "It uses the provider and model you chose."
                  : "It uses the default provider and model.") +
                " The exact reviewed policy values below are applied.",
              values: patch as Record<string, unknown>,
              revision: policy.revision,
              maintenance: true,
              check: async () => same((await fetchMemoryMaintenanceStatus(policy.workspaceId)).policy, policy),
              apply: async () => {
                const updated = await patchMemoryMaintenancePolicy(policy.workspaceId, {
                  ...patch,
                  expectedRevision: policy.revision,
                });
                if (
                  updated.workspaceId !== policy.workspaceId ||
                  !updated.revision ||
                  updated.revision === policy.revision
                )
                  throw new Error("Policy receipt does not confirm the reviewed revision.");
                same(buildMemoryMaintenancePolicyPatch(toMemoryMaintenancePolicyDraft(updated)), patch);
                draft.acceptSaved(toMemoryMaintenancePolicyDraft(updated), updated.revision, draft.value);
                return "Memory maintenance policy saved with a new canonical revision.";
              },
            });
          }}
        >
          Review policy changes
        </Button>
        <Button variant="secondary" onClick={draft.discard}>
          Discard policy changes
        </Button>
        <TechnicalDetails label="Current policy values">
          <pre className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere">{JSON.stringify(policy, null, 2)}</pre>
        </TechnicalDetails>
      </div>
    </details>
  );
}
