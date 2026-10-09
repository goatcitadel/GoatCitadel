import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { GovernanceJourneyPoisoningStatus, JourneyTimelineItem } from "@goatcitadel/contracts";
import { fetchJourneyTimeline } from "@goatcitadel/mission-control-shared/api/journey";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  eventTypesForJourneyCategory,
  formatJourneyEvidenceHealth,
  mergeJourneyItems,
  semanticRecordRows,
} from "../../../features/native-routes/library/JourneyTimelineRoutePage";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useLibraryOperation } from "./use-library-operation";

const CATEGORIES = [
  ["all", "All events"],
  ["memory", "Memory"],
  ["skills", "Skills and proposals"],
  ["imports", "Imports and updates"],
  ["approvals", "Approvals"],
  ["provenance", "Provenance"],
] as const;
const POSTURES = [
  ["all", "All postures"],
  ["clean", "Clean"],
  ["blocked", "Poisoned / blocked"],
  ["quarantined", "Quarantined"],
  ["conflicting", "Conflicting"],
] as const;
type Category = (typeof CATEGORIES)[number][0];
type Posture = (typeof POSTURES)[number][0];
const PAGE_SIZE = 50;
const CARD = "grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-line p-3";
const INPUT = "w-full min-w-0 rounded-md border border-line bg-raised p-2";

const pick = <T extends string>(value: string | null, allowed: readonly (readonly [T, string])[], fallback: T): T =>
  allowed.some(([id]) => id === value) ? (value as T) : fallback;
const humanize = (value: string) => {
  const words = value.replaceAll("_", " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Journey event";
};
const formatTime = (iso: string) => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : iso);

