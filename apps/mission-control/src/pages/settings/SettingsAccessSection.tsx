import type { DeviceAccessGrantRecord } from "@goatcitadel/contracts";
import { FieldHelp } from "../../components/FieldHelp";
import { Panel } from "../../components/Panel";
import { GCSelect, GCSwitch } from "../../components/ui";

export type SettingsAuthMode = "none" | "token" | "basic";
export type SettingsAuthStorageMode = "session" | "persistent";

export interface SettingsAccessSectionProps {
  authMode: SettingsAuthMode;
  onAuthModeChange: (mode: SettingsAuthMode) => void;
  allowLoopbackBypass: boolean;
  onAllowLoopbackBypassChange: (value: boolean) => void;
  authStorageMode: SettingsAuthStorageMode;
  onAuthStorageModeChange: (mode: SettingsAuthStorageMode) => void;
  authToken: string;
  onAuthTokenChange: (value: string) => void;
  basicUsername: string;
  onBasicUsernameChange: (value: string) => void;
  basicPassword: string;
  onBasicPasswordChange: (value: string) => void;
  tokenConfigured: boolean;
  basicConfigured: boolean;
  onSaveAuth: () => void;
  blockSaves: boolean;
  deviceGrants: DeviceAccessGrantRecord[];
  deviceGrantBusyId: string | null;
  onRevokeDeviceGrant: (grantId: string) => Promise<void> | void;
}

export function SettingsAccessSection(props: SettingsAccessSectionProps) {
  const {
    authMode,
    onAuthModeChange,
    allowLoopbackBypass,
    onAllowLoopbackBypassChange,
    authStorageMode,
    onAuthStorageModeChange,
    authToken,
    onAuthTokenChange,
    basicUsername,
    onBasicUsernameChange,
    basicPassword,
    onBasicPasswordChange,
    tokenConfigured,
    basicConfigured,
    onSaveAuth,
    blockSaves,
    deviceGrants,
    deviceGrantBusyId,
    onRevokeDeviceGrant,
  } = props;

  return (
    <section id="settings-access" className="settings-v2-section">
      <Panel
        className="settings-v2-panel"
        title="Gateway Access"
        subtitle="Set auth and storage defaults for local or remote use."
      >
        <FieldHelp>
          Keep this section conservative for public or remote installs. Session-only storage is the safer default;
          persistent storage is a convenience tradeoff.
        </FieldHelp>
        <div className="controls-row">
          <label htmlFor="authMode">Auth Mode</label>
          <GCSelect
            id="authMode"
            value={authMode}
            onChange={(value) => onAuthModeChange(value as SettingsAuthMode)}
            options={[
              { value: "none", label: "none (local trusted)" },
              { value: "token", label: "token" },
              { value: "basic", label: "basic" },
            ]}
          />
        </div>
        <div className="controls-row">
          <label htmlFor="allowLoopbackBypassToggle">Allow loopback bypass</label>
          <GCSwitch
            id="allowLoopbackBypassToggle"
            checked={allowLoopbackBypass}
            onCheckedChange={onAllowLoopbackBypassChange}
          />
        </div>
        <FieldHelp>
          Leave loopback bypass off unless this is trusted single-machine development and every local process may reach
          the gateway without normal auth.
        </FieldHelp>
        {authMode !== "none" ? (
          <div className="controls-row">
            <label htmlFor="authRememberMeToggle">Remember credentials on this browser (less secure)</label>
            <GCSwitch
              id="authRememberMeToggle"
              checked={authStorageMode === "persistent"}
              onCheckedChange={(checked) => onAuthStorageModeChange(checked ? "persistent" : "session")}
            />
          </div>
        ) : null}
        {authMode === "token" ? (
          <div className="controls-row">
            <label htmlFor="authToken">Gateway token</label>
            <input
              id="authToken"
              type="password"
              value={authToken}
              onChange={(event) => onAuthTokenChange(event.target.value)}
            />
          </div>
        ) : null}
        {authMode === "basic" ? (
          <>
            <div className="controls-row">
              <label htmlFor="basicUsername">Username</label>
              <input
                id="basicUsername"
                value={basicUsername}
                onChange={(event) => onBasicUsernameChange(event.target.value)}
              />
            </div>
            <div className="controls-row">
              <label htmlFor="basicPassword">Password</label>
              <input
                id="basicPassword"
                type="password"
                value={basicPassword}
                onChange={(event) => onBasicPasswordChange(event.target.value)}
              />
            </div>
          </>
        ) : null}
        <p className="office-subtitle">
          Server status: token configured: {tokenConfigured ? "yes" : "no"} | basic configured:{" "}
          {basicConfigured ? "yes" : "no"}
        </p>
        <button type="button" onClick={onSaveAuth} disabled={blockSaves} className="gc-button">
          Save Access Control
        </button>
        <div className="replay-box">
          <h4>Approved device grants</h4>
          <p className="office-subtitle">
            Active grants stay visible here with last-seen and expiry data so operators can revoke stale devices without
            guessing.
          </p>
          {deviceGrants.length === 0 ? (
            <p className="office-subtitle">No approved device grants yet.</p>
          ) : (
            <ul className="compact-list">
              {deviceGrants.map((grant) => (
                <li key={grant.grantId}>
                  <div>
                    <strong>{grant.deviceLabel}</strong> ({grant.deviceType})
                    {grant.platform ? ` on ${grant.platform}` : ""}
                  </div>
                  <div className="office-subtitle">
                    actor: {grant.actorId} | granted by {grant.grantedBy}
                  </div>
                  <div className="office-subtitle">
                    created: {new Date(grant.createdAt).toLocaleString()}
                    {grant.lastUsedAt
                      ? ` | last seen: ${new Date(grant.lastUsedAt).toLocaleString()}`
                      : " | last seen: never"}
                    {grant.expiresAt
                      ? ` | expires: ${new Date(grant.expiresAt).toLocaleString()}`
                      : " | expires: no TTL"}
                    {grant.revokedAt ? ` | revoked: ${new Date(grant.revokedAt).toLocaleString()}` : ""}
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      className="gc-button danger"
                      disabled={Boolean(grant.revokedAt) || deviceGrantBusyId === grant.grantId}
                      onClick={() => {
                        void onRevokeDeviceGrant(grant.grantId);
                      }}
                    >
                      {grant.revokedAt
                        ? "Revoked"
                        : deviceGrantBusyId === grant.grantId
                          ? "Revoking..."
                          : "Revoke device"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </section>
  );
}
