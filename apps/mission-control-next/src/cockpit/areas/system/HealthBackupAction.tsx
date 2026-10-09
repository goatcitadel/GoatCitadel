import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getGatewayAccessRevision, subscribeGatewayAccessChange } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Callout } from "../../ui/Callout";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { SystemOwnerLink } from "./SystemOwnerLink";
import { backupLocked, backupReviewCurrent, commitBackup, readBackupReview, useBackupAttempt, type BackupReview } from "./health-backup-action";

export function HealthBackupAction({ onRefresh, readAvailable = true }: { onRefresh?: () => unknown | Promise<unknown>; readAvailable?: boolean }) {
  const [open, setOpen] = useState(false), [reading, setReading] = useState(false), [review, setReview] = useState<BackupReview>(), [error, setError] = useState<string>();
  const lifetime = useRef(0), readPending = useRef(false);
  const readable = useRef(readAvailable); readable.current = readAvailable;
  const attempt = useBackupAttempt(), pending = attempt.phase === "checking" || attempt.phase === "creating";
  const accessRevision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, getGatewayAccessRevision);
  useEffect(() => () => { lifetime.current++; }, []);
  function close() { if (pending) return; lifetime.current++; setOpen(false); setReview(undefined); setReading(false); }
  async function load() {
    if (!readAvailable || readPending.current || backupLocked(attempt)) return;
    const generation = ++lifetime.current;
    readPending.current = true; setOpen(true); setReading(true); setError(undefined); setReview(undefined);
    try { const value = await readBackupReview(); if (generation === lifetime.current) setReview(value); }
    catch (cause) { if (generation === lifetime.current) setError(describeApiError(cause).summary); }
    finally { readPending.current = false; if (generation === lifetime.current) setReading(false); }
  }
  async function confirm() {
    if (!readAvailable || !review || !backupReviewCurrent(review)) return;
    const generation = lifetime.current;
    await commitBackup(review, () => generation === lifetime.current && readable.current);
    if (generation !== lifetime.current) return;
    setOpen(false); setReview(undefined);
    try { await onRefresh?.(); } catch { /* Owner read error is shown by its query; creation receipt remains intact. */ }
  }
  const sameAccess = attempt.accessRevision === accessRevision;
  const receipt = sameAccess ? attempt.receipt : undefined;
  const message = sameAccess ? attempt.message : backupLocked(attempt) ? "A host-wide backup request from earlier access is pending or unconfirmed. Review current backup records with operator access." : undefined;
  return <div className="mt-3 grid gap-3">
    <Button size="sm" disabled={!readAvailable || reading || backupLocked(attempt)} onClick={() => void load()}>{pending ? "Creating backup…" : reading ? "Reading backup scope…" : "Back up now"}</Button>
    {!readAvailable ? <p role="status" className="text-xs text-fg-muted">Current backup owner evidence is unavailable or refreshing. Creation requires a current read.</p> : null}
    {message ? <Callout tone={attempt.phase === "uncertain" || attempt.phase === "failed" ? "error" : "info"}>{message}</Callout> : null}
    {receipt ? <section aria-label="Backup creation receipt" className="grid gap-2 text-sm text-fg-secondary">
      <p>Backup ID: <span className="break-all text-fg">{receipt.backupId}</span></p>
      <p>Created {new Date(receipt.manifest.createdAt).toLocaleString()} · {new Intl.NumberFormat().format(receipt.bytes)} bytes · {receipt.manifest.files.length} files</p>
      <p className="break-all">Gateway destination: {receipt.outputPath}</p>
      <p>Creation does not prove offline restore or installed-host readiness. Hashes in the manifest are recorded values; verification is a separate Gateway operation.</p>
      <TechnicalDetails label="Backup manifest and recorded hashes"><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(receipt.manifest, null, 2)}</pre></TechnicalDetails>
    </section> : null}
    {attempt.phase === "uncertain" ? <SystemOwnerLink href="/ops/runtime" scope="host-backups">Review backup records</SystemOwnerLink> : null}
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }} title="Review backup creation" description="Create a host-wide backup through the Gateway's existing backup owner.">
      {reading ? <p role="status">Reading current operator access and backup records…</p> : error ? <Callout tone="error">{error}</Callout> : review ? <div className="grid gap-3 text-sm text-fg-secondary">
        <p>Includes the configured database, transcripts, audit logs and recursive config JSON on this Gateway host. Config may contain sensitive settings. All workspaces using this installation are affected.</p>
        <p>The Gateway chooses its configured backup directory and enforces path boundaries. This writes a new snapshot and consumes disk space. Existing records: {review.before.length}. No online restore is offered.</p>
        <p>Completion returns a creation receipt. Exact-byte/hash verification, restore-contract verification and offline restore proof are separate checks.</p>
        <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={!readAvailable || pending || !backupReviewCurrent(review)} onClick={() => void confirm()}>{pending ? "Creating backup…" : "Confirm backup"}</Button><Button disabled={pending} onClick={close}>Cancel</Button></div>
      </div> : null}
    </Dialog>
  </div>;
}
