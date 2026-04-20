import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";
import { formatDeploymentProfileLabel } from "../settings-page-utils";

export interface SettingsOverviewSectionProps {
  environment: string;
  workspaceDir: string;
  deploymentProfile: "local_dev" | "trusted_local" | "remote_hardened";
  authMode: "none" | "token" | "basic";
  activeProviderId: string;
  fallbackProviderId: string;
  activeModel: string;
  fallbackModel: string;
  allowLoopbackBypass: boolean;
}

export function SettingsOverviewSection({
  environment,
  workspaceDir,
  deploymentProfile,
  authMode,
  activeProviderId,
  fallbackProviderId,
  activeModel,
  fallbackModel,
  allowLoopbackBypass,
}: SettingsOverviewSectionProps) {
  const resolvedProvider = activeProviderId || fallbackProviderId || "not set";
  const resolvedModel = activeModel || fallbackModel || "not set";
  return (
    <section id="settings-overview" className="settings-v2-section">
      <Panel title="Current settings" subtitle="Environment, defaults, and access state." tone="soft">
        <div className="settings-v2-summary">
          <StatusChip tone="muted">{environment}</StatusChip>
          <StatusChip
            tone={
              deploymentProfile === "remote_hardened"
                ? "warning"
                : deploymentProfile === "trusted_local"
                  ? "success"
                  : "muted"
            }
          >
            {formatDeploymentProfileLabel(deploymentProfile)}
          </StatusChip>
          <StatusChip tone={authMode === "none" ? "warning" : "success"}>
            {authMode === "none" ? "Local-trusted auth" : `${authMode} auth`}
          </StatusChip>
          <StatusChip tone="live">{activeProviderId || fallbackProviderId || "No active provider"}</StatusChip>
          <StatusChip tone={allowLoopbackBypass ? "warning" : "success"}>
            {allowLoopbackBypass ? "Loopback bypass on" : "Loopback bypass off"}
          </StatusChip>
        </div>
        <div className="settings-v2-overview-grid">
          <div>
            <strong>Environment</strong>
            <p className="office-subtitle">{environment}</p>
          </div>
          <div>
            <strong>Deployment profile</strong>
            <p className="office-subtitle">{formatDeploymentProfileLabel(deploymentProfile)}</p>
          </div>
          <div>
            <strong>Workspace</strong>
            <p className="office-subtitle">{workspaceDir}</p>
          </div>
          <div>
            <strong>Active provider</strong>
            <p className="office-subtitle">{resolvedProvider}</p>
          </div>
          <div>
            <strong>Active model</strong>
            <p className="office-subtitle">{resolvedModel}</p>
          </div>
        </div>
      </Panel>
    </section>
  );
}
