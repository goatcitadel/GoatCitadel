import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Hand, RefreshCw, ShieldCheck, Wand2, type LucideIcon } from "lucide-react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchRuntimeRepairs } from "@goatcitadel/mission-control-shared/api/runtime-repairs";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { MetricList } from "../../ui/MetricList";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { Section } from "../../ui/Section";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import {
  buildRepairsPage,
  type PresentedRepairCheck,
  type PresentedRepairFinding,
  type RepairTierKind,
} from "./repairs-page-model";

/** The sweep checks every 5 minutes; refreshing every minute shows a new check soon after it lands. */
const REFRESH_INTERVAL_MS = 60_000;

const TIER_ICONS: Readonly<Record<RepairTierKind, LucideIcon>> = {
  automatic: Wand2,
  proposed: ShieldCheck,
  report: Hand,
};

/** Detect-only Runtime Repair Sweep (docs/RUNTIME_REPAIR_SWEEP.md). Read-only: nothing here changes a run or approval. */
export function SystemRepairs() {
  const query = useQuery({
    queryKey: ["system", "runtime-repairs"],
    queryFn: fetchRuntimeRepairs,
    refetchInterval: REFRESH_INTERVAL_MS,
  });
  const page = query.data ? buildRepairsPage(query.data) : null;
  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Repairs"
        description="Stuck work GoatCitadel noticed. This first version only watches: it hasn't changed anything."
        actions={
          <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh repairs
          </Button>
        }
      >
        {page?.lastTickAt ? (
          <p className="mt-1 text-xs text-fg-muted">
            <TimeText value={page.lastTickAt} prefix="Checked" />
          </p>
        ) : null}
      </AreaHeader>
      {query.isPending ? <p className="text-sm text-fg-muted">Loading repairs…</p> : null}
      {query.isError && !page ? (
        <EmptyState
          tone="error"
          title="Repairs unavailable"
          description={describeApiError(query.error, "GoatCitadel didn't answer. Try again in a moment.").summary}
          action={<Button onClick={() => void query.refetch()}>Try again</Button>}
        />
      ) : null}
      {page?.state === "first_check_pending" ? (
        <EmptyState
          title="The first check hasn't run yet"
          description="It runs about a minute after GoatCitadel starts, then every 5 minutes."
        />
      ) : null}
      {page?.state === "all_clear" ? (
        <>
          <EmptyState
            title="Nothing looks stuck"
            description="GoatCitadel checks every 5 minutes. Anything stuck shows up here, with a link to it."
          />
          <ChecksSection checks={page.checks} />
        </>
      ) : null}
      {page?.state === "findings" ? (
        <>
          <div className="space-y-3">
            <p className="text-base text-fg">{page.intro}</p>
            <MetricList label="Repairs" items={page.metrics} />
          </div>
          {page.open.length ? (
            <Section title="Open" description="Newest first.">
              <ul aria-label="Open problems" className="divide-y divide-line-subtle">
                {page.open.map((item) => (
                  <FindingRow key={item.findingId} item={item} />
                ))}
              </ul>
            </Section>
          ) : null}
          {page.cleared.length ? (
            <Section title="Cleared recently" description="Problems that went away since GoatCitadel last started.">
              <ul aria-label="Cleared problems" className="divide-y divide-line-subtle">
                {page.cleared.map((item) => (
                  <FindingRow key={item.findingId} item={item} cleared />
                ))}
              </ul>
            </Section>
          ) : null}
          <ChecksSection checks={page.checks} />
        </>
      ) : null}
    </section>
  );
}

function FindingRow({ item, cleared = false }: { item: PresentedRepairFinding; cleared?: boolean }) {
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className={cleared ? "text-sm text-fg-secondary" : "text-base text-fg"}>
          {cleared ? <CircleCheck aria-hidden="true" className="mr-1 inline size-4 text-status-done" /> : null}
          {item.summary}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
          {cleared ? null : <StatusBadge status={item.tier} icon={TIER_ICONS[item.tierKind]} />}
          {item.detail ? <span>{item.detail}</span> : null}
          <TimeText value={item.firstSeenAt} prefix="First noticed" />
        </div>
        <TechnicalDetails>
          <dl className="space-y-1 text-xs">
            {item.technical.map(([term, value]) => (
              <div key={term} className="flex min-w-0 gap-3">
                <dt className="shrink-0 text-fg-muted">{term}</dt>
                <dd className="min-w-0 font-mono break-all text-fg-secondary">{value}</dd>
              </div>
            ))}
          </dl>
        </TechnicalDetails>
      </div>
      {item.link ? (
        <NativeOwnerLink
          href={item.link.href}
          scope="system-repairs"
          className="inline-flex min-h-8 items-center text-sm font-medium text-accent hover:underline"
        >
          {item.link.label}
        </NativeOwnerLink>
      ) : null}
    </li>
  );
}

function ChecksSection({ checks }: { checks: PresentedRepairCheck[] }) {
  return (
    <Section title="Checks" description="What GoatCitadel looks for on each check.">
      <ul aria-label="Checks" className="divide-y divide-line-subtle text-sm">
        {checks.map((check) => (
          <li key={check.label} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="text-fg">{check.label}</span>
            <span className={check.failed ? "inline-flex items-center gap-1 text-status-failed" : "text-fg-muted"}>
              {check.failed ? <CircleAlert aria-hidden="true" className="size-4" /> : null}
              {check.note}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
