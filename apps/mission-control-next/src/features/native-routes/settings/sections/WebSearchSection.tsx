import { useShellHandoff } from "@next/app/use-shell-handoff";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton } from "../../primitives";
import { SettingsGrid, type SettingsSectionProps } from "../SettingsShared";

/**
 * Classic rollback pointer. Web & Search is a cockpit-only owner: Firecrawl, search engine order,
 * and keychain-held keys are edited there, never through a second Classic editor.
 */
export function WebSearchSection(props: SettingsSectionProps) {
  const shellSwitch = useShellHandoff([props.activeCitadelId, props.activeWorkspaceId]);
  return (
    <SettingsGrid>
      <NativeCard
        density="compact"
        className="mc-next-settings-panel"
        title="Web & Search"
        subtitle="Firecrawl, search engines, and web-search API keys are managed in the cockpit layout."
      >
        <NativeButton variant="outline" onClick={() => shellSwitch.request("cockpit")}>
          Open Web &amp; Search in the cockpit
        </NativeButton>
      </NativeCard>
    </SettingsGrid>
  );
}
