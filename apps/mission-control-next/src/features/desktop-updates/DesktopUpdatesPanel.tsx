import type { DesktopUpdateChannel } from "@goatcitadel/contracts";
import { NativeCard } from "../native-routes/NativeRoutePageLayout";
import { NativeButton } from "../native-routes/primitives";
import { SettingsButtonRow, SettingsField } from "../native-routes/settings/SettingsShared";
import { useDesktopUpdates } from "./desktop-update-bridge";
import { useDesktopUpdateActions } from "./use-desktop-update-actions";

export function DesktopUpdatesPanel() {
  const status = useDesktopUpdates();
  const { act, busy, error, uncertain } = useDesktopUpdateActions(status);
  const actionBusy = busy || uncertain;
  const offered = status?.availableRelease;
  return (
    <section id="updates" aria-label="Application updates">
      <NativeCard title="Updates" subtitle="Choose when to download and install a new version.">
        {!status ? (
          <p>
            Open the installed Windows app to check for updates. Its tray menu also works while the local runtime is
            unavailable.
          </p>
        ) : (
          <>
            <p>
              Installed: <strong>{status.installedVersion}</strong>
              {status.installedCommit ? <span> · {status.installedCommit.slice(0, 8)}</span> : null}
            </p>
            <SettingsField label="Update channel">
              <select
                className="mc-next-settings-input"
                aria-label="Update channel"
                value={status.channel}
                disabled={actionBusy}
                onChange={(event) => void act("channel", event.target.value as DesktopUpdateChannel)}
              >
                <option value="stable">Stable releases</option>
                <option value="preview">Preview — unsigned builds from main</option>
              </select>
            </SettingsField>
            <p role="status">{status.message}</p>
            <p className="mc-next-settings-field-note">
              Last successful check:{" "}
              {status.lastSuccessfulCheck ? new Date(status.lastSuccessfulCheck).toLocaleString() : "Not checked yet"}
            </p>
            {offered ? (
              <>
                <p>
                  Available: <strong>{offered.version}</strong> · {offered.sourceCommit.slice(0, 8)}
                </p>
                <p>
                  {offered.publisherSigned
                    ? "Verified signed release evidence."
                    : "Unsigned preview. Checksum verification does not establish publisher signing."}
                </p>
                {status.phase === "downloading" ? (
                  <label>
                    Downloading {Math.round(status.downloadedBytes / 1048576)} of{" "}
                    {Math.round(offered.installer.sizeBytes / 1048576)} MB
                    <progress
                      aria-label="Update download"
                      value={status.downloadedBytes}
                      max={offered.installer.sizeBytes}
                    />
                  </label>
                ) : null}
                <details>
                  <summary>Release notes</summary>
                  <p style={{ whiteSpace: "pre-wrap" }}>{offered.releaseNotes || "No release notes provided."}</p>
                </details>
              </>
            ) : null}
            <SettingsButtonRow>
              <NativeButton type="button" disabled={busy} onClick={() => void act("check")}>
                Check for updates
              </NativeButton>
              {offered ? (
                <>
                  <NativeButton type="button" disabled={actionBusy} onClick={() => void act("download")}>
                    Download
                  </NativeButton>
                  <NativeButton type="button" disabled={actionBusy} onClick={() => void act("notes")}>
                    View release notes
                  </NativeButton>
                  <NativeButton type="button" disabled={actionBusy} onClick={() => void act("snooze")}>
                    Remind me tomorrow
                  </NativeButton>
                </>
              ) : null}
              {status.downloadedPath ? (
                <NativeButton type="button" disabled={actionBusy} onClick={() => void act("reveal")}>
                  Show installer
                </NativeButton>
              ) : null}
            </SettingsButtonRow>
            {status.downloadedPath ? (
              <p>
                Run the downloaded installer when your work is finished. The app will not install or restart
                automatically.
              </p>
            ) : null}
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </NativeCard>
    </section>
  );
}
