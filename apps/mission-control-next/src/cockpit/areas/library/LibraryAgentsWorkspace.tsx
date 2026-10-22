import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAgents } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useCockpitRoute } from "../../app/use-cockpit-route";

import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import { LibraryAgentEditor } from "./LibraryAgentEditor";
import { LibraryImportedAgents } from "./LibraryImportedAgents";
import { LIBRARY_SECTION_LABELS } from "./library-sections";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";

const AGENT_VIEWS = [
  { id: "profiles", label: "Profiles" },
  { id: "catalog", label: "Imported catalog" },
] as const;

export function LibraryAgentsWorkspace({ workspaceId }: { workspaceId: string }) {
  const access = useProjectAccess(workspaceId);
  return <AgentsWorkspace key={access.identity} workspaceId={workspaceId} identity={access.identity} />;
}
function AgentsWorkspace({ workspaceId, identity }: { workspaceId: string; identity: string }) {
  const route = useCockpitRoute();
  const params = new URLSearchParams(route.search),
    agentId = params.get("agentId"),
    catalog = params.get("view") === "catalog";
  const creating = !agentId && params.get("view") === "create";
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["library", "agents", identity],
    queryFn: () => fetchAgents("all", 160),
    staleTime: 0,
  });
  function select(id?: string) {
    const next = new URLSearchParams(route.search);
    if (id) next.set("agentId", id);
    else next.delete("agentId");
    next.delete("view");
    next.set("shell", "cockpit");
    route.requestTransition((review) => {
      if (review.isCurrent()) {
        review.navigate(`/library/agents?${next}`);
      }
    });
  }
  return (
    <section className={AREA_PAGE} aria-label="Library Agents">
      <AreaHeader
        title={LIBRARY_SECTION_LABELS.agents}
        description="Installation profiles and workspace imported definitions. Tool access remains governed by GoatCitadel policy and grants."
        actions={
          <>
            <Button
              size="sm"
              onClick={() =>
                route.requestTransition((review) => {
                  if (review.isCurrent()) {
                    const next = new URLSearchParams(route.search);
                    next.delete("agentId");
                    next.set("view", "create");
                    next.set("shell", "cockpit");
                    review.navigate(`/library/agents?${next}`);
                  }
                })
              }
            >
              New agent profile
            </Button>
            <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
              Refresh agent profiles
            </Button>
          </>
        }
      />
      {/* One segmented control; the pressed button names the open view (LB-N03). */}
      <div role="group" aria-label="Agent views" className="flex flex-wrap gap-2">
        {AGENT_VIEWS.map((view) => (
          <Button
            key={view.id}
            aria-pressed={catalog === (view.id === "catalog")}
            variant={catalog === (view.id === "catalog") ? "primary" : "secondary"}
            onClick={() =>
              route.requestTransition((review) => {
                if (review.isCurrent()) review.navigate(`/library/agents?view=${view.id}&shell=cockpit`);
              })
            }
          >
            {view.label}
          </Button>
        ))}
      </div>
      {query.isPending ? <p role="status">Loading agent profiles…</p> : null}
      {query.error ? <Callout tone="error">{describeApiError(query.error).summary}</Callout> : null}
      {!catalog ? (
        <>
          <Field label="Search agents">
            {(props) => (
              <input
                {...props}
                className="rounded-md border border-line bg-raised p-2"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
          </Field>
          <p className="text-sm text-fg-muted">Up to 160 installation profiles.</p>
          <ul className="divide-y divide-line-subtle">
            {query.data?.items
              .filter((item) =>
                `${item.name} ${item.title} ${item.roleId} ${item.summary}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((item) => (
                <li key={item.agentId} className="space-y-1 py-3">
                  <h2 className="font-semibold">{item.name}</h2>
                  <p className="text-sm text-fg-secondary">
                    {item.title}
                    {" · "}
                    {item.lifecycleStatus}
                    {" · "}
                    {item.isBuiltin ? "Built-in role" : "Custom profile"}
                    {" · "}
                    {item.sessionCount}
                    {" conversations"}
                  </p>
                  <Button size="sm" onClick={() => select(item.agentId)}>
                    Open {item.name}
                  </Button>
                </li>
              ))}
          </ul>
          {creating ? (
            <LibraryAgentEditor key="new" workspaceId={workspaceId} onClose={() => select()} />
          ) : agentId ? (
            <LibraryAgentEditor key={`${workspaceId}:${agentId}`} workspaceId={workspaceId} agentId={agentId} />
          ) : null}
        </>
      ) : (
        <LibraryImportedAgents workspaceId={workspaceId} />
      )}
    </section>
  );
}
