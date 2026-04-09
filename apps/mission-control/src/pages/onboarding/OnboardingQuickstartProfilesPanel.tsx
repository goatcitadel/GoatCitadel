interface OnboardingQuickstartPreset {
  id: string;
  title: string;
  summary: string;
}

interface OnboardingQuickstartProfilesPanelProps {
  presets: readonly OnboardingQuickstartPreset[];
  onApplyQuickstartPreset: (presetId: string) => void;
}

export function OnboardingQuickstartProfilesPanel(props: OnboardingQuickstartProfilesPanelProps) {
  const { presets, onApplyQuickstartPreset } = props;

  return (
    <article className="card">
      <h3>Quickstart Profiles</h3>
      <p className="office-subtitle">
        Pick the closest operator posture, then refine provider and mesh details before apply.
      </p>
      <div className="compact-list">
        {presets.map((preset) => (
          <li key={preset.id}>
            <strong>{preset.title}</strong> {preset.summary}
            <div className="actions" style={{ marginTop: 8 }}>
              <button type="button" onClick={() => onApplyQuickstartPreset(preset.id)}>
                Load profile
              </button>
            </div>
          </li>
        ))}
      </div>
    </article>
  );
}
