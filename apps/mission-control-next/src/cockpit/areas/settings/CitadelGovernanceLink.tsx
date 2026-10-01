import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";

export function CitadelGovernanceLink({ activeCitadelId }: { activeCitadelId: string }) {
  return (
    <ClassicOwnerLink
      href="/library/citadel-overview?shell=classic"
      scope={activeCitadelId}
      label="Open Citadel governance"
      openingLabel="Opening Citadel governance…"
      errorLabel="Citadel governance could not open. Your current drafts are still available."
    />
  );
}
