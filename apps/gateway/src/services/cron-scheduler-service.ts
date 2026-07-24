/**
 * Cron scheduler delegates to CronAutomationService so the cron-facing API
 * surface stays in one place.
 */

import type { CronJobRecord, CronReviewItem, CronRunDiff } from "@goatcitadel/contracts";
import type { CronAutomationService, CronRunSnapshot } from "./gateway/cron-automation-service.js";

export interface CronSchedulerHost {
  readonly cronAutomationService: CronAutomationService;
}

export function listCronJobs(host: CronSchedulerHost): CronJobRecord[] {
  return host.cronAutomationService.listCronJobs();
}

export function getCronJob(host: CronSchedulerHost, jobId: string): CronJobRecord {
  return host.cronAutomationService.getCronJob(jobId);
}

export function createCronJob(
  host: CronSchedulerHost,
  input: {
    jobId: string;
    name: string;
    action?: CronJobRecord["action"];
    description?: string;
    schedule: string;
    enabled?: boolean;
    endAt?: string;
    actionConfig?: unknown;
    workdir?: string;
    contextFrom?: string;
  },
): Promise<CronJobRecord> {
  return host.cronAutomationService.createCronJob(input);
}

export function updateCronJob(
  host: CronSchedulerHost,
  jobId: string,
  input: {
    name?: string;
    action?: CronJobRecord["action"];
    description?: string;
    schedule?: string;
    enabled?: boolean;
    endAt?: string | null;
    actionConfig?: unknown;
    workdir?: string | null;
    contextFrom?: string | null;
  },
  expectedRevision: number,
): Promise<CronJobRecord> {
  return host.cronAutomationService.updateCronJob(jobId, input, expectedRevision);
}

export function setCronJobEnabled(
  host: CronSchedulerHost,
  jobId: string,
  enabled: boolean,
  expectedRevision: number,
): Promise<CronJobRecord> {
  return host.cronAutomationService.setCronJobEnabled(jobId, enabled, expectedRevision);
}

export function deleteCronJob(
  host: CronSchedulerHost,
  jobId: string,
  expectedRevision: number,
): Promise<{ deleted: boolean; jobId: string }> {
  return host.cronAutomationService.deleteCronJob(jobId, expectedRevision);
}

export async function runCronJobNow(
  host: CronSchedulerHost,
  jobId: string,
): Promise<{ jobId: string; runId: string; status: "ok" | "pending" }> {
  return host.cronAutomationService.runCronJobNow(jobId);
}

export function findCronRunById(host: CronSchedulerHost, runId: string): CronRunSnapshot | undefined {
  return host.cronAutomationService.findCronRunById(runId);
}

export function listCronReviewQueue(host: CronSchedulerHost, limit = 200): CronReviewItem[] {
  return host.cronAutomationService.listCronReviewQueue(limit);
}

export function retryCronReviewQueueItem(host: CronSchedulerHost, itemId: string): CronReviewItem {
  return host.cronAutomationService.retryCronReviewQueueItem(itemId);
}

export function getCronRunDiff(host: CronSchedulerHost, runId: string): CronRunDiff {
  return host.cronAutomationService.getCronRunDiff(runId);
}
