import { fetchMemoryDecisions, addMemoryDecisionRetrospective } from "@goatcitadel/mission-control-shared/api/client";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import {
  authorityLabel,
  freeformLabel,
  retrospectiveLabel,
  structuredScopeLabel,
  structuredStatusLabel,
} from "./memory-diagnostics-vocabulary";
import { FACTS, Fact, same, stamp, type MemorySnapshot, type RequestReview } from "./memory-diagnostics-shared";

type MemoryDecision = MemorySnapshot["memoryDecisions"][number];

/** The "Entities and decisions" view: entities, relations and the decision journal. */
export function MemoryGraphView({
  workspaceId,
  data,
  disabled,
  request,
}: {
  workspaceId: string;
  data: MemorySnapshot | null;
  disabled: boolean;
  request: RequestReview;
}) {
  return (
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
          <DecisionItem key={item.id} item={item} workspaceId={workspaceId} disabled={disabled} request={request} />
        ))}
      </ul>
    </>
  );
}

function DecisionItem({
  item,
  workspaceId,
  disabled,
  request,
}: {
  item: MemoryDecision;
  workspaceId: string;
  disabled: boolean;
  request: RequestReview;
}) {
  return (
    <li className="rounded-md border border-line p-3">
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
  );
}
