import { useEffect, useRef } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { CapabilityCatalog } from "./CapabilityCatalog";
import { MeshCapabilityPublications } from "./MeshCapabilityPublications";
import { LibraryPromptPacks } from "./LibraryPromptPacks";
import { LibraryResources } from "./LibraryResources";
import { RESOURCE_KINDS, type ResourceKind } from "./library-resources";
import { isLibraryGovernanceSection, LibraryGovernanceRoute } from "./LibraryGovernanceRoute";
import { AREA_TABS } from "../../ui/area-layout";
import { getRouteReleaseScope, isPrimaryRailRoute, describeReleaseSurfaceStatus, type AppRoute } from "../../../app/route-model";
import { readCatalogLocation } from "./capability-catalog-route";
import { EmptyState } from "../../ui/EmptyState";
import { LibraryAgentsWorkspace } from "./LibraryAgentsWorkspace";
import { LibraryKnowledgeWorkspace } from "./LibraryKnowledgeWorkspace";
import { LibraryCommunications } from "./LibraryCommunications";
import { LibraryCurator } from "./LibraryCurator";
import { LibraryJourney } from "./LibraryJourney";

const NATIVE_SECTIONS = ["agents", "knowledge", "communications", "curator", "journey", "prompt-packs"] as const;
type NativeSection = (typeof NATIVE_SECTIONS)[number];
const SECTION_LABELS: Partial<Record<string, string>> = { communications: "Mail", "prompt-packs": "Prompt packs" };


export function LibraryArea() {
  const route = useCockpitRoute();
  const sectionsRef = useRef<HTMLElement>(null);
  const sectionPath = route.rest.join("/");
  useEffect(() => {
    sectionsRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sectionPath]);
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const kind =
    route.rest.length === 1 && RESOURCE_KINDS.includes(route.rest[0] as ResourceKind)
      ? (route.rest[0] as ResourceKind)
      : undefined;
  const workspaceId = activeWorkspaceId ?? "default";
  const citadelId = activeCitadelId ?? "personal";
  const nativeSection = route.rest.length === 1 && NATIVE_SECTIONS.includes(route.rest[0] as NativeSection) ? (route.rest[0] as NativeSection) : undefined;
  const governance = route.rest.length === 1 && isLibraryGovernanceSection(route.rest[0]!) ? route.rest[0]! : undefined;
  const release = getRouteReleaseScope({ area: "library", section: (governance ?? nativeSection ?? kind ?? "capabilities") as AppRoute["section"] });
  const invalid = !governance && !kind && !nativeSection && (readCatalogLocation(route.rest, "").invalidSelection ||
    (route.rest.length > 1 && RESOURCE_KINDS.includes(route.rest[0] as ResourceKind)));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav ref={sectionsRef} aria-label="Library sections" className={AREA_TABS}>
        {([undefined, ...RESOURCE_KINDS, ...NATIVE_SECTIONS] as const).filter((section) => isPrimaryRailRoute({ area: "library", section: section ?? "capabilities" })).map((section) => (
          <a
            key={section ?? "capabilities"}
            className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${!governance && section === (nativeSection ?? kind) ? "border-accent text-fg" : "border-transparent text-fg-secondary hover:text-fg"}`}
            aria-current={!governance && section === (nativeSection ?? kind) ? "page" : undefined}
            href={`/library${section ? `/${section}` : ""}?shell=cockpit`}
            onClick={(event) => {
              if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                route.navigate(event.currentTarget.getAttribute("href")!);
              }
            }}
          >
            {section ? (SECTION_LABELS[section] ?? section[0]!.toUpperCase() + section.slice(1)) : "Skills and tools"}
          </a>
        ))}
      </nav>
      {release.status !== "ship" ? <p role="status" className="px-4 py-2 text-sm text-fg-secondary">{describeReleaseSurfaceStatus(release.status)}. {release.note}</p> : null}
      {invalid ? <EmptyState title="Library destination unavailable" description="This link does not identify a supported Library destination. Check the link or open Library." /> : nativeSection === "agents" ? <LibraryAgentsWorkspace key={workspaceId} workspaceId={workspaceId} /> : nativeSection === "knowledge" ? <LibraryKnowledgeWorkspace key={workspaceId} workspaceId={workspaceId} /> : nativeSection === "communications" ? <LibraryCommunications key={workspaceId} workspaceId={workspaceId} /> : nativeSection === "curator" ? <LibraryCurator key={workspaceId} workspaceId={workspaceId} /> : nativeSection === "journey" ? <LibraryJourney key={workspaceId} workspaceId={workspaceId} /> : nativeSection === "prompt-packs" ? <LibraryPromptPacks key={workspaceId} workspaceId={workspaceId} /> : governance && isLibraryGovernanceSection(governance) ? <LibraryGovernanceRoute section={governance} citadelId={activeCitadelId ?? ""} /> : kind ? (
        <LibraryResources
          key={JSON.stringify([workspaceId, citadelId, kind])}
          kind={kind}
          workspaceId={workspaceId}
          citadelId={citadelId}
        />
      ) : (
        <>
          {route.rest.length === 0 ? <section className="grid gap-2 border-b border-line p-4" aria-label="Library overview"><h1 className="font-display text-xl font-semibold">Library</h1><p className="text-sm text-fg-secondary">Manage workspace notes and memory, transfer files and artifacts, and inspect skills, agents and governed knowledge. Use the sections above to open each owner.</p><nav aria-label="Library governance" className="flex flex-wrap gap-3">{["citadel-overview", "citadel", "citadel-wards", "citadel-council", "citadel-blueprint", "citadel-vault"].map(section => <a key={section} className="text-sm text-accent hover:underline" href={`/library/${section}?shell=cockpit`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); route.navigate(event.currentTarget.getAttribute("href")!); } }}>{section.replace("citadel-", "").replace(/^./u, letter => letter.toUpperCase())}</a>)}</nav></section> : null}
          <CapabilityCatalog />
          {route.rest.length === 0 ? <MeshCapabilityPublications key={workspaceId} workspaceId={workspaceId} /> : null}
        </>
      )}
    </div>
  );
}
