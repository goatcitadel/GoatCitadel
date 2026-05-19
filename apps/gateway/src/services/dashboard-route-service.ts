import os from "node:os";
import type { Storage } from "@goatcitadel/storage";
import type { BackupRetentionService } from "./backup-retention-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import type { OperatorSummaryCache } from "./gateway/operator-summary-cache.js";
import type { RealtimeEventService } from "./realtime-event-service.js";
import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const dashboardRouteMethods = [
  "costSummary",
  "costUsageAvailability",
  "getDashboardState",
  "getMemoryQmdStats",
  "getSystemVitals",
  "isFeatureEnabled",
  "listBackups",
  "listMemoryFiles",
  "listOperators",
  "listRealtimeEvents",
  "listSessions",
] as const;

export type DashboardRouteMethod = (typeof dashboardRouteMethods)[number];
export type DashboardRoutePort = RoutePort<DashboardRouteMethod>;
export type DashboardRouteService = RouteService<DashboardRouteMethod>;

export interface DashboardRoutePortDependencies {
  backupRetentionService: BackupRetentionService;
  memoryLifecycleService: MemoryLifecycleService;
  operatorSummaryCache: OperatorSummaryCache;
  realtimeEventService: RealtimeEventService;
  storage: Storage;
  isFeatureEnabled: (flag: string) => boolean;
}

export function createDashboardRoutePort(deps: DashboardRoutePortDependencies): DashboardRoutePort {
  return {
    costSummary: (scope, from, to) => deps.storage.costLedger.summary(scope, from, to),
    costUsageAvailability: (from, to) => deps.storage.costLedger.usageAvailability(from, to),
    getDashboardState: () => {
      const sessions = deps.storage.sessions.list(200);
      const now = new Date();
      const pendingApprovals = deps.storage.approvals
        .list("pending", 10000)
        .filter((approval) => !approval.expiresAt || Date.parse(approval.expiresAt) > now.getTime()).length;
      const activeSubagents = deps.storage.taskSubagents.activeCount();
      const taskStatusCounts = deps.storage.tasks.statusCounts();
      const recentEvents = deps.storage.realtimeEvents.list(100);
      const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const to = now.toISOString();
      const byDay = deps.storage.costLedger.summary("day", from, to);
      const dailyCostUsd = byDay.reduce((sum, row) => sum + row.costUsd, 0);

      return {
        timestamp: now.toISOString(),
        sessions,
        pendingApprovals,
        activeSubagents,
        taskStatusCounts,
        recentEvents,
        dailyCostUsd,
      };
    },
    getMemoryQmdStats: (from, to) => deps.memoryLifecycleService.getContextStats(from, to),
    getSystemVitals: () => {
      const total = os.totalmem();
      const free = os.freemem();
      const processMem = process.memoryUsage();
      return {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        uptimeSeconds: os.uptime(),
        loadAverage: os.loadavg(),
        cpuCount: os.cpus().length,
        memoryTotalBytes: total,
        memoryFreeBytes: free,
        memoryUsedBytes: total - free,
        processRssBytes: processMem.rss,
        processHeapUsedBytes: processMem.heapUsed,
      };
    },
    isFeatureEnabled: (flag) => deps.isFeatureEnabled(flag),
    listBackups: (limit) => deps.backupRetentionService.listBackups(limit),
    listMemoryFiles: (relativeDir) => deps.memoryLifecycleService.listMemoryFiles(relativeDir),
    listOperators: () => {
      const activeSinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      return deps.operatorSummaryCache.get(() => deps.storage.sessions.listOperatorSummaries(activeSinceIso));
    },
    listRealtimeEvents: (limit, cursor) => deps.realtimeEventService.listRealtimeEvents(limit, cursor),
    listSessions: (limit, cursor) => deps.storage.sessions.list(limit, cursor),
  };
}

export function createDashboardRouteService(port: DashboardRoutePort): DashboardRouteService {
  return createRouteService(port, dashboardRouteMethods);
}
