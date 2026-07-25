import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type {
  JourneyTimelineEvidenceHealth,
  JourneyTimelineItem,
  JourneyTimelinePage,
  GovernanceJourneyPoisoningStatus,
} from "@goatcitadel/contracts";
import { fetchJourneyTimeline } from "@goatcitadel/mission-control-shared";
import { getRouteReleaseScope } from "@next/app/route-model";
import { NativeCard, ReleaseScopeBadge } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import { getErrorMessage } from "../shared/native-helpers";
import {
  LibraryButtonRow,
  LibraryCodeBlock,
  LibraryActionList,
  LibraryEmptyState,
  LibraryField,
  LibraryFieldGrid,
  LibraryMetricGrid,
  LibrarySectionShell,
  LibrarySelectableList,
} from "../shared/library-primitives";

type JourneyCategoryFilter = "all" | "memory" | "skills" | "imports" | "approvals" | "provenance";
type JourneyEvidenceFilter = "all" | GovernanceJourneyPoisoningStatus;

const EMPTY_PAGE: JourneyTimelinePage = {
  schemaVersion: "goatcitadel.journey-timeline-page.v1",
  readOnly: true,
  mutationSemantics: "none",
  workspaceId: "",
  includeGlobal: false,
  items: [],
  generatedAt: "1970-01-01T00:00:00.000Z",
};

