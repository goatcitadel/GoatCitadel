import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
  canonicalJsonString,
  mcpRequesterResolutionBindingHashMaterial,
  mcpRequesterScopeHashMaterial,
  type McpRequesterResolutionBinding,
  type McpRequesterResolutionTransportPolicy,
} from "@goatcitadel/contracts";
import {
  McpRequesterResolutionError,
  McpRequesterResolverRegistry,
  assertMcpRequesterAuthority,
  createMcpEphemeralResolvedConnectionCandidate,
  createMcpRequesterAuthority,
  mcpRequesterScopedServerConfigHash,
  mcpRequesterTransportPolicyHash,
  validateMcpEphemeralResolvedConnection,
  type McpEphemeralResolvedConnectionInput,
  type McpRequesterAuthorityInput,
  type McpRequesterScopedServerSnapshot,
} from "./mcp-requester-resolution.js";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}

function authorityInput(actorId = "operator-a"): McpRequesterAuthorityInput {
  const base = {
    actorId,
    actorSource: "token" as const,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    capabilityProfileId: "profile-1",
    capabilityProfileSha256: "a".repeat(64),
    invocationAttemptId: `attempt-${actorId}`,
    attemptGeneration: 3,
  };
  return {
    ...base,
    requesterScopeSha256: digest(
      mcpRequesterScopeHashMaterial({
        profileId: base.capabilityProfileId,
        turnId: base.turnId,
        sessionId: base.sessionId,
        workspaceId: base.workspaceId,
        authActorId: base.actorId,
        authActorSource: base.actorSource,
      }),
    ),
  };
}

function policy(): McpRequesterResolutionTransportPolicy {
  return {
    allowedSchemes: ["https"],
    allowedHosts: ["a.example.test", "b.example.test", "mcp.example.test"],
    allowedPorts: [443],
    allowedHeaderNames: ["authorization", "x-a", "x-b", "x-c", "x-d", "x-tenant"],
  };
}

function output(): McpEphemeralResolvedConnectionInput {
  return {
    outcomeClass: "resolved",
    url: "https://mcp.example.test/search?tenant=alpha",
    headers: [
      { name: "Authorization", value: "Bearer canary-secret" },
      { name: "X-Tenant", value: "alpha" },
    ],
    connectionGeneration: 5,
    rotationGeneration: 2,
    expiresAt: "2026-07-14T12:04:00.000Z",
  };
}

