import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  canonicalJsonString,
  mcpRequesterResolutionBindingHashMaterial,
  mcpRequesterScopeHashMaterial,
  type McpRequesterResolutionBinding,
} from "@goatcitadel/contracts";
import {
  McpRequesterResolverRegistry,
  createMcpEphemeralResolvedConnectionCandidate,
  createMcpRequesterAuthority,
  mcpRequesterMeshActivationHash,
  mcpRequesterScopedServerConfigHash,
  mcpRequesterTransportPolicyHash,
  type McpEphemeralResolvedConnectionInput,
  type McpRequesterConnectionResolverInput,
  type McpRequesterResolutionCurrentState,
  type McpRequesterScopedServerSnapshot,
} from "./mcp-requester-resolution.js";
import {
  McpRequesterResolutionService,
  type McpRequesterResolutionServiceInput,
} from "./mcp-requester-resolution-service.js";

const START = Date.parse("2026-07-14T12:00:00.000Z");

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}

interface Fixture {
  input: McpRequesterResolutionServiceInput;
  current: McpRequesterResolutionCurrentState;
  allowedConnectionGeneration: { value: number };
}

function buildFixture(actorId = "operator-a", revocationSignal?: AbortSignal): Fixture {
  const server: McpRequesterScopedServerSnapshot = {
    serverId: "tenant-mcp",
    transport: "http",
    connectionMode: "requester_scoped",
    configurationRevision: 7,
    requesterResolution: {
      resolverId: "gateway.tenant",
      resolverVersion: "1.2.3",
      configGeneration: 4,
      transportPolicy: {
        allowedSchemes: ["https"],
        allowedHosts: ["a.example.test", "b.example.test", "mcp.example.test"],
        allowedPorts: [443],
        allowedHeaderNames: ["authorization", "x-tenant"],
      },
    },
  };
  const profile = {
    profileId: `profile-${actorId}`,
    profileSha256: digest({ profile: actorId }),
    callableCatalogSnapshotId: "snapshot-1",
    callableCatalogSha256: digest({ tools: ["mcp.tenant-mcp.search"] }),
    canonicalToolName: "mcp.tenant-mcp.search",
  };
  const requesterScopeSha256 = digest(
    mcpRequesterScopeHashMaterial({
      profileId: profile.profileId,
      turnId: `turn-${actorId}`,
      sessionId: `session-${actorId}`,
      workspaceId: "workspace-1",
      authActorId: actorId,
      authActorSource: "token",
    }),
  );
  const requester = createMcpRequesterAuthority({
    actorId,
    actorSource: "token",
    workspaceId: "workspace-1",
    sessionId: `session-${actorId}`,
    turnId: `turn-${actorId}`,
    capabilityProfileId: profile.profileId,
    capabilityProfileSha256: profile.profileSha256,
    requesterScopeSha256,
    invocationAttemptId: `attempt-${actorId}`,
    attemptGeneration: 3,
    authConnectionGeneration: 2,
  });
  const bindingMaterial = {
    schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
    mode: "requester_scoped" as const,
    serverId: server.serverId,
    toolName: profile.canonicalToolName,
    resolverId: server.requesterResolution.resolverId,
    resolverVersion: server.requesterResolution.resolverVersion,
    resolverConfigGeneration: server.requesterResolution.configGeneration,
    requesterScopeSha256,
    serverConfigRevision: server.configurationRevision,
    serverConfigSha256: mcpRequesterScopedServerConfigHash(server),
    transportPolicySha256: mcpRequesterTransportPolicyHash(server.requesterResolution.transportPolicy),
    callableCatalogSnapshotId: profile.callableCatalogSnapshotId,
    callableCatalogSha256: profile.callableCatalogSha256,
  };
  const binding: McpRequesterResolutionBinding = {
    ...bindingMaterial,
    bindingSha256: digest(bindingMaterial),
  };
  const current: McpRequesterResolutionCurrentState = {
    revoked: false,
    capabilityProfileId: profile.profileId,
    capabilityProfileSha256: profile.profileSha256,
    requesterScopeSha256,
    serverConfigRevision: server.configurationRevision,
    serverConfigSha256: binding.serverConfigSha256,
    resolverId: binding.resolverId,
    resolverVersion: binding.resolverVersion,
    resolverConfigGeneration: binding.resolverConfigGeneration,
    transportPolicySha256: binding.transportPolicySha256,
    callableCatalogSnapshotId: profile.callableCatalogSnapshotId,
    callableCatalogSha256: profile.callableCatalogSha256,
    attemptGeneration: requester.attemptGeneration,
    authConnectionGeneration: requester.authConnectionGeneration,
    meshActivationSha256: mcpRequesterMeshActivationHash(binding),
    connectionGenerationCurrent: true,
  };
  const allowedConnectionGeneration = { value: actorId === "operator-a" ? 11 : 12 };
  const readCurrentState = vi.fn((check: { connectionGeneration?: number }) => ({
    ...current,
    connectionGenerationCurrent:
      current.connectionGenerationCurrent &&
      (check.connectionGeneration === undefined || check.connectionGeneration === allowedConnectionGeneration.value),
  }));
  return {
    input: { requester, server, profile, binding, readCurrentState, revocationSignal },
    current,
    allowedConnectionGeneration,
  };
}

