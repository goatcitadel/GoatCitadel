import fs from "node:fs";
import { describe, expect, it } from "vitest";

const gatewaySource = fs.readFileSync(new URL("./gateway-service.ts", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../app.ts", import.meta.url), "utf8");
const storagePluginSource = fs.readFileSync(new URL("../plugins/storage.ts", import.meta.url), "utf8");
const mainSource = fs.readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const remoteWorkerNativeRuntimeSource = fs.readFileSync(
  new URL("./remote-worker-native-runtime-service.ts", import.meta.url),
  "utf8",
);

describe("shared-host production admission wiring", () => {
  it("creates one app-owned lifecycle before runtime construction and reserves deferred init before scheduling", () => {
    const ownerIndex = appSource.indexOf("createAppSharedHostLifecycle(app)");
    const lifecyclePluginIndex = appSource.indexOf("app.register(sharedHostLifecyclePlugin");
    const storagePluginIndex = appSource.indexOf("app.register(gatewayPlugin)");
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    expect(lifecyclePluginIndex).toBeGreaterThan(ownerIndex);
    expect(storagePluginIndex).toBeGreaterThan(lifecyclePluginIndex);
    expect(appSource).toContain("await app.close()");

    const reservationIndex = storagePluginSource.indexOf(
      'fastify.sharedHostLifecycle.tryReserve("worker", "gateway:deferred-init")',
    );
    const scheduleIndex = storagePluginSource.indexOf("setImmediate(");
    expect(reservationIndex).toBeGreaterThanOrEqual(0);
    expect(scheduleIndex).toBeGreaterThan(reservationIndex);
    expect(storagePluginSource).toContain("admission.reservation.release()");
  });

  it("fences HTTP listener startup before bind and releases its exact reservation", () => {
    const reservationIndex = mainSource.indexOf(
      'app.sharedHostLifecycle.tryReserve("worker", "gateway:http-listener-startup")',
    );
    const listenIndex = mainSource.indexOf("await app.listen({ port, host })");
    const releaseIndex = mainSource.indexOf("listenerAdmission.reservation.release()", listenIndex);
    expect(reservationIndex).toBeGreaterThanOrEqual(0);
    expect(listenIndex).toBeGreaterThan(reservationIndex);
    expect(releaseIndex).toBeGreaterThan(listenIndex);
    expect(mainSource).toContain("sharedHostLifecycle: app.sharedHostLifecycle");
  });

  it("fences the production-dark remote-worker listener and starts it before other network listeners", () => {
    const reservationIndex = remoteWorkerNativeRuntimeSource.indexOf(
      'this.sharedHostLifecycle.tryReserve("worker", LISTENER_START_RESERVATION_ID)',
    );
    const startIndex = remoteWorkerNativeRuntimeSource.indexOf(
      "startRemoteWorkerNativeTlsListener(config)",
      reservationIndex,
    );
    const releaseIndex = remoteWorkerNativeRuntimeSource.indexOf("reservation.release()", startIndex);
    expect(remoteWorkerNativeRuntimeSource).toContain(
      'const LISTENER_START_RESERVATION_ID = "gateway:remote-worker-native-listener-startup"',
    );
    expect(reservationIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(reservationIndex);
    expect(releaseIndex).toBeGreaterThan(startIndex);

    const guardIndex = mainSource.indexOf("shouldWarnUnauthNonLoopbackBind(");
    const workerIndex = mainSource.indexOf("await remoteWorkerNativeRuntime.start()", guardIndex);
    const httpIndex = mainSource.indexOf("await app.listen({ port, host })", workerIndex);
    const a2aIndex = mainSource.indexOf("await startA2AGrpcServer({", httpIndex);
    const readyIndex = mainSource.indexOf("startupPhases.markReady()", a2aIndex);
    expect(workerIndex).toBeGreaterThan(guardIndex);
    expect(httpIndex).toBeGreaterThan(workerIndex);
    expect(a2aIndex).toBeGreaterThan(httpIndex);
    expect(readyIndex).toBeGreaterThan(a2aIndex);
    expect(mainSource).toContain("remoteWorkerNativeRuntime.close()");
  });

  it("routes every gateway-owned producer through the app lifecycle port", () => {
    const admittedProducerLabels = [
      "provider-catalog-prewarm",
      "proactive-scheduler-tick",
      "curator-idle-janitor",
      "cron-due-sweep",
      "commitment-sweep",
      "heartbeat-sweep",
      "memory-evaluation",
      "orchestration-worktree-reaper",
      "memory-post-turn",
      "background-review",
      "memory-context-prewarm",
      "commitment-classifier",
      "assembly-model-council",
      "approval-explanation",
      "orchestration-memory-context",
    ];

    for (const label of admittedProducerLabels) {
      expect(gatewaySource, `missing lifecycle admission for ${label}`).toContain(label);
    }
    expect(gatewaySource).toContain("sharedHostLifecycle: this.sharedHostLifecycle");
    expect(gatewaySource).toContain('runBackgroundWork: (label, work) => this.tryRunWithSharedHostWork("worker"');
    expect(gatewaySource).toContain('runBackgroundWork: (label, work) => this.tryRunWithSharedHostWork("agent"');
  });

  it("keeps CronAutomation as the sole due-cadence owner for system jobs", () => {
    for (const handlerCall of [
      "runWeeklyImprovementSchedulerIfDue({ force: true, recordCronState: false })",
      "runPrivateBetaBackupSchedulerIfDue({ force: true, recordCronState: false })",
      "runMemoryFlushSchedulerIfDue({ force: true, recordCronState: false })",
      "runMemoryConsolidationSchedulerIfDue({ force: true, recordCronState: false })",
      "runCostReportSchedulerIfDue({ force: true, recordCronState: false })",
      "runUpdateReviewSchedulerIfDue({ force: true, recordCronState: false })",
      "runCuratorWeeklyIfDue({ force: true, recordCronState: false })",
    ]) {
      expect(gatewaySource, `missing telemetry-neutral cron handler ${handlerCall}`).toContain(handlerCall);
    }

    const maintenanceStart = gatewaySource.indexOf("private async runMaintenanceSchedulerTick");
    const maintenanceEnd = gatewaySource.indexOf("private handleOrchestrationWorktreeLeaseLoss", maintenanceStart);
    expect(maintenanceStart).toBeGreaterThanOrEqual(0);
    expect(maintenanceEnd).toBeGreaterThan(maintenanceStart);
    const maintenanceSource = gatewaySource.slice(maintenanceStart, maintenanceEnd);
    expect(maintenanceSource).toContain("cronAutomationService.runDueTaskCronJobs()");
    for (const legacyDispatcher of [
      "runWeeklyImprovementSchedulerIfDue",
      "runPrivateBetaBackupSchedulerIfDue",
      "runMemoryFlushSchedulerIfDue",
      "runMemoryConsolidationSchedulerIfDue",
      "runCostReportSchedulerIfDue",
      "runUpdateReviewSchedulerIfDue",
      "runCuratorWeeklyIfDue",
    ]) {
      expect(maintenanceSource, `legacy cadence dispatch remains for ${legacyDispatcher}`).not.toContain(
        legacyDispatcher,
      );
    }
  });
});
