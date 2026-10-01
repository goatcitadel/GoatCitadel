import { CitadelOverviewSettings } from "../settings/CitadelOverviewSettings";
import { CitadelBlueprintSettings } from "../settings/CitadelBlueprintSettings";
import { CitadelMasonSettings } from "../settings/CitadelMasonSettings";
import { CitadelWardsSettings } from "../settings/CitadelWardsSettings";
import { CitadelCouncilSettings } from "../settings/CitadelCouncilSettings";
import { CitadelVaultSettings } from "../settings/CitadelVaultSettings";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";

const GOVERNANCE_SECTIONS = {
  "citadel-overview": "Citadel Overview",
  "citadel-blueprint": "Citadel Blueprint",
  citadel: "Citadel Mason",
  "citadel-wards": "Citadel Wards",
  "citadel-council": "Citadel Council",
  "citadel-vault": "Citadel Vault",
} as const;

export function isLibraryGovernanceSection(section: string): section is keyof typeof GOVERNANCE_SECTIONS {
  return Object.hasOwn(GOVERNANCE_SECTIONS, section);
}

export function LibraryGovernanceRoute({ section, citadelId }: { section: keyof typeof GOVERNANCE_SECTIONS; citadelId: string }) {
  return <section className="mx-auto w-full min-w-0 max-w-5xl space-y-4 p-4 sm:p-6">
    <h1 className="font-display text-xl font-semibold text-fg">{GOVERNANCE_SECTIONS[section]}</h1>
    {section === "citadel-overview" ? <CitadelOverviewSettings key={citadelId} citadelId={citadelId} />
      : section === "citadel-blueprint" ? <CitadelBlueprintSettings key={citadelId} citadelId={citadelId} />
      : section === "citadel" ? <CitadelMasonSettings key={citadelId} citadelId={citadelId} />
      : section === "citadel-wards" ? <CitadelWardsSettings key={citadelId} citadelId={citadelId} />
      : section === "citadel-council" ? <CitadelCouncilSettings key={citadelId} citadelId={citadelId} />
      : section === "citadel-vault" ? <CitadelVaultSettings key={citadelId} citadelId={citadelId} />
      : <><p className="text-sm text-fg-secondary">Open the detailed controls for this Citadel.</p>
        <ClassicOwnerLink href={`/library/${section}?shell=classic`} scope={citadelId} label={`Open ${GOVERNANCE_SECTIONS[section]}`} /></>}
  </section>;
}
