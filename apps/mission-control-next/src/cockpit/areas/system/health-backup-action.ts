import { useSyncExternalStore } from "react";
import { canonicalJsonString, type BackupCreateResponse, type BackupManifestRecord } from "@goatcitadel/contracts";
import { getGatewayAccessRevision, getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchGatewayCurrentAccess } from "@goatcitadel/mission-control-shared/api/shell-client";
import { createBackup, listBackups } from "@goatcitadel/mission-control-shared/api/system";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

export interface BackupReview { base: string; accessRevision: number; before: BackupManifestRecord[] }
export interface BackupAttempt {
  phase: "idle" | "checking" | "creating" | "created" | "failed" | "uncertain";
  message?: string;
  receipt?: BackupCreateResponse;
  accessRevision?: number;
}
const idle: BackupAttempt = { phase: "idle" };
const attempts = new Map<string, BackupAttempt>(), listeners = new Set<() => void>();
const read = (base: string) => attempts.get(base) ?? idle;
function publish(base: string, value: BackupAttempt) {
  attempts.set(base, value);
  for (const listener of listeners) listener();
}
export function useBackupAttempt() {
  const base = getGatewayApiBaseUrl();
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => read(base), () => idle);
}
export const backupLocked = (value: BackupAttempt) => ["checking", "creating", "uncertain"].includes(value.phase);
export const backupReviewCurrent = (review: BackupReview) => review.base === getGatewayApiBaseUrl() && review.accessRevision === getGatewayAccessRevision();

export async function readBackupReview(): Promise<BackupReview> {
  const base = getGatewayApiBaseUrl(), accessRevision = getGatewayAccessRevision();
  const [access, before] = await Promise.all([fetchGatewayCurrentAccess(), listBackups()]);
  const review = { base, accessRevision, before: before.items };
  if (!access.operatorAccess || !backupReviewCurrent(review)) throw new Error("Current operator access is required to review this installation's backup.");
  return review;
}

function validReceipt(value: BackupCreateResponse) {
  return Boolean(value?.backupId && value.outputPath && Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
    value.manifest?.backupId === value.backupId && Number.isFinite(Date.parse(value.manifest.createdAt)) &&
    Array.isArray(value.manifest.files) && value.manifest.files.length && value.manifest.files.every(file =>
      file.path && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0 && /^[a-f0-9]{64}$/i.test(file.sha256)));
}

/** Session-level host admission survives navigation. The Gateway still owns authorization, paths and idempotency. */
export async function commitBackup(review: BackupReview, current: () => boolean): Promise<void> {
  if (backupLocked(read(review.base)) || !current() || !backupReviewCurrent(review)) return;
  publish(review.base, { phase: "checking", accessRevision: review.accessRevision, message: "Checking current operator access…" });
  let dispatched = false, receipt: BackupCreateResponse | undefined;
  try {
    const access = await fetchGatewayCurrentAccess();
    if (!access.operatorAccess || !current() || !backupReviewCurrent(review)) {
      publish(review.base, { phase: "failed", accessRevision: review.accessRevision, message: "Backup review changed or operator access is unavailable. No backup was requested." });
      return;
    }
    publish(review.base, { phase: "creating", accessRevision: review.accessRevision, message: "Creating backup on the Gateway host… Progress details are not supplied by this API." });
    dispatched = true;
    receipt = await createBackup();
    if (!validReceipt(receipt) || !backupReviewCurrent(review)) throw new Error("Backup creation receipt could not be confirmed.");
    const records = await listBackups();
    if (!backupReviewCurrent(review) || !records.items.some(item => item.backupId === receipt?.backupId &&
      canonicalJsonString(item) === canonicalJsonString(receipt?.manifest))) throw new Error("Backup record could not be read back.");
    publish(review.base, { phase: "created", accessRevision: review.accessRevision, receipt, message: "Backup created and its manifest confirmed by the Gateway. Stored bytes, hashes and restore contract have not been verified by this action." });
  } catch (cause) {
    const description = describeApiError(cause);
    const uncertain = dispatched;
    publish(review.base, { phase: uncertain ? "uncertain" : "failed", accessRevision: review.accessRevision, ...(receipt && validReceipt(receipt) ? { receipt } : {}),
      message: uncertain
        ? `Backup creation outcome is unconfirmed. ${description.summary} Further creation is withheld for this app session; review backup records before continuing.`
        : `${description.summary} No backup was requested.` });
  }
}
export function __resetBackupAttemptsForTests() { attempts.clear(); for (const listener of listeners) listener(); }
