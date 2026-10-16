import { useQuery } from "@tanstack/react-query";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { loadCapabilityCatalog } from "../library/capability-catalog";

export function SafetyCatalogSummary() {
  const { navigate } = useCockpitRoute();
  const query = useQuery({ queryKey: queryKeys.capabilities(), queryFn: loadCapabilityCatalog });
  const catalog = query.isError ? undefined : query.data;
  const links = [
    { kind: "tool", label: "Tools", action: "Open tools in Library" },
    { kind: "skill", label: "Skills", action: "Open skills in Library" },
  ];
  return (
    <section
      aria-labelledby="safety-catalog-title"
      className="mt-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="safety-catalog-title" className="text-md font-semibold text-fg">
            Tools and skills
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Library shows availability, policy, trust, and settings for each entry. An entry in the catalog does not
            bypass approvals or grant permission for a specific action.
          </p>
        </div>
        <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
          Refresh catalog
        </Button>
      </div>
      {query.isPending ? (
        <p role="status" className="mt-3 text-sm text-fg-muted">
          Loading tools and skills…
        </p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          {describeApiError(query.error).summary}
        </p>
      ) : null}
      {catalog ? (
        <>
          {catalog.issues.length ? (
            <p className="mt-3 text-sm text-status-waiting">
              Some catalog sources are unavailable, so these counts may be incomplete.
            </p>
          ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {links.map(({ kind, label, action }) => {
              const entries = catalog.items.filter((item) => item.kind === kind);
              const href = `/library?shell=cockpit&type=${kind}`;
              return (
                <div key={kind} className="rounded-md border border-line bg-raised p-3">
                  <h4 className="text-sm font-medium text-fg">{label}</h4>
                  <p className="mt-1 text-sm text-fg-secondary">
                    {entries.length} catalog entries
                    {catalog.callableKnown
                      ? ` · ${entries.filter((item) => item.callable).length} in the current callable catalog`
                      : " · Callability unknown"}
                  </p>
                  <a
                    href={href}
                    className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(href);
                    }}
                  >
                    {action}
                  </a>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}
