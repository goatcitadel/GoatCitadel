import { FieldHelp } from "../../components/FieldHelp";

export interface SettingsSectionNavItem {
  id: string;
  label: string;
  description: string;
}

export interface SettingsSectionNavProps {
  sections: readonly SettingsSectionNavItem[];
  onNavigate: (sectionId: string) => void;
}

export function SettingsSectionNav({ sections, onNavigate }: SettingsSectionNavProps) {
  return (
    <aside className="panel panel-soft panel-pad-default settings-v2-nav">
      <div className="settings-v2-nav-head">
        <h3>Forge Sections</h3>
        <FieldHelp>Jump straight to the section you need instead of working through one long scroll.</FieldHelp>
      </div>
      <div className="settings-v2-nav-list">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className="settings-v2-nav-item"
            onClick={() => onNavigate(section.id)}
          >
            <strong>{section.label}</strong>
            <span>{section.description}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
