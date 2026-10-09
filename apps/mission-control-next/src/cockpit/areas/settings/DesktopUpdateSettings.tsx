import { useState } from "react";
import { Dialog } from "../../ui/Dialog";
import type { DesktopUpdateChannel } from "@goatcitadel/contracts";
import { useDesktopUpdates } from "../../../features/desktop-updates/desktop-update-bridge";
import { useDesktopUpdateActions } from "../../../features/desktop-updates/use-desktop-update-actions";
import { Button } from "../../ui/Button";

export function DesktopUpdateSettings() {
  const status = useDesktopUpdates();
  const [review, setReview] = useState<string>();
  const binding = status
    ? JSON.stringify([status.channel, status.installedVersion, status.installedCommit])
    : undefined;
  const { act, busy, error, uncertain } = useDesktopUpdateActions(status);
  const actionBusy = busy || uncertain;
  const offered = status?.availableRelease;
  return (
    <section
      id="application-updates"
      aria-label="Application updates"
      className="space-y-3 rounded-lg border border-line bg-sunken p-4 sm:col-span-2"
    >
      <header>
        <h3 className="font-display text-base font-semibold text-fg">Application updates</h3>
        <p className="mt-1 text-sm text-fg-secondary">Choose when to download a version and run its installer.</p>
      </header>
      {!status ? (
        <p className="text-sm text-fg-secondary">
          Open the installed Windows app to check for updates. Its tray menu also works while the local runtime is
          unavailable.
        </p>
      ) : (
        <>
          <p className="text-sm text-fg-secondary">
            Installed: <strong className="text-fg">{status.installedVersion}</strong>
            {status.installedCommit ? <span> · {status.installedCommit.slice(0, 8)}</span> : null}
          </p>
          <label className="block text-sm text-fg-secondary">
            Update channel
            <select
              aria-label="Update channel"
              value={status.channel}
              disabled={actionBusy}
              onChange={(event) =>
                event.target.value === "preview"
                  ? setReview(binding)
                  : void act("channel", event.target.value as DesktopUpdateChannel)
              }
              className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-fg"
            >
              <option value="stable">Stable releases</option>
              <option value="preview">Preview — unsigned builds from main</option>
            </select>
          </label>
          <p role="status" className="text-sm text-fg-secondary">
            {status.message}
          </p>
          <p className="text-xs text-fg-muted">
            Last successful check:{" "}
            {status.lastSuccessfulCheck ? new Date(status.lastSuccessfulCheck).toLocaleString() : "Not checked yet"}
          </p>
          {offered ? (
            <>
              <p className="text-sm text-fg-secondary">
                Available: <strong className="text-fg">{offered.version}</strong> · {offered.sourceCommit.slice(0, 8)}
              </p>
              <p className="text-xs text-fg-muted">
                {offered.publisherSigned
                  ? "Verified signed release evidence."
                  : "Unsigned preview. Checksum verification does not establish publisher signing."}
              </p>
              {status.phase === "downloading" ? (
                <label className="block text-sm text-fg-secondary">
                  Downloading {Math.round(status.downloadedBytes / 1048576)} of{" "}
                  {Math.round(offered.installer.sizeBytes / 1048576)} MB
                  <progress
                    aria-label="Update download"
                    value={status.downloadedBytes}
                    max={offered.installer.sizeBytes}
                    className="mt-1 block w-full"
                  />
                </label>
              ) : null}
              <details className="text-sm text-fg-secondary">
                <summary>Release notes</summary>
                <p className="mt-2 whitespace-pre-wrap break-words">
                  {offered.releaseNotes || "No release notes provided."}
                </p>
              </details>
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void act("check")}>
              Check for updates
            </Button>
            {offered ? (
              <>
                <Button size="sm" disabled={actionBusy} onClick={() => void act("download")}>
                  Download
                </Button>
                <Button size="sm" disabled={actionBusy} onClick={() => void act("notes")}>
                  View release notes
                </Button>
                <Button size="sm" disabled={actionBusy} onClick={() => void act("snooze")}>
                  Remind me tomorrow
                </Button>
              </>
            ) : null}
            {status.downloadedPath ? (
              <Button size="sm" disabled={actionBusy} onClick={() => void act("reveal")}>
                Show installer
              </Button>
            ) : null}
          </div>
          {status.downloadedPath ? (
            <p className="text-sm text-fg-secondary">
              Run the downloaded installer when your work is finished. The app will not install or restart
              automatically.
            </p>
          ) : null}
        </>
      )}
      <Dialog
        open={Boolean(review)}
        title="Use Preview updates?"
        description={`Change updates for this installed app (${status?.installedVersion ?? "unavailable"}) from Stable to Preview. Preview builds from main are unsigned. Checksums do not establish publisher identity. Downloads and installer execution still require your action.`}
        onOpenChange={(open) => {
          if (!open) setReview(undefined);
        }}
      >
        {review !== binding ? <p role="alert">The installed app or channel changed. Close and review again.</p> : null}
        <div className="flex gap-2">
          <Button
            variant="danger"
            disabled={actionBusy || review !== binding}
            onClick={() => {
              setReview(undefined);
              void act("channel", "preview");
            }}
          >
            Use reviewed Preview channel
          </Button>
          <Button onClick={() => setReview(undefined)}>Keep current channel</Button>
        </div>
      </Dialog>
      {error ? (
        <p role="alert" className="text-sm text-status-failed">
          {error}
        </p>
      ) : null}
    </section>
  );
}
