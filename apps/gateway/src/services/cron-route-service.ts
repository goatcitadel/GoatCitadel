import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";
import type { CronAutomationService } from "./gateway/cron-automation-service.js";

export const cronRouteMethods = [
  "createCronJob",
  "deleteCronJob",
  "findCronRunById",
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
    deleteCronJob: (jobId, expectedRevision) => cronAutomationService.deleteCronJob(jobId, expectedRevision),
    findCronRunById: (runId) => cronAutomationService.findCronRunById(runId),
    getCronJob: (jobId) => cronAutomationService.getCronJob(jobId),
    getCronRunDiff: (runId) => cronAutomationService.getCronRunDiff(runId),
    listCronJobs: () => cronAutomationService.listCronJobs(),
    listCronReviewQueue: (limit) => cronAutomationService.listCronReviewQueue(limit),
    retryCronReviewQueueItem: (itemId) => cronAutomationService.retryCronReviewQueueItem(itemId),
    runCronJobNow: (jobId) => cronAutomationService.runCronJobNow(jobId),
    setCronJobEnabled: (jobId, enabled, expectedRevision) =>
      cronAutomationService.setCronJobEnabled(jobId, enabled, expectedRevision),
    updateCronJob: (jobId, input, expectedRevision) =>
      cronAutomationService.updateCronJob(jobId, input, expectedRevision),
  };
}

export function createCronRouteService(port: CronRoutePort): CronRouteService {
  return createRouteService(port, cronRouteMethods);
}
