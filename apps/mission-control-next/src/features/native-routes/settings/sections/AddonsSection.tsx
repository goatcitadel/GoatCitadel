import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { SettingsFilterBar, SettingsSectionShell, SettingsStack, type SettingsSectionProps } from "../SettingsShared";
import { AddonApplicationsSection } from "./AddonApplicationsSection";
import { PortablePacksSection } from "./PortablePacksSection";

/** Both shells consume the shared add-on lifecycle and governed pack owners. */
export function AddonsSection(props: SettingsSectionProps) {
  const [view, setView] = useSessionViewState<"addons" | "packs">("addons:view", "addons");
  const leave = useDraftLeave();
  return (
    <SettingsSectionShell loading={false} error={null}>
      <SettingsStack>
        <SettingsFilterBar label="Extension settings" value={view}
          options={[{ id: "addons", label: "Add-ons" }, { id: "packs", label: "Capability packs" }]}
          onChange={(next) => leave.request(() => setView(next === "packs" ? "packs" : "addons"))} />
        {view === "addons" ? <AddonApplicationsSection /> : <PortablePacksSection {...props} />}
        <NativeDisclosureCard id="addon-product-posture" title="1.0 add-on posture">
          <p>Experimental local extensions · operator-reviewed installation.</p>
          <p>Local-only boundary: add-ons run trusted repository code on this host. This is not hostile-code sandboxing.</p>
          <p>Only Arena has a shipped launch implementation. Portable pack staging records review evidence; runtime activation uses the capability owners.</p>
        </NativeDisclosureCard>
      </SettingsStack>
      {leave.dialog}
    </SettingsSectionShell>
  );
}
