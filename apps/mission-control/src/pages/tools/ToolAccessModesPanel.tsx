import { StatusChip } from "../../components/StatusChip";
import { Panel } from "../../components/Panel";

interface ToolProfilePreset {
  id: string;
  label: string;
  helper: string;
}

interface ToolAccessModesPanelProps {
  currentToolProfile: string;
  profileSwitchBusy: string | null;
  presets: ToolProfilePreset[];
  showTechnicalDetails: boolean;
  setShowTechnicalDetails: (value: boolean) => void;
  uiMode: string;
  onApplyToolProfile: (profileId: string) => Promise<void>;
}

export function ToolAccessModesPanel(props: ToolAccessModesPanelProps) {
  const {
    currentToolProfile,
    profileSwitchBusy,
    presets,
    showTechnicalDetails,
    setShowTechnicalDetails,
    uiMode,
    onApplyToolProfile,
  } = props;

  return (
    <Panel
      title="Access Modes"
      subtitle={
        <>
          One-click profile switching for safe days versus power days. Current profile:{" "}
          <strong>{currentToolProfile}</strong>.
        </>
      }
    >
      <div className="tool-profile-grid">
        {presets.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className={["gc-button", (`tool-profile-card ${currentToolProfile === preset.id ? "active" : ""}`)].filter(Boolean).join(" ")}
            onClick={() => void onApplyToolProfile(preset.id)}
            disabled={profileSwitchBusy !== null}
          >
            <strong>{preset.label}</strong>
            <span>{preset.helper}</span>
            <small>{preset.id}</small>
            {profileSwitchBusy === preset.id ? <em>Applying…</em> : null}
          </button>
        ))}
      </div>
      <label className="tools-advanced-toggle">
        <input
          type="checkbox"
          checked={showTechnicalDetails}
          onChange={(event) => setShowTechnicalDetails(event.target.checked)}
        />
        Show technical controls on this and other pages
      </label>
      {uiMode === "simple" && !showTechnicalDetails ? (
        <p className="tools-helper">
          Beginner mode is active. You can still grant access safely with the wizard below.
        </p>
      ) : null}
      <div className="workflow-summary-strip" style={{ marginTop: 12 }}>
        <StatusChip tone="live">{currentToolProfile}</StatusChip>
      </div>
    </Panel>
  );
}
