import { FieldHelp } from "../../components/FieldHelp";
import { HelpHint } from "../../components/HelpHint";
import { Panel } from "../../components/Panel";
import { SelectOrCustom, type SelectOption } from "../../components/SelectOrCustom";
import { GCSelect, GCSwitch } from "../../components/ui";

export type DeploymentProfile = "local_dev" | "trusted_local" | "remote_hardened";
export type BudgetMode = "saver" | "balanced" | "power";
export type ReadAccessMode = "roots_only" | "approval_required" | "full_disk";

export interface AllowlistPreset {
  id: string;
  label: string;
  hosts: string[];
}

export interface SettingsRuntimeSectionProps {
  deploymentProfile: DeploymentProfile;
  onDeploymentProfileChange: (value: DeploymentProfile) => void;
  profile: string;
  onProfileChange: (value: string) => void;
  toolProfileOptions: SelectOption[];
  budgetMode: BudgetMode;
  onBudgetModeChange: (value: BudgetMode) => void;
  readAccessMode: ReadAccessMode;
  onReadAccessModeChange: (value: ReadAccessMode) => void;
  readAccessModeOptions: SelectOption[];
  allowlistPreset: string;
  onAllowlistPresetChange: (nextPreset: string) => void;
  allowlistPresets: AllowlistPreset[];
  networkAllowlistText: string;
  onNetworkAllowlistTextChange: (value: string) => void;
  firecrawlEnabled: boolean;
  onFirecrawlEnabledChange: (value: boolean) => void;
  firecrawlDefaultReadBackend: "native" | "firecrawl";
  onFirecrawlDefaultReadBackendChange: (value: "native" | "firecrawl") => void;
  firecrawlDefaultReadBackendOptions: SelectOption[];
  firecrawlBaseUrl: string;
  onFirecrawlBaseUrlChange: (value: string) => void;
  firecrawlApiKeyEnv: string;
  onFirecrawlApiKeyEnvChange: (value: string) => void;
  firecrawlTimeoutMs: number;
  onFirecrawlTimeoutMsChange: (value: number) => void;
  firecrawlFallbackToNative: boolean;
  onFirecrawlFallbackToNativeChange: (value: boolean) => void;
  onSaveRuntime: () => void;
  blockSaves: boolean;
}

