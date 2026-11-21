import { useLibraryOperation } from "./use-library-operation";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canonicalJsonString, type TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import {
  fetchTraceMemoryCandidates,
  fetchTraceMemoryCandidate,
  promoteTraceMemoryCandidate,
  rejectTraceMemoryCandidate,
} from "@goatcitadel/mission-control-shared/api/memory";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { FeatureOffNotice, listedFeatureFlag } from "../settings/FeatureOffNotice";
import { useRetryWhenSwitchTurnsOn } from "../settings/feature-switches";
import { Dialog } from "../../ui/Dialog";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { StatusBadge } from "../../ui/StatusBadge";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { presentProposalStatus, proposalAuthorityLabel } from "./library-vocabulary";
import { Section } from "../../ui/Section";

export function LibraryMemoryProposals(props: Parameters<typeof LibraryMemoryProposalsContent>[0]) {
  const access = useLibraryOperation(JSON.stringify(["memory-proposals", props.workspaceId]));
  return <LibraryMemoryProposalsContent key={access.identity} {...props} />;
}
function LibraryMemoryProposalsContent({
  workspaceId,
  hideWhenEmpty = false,
}: {
  workspaceId: string;
  /** Hide the section after a successful read finds no proposals; loading and failed reads keep it. */
  hideWhenEmpty?: boolean;
}) {
  const operation = useLibraryOperation(JSON.stringify(["memory-proposals", workspaceId]));
  const client = useQueryClient();
  const [reconciliationCursor, setReconciliationCursor] = useState<string>();
  const query = useQuery({
    queryKey: ["library", "memory-proposals", workspaceId, operation.identity, reconciliationCursor],
    queryFn: () => fetchTraceMemoryCandidates({ workspaceId, limit: 100, reconciliationCursor }),
    staleTime: 0,
  });
  const settings = useQuery({
    queryKey: ["library", "memory-settings", workspaceId, operation.identity],
    queryFn: () => fetchSettings(),
    staleTime: 0,
  });
  useRetryWhenSwitchTurnsOn(
    "memoryLifecycleAdminV1Enabled",
    listedFeatureFlag(query.error) === "memoryLifecycleAdminV1Enabled",
    () => void query.refetch(),
  );
  const enabled =
    settings.data?.features.memoryLifecycleAdminV1Enabled === true && !settings.isError && !settings.isFetching;
  const proposals = query.data?.items.filter((item) => item.workspaceId === workspaceId) ?? [];
  const [review, setReview] = useState<{ item: TraceMemoryCandidateRecord; action: "promote" | "reject" }>(),
    [busy, setBusy] = useState(false),
    [outcome, setOutcome] = useState<{ error: boolean; text: string }>();
  async function confirm() {
    if (!review || operation.locked || outcome || !enabled || query.isFetching || query.isError) return;
    setBusy(true);
    try {
      const completed = await operation.run(
        review.item.updatedAt,
        async () => {
          const fresh = await fetchTraceMemoryCandidate(review.item.candidateId, { workspaceId });
          if (
            fresh.workspaceId !== workspaceId ||
            fresh.status !== "proposed" ||
            canonicalJsonString(fresh) !== canonicalJsonString(review.item)
          )
            throw new Error("The memory proposal changed during review. Refresh before deciding.");
          return fresh;
        },
        async (fresh) => {
          if (review.action === "promote") {
            const result = await promoteTraceMemoryCandidate(fresh.candidateId, {
              workspaceId,
              expectedReviewHash: fresh.reviewHash ?? "",
            });
            if (
              result.workspaceId !== workspaceId ||
              result.status !== "trusted" ||
              result.insight !== fresh.proposedInsight ||
              canonicalJsonString(result.sourceRefs) !== canonicalJsonString(fresh.sourceRefs)
            )
              throw new Error("The learning receipt does not confirm this proposal.");
          } else {
            const result = await rejectTraceMemoryCandidate(fresh.candidateId, {
              workspaceId,
              expectedReviewHash: fresh.reviewHash ?? "",
            });
            if (
              result.workspaceId !== workspaceId ||
              result.candidateId !== fresh.candidateId ||
              result.status !== "rejected"
            )
              throw new Error("Rejection is not confirmed.");
          }
          return true;
        },
      );
      if (!completed) return;
      setOutcome({
        error: false,
        text:
          review.action === "promote"
            ? "GoatCitadel confirmed promotion into a trusted workspace learning."
            : "GoatCitadel confirmed rejection.",
      });
      await client.invalidateQueries({ queryKey: ["library", "memory-proposals", workspaceId, operation.identity] });
      // A promotion adds a memory: read the memory list again so it shows next to the confirmation.
      if (review.action === "promote") await client.invalidateQueries({ queryKey: ["library", "memory", workspaceId] });
    } catch (cause) {
      if (operation.current())
        setOutcome({
          error: true,
          text: `${describeApiError(cause).summary} The decision is not confirmed. Refresh the proposal before retrying.`,
        });
    } finally {
      setBusy(false);
    }
  }
  // A shown decision or an open review keeps the section, so a confirmation never disappears with the last row.
  if (hideWhenEmpty && query.data && !query.isError && !proposals.length && !outcome && !review) return null;
  return (
    <Section
      title="Memory proposals"
      description="Proposals are not trusted memory. Promotion is a decision you make explicitly."
      actions={
        <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh memory proposals
        </Button>
      }
    >
      {query.isFetching ? <p>Reading memory proposals…</p> : null}
      {query.error && listedFeatureFlag(query.error) ? (
        <FeatureOffNotice flag={listedFeatureFlag(query.error)!} />
      ) : null}
      {query.error && !listedFeatureFlag(query.error) ? (
        <Callout tone="error">{describeApiError(query.error).summary}</Callout>
      ) : null}
      {operation.locked && operation.attempt?.message ? (
        <Callout tone="warning">{operation.attempt.message}</Callout>
      ) : null}
      {query.data?.reconciliationPreview?.items.length ? (
        <Callout announce={false} tone="warning">
          Some older automatic proposals have no verifiable source binding. They stay inactive. Review each proposal,
          reject it, then generate a fresh one from current scoped work.
        </Callout>
      ) : null}
      {query.data?.reconciliationPreview?.coverage === "partial" ? (
        <div className="space-y-2">
          <p className="text-sm text-fg-muted">
            Older proposals remain to be checked. This preview has made no changes.
          </p>
          <Button
            size="sm"
            disabled={query.isFetching}
            onClick={() => setReconciliationCursor(query.data?.reconciliationPreview?.nextCursor)}
          >
            Check older proposals
          </Button>
        </div>
      ) : null}
      {query.data && !proposals.length ? (
        <p className="text-sm text-fg-muted">No proposals waiting for review.</p>
      ) : null}
      <ul className="divide-y divide-line-subtle">
        {proposals.map((item) => (
          <li key={item.candidateId} className="space-y-1 py-3">
            <p className="whitespace-pre-wrap break-words">{item.proposedInsight}</p>
            {item.promotionEligibility?.reason ? <p>{item.promotionEligibility.reason}</p> : null}
            <div className="flex flex-wrap items-center gap-1 text-sm text-fg-secondary">
              <StatusBadge status={presentProposalStatus(item.status)} />
              <span>
                {proposalAuthorityLabel(item.authority)} · {plural(item.sourceRefs.length, "source reference")}
              </span>
            </div>
            <TechnicalDetails label="Proposal provenance">
              <p>Conversation: {item.sourceSessionId ?? "Not recorded"}</p>
              <p>Message: {item.sourceMessageId ?? item.sourceTurnId ?? "Not recorded"}</p>
              <p>Candidate: {item.candidateId}</p>
            </TechnicalDetails>
            {item.status === "proposed" ? (
              <div className="flex gap-2">
                {(["promote", "reject"] as const).map((action) => (
                  <Button
                    key={action}
                    disabled={
                      !enabled ||
                      query.isFetching ||
                      query.isError ||
                      busy ||
                      (action === "promote" && item.promotionEligibility?.allowed === false)
                    }
                    onClick={() => {
                      if (operation.locked || !operation.current()) return;
                      setOutcome(undefined);
                      setReview({ item, action });
                    }}
                  >
                    {action === "promote" ? "Review promotion" : "Review rejection"}
                  </Button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(undefined);
        }}
        title="Review memory proposal"
        description="Review the insight, workspace and what it adds to long-term memory."
      >
        <div className="grid gap-3">
          <p>Applies to this workspace.</p>
          <p className="whitespace-pre-wrap break-words">{review?.item.proposedInsight}</p>
          <Callout announce={false} tone="warning">
            {review?.action === "promote"
              ? "Promotion writes this proposed insight into trusted long-term memory."
              : "Rejection leaves this proposal unpromoted."}
          </Callout>
          {outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
          <Button
            variant="primary"
            disabled={
              busy ||
              operation.locked ||
              Boolean(outcome) ||
              !enabled ||
              query.isFetching ||
              query.isError ||
              (review?.action === "promote" && review.item.promotionEligibility?.allowed === false)
            }
            onClick={() => void confirm()}
          >
            {review?.action === "promote" ? "Confirm memory promotion" : "Confirm memory rejection"}
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}