export function JourneyTimelineRoutePage({ route, activeWorkspaceId }: NativeRoutePagesProps) {
  const [category, setCategory] = useState<JourneyCategoryFilter>("all");
  const [evidenceFilter, setEvidenceFilter] = useState<JourneyEvidenceFilter>("all");
  const [includeGlobal, setIncludeGlobal] = useState(false);
  const [sessionDraft, setSessionDraft] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [page, setPage] = useState<JourneyTimelinePage>(EMPTY_PAGE);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(
    async (cursor?: string) => {
      const requestGeneration = cursor ? generation.current : generation.current + 1;
      if (!cursor) generation.current = requestGeneration;
      if (cursor) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const next = await fetchJourneyTimeline({
          workspaceId: activeWorkspaceId,
          includeGlobal,
          eventTypes: eventTypesForJourneyCategory(category),
          poisoningStatuses: evidenceFilter === "all" ? undefined : [evidenceFilter],
          sessionId: sessionId || undefined,
          cursor,
          limit: 50,
        });
        if (requestGeneration !== generation.current) return;
        setPage((current) =>
          cursor
            ? {
                ...next,
                items: mergeJourneyItems(current.items, next.items),
              }
            : next,
        );
      } catch (loadError) {
        if (requestGeneration === generation.current) setError(getErrorMessage(loadError));
      } finally {
        if (requestGeneration === generation.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [activeWorkspaceId, category, evidenceFilter, includeGlobal, sessionId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!page.items.length) {
      setSelectedEventId("");
      return;
    }
    setSelectedEventId((current) =>
      page.items.some((item) => item.eventId === current) ? current : (page.items[0]?.eventId ?? ""),
    );
  }, [page.items]);

  const selected = useMemo(
    () => page.items.find((item) => item.eventId === selectedEventId) ?? null,
    [page.items, selectedEventId],
  );
  const blockedCount = page.items.filter((item) => item.evidence.trustContribution === "blocked").length;
  const distinctSessions = new Set(page.items.flatMap((item) => (item.sessionId ? [item.sessionId] : []))).size;

  return (
    <LibrarySectionShell loading={loading} error={error} onRetry={() => void load()}>
      <ReleaseScopeBadge status={getRouteReleaseScope(route).status} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Journey timeline"
          subtitle="Experimental read-only governance history for captured skill learning, approvals, effects, and Skills Hub lifecycle evidence."
          stats={[
            { label: "Loaded", value: String(page.items.length) },
            { label: "Blocked evidence", value: String(blockedCount) },
            { label: "Sessions", value: String(distinctSessions) },
          ]}
        >
          <LibraryFieldGrid>
            <LibraryField label="Event family">
              <select
                className="mc-next-settings-input"
                value={category}
                onChange={(event) => setCategory(event.target.value as JourneyCategoryFilter)}
              >
                <option value="all">All events</option>
                <option value="memory">Memory</option>
                <option value="skills">Skills and proposals</option>
                <option value="imports">Imports and updates</option>
                <option value="approvals">Approvals</option>
                <option value="provenance">Provenance</option>
              </select>
            </LibraryField>
            <LibraryField label="Evidence posture">
              <select
                className="mc-next-settings-input"
                value={evidenceFilter}
                onChange={(event) => setEvidenceFilter(event.target.value as JourneyEvidenceFilter)}
              >
                <option value="all">All postures</option>
                <option value="clean">Clean</option>
                <option value="blocked">Poisoned / blocked</option>
                <option value="quarantined">Quarantined</option>
                <option value="conflicting">Conflicting</option>
              </select>
            </LibraryField>
            <LibraryField label="Exact session ID" span={2}>
              <input
                className="mc-next-settings-input"
                value={sessionDraft}
                onChange={(event) => setSessionDraft(event.target.value)}
                placeholder="Optional session filter"
              />
            </LibraryField>
          </LibraryFieldGrid>
          <LibraryButtonRow>
            <button
              type="button"
              className="mc-next-settings-filter"
              onClick={() => setSessionId(sessionDraft.normalize("NFKC").trim())}
            >
              Apply session
            </button>
            <button
              type="button"
              className={`mc-next-settings-filter${includeGlobal ? " active" : ""}`}
              aria-pressed={includeGlobal}
              onClick={() => setIncludeGlobal((current) => !current)}
            >
              Include global evidence
            </button>
            <button type="button" className="mc-next-settings-filter" onClick={() => void load()}>
              <RefreshCw size={16} />
              Refresh
            </button>
          </LibraryButtonRow>
          <LibrarySelectableList
            items={page.items.map((item) => ({
              id: item.eventId,
              title: humanizeAction(item.action),
              meta: `${item.category} · ${formatJourneyEvidenceHealth(item.evidence.health)}`,
              body: `${item.subjectKind} · ${item.subjectId} · ${formatTimestamp(item.occurredAt)}`,
            }))}
            selectedId={selectedEventId}
            onSelect={setSelectedEventId}
            emptyLabel="No canonical Journey events match these filters."
          />
          {page.nextCursor ? (
            <LibraryButtonRow>
              <button
                type="button"
                className="mc-next-settings-filter"
                disabled={loadingMore}
                onClick={() => void load(page.nextCursor)}
              >
                {loadingMore ? "Loading…" : "Load older events"}
              </button>
            </LibraryButtonRow>
          ) : null}
        </NativeCard>

        <div className="mc-next-settings-stack">
          <NativeCard
            title={selected ? humanizeAction(selected.action) : "Event evidence"}
            subtitle={selected ? `${selected.eventType} · ${formatTimestamp(selected.recordedAt)}` : "Select an event."}
          >
            {selected ? <JourneyEventDetail item={selected} /> : <LibraryEmptyState label="Select a Journey event." />}
          </NativeCard>
          <NativeCard
            title="Experimental read-only boundary"
            subtitle="Journey explains only the canonical producers currently wired; it does not activate skills or promote memory."
          >
            <p className="mc-next-settings-copy">
              Poisoned, conflicting, quarantined, foreign-scope, or incomplete evidence remains visible and is marked
              unable to contribute trust. Any actual mutation stays in its owning approval-gated surface.
            </p>
            <p className="mc-next-settings-copy">
              Broader memory lifecycle, legacy imports, direct skill state, improvement rollback/revoke, and external
              source producer coverage is not yet complete. This view must not be used as release-bearing parity
              evidence.
            </p>
          </NativeCard>
        </div>
      </div>
    </LibrarySectionShell>
  );
}

function JourneyEventDetail({ item }: { item: JourneyTimelineItem }) {
  const recurrence = item.recurrence;
  return (
    <>
      <LibraryMetricGrid
        items={[
          { label: "Evidence", value: formatJourneyEvidenceHealth(item.evidence.health) },
          { label: "Trust contribution", value: item.evidence.trustContribution.replaceAll("_", " ") },
          { label: "Actor", value: `${item.actorType} · ${item.actorId}` },
          { label: "Scope", value: item.scopeKind === "global" ? "Global" : (item.workspaceId ?? "Unknown") },
        ]}
      />
      <LibraryCodeBlock label="Stable event fingerprint">{item.eventFingerprint}</LibraryCodeBlock>
      {item.evidenceFingerprint ? (
        <LibraryCodeBlock label="Stable evidence fingerprint">{item.evidenceFingerprint}</LibraryCodeBlock>
      ) : null}
      <LibraryMetricGrid
        items={[
          {
            label: "Evidence requirements",
            value: item.evidence.requirementsDeclared ? "Declared by canonical event" : "Undeclared, blocked",
          },
          {
            label: "Source",
            value: !item.evidence.requirementsDeclared
              ? "Requirement undeclared"
              : item.evidence.sourceLinked
                ? "Linked"
                : item.evidence.requiresSource
                  ? "Required, missing"
                  : "Not required",
          },
          {
            label: "Approval",
            value: !item.evidence.requirementsDeclared
              ? "Requirement undeclared"
              : item.evidence.approvalLinked
                ? "Linked"
                : item.evidence.requiresApproval
                  ? "Required, missing"
                  : "Not required",
          },
          {
            label: "Distinct sessions",
            value: recurrence ? String(recurrence.distinctSessionCount) : "N/A",
            meta: recurrence
              ? `${recurrence.observationCount} observations; ${recurrence.repeatedObservationCount} same-session repeats`
              : "No evidence fingerprint",
          },
          {
            label: "Recurrence scan",
            value: recurrence?.complete === false ? "Bounded / partial" : "Complete",
            meta: recurrence ? `${recurrence.blockedObservationCount} blocked observations excluded` : undefined,
          },
        ]}
      />
      <EvidenceRows title="Evidence references" rows={item.evidenceRefs.map((ref) => [ref.owner, ref.refId])} />
      <EvidenceRows title="Provenance" rows={semanticRecordRows(item.provenance)} />
      <EvidenceRows title="Event summary" rows={semanticRecordRows(item.summary)} />
    </>
  );
}

function EvidenceRows({ title, rows }: { title: string; rows: Array<readonly [string, string]> }) {
  return (
    <section aria-label={title}>
      <h3 className="mc-next-settings-subtitle">{title}</h3>
      <LibraryActionList
        items={rows.map(([label, value], index) => ({
          id: `${label}-${index}`,
          label: humanizeAction(label),
          description: value,
        }))}
        emptyLabel={`No ${title.toLowerCase()} recorded.`}
        maxHeight="min(18rem, 32vh)"
      />
    </section>
  );
}

export function eventTypesForJourneyCategory(category: JourneyCategoryFilter): string[] | undefined {
  switch (category) {
    case "memory":
      return ["memory_lifecycle", "memory_item_lifecycle", "structured_memory_lifecycle"];
    case "skills":
      return [
        "skill_learning_evidence_assessed",
        "candidate_skill_lifecycle",
        "capability_proposal_lifecycle",
        "skill_lifecycle",
        "skill_hub_review",
        "skill_hub_lifecycle",
      ];
    case "imports":
      return ["skill_import_lifecycle", "skill_hub_review", "skill_hub_lifecycle"];
    case "approvals":
      return ["approval_lifecycle", "approval_effect_lifecycle"];
    case "provenance":
      return ["provenance_lifecycle", "skill_hub_review", "skill_hub_lifecycle"];
    default:
      return undefined;
  }
}

export function mergeJourneyItems(
  current: readonly JourneyTimelineItem[],
  incoming: readonly JourneyTimelineItem[],
): JourneyTimelineItem[] {
  const byId = new Map(current.map((item) => [item.eventId, item]));
  for (const item of incoming) byId.set(item.eventId, item);
  return [...byId.values()].sort((left, right) => {
    const time = right.recordedAt.localeCompare(left.recordedAt);
    return time === 0 ? right.eventId.localeCompare(left.eventId) : time;
  });
}

export function formatJourneyEvidenceHealth(health: JourneyTimelineEvidenceHealth): string {
  return health.replaceAll("_", " ");
}

export function semanticRecordRows(record: Record<string, unknown>): Array<readonly [string, string]> {
  return Object.entries(record)
    .slice(0, 64)
    .map(([key, value]) => [key, formatSemanticValue(value)] as const);
}

function formatSemanticValue(value: unknown): string {
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 509)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "Not recorded";
  if (Array.isArray(value)) {
    const values = value
      .slice(0, 32)
      .map((item) =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean"
          ? String(item)
          : "Recorded item",
      );
    return values.length ? values.join(", ") : "None";
  }
  return "Structured evidence recorded";
}

function humanizeAction(value: string): string {
  const words = value.replaceAll("_", " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Journey event";
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}