/** Read-only governance history. Every read is bound to the current workspace and access identity. */
export function LibraryJourney({ workspaceId }: { workspaceId: string }) {
  const route = useCockpitRoute();
  const params = new URLSearchParams(route.search);
  const category = pick<Category>(params.get("category"), CATEGORIES, "all");
  const posture = pick<Posture>(params.get("evidence"), POSTURES, "all");
  const sessionId = params.get("sessionId")?.normalize("NFKC").trim() || undefined;
  const includeGlobal = params.get("includeGlobal") === "true";
  const selectedId = params.get("eventId") ?? "";
  const [sessionDraft, setSessionDraft] = useState(sessionId ?? "");
  // Back/Forward changes the URL session; the field follows it rather than keeping a stale draft.
  const [syncedSessionId, setSyncedSessionId] = useState(sessionId);
  if (syncedSessionId !== sessionId) {
    setSyncedSessionId(sessionId);
    setSessionDraft(sessionId ?? "");
  }
  const access = useLibraryOperation(JSON.stringify(["journey", workspaceId]));

  const query = useInfiniteQuery({
    queryKey: ["library", "journey", workspaceId, category, posture, sessionId, includeGlobal, access.identity],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchJourneyTimeline({
        workspaceId,
        includeGlobal,
        eventTypes: category === "all" ? undefined : eventTypesForJourneyCategory(category),
        poisoningStatuses: posture === "all" ? undefined : [posture as GovernanceJourneyPoisoningStatus],
        sessionId,
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 0,
  });
  const items = (query.data?.pages ?? []).reduce<JourneyTimelineItem[]>(
    (all, next) => mergeJourneyItems(all, next.items),
    [],
  );
  const selected = items.find((event) => event.eventId === selectedId);
  const blocked = items.filter((event) => event.evidence.trustContribution === "blocked").length;

  function setParams(patch: Record<string, string | undefined>) {
    const next = new URLSearchParams(route.search);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "" || value === "all" || value === "false") next.delete(key);
      else next.set(key, value);
    }
    next.delete("shell");
    const search = next.toString();
    route.navigate(`/library/journey${search ? `?${search}` : ""}`, { replace: true });
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 overflow-y-auto p-4">
      <header className="grid min-w-0 gap-2">
        <h1 className="font-display text-xl font-semibold">Journey timeline</h1>
        <p className="text-sm text-fg-secondary">
          Experimental, read-only governance history for workspace {workspaceId}. Journey explains evidence from the
          canonical producers currently wired; it never activates skills or promotes memory. Blocked, quarantined,
          conflicting, foreign-scope and incomplete evidence stays visible and marked.
        </p>
        <p className="text-sm text-fg-secondary">
          Coverage is not yet complete: broader memory lifecycle, legacy imports, direct skill state, improvement
          rollback or revoke, and external source producers are not wired. This view is not release-bearing parity
          evidence.
        </p>
      </header>
      <section className={CARD} aria-label="Journey filters">
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Event family">
            {(props) => (
              <select
                {...props}
                className={INPUT}
                value={category}
                onChange={(event) => setParams({ category: event.target.value, eventId: undefined })}
              >
                {CATEGORIES.map(([id, text]) => (
                  <option key={id} value={id}>
                    {text}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Evidence posture">
            {(props) => (
              <select
                {...props}
                className={INPUT}
                value={posture}
                onChange={(event) => setParams({ evidence: event.target.value, eventId: undefined })}
              >
                {POSTURES.map(([id, text]) => (
                  <option key={id} value={id}>
                    {text}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Exact session ID" help="Only events recorded for this session ID.">
            {(props) => (
              <input
                {...props}
                className={INPUT}
                value={sessionDraft}
                onChange={(event) => setSessionDraft(event.target.value)}
              />
            )}
          </Field>
          <label className="flex min-h-11 min-w-0 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeGlobal}
              onChange={(event) => setParams({ includeGlobal: String(event.target.checked), eventId: undefined })}
            />
            Include global evidence
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              setParams({ sessionId: sessionDraft.normalize("NFKC").trim() || undefined, eventId: undefined })
            }
          >
            Apply session
          </Button>
          <Button variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>
            Refresh
          </Button>
        </div>
      </section>
      {query.isPending ? <p role="status">Reading Journey events…</p> : null}
      {query.error ? <Callout tone="error">{describeApiError(query.error).summary}</Callout> : null}
      {query.data ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
          <section className={CARD} aria-label="Journey events">
            <h2 className="font-display text-md font-semibold">Events</h2>
            <p className="text-sm text-fg-secondary">
              {items.length} loaded · {blocked} with blocked evidence
            </p>
            {!items.length ? <p className="text-sm text-fg-muted">No Journey events match these filters.</p> : null}
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {items.map((event) => (
                <li key={event.eventId} data-journey-event={event.eventId} className="min-w-0">
                  <button
                    type="button"
                    aria-current={event.eventId === selectedId ? "true" : undefined}
                    onClick={() => setParams({ eventId: event.eventId })}
                    className="grid min-h-11 w-full min-w-0 gap-1 rounded-md border border-line p-2 text-left wrap-anywhere aria-[current=true]:border-accent"
                  >
                    <strong>{humanize(event.action)}</strong>
                    <span className="text-sm text-fg-secondary">
                      {formatTime(event.recordedAt)} · {event.category.replaceAll("_", " ")} ·{" "}
                      {formatJourneyEvidenceHealth(event.evidence.health)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {query.hasNextPage ? (
              <div>
                <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  Load older events
                </Button>
              </div>
            ) : null}
          </section>
          <div className="min-w-0 lg:col-span-2">
            {selected ? (
              <JourneyEventDetail item={selected} />
            ) : selectedId ? (
              <Callout tone="warning">
                This event is not in the loaded results. Load older events or adjust the filters.
              </Callout>
            ) : (
              <p className="rounded-lg border border-line p-3 text-sm text-fg-secondary">
                Select an event to inspect its evidence.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Rows({ title, rows }: { title: string; rows: Array<readonly [string, string]> }) {
  return (
    <section aria-label={title} className="grid min-w-0 gap-1">
      <h3 className="font-medium">{title}</h3>
      {rows.length ? (
        <dl className="grid min-w-0 grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          {rows.map(([key, value], index) => (
            <div key={`${key}-${index}`} className="min-w-0 wrap-anywhere">
              <dt className="text-fg-secondary">{humanize(key)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-fg-muted">No {title.toLowerCase()} recorded.</p>
      )}
    </section>
  );
}

function JourneyEventDetail({ item }: { item: JourneyTimelineItem }) {
  const evidence = item.evidence;
  const recurrence = item.recurrence;
  const link = (linked: boolean, required: boolean) =>
    !evidence.requirementsDeclared
      ? "Requirement undeclared"
      : linked
        ? "Linked"
        : required
          ? "Missing"
          : "Not required";
  return (
    <section className={CARD} aria-label="Journey event detail">
      <h2 className="font-display text-md font-semibold wrap-anywhere">{humanize(item.action)}</h2>
      <p className="text-sm text-fg-secondary wrap-anywhere">
        {item.eventType} · {item.subjectKind} ·{" "}
        {item.scopeKind === "global" ? "global evidence" : `workspace ${item.workspaceId ?? "unknown"}`}
      </p>
      <dl className="grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium">Evidence</dt>
          <dd>{formatJourneyEvidenceHealth(evidence.health)}</dd>
        </div>
        <div>
          <dt className="font-medium">Trust contribution</dt>
          <dd>{evidence.trustContribution.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt className="font-medium">Source</dt>
          <dd>{link(evidence.sourceLinked, evidence.requiresSource)}</dd>
        </div>
        <div>
          <dt className="font-medium">Approval</dt>
          <dd>{link(evidence.approvalLinked, evidence.requiresApproval)}</dd>
        </div>
        <div>
          <dt className="font-medium">Actor</dt>
          <dd className="wrap-anywhere">
            {item.actorType} · {item.actorId}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Recorded</dt>
          <dd>{formatTime(item.recordedAt)}</dd>
        </div>
        <div>
          <dt className="font-medium">Recurrence</dt>
          <dd>
            {recurrence
              ? `${recurrence.observationCount} observations in ${recurrence.distinctSessionCount} sessions · ${recurrence.complete ? "complete scan" : "bounded, partial scan"}`
              : "No evidence fingerprint"}
          </dd>
        </div>
        {evidence.blockerCodes.length ? (
          <div>
            <dt className="font-medium">Blockers</dt>
            <dd className="wrap-anywhere">{evidence.blockerCodes.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      <Rows title="Evidence references" rows={item.evidenceRefs.map((ref) => [ref.owner, ref.refId] as const)} />
      <Rows title="Provenance" rows={semanticRecordRows(item.provenance)} />
      <Rows title="Event summary" rows={semanticRecordRows(item.summary)} />
      <TechnicalDetails label="Fingerprints and full event">
        <p className="break-all">Event fingerprint {item.eventFingerprint}</p>
        {item.evidenceFingerprint ? <p className="break-all">Evidence fingerprint {item.evidenceFingerprint}</p> : null}
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-sunken p-2 font-mono text-xs">
          {JSON.stringify(item, null, 2)}
        </pre>
      </TechnicalDetails>
    </section>
  );
}
