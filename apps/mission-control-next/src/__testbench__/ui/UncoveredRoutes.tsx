import { EmptyState } from "@next/features/native-routes/primitives";
import type { CoverageReport } from "../runner/routes";
import { groupRoutesByDomain } from "./filters";

export interface UncoveredRoutesProps {
  readonly coverage: CoverageReport | undefined;
  readonly labelFor: (domain: string) => string;
}

export function UncoveredRoutes({ coverage, labelFor }: UncoveredRoutesProps) {
  if (!coverage) {
    return (
      <EmptyState
        title="Route list unavailable"
        description="This gateway did not serve its route list, so uncovered routes cannot be listed. Development verification endpoints may be off."
      />
    );
  }
  return (
    <section className="testbench-uncovered" aria-label="Uncovered routes">
      <p className="testbench-meta">{`${coverage.uncovered.length} of ${coverage.total} routes have no check yet.`}</p>
      {coverage.staleClaims.length > 0 ? (
        <>
          <h2>Stale claims</h2>
          <ul>
            {coverage.staleClaims.map((claim) => (
              <li key={`${claim.checkId}:${claim.route}`}>
                <code>{claim.route}</code>
                {` claimed by ${claim.checkId} but missing from the route list`}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {groupRoutesByDomain(coverage.uncovered).map(([domain, routes]) => (
        <details key={domain}>
          <summary>{`${labelFor(domain)} (${routes.length})`}</summary>
          <ul>
            {routes.map((route) => (
              <li key={route}>
                <code>{route}</code>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}
