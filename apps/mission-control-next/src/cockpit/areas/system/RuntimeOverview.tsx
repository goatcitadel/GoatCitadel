import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { useOpsRuntimeSnapshot } from "@goatcitadel/mission-control-shared/hooks/useOpsRuntimeSnapshot";
import { buildSectionDegradedSources } from "../../../features/native-routes/ops/runtime-overview-model";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { StatusBadge } from "../../ui/StatusBadge";
import { TimeText } from "../../ui/TimeText";
import { RuntimeModelPerformance } from "./RuntimeModelPerformance";
import { RuntimeRecordSections } from "./RuntimeRecordSections";
import { RuntimeServerSection } from "./RuntimeServerSection";
import { RUNTIME_SOURCE_LABELS, runtimeSectionForHash } from "./runtime-page-model";
import { SystemOwnerLink } from "./SystemOwnerLink";

const REQUESTED_SOURCES = [
  "llamaCpp",
  "backups",
  "mcpServers",
  "runtimeMeasurements",
  "localEngines",
  "evalProofRuns",
] as const;

/** System › Runtime: the server, local models, backups and integrations, each in its own words. */
export function RuntimeOverview({ workspaceId, sessionId }: { workspaceId: string; sessionId?: string }) {
  const runtime = useOpsRuntimeSnapshot("runtime", { requestedSources: REQUESTED_SOURCES });
  const { hash } = useCockpitRoute();
  const data = runtime.data;
  const loaded = Boolean(data);
  // Health and old bookmarks link to Classic anchors; land them on the native section that holds them now.
  useEffect(() => {
    if (!loaded) return;
    const target = runtimeSectionForHash(hash);
    if (target) document.getElementById(target)?.scrollIntoView?.({ block: "start" });
  }, [hash, loaded]);
  const degraded = data ? buildSectionDegradedSources(data, "runtime") : [];
  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Runtime"
        description="The GoatCitadel server, local models, backups and integrations, as each reports itself."
        actions={
          <>
            {runtime.isStale ? <StatusBadge status={{ label: "Data stale", tone: "waiting" }} /> : null}
            <Button size="sm" onClick={() => void runtime.reload()} disabled={runtime.loading}>
              <RefreshCw aria-hidden="true" className="size-4" /> Refresh<span className="sr-only"> runtime</span>
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
      {runtime.loading && !data ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading runtime…
        </p>
      ) : null}
      {runtime.error && !data ? (
        <EmptyState
          title="Runtime unavailable"
          description={runtime.error}
          action={<Button onClick={() => void runtime.reload()}>Try again</Button>}
        />
      ) : null}
      {data ? (
        <>
          {degraded.length ? (
            <details className="rounded-md border border-status-waiting/40 p-3 text-sm text-fg-secondary">
              <summary className="cursor-pointer font-medium">
                {degraded.length} runtime {degraded.length === 1 ? "source is" : "sources are"} unavailable
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {degraded.map((item) => (
                  <li key={item.source}>
                    {RUNTIME_SOURCE_LABELS[item.source] ?? "Runtime source"}: {item.message}
                  </li>
                ))}
              </ul>
              <p className="mt-2">What these sources report reads Unknown below until they answer again.</p>
            </details>
          ) : null}
          <RuntimeServerSection data={data} runtime={runtime} />
          <RuntimeRecordSections data={data} workspaceId={workspaceId} onRefresh={runtime.reload} />
          <RuntimeModelPerformance data={data} />
          {sessionId ? (
            <SystemOwnerLink
              href={`/system/sessions?sessionId=${encodeURIComponent(sessionId)}`}
              scope={[workspaceId, sessionId]}
            >
              Open the session in System › Sessions
            </SystemOwnerLink>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
