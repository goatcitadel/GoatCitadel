import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";

export function CitadelGovernanceLink({ activeCitadelId }: { activeCitadelId: string }) {
  const { search, hash } = useCockpitRoute();
  const { activeWorkspaceId } = useUiPreferences();
  const parameters = new URLSearchParams(search);
  parameters.set("citadelId", activeCitadelId);
  if (activeWorkspaceId) parameters.set("workspaceId", activeWorkspaceId);
  parameters.delete("shell");
  parameters.delete("shellScope");
  return (
    <NativeOwnerLink href={`/library/citadel-overview?${parameters}${hash}`} scope={activeCitadelId}>
      Open Citadel governance
    </NativeOwnerLink>
  );
}
