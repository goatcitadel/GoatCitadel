import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  SharedHostLifecycleService,
  resolveSharedHostDrainTimeoutMs,
  resolveSharedHostLifecycleEnabled,
  type SharedHostLifecycleEvent,
  type SharedHostWorkKind,
  type SharedHostWorkReservation,
} from "../services/shared-host-lifecycle-service.js";

export interface SharedHostLifecyclePluginOptions {
  lifecycle?: SharedHostLifecycleService;
  activateImmediately?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    sharedHostLifecycle: SharedHostLifecycleService;
  }

  interface FastifyRequest {
    sharedHostWorkReservation?: SharedHostWorkReservation;
  }
}

const LIFECYCLE_ROUTE_PREFIX = "/api/v1/ops/shared-host";
const ALWAYS_AVAILABLE_PATHS = new Set(["/health", "/livez", "/api/v1/ops/readiness"]);
const AGENT_ROUTE_PREFIXES = [
  "/api/v1/a2a",
  "/api/v1/agentic",
  "/api/v1/agents",
  "/api/v1/assembly",
  "/api/v1/chat",
  "/api/v1/durable",
  "/api/v1/llm",
  "/api/v1/orchestration",
  "/api/v1/subagents",
  "/api/v1/tasks",
  "/api/v1/tools",
  "/api/v1/turns",
] as const;

export function createAppSharedHostLifecycle(fastify: FastifyInstance): SharedHostLifecycleService {
  const publishEvidence = createLifecycleEvidencePublisher(fastify);
  return new SharedHostLifecycleService({
    enabled: resolveSharedHostLifecycleEnabled(),
    onEvent: publishEvidence,
  });
}

export const sharedHostLifecyclePlugin = fp<SharedHostLifecyclePluginOptions>(async (fastify, options) => {
  const lifecycle = options.lifecycle ?? createAppSharedHostLifecycle(fastify);
  if (!fastify.hasDecorator("sharedHostLifecycle")) {
    fastify.decorate("sharedHostLifecycle", lifecycle);
  } else if (fastify.sharedHostLifecycle !== lifecycle) {
    throw new Error("Shared-host lifecycle plugin received a controller different from the app-owned controller.");
  }
  if (options.activateImmediately !== false && lifecycle.snapshot().state === "starting") {
    lifecycle.markAccepting();
  }

  fastify.addHook("onRequest", async (request, reply) => {
    if (!lifecycle.enabled || isAlwaysAvailableRequest(request)) return;
    const kind = classifyRequestKind(request.url);
    const result = lifecycle.tryReserve(kind, `http:${request.id}`);
    if (!result.admitted) {
      reply.header("retry-after", "1");
      return reply.code(503).send({
        error: result.reason,
        code: "SHARED_HOST_ADMISSION_CLOSED",
        lifecycleState: result.state,
        retryable: result.retryable,
      });
    }
    request.sharedHostWorkReservation = result.reservation;
  });

  const releaseRequestReservation = (request: FastifyRequest) => {
    request.sharedHostWorkReservation?.release();
    request.sharedHostWorkReservation = undefined;
  };
  fastify.addHook("onResponse", async (request) => releaseRequestReservation(request));
  fastify.addHook("onError", async (request) => releaseRequestReservation(request));
  fastify.addHook("onRequestAbort", async (request) => releaseRequestReservation(request));

  fastify.addHook("onClose", async () => {
    try {
      const state = lifecycle.snapshot().state;
      if (state === "starting") {
        lifecycle.abortStartup();
      } else if (lifecycle.enabled && state !== "closed" && state !== "closing") {
        await lifecycle.drain({
          mode: "force",
          timeoutMs: resolveSharedHostDrainTimeoutMs(),
          reason: "fastify_close",
          actorId: "gateway",
        });
      }
      lifecycle.markClosed();
      try {
        await lifecycle.replayFailedSignals();
      } catch (error) {
        fastify.log.warn(error, "shared-host lifecycle evidence remained degraded during close");
      }
      await lifecycle.flushSignals().catch((error) => {
        fastify.log.warn(error, "shared-host lifecycle evidence flush failed during close");
      });
    } catch (error) {
      fastify.log.warn(error, "shared-host lifecycle close cleanup failed");
      if (lifecycle.snapshot().state === "starting") lifecycle.abortStartup();
      lifecycle.markClosed();
    }
  });
});

