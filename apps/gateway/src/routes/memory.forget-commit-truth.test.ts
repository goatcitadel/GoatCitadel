import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { memoryRoutes } from "./memory.js";

type MutationStatus = "pending" | "completed" | "failed";

interface MutationKey {
  method: string;
  routePath: string;
  idempotencyKey: string;
  actorScope?: string;
}

class FakeMutationIdempotencyStore {
  private readonly rows = new Map<string, { payloadHash: string; status: MutationStatus }>();

  public claim(input: MutationKey & { payloadHash: string }) {
    const key = this.toKey(input);
    const existing = this.rows.get(key);
    if (!existing || existing.status === "failed") {
      this.rows.set(key, { payloadHash: input.payloadHash, status: "pending" });
      return { outcome: "claimed" as const, record: { status: "pending" as const } };
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

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("memory bulk-forget route commit truth", () => {
  it("keeps the HTTP claim completed when response delivery fails after the canonical commit", async () => {
    const forget = vi.fn(
      (
        _input: unknown,
        lifecycle?: {
          onCommit?: () => void;
          afterCommit?: () => void;
        },
      ) => {
        lifecycle?.onCommit?.();
        lifecycle?.afterCommit?.();
        return {
          actionId: "forget-commit-truth",
          matchedCount: 1,
          alreadyForgottenCount: 0,
          forgottenCount: 1,
          itemIds: ["memory-1"],
          items: [],
        };
      },
    );
    const app = await buildApp({ forget }, true, "/api/v1/memory/forget");
    const request = {
      method: "POST" as const,
      url: "/api/v1/memory/forget",
      headers: { "idempotency-key": "memory-forget-commit-truth" },
      payload: {
        itemIds: ["memory-1"],
        workspaceId: "workspace-a",
        actionId: "forget-commit-truth",
        source: "route-proof",
      },
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(500);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: expect.stringMatching(/duplicate/i) });
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it("releases the HTTP claim when the service fails before its canonical commit", async () => {
    let attempt = 0;
    const forget = vi.fn(
      (
        _input: unknown,
        lifecycle?: {
          onCommit?: () => void;
          afterCommit?: () => void;
        },
      ) => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("canonical memory transaction failed");
        }
        lifecycle?.onCommit?.();
        lifecycle?.afterCommit?.();
        return {
          actionId: "forget-precommit-retry",
          matchedCount: 1,
          alreadyForgottenCount: 0,
          forgottenCount: 1,
          itemIds: ["memory-1"],
          items: [],
        };
      },
    );
    const app = await buildApp({ forget }, false, "/api/v1/memory/forget");
    const request = {
      method: "POST" as const,
      url: "/api/v1/memory/forget",
      headers: { "idempotency-key": "memory-forget-precommit-retry" },
      payload: {
        itemIds: ["memory-1"],
        workspaceId: "workspace-a",
        actionId: "forget-precommit-retry",
        source: "route-proof",
      },
    };

    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(500);
    expect(retry.statusCode).toBe(200);
    expect(forget).toHaveBeenCalledTimes(2);
  });

  it("keeps the single-item HTTP claim completed when response delivery fails after commit", async () => {
    const forgetItem = vi.fn(
      (
        _itemId: string,
        _actorId: string,
        lifecycle?: {
          onCommit?: () => void;
          afterCommit?: () => void;
        },
      ) => {
        lifecycle?.onCommit?.();
        lifecycle?.afterCommit?.();
        return { itemId: "memory-1", status: "forgotten" };
      },
    );
    const routePath = "/api/v1/memory/items/:itemId/forget";
    const app = await buildApp({ forgetItem }, true, routePath);
    const request = {
      method: "POST" as const,
      url: "/api/v1/memory/items/memory-1/forget",
      headers: { "idempotency-key": "memory-single-forget-commit-truth" },
      payload: {},
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(500);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: expect.stringMatching(/duplicate/i) });
    expect(forgetItem).toHaveBeenCalledTimes(1);
  });
});

async function buildApp(
  memory: Record<string, unknown>,
  failFirstSuccessfulResponse: boolean,
  failingRoutePath: string,
) {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authActorId", "");
  app.decorateRequest("authActorSource", "loopback");
  app.addHook("onRequest", async (request) => {
    request.authActorId = "operator-test";
    request.authActorSource = "loopback";
  });
  app.decorate("requireOperatorAuth", async () => undefined);
  app.decorate("gatewayConfig", {
    assistant: {
      auth: {
        mode: "none",
      },
    },
  } as never);
  app.decorate("services", { memory } as never);
  await app.register(idempotencyHeaderPlugin, {
    mutationStore: new FakeMutationIdempotencyStore() as never,
  });

  let responseDeliveryFailed = false;
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      failFirstSuccessfulResponse &&
      !responseDeliveryFailed &&
      request.routeOptions.url === failingRoutePath &&
      reply.statusCode < 400
    ) {
      responseDeliveryFailed = true;
      reply.code(500);
      return JSON.stringify({ error: "response delivery unavailable" });
    }
    return payload;
  });
  await app.register(memoryRoutes);
  return app;
}