describe("MCP requester resolution primitives", () => {
  it("creates only exact branded, nonserializable authenticated requester authority", () => {
    const authority = createMcpRequesterAuthority(authorityInput());
    expect(() => assertMcpRequesterAuthority(authority)).not.toThrow();
    expect(authority.actorId).toBe("operator-a");
    expect(() => JSON.stringify(authority)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
    expect(() => assertMcpRequesterAuthority({ ...authorityInput() })).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );

    const forgedScope = { ...authorityInput(), requesterScopeSha256: "f".repeat(64) };
    expect(() => createMcpRequesterAuthority(forgedScope)).toThrowError(
      expect.objectContaining({ code: "requester_scope_mismatch" }),
    );
    expect(() => createMcpRequesterAuthority({ ...authorityInput(), actorSource: "none" } as never)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
  });

  it("rejects authority prototype forgery, accessors, and proxies without rereading attacker input", () => {
    const valid = createMcpRequesterAuthority(authorityInput());
    const prototypeForgery = Object.create(Object.getPrototypeOf(valid));
    Object.defineProperties(prototypeForgery, Object.getOwnPropertyDescriptors(authorityInput()));
    expect(() => assertMcpRequesterAuthority(prototypeForgery)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );

    let getterReads = 0;
    const accessorInput = authorityInput();
    Object.defineProperty(accessorInput, "actorId", {
      enumerable: true,
      get() {
        getterReads += 1;
        return getterReads === 1 ? "operator-a" : "operator-b";
      },
    });
    expect(() => createMcpRequesterAuthority(accessorInput)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxyInput = new Proxy(authorityInput(), {
      get(target, key, receiver) {
        proxyReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createMcpRequesterAuthority(proxyInput)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
    expect(proxyReads).toBe(0);
  });

  it("freezes an exact resolver registry and rejects duplicate or drifted registrations", async () => {
    const candidate = createMcpEphemeralResolvedConnectionCandidate(output());
    expect(() => JSON.stringify(candidate)).toThrowError(expect.objectContaining({ code: "secret_guard_failed" }));
    const resolve = vi.fn(async () => candidate);
    const mutable = { resolverId: "gateway.tenant", resolverVersion: "1.2.3", configGeneration: 4, resolve };
    const registry = new McpRequesterResolverRegistry([mutable]);
    mutable.resolverVersion = "9.9.9";
    mutable.configGeneration = 99;

    const frozen = registry.resolveExact("gateway.tenant", "1.2.3", 4);
    await expect(frozen.resolve({} as never)).resolves.toBe(candidate);
    expect(registry.listMetadata()).toEqual([
      { resolverId: "gateway.tenant", resolverVersion: "1.2.3", configGeneration: 4 },
    ]);
    expect(() => registry.resolveExact("missing", "1.0.0", 1)).toThrowError(
      expect.objectContaining({ code: "resolver_missing" }),
    );
    expect(() => registry.resolveExact("gateway.tenant", "1.2.4", 4)).toThrowError(
      expect.objectContaining({ code: "resolver_binding_drift" }),
    );
    expect(
      () => new McpRequesterResolverRegistry([mutable, { ...mutable, resolverVersion: "1.2.3", configGeneration: 4 }]),
    ).toThrowError(expect.objectContaining({ code: "resolver_binding_drift" }));
  });

  it("rejects accessor and proxy resolver records without observing drift", () => {
    let getterReads = 0;
    const accessorResolver = {
      resolverVersion: "1.2.3",
      configGeneration: 4,
      resolve: async () => createMcpEphemeralResolvedConnectionCandidate(output()),
    } as Record<string, unknown>;
    Object.defineProperty(accessorResolver, "resolverId", {
      enumerable: true,
      get() {
        getterReads += 1;
        return getterReads === 1 ? "gateway.tenant" : "gateway.attacker";
      },
    });
    expect(() => new McpRequesterResolverRegistry([accessorResolver as never])).toThrowError(
      expect.objectContaining({ code: "resolver_binding_drift" }),
    );
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxyResolver = new Proxy(
      {
        resolverId: "gateway.tenant",
        resolverVersion: "1.2.3",
        configGeneration: 4,
        resolve: async () => createMcpEphemeralResolvedConnectionCandidate(output()),
      },
      {
        get(target, key, receiver) {
          proxyReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => new McpRequesterResolverRegistry([proxyResolver])).toThrowError(
      expect.objectContaining({ code: "resolver_binding_drift" }),
    );
    expect(proxyReads).toBe(0);
  });

  it("hashes only the exact non-secret server and transport policy material", () => {
    const server: McpRequesterScopedServerSnapshot = {
      serverId: "tenant-mcp",
      transport: "http",
      connectionMode: "requester_scoped",
      configurationRevision: 7,
      requesterResolution: {
        resolverId: "gateway.tenant",
        resolverVersion: "1.2.3",
        configGeneration: 4,
        transportPolicy: policy(),
      },
    };
    expect(mcpRequesterScopedServerConfigHash(server)).toMatch(/^[a-f0-9]{64}$/u);
    expect(mcpRequesterTransportPolicyHash(server.requesterResolution.transportPolicy)).toBe(
      digest(server.requesterResolution.transportPolicy),
    );
  });

  it("accepts one exact bounded resolved connection and canonicalizes header names", () => {
    const validated = validateMcpEphemeralResolvedConnection(output(), policy(), NOW);
    expect(validated).toMatchObject({
      url: "https://mcp.example.test/search?tenant=alpha",
      headers: [
        { name: "authorization", value: "Bearer canary-secret" },
        { name: "x-tenant", value: "alpha" },
      ],
      connectionGeneration: 5,
      expiresAtMs: Date.parse("2026-07-14T12:04:00.000Z"),
    });
    expect(Object.isFrozen(validated.headers)).toBe(true);
  });

  it("rejects accessor and proxy resolved connections without a second URL or header read", () => {
    let urlReads = 0;
    const accessorOutput = output();
    Object.defineProperty(accessorOutput, "url", {
      enumerable: true,
      get() {
        urlReads += 1;
        return urlReads === 1 ? "https://mcp.example.test/path" : "https://evil.example.test/path";
      },
    });
    expect(() => validateMcpEphemeralResolvedConnection(accessorOutput, policy(), NOW)).toThrowError(
      expect.objectContaining({ code: "resolved_connection_invalid" }),
    );
    expect(urlReads).toBe(0);

    let headerReads = 0;
    const headerAccessorOutput = output();
    Object.defineProperty(headerAccessorOutput.headers[0], "value", {
      enumerable: true,
      get() {
        headerReads += 1;
        return headerReads === 1 ? "Bearer canary-secret" : "Bearer attacker-secret";
      },
    });
    expect(() => createMcpEphemeralResolvedConnectionCandidate(headerAccessorOutput)).toThrowError(
      expect.objectContaining({ code: "resolved_connection_invalid" }),
    );
    expect(headerReads).toBe(0);

    const proxyOutput = new Proxy(output(), {});
    expect(() => validateMcpEphemeralResolvedConnection(proxyOutput, policy(), NOW)).toThrowError(
      expect.objectContaining({ code: "resolved_connection_invalid" }),
    );
  });

  it.each([
    [
      "unknown output field",
      () => ({ ...output(), endpoint: "https://secret.example.test" }),
      "resolved_connection_invalid",
    ],
    ["unsupported scheme", () => ({ ...output(), url: "ftp://mcp.example.test/file" }), "resolved_connection_invalid"],
    [
      "userinfo",
      () => ({ ...output(), url: "https://user:pass@mcp.example.test/file" }),
      "resolved_connection_invalid",
    ],
    ["fragment", () => ({ ...output(), url: "https://mcp.example.test/file#secret" }), "resolved_connection_invalid"],
    ["host drift", () => ({ ...output(), url: "https://evil.example.test/file" }), "resolved_destination_denied"],
    ["port drift", () => ({ ...output(), url: "https://mcp.example.test:8443/file" }), "resolved_destination_denied"],
    [
      "oversized URL",
      () => ({ ...output(), url: `https://mcp.example.test/${"x".repeat(2_100)}` }),
      "resolved_connection_invalid",
    ],
    ["expired", () => ({ ...output(), expiresAt: "2026-07-14T11:59:59.999Z" }), "resolved_connection_expired"],
    ["overlong expiry", () => ({ ...output(), expiresAt: "2026-07-14T12:05:00.001Z" }), "resolved_connection_invalid"],
  ])("rejects %s", (_label, build, code) => {
    expect(() => validateMcpEphemeralResolvedConnection(build(), policy(), NOW)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("allows HTTP only for an exact configured loopback authority", () => {
    const loopbackPolicy: McpRequesterResolutionTransportPolicy = {
      allowedSchemes: ["http"],
      allowedHosts: ["127.0.0.1", "mcp.example.test"],
      allowedPorts: [80],
      allowedHeaderNames: [],
    };
    expect(() =>
      validateMcpEphemeralResolvedConnection(
        { ...output(), url: "http://127.0.0.1/path", headers: [] },
        loopbackPolicy,
        NOW,
      ),
    ).not.toThrow();
    expect(() =>
      validateMcpEphemeralResolvedConnection(
        { ...output(), url: "http://mcp.example.test/path", headers: [] },
        loopbackPolicy,
        NOW,
      ),
    ).toThrowError(expect.objectContaining({ code: "resolved_destination_denied" }));
  });

  it.each([
    ["too many", () => Array.from({ length: 17 }, (_, index) => ({ name: "X-Tenant", value: String(index) }))],
    [
      "case-fold duplicate",
      () => [
        { name: "X-Tenant", value: "a" },
        { name: "x-tenant", value: "b" },
      ],
    ],
    ["forbidden", () => [{ name: "Host", value: "mcp.example.test" }]],
    ["not allowed", () => [{ name: "X-Other", value: "secret" }]],
    ["control", () => [{ name: "X-Tenant", value: "secret\r\nInjected: yes" }]],
    ["surrounding whitespace", () => [{ name: "X-Tenant", value: " secret " }]],
    ["oversized value", () => [{ name: "X-Tenant", value: "x".repeat(8_193) }]],
    [
      "aggregate overflow",
      () => [
        { name: "X-A", value: "a".repeat(8_190) },
        { name: "X-B", value: "b".repeat(8_190) },
        { name: "X-C", value: "c".repeat(8_190) },
        { name: "X-D", value: "d".repeat(8_190) },
      ],
    ],
  ])("rejects %s resolved headers", (_label, build) => {
    expect(() => validateMcpEphemeralResolvedConnection({ ...output(), headers: build() }, policy(), NOW)).toThrowError(
      expect.objectContaining({ code: "resolved_header_denied" }),
    );
  });

  it("keeps binding hash material independent from the claimed digest", () => {
    const binding = {
      schemaVersion: MCP_REQUESTER_RESOLUTION_BINDING_VERSION,
      mode: "requester_scoped",
      serverId: "tenant-mcp",
      toolName: "mcp.tenant-mcp.search",
      resolverId: "gateway.tenant",
      resolverVersion: "1.2.3",
      resolverConfigGeneration: 4,
      requesterScopeSha256: "a".repeat(64),
      serverConfigRevision: 7,
      serverConfigSha256: "b".repeat(64),
      transportPolicySha256: "c".repeat(64),
      callableCatalogSnapshotId: "snapshot-1",
      callableCatalogSha256: "d".repeat(64),
      bindingSha256: "e".repeat(64),
    } satisfies McpRequesterResolutionBinding;
    expect(mcpRequesterResolutionBindingHashMaterial(binding)).not.toHaveProperty("bindingSha256");
    expect(new McpRequesterResolutionError("resolver_failed").message).not.toContain("tenant-mcp");
  });
});