export function SettingsRuntimeSection(props: SettingsRuntimeSectionProps) {
  const {
    deploymentProfile,
    onDeploymentProfileChange,
    profile,
    onProfileChange,
    toolProfileOptions,
    budgetMode,
    onBudgetModeChange,
    readAccessMode,
    onReadAccessModeChange,
    readAccessModeOptions,
    allowlistPreset,
    onAllowlistPresetChange,
    allowlistPresets,
    networkAllowlistText,
    onNetworkAllowlistTextChange,
    firecrawlEnabled,
    onFirecrawlEnabledChange,
    firecrawlDefaultReadBackend,
    onFirecrawlDefaultReadBackendChange,
    firecrawlDefaultReadBackendOptions,
    firecrawlBaseUrl,
    onFirecrawlBaseUrlChange,
    firecrawlApiKeyEnv,
    onFirecrawlApiKeyEnvChange,
    firecrawlTimeoutMs,
    onFirecrawlTimeoutMsChange,
    firecrawlFallbackToNative,
    onFirecrawlFallbackToNativeChange,
    onSaveRuntime,
    blockSaves,
  } = props;

  return (
    <section id="settings-runtime" className="settings-v2-section">
      <Panel
        className="settings-v2-panel"
        title="Runtime Controls"
        subtitle="Configure how boldly GoatCitadel acts by default before you change providers, tools, or outbound access."
      >
        <FieldHelp>
          Runtime controls shape how boldly GoatCitadel acts by default. Use the allowlist preset first, then drop into
          custom mode only when your network or model layout needs it.
        </FieldHelp>
        <div className="controls-row">
          <label htmlFor="deploymentProfile">
            Deployment Profile
            <HelpHint
              label="Deployment profile help"
              text="Local Dev is loose for iteration, Trusted Local enables browser state tools on a trusted machine, and Remote Hardened requires explicit auth, host allowlists, and approval bypass disabled."
            />
          </label>
          <GCSelect
            id="deploymentProfile"
            value={deploymentProfile}
            onChange={(value) => onDeploymentProfileChange(value as DeploymentProfile)}
            options={[
              { value: "local_dev", label: "Local Dev" },
              { value: "trusted_local", label: "Trusted Local" },
              { value: "remote_hardened", label: "Remote Hardened" },
            ]}
          />
        </div>
        {deploymentProfile === "remote_hardened" ? (
          <FieldHelp>
            Hardened mode fails closed unless auth is enabled, loopback bypass stays off, outbound hosts are explicitly
            allowlisted, approval bypass is unavailable, and browser submit flows include verification plus
            confirm-before-submit.
          </FieldHelp>
        ) : null}
        <div className="controls-row">
          <label htmlFor="profile">Tool Profile</label>
          <SelectOrCustom
            id="profile"
            value={profile}
            onChange={onProfileChange}
            options={toolProfileOptions}
            customPlaceholder="Custom tool profile"
            customLabel="Custom profile"
          />
        </div>
        <div className="controls-row">
          <label htmlFor="budgetMode">Budget Mode</label>
          <GCSelect
            id="budgetMode"
            value={budgetMode}
            onChange={(value) => onBudgetModeChange(value as BudgetMode)}
            options={[
              { value: "saver", label: "saver" },
              { value: "balanced", label: "balanced" },
              { value: "power", label: "power" },
            ]}
          />
        </div>
        <details className="advanced-panel">
          <summary>Advanced runtime options</summary>
          <div className="controls-row">
            <label htmlFor="readAccessMode">Filesystem Read Access</label>
            <GCSelect
              id="readAccessMode"
              value={readAccessMode}
              onChange={(value) => onReadAccessModeChange(value as ReadAccessMode)}
              options={readAccessModeOptions}
            />
          </div>
          <FieldHelp>
            `trusted roots only` keeps reads inside the configured workspace and skills roots. `ask before outside-root
            reads` turns out-of-root local file reads into approval prompts in chat. `full disk read access` skips those
            prompts. Prompt Lab still bootstraps its own read grants for evaluation runs.
          </FieldHelp>
          <div className="controls-row">
            <label htmlFor="allowlistPreset">
              Allowlist Preset{" "}
              <HelpHint
                label="Network allowlist help"
                text="This controls outbound hosts GoatCitadel is allowed to contact. It is not your machine's LAN IP. Use local hosts for local models, and provider domains such as api.z.ai for cloud models."
              />
            </label>
            <GCSelect
              id="allowlistPreset"
              value={allowlistPreset}
              onChange={onAllowlistPresetChange}
              options={[
                ...allowlistPresets.map((preset) => ({
                  value: preset.id,
                  label: preset.label,
                })),
                { value: "custom", label: "custom" },
              ]}
            />
          </div>
          <div className="controls-row">
            <label htmlFor="firecrawlEnabled">Firecrawl Read Backend</label>
            <GCSwitch
              id="firecrawlEnabled"
              checked={firecrawlEnabled}
              onCheckedChange={(checked: boolean) => onFirecrawlEnabledChange(Boolean(checked))}
            />
          </div>
          <FieldHelp>
            Firecrawl only powers read-heavy browser work here: `browser.search`, `browser.navigate`, `browser.extract`,
            and URL-based `docs.ingest`. Interactive browser state stays native.
          </FieldHelp>
          <div className="controls-row">
            <label htmlFor="firecrawlDefaultReadBackend">Default Read Backend</label>
            <GCSelect
              id="firecrawlDefaultReadBackend"
              value={firecrawlDefaultReadBackend}
              onChange={(value) => onFirecrawlDefaultReadBackendChange(value as "native" | "firecrawl")}
              options={firecrawlDefaultReadBackendOptions}
            />
          </div>
          <div className="controls-row">
            <label htmlFor="firecrawlBaseUrl">Firecrawl Base URL</label>
            <input
              id="firecrawlBaseUrl"
              type="url"
              value={firecrawlBaseUrl}
              onChange={(event) => onFirecrawlBaseUrlChange(event.target.value)}
              placeholder="http://127.0.0.1:3002"
            />
          </div>
          <div className="controls-row">
            <label htmlFor="firecrawlApiKeyEnv">Firecrawl API Key Env</label>
            <input
              id="firecrawlApiKeyEnv"
              value={firecrawlApiKeyEnv}
              onChange={(event) => onFirecrawlApiKeyEnvChange(event.target.value)}
              placeholder="FIRECRAWL_API_KEY"
            />
          </div>
          <div className="controls-row">
            <label htmlFor="firecrawlTimeoutMs">Firecrawl Timeout (ms)</label>
            <input
              id="firecrawlTimeoutMs"
              type="number"
              min={1000}
              step={1000}
              value={firecrawlTimeoutMs}
              onChange={(event) =>
                onFirecrawlTimeoutMsChange(Math.max(1000, Number.parseInt(event.target.value || "0", 10) || 20000))
              }
            />
          </div>
          <div className="controls-row">
            <label htmlFor="firecrawlFallbackToNative">Fallback To Native</label>
            <GCSwitch
              id="firecrawlFallbackToNative"
              checked={firecrawlFallbackToNative}
              onCheckedChange={(checked: boolean) => onFirecrawlFallbackToNativeChange(Boolean(checked))}
            />
          </div>
          <label htmlFor="allowlist">Network Allowlist (one host/pattern per line)</label>
          <textarea
            id="allowlist"
            rows={6}
            className="full-textarea"
            value={networkAllowlistText}
            onChange={(event) => onNetworkAllowlistTextChange(event.target.value)}
          />
        </details>
        <button type="button" onClick={onSaveRuntime} disabled={blockSaves} className="gc-button">
          Save Runtime Controls
        </button>
      </Panel>
    </section>
  );
}
