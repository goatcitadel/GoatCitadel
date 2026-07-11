import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { toolsRoutes } from "./tools.js";

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

describe("tool grant route commit truth", () => {
  it("does not recreate a grant when response projection fails after commit", async () => {
    const createToolGrant = vi.fn((input) => ({
      grantId: "a7bb54a8-b436-42e4-82f2-044b770be239",
      grantType: "persistent",
      status: "active",
      createdAt: "2026-07-10T00:00:00.000Z",
      ...input,
    }));
    const app = await buildApp(
      {
        createToolGrant,
        revokeToolGrant: vi.fn(),
      },
      "/api/v1/tools/grants",
    );
    const request = {
      method: "POST" as const,
      url: "/api/v1/tools/grants",
      headers: { "idempotency-key": "tool-grant-create-commit-truth" },
      payload: { toolPattern: "browser.*", decision: "allow", scope: "global" },
    };

    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(500);
    expect(retry.statusCode).toBe(409);
    expect(createToolGrant).toHaveBeenCalledTimes(1);
  });

  it("does not revoke a grant twice when response projection fails after commit", async () => {
    const revokeToolGrant = vi.fn(() => true);
    const app = await buildApp(
      {
        createToolGrant: vi.fn(),
        revokeToolGrant,
      },
      "/api/v1/tools/grants/:grantId/revoke",
    );
    const request = {
      method: "POST" as const,
      url: "/api/v1/tools/grants/a7bb54a8-b436-42e4-82f2-044b770be239/revoke",
      headers: { "idempotency-key": "tool-grant-revoke-commit-truth" },
    };

    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(500);
    expect(retry.statusCode).toBe(409);
    expect(revokeToolGrant).toHaveBeenCalledTimes(1);
  });

  it("preserves idempotency claims for every committed permission and local-override mutation", async () => {
    const ownedProfile = {
      profileId: "profile-owned",
      builtin: false,
      scope: "operator",
      scopeRef: "operator-test",
      createdBy: "operator-test",
    };
    const activeOverride = {
      overrideId: "override-owned",
      operatorId: "operator-test",
      status: "active",
    };
    const scenarios = [
      {
        label: "permission profile create",
        route: "/api/v1/tools/permission-profiles",
        method: "POST" as const,
        payload: { label: "Review", approvalMode: "approve_all" },
        mutation: vi.fn(() => ({ ...ownedProfile, profileId: "profile-created" })),
        tools: {} as Record<string, unknown>,
        mutationName: "createPermissionProfile",
      },
      {
        label: "permission profile update",
        route: "/api/v1/tools/permission-profiles/profile-owned",
        method: "PATCH" as const,
        payload: { description: "updated" },
        mutation: vi.fn(() => ({ ...ownedProfile, description: "updated" })),
        tools: { listPermissionProfiles: vi.fn(() => [ownedProfile]) } as Record<string, unknown>,
        mutationName: "updatePermissionProfile",
      },
      {
        label: "permission profile archive",
        route: "/api/v1/tools/permission-profiles/profile-owned/archive",
        method: "POST" as const,
        mutation: vi.fn(() => true),
        tools: { listPermissionProfiles: vi.fn(() => [ownedProfile]) } as Record<string, unknown>,
        mutationName: "archivePermissionProfile",
      },
      {
        label: "permission profile activation",
        route: "/api/v1/tools/permission-profiles/activate",
        method: "POST" as const,
        payload: { profileId: "profile-owned", surface: "chat" },
        mutation: vi.fn(() => ({ activationId: "activation-1" })),
        tools: { listPermissionProfiles: vi.fn(() => [ownedProfile]) } as Record<string, unknown>,
        mutationName: "activatePermissionProfile",
      },
      {
        label: "local operator override create",
        route: "/api/v1/tools/local-operator-overrides",
        method: "POST" as const,
        payload: { scope: "operator", reason: "local review", ttlSeconds: 300 },
        mutation: vi.fn(() => ({ ...activeOverride, overrideId: "override-created" })),
        tools: {} as Record<string, unknown>,
        mutationName: "createLocalOperatorOverride",
      },
      {
        label: "local operator override revoke",
        route: "/api/v1/tools/local-operator-overrides/override-owned/revoke",
        method: "POST" as const,
        mutation: vi.fn(() => ({ ...activeOverride, status: "revoked", revokedAt: "2026-07-10T00:00:00.000Z" })),
        tools: { listActiveLocalOperatorOverrides: vi.fn(() => [activeOverride]) } as Record<string, unknown>,
        mutationName: "revokeLocalOperatorOverride",
      },
    ];

    for (const scenario of scenarios) {
      const app = await buildApp({ ...scenario.tools, [scenario.mutationName]: scenario.mutation }, scenario.route);
      const request = {
        method: scenario.method,
        url: scenario.route,
        headers: { "idempotency-key": `commit-truth-${scenario.mutationName}` },
        ...(scenario.payload ? { payload: scenario.payload } : {}),
      };

      const first = await app.inject(request);
      const retry = await app.inject(request);

      expect(first.statusCode, scenario.label).toBe(500);
      expect(retry.statusCode, scenario.label).toBe(409);
      expect(scenario.mutation, scenario.label).toHaveBeenCalledTimes(1);

      const postCommitMutation = vi.fn(() => {
        throw Object.assign(new Error(`${scenario.label} projection unavailable`), { mutationCommitted: true });
      });
      const postCommitApp = await buildApp(
        { ...scenario.tools, [scenario.mutationName]: postCommitMutation },
        scenario.route,
      );
      const postCommitRequest = {
        ...request,
        headers: { "idempotency-key": `post-commit-truth-${scenario.mutationName}` },
      };
      const postCommitFailure = await postCommitApp.inject(postCommitRequest);
      const postCommitRetry = await postCommitApp.inject(postCommitRequest);

      expect(postCommitFailure.statusCode, scenario.label).toBe(500);
      expect(postCommitRetry.statusCode, scenario.label).toBe(409);
      expect(postCommitMutation, scenario.label).toHaveBeenCalledTimes(1);
    }
  });
});

async function buildApp(tools: Record<string, unknown>, responseFailureRoute: string): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authActorId", "");
  app.decorateRequest("authActorSource", "loopback");
  app.addHook("onRequest", async (request) => {
    request.authActorId = "operator-test";
    request.authActorSource = "loopback";
  });
  app.decorate("requireOperatorAuth", async () => undefined);
  app.decorate("services", { tools } as never);
  await app.register(idempotencyHeaderPlugin, {
    mutationStore: new FakeMutationIdempotencyStore() as never,
  });

  let responseProjectionFailed = false;
  app.addHook("onSend", async (request, reply, payload) => {
    const requestPath = request.url.split("?", 1)[0];
    if (
      !responseProjectionFailed &&
      (request.routeOptions.url === responseFailureRoute || requestPath === responseFailureRoute) &&
      reply.statusCode < 400
    ) {
      responseProjectionFailed = true;
      reply.code(500);
      return JSON.stringify({ error: "response projection unavailable" });
    }
    return payload;
  });
  await app.register(toolsRoutes);
  return app;
}
