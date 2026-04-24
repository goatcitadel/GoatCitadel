import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { improvementRoutes } from "./improvement.js";

describe("improvement routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("serves legacy capability-gap and repair-candidate endpoints", async () => {
    const listCapabilityGapEvents = vi.fn(() => [
      {
        eventId: "gap-1",
        sessionId: "sess-1",
        causeClass: "retryable_network_failure",
        confidence: 0.8,
        repeatCount: 2,
        recoveryOptions: ["retry_once"],
        replayStatus: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const listRepairCandidates = vi.fn(() => [
      {
        candidateId: "repair-1",
        fingerprint: "fp-1",
        causeClass: "retryable_network_failure",
        title: "Retry connector",
        summary: "Retry the connector path.",
        validationStatus: "needs_review",
        eventCount: 2,
        confidence: 0.8,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
    ]);
    const updateRepairCandidateValidation = vi.fn(() => ({
      candidateId: "repair-1",
      fingerprint: "fp-1",
      causeClass: "retryable_network_failure",
      title: "Retry connector",
      summary: "Retry the connector path.",
      validationStatus: "passed",
      validationSummary: "validated",
      eventCount: 2,
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }));

    app = Fastify();
    app.decorate("services", {
      improvement: {
        listCapabilityGapEvents,
        listRepairCandidates,
        updateRepairCandidateValidation,
      },
    } as never);
    await app.register(improvementRoutes);

    const gaps = await app.inject({
      method: "GET",
      url: "/api/v1/improvement/capability-gaps?limit=5",
    });
    expect(gaps.statusCode).toBe(200);
    expect(listCapabilityGapEvents).toHaveBeenCalledWith(5);

    const repairs = await app.inject({
      method: "GET",
      url: "/api/v1/improvement/repair-candidates?limit=7",
    });
    expect(repairs.statusCode).toBe(200);
    expect(listRepairCandidates).toHaveBeenCalledWith(7);

    const validation = await app.inject({
      method: "PATCH",
      url: "/api/v1/improvement/repair-candidates/repair-1/validation",
      payload: {
        status: "passed",
        summary: "validated",
      },
    });
    expect(validation.statusCode).toBe(200);
    expect(updateRepairCandidateValidation).toHaveBeenCalledWith("repair-1", {
      status: "passed",
      summary: "validated",
    });
  });

  it("serves ledger signal, candidate, and activation detail routes", async () => {
    const listImprovementSignals = vi.fn(() => [{ signalId: "sig-1" }]);
    const getImprovementSignal = vi.fn(() => ({ signalId: "sig-1" }));
    const listImprovementCandidates = vi.fn(() => [{ candidateId: "cand-1" }]);
    const getImprovementCandidate = vi.fn(() => ({
      candidate: { candidateId: "cand-1" },
      supportingSignals: [],
      attemptManifestSummary: [],
    }));
    const getImprovementActivation = vi.fn(() => ({ activationId: "act-1", status: "active" }));
    const getHarnessAuditReport = vi.fn(() => ({
      generatedAt: "2026-04-16T10:00:00.000Z",
      summary: "Harness audit summary",
      overallScore: 84,
      overallStatus: "strong",
      pillars: [],
      strategyGlossary: [],
    }));

    app = Fastify();
    app.decorate("services", {
      improvement: {
        listImprovementSignals,
        getImprovementSignal,
        listImprovementCandidates,
        getImprovementCandidate,
        getImprovementActivation,
        getHarnessAuditReport,
      },
    } as never);
    await app.register(improvementRoutes);

    const signals = await app.inject({
      method: "GET",
      url: "/api/v1/improvement/signals?limit=11&workspaceId=ws-1",
    });
    expect(signals.statusCode).toBe(200);
    expect(listImprovementSignals).toHaveBeenCalledWith(11, "ws-1");

    const signal = await app.inject({
      method: "GET",
      url: "/api/v1/improvement/signals/sig-1",
    });
    expect(signal.statusCode).toBe(200);
    expect(getImprovementSignal).toHaveBeenCalledWith("sig-1");

    const candidates = await app.inject({
      method: "GET",
      url: "/api/v1/improvement/candidates?limit=13",
    });
    expect(candidates.statusCode).toBe(200);
    expect(listImprovementCandidates).toHaveBeenCalledWith(13, undefined);

    const candidate = await app.inject({
      method: "GET",
      url: "/api/v1/improvement/candidates/cand-1",
    });
    expect(candidate.statusCode).toBe(200);
    expect(getImprovementCandidate).toHaveBeenCalledWith("cand-1");

    const activation = await app.inject({
      method: "GET",
      url: "/api/v1/improvement/activations/act-1",
    });
    expect(activation.statusCode).toBe(200);
    expect(getImprovementActivation).toHaveBeenCalledWith("act-1");

    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/improvement/harness-audit",
    });
    expect(audit.statusCode).toBe(200);
    expect(getHarnessAuditReport).toHaveBeenCalledOnce();
  });

  it("returns 409 for activation request, pause, and rollback conflicts", async () => {
    const requestImprovementActivation = vi.fn(async () => {
      throw new Error("candidate drifted");
    });
    const pauseImprovementActivation = vi.fn(() => {
      throw new Error("activation not active");
    });
    const rollbackImprovementActivation = vi.fn(() => {
      throw new Error("activation already rolled back");
    });

    app = Fastify();
    app.decorate("services", {
      improvement: {
        requestImprovementActivation,
        pauseImprovementActivation,
        rollbackImprovementActivation,
      },
    } as never);
    await app.register(improvementRoutes);

    const activate = await app.inject({
      method: "POST",
      url: "/api/v1/improvement/candidates/cand-1/activation-request",
      payload: {},
    });
    expect(activate.statusCode).toBe(409);

    const pause = await app.inject({
      method: "POST",
      url: "/api/v1/improvement/activations/act-1/pause",
      payload: {},
    });
    expect(pause.statusCode).toBe(409);

    const rollback = await app.inject({
      method: "POST",
      url: "/api/v1/improvement/activations/act-1/rollback",
      payload: {},
    });
    expect(rollback.statusCode).toBe(409);
  });

  it("returns 404s for missing ledger and legacy resources", async () => {
    const getImprovementSignal = vi.fn(() => {
      throw new Error("missing signal");
    });
    const getImprovementCandidate = vi.fn(() => {
      throw new Error("missing candidate");
    });
    const getImprovementActivation = vi.fn(() => {
      throw new Error("missing activation");
    });
    const updateRepairCandidateValidation = vi.fn(() => {
      throw new Error("missing repair candidate");
    });
    const requestImprovementActivation = vi.fn(async () => {
      throw new Error("improvement candidate not found");
    });
    const pauseImprovementActivation = vi.fn(() => {
      throw new Error("improvement activation not found");
    });
    const rollbackImprovementActivation = vi.fn(() => {
      throw new Error("improvement activation not found");
    });

    app = Fastify();
    app.decorate("services", {
      improvement: {
        getImprovementSignal,
        getImprovementCandidate,
        getImprovementActivation,
        updateRepairCandidateValidation,
        requestImprovementActivation,
        pauseImprovementActivation,
        rollbackImprovementActivation,
      },
    } as never);
    await app.register(improvementRoutes);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/improvement/signals/missing",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/improvement/candidates/missing",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/improvement/activations/missing",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/improvement/repair-candidates/missing/validation",
          payload: {
            status: "failed",
          },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/improvement/candidates/missing/activation-request",
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/improvement/activations/missing/pause",
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/improvement/activations/missing/rollback",
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
});