function isAlwaysAvailableRequest(request: FastifyRequest): boolean {
  if (request.method === "OPTIONS") return true;
  const path = stripQuery(request.url);
  return ALWAYS_AVAILABLE_PATHS.has(path) || path.startsWith(LIFECYCLE_ROUTE_PREFIX);
}

function classifyRequestKind(url: string): SharedHostWorkKind {
  const path = stripQuery(url);
  return AGENT_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ? "agent" : "api";
}

function stripQuery(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex >= 0 ? url.slice(0, queryIndex) : url;
}

function createLifecycleEvidencePublisher(
  fastify: FastifyInstance,
): (event: SharedHostLifecycleEvent) => Promise<void> {
  const priorFailures = new Map<string, Set<"audit" | "realtime">>();
  return async (event) => {
    const payload = lifecycleEventPayload(event);
    const deliveries = [
      {
        name: "audit" as const,
        publish: async (value: Record<string, unknown>, deliveryId: string): Promise<void> => {
          await Promise.resolve(
            fastify.services.devVerification.storage.audit.append("hooks", value, {
              deliveryId,
              occurredAt: event.occurredAt,
            }),
          );
        },
      },
      {
        name: "realtime" as const,
        publish: async (value: Record<string, unknown>): Promise<void> => {
          await Promise.resolve().then(() =>
            fastify.services.devVerification.publishRealtime("shared_host_lifecycle", "gateway", value, {
              eventClass: "operational_signal",
              eventAuthority: "retained_stream",
              links: {},
            }),
          );
        },
      },
    ];
    const results = await Promise.allSettled(
      deliveries.map((sink) => Promise.resolve().then(() => sink.publish(payload, event.eventId))),
    );
    const failedNames = new Set<"audit" | "realtime">();
    const failures: unknown[] = [];
    results.forEach((result, index) => {
      if (result.status !== "rejected") return;
      const name = deliveries[index]!.name;
      failedNames.add(name);
      failures.push(result.reason);
      fastify.log.warn(result.reason, `shared-host lifecycle ${name} evidence sink failed`);
    });
    const previous = priorFailures.get(event.eventId);
    if (failedNames.size > 0) {
      priorFailures.set(event.eventId, new Set([...(previous ?? []), ...failedNames]));
      const degraded = {
        ...payload,
        eventType: "shared_host.lifecycle.evidence_degraded",
        failedSinks: [...failedNames],
        replayPending: true,
      };
      await Promise.allSettled(
        deliveries
          .filter((sink) => !failedNames.has(sink.name))
          .map((sink) => Promise.resolve().then(() => sink.publish(degraded, `${event.eventId}:evidence-degraded`))),
      );
      throw new AggregateError(failures, "Shared-host lifecycle evidence persistence failed.");
    }
    if (previous?.size) {
      const replayed = {
        ...payload,
        eventType: "shared_host.lifecycle.evidence_replayed",
        recoveredSinks: [...previous],
        replayPending: false,
      };
      await Promise.all(
        deliveries.map((sink) =>
          Promise.resolve().then(() => sink.publish(replayed, `${event.eventId}:evidence-replayed`)),
        ),
      );
      priorFailures.delete(event.eventId);
    }
  };
}

function lifecycleEventPayload(event: SharedHostLifecycleEvent): Record<string, unknown> {
  return {
    eventType: event.eventType,
    eventId: event.eventId,
    from: event.from,
    to: event.to,
    occurredAt: event.occurredAt,
    lifecycle: event.snapshot,
  };
}

export const __internal = {
  classifyRequestKind,
  createLifecycleEvidencePublisher,
  isAlwaysAvailableRequest,
};
