import { SettingsActionList, SettingsGrid, SettingsPanel, type SettingsSectionProps } from "../SettingsShared";

export function UnknownSettingsSection({ section, route, navigate }: SettingsSectionProps) {
  return (
    <SettingsGrid>
      <SettingsPanel
        title="Unknown settings section"
        subtitle={`No settings section is registered for "${String(section)}".`}
      >
        <SettingsActionList
          items={[
            {
              label: "Open General",
              description: "Return to the settings overview.",
              onClick: () => navigate({ area: "settings", section: "general", theme: route.theme }),
            },
            {
              label: "Open Providers",
              description: "Jump to the provider/model route used by Chat, Cowork, and Code.",
              onClick: () => navigate({ area: "settings", section: "providers", theme: route.theme }),
            },
          ]}
        />
      </SettingsPanel>
    </SettingsGrid>
  );
}
