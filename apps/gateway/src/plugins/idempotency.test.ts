import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Storage } from "@goatcitadel/storage";
import {
  commitMutationIdempotencyAlongsideCanonicalWrite,
  idempotencyHeaderPlugin,
  markMutationCommitted,
  markMutationCommittedFromError,
} from "./idempotency.js";

type MutationStatus = "pending" | "completed" | "failed";

class FakeMutationIdempotencyStore {
  private readonly rows = new Map<string, { payloadHash: string; status: MutationStatus }>();

  public claim(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
    payloadHash: string;
    leaseDurationMs?: number;
  }) {
    const key = this.toKey(input);
    const existing = this.rows.get(key);
    if (!existing) {
      this.rows.set(key, { payloadHash: input.payloadHash, status: "pending" });
      return { outcome: "claimed" as const, record: { status: "pending", claimToken: "fake-claim-token" } };
    }
    if (existing.payloadHash !== input.payloadHash) {
      return { outcome: "payload_mismatch" as const, record: existing };
    }
    if (existing.status === "failed") {
      this.rows.set(key, { payloadHash: input.payloadHash, status: "pending" });
      return { outcome: "claimed" as const, record: { status: "pending", claimToken: "fake-claim-token" } };
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

  public getStatus(input: {
    method: string;
    routePath: string;
    idempotencyKey: string;
    actorScope?: string;
  }): MutationStatus | undefined {
    return this.rows.get(this.toKey(input))?.status;
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
  it.each([
    ["send", "/api/v1/chat/sessions/:sessionId/agent-send/stream", "/api/v1/chat/sessions/session-1/agent-send/stream"],
    [
      "retry",
      "/api/v1/chat/sessions/:sessionId/turns/:turnId/retry/stream",
      "/api/v1/chat/sessions/session-1/turns/turn-1/retry/stream",
    ],
    [
      "edit",
      "/api/v1/chat/sessions/:sessionId/turns/:turnId/edit/stream",
      "/api/v1/chat/sessions/session-1/turns/turn-1/edit/stream",
    ],
  ])("uses a generation-fenced crash lease for canonical Chat SSE %s", async (_label, routePath, url) => {
    const built = await buildApp((fastify) => {
      fastify.post(routePath, async () => ({ ok: true }));
    });
    const claim = vi.spyOn(built.store, "claim");

    try {
      const response = await built.app.inject({
        method: "POST",
        url,
        headers: { "Idempotency-Key": `idem-chat-lease-${_label}` },
        payload: { content: "hello" },
      });

      expect(response.statusCode).toBe(200);
      expect(claim).toHaveBeenCalledWith(expect.objectContaining({ routePath, leaseDurationMs: 5 * 60_000 }));
    } finally {
      await built.app.close();
    }
  });

  it.each([
    [
      "retry",
      "/api/v1/chat/sessions/:sessionId/turns/:turnId/retry/stream",
      "/api/v1/chat/sessions/session-1/turns/turn-1/retry/stream",
    ],
    [
      "edit",
      "/api/v1/chat/sessions/:sessionId/turns/:turnId/edit/stream",
      "/api/v1/chat/sessions/session-1/turns/turn-1/edit/stream",
    ],
  ])(
    "reclaims a crash-stale real SQLite Chat SSE %s claim with a new response token",
    async (label, routePath, url) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-http-idempotency-stale-"));
      const storage = new Storage({
        dbPath: ":memory:",
        transcriptsDir: path.join(root, "transcripts"),
        auditDir: path.join(root, "audit"),
      });
      const app = Fastify();
      app.decorateRequest("authActorId", "operator:test");
      app.addHook("onRequest", async (request) => {
        request.authActorId = "operator:test";
      });
      const payload = { content: "hello" };
      const identity = {
        method: "POST",
        routePath,
        idempotencyKey: `idem-crash-stale-${label}`,
        actorScope: "operator:test",
      };
      const original = storage.mutationIdempotency.claim({
        ...identity,
        payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        now: "2000-01-01T00:00:00.000Z",
        leaseDurationMs: 1,
      });
      if (original.outcome !== "claimed") {
        throw new Error(`expected original claim, received ${original.outcome}`);
      }
      await app.register(idempotencyHeaderPlugin, { mutationStore: storage.mutationIdempotency });
      app.post(routePath, async (request) => {
        await commitMutationIdempotencyAlongsideCanonicalWrite(request);
        return { ok: true };
      });

      try {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { "Idempotency-Key": identity.idempotencyKey },
          payload,
        });
        const completed = storage.mutationIdempotency.get(identity);

        expect(response.statusCode).toBe(200);
        expect(completed).toMatchObject({ status: "completed" });
        expect(completed?.claimToken).not.toBe(original.record.claimToken);
      } finally {
        await app.close();
        storage.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("can complete the persistent claim at the canonical write boundary before response delivery", async () => {
    const storeRef: { current?: FakeMutationIdempotencyStore } = {};
    let statusAtCanonicalWriteBoundary: MutationStatus | undefined;
    let attempts = 0;
    const built = await buildApp((fastify) => {
      fastify.post("/api/v1/chat/sessions/:sessionId/messages", async (request) => {
        attempts += 1;
        await commitMutationIdempotencyAlongsideCanonicalWrite(request);
        statusAtCanonicalWriteBoundary = storeRef.current?.getStatus({
          method: "POST",
          routePath: "/api/v1/chat/sessions/:sessionId/messages",
          idempotencyKey: request.idempotencyKey,
          actorScope: request.authActorId,
        });
        return { ok: true };
      });
    });
    storeRef.current = built.store;

    try {
      const headers = { "Idempotency-Key": "idem-chat-canonical-commit" };
      const payload = { content: "hello" };
      const first = await built.app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/session-1/messages",
        headers,
        payload,
      });
      const retry = await built.app.inject({
        method: "POST",
        url: "/api/v1/chat/sessions/session-1/messages",
        headers,
        payload,
      });

      expect(first.statusCode).toBe(200);
      expect(statusAtCanonicalWriteBoundary).toBe("completed");
      expect(retry.statusCode).toBe(409);
      expect(attempts).toBe(1);
    } finally {
      await built.app.close();
    }
  });

  it.each([
    ["send", "/api/v1/chat/sessions/:sessionId/agent-send/stream", "/api/v1/chat/sessions/session-1/agent-send/stream"],
    [
      "retry",
      "/api/v1/chat/sessions/:sessionId/turns/:turnId/retry/stream",
      "/api/v1/chat/sessions/session-1/turns/turn-1/retry/stream",
    ],
    [
      "edit",
      "/api/v1/chat/sessions/:sessionId/turns/:turnId/edit/stream",
      "/api/v1/chat/sessions/session-1/turns/turn-1/edit/stream",
    ],
  ])(
    "fails the canonical Chat SSE %s write boundary when a stale request no longer owns the response token",
    async (_label, routePath, url) => {
      let writesAfterFence = 0;
      const built = await buildApp((fastify) => {
        fastify.post(routePath, async (request) => {
          await commitMutationIdempotencyAlongsideCanonicalWrite(request);
          writesAfterFence += 1;
          return { ok: true };
        });
      });
      const markCompleted = vi.spyOn(built.store, "markCompleted").mockReturnValue(false);

      try {
        const response = await built.app.inject({
          method: "POST",
          url,
          headers: { "Idempotency-Key": "idem-stale-http-owner" },
          payload: { content: "hello" },
        });

        expect(response.statusCode).toBe(500);
        expect(writesAfterFence).toBe(0);
        expect(markCompleted).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "fake-claim-token" }));
      } finally {
        await built.app.close();
      }
    },
  );

  it("blocks duplicate operator mutations with the same key and payload", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const built = await buildApp((fastify) => {
      fastify.post("/api/v1/tools/invoke", async (request) => {
        calls.push((request as { body: Record<string, unknown> }).body);
        return { ok: true };
      });
    });
    const markCompleted = vi.spyOn(built.store, "markCompleted");

    try {
      const headers = { "Idempotency-Key": "idem-tools-1" };
      const payload = { toolName: "shell.exec", args: { command: "echo hi" } };
      const first = await built.app.inject({ method: "POST", url: "/api/v1/tools/invoke", headers, payload });
      const second = await built.app.inject({ method: "POST", url: "/api/v1/tools/invoke", headers, payload });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({
        error: "Duplicate mutation blocked for this Idempotency-Key",
      });
      expect(calls).toEqual([payload]);
      expect(markCompleted).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "fake-claim-token" }));
    } finally {
      await built.app.close();
    }
  });

  it("binds secure configuration retries without durably hashing the credential body", async () => {
    let handlerCalls = 0;
    const built = await buildApp((fastify) => {
      fastify.post(
        "/api/v1/chat/sessions/:sessionId/turns/:turnId/user-input/:promptId/secure-configuration",
        async () => {
          handlerCalls += 1;
          return { ok: true };
        },
      );
    });
    const claim = vi.spyOn(built.store, "claim");
    const url =
      "/api/v1/chat/sessions/session-1/turns/turn-1/user-input/runtime_configuration%3Aprompt-1/secure-configuration";

    try {
      const first = await built.app.inject({
        method: "POST",
        url,
        headers: { "Idempotency-Key": "idem-secure-1" },
        payload: { secret: "gc-canary-secret-one" },
      });
      const second = await built.app.inject({
        method: "POST",
        url,
        headers: { "Idempotency-Key": "idem-secure-2" },
        payload: { secret: "gc-canary-secret-two" },
      });
      const lostResponseRetry = await built.app.inject({
        method: "POST",
        url,
        headers: { "Idempotency-Key": "idem-secure-1" },
        payload: { secret: "gc-canary-secret-retry-must-be-ignored-by-owner" },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(lostResponseRetry.statusCode).toBe(200);
      expect(handlerCalls).toBe(3);
      const firstHash = claim.mock.calls[0]?.[0].payloadHash;
      const secondHash = claim.mock.calls[1]?.[0].payloadHash;
      expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
      expect(secondHash).toBe(firstHash);
      expect(firstHash).not.toBe(
        createHash("sha256")
          .update(JSON.stringify({ secret: "gc-canary-secret-one" }))
          .digest("hex"),
      );
      expect(JSON.stringify(claim.mock.calls)).not.toContain("gc-canary-secret");
    } finally {
      await built.app.close();
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
    const built = await buildApp((fastify) => {
      fastify.post("/api/v1/tasks/run", async (_request, reply) => {
        attempts += 1;
        if (attempts === 1) {
          return reply.code(500).send({ error: "boom" });
        }
        return { ok: true };
      });
    });
    const markFailed = vi.spyOn(built.store, "markFailed");

    try {
      const headers = { "Idempotency-Key": "idem-task-1" };
      const payload = { taskId: "task-1" };
      const first = await built.app.inject({ method: "POST", url: "/api/v1/tasks/run", headers, payload });
      const second = await built.app.inject({ method: "POST", url: "/api/v1/tasks/run", headers, payload });

      expect(first.statusCode).toBe(500);
      expect(second.statusCode).toBe(200);
      expect(attempts).toBe(2);
      expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "fake-claim-token" }));
    } finally {
      await built.app.close();
    }
  });

  it("does not revive a committed mutation when response delivery later reports an error", async () => {
    let attempts = 0;
    const { app } = await buildApp((fastify) => {
      fastify.post("/api/v1/approvals/:approvalId/resolve", async (request, reply) => {
        attempts += 1;
        markMutationCommitted(request);
        return reply.code(500).send({ error: "response projection unavailable" });
      });
    });

    try {
      const headers = { "Idempotency-Key": "idem-approval-committed-response-failure" };
      const payload = { decision: "approve" };
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/approvals/apr-1/resolve",
        headers,
        payload,
      });
      const retry = await app.inject({
        method: "POST",
        url: "/api/v1/approvals/apr-1/resolve",
        headers,
        payload,
      });

      expect(first.statusCode).toBe(500);
      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toEqual({
        error: "Duplicate mutation blocked for this Idempotency-Key",
      });
      expect(attempts).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("does not revive a mutation-aware domain error after its cleanup transaction commits", async () => {
    let attempts = 0;
    const { app } = await buildApp((fastify) => {
      fastify.post("/api/v1/approvals/:approvalId/resolve", async (request, reply) => {
        attempts += 1;
        const error = Object.assign(new Error("approval expired"), { mutationCommitted: true });
        markMutationCommittedFromError(request, error);
        return reply.code(400).send({ error: error.message });
      });
    });

    try {
      const headers = { "Idempotency-Key": "idem-approval-expiry-cleanup" };
      const payload = { decision: "approve" };
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/approvals/apr-expired/resolve",
        headers,
        payload,
      });
      const retry = await app.inject({
        method: "POST",
        url: "/api/v1/approvals/apr-expired/resolve",
        headers,
        payload,
      });

      expect(first.statusCode).toBe(400);
      expect(retry.statusCode).toBe(409);
      expect(attempts).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("releases a non-side-effecting 4xx so a same-key retry can re-run", async () => {
    // F-M1: a handler-emitted 4xx that performed no mutation (here a transient
    // precondition rejection) used to burn the key as `completed`, so a later
    // retry of the same request was blocked with 409. The key must instead be
    // revivable — mirrors the 500-retry path above.
    let attempts = 0;
    const { app } = await buildApp((fastify) => {
      fastify.post("/api/v1/tasks/run", async (_request, reply) => {
        attempts += 1;
        if (attempts === 1) {
          // No side effect: reject up front (e.g. a not-yet-ready precondition).
          return reply.code(422).send({ error: "resource not ready, retry" });
        }
        return { ok: true };
      });
    });

    try {
      const headers = { "Idempotency-Key": "idem-task-4xx-1" };
      const payload = { taskId: "task-1" };
      const first = await app.inject({ method: "POST", url: "/api/v1/tasks/run", headers, payload });
      const second = await app.inject({ method: "POST", url: "/api/v1/tasks/run", headers, payload });

      expect(first.statusCode).toBe(422);
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
