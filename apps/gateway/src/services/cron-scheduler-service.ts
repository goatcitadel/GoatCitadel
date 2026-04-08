/**
 * Cron scheduler façade — pure delegation to CronAutomationService.
 *
 * Step 1 of the gateway-service decomposition plan: extracts the 10
 * cron-related public methods of GatewayService into a thin module so the
 * cron API surface lives in one place. The methods are pure delegations,
 * so the body moves are zero-risk.
 */

import type { CronJobRecord, CronReviewItem, CronRunDiff } from "@goatcitadel/contracts";
import type { CronAutomationService } from "./gateway/cron-automation-service.js";

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
  input: { jobId: string; name: string; schedule: string; enabled?: boolean },
): CronJobRecord {
  return host.cronAutomationService.createCronJob(input);
}

export function updateCronJob(
  host: CronSchedulerHost,
  jobId: string,
  input: { name?: string; schedule?: string; enabled?: boolean },
): CronJobRecord {
  return host.cronAutomationService.updateCronJob(jobId, input);
}

export function setCronJobEnabled(host: CronSchedulerHost, jobId: string, enabled: boolean): CronJobRecord {
  return host.cronAutomationService.setCronJobEnabled(jobId, enabled);
}

export function deleteCronJob(host: CronSchedulerHost, jobId: string): { deleted: boolean; jobId: string } {
  return host.cronAutomationService.deleteCronJob(jobId);
}

export async function runCronJobNow(host: CronSchedulerHost, jobId: string): Promise<{ jobId: string; status: "ok" }> {
  return host.cronAutomationService.runCronJobNow(jobId);
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
