import {
  fetchMemoryMaintenanceStatus,
  fetchMemoryMaintenanceRecommendations,
  acceptMemoryMaintenanceRecommendation,
  rejectMemoryMaintenanceRecommendation,
  runMemoryMaintenanceNow,
} from "@goatcitadel/mission-control-shared/api/client";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { StatusBadge } from "../../ui/StatusBadge";
import { maintenanceSourceLabel, presentMaintenanceRun, presentRecommendation } from "./memory-diagnostics-vocabulary";
import {
  FACTS,
  readableValues,
  same,
  stamp,
  type MemorySnapshot,
  type RequestReview,
} from "./memory-diagnostics-shared";
import { MemoryPolicy } from "./LibraryMemoryPolicy";

type MaintenanceRecommendation = MemorySnapshot["maintenanceRecommendations"][number];

/** The "Memory maintenance" view: policy, manual runs, recommendations, run history and run provenance. */
export function MemoryMaintenanceView({
  workspaceId,
  data,
  disabled,
  request,
  presentationScope,
  ownerScope,
  onInspectRun,
}: {
  workspaceId: string;
  data: MemorySnapshot | null;
  disabled: boolean;
  request: RequestReview;
  presentationScope: string;
  ownerScope: string;
  onInspectRun: (runId: string) => void;
}) {
  return (
    <>
      {!data?.maintenanceEnabled || !data.maintenanceDurableReady ? (
        <Callout>
          Memory maintenance needs the maintenance and resumable runs features turned on. Controls stay locked.
        </Callout>
      ) : (
        <>
          {data.maintenanceStatus?.policy ? (
            <MemoryPolicy
              policy={data.maintenanceStatus.policy}
              scope={presentationScope}
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
                  "Queue a maintenance run under the current policy. Starting it is not the same as finishing it.",
                revision: data.maintenanceStatus?.policy.revision ?? "",
                maintenance: true,
                check: async () =>
                  same((await fetchMemoryMaintenanceStatus(workspaceId)).policy, data.maintenanceStatus?.policy),
                apply: async () => {
                  const admitted = await runMemoryMaintenanceNow({ workspaceId, triggerSource: "manual" });
                  if (admitted.workspaceId !== workspaceId || !admitted.runId || !admitted.durableRunId)
                    throw new Error("The maintenance response does not match this workspace and run.");
                  return "Maintenance accepted. Open its run below to follow progress and results.";
                },
              })
            }
          >
            Review maintenance run
          </Button>
          <h3 className="font-semibold">Maintenance recommendations</h3>
          <ul className="grid min-w-0 max-w-full grid-cols-1 gap-2">
            {data.maintenanceRecommendations.map((item) => (
              <RecommendationItem
                key={item.recommendationId}
                item={item}
                data={data}
                workspaceId={workspaceId}
                disabled={disabled}
                request={request}
              />
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
            <Button onClick={() => onInspectRun(run.runId)}>Inspect maintenance run</Button>
            {run.durableRunId ? (
              <NativeOwnerLink
                className="inline-flex min-h-11 max-w-full items-center wrap-anywhere"
                scope={ownerScope}
                href={"/work/runs/" + encodeURIComponent(run.durableRunId) + "?shell=cockpit"}
              >
                Open maintenance run
              </NativeOwnerLink>
            ) : null}
          </li>
        ))}
      </ul>
      {data?.selectedRunProvenance ? <RunProvenance provenance={data.selectedRunProvenance} /> : null}
    </>
  );
}

function RecommendationItem({
  item,
  data,
  workspaceId,
  disabled,
  request,
}: {
  item: MaintenanceRecommendation;
  data: MemorySnapshot;
  workspaceId: string;
  disabled: boolean;
  request: RequestReview;
}) {
  return (
    <li className="rounded-md border border-line p-3">
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
              label: action === "accept" ? "Accept maintenance recommendation" : "Reject maintenance recommendation",
              consequence:
                item.summary +
                (action === "accept" ? ". Apply its reviewed policy changes." : ". Leave the policy unchanged."),
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
                same((await fetchMemoryMaintenanceStatus(workspaceId)).policy, data.maintenanceStatus?.policy);
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
                  "Recommendation " + action + " receipt returned. The policy and recommendation below are refreshed."
                );
              },
            })
          }
        >
          Review {action} recommendation
        </Button>
      ))}
    </li>
  );
}

function RunProvenance({ provenance }: { provenance: NonNullable<MemorySnapshot["selectedRunProvenance"]> }) {
  return (
    <section
      className="grid min-w-0 max-w-full grid-cols-1 gap-2 wrap-anywhere"
      aria-label="Maintenance run provenance"
    >
      <div className="flex flex-wrap items-center gap-1">
        <StatusBadge status={presentMaintenanceRun(provenance.run.status)} />
        <span>{provenance.run.summary}</span>
      </div>
      <h4>Sources</h4>
      <ul className="grid min-w-0 grid-cols-1 gap-2">
        {provenance.sources.map((source) => (
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
        {provenance.changes.map((change) => (
          <li className="min-w-0" key={change.changeId}>
            <p className="whitespace-pre-wrap wrap-anywhere">{change.summary}</p>
            <TechnicalDetails label="Change provenance">
              <p>
                {change.targetKind} · {change.targetRef} · {change.beforeRef} → {change.afterRef} · {change.createdAt}
              </p>
            </TechnicalDetails>
          </li>
        ))}
      </ul>
    </section>
  );
}
