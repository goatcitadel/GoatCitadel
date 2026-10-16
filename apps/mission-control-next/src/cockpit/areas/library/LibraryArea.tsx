import { useEffect, useRef } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { CapabilityCatalog } from "./CapabilityCatalog";
import { MeshCapabilityPublications } from "./MeshCapabilityPublications";
import { LibraryPromptPacks } from "./LibraryPromptPacks";
import { LibraryResources } from "./LibraryResources";
import { RESOURCE_KINDS, type ResourceKind } from "./library-resources";
import { isLibraryGovernanceSection, LibraryGovernanceRoute } from "./LibraryGovernanceRoute";
import { AREA_COLUMN, AREA_PAGE } from "../../ui/area-layout";
import { AreaHeader, AreaTabsProvider } from "../../ui/AreaHeader";
import {
  getRouteReleaseScope,
  isPrimaryRailRoute,
  describeReleaseSurfaceStatus,
  type AppRoute,
} from "../../../app/route-model";
import { readCatalogLocation } from "./capability-catalog-route";
import { EmptyState } from "../../ui/EmptyState";
import { LibraryAgentsWorkspace } from "./LibraryAgentsWorkspace";
import { LibraryKnowledgeWorkspace } from "./LibraryKnowledgeWorkspace";
import { LibraryCommunications } from "./LibraryCommunications";
import { LibraryCurator } from "./LibraryCurator";
import { LibraryJourney } from "./LibraryJourney";
import { LIBRARY_SECTION_LABELS } from "./library-sections";

const NATIVE_SECTIONS = ["agents", "knowledge", "communications", "curator", "journey", "prompt-packs"] as const;
type NativeSection = (typeof NATIVE_SECTIONS)[number];

export function LibraryArea() {
  const route = useCockpitRoute();
  const pageRef = useRef<HTMLDivElement>(null);
  const sectionPath = route.rest.join("/");
  // Each page draws the tab row in its AreaHeader; keep the selected tab in view on narrow screens.
  useEffect(() => {
    pageRef.current
      ?.querySelector<HTMLElement>('nav[aria-label="Library sections"] [aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [sectionPath]);
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const kind =
    route.rest.length === 1 && RESOURCE_KINDS.includes(route.rest[0] as ResourceKind)
      ? (route.rest[0] as ResourceKind)
      : undefined;
  const workspaceId = activeWorkspaceId ?? "default";
  const citadelId = activeCitadelId ?? "personal";
  const nativeSection =
    route.rest.length === 1 && NATIVE_SECTIONS.includes(route.rest[0] as NativeSection)
      ? (route.rest[0] as NativeSection)
      : undefined;
  const governance = route.rest.length === 1 && isLibraryGovernanceSection(route.rest[0]!) ? route.rest[0]! : undefined;
  const release = getRouteReleaseScope({
    area: "library",
    section: (governance ?? nativeSection ?? kind ?? "capabilities") as AppRoute["section"],
  });
  const invalid =
    !governance &&
    !kind &&
    !nativeSection &&
    (readCatalogLocation(route.rest, "").invalidSelection ||
      (route.rest.length > 1 && RESOURCE_KINDS.includes(route.rest[0] as ResourceKind)));
  const tabs = ([undefined, ...RESOURCE_KINDS, ...NATIVE_SECTIONS] as const)
    .filter((section) => isPrimaryRailRoute({ area: "library", section: section ?? "capabilities" }))
    .map((section) => ({
      id: section ?? "capabilities",
      label: LIBRARY_SECTION_LABELS[section ?? "capabilities"],
      href: `/library${section ? `/${section}` : ""}?shell=cockpit`,
    }));
  return (
    <AreaTabsProvider
      label="Library sections"
      tabs={tabs}
      current={governance ? "" : (nativeSection ?? kind ?? "capabilities")}
      navigate={(href) => route.navigate(href)}
    >
      <div ref={pageRef} className="flex h-full min-h-0 flex-col">
        {release.status !== "ship" ? (
          <p role="status" className={`${AREA_COLUMN} px-4 pt-3 text-sm text-fg-secondary sm:px-6`}>
            {describeReleaseSurfaceStatus(release.status)}. {release.note}
          </p>
        ) : null}
        {invalid ? (
          <div className={AREA_PAGE}>
            <AreaHeader title="Library" />
            <EmptyState
              title="Library destination unavailable"
              description="This link does not identify a supported Library destination. Check the link or open Library."
            />
          </div>
        ) : nativeSection === "agents" ? (
          <LibraryAgentsWorkspace key={workspaceId} workspaceId={workspaceId} />
        ) : nativeSection === "knowledge" ? (
          <LibraryKnowledgeWorkspace key={workspaceId} workspaceId={workspaceId} />
        ) : nativeSection === "communications" ? (
          <LibraryCommunications key={workspaceId} workspaceId={workspaceId} />
        ) : nativeSection === "curator" ? (
          <LibraryCurator key={workspaceId} workspaceId={workspaceId} />
        ) : nativeSection === "journey" ? (
          <LibraryJourney key={workspaceId} workspaceId={workspaceId} />
        ) : nativeSection === "prompt-packs" ? (
          <LibraryPromptPacks key={workspaceId} workspaceId={workspaceId} />
        ) : governance && isLibraryGovernanceSection(governance) ? (
          // Citadel pages belong to Settings › Citadel (navigationAreaForRoute); their old Library paths stay
          // routable here, under the Library tabs with none selected.
          <LibraryGovernanceRoute section={governance} citadelId={activeCitadelId ?? ""} />
        ) : kind ? (
          <LibraryResources
            key={JSON.stringify([workspaceId, citadelId, kind])}
            kind={kind}
            workspaceId={workspaceId}
            citadelId={citadelId}
          />
        ) : (
          <CapabilityCatalog
            footer={
              route.rest.length === 0 ? (
                <MeshCapabilityPublications key={workspaceId} workspaceId={workspaceId} />
              ) : null
            }
          />
        )}
      </div>
    </AreaTabsProvider>
  );
}
