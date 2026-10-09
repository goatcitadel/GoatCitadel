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

  public get(input: { method: string; routePath: string; idempotencyKey: string; actorScope?: string }) {
    const row = this.rows.get(this.toKey(input));
    return row
      ? { ...input, actorScope: input.actorScope ?? "", payloadHash: row.payloadHash, status: row.status, claimToken: "fake-claim-token", createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:01.000Z" }
      : undefined;
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
  options: { store?: FakeMutationIdempotencyStore; actorId?: string } = {},
): Promise<{ app: FastifyInstance; store: FakeMutationIdempotencyStore }> {
  const store = options.store ?? new FakeMutationIdempotencyStore();
  const actorId = options.actorId ?? "operator:test";
  const app = Fastify();
  app.decorateRequest("authActorId", actorId);
  app.addHook("onRequest", async (request) => {
    request.authActorId = actorId;
  });
  await app.register(idempotencyHeaderPlugin, { mutationStore: store });
  handler(app);
  return { app, store };
}

afterEach(() => {
  // no-op placeholder so future per-test cleanup is centralized
});

describe("mutation attempt read", () => {
  const route = "/api/v1/example/attempt";
  const read = (app: FastifyInstance, key: string, query = `method=POST&route=${encodeURIComponent(route)}`) =>
    app.inject({ method: "GET", url: `/api/v1/mutation-attempts/${encodeURIComponent(key)}?${query}` });

  it("reports the caller's own recorded attempt outcome without its fingerprint or claim token", async () => {
    const built = await buildApp((fastify) => {
      fastify.post(route, async (request, reply) =>
        (request.body as { fail?: boolean }).fail ? reply.code(422).send({ error: "invalid" }) : { ok: true });
    });
    try {
      await built.app.inject({ method: "POST", url: route, headers: { "Idempotency-Key": "attempt-done" }, payload: {} });
      await built.app.inject({ method: "POST", url: route, headers: { "Idempotency-Key": "attempt-failed" }, payload: { fail: true } });
      const done = await read(built.app, "attempt-done");
      expect(done.statusCode).toBe(200);
      expect(done.headers["cache-control"]).toBe("no-store");
      expect(done.json()).toEqual({ attempt: { status: "completed", claimExpired: false, updatedAt: "2026-10-08T00:00:01.000Z" } });
      expect(done.body).not.toMatch(/payloadHash|claimToken|fake-claim-token/u);
      expect((await read(built.app, "attempt-failed")).json().attempt.status).toBe("failed");
      expect((await read(built.app, "never-sent")).json()).toEqual({ attempt: { status: "absent" } });
    } finally {
      await built.app.close();
    }
  });

  it("reports an attempt that is still running as pending", async () => {
    let release!: () => void;
    const built = await buildApp((fastify) => {
      fastify.post(route, async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { ok: true };
      });
    });
    try {
      const running = built.app.inject({ method: "POST", url: route, headers: { "Idempotency-Key": "attempt-running" }, payload: {} });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect((await read(built.app, "attempt-running")).json().attempt.status).toBe("pending");
      release();
      await running;
      expect((await read(built.app, "attempt-running")).json().attempt.status).toBe("completed");
    } finally {
      await built.app.close();
    }
  });

  it("never reveals another caller's attempt", async () => {
    const store = new FakeMutationIdempotencyStore();
    const owner = await buildApp((fastify) => { fastify.post(route, async () => ({ ok: true })); }, { store, actorId: "operator:one" });
    const other = await buildApp((fastify) => { fastify.post(route, async () => ({ ok: true })); }, { store, actorId: "operator:two" });
    try {
      await owner.app.inject({ method: "POST", url: route, headers: { "Idempotency-Key": "shared-key" }, payload: {} });
      expect((await read(owner.app, "shared-key")).json().attempt.status).toBe("completed");
      expect((await read(other.app, "shared-key")).json()).toEqual({ attempt: { status: "absent" } });
    } finally {
      await owner.app.close();
      await other.app.close();
    }
  });

  it.each([
    ["a read method", "method=GET&route=%2Fapi%2Fv1%2Fexample%2Fattempt"],
    ["a route outside the API", "method=POST&route=%2Fhealthz"],
    ["the realtime events route", "method=POST&route=%2Fapi%2Fv1%2Fgateway%2Fevents"],
    ["a missing route", "method=POST"],
    ["a concrete URL instead of the route pattern", "method=POST&route=%2Fapi%2Fv1%2Fsecrets%2Fproviders%2Fopenai"],
    ["an unregistered route pattern", "method=POST&route=%2Fapi%2Fv1%2Fnot-registered%2F%3Aid"],
    ["a registered pattern under another method", "method=DELETE&route=%2Fapi%2Fv1%2Fsecrets%2Fproviders%2F%3AproviderId"],
  ])("refuses %s rather than answering absent", async (_label, query) => {
    const built = await buildApp((fastify) => {
      fastify.post("/api/v1/secrets/providers/:providerId", async () => ({ ok: true }));
    });
    try {
      const response = await read(built.app, "any-key", query);
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("absent");
    } finally {
      await built.app.close();
    }
  });

  it("answers for the registered route pattern of a parameterised route", async () => {
    const built = await buildApp((fastify) => {
      fastify.post("/api/v1/secrets/providers/:providerId", async () => ({ ok: true }));
    });
    try {
      await built.app.inject({ method: "POST", url: "/api/v1/secrets/providers/openai", headers: { "Idempotency-Key": "pattern-key" }, payload: {} });
      const response = await read(built.app, "pattern-key", "method=POST&route=%2Fapi%2Fv1%2Fsecrets%2Fproviders%2F%3AproviderId");
      expect(response.json().attempt.status).toBe("completed");
    } finally {
      await built.app.close();
    }
  });
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

  it.each([
    ["POST", "/api/v1/secrets/providers/:providerId", "/api/v1/secrets/providers/provider-one", { apiKey: "gc-canary-provider-key", expectedRevision: 3 }],
    ["DELETE", "/api/v1/secrets/providers/:providerId", "/api/v1/secrets/providers/provider-one", { expectedRevision: 3, note: "gc-canary-delete" }],
    ["PATCH", "/api/v1/auth/settings", "/api/v1/auth/settings", { mode: "basic", basicPassword: "gc-canary-basic-password", token: "gc-canary-token", expectedRevision: "r1" }],
  ] as const)("never durably fingerprints the credential body of %s %s", async (method, route, url, payload) => {
    let calls = 0;
    const built = await buildApp((fastify) => {
      fastify.route({ method, url: route, handler: async () => { calls += 1; return { ok: true }; } });
    });
    const claim = vi.spyOn(built.store, "claim");
    try {
      const first = await built.app.inject({ method, url, headers: { "Idempotency-Key": "credential-attempt-1" }, payload });
      const second = await built.app.inject({ method, url, headers: { "Idempotency-Key": "credential-attempt-2" },
        payload: Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === "string" ? `${value}-changed` : value])) });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(calls).toBe(2);
      const [firstHash, secondHash] = claim.mock.calls.map(([input]) => input.payloadHash);
      expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
      expect(secondHash).toBe(firstHash);
      expect(firstHash).not.toBe(createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
      expect(JSON.stringify(claim.mock.calls)).not.toContain("gc-canary");
    } finally {
      await built.app.close();
    }
  });

  it.each([
    ["PATCH", "/api/v1/settings", { llm: { upsertProvider: { providerId: "p", apiKey: "gc-canary-settings-key" } }, auth: { basicPassword: "gc-canary-settings-pass" }, expectedRevision: "r1" }],
    ["POST", "/api/v1/onboarding/bootstrap", { auth: { token: "gc-canary-onboarding-token" }, upsertProvider: { apiKey: "gc-canary-onboarding-key", headers: { Authorization: "gc-canary-header" } } }],
    ["POST", "/api/v1/change-plans/:planId/provider-secret", { apiKey: "gc-canary-plan-key", expectedRevision: 2 }],
    ["POST", "/api/v1/change-plans/:planId/channel-secrets", { values: { botToken: "gc-canary-bot" }, expectedRevision: 2 }],
    ["POST", "/api/v1/workspaces/:workspaceId/hooks", { name: "hook", secret: "gc-canary-webhook-secret" }],
    ["POST", "/api/v1/mesh/join", { token: "gc-canary-join-token", nodeName: "node" }],
  ] as const)("redacts secret-named fields of %s %s before fingerprinting, keeping non-secret drift detection", async (method, route, payload) => {
    const built = await buildApp((fastify) => {
      fastify.route({ method, url: route, handler: async () => ({ ok: true }) });
    });
    const claim = vi.spyOn(built.store, "claim");
    const url = route.replace(":planId", "plan-1").replace(":workspaceId", "ws-1");
    const swapSecrets = (value: unknown): unknown =>
      typeof value === "string" ? (value.startsWith("gc-canary") ? `${value}-other` : value)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swapSecrets(item)])) : value;
    try {
      await built.app.inject({ method, url, headers: { "Idempotency-Key": "secret-field-1" }, payload });
      await built.app.inject({ method, url, headers: { "Idempotency-Key": "secret-field-2" }, payload: swapSecrets(payload) as object });
      await built.app.inject({ method, url, headers: { "Idempotency-Key": "secret-field-3" }, payload: { ...payload, nonSecretMarker: "changed" } });
      const [first, swapped, drifted] = claim.mock.calls.map(([input]) => input.payloadHash);
      expect(swapped).toBe(first);
      expect(drifted).not.toBe(first);
      expect(JSON.stringify(claim.mock.calls)).not.toContain("gc-canary");
    } finally {
      await built.app.close();
    }
  });

  it.each([
    ["more secret-named fields", { pwd: "gc-canary-a", otpCode: 1, pin: "gc-canary-b", signingKey: "gc-canary-c", accessKey: "gc-canary-d", dsn: "gc-canary-e", connectionString: "gc-canary-f", jwt: "gc-canary-g", rootPath: "gc-canary-h", certificate: "gc-canary-i" }],
    ["URL userinfo in a non-secret field", { endpoint: "https://user:gc-canary-userinfo@example.invalid/path" }],
    ["token-shaped values", { note: "sk-gccanary0000000000000000", other: "ghp_gccanary000000000000000000", slack: "xoxb-gccanary-000", aws: "AKIAGCCANARY00000000", jwt2: "eyJhbGciOiJIUzI1NiJ9.gccanary.signature" }],
    ["flag-style secret arguments", { args: ["--token", "gc-canary-arg", "--password=gc-canary-eq", "--verbose"] }],
    ["a deep secret beyond the depth cap", { deep: Array.from({ length: 40 }).reduce<unknown>((inner) => ({ inner }), { note: "gc-canary-deep" }) }],
  ] as const)("never fingerprints %s", async (_label, payload) => {
    const built = await buildApp((fastify) => {
      fastify.post("/api/v1/example/unlisted", async () => ({ ok: true }));
    });
    const claim = vi.spyOn(built.store, "claim");
    try {
      await built.app.inject({ method: "POST", url: "/api/v1/example/unlisted", headers: { "Idempotency-Key": "scrub-1" }, payload });
      const serialized = JSON.stringify(claim.mock.calls);
      expect(serialized).not.toContain("gc-canary");
      expect(serialized).not.toContain("gccanary");
      const swapped = JSON.parse(JSON.stringify(payload).replaceAll("gc-canary", "gc-canary-x").replaceAll("gccanary", "gccanaryx"));
      await built.app.inject({ method: "POST", url: "/api/v1/example/unlisted", headers: { "Idempotency-Key": "scrub-2" }, payload: swapped });
      expect(claim.mock.calls[1]![0].payloadHash).toBe(claim.mock.calls[0]![0].payloadHash);
    } finally {
      await built.app.close();
    }
  });

  it("redacts a flag value that contains a newline", async () => {
    const built = await buildApp((fastify) => {
      fastify.post("/api/v1/example/newline", async () => ({ ok: true }));
    });
    const claim = vi.spyOn(built.store, "claim");
    try {
      await built.app.inject({ method: "POST", url: "/api/v1/example/newline", headers: { "Idempotency-Key": "newline-1" }, payload: { args: ["--token=gc-canary-a\nmore"] } });
      await built.app.inject({ method: "POST", url: "/api/v1/example/newline", headers: { "Idempotency-Key": "newline-2" }, payload: { args: ["--token=gc-canary-b\nother"] } });
      expect(claim.mock.calls[1]![0].payloadHash).toBe(claim.mock.calls[0]![0].payloadHash);
    } finally {
      await built.app.close();
    }
  });

  it("redacts a long inline flag value", async () => {
    const built = await buildApp((fastify) => {
      fastify.post("/api/v1/example/long-flag", async () => ({ ok: true }));
    });
    const claim = vi.spyOn(built.store, "claim");
    try {
      await built.app.inject({ method: "POST", url: "/api/v1/example/long-flag", headers: { "Idempotency-Key": "long-flag-1" }, payload: { args: [`--token=${"a".repeat(400)}`] } });
      await built.app.inject({ method: "POST", url: "/api/v1/example/long-flag", headers: { "Idempotency-Key": "long-flag-2" }, payload: { args: [`--token=${"b".repeat(400)}`] } });
      expect(claim.mock.calls[1]![0].payloadHash).toBe(claim.mock.calls[0]![0].payloadHash);
    } finally {
      await built.app.close();
    }
  });

  it("fingerprints adversarial flag-like strings in linear time", async () => {
    const built = await buildApp((fastify) => {
      fastify.post("/api/v1/example/adversarial", { bodyLimit: 2 * 1024 * 1024 }, async () => ({ ok: true }));
    });
    try {
      const hostile = `--${"key".repeat(60_000)}!`;
      const started = performance.now();
      const response = await built.app.inject({ method: "POST", url: "/api/v1/example/adversarial", headers: { "Idempotency-Key": "adversarial-1" }, payload: { args: [hostile, hostile] } });
      expect(response.statusCode).toBe(200);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await built.app.close();
    }
  });

  it("does not fingerprint a primitive JSON body", async () => {
    const built = await buildApp((fastify) => {
      fastify.post("/api/v1/example/primitive", async () => ({ ok: true }));
    });
    const claim = vi.spyOn(built.store, "claim");
    try {
      await built.app.inject({ method: "POST", url: "/api/v1/example/primitive", headers: { "Idempotency-Key": "primitive-1", "content-type": "application/json" }, payload: JSON.stringify("gc-canary-primitive") });
      await built.app.inject({ method: "POST", url: "/api/v1/example/primitive", headers: { "Idempotency-Key": "primitive-2", "content-type": "application/json" }, payload: JSON.stringify("gc-canary-primitive-other") });
      expect(claim.mock.calls[1]![0].payloadHash).toBe(claim.mock.calls[0]![0].payloadHash);
    } finally {
      await built.app.close();
    }
  });

  it.each(["POST", "DELETE"] as const)("never fingerprints a Vault %s body and blocks completed duplicates", async (method) => {
    let calls = 0;
    const route = method === "POST" ? "/api/v1/citadels/:citadelId/vault-secrets" : "/api/v1/citadels/:citadelId/vault-secrets/:secretId";
    const built = await buildApp((fastify) => {
      fastify.route({ method, url: route, handler: async () => { calls += 1; return { items: [] }; } });
    });
    const claim = vi.spyOn(built.store, "claim");
    const url = route.replace(":citadelId", "vault-one").replace(":secretId", "secret-one");
    try {
      for (const [index, key] of ["vault-attempt-1", "vault-attempt-2", "vault-attempt-1"].entries()) {
        const response = await built.app.inject({ method, url, headers: { "Idempotency-Key": key },
          payload: { name: `synthetic-name-${index}`, value: `synthetic-value-${index}`, extra: `synthetic-extra-${index}`, expectedRevision: String(index).repeat(64) } });
        expect(response.statusCode).toBe(index === 2 ? 409 : 200);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(calls).toBe(2);
      expect(new Set(claim.mock.calls.map(([input]) => input.payloadHash)).size).toBe(1);
      await built.app.inject({ method, url: url.replace("vault-one", "vault-two"), headers: { "Idempotency-Key": "vault-attempt-3" }, payload: {} });
      expect(claim.mock.calls[3]![0].payloadHash).not.toBe(claim.mock.calls[0]![0].payloadHash);
      expect(JSON.stringify(claim.mock.calls)).not.toMatch(/synthetic-name|synthetic-value|synthetic-extra/);
    } finally { await built.app.close(); }
  });

  it("disables caching of explicitly revealed Vault values", async () => {
    const built = await buildApp((fastify) => {
      fastify.get("/api/v1/citadels/:citadelId/vault-secrets/:secretId/reveal", async () => ({ value: "synthetic-reveal" }));
    });
    try {
      const response = await built.app.inject({ method: "GET", url: "/api/v1/citadels/one/vault-secrets/one/reveal" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.pragma).toBe("no-cache");
    } finally { await built.app.close(); }
  });

  it.each(["POST", "PATCH", "DELETE"] as const)("never fingerprints integration %s bodies and blocks completed duplicates", async (method) => {
    let calls = 0;
    const route = method === "POST" ? "/api/v1/integrations/connections" : "/api/v1/integrations/connections/:connectionId";
    const built = await buildApp(fastify => { fastify.route({ method, url: route, handler: async () => { calls += 1; return { ok: true }; } }); });
    const claim = vi.spyOn(built.store, "claim");
    const url = route.replace(":connectionId", "one");
    try {
      for (const [index, key] of ["integration-attempt-1", "integration-attempt-2", "integration-attempt-1"].entries()) {
        const response = await built.app.inject({ method, url: `${url}?extra=synthetic-query-${index}`, headers: { "Idempotency-Key": key },
          payload: { config: { apiKey: `synthetic-value-${index}` }, extra: `synthetic-extra-${index}`, expectedRevision: String(index).repeat(64) } });
        expect(response.statusCode).toBe(index === 2 ? 409 : 200);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(calls).toBe(2);
      expect(new Set(claim.mock.calls.map(([input]) => input.payloadHash)).size).toBe(1);
      if (method !== "POST") {
        await built.app.inject({ method, url: url.replace("/one", "/two"), headers: { "Idempotency-Key": "integration-attempt-3" }, payload: {} });
        expect(claim.mock.calls[3]![0].payloadHash).not.toBe(claim.mock.calls[0]![0].payloadHash);
      }
      expect(JSON.stringify(claim.mock.calls)).not.toMatch(/synthetic-value|synthetic-extra|synthetic-query/);
    } finally { await built.app.close(); }
  });

  it.each(["/api/v1/channels/drafts/:draftId/secure-fields", "/api/v1/channels/drafts/:draftId/connection-review"])("keeps channel credential bodies out of durable retry identity at %s", async route => {
    let calls = 0;
    const built = await buildApp(fastify => { fastify.post(route, async () => { calls += 1; return { ok: true }; }); });
    const claim = vi.spyOn(built.store, "claim");
    try {
      for (const [index, key] of ["channel-attempt-1", "channel-attempt-2", "channel-attempt-1"].entries()) {
        const response = await built.app.inject({ method: "POST", url: `${route.replace(":draftId", "one")}?extra=synthetic-query-${index}`, headers: { "Idempotency-Key": key }, payload: { values: { botToken: `synthetic-token-${index}` }, expectedRevision: index + 1, extra: `synthetic-extra-${index}` } });
        expect(response.statusCode).toBe(index === 2 ? 409 : 200);
      }
      expect(calls).toBe(2);
      expect(new Set(claim.mock.calls.map(([input]) => input.payloadHash)).size).toBe(1);
      await built.app.inject({ method: "POST", url: route.replace(":draftId", "two"), headers: { "Idempotency-Key": "channel-attempt-3" }, payload: {} });
      expect(claim.mock.calls[3]![0].payloadHash).not.toBe(claim.mock.calls[0]![0].payloadHash);
      expect(JSON.stringify(claim.mock.calls)).not.toMatch(/synthetic-token|synthetic-extra|synthetic-query/);
    } finally { await built.app.close(); }
  });

  it.each(["/api/v1/mcp/servers/:serverId", "/api/v1/mcp/servers/:serverId/policy", "/api/v1/mcp/servers/:serverId/oauth/complete", "/api/v1/mcp/servers/:serverId/oauth/start-reviewed", "/api/v1/mcp/servers/:serverId/oauth/complete-reviewed"])("keeps MCP bodies out of retained retry fingerprints at %s", async route => {
    const built = await buildApp(fastify => { fastify.post(route, async () => ({ ok: true })); });
    const claim = vi.spyOn(built.store, "claim");
    try {
      for (const [index, key] of ["mcp-attempt-1", "mcp-attempt-2", "mcp-attempt-1"].entries()) {
        const response = await built.app.inject({ method: "POST", url: `${route.replace(":serverId", "one")}?extra=synthetic-query-${index}`, headers: { "Idempotency-Key": key }, payload: { args: ["--password", `synthetic-credential-${index}`], code: `synthetic-code-${index}`, expectedRevision: String(index).repeat(64) } });
        expect(response.statusCode).toBe(index === 2 ? 409 : 200);
      }
      expect(new Set(claim.mock.calls.map(([input]) => input.payloadHash)).size).toBe(1);
      await built.app.inject({ method: "POST", url: route.replace(":serverId", "two"), headers: { "Idempotency-Key": "mcp-attempt-3" }, payload: {} });
      expect(claim.mock.calls[3]![0].payloadHash).not.toBe(claim.mock.calls[0]![0].payloadHash);
      expect(JSON.stringify(claim.mock.calls)).not.toMatch(/synthetic-credential|synthetic-code|synthetic-query/);
    } finally { await built.app.close(); }
  });

  it("binds mobile push retries to a secret-free provider tuple", async () => {
    const built = await buildApp((fastify) => {
      fastify.put("/api/v1/mobile/current-device/push", async () => ({ ok: true }));
    });
    const claim = vi.spyOn(built.store, "claim");
    const url = "/api/v1/mobile/current-device/push";

    try {
      const requests = [
        {
          key: "idem-mobile-push-1",
          payload: {
            provider: "expo",
            enabled: true,
            token: "ExpoPushToken[gc-canary-push-one]",
            maliciousExtraSecret: "gc-canary-extra-one",
          },
        },
        {
          key: "idem-mobile-push-2",
          payload: {
            provider: "expo",
            enabled: true,
            token: "ExpoPushToken[gc-canary-push-two]",
            maliciousExtraSecret: "gc-canary-extra-two",
          },
        },
        {
          key: "idem-mobile-push-3",
          payload: { provider: "fcm", enabled: true, token: "gc-canary-push-three" },
        },
        {
          key: "idem-mobile-push-4",
          payload: { provider: "expo", enabled: false, maliciousExtraSecret: "gc-canary-extra-four" },
        },
      ];
      for (const input of requests) {
        const response = await built.app.inject({
          method: "PUT",
          url,
          headers: { "Idempotency-Key": input.key },
          payload: input.payload,
        });
        expect(response.statusCode).toBe(200);
      }

      const hashes = claim.mock.calls.map(([input]) => input.payloadHash);
      expect(hashes).toHaveLength(4);
      expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(hashes[1]).toBe(hashes[0]);
      expect(hashes[2]).not.toBe(hashes[0]);
      expect(hashes[3]).not.toBe(hashes[0]);
      expect(JSON.stringify(claim.mock.calls)).not.toContain("gc-canary");
    } finally {
      await built.app.close();
    }
  });

  it("marks every mobile push registration response boundary no-store", async () => {
    const app = Fastify();
    const store = new FakeMutationIdempotencyStore();
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers["x-test-auth-reject"] === "true") {
        return reply.code(401).send({ error: "Unauthorized" });
      }
    });
    await app.register(idempotencyHeaderPlugin, { mutationStore: store });
    app.put("/api/v1/mobile/current-device/push", async (request) => {
      if ((request.body as { fail?: boolean } | undefined)?.fail) {
        throw new Error("synthetic route failure");
      }
      return { ok: true };
    });
    app.put("/api/v1/mobile/current-device/push-adjacent", async () => ({ ok: true }));

    try {
      const responses = [
        await app.inject({
          method: "PUT",
          url: "/api/v1/mobile/current-device/push",
          headers: { "x-test-auth-reject": "true" },
          payload: { provider: "expo", enabled: true, token: "auth-rejected-token" },
        }),
        await app.inject({
          method: "PUT",
          url: "/api/v1/mobile/current-device/push",
          headers: { "content-type": "application/json", "Idempotency-Key": "idem-mobile-parser" },
          payload: "{definitely-not-json",
        }),
        await app.inject({
          method: "PUT",
          url: "/api/v1/mobile/current-device/push",
          headers: { "Idempotency-Key": "idem-mobile-error" },
          payload: { provider: "expo", enabled: true, token: "handler-error-token", fail: true },
        }),
        await app.inject({
          method: "PUT",
          url: "/api/v1/mobile/current-device/push",
          headers: { "Idempotency-Key": "idem-mobile-success" },
          payload: { provider: "expo", enabled: true, token: "successful-token" },
        }),
      ];

      expect(responses.map((response) => response.statusCode)).toEqual([401, 400, 500, 200]);
      for (const response of responses) {
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers.pragma).toBe("no-cache");
      }

      const adjacent = await app.inject({
        method: "PUT",
        url: "/api/v1/mobile/current-device/push-adjacent",
        headers: { "Idempotency-Key": "idem-mobile-adjacent" },
        payload: { ok: true },
      });
      expect(adjacent.statusCode).toBe(200);
      expect(adjacent.headers["cache-control"]).toBeUndefined();
      expect(adjacent.headers.pragma).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("defers remote-worker bootstrap replay and drift to its one-time-secret canonical owner", async () => {
    let handlerCalls = 0;
    const built = await buildApp((fastify) => {
      let canonicalPayload: string | undefined;
      fastify.post("/api/v1/ops/workspaces/:workspaceId/remote-workers/bootstrap", async (request, reply) => {
        handlerCalls += 1;
        const payload = JSON.stringify((request as { body: unknown }).body);
        canonicalPayload ??= payload;
        if (payload !== canonicalPayload) {
          return reply.code(409).send({ error: "canonical bootstrap request drift" });
        }
        await markMutationCommitted(request);
        return handlerCalls === 1
          ? { disposition: "created", bootstrapSecret: "one-time-secret" }
          : { disposition: "replayed_without_secret" };
      });
    });
    const claim = vi.spyOn(built.store, "claim");
    const markCompleted = vi.spyOn(built.store, "markCompleted");

    try {
      const headers = { "Idempotency-Key": "idem-worker-bootstrap-1" };
      const payload = { workerLabel: "Windows workstation", runtimeManifest: { payloadSha256: "a".repeat(64) } };
      const first = await built.app.inject({
        method: "POST",
        url: "/api/v1/ops/workspaces/workspace-a/remote-workers/bootstrap",
        headers,
        payload,
      });
      const replay = await built.app.inject({
        method: "POST",
        url: "/api/v1/ops/workspaces/workspace-a/remote-workers/bootstrap",
        headers,
        payload,
      });
      const mismatch = await built.app.inject({
        method: "POST",
        url: "/api/v1/ops/workspaces/workspace-a/remote-workers/bootstrap",
        headers,
        payload: { ...payload, workerLabel: "Different workstation" },
      });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toHaveProperty("bootstrapSecret", "one-time-secret");
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ disposition: "replayed_without_secret" });
      expect(mismatch.statusCode).toBe(409);
      expect(handlerCalls).toBe(3);
      expect(claim).not.toHaveBeenCalled();
      expect(markCompleted).not.toHaveBeenCalled();
    } finally {
      await built.app.close();
    }
  });

  it("defers mesh join secret replay and drift to its canonical storage owner", async () => {
    let handlerCalls = 0;
    const built = await buildApp((fastify) => {
      let canonicalPayload: string | undefined;
      fastify.post(
        "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/generations/:workerGeneration/mesh-node-join-authorities",
        async (request, reply) => {
          handlerCalls += 1;
          const payload = JSON.stringify((request as { body: unknown }).body);
          canonicalPayload ??= payload;
          if (payload !== canonicalPayload) return reply.code(409).send({ error: "canonical join request drift" });
          await markMutationCommitted(request);
          return handlerCalls === 1
            ? { disposition: "created", meshNodeCredential: "one-time-mesh-secret" }
            : { disposition: "replayed_without_secret", secretDisposition: "not_recoverable" };
        },
      );
    });
    const claim = vi.spyOn(built.store, "claim");
    const markCompleted = vi.spyOn(built.store, "markCompleted");

    try {
      const headers = { "Idempotency-Key": "idem-mesh-join-1" };
      const url = "/api/v1/ops/workspaces/registry-a/remote-workers/worker-a/generations/2/mesh-node-join-authorities";
      const payload = { targetWorkspaceId: "workspace-a", expiresInSeconds: 300 };
      const first = await built.app.inject({ method: "POST", url, headers, payload });
      const replay = await built.app.inject({ method: "POST", url, headers, payload });
      const mismatch = await built.app.inject({
        method: "POST",
        url,
        headers,
        payload: { ...payload, expiresInSeconds: 301 },
      });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toHaveProperty("meshNodeCredential", "one-time-mesh-secret");
      expect(replay.json()).toEqual({ disposition: "replayed_without_secret", secretDisposition: "not_recoverable" });
      expect(mismatch.statusCode).toBe(409);
      expect(handlerCalls).toBe(3);
      expect(claim).not.toHaveBeenCalled();
      expect(markCompleted).not.toHaveBeenCalled();
    } finally {
      await built.app.close();
    }
  });

  it("never fingerprints a remote-worker control reason before secret validation", async () => {
    let handlerCalls = 0;
    const built = await buildApp((fastify) => {
      fastify.post(
        "/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId/generations/:workerGeneration/quarantine",
        async (request, reply) => {
          handlerCalls += 1;
          if (handlerCalls === 1) return reply.code(400).send({ error: "invalid reason" });
          await markMutationCommitted(request);
          return { ok: true };
        },
      );
    });
    const claim = vi.spyOn(built.store, "claim");
    const url = "/api/v1/ops/workspaces/workspace-a/remote-workers/worker-a/generations/1/quarantine";
    const headers = { "Idempotency-Key": "idem-worker-control-1" };
    const secret = "Authorization: Bearer ghp_SUPER_SECRET_TOKEN_1234567890";

    try {
      const rejected = await built.app.inject({
        method: "POST",
        url,
        headers,
        payload: { reasonCode: "operator.quarantine", reason: secret },
      });
      const corrected = await built.app.inject({
        method: "POST",
        url,
        headers,
        payload: { reasonCode: "operator.quarantine", reason: "Worker missed its integrity checkpoint." },
      });

      expect(rejected.statusCode).toBe(400);
      expect(corrected.statusCode).toBe(200);
      expect(handlerCalls).toBe(2);
      expect(claim).toHaveBeenCalledTimes(2);
      expect(claim.mock.calls[0]?.[0].payloadHash).toBe(claim.mock.calls[1]?.[0].payloadHash);
      expect(claim.mock.calls[0]?.[0].payloadHash).not.toBe(
        createHash("sha256")
          .update(JSON.stringify({ reasonCode: "operator.quarantine", reason: secret }))
          .digest("hex"),
      );
      expect(JSON.stringify(claim.mock.calls)).not.toContain(secret);
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