function resolvedFor(actorId: string): McpEphemeralResolvedConnectionInput {
  const suffix = actorId === "operator-a" ? "a" : "b";
  return {
    outcomeClass: "resolved",
    url: `https://${suffix}.example.test/tools?requester=${actorId}`,
    headers: [
      { name: "Authorization", value: `Bearer secret-${actorId}` },
      { name: "X-Tenant", value: actorId },
    ],
    connectionGeneration: actorId === "operator-a" ? 11 : 12,
    rotationGeneration: 2,
    expiresAt: "2026-07-14T12:04:00.000Z",
  };
}

type RawResolver = (
  input: McpRequesterConnectionResolverInput,
) => McpEphemeralResolvedConnectionInput | Promise<McpEphemeralResolvedConnectionInput>;

function registryWith(resolve: RawResolver): McpRequesterResolverRegistry {
  return new McpRequesterResolverRegistry([
    {
      resolverId: "gateway.tenant",
      resolverVersion: "1.2.3",
      configGeneration: 4,
      resolve: async (input) => createMcpEphemeralResolvedConnectionCandidate(await resolve(input)),
    },
  ]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("McpRequesterResolutionService", () => {
  it("isolates two requesters using one descriptor without connection, guard, or attempt reuse", async () => {
    const resolver = vi.fn(async ({ requester }) => resolvedFor(requester.actorId));
    const service = new McpRequesterResolutionService(registryWith(resolver), { now: () => START });
    const a = buildFixture("operator-a");
    const b = buildFixture("operator-b");

    const [attemptA, attemptB] = await Promise.all([service.resolve(a.input), service.resolve(b.input)]);

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(attemptA).not.toBe(attemptB);
    expect(attemptA.connection).not.toBe(attemptB.connection);
    expect(attemptA.connection.url).toContain("a.example.test");
    expect(attemptB.connection.url).toContain("b.example.test");
    expect(attemptA.scrubText("secret-operator-a secret-operator-b")).toBe("[REDACTED] secret-operator-b");
    expect(attemptB.scrubText("secret-operator-a secret-operator-b")).toBe("secret-operator-a [REDACTED]");
    expect(() => JSON.stringify(attemptA)).toThrowError(expect.objectContaining({ code: "secret_guard_failed" }));
    expect(() => JSON.stringify(attemptA.connection)).toThrowError(
      expect.objectContaining({ code: "secret_guard_failed" }),
    );
    attemptA.dispose();
    expect(() => attemptB.assertCurrent()).not.toThrow();
    attemptB.dispose();
  });

  it("enforces a two-second asynchronous deadline and discards an abort-ignoring late result", async () => {
    vi.useFakeTimers();
    let complete: ((value: McpEphemeralResolvedConnectionInput) => void) | undefined;
    let resolverSignal: AbortSignal | undefined;
    const resolver = vi.fn(
      ({ requester, signal }) =>
        new Promise<McpEphemeralResolvedConnectionInput>((resolve) => {
          resolverSignal = signal;
          complete = () => resolve(resolvedFor(requester.actorId));
        }),
    );
    const service = new McpRequesterResolutionService(registryWith(resolver), { now: () => START });
    const fixture = buildFixture();
    const pending = service.resolve(fixture.input);
    const rejection = expect(pending).rejects.toMatchObject({ code: "resolver_timeout" });

    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(resolverSignal?.aborted).toBe(true);
    complete?.(resolvedFor("operator-a"));
    await Promise.resolve();
    expect(fixture.input.readCurrentState).toHaveBeenCalledTimes(1);
  });

  it("treats resolver exceptions as opaque and never reads attacker properties or causes", async () => {
    let reads = 0;
    const hostile = Object.create(null);
    for (const key of ["message", "stack", "cause", "toString"]) {
      Object.defineProperty(hostile, key, {
        get() {
          reads += 1;
          return "https://secret.example.test/?token=canary";
        },
      });
    }
    const resolve = (() => {
      throw hostile;
    }) as RawResolver;
    const service = new McpRequesterResolutionService(registryWith(resolve), { now: () => START });

    const error = await service.resolve(buildFixture().input).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "resolver_failed" });
    expect(String((error as Error).message)).not.toContain("canary");
    expect(reads).toBe(0);
  });

  it("snapshots server, profile, and binding bytes before the asynchronous resolver seam", async () => {
    let complete: ((value: McpEphemeralResolvedConnectionInput) => void) | undefined;
    let seenBinding: McpRequesterResolutionBinding | undefined;
    const resolver = vi.fn(
      ({ binding }: McpRequesterConnectionResolverInput) =>
        new Promise<McpEphemeralResolvedConnectionInput>((resolve) => {
          seenBinding = binding;
          complete = resolve;
        }),
    );
    const fixture = buildFixture();
    const service = new McpRequesterResolutionService(registryWith(resolver), { now: () => START });
    const pending = service.resolve(fixture.input);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());

    fixture.input.server.requesterResolution.transportPolicy.allowedHosts.push("evil.example.test");
    fixture.input.binding.serverId = "evil-server";
    fixture.input.profile.canonicalToolName = "mcp.evil-server.search";
    complete?.({ ...resolvedFor("operator-a"), url: "https://evil.example.test/path" });

    await expect(pending).rejects.toMatchObject({ code: "resolved_destination_denied" });
    expect(seenBinding?.serverId).toBe("tenant-mcp");
    expect(Object.isFrozen(seenBinding)).toBe(true);
  });

  it("fails closed on revoke, expiry, resolver drift, and output connection-generation drift", async () => {
    let now = START;
    const resolver = vi.fn(async ({ requester }) => resolvedFor(requester.actorId));
    const service = new McpRequesterResolutionService(registryWith(resolver), { now: () => now });

    const revoked = buildFixture();
    const revokedAttempt = await service.resolve(revoked.input);
    revoked.current.revoked = true;
    expect(() => revokedAttempt.assertCurrent()).toThrowError(
      expect.objectContaining({ code: "connection_generation_revoked" }),
    );
    revokedAttempt.dispose();

    const drifted = buildFixture();
    const driftedAttempt = await service.resolve(drifted.input);
    drifted.current.resolverConfigGeneration += 1;
    expect(() => driftedAttempt.assertCurrent()).toThrowError(
      expect.objectContaining({ code: "resolver_binding_drift" }),
    );
    driftedAttempt.dispose();

    const expired = buildFixture();
    const expiredAttempt = await service.resolve(expired.input);
    now = Date.parse("2026-07-14T12:04:00.000Z");
    expect(() => expiredAttempt.assertCurrent()).toThrowError(
      expect.objectContaining({ code: "resolved_connection_expired" }),
    );
    expiredAttempt.dispose();
    now = START;

    const wrongGeneration = buildFixture();
    wrongGeneration.allowedConnectionGeneration.value = 99;
    await expect(service.resolve(wrongGeneration.input)).rejects.toMatchObject({
      code: "connection_generation_revoked",
    });
  });

  it("propagates a live revocation signal into the nonserializable attempt lease", async () => {
    const revoke = new AbortController();
    const fixture = buildFixture("operator-a", revoke.signal);
    const service = new McpRequesterResolutionService(
      registryWith(async ({ requester }) => resolvedFor(requester.actorId)),
      { now: () => START },
    );
    const attempt = await service.resolve(fixture.input);

    revoke.abort();

    expect(attempt.signal.aborted).toBe(true);
    expect(() => attempt.assertCurrent()).toThrowError(
      expect.objectContaining({ code: "connection_generation_revoked" }),
    );
    attempt.dispose();
  });

  it("never invokes hostile current-state getters during a live lease check", async () => {
    const fixture = buildFixture();
    const service = new McpRequesterResolutionService(
      registryWith(async ({ requester }) => resolvedFor(requester.actorId)),
      { now: () => START },
    );
    const attempt = await service.resolve(fixture.input);
    const hostile = { ...fixture.current };
    let reads = 0;
    Object.defineProperty(hostile, "resolverId", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("secret-canary");
      },
    });
    fixture.input.readCurrentState.mockImplementation(() => hostile);

    expect(() => attempt.assertCurrent()).toThrowError(expect.objectContaining({ code: "resolver_binding_drift" }));
    expect(reads).toBe(0);
    attempt.dispose();
  });

  it("rejects frozen profile or requester binding drift before invoking the resolver", async () => {
    const resolver = vi.fn(async ({ requester }) => resolvedFor(requester.actorId));
    const service = new McpRequesterResolutionService(registryWith(resolver), { now: () => START });
    const fixture = buildFixture();
    const tampered = structuredClone(fixture.input.binding);
    tampered.requesterScopeSha256 = "f".repeat(64);
    tampered.bindingSha256 = digest(mcpRequesterResolutionBindingHashMaterial(tampered));

    await expect(service.resolve({ ...fixture.input, binding: tampered })).rejects.toMatchObject({
      code: "requester_scope_mismatch",
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("fails before returning an attempt when secret-guard derivation exceeds its cap", async () => {
    const query = Array.from({ length: 96 }, (_, index) => `key-${index}=value-${index}`).join("&");
    const fixture = buildFixture();
    const service = new McpRequesterResolutionService(
      registryWith(async () => ({
        ...resolvedFor("operator-a"),
        url: `https://mcp.example.test/path?${query}`,
      })),
      { now: () => START },
    );

    await expect(service.resolve(fixture.input)).rejects.toMatchObject({ code: "secret_guard_failed" });
  });
});
