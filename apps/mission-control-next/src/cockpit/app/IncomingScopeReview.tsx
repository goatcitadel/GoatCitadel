import { lazy, Suspense } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { Button } from "../ui/Button";
import { useCockpitRoute } from "./use-cockpit-route";
import { AreaErrorBoundary } from "../ui/AreaErrorBoundary";

const LinkedScopeOptions = lazy(async () => ({ default: (await import("./LinkedScopeOptions")).LinkedScopeOptions }));

/** The address without the scope it asked for, so the page stays in the scope that is open. */
function withoutRequestedScope(pathname: string, search: string, hash: string) {
  const parameters = new URLSearchParams(search);
  parameters.delete("workspaceId");
  parameters.delete("citadelId");
  const rest = parameters.toString();
  return `${pathname}${rest ? `?${rest}` : ""}${hash}`;
}

/** Bookmarks request a view. Only the existing reviewed directory owner can select its scope. */
export function IncomingScopeReview() {
  const { pathname, search, hash, navigate } = useCockpitRoute();
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const parameters = new URLSearchParams(search);
  const citadelId = parameters.get("citadelId"),
    workspaceId = parameters.get("workspaceId");
  const workspaceMismatch = Boolean(workspaceId && workspaceId !== activeWorkspaceId);
  const citadelMismatch = Boolean(citadelId && citadelId !== activeCitadelId);
  // The directory is read only for a link that asks for another scope.
  if (!workspaceMismatch && !citadelMismatch) return null;
  const destination = pathname + search + hash;
  return (
    <section
      aria-label="Linked scope review"
      className="flex flex-wrap items-center gap-3 border-b border-line bg-raised px-4 py-3"
    >
      <AreaErrorBoundary label="Linked scope review" resetKey={destination}>
        <Suspense
          fallback={
            <p role="status" className="min-w-0 flex-1 text-sm text-fg-secondary">
              Loading linked scope review…
            </p>
          }
        >
          <LinkedScopeOptions
            destination={destination}
            citadelId={citadelId}
            workspaceId={workspaceMismatch ? workspaceId : null}
          />
        </Suspense>
      </AreaErrorBoundary>
      <Button onClick={() => navigate(withoutRequestedScope(pathname, search, hash), { replace: true })}>
        Stay here
      </Button>
    </section>
  );
}
