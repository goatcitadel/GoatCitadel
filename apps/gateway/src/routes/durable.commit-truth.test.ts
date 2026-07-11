import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { durableRoutes } from "./durable.js";

type MutationStatus = "pending" | "completed" | "failed";

class FakeMutationIdempotencyStore {
  private readonly rows = new Map<string, { payloadHash: string; status: MutationStatus }>();

  public claim(input: MutationKey & { payloadHash: string }) {
    const key = this.toKey(input);
    const existing = this.rows.get(key);
    if (!existing || existing.status === "failed") {
      this.rows.set(key, { payloadHash: input.payloadHash, status: "pending" });
      return { outcome: "claimed" as const, record: { status: "pending" } };
    }
    if (existing.payloadHash !== input.payloadHash) {
      return { outcome: "payload_mismatch" as const, record: existing };
    }
    return {
      outcome: existing.status === "pending" ? ("in_progress" as const) : ("duplicate" as const),
      record: existing,
    };
  }

  public markCompleted(input: MutationKey): void {
    this.updateStatus(input, "completed");
  }

  public markFailed(input: MutationKey): void {
    this.updateStatus(input, "failed");
  }

  private updateStatus(input: MutationKey, status: MutationStatus): void {
    const key = this.toKey(input);
    const existing = this.rows.get(key);
    if (existing) {
      this.rows.set(key, { ...existing, status });
    }
  }

  private toKey(input: MutationKey): string {
    return [input.method, input.routePath, input.idempotencyKey, input.actorScope ?? ""].join("|");
  }
}

interface MutationKey {
  method: string;
  routePath: string;
  idempotencyKey: string;
  actorScope?: string;
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("durable route commit truth", () => {
  it.each([
    {
      label: "create",
      methodName: "createRun",
      url: "/api/v1/durable/runs",
      payload: { workflowKey: "connector.delivery" },
    },
    { label: "pause", methodName: "pauseRun", url: "/api/v1/durable/runs/run-1/pause", payload: {} },
    { label: "resume", methodName: "resumeRun", url: "/api/v1/durable/runs/run-1/resume", payload: {} },
    { label: "cancel", methodName: "cancelRun", url: "/api/v1/durable/runs/run-1/cancel", payload: {} },
    {
      label: "retry",
      methodName: "retryRun",
      url: "/api/v1/durable/runs/run-1/retry",
      payload: { reason: "operator_retry" },
    },
    {
      label: "wake",
      methodName: "wakeRun",
      url: "/api/v1/durable/runs/run-1/events/wake",
      payload: { eventKey: "approval.resolved" },
    },
    {
      label: "dead-letter recovery",
      methodName: "recoverDeadLetter",
      url: "/api/v1/durable/dead-letters/dead-1/recover",
      payload: {},
    },
  ])("keeps the $label idempotency key committed when response delivery fails", async (scenario) => {
    const mutation = vi.fn(() => ({ runId: "run-1", status: "queued", outcome: "woke" }));
    const app = Fastify();
    apps.push(app);
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", {
      durable: {
        createRun: vi.fn(),
        getDiagnostics: vi.fn(),
        getRun: vi.fn(),
        listDeadLetters: vi.fn(() => []),
        listRunCheckpoints: vi.fn(() => []),
        listRuns: vi.fn(() => []),
        listRunTimeline: vi.fn(() => []),
        pauseRun: vi.fn(),
        resumeRun: vi.fn(),
        cancelRun: vi.fn(),
        retryRun: vi.fn(),
        wakeRun: vi.fn(),
        recoverDeadLetter: vi.fn(),
        [scenario.methodName]: mutation,
      },
    } as never);
    await app.register(idempotencyHeaderPlugin, {
      mutationStore: new FakeMutationIdempotencyStore() as never,
    });
    await app.register(durableRoutes);
    let failResponse = true;
    app.addHook("onSend", async (request, reply, payload) => {
      if (failResponse && request.url === scenario.url && reply.statusCode < 400) {
        failResponse = false;
        throw new Error("response delivery unavailable");
      }
      return payload;
    });

    const request = {
      method: "POST" as const,
      url: scenario.url,
      headers: { "idempotency-key": `durable-${scenario.label}` },
      payload: scenario.payload,
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(500);
    expect(retry.statusCode).toBe(409);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("allows the same wake key to retry after a rolled-back wake failure", async () => {
    const wakeRun = vi
      .fn()
      .mockReturnValueOnce({ outcome: "failed", runId: "run-1", detail: "timeline write unavailable" })
      .mockReturnValueOnce({ outcome: "woke", runId: "run-1", run: { runId: "run-1", status: "queued" } });
    const app = Fastify();
    apps.push(app);
    app.decorate("requireOperatorAuth", async () => undefined);
    app.decorate("services", {
      durable: {
        createRun: vi.fn(),
        getDiagnostics: vi.fn(),
        getRun: vi.fn(),
        listDeadLetters: vi.fn(() => []),
        listRunCheckpoints: vi.fn(() => []),
        listRuns: vi.fn(() => []),
        listRunTimeline: vi.fn(() => []),
        pauseRun: vi.fn(),
        resumeRun: vi.fn(),
        cancelRun: vi.fn(),
        retryRun: vi.fn(),
        wakeRun,
        recoverDeadLetter: vi.fn(),
      },
    } as never);
    await app.register(idempotencyHeaderPlugin, {
      mutationStore: new FakeMutationIdempotencyStore() as never,
    });
    await app.register(durableRoutes);

    const request = {
      method: "POST" as const,
      url: "/api/v1/durable/runs/run-1/events/wake",
      headers: { "idempotency-key": "wake-after-rollback" },
      payload: { eventKey: "approval.resolved" },
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(503);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ outcome: "woke", run: { status: "queued" } });
    expect(wakeRun).toHaveBeenCalledTimes(2);
  });
});
