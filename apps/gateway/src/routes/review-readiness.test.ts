import { describe, expect, it, vi } from "vitest";
import { reviewReadinessRoutes } from "./review-readiness.js";

describe("review readiness routes", () => {
  it("awaits the readiness summary before sending it", async () => {
    const summary = {
      generatedAt: "2026-08-05T00:00:00.000Z",
      branch: "main",
      sha: "a".repeat(40),
      ready: true,
    };
    const get = vi.fn();
    const post = vi.fn();
    const getReadiness = vi.fn(async () => summary);
    const fastify = {
      get,
      post,
      requireOperatorAuth: vi.fn(),
      gatewayRuntime: {
        reviewReadinessService: {
          getReadiness,
        },
      },
    };

    await reviewReadinessRoutes(fastify as never, {});

    const registration = get.mock.calls.find(([url]) => url === "/api/v1/review/readiness");
    const send = vi.fn((payload) => payload);
    await expect(registration?.[2]({ log: {} }, { send })).resolves.toEqual(summary);
    expect(getReadiness).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(summary);
  });

  it("keeps the build identity endpoint operator-scoped and server-authored", async () => {
    const identity = {
      schemaVersion: 1,
      kind: "source",
      version: "1.0.0",
      buildSha: "a".repeat(40),
      shortSha: "a".repeat(8),
      integrity: "clean",
      identitySource: "git_checkout",
      release: {
        verified: false,
        certificateState: "absent",
        requiredProof: { total: 0, passed: 0, missing: 0, failed: 0, stale: 0 },
        acceptedFailureCount: 0,
        acceptedFailures: [],
        reasonCodes: ["certificate_absent"],
        reasons: ["No release certificate is available to the running Gateway."],
      },
    };
    const get = vi.fn();
    const post = vi.fn();
    const requireOperatorAuth = vi.fn();
    const fastify = {
      get,
      post,
      requireOperatorAuth,
      gatewayRuntime: {
        reviewReadinessService: {
          getRuntimeIdentity: vi.fn(() => identity),
          getReadiness: vi.fn(),
          refreshRuntimeReleaseTrust: vi.fn(),
          importFindings: vi.fn(),
        },
      },
    };

    await reviewReadinessRoutes(fastify as never, {});

    const registration = get.mock.calls.find(([url]) => url === "/api/v1/review/identity");
    expect(registration).toBeDefined();
    expect(registration?.[1]).toMatchObject({
      config: { goatcitadelRouteAccessClass: "operator" },
    });
    expect(registration?.[1]).toHaveProperty("preHandler");

    const preHandler = registration?.[1].preHandler as
      | ((request: unknown, reply: unknown) => Promise<unknown>)
      | undefined;
    await preHandler?.({ authActorSource: "none" }, { code: vi.fn(), send: vi.fn() });
    expect(requireOperatorAuth).toHaveBeenCalledOnce();

    const send = vi.fn((payload) => payload);
    const result = await registration?.[2](
      {
        log: {},
        headers: {
          "x-goatcitadel-build-sha": "b".repeat(40),
          "x-goatcitadel-release-verified": "true",
        },
        query: { releaseVerified: "true" },
        body: { runtimeIdentity: { release: { verified: true } } },
      },
      { send },
    );
    expect(result).toEqual(identity);
    expect(send).toHaveBeenCalledWith(identity);
    expect(fastify.gatewayRuntime.reviewReadinessService.getRuntimeIdentity).toHaveBeenCalledWith();
  });

  it("keeps forced runtime-release verification operator-scoped and server-authored", async () => {
    const summary = { generatedAt: "2026-07-14T20:00:00.000Z", runtimeIdentity: { kind: "packaged" } };
    const get = vi.fn();
    const post = vi.fn();
    const requireOperatorAuth = vi.fn();
    const refreshRuntimeReleaseTrust = vi.fn(async () => summary);
    const fastify = {
      get,
      post,
      requireOperatorAuth,
      gatewayRuntime: {
        reviewReadinessService: {
          getRuntimeIdentity: vi.fn(),
          getReadiness: vi.fn(),
          refreshRuntimeReleaseTrust,
          importFindings: vi.fn(),
        },
      },
    };

    await reviewReadinessRoutes(fastify as never, {});

    const registration = post.mock.calls.find(([url]) => url === "/api/v1/review/readiness/runtime-release/refresh");
    expect(registration?.[1]).toMatchObject({
      config: { goatcitadelRouteAccessClass: "operator" },
    });
    expect(registration?.[1]).toHaveProperty("preHandler");

    const preHandler = registration?.[1].preHandler as
      | ((request: unknown, reply: unknown) => Promise<unknown>)
      | undefined;
    await preHandler?.({ authActorSource: "none" }, { code: vi.fn(), send: vi.fn() });
    expect(requireOperatorAuth).toHaveBeenCalledOnce();

    const send = vi.fn((payload) => payload);
    await expect(
      registration?.[2]({ log: {}, body: { force: false, releaseVerified: true } }, { send }),
    ).resolves.toEqual(summary);
    expect(refreshRuntimeReleaseTrust).toHaveBeenCalledWith();
    expect(send).toHaveBeenCalledWith(summary);
  });
});
