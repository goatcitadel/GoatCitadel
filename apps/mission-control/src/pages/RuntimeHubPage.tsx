import { useCallback, useEffect, useMemo, useState } from "react";
import type { BackupManifestRecord } from "@goatcitadel/contracts";
import { createBackup, listBackups, verifyBackup } from "../api/client";
import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { FieldHelp } from "../components/FieldHelp";
import { OperatorSplitLayout } from "../components/OperatorSplitLayout";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { ConfigureHubLayout } from "../components/ConfigureHubLayout";
import { LlamaCppPage } from "./LlamaCppPage";
import { MeshPage } from "./MeshPage";
import { NpuPage } from "./NpuPage";
import { SettingsPage } from "./SettingsPage";

export function RuntimeHubPage() {
  const [backups, setBackups] = useState<BackupManifestRecord[]>([]);
  const [backupPath, setBackupPath] = useState("");
  const [busy, setBusy] = useState<null | "create" | "verify">(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadBackups = useCallback(async () => {
    try {
      const response = await listBackups(12);
      setBackups(response.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  const latestBackup = backups[0] ?? null;
  const selectedBackupPath = backupPath.trim();

  const canVerifyOrRestore = selectedBackupPath.length > 0;
  const restoreCommand = selectedBackupPath
    ? `pnpm admin backup restore --file "${selectedBackupPath}" --confirm`
    : 'pnpm admin backup restore --file "<backup-path>" --confirm';
  const backupSummary = useMemo(() => {
    if (!latestBackup) {
      return "No backups recorded yet.";
    }
    return `Latest backup ${latestBackup.backupId} from ${new Date(latestBackup.createdAt).toLocaleString()} with ${latestBackup.files.length} files.`;
  }, [latestBackup]);

  const handleCreateBackup = async () => {
    setBusy("create");
    setStatus(null);
    setError(null);
    try {
      const created = await createBackup();
      setBackupPath(created.outputPath);
      setStatus(`Created backup ${created.backupId} at ${created.outputPath}.`);
      await loadBackups();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleVerifyBackup = async () => {
    setBusy("verify");
    setStatus(null);
    setError(null);
    try {
      const verified = await verifyBackup(selectedBackupPath);
      setStatus(
        verified.verified && verified.contractVerified
          ? `Verified backup ${verified.backupId ?? "manifest"} with ${verified.filesVerified} files and confirmed the 1.0 minimum backup contract.`
          : verified.verified
            ? `Backup integrity is valid, but 1.0 contract coverage is incomplete: ${verified.contractCoverage.reasons.join(", ")}.`
            : `Backup verification reported ${verified.issues.length} issue${verified.issues.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ConfigureHubLayout
      title="Runtime"
      subtitle="Gateway controls, local runtimes, acceleration targets, and backup safety need to read like one operator cockpit."
      summaries={[
        {
          label: "Current posture",
          value: latestBackup ? "Recoverable" : "Needs first backup",
          note: latestBackup
            ? "Backups and local runtime posture are loaded."
            : "Create and verify a backup before runtime changes get riskier.",
          tone: latestBackup ? "success" : "warning",
        },
        {
          label: "Latest backup",
          value: latestBackup ? latestBackup.backupId : "None yet",
          note: latestBackup
            ? new Date(latestBackup.createdAt).toLocaleString()
            : "No backup manifest has been created.",
        },
        {
          label: "Operator focus",
          value: "Serving, backups, local runtimes",
          note: "Keep serving posture visible while mesh and local hosts stay secondary.",
          tone: "accent",
        },
      ]}
      summaryMode="posture"
      guideTitle="What this controls"
      guideBody="Use Runtime for changes that can interrupt serving, alter local acceleration posture, or affect recovery guarantees."
    >
      {error ? <p className="error">{error}</p> : null}
      {status ? <p className="status-banner">{status}</p> : null}
      <EmbeddedPageChromeProvider>
        <div className="stack-lg">
          <OperatorSplitLayout
            primary={
              <Panel
                title="Runtime controls"
                subtitle="Serving defaults, shell runtime posture, and recovery-critical controls stay visible first."
                tone="accent"
                rank="primary"
                padding="compact"
              >
                <SettingsPage activeTab="runtime" />
              </Panel>
            }
            inspector={
              <Panel
                title="Backup posture"
                subtitle="Create, inspect, and verify backups beside runtime changes instead of ahead of them."
                rank="muted"
                padding="compact"
              >
                <div className="workflow-summary-strip">
                  <StatusChip tone={latestBackup ? "success" : "warning"}>
                    {latestBackup ? "Backup history loaded" : "No backup history"}
                  </StatusChip>
                  <StatusChip tone="muted">
                    {backups.length} recent manifest{backups.length === 1 ? "" : "s"}
                  </StatusChip>
                </div>
                <p className="office-subtitle">{backupSummary}</p>
                <div className="stack-sm">
                  <label className="chat-v11-field">
                    <span>Backup path</span>
                    <input
                      value={backupPath}
                      onChange={(event) => setBackupPath(event.target.value)}
                      placeholder="%USERPROFILE%\\GoatCitadel\\backups\\..."
                    />
                  </label>
                  <FieldHelp>
                    Creating a backup fills this path automatically. Verification runs here. Restore remains an offline
                    CLI operation so the gateway cannot overwrite active runtime files while it is serving.
                  </FieldHelp>
                  <div className="actions">
                    <button
                      type="button"
                      className="gc-button"
                      onClick={() => void handleCreateBackup()}
                      disabled={busy !== null}
                    >
                      {busy === "create" ? "Creating..." : "Create backup"}
                    </button>
                    <button
                      type="button"
                      className="gc-button"
                      onClick={() => void handleVerifyBackup()}
                      disabled={!canVerifyOrRestore || busy !== null}
                    >
                      {busy === "verify" ? "Verifying..." : "Verify backup"}
                    </button>
                  </div>
                  <label className="chat-v11-field">
                    <span>Offline restore command</span>
                    <input value={restoreCommand} readOnly />
                  </label>
                  <FieldHelp>
                    Stop the gateway first, then run this command from the repo root to restore the selected backup
                    safely.
                  </FieldHelp>
                  {backups.length > 0 ? (
                    <ul className="compact-list">
                      {backups.slice(0, 6).map((backup) => (
                        <li key={backup.backupId}>
                          <strong>{backup.backupId}</strong>
                          {" | "}
                          {new Date(backup.createdAt).toLocaleString()}
                          {" | "}
                          {backup.files.length} files
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </Panel>
            }
          />
          <Panel
            title="Mesh"
            subtitle="Distributed runtime posture and remote execution routing."
            collapsible
            defaultExpanded={false}
            rank="muted"
            padding="compact"
          >
            <MeshPage />
          </Panel>
          <Panel
            title="Local runtimes"
            subtitle="Local model hosts and acceleration targets stay collapsed until you need them."
            collapsible
            defaultExpanded={false}
            rank="muted"
            padding="compact"
          >
            <LlamaCppPage />
            <NpuPage />
          </Panel>
        </div>
      </EmbeddedPageChromeProvider>
    </ConfigureHubLayout>
  );
}
