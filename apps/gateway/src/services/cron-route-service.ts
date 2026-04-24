import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";
import type { CronAutomationService } from "./gateway/cron-automation-service.js";

export const cronRouteMethods = [
  "createCronJob",
  "deleteCronJob",
  "getCronJob",
  "getCronRunDiff",
  "listCronJobs",
  "listCronReviewQueue",
  "retryCronReviewQueueItem",
  "runCronJobNow",
  "setCronJobEnabled",
  "updateCronJob",
] as const;

export type CronRouteMethod = (typeof cronRouteMethods)[number];
export type CronRoutePort = RoutePort<CronRouteMethod>;
export type CronRouteService = RouteService<CronRouteMethod>;

export function createCronRoutePort(cronAutomationService: CronAutomationService): CronRoutePort {
  return {
    createCronJob: (input) => cronAutomationService.createCronJob(input),
    deleteCronJob: (jobId) => cronAutomationService.deleteCronJob(jobId),
    getCronJob: (jobId) => cronAutomationService.getCronJob(jobId),
    getCronRunDiff: (runId) => cronAutomationService.getCronRunDiff(runId),
    listCronJobs: () => cronAutomationService.listCronJobs(),
    listCronReviewQueue: (limit) => cronAutomationService.listCronReviewQueue(limit),
    retryCronReviewQueueItem: (itemId) => cronAutomationService.retryCronReviewQueueItem(itemId),
    runCronJobNow: (jobId) => cronAutomationService.runCronJobNow(jobId),
    setCronJobEnabled: (jobId, enabled) => cronAutomationService.setCronJobEnabled(jobId, enabled),
    updateCronJob: (jobId, input) => cronAutomationService.updateCronJob(jobId, input),
  };
}

export function createCronRouteService(port: CronRoutePort): CronRouteService {
  return createRouteService(port, cronRouteMethods);
}
