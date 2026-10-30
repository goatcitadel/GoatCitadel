import { SettingsSectionShell, type SettingsSectionProps } from "../SettingsShared";
import { PortablePacksSection } from "./PortablePacksSection";

/** Both shells consume the governed pack owner; the section id stays `addons` until plugins replace the packs. */
export function AddonsSection(props: SettingsSectionProps) {
  return (
    <SettingsSectionShell loading={false} error={null}>
      <PortablePacksSection {...props} />
    </SettingsSectionShell>
  );
}
