import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import { useProjectAccess } from "@goatcitadel/mission-control-shared/hooks/use-current-access";
import { buildSectionDegradedSources } from "../../../features/native-routes/ops/runtime-overview-model";
import { validApprovalRecordId } from "../../app/cockpit-compatibility";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { MetricList } from "../../ui/MetricList";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { Section } from "../../ui/Section";
import { StatusBadge } from "../../ui/StatusBadge";
import { TimeText } from "../../ui/TimeText";
import { SelectedSessionSection } from "./SelectedSessionSection";
import { SessionRow } from "./SessionRow";
import { recentSessionList, SESSIONS_SOURCE_LABELS, sessionsAcrossWorkspaces } from "./sessions-page-model";

type CockpitLocation = ReturnType<typeof useCockpitRoute>;

/** Session lists are installation-wide metadata; only the Chat session control manager changes a session. */
export function SystemSessions() {
  const preferences = useUiPreferences(),
    location = useCockpitRoute();
  const workspaceId = preferences.activeWorkspaceId ?? "default";
  const access = useProjectAccess(JSON.stringify(["system-sessions", preferences.activeCitadelId, workspaceId]));
  const params = new URLSearchParams(location.search);
  const runIds = params.getAll("runId");
  const runId = usableRunId(runIds);
  if (runId) return <OpenRunInWork runId={runId} location={location} />;
  if (runIds.length || params.get("view") === "run-detail") return <NoRunChosen workspaceId={workspaceId} />;
  return <SessionsPage key={access.identity} workspaceId={workspaceId} location={location} />;
}

/** One run, named the same way every time, that stays a single path segment (`.` and `..` would leave Work's runs). */
function usableRunId(runIds: string[]): string | null {
  const [runId] = runIds;
  if (runId === undefined || runIds.some((id) => id !== runId)) return null;
  return validApprovalRecordId(runId) && runId !== "." && runId !== ".." ? runId : null;
}

/** Old Sessions run links open the run in Work, which owns run detail now; scope and fragment travel with it. */
function OpenRunInWork({ runId, location }: { runId: string; location: CockpitLocation }) {
  const { search, hash, navigate } = location;
  useEffect(() => {
    const params = new URLSearchParams(search);
    for (const key of ["runId", "view", "sessionId"]) params.delete(key);
    const query = params.toString();
    navigate(`/work/runs/${encodeURIComponent(runId)}${query ? `?${query}` : ""}${hash}`, { replace: true });
  }, [runId, search, hash, navigate]);
  return <p className="text-sm text-fg-muted">Opening the run in Work…</p>;
}

function NoRunChosen({ workspaceId }: { workspaceId: string }) {
  return (
    <section className={AREA_PAGE}>
      <AreaHeader title="Run detail" description="A run opened from Sessions, with its saved steps and outcome." />
      <EmptyState
        title="No run chosen"
        description="Open a run from Work › History or from its Chat turn."
        action={
          <NativeOwnerLink href="/work/history" scope={[workspaceId, "run-history"]}>
            Open Work › History
          </NativeOwnerLink>
        }
      />
    </section>
  );
}

function SessionsPage({ workspaceId, location }: { workspaceId: string; location: CockpitLocation }) {
  const runtime = useOpsRuntimeSnapshot("sessions", { requestedSources: ["sessions"] });
  const data = runtime.data;
  const sessionId = new URLSearchParams(location.search).get("sessionId");
  const selectSession = (id: string | null) => {
    const url = new URL("/system/sessions" + location.search + location.hash, "http://cockpit.invalid");
    if (id) url.searchParams.set("sessionId", id);
    else url.searchParams.delete("sessionId");
    location.navigate(url.pathname + url.search + url.hash);
  };
  const degraded = data ? buildSectionDegradedSources(data, "sessions") : [];
  const list = data ? recentSessionList(data) : null;
  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Sessions"
        description="Conversations across every channel, with controls for the one you choose."
        actions={
          <>
            {runtime.isStale ? <StatusBadge status={{ label: "Data stale", tone: "waiting" }} /> : null}
            <Button size="sm" disabled={runtime.loading} onClick={() => void runtime.reload()}>
              <RefreshCw aria-hidden="true" className="size-4" /> Refresh sessions
            </Button>
          </>
        }
      >
        {runtime.lastFetchedAt ? (
          <p className="mt-1 text-xs text-fg-muted">
            <TimeText value={runtime.lastFetchedAt} prefix="Updated" />
          </p>
        ) : null}
      </AreaHeader>
      {runtime.loading && !data ? <p className="text-sm text-fg-muted">Loading sessions…</p> : null}
      {runtime.error && !data ? (
        <EmptyState
          title="Sessions unavailable"
          description={runtime.error}
          action={<Button onClick={() => void runtime.reload()}>Try again</Button>}
        />
      ) : null}
      {degraded.length ? (
        <details className="text-sm text-fg-secondary">
          <summary className="cursor-pointer font-medium">
            {degraded.length} session {degraded.length === 1 ? "source is" : "sources are"} unavailable
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {degraded.map((item) => (
              <li key={item.source}>
                {SESSIONS_SOURCE_LABELS[item.source] ?? "Session source"}: {item.message}
              </li>
            ))}
          </ul>
          <p className="mt-2">What these sources report reads Unknown below until they answer again.</p>
        </details>
      ) : null}
      {sessionId && (data || !runtime.loading) ? (
        <SelectedSessionSection
          data={data}
          listRead={list?.state === "ok"}
          sessionId={sessionId}
          workspaceId={workspaceId}
          onClose={() => selectSession(null)}
        />
      ) : null}
      {data && list ? (
        <>
          <Section title="Recent sessions" description="Most recent first." className="space-y-3 text-sm">
            {list.state === "failed" ? (
              <p className="text-fg-muted">Sessions couldn&apos;t be read.</p>
            ) : list.items.length ? (
              <ul aria-label="Recent sessions" className="divide-y divide-line-subtle">
                {list.items.map((item) => (
                  <SessionRow key={item.sessionId} item={item} onDetails={selectSession} />
                ))}
              </ul>
            ) : (
              <p className="text-fg-muted">No sessions have recent activity.</p>
            )}
          </Section>
          <Section
            title="Across all workspaces"
            description="Approvals and helper agents for the whole installation, not just this workspace."
          >
            <MetricList label="Across all workspaces" items={sessionsAcrossWorkspaces(data)} />
          </Section>
        </>
      ) : null}
    </section>
  );
}
