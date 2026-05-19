import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { idempotencyHeaderPlugin } from "./idempotency.js";

type MutationStatus = "pending" | "completed" | "failed";

class FakeMutationIdempotencyStore {
  private readonly rows = new Map<string, { payloadHash: string; status: MutationStatus }>();

  public claim(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
    payloadHash: string;
  }) {
    const key = this.toKey(input);
    const existing = this.rows.get(key);
    if (!existing) {
      this.rows.set(key, { payloadHash: input.payloadHash, status: "pending" });
      return { outcome: "claimed" as const, record: { status: "pending" } };
    }
    if (existing.payloadHash !== input.payloadHash) {
      return { outcome: "payload_mismatch" as const, record: existing };
    }
    if (existing.status === "failed") {
      this.rows.set(key, { payloadHash: input.payloadHash, status: "pending" });
      return { outcome: "claimed" as const, record: { status: "pending" } };
    }
    return {
      outcome: existing.status === "pending" ? ("in_progress" as const) : ("duplicate" as const),
      record: existing,
    };
  }

  public markCompleted(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
  }): void {
    this.updateStatus(input, "completed");
  }

  public markFailed(input: { method: string; routePath: string; idempotencyKey: string; actorScope?: string }): void {
    this.updateStatus(input, "failed");
  }

  private updateStatus(
    input: {
      method: string;
      routePath: string;
      idempotencyKey: string;
      actorScope?: string;
    },
    status: MutationStatus,
  ): void {
    const key = this.toKey(input);
    const existing = this.rows.get(key);
    if (!existing) {
      return;
    }
    this.rows.set(key, { ...existing, status });
  }

  private toKey(input: { method: string; routePath: string; idempotencyKey: string; actorScope?: string }): string {
    return [input.method, input.routePath, input.idempotencyKey, input.actorScope ?? ""].join("|");
  }
}

async function buildApp(
  handler: (app: FastifyInstance) => void,
): Promise<{ app: FastifyInstance; store: FakeMutationIdempotencyStore }> {
  const store = new FakeMutationIdempotencyStore();
  const app = Fastify();
  app.decorateRequest("authActorId", "operator:test");
  app.addHook("onRequest", async (request) => {
    request.authActorId = "operator:test";
  });
  await app.register(idempotencyHeaderPlugin, { mutationStore: store });
  handler(app);
  return { app, store };
}

afterEach(() => {
  // no-op placeholder so future per-test cleanup is centralized
});

describe("idempotencyHeaderPlugin", () => {
  it("blocks duplicate operator mutations with the same key and payload", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { app } = await buildApp((fastify) => {
      fastify.post("/api/v1/tools/invoke", async (request) => {
        calls.push((request as { body: Record<string, unknown> }).body);
        return { ok: true };
      });
    });

    try {
      const headers = { "Idempotency-Key": "idem-tools-1" };
      const payload = { toolName: "shell.exec", args: { command: "echo hi" } };
      const first = await app.inject({ method: "POST", url: "/api/v1/tools/invoke", headers, payload });
      const second = await app.inject({ method: "POST", url: "/api/v1/tools/invoke", headers, payload });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({
        error: "Duplicate mutation blocked for this Idempotency-Key",
      });
      expect(calls).toEqual([payload]);
    } finally {
      await app.close();
    }
  });

  it("rejects reused keys when the payload changes", async () => {
    const { app } = await buildApp((fastify) => {
      fastify.post("/api/v1/approvals/:approvalId/resolve", async () => ({ ok: true }));
    });

    try {
      const headers = { "Idempotency-Key": "idem-approval-1" };
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/approvals/apr-1/resolve",
        headers,
        payload: { decision: "approve" },
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/approvals/apr-1/resolve",
        headers,
        payload: { decision: "reject" },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({
        error: "Idempotency-Key was reused with a different payload",
      });
    } finally {
      await app.close();
    }
  });

  it("blocks completed duplicate approval resolve requests with the same key and payload", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { app } = await buildApp((fastify) => {
      fastify.post("/api/v1/approvals/:approvalId/resolve", async (request) => {
        calls.push((request as { body: Record<string, unknown> }).body);
        return { ok: true };
      });
    });

    try {
      const headers = { "Idempotency-Key": "idem-approval-completed-1" };
      const payload = { decision: "approve" };
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/approvals/apr-1/resolve",
        headers,
        payload,
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/approvals/apr-1/resolve",
        headers,
        payload,
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({
        error: "Duplicate mutation blocked for this Idempotency-Key",
      });
      expect(calls).toEqual([payload]);
    } finally {
      await app.close();
    }
  });

  it("blocks a parallel approval resolve while the first matching mutation is in progress", async () => {
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const calls: Array<Record<string, unknown>> = [];
    const { app } = await buildApp((fastify) => {
      fastify.post("/api/v1/approvals/:approvalId/resolve", async (request) => {
        calls.push((request as { body: Record<string, unknown> }).body);
        firstStarted();
        await firstCanFinish;
        return { ok: true };
      });
    });

    try {
      const headers = { "Idempotency-Key": "idem-approval-parallel-1" };
      const payload = { decision: "approve" };
      const first = app.inject({
        method: "POST",
        url: "/api/v1/approvals/apr-1/resolve",
        headers,
        payload,
      });
      await firstStartedPromise;
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/approvals/apr-1/resolve",
        headers,
        payload,
      });
      releaseFirst();
      const firstResponse = await first;

      expect(firstResponse.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({
        error: "Request already in progress for this Idempotency-Key",
      });
      expect(calls).toEqual([payload]);
    } finally {
      releaseFirst();
      await app.close();
    }
  });

  it("releases failed claims so a later retry can execute", async () => {
    let attempts = 0;
    const { app } = await buildApp((fastify) => {
      fastify.post("/api/v1/tasks/run", async (_request, reply) => {
        attempts += 1;
        if (attempts === 1) {
          return reply.code(500).send({ error: "boom" });
        }
        return { ok: true };
      });
    });

    try {
      const headers = { "Idempotency-Key": "idem-task-1" };
      const payload = { taskId: "task-1" };
      const first = await app.inject({ method: "POST", url: "/api/v1/tasks/run", headers, payload });
      const second = await app.inject({ method: "POST", url: "/api/v1/tasks/run", headers, payload });

      expect(first.statusCode).toBe(500);
      expect(second.statusCode).toBe(200);
      expect(attempts).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("requires idempotency keys for normal channel setup mutations", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { app } = await buildApp((fastify) => {
      fastify.post("/api/v1/channels/drafts", async (request) => {
        calls.push((request as { body: Record<string, unknown> }).body);
        return { ok: true };
      });
    });

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/v1/channels/drafts",
        payload: { channel: "discord" },
      });
      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/channels/drafts",
        headers: { "Idempotency-Key": "idem-channel-draft-1" },
        payload: { channel: "discord" },
      });

      expect(missing.statusCode).toBe(400);
      expect(accepted.statusCode).toBe(200);
      expect(calls).toEqual([{ channel: "discord" }]);
    } finally {
      await app.close();
    }
  });

  it("does not require operator idempotency headers for generic signed inbound webhooks", async () => {
    const calls: string[] = [];
    const { app } = await buildApp((fastify) => {
      fastify.post("/api/v1/integrations/connections/:connectionId/:channel/inbound", async (request) => {
        calls.push(request.idempotencyKey);
        return { ok: true };
      });
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/discord/inbound",
        payload: { eventId: "evt-1" },
      });

      expect(response.statusCode).toBe(200);
      expect(calls).toEqual([""]);
    } finally {
      await app.close();
    }
  });
});
