import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { healthRoute } from "./health.js";
import { SharedHostLifecycleService } from "../services/shared-host-lifecycle-service.js";

describe("health route", () => {
  it("keeps detailed readiness behind operator authentication while public health stays sanitized", async () => {
    const app = Fastify();
    const getDatabaseHealthSnapshot = vi.fn(async () => ({
      driver: "postgres" as const,
      configured: true,
      reachable: true,
      issues: [],
    }));
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot,
        getConfigGenerationHealthSnapshot: vi.fn(async () => readyConfigGeneration()),
      },
    } as never);
    app.decorate("requireOperatorAuth", async (_request, reply) => {
      await reply.code(401).send({ error: "Operator authentication is required." });
    });
    await app.register(healthRoute);

    try {
      const publicResponse = await app.inject({ method: "GET", url: "/health" });
      expect(publicResponse.statusCode).toBe(200);
      expect(publicResponse.json()).toEqual({
        status: "ok",
        readiness: "ready",
        service: "gateway",
      });

      const detailedResponse = await app.inject({ method: "GET", url: "/api/v1/ops/readiness" });
      expect(detailedResponse.statusCode).toBe(401);
      expect(detailedResponse.json()).toEqual({ error: "Operator authentication is required." });
      expect(getDatabaseHealthSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("returns ready when the database snapshot is reachable and clean", async () => {
    const app = Fastify();
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot: vi.fn(async () => ({
          driver: "sqlite",
          configured: true,
          reachable: true,
          issues: [],
        })),
        getConfigGenerationHealthSnapshot: vi.fn(async () => readyConfigGeneration()),
      },
    } as never);
    app.decorate("requireOperatorAuth", async () => undefined);
    await app.register(healthRoute);

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ok",
        readiness: "ready",
        service: "gateway",
      });

      const detailed = await app.inject({ method: "GET", url: "/api/v1/ops/readiness" });
      expect(detailed.statusCode).toBe(200);
      expect(detailed.json()).toMatchObject({
        status: "ok",
        readiness: "ready",
        checks: [
          {
            key: "database",
            configuration: "configured",
            probe: "passed",
            state: "ready",
            driver: "sqlite",
            issueCount: 0,
          },
          {
            key: "config_generation",
            state: "ready",
            revision: 7,
            transactionState: "idle",
            mirrorRepairPending: false,
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("returns degraded when the database snapshot is unreachable", async () => {
    const app = Fastify();
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot: vi.fn(async () => ({
          driver: "postgres",
          configured: true,
          reachable: false,
          issues: ["connection refused"],
        })),
        getConfigGenerationHealthSnapshot: vi.fn(async () => readyConfigGeneration()),
      },
    } as never);
    app.decorate("requireOperatorAuth", async () => undefined);
    await app.register(healthRoute);

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: "degraded",
        readiness: "degraded",
        service: "gateway",
      });
      expect(response.body).not.toContain("connection refused");

      const detailed = await app.inject({ method: "GET", url: "/api/v1/ops/readiness" });
      expect(detailed.statusCode).toBe(503);
      expect(detailed.body).not.toContain("connection refused");
      const detailedBody = detailed.json();
      expect(detailedBody).toMatchObject({ readiness: "degraded" });
      expect(detailedBody.checks[0]).toMatchObject({
        key: "database",
        configuration: "configured",
        probe: "failed",
        state: "degraded",
        driver: "postgres",
        issueCount: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("returns degraded when the database reports issues despite being reachable", async () => {
    const app = Fastify();
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot: vi.fn(async () => ({
          driver: "sqlite",
          configured: true,
          reachable: true,
          issues: ["migration drift detected"],
        })),
        getConfigGenerationHealthSnapshot: vi.fn(async () => readyConfigGeneration()),
      },
    } as never);
    app.decorate("requireOperatorAuth", async () => undefined);
    await app.register(healthRoute);

    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "degraded",
        readiness: "degraded",
      });
      expect(response.body).not.toContain("migration drift detected");

      const detailed = await app.inject({ method: "GET", url: "/api/v1/ops/readiness" });
      expect(detailed.statusCode).toBe(503);
      expect(detailed.body).not.toContain("migration drift detected");
      expect(detailed.json().checks[0]).toMatchObject({
        configuration: "configured",
        probe: "passed",
        state: "degraded",
        issueCount: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("distinguishes not-configured owner state without exposing raw issue details", async () => {
    const app = Fastify();
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot: vi.fn(async () => ({
          driver: "postgres",
          configured: false,
          reachable: false,
          issues: ["postgres://operator:secret@db.internal/goatcitadel"],
        })),
        getConfigGenerationHealthSnapshot: vi.fn(async () => readyConfigGeneration()),
      },
    } as never);
    app.decorate("requireOperatorAuth", async () => undefined);
    await app.register(healthRoute);

    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/ops/readiness" });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("operator:secret");
      expect(response.body).not.toContain("db.internal");
      const responseBody = response.json();
      expect(responseBody).toMatchObject({ readiness: "degraded" });
      expect(responseBody.checks[0]).toMatchObject({
        key: "database",
        configuration: "not_configured",
        probe: "failed",
        issueCount: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("reports an in-flight or mirror-degraded config generation without exposing config payloads", async () => {
    const app = Fastify();
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot: vi.fn(async () => ({
          driver: "sqlite" as const,
          configured: true,
          reachable: true,
          issues: [],
        })),
        getConfigGenerationHealthSnapshot: vi.fn(async () => ({
          ...readyConfigGeneration(),
          transactionState: "pending" as const,
          mirrorRepairPending: true,
        })),
      },
    } as never);
    app.decorate("requireOperatorAuth", async () => undefined);
    await app.register(healthRoute);

    try {
      const publicResponse = await app.inject({ method: "GET", url: "/health" });
      expect(publicResponse.statusCode).toBe(503);
      expect(publicResponse.json()).toEqual({
        status: "degraded",
        readiness: "degraded",
        service: "gateway",
      });

      const detailedResponse = await app.inject({ method: "GET", url: "/api/v1/ops/readiness" });
      expect(detailedResponse.statusCode).toBe(503);
      expect(detailedResponse.body).not.toContain("assistant");
      expect(detailedResponse.body).not.toContain("toolPolicy");
      expect(detailedResponse.json()).toMatchObject({
        checks: [
          { key: "database", state: "ready" },
          {
            key: "config_generation",
            probe: "failed",
            state: "degraded",
            transactionState: "pending",
            mirrorRepairPending: true,
            recoveryOutcome: "confirmed_generation",
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("reports shared-host drain truth as unready while liveness remains a separate concern", async () => {
    const app = Fastify();
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    await lifecycle.drain({ mode: "pause", timeoutMs: 10, reason: "scale_down", actorId: "ops" });
    app.decorate("sharedHostLifecycle", lifecycle);
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot: vi.fn(async () => ({
          driver: "sqlite",
          configured: true,
          reachable: true,
          issues: [],
        })),
        getConfigGenerationHealthSnapshot: vi.fn(async () => readyConfigGeneration()),
      },
    } as never);
    app.decorate("requireOperatorAuth", async () => undefined);
    await app.register(healthRoute);

    try {
      const publicResponse = await app.inject({ method: "GET", url: "/health" });
      expect(publicResponse.statusCode).toBe(503);
      expect(publicResponse.json()).toEqual({ status: "degraded", readiness: "degraded", service: "gateway" });

      const detailed = await app.inject({ method: "GET", url: "/api/v1/ops/readiness" });
      expect(detailed.statusCode).toBe(503);
      expect(detailed.json().checks.at(-1)).toMatchObject({
        key: "shared_host_lifecycle",
        state: "degraded",
        lifecycleState: "quiesced",
        admission: "closed",
        activeCount: 0,
      });
    } finally {
      await app.close();
    }
  });

  it("keeps an accepting host unready while lifecycle evidence is degraded", async () => {
    const app = Fastify();
    const lifecycle = new SharedHostLifecycleService({
      enabled: true,
      onEvent: async () => {
        throw new Error("audit unavailable");
      },
    });
    lifecycle.markAccepting();
    await expect(lifecycle.flushSignals()).rejects.toThrow(/evidence signals failed/i);
    app.decorate("sharedHostLifecycle", lifecycle);
    app.decorate("services", {
      health: {
        getDatabaseHealthSnapshot: vi.fn(async () => ({
          driver: "sqlite",
          configured: true,
          reachable: true,
          issues: [],
        })),
        getConfigGenerationHealthSnapshot: vi.fn(async () => readyConfigGeneration()),
      },
    } as never);
    app.decorate("requireOperatorAuth", async () => undefined);
    await app.register(healthRoute);

    try {
      const publicResponse = await app.inject({ method: "GET", url: "/health" });
      expect(publicResponse.statusCode).toBe(503);
      expect(publicResponse.json()).toEqual({ status: "degraded", readiness: "degraded", service: "gateway" });

      const detailed = await app.inject({ method: "GET", url: "/api/v1/ops/readiness" });
      expect(detailed.statusCode).toBe(503);
      expect(detailed.json().checks.at(-1)).toMatchObject({
        key: "shared_host_lifecycle",
        lifecycleState: "accepting",
        admission: "open",
        evidence: { state: "degraded", failedCount: 1 },
      });
    } finally {
      await app.close();
    }
  });
});

function readyConfigGeneration() {
  return {
    revision: 7,
    generationId: "generation-7",
    transactionState: "idle" as const,
    mirrorRepairPending: false,
    lastRecovery: {
      outcome: "confirmed_generation" as const,
      recovered: false,
      revision: 7,
    },
  };
}
