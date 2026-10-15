import { useQuery } from "@tanstack/react-query";
import type { ExternalSourceDetailResponse, ExternalSourceImportPlanResponse } from "@goatcitadel/contracts";
import {
  fetchExternalSources,
  fetchExternalSourceDetail,
  isExternalSourceCapabilityAbsent,
} from "@goatcitadel/mission-control-shared/api/external-sources";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { useLibraryOperation } from "./use-library-operation";
import { LibrarySourceRegistration } from "./LibrarySourceRegistration";
import { SourceOperations } from "./LibrarySourceOperations";

export function LibraryExternalSources({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["external-sources", workspaceId]));
  return <ExternalSources key={operation.identity} workspaceId={workspaceId} />;
}
function ExternalSources({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["external-sources", workspaceId]));
  const route = useCockpitRoute();
  const sourceId = new URLSearchParams(route.search).get("sourceId");
  const query = useQuery({
    queryKey: ["library", "external-sources", workspaceId, operation.identity],
    queryFn: () => fetchExternalSources(workspaceId),
    staleTime: 0,
    retry: false,
  });
  const detail = useQuery({
    queryKey: ["library", "external-source", workspaceId, sourceId, operation.identity],
    queryFn: () => fetchExternalSourceDetail(workspaceId, sourceId!),
    enabled: Boolean(sourceId) && Boolean(query.data),
    staleTime: 0,
  });
  if (query.isError && isExternalSourceCapabilityAbsent(query.error))
    return (
      <Callout>External sources are unavailable in this runtime. Registration and imports remain disabled.</Callout>
    );
  return (
    <section
      className="grid min-w-0 max-w-full grid-cols-1 gap-3 wrap-anywhere rounded-lg border border-line p-3"
      aria-label="External sources"
    >
      <h2 className="font-display text-lg">External sources</h2>
      <p className="text-sm text-fg-secondary">
        Governed source registration, sealed scans and content-free import provenance. Imports do not grant unrestricted
        source read access.
      </p>
      {query.isPending ? <p role="status">Reading external sources…</p> : null}
      {query.error ? (
        <Callout tone="error">
          {describeApiError(query.error).summary} A specific authenticated operator and source access may be required.
        </Callout>
      ) : null}
      {query.data && !query.isError ? (
        <LibrarySourceRegistration
          workspaceId={workspaceId}
          onRegistered={(id) => {
            void query.refetch();
            route.navigate(`/library/knowledge?sourceId=${encodeURIComponent(id)}&shell=cockpit`);
          }}
        />
      ) : null}
      <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
        Refresh external sources
      </Button>
      <ul className="grid min-w-0 grid-cols-1 gap-2">
        {query.data?.items
          .filter((item) => item.workspaceId === workspaceId)
          .map((item) => (
            <li key={item.sourceId} className="min-w-0 rounded-md border border-line p-3">
              <h3>{item.label}</h3>
              <p>
                {item.kind.replaceAll("_", " ")} · {item.status} · {item.latestScan?.status ?? "No scan recorded"}
              </p>
              <Button
                size="sm"
                className="min-w-0 max-w-full"
                onClick={() =>
                  route.navigate(`/library/knowledge?sourceId=${encodeURIComponent(item.sourceId)}&shell=cockpit`)
                }
              >
                Inspect {item.label}
              </Button>
            </li>
          ))}
      </ul>
      {detail.isFetching ? <p role="status">Reading registered source…</p> : null}
      {detail.error ? <Callout tone="error">{describeApiError(detail.error).summary}</Callout> : null}
      {detail.data && detail.data.source.workspaceId !== workspaceId ? (
        <Callout tone="error">This source does not belong to the current workspace.</Callout>
      ) : null}
      {detail.data?.source.workspaceId === workspaceId ? (
        <SourceOperations
          key={`${workspaceId}:${sourceId}`}
          detail={detail.data}
          workspaceId={workspaceId}
          available={!query.isError && !detail.isError && !detail.isFetching}
        />
      ) : null}
    </section>
  );
}
export type SourceReview = {
  action: "scan" | "plan" | "apply";
  revision: number;
  scanId?: string;
  selected: string[];
  plan?: ExternalSourceImportPlanResponse;
  source: ExternalSourceDetailResponse["source"];
  itemLabels: Record<string, string>;
};

export type SourceOperationsProps = {
  detail: ExternalSourceDetailResponse;
  workspaceId: string;
  available: boolean;
};
