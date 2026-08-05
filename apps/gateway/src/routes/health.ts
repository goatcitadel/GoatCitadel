import type { FastifyPluginAsync } from "fastify";
import type { DatabaseHealthSnapshot } from "@goatcitadel/contracts";
import type { ConfigGenerationHealthSnapshot } from "../services/config-generation-service.js";
import type { SharedHostLifecycleSnapshot } from "../services/shared-host-lifecycle-service.js";
import { withRouteAccess } from "./route-access.js";

const MANAGED_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async (_request, reply) => {
    const [database, configGeneration] = await Promise.all([
      fastify.services.health.getDatabaseHealthSnapshot(),
      fastify.services.health.getConfigGenerationHealthSnapshot(),
    ]);
    const lifecycle = readSharedHostLifecycleSnapshot(fastify);
    const ready =
      isDatabaseReady(database) && isConfigGenerationReady(configGeneration) && isSharedHostLifecycleReady(lifecycle);
    return reply
      .header("Cache-Control", "no-store, max-age=0, must-revalidate")
      .code(ready ? 200 : 503)
      .send({
        status: ready ? "ok" : "degraded",
        readiness: ready ? "ready" : "degraded",
        service: "gateway",
        ...buildManagedHealthIdentity("gateway"),
      });
  });

  fastify.get("/api/v1/ops/readiness", withRouteAccess(fastify, "operator"), async (_request, reply) => {
    const [database, configGeneration] = await Promise.all([
      fastify.services.health.getDatabaseHealthSnapshot(),
      fastify.services.health.getConfigGenerationHealthSnapshot(),
    ]);
    const snapshot = buildAuthenticatedReadinessSnapshot(
      database,
      configGeneration,
      readSharedHostLifecycleSnapshot(fastify),
    );
    return reply.code(snapshot.readiness === "ready" ? 200 : 503).send(snapshot);
  });
};

function buildAuthenticatedReadinessSnapshot(
  database: DatabaseHealthSnapshot,
  configGeneration: ConfigGenerationHealthSnapshot,
  lifecycle?: SharedHostLifecycleSnapshot,
) {
  const databaseReady = isDatabaseReady(database);
  const configGenerationReady = isConfigGenerationReady(configGeneration);
  const lifecycleReady = isSharedHostLifecycleReady(lifecycle);
  const ready = databaseReady && configGenerationReady && lifecycleReady;
  return {
    status: ready ? "ok" : "degraded",
    readiness: ready ? "ready" : "degraded",
    service: "gateway",
    generatedAt: new Date().toISOString(),
    checks: [
      {
        key: "database",
        configuration: database.configured ? "configured" : "not_configured",
        probe: database.reachable ? "passed" : "failed",
        state: databaseReady ? "ready" : "degraded",
        driver: database.driver,
        migrationVersion: database.migrationVersion,
        latencyMs: database.latencyMs,
        storageWait: database.storageWait,
        issueCount: database.issues.length,
      },
      {
        key: "config_generation",
        configuration: "configured",
        probe: configGenerationReady ? "passed" : "failed",
        state: configGenerationReady ? "ready" : "degraded",
        revision: configGeneration.revision,
        generationId: configGeneration.generationId,
        transactionState: configGeneration.transactionState,
        mirrorRepairPending: configGeneration.mirrorRepairPending,
        recoveryOutcome: configGeneration.lastRecovery.outcome,
        recoveryApplied: configGeneration.lastRecovery.recovered,
        recoveredRevision: configGeneration.lastRecovery.revision,
      },
      ...(lifecycle
        ? [
            {
              key: "shared_host_lifecycle",
              configuration: lifecycle.enabled ? "configured" : "not_configured",
              probe: lifecycleReady ? "passed" : "failed",
              state: lifecycleReady ? "ready" : "degraded",
              lifecycleState: lifecycle.state,
              admission: lifecycle.admission,
              activeCount: lifecycle.activeCount,
              activeByKind: lifecycle.activeByKind,
              mode: lifecycle.mode,
              drainTimedOut: lifecycle.drain?.timedOut ?? false,
              forcedOutstandingCount: lifecycle.drain?.forcedOutstandingCount ?? 0,
              evidence: lifecycle.evidence,
            },
          ]
        : []),
    ],
  } as const;
}

function isDatabaseReady(database: DatabaseHealthSnapshot): boolean {
  return database.configured && database.reachable && database.issues.length === 0;
}

function isConfigGenerationReady(configGeneration: ConfigGenerationHealthSnapshot): boolean {
  return configGeneration.transactionState === "idle" && !configGeneration.mirrorRepairPending;
}

function readSharedHostLifecycleSnapshot(
  fastify: Parameters<FastifyPluginAsync>[0],
): SharedHostLifecycleSnapshot | undefined {
  const lifecycle = (fastify as unknown as { sharedHostLifecycle?: { snapshot(): SharedHostLifecycleSnapshot } })
    .sharedHostLifecycle;
  return lifecycle?.snapshot();
}

function isSharedHostLifecycleReady(lifecycle?: SharedHostLifecycleSnapshot): boolean {
  return !lifecycle || lifecycle.readiness === "ready";
}

function buildManagedHealthIdentity(
  service: string,
  env: Record<string, string | undefined> = process.env,
): { managedInstanceId?: string; managedProcessId?: number } {
  const instanceId = env.GOATCITADEL_MANAGED_INSTANCE_ID?.trim();
  if (env.GOATCITADEL_MANAGED_SERVICE !== service || !instanceId || !MANAGED_INSTANCE_ID_PATTERN.test(instanceId)) {
    return {};
  }
  return { managedInstanceId: instanceId, managedProcessId: process.pid };
}

export const __internal = {
  buildAuthenticatedReadinessSnapshot,
  buildManagedHealthIdentity,
};
