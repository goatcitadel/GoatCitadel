import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { CapabilityCatalog } from "./CapabilityCatalog";
import { LibraryResources } from "./LibraryResources";
import { RESOURCE_KINDS, type ResourceKind } from "./library-resources";
import { isLibraryGovernanceSection, LibraryGovernanceRoute } from "./LibraryGovernanceRoute";
import { AREA_TABS } from "../../ui/area-layout";

export function LibraryArea() {
  const route = useCockpitRoute();
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const kind =
    route.rest.length === 1 && RESOURCE_KINDS.includes(route.rest[0] as ResourceKind)
      ? (route.rest[0] as ResourceKind)
      : undefined;
  const workspaceId = activeWorkspaceId ?? "default";
  const citadelId = activeCitadelId ?? "personal";
  const governance = route.rest.length === 1 && isLibraryGovernanceSection(route.rest[0]!) ? route.rest[0]! : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label="Library sections" className={AREA_TABS}>
        {([undefined, ...RESOURCE_KINDS] as const).map((section) => (
          <a
            key={section ?? "capabilities"}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${!governance && section === kind ? "border-accent text-fg" : "border-transparent text-fg-secondary hover:text-fg"}`}
            aria-current={!governance && section === kind ? "page" : undefined}
            href={`/library${section ? `/${section}` : ""}?shell=cockpit`}
            onClick={(event) => {
              if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                route.navigate(event.currentTarget.getAttribute("href")!);
              }
            }}
          >
            {section ? section[0]!.toUpperCase() + section.slice(1) : "Capabilities"}
          </a>
        ))}
      </nav>
      {governance && isLibraryGovernanceSection(governance) ? <LibraryGovernanceRoute section={governance} citadelId={activeCitadelId ?? ""} /> : kind ? (
        <LibraryResources
          key={JSON.stringify([workspaceId, citadelId, kind])}
          kind={kind}
          workspaceId={workspaceId}
          citadelId={citadelId}
        />
      ) : (
        <CapabilityCatalog />
      )}
    </div>
  );
}
