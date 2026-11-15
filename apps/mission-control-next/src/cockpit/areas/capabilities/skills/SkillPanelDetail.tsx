import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { CapabilitySkillDetail, CapabilitySkillItem } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { CHECKING_FOR_CHANGES, recordView } from "../../../data/record-view";
import { Button } from "../../../ui/Button";
import { Section } from "../../../ui/Section";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { CapabilityPolicyEvidence, CapabilitySourceEvidence } from "../../library/CapabilityEvidence";
import { SkillInstructions } from "./SkillInstructions";
import { presentSkillReview, presentSkillSource } from "./skill-source";

type DetailQuery = UseQueryResult<CapabilitySkillDetail>;

/** The instructions once read; while the first read runs, the usual line; after it fails, a plain line and Retry. */
function Instructions({ query }: { query: DetailQuery }) {
  const view = recordView(query);
  if (view.record) return <SkillInstructions body={view.record.instructionBody} />;
  // Retrying clears the error while the read runs again, so a read that has failed before keeps this view (and the
  // Retry button, with its focus) until it answers.
  const failed = view.phase === "error" || (query.isFetching && query.errorUpdateCount > 0);
  if (!failed) return <p className="text-sm text-fg-muted">{CHECKING_FOR_CHANGES}</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-fg">
        The skill&apos;s instructions couldn&apos;t load.
        {query.error ? ` ${describeApiError(query.error).summary}` : ""}
      </p>
      <Button size="sm" loading={query.isFetching} loadingLabel="Retrying…" onClick={() => void query.refetch()}>
        Retry
      </Button>
    </div>
  );
}

function Field({ label, mono = true, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs text-fg-secondary" : "text-xs text-fg-secondary"}>
        {children}
      </dd>
    </div>
  );
}

const listed = (values: readonly string[]) => (values.length > 0 ? values.join(", ") : "None");

/** Everything an expert may want and nobody else needs: ids, raw labels, the source's address and hashes. */
function SkillTechnicalDetails({
  item,
  detail,
}: {
  item: CapabilitySkillItem;
  detail: CapabilitySkillDetail | undefined;
}) {
  const provenance = detail?.provenance;
  return (
    <TechnicalDetails>
      <dl className="space-y-2">
        <Field label="Skill">{item.skillId}</Field>
        <Field label="Revision">{item.revision}</Field>
        <Field label="Lifecycle">{item.lifecycleState ?? "Not reported"}</Field>
        {detail ? (
          <>
            {detail.trustLabel ? <Field label="Trust label">{detail.trustLabel}</Field> : null}
            {detail.reviewWarning ? (
              <Field label="Review warning" mono={false}>
                {detail.reviewWarning}
              </Field>
            ) : null}
            {detail.note ? (
              <Field label="Note" mono={false}>
                {detail.note}
              </Field>
            ) : null}
            <Field label="Keywords">{listed(detail.keywords)}</Field>
            <Field label="Declared tools">{listed(detail.declaredTools)}</Field>
            <Field label="Requires">{listed(detail.requires)}</Field>
          </>
        ) : null}
        {provenance ? (
          <>
            <Field label="Source">{provenance.source}</Field>
            {provenance.sourceRef ? <Field label="Source reference">{provenance.sourceRef}</Field> : null}
            {provenance.sourceProvider ? <Field label="Provider">{provenance.sourceProvider}</Field> : null}
            {provenance.commitSha ? <Field label="Commit">{provenance.commitSha}</Field> : null}
            {provenance.treeSha256 ? <Field label="Tree SHA-256">{provenance.treeSha256}</Field> : null}
          </>
        ) : null}
      </dl>
      {detail?.catalogEntry ? (
        <div className="mt-3 space-y-2 border-t border-line-subtle pt-3">
          <CapabilityPolicyEvidence item={detail.catalogEntry} callableKnown />
          <CapabilitySourceEvidence item={detail.catalogEntry} />
        </div>
      ) : null}
    </TechnicalDetails>
  );
}

/**
 * The parts of the panel that come from the skill's own details: its instructions, where it came from, and the
 * collapsed Technical details. Where it came from is worded from the list until the details arrive, so it never waits
 * on them; the details only name the host an import came from.
 */
export function SkillPanelDetail({ item, query }: { item: CapabilitySkillItem; query: DetailQuery }) {
  const detail = recordView(query).record;
  const source = presentSkillSource(item.origin, detail?.provenance);
  const review = presentSkillReview(item.lifecycleState);
  return (
    <>
      <Section title="Instructions" headingLevel={3}>
        <Instructions query={query} />
      </Section>
      <Section title="Where it came from" headingLevel={3}>
        <p className="text-sm text-fg-secondary">{review ? `${source} · ${review}` : source}</p>
      </Section>
      <SkillTechnicalDetails item={item} detail={detail} />
    </>
  );
}
