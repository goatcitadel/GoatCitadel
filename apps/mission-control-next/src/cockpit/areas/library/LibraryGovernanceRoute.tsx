import { CitadelOverviewSettings } from "../settings/CitadelOverviewSettings";
import { CitadelBlueprintSettings } from "../settings/CitadelBlueprintSettings";
import { CitadelMasonSettings } from "../settings/CitadelMasonSettings";
import { CitadelWardsSettings } from "../settings/CitadelWardsSettings";
import { CitadelCouncilSettings } from "../settings/CitadelCouncilSettings";
import { CitadelVaultSettings } from "../settings/CitadelVaultSettings";
import { CITADEL_PAGE_LABELS } from "../../../app/route-model";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";

// Headings use the shared Citadel page names so Library, Settings, the nav rail and document titles agree.
const GOVERNANCE_SECTIONS = CITADEL_PAGE_LABELS;

export function isLibraryGovernanceSection(section: string): section is keyof typeof GOVERNANCE_SECTIONS {
  return Object.hasOwn(GOVERNANCE_SECTIONS, section);
}

export function LibraryGovernanceRoute({
  section,
  citadelId,
}: {
  section: keyof typeof GOVERNANCE_SECTIONS;
  citadelId: string;
}) {
  return (
    <section className={`${AREA_PAGE} min-w-0`}>
      <AreaHeader
        title={GOVERNANCE_SECTIONS[section]}
        description="Governance for the active Citadel. Settings › Citadel lists every Citadel page."
      />
      {section === "citadel-overview" ? (
        <CitadelOverviewSettings key={citadelId} citadelId={citadelId} />
      ) : section === "citadel-blueprint" ? (
        <CitadelBlueprintSettings key={citadelId} citadelId={citadelId} />
      ) : section === "citadel" ? (
        <CitadelMasonSettings key={citadelId} citadelId={citadelId} />
      ) : section === "citadel-wards" ? (
        <CitadelWardsSettings key={citadelId} citadelId={citadelId} />
      ) : section === "citadel-council" ? (
        <CitadelCouncilSettings key={citadelId} citadelId={citadelId} />
      ) : section === "citadel-vault" ? (
        <CitadelVaultSettings key={citadelId} citadelId={citadelId} />
      ) : null}
    </section>
  );
}
