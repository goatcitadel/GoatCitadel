import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as requesterResolutionModule from "./mcp-requester-resolution.js";
import {
  canonicalJsonString,
  type McpProfileDiscoveryAuthorityHashInput,
  type McpRequesterResolutionTransportPolicy,
  type McpToolCallAuthorityHashInput,
} from "@goatcitadel/contracts";
import {
  McpRequesterResolutionError,
  McpRequesterResolverRegistry,
  assertMcpProfileDiscoveryAuthority,
  assertMcpToolCallAuthority,
  assertNormalizedMcpRequesterDiscoveryCatalog,
  createMcpEphemeralResolvedConnectionCandidate,
  createMcpRequesterProviderAlias,
  extractMcpRequesterDiscoveryOutputInput,
  issueMcpProfileDiscoveryAuthority,
  issueMcpToolCallAuthority,
  mcpRequesterScopedServerConfigHash,
  mcpRequesterTransportPolicyHash,
  normalizeMcpRequesterDiscoveryOutput,
  readMcpEphemeralResolvedConnectionCandidate,
  snapshotMcpRequesterScopedServerSnapshot,
  validateMcpEphemeralResolvedConnection,
  type McpEphemeralResolvedConnectionInput,
  type McpRequesterDiscoverySecretScanner,
  type McpRequesterScopedServerSnapshot,
  type McpToolCallAuthorityIssueInput,
} from "./mcp-requester-resolution.js";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

function digest(input: unknown): string {
  return createHash("sha256").update(canonicalJsonString(input)).digest("hex");
}

function policy(): McpRequesterResolutionTransportPolicy {
  return {
    allowedSchemes: ["https"],
    allowedHosts: ["a.example.test", "b.example.test", "mcp.example.test"],
    allowedPorts: [443],
    allowedHeaderNames: ["authorization", "x-a", "x-b", "x-c", "x-d", "x-tenant"],
  };
}

function server(): McpRequesterScopedServerSnapshot {
  return {
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
}

function discoveryAuthorityInput(actorId = "operator-a"): McpProfileDiscoveryAuthorityHashInput {
  const selected = server();
  return {
    actorId,
    actorSource: "token",
    workspaceId: "workspace-1",
    sessionId: `session-${actorId}`,
    turnId: `turn-${actorId}`,
    futureProfileId: `future-profile-${actorId}`,
    baseCallableCatalogSha256: digest({ tools: ["mcp.invoke"] }),
    serverId: selected.serverId,
    serverConfigRevision: selected.configurationRevision,
    serverConfigSha256: mcpRequesterScopedServerConfigHash(selected),
    resolverId: selected.requesterResolution.resolverId,
    resolverVersion: selected.requesterResolution.resolverVersion,
    resolverConfigGeneration: selected.requesterResolution.configGeneration,
    transportPolicySha256: mcpRequesterTransportPolicyHash(selected.requesterResolution.transportPolicy),
    globalNetworkPolicyGeneration: 5,
    authConnectionGeneration: 6,
    turnGeneration: 7,
    preparationGeneration: 8,
    discoveryAttemptId: `discovery-${actorId}`,
    discoveryAttemptGeneration: 9,
  };
}

function scanner(overrides: Partial<McpRequesterDiscoverySecretScanner> = {}): McpRequesterDiscoverySecretScanner {
  return {
    scannerId: "gateway.secret-scan",
    scannerVersion: "1.0.0",
    scannerGeneration: 3,
    scan: ({ payloadSha256 }) => ({ verdict: "clean", evidenceSha256: digest({ payloadSha256, clean: true }) }),
    ...overrides,
  };
}

function discoveryCatalog() {
  return normalizeMcpRequesterDiscoveryOutput(
    "tenant-mcp",
    {
      tools: [
        {
          rawRemoteToolName: "search",
          canonicalToolName: "mcp.tenant-mcp.search",
          description: "Search safely",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    },
    scanner(),
  );
}

function toolCallAuthorityInput(actorId = "operator-a"): McpToolCallAuthorityHashInput {
  const selected = server();
  const catalog = discoveryCatalog();
  const tool = catalog.tools[0]!;
  const profile = {
    finalProfileId: "profile-1",
    finalProfileSha256: digest({ profile: 1 }),
    baseCallableCatalogSha256: digest({ tools: ["mcp.invoke"] }),
    finalCallableCatalogSha256: digest({ tools: ["mcp.tenant-mcp.search"] }),
    serverId: "tenant-mcp",
    rawRemoteToolName: tool.rawRemoteToolName,
    canonicalToolName: tool.canonicalToolName,
    normalizedDiscoveryCatalogSha256: catalog.catalogSha256,
    normalizedToolDefinitionSha256: tool.toolDefinitionSha256,
    bindingSha256: digest({ binding: 1 }),
  };
  return {
    actorId,
    actorSource: "token",
    workspaceId: "workspace-1",
    sessionId: `session-${actorId}`,
    turnId: `turn-${actorId}`,
    ...profile,
    providerAlias: createMcpRequesterProviderAlias({
      serverId: profile.serverId,
      rawRemoteToolName: profile.rawRemoteToolName,
      canonicalToolName: profile.canonicalToolName,
      normalizedToolDefinitionSha256: profile.normalizedToolDefinitionSha256,
      bindingSha256: profile.bindingSha256,
    }),
    serverConfigRevision: selected.configurationRevision,
    serverConfigSha256: mcpRequesterScopedServerConfigHash(selected),
    resolverId: selected.requesterResolution.resolverId,
    resolverVersion: selected.requesterResolution.resolverVersion,
    resolverConfigGeneration: selected.requesterResolution.configGeneration,
    transportPolicySha256: mcpRequesterTransportPolicyHash(selected.requesterResolution.transportPolicy),
    globalNetworkPolicyGeneration: 5,
    authConnectionGeneration: 6,
    turnGeneration: 7,
    preparationGeneration: 8,
    profileDiscoveryAttemptId: `discovery-${actorId}`,
    profileDiscoveryAttemptGeneration: 9,
    revalidationAttemptId: `revalidation-${actorId}`,
    revalidationAttemptGeneration: 10,
    finalEffectAttemptId: `effect-${actorId}`,
    finalEffectAttemptGeneration: 11,
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

describe("MCP two-stage requester resolution primitives", () => {
  it("keeps all authority, sealed-profile, and callback issuer construction paths private", () => {
    expect(Object.keys(requesterResolutionModule)).not.toEqual(
      expect.arrayContaining([
        "createMcpProfileDiscoveryAuthority",
        "createMcpSealedToolCallProfile",
        "createMcpToolCallAuthority",
        "createMcpRequesterAuthorityIssuer",
      ]),
    );
    const bodyDiscovery = discoveryAuthorityInput();
    const bodyToolCall = toolCallAuthorityInput();
    const bodyCallback = (): McpProfileDiscoveryAuthorityHashInput => bodyDiscovery;
    expect(() => assertMcpProfileDiscoveryAuthority(bodyDiscovery)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
    expect(() => assertMcpToolCallAuthority(bodyToolCall)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
    expect(() => assertMcpProfileDiscoveryAuthority(bodyCallback())).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
  });

  it("rejects body and prototype authority forgery with no structural conversion path", () => {
    const prototypeForgery = Object.create({ stage: "profile_discovery" });
    Object.assign(prototypeForgery, discoveryAuthorityInput(), { authoritySha256: "a".repeat(64) });
    expect(() => assertMcpProfileDiscoveryAuthority(prototypeForgery)).toThrow();
    expect(() => assertMcpProfileDiscoveryAuthority({ ...discoveryAuthorityInput() })).toThrow();
    expect(() => assertMcpToolCallAuthority({ ...toolCallAuthorityInput() })).toThrow();
  });

  it("rejects authority accessors and proxies without invoking body getters", () => {
    let reads = 0;
    const accessor = discoveryAuthorityInput();
    Object.defineProperty(accessor, "actorId", {
      enumerable: true,
      get() {
        reads += 1;
        return "operator-a";
      },
    });
    expect(() => assertMcpProfileDiscoveryAuthority(accessor)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
    expect(reads).toBe(0);
    const proxy = new Proxy(discoveryAuthorityInput(), {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => assertMcpProfileDiscoveryAuthority(proxy)).toThrow();
    expect(reads).toBe(0);
  });

  it("creates a full-digest opaque provider alias without exposing a profile mint", () => {
    const input = toolCallAuthorityInput();
    expect(input.providerAlias).toMatch(/^mcp__[a-f0-9]{64}$/u);
    expect(input.providerAlias).toHaveLength(69);
    expect(input.providerAlias).not.toContain(input.serverId);
  });

  it("normalizes discovery output deterministically and binds the clean scan", () => {
    const first = normalizeMcpRequesterDiscoveryOutput(
      "tenant-mcp",
      {
        tools: [
          { rawRemoteToolName: "zeta", canonicalToolName: "mcp.tenant.zeta", inputSchema: { type: "object" } },
          { rawRemoteToolName: "alpha", canonicalToolName: "mcp.tenant.alpha", inputSchema: { type: "object" } },
        ],
      },
      scanner(),
    );
    const second = normalizeMcpRequesterDiscoveryOutput(
      "tenant-mcp",
      {
        tools: [...first.tools]
          .reverse()
          .map(({ toolDefinitionSha256: _hash, ...tool }) => ({ ...tool, inputSchema: { ...tool.inputSchema } })),
      },
      scanner(),
    );
    expect(first.tools.map((tool) => tool.rawRemoteToolName)).toEqual(["alpha", "zeta"]);
    expect(second.catalogSha256).toBe(first.catalogSha256);
    expect(first.secretScan).toMatchObject({ verdict: "clean", scannerGeneration: 3 });
    expect(() => assertNormalizedMcpRequesterDiscoveryCatalog(first)).not.toThrow();
    expect(() => assertNormalizedMcpRequesterDiscoveryCatalog(structuredClone(first))).toThrow();
  });

  it.each([
    [
      "duplicate raw names",
      [
        { rawRemoteToolName: "search", canonicalToolName: "mcp.tenant.search-a", inputSchema: {} },
        { rawRemoteToolName: "search", canonicalToolName: "mcp.tenant.search-b", inputSchema: {} },
      ],
      "discovery_output_invalid",
    ],
    [
      "canonical collision",
      [
        { rawRemoteToolName: "search-a", canonicalToolName: "mcp.tenant.search", inputSchema: {} },
        { rawRemoteToolName: "search-b", canonicalToolName: "mcp.tenant.search", inputSchema: {} },
      ],
      "discovery_output_invalid",
    ],
    [
      "tool limit",
      Array.from({ length: 65 }, (_, index) => ({
        rawRemoteToolName: `tool-${index}`,
        canonicalToolName: `mcp.tenant.tool-${index}`,
        inputSchema: {},
      })),
      "discovery_output_too_large",
    ],
    [
      "description limit",
      [
        {
          rawRemoteToolName: "search",
          canonicalToolName: "mcp.tenant.search",
          description: "x".repeat(8_193),
          inputSchema: {},
        },
      ],
      "discovery_output_invalid",
    ],
  ])("rejects bounded discovery %s", (_label, tools, code) => {
    expect(() => normalizeMcpRequesterDiscoveryOutput("tenant-mcp", { tools }, scanner())).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects excessive schema depth and nodes", () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 17; index += 1) deep = { child: deep };
    expect(() =>
      normalizeMcpRequesterDiscoveryOutput(
        "tenant-mcp",
        { tools: [{ rawRemoteToolName: "search", canonicalToolName: "mcp.tenant.search", inputSchema: deep }] },
        scanner(),
      ),
    ).toThrowError(expect.objectContaining({ code: "discovery_output_too_large" }));
    const wide = Object.fromEntries(Array.from({ length: 2_049 }, (_, index) => [`field${index}`, null]));
    expect(() =>
      normalizeMcpRequesterDiscoveryOutput(
        "tenant-mcp",
        { tools: [{ rawRemoteToolName: "search", canonicalToolName: "mcp.tenant.search", inputSchema: wide }] },
        scanner(),
      ),
    ).toThrowError(expect.objectContaining({ code: "discovery_output_too_large" }));
  });

  it("rejects giant schema strings, keys, and cumulative bytes before canonicalization", () => {
    const normalizeSchema = (inputSchema: Record<string, unknown>) =>
      normalizeMcpRequesterDiscoveryOutput(
        "tenant-mcp",
        { tools: [{ rawRemoteToolName: "search", canonicalToolName: "mcp.tenant.search", inputSchema }] },
        scanner(),
      );
    expect(() => normalizeSchema({ value: "x".repeat(70_000) })).toThrowError(
      expect.objectContaining({ code: "discovery_output_too_large" }),
    );
    expect(() => normalizeSchema({ ["k".repeat(70_000)]: true })).toThrowError(
      expect.objectContaining({ code: "discovery_output_too_large" }),
    );
    expect(() => normalizeSchema({ a: "x".repeat(40_000), b: "y".repeat(40_000) })).toThrowError(
      expect.objectContaining({ code: "discovery_output_too_large" }),
    );
  });

  it("fails closed on secret-scan rejection, scanner forgery, and discovery getters/proxies", () => {
    const tool = { rawRemoteToolName: "search", canonicalToolName: "mcp.tenant.search", inputSchema: {} };
    expect(() =>
      normalizeMcpRequesterDiscoveryOutput(
        "tenant-mcp",
        { tools: [tool] },
        scanner({ scan: (() => ({ verdict: "secret", evidenceSha256: "a".repeat(64) })) as never }),
      ),
    ).toThrowError(expect.objectContaining({ code: "discovery_secret_detected" }));
    expect(() =>
      normalizeMcpRequesterDiscoveryOutput("tenant-mcp", { tools: [tool] }, new Proxy(scanner(), {})),
    ).toThrow();

    let reads = 0;
    const hostile = { ...tool };
    Object.defineProperty(hostile, "rawRemoteToolName", {
      enumerable: true,
      get() {
        reads += 1;
        return "search";
      },
    });
    expect(() => normalizeMcpRequesterDiscoveryOutput("tenant-mcp", { tools: [hostile] }, scanner())).toThrow();
    expect(reads).toBe(0);
    expect(() =>
      normalizeMcpRequesterDiscoveryOutput("tenant-mcp", { tools: [new Proxy(tool, {})] }, scanner()),
    ).toThrow();
  });

  it("freezes distinct discovery/final resolver ports with no generic resolve", async () => {
    const candidate = createMcpEphemeralResolvedConnectionCandidate(output());
    const discovery = vi.fn(async () => candidate);
    const final = vi.fn(async () => createMcpEphemeralResolvedConnectionCandidate(output()));
    const registry = new McpRequesterResolverRegistry({
      profileDiscovery: [
        {
          resolverId: "gateway.tenant",
          resolverVersion: "1.2.3",
          configGeneration: 4,
          resolveForProfileDiscovery: discovery,
        },
      ],
      toolCall: [
        {
          resolverId: "gateway.tenant",
          resolverVersion: "1.2.3",
          configGeneration: 4,
          resolveForToolCall: final,
        },
      ],
    });
    expect(registry.listMetadata()).toEqual([
      { stage: "profile_discovery", resolverId: "gateway.tenant", resolverVersion: "1.2.3", configGeneration: 4 },
      { stage: "tool_call", resolverId: "gateway.tenant", resolverVersion: "1.2.3", configGeneration: 4 },
    ]);
    expect((registry as unknown as Record<string, unknown>).resolveExact).toBeUndefined();
    await expect(
      registry.resolveProfileDiscoveryExact("gateway.tenant", "1.2.3", 4).resolveForProfileDiscovery({} as never),
    ).resolves.toBe(candidate);
    await expect(
      registry.resolveToolCallExact("gateway.tenant", "1.2.3", 4).resolveForToolCall({} as never),
    ).resolves.toBeInstanceOf(Object);
  });

  it("makes resolved candidates one-shot so stages cannot reuse connection secrets", () => {
    const candidate = createMcpEphemeralResolvedConnectionCandidate(output());
    expect(readMcpEphemeralResolvedConnectionCandidate(candidate)).toMatchObject({ connectionGeneration: 5 });
    expect(() => readMcpEphemeralResolvedConnectionCandidate(candidate)).toThrowError(
      expect.objectContaining({ code: "resolved_connection_invalid" }),
    );
    expect(() => JSON.stringify(candidate)).toThrowError(expect.objectContaining({ code: "secret_guard_failed" }));
  });

  it("snapshots requester-scoped servers without invoking accessors or proxies", () => {
    const valid = snapshotMcpRequesterScopedServerSnapshot(server());
    expect(Object.isFrozen(valid.requesterResolution.transportPolicy.allowedHosts)).toBe(true);
    let reads = 0;
    const hostile = server();
    Object.defineProperty(hostile, "serverId", {
      enumerable: true,
      get() {
        reads += 1;
        return "tenant-mcp";
      },
    });
    expect(() => snapshotMcpRequesterScopedServerSnapshot(hostile)).toThrow();
    expect(reads).toBe(0);
    expect(() => snapshotMcpRequesterScopedServerSnapshot(new Proxy(server(), {}))).toThrow();
  });

  it("keeps exact destination/header/expiry bounds for each fresh stage connection", () => {
    const validated = validateMcpEphemeralResolvedConnection(output(), policy(), NOW);
    expect(validated).toMatchObject({
      url: "https://mcp.example.test/search?tenant=alpha",
      headers: [
        { name: "authorization", value: "Bearer canary-secret" },
        { name: "x-tenant", value: "alpha" },
      ],
      connectionGeneration: 5,
    });
    expect(() =>
      validateMcpEphemeralResolvedConnection({ ...output(), url: "https://evil.example.test/path" }, policy(), NOW),
    ).toThrowError(expect.objectContaining({ code: "resolved_destination_denied" }));
    expect(() =>
      validateMcpEphemeralResolvedConnection(
        { ...output(), headers: [{ name: "Host", value: "mcp.example.test" }] },
        policy(),
        NOW,
      ),
    ).toThrowError(expect.objectContaining({ code: "resolved_header_denied" }));
  });

  it("keeps reason messages opaque", () => {
    expect(new McpRequesterResolutionError("resolver_failed").message).not.toContain("tenant-mcp");
  });
});

function toolCallIssueInput(actorId = "operator-a"): McpToolCallAuthorityIssueInput {
  const {
    finalProfileId,
    finalProfileSha256,
    baseCallableCatalogSha256,
    finalCallableCatalogSha256,
    serverId,
    rawRemoteToolName,
    canonicalToolName,
    providerAlias,
    normalizedDiscoveryCatalogSha256,
    normalizedToolDefinitionSha256,
    bindingSha256,
    ...rest
  } = toolCallAuthorityInput(actorId);
  return {
    ...rest,
    sealedProfile: {
      finalProfileId,
      finalProfileSha256,
      baseCallableCatalogSha256,
      finalCallableCatalogSha256,
      serverId,
      rawRemoteToolName,
      canonicalToolName,
      providerAlias,
      normalizedDiscoveryCatalogSha256,
      normalizedToolDefinitionSha256,
      bindingSha256,
    },
  };
}

describe("controlled requester-authority issuance (HX-415 slice 7c)", () => {
  it("mints branded discovery authorities through full validation only", () => {
    const authority = issueMcpProfileDiscoveryAuthority(discoveryAuthorityInput());
    expect(() => assertMcpProfileDiscoveryAuthority(authority)).not.toThrow();
    expect(authority.stage).toBe("profile_discovery");
    expect(authority.authoritySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => JSON.stringify(authority)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
  });

  it("mints branded tool-call authorities by sealing the raw profile record first", () => {
    const authority = issueMcpToolCallAuthority(toolCallIssueInput());
    expect(() => assertMcpToolCallAuthority(authority)).not.toThrow();
    expect(authority.stage).toBe("tool_call");
    expect(authority.rawRemoteToolName).toBe("search");
    expect(authority.canonicalToolName).toBe("mcp.tenant-mcp.search");
    expect(() => JSON.stringify(authority)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
  });

  it("rejects forged issuance input before any brand is created", () => {
    const badSha = toolCallIssueInput();
    badSha.sealedProfile.finalProfileSha256 = "NOT-A-SHA";
    expect(() => issueMcpToolCallAuthority(badSha)).toThrowError(
      expect.objectContaining({ code: "capability_profile_invalid" }),
    );

    const aliasMismatch = toolCallIssueInput();
    aliasMismatch.sealedProfile.providerAlias = `mcp__${"a".repeat(64)}`;
    expect(() => issueMcpToolCallAuthority(aliasMismatch)).toThrowError(
      expect.objectContaining({ code: "capability_profile_invalid" }),
    );

    const nonCanonical = toolCallIssueInput();
    nonCanonical.sealedProfile.serverId = "tenant mcp";
    expect(() => issueMcpToolCallAuthority(nonCanonical)).toThrowError(
      expect.objectContaining({ code: "capability_profile_invalid" }),
    );

    const extraKey = { ...toolCallIssueInput(), forged: true } as unknown as McpToolCallAuthorityIssueInput;
    expect(() => issueMcpToolCallAuthority(extraKey)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );

    const badDiscovery = { ...discoveryAuthorityInput(), actorSource: "none" };
    expect(() => issueMcpProfileDiscoveryAuthority(badDiscovery as never)).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
  });

  it("never accepts a re-issued raw profile record in place of the sealed brand", () => {
    const issued = issueMcpToolCallAuthority(toolCallIssueInput());
    expect(() => assertMcpToolCallAuthority({ ...issued })).toThrowError(
      expect.objectContaining({ code: "requester_context_ambiguous" }),
    );
  });

  it("keeps issuance call sites scoped to the resolution service and gateway composition", () => {
    const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
    const inventory = listProductionTypeScriptSources(sourceRoot).map((filePath) => ({
      relativePath: relative(sourceRoot, filePath).replaceAll("\\", "/"),
      content: readFileSync(filePath, "utf8"),
    }));
    expect(inventory.length).toBeGreaterThan(0);
    expect(() => assertIssuanceCallSitesScoped(inventory)).not.toThrow();
    // The guard itself must fail when a disallowed production file gains a call.
    expect(() =>
      assertIssuanceCallSitesScoped([
        ...inventory,
        {
          relativePath: "routes/mcp.ts",
          content: "issueMcpToolCallAuthority({} as never);",
        },
      ]),
    ).toThrow(/routes\/mcp\.ts/u);
    expect(() =>
      assertIssuanceCallSitesScoped([
        ...inventory,
        {
          relativePath: "services/gateway-service.ts",
          content: "issueMcpProfileDiscoveryAuthority(input);",
        },
      ]),
    ).not.toThrow();
  });
});

const ISSUANCE_DEFINITION_SITE = "services/mcp-requester-resolution.ts";
const ISSUANCE_ALLOWED_CALL_SITES = new Set([
  "services/gateway-service.ts",
  "services/mcp-requester-resolution-service.ts",
]);

function assertIssuanceCallSitesScoped(inventory: ReadonlyArray<{ relativePath: string; content: string }>): void {
  for (const callToken of ["issueMcpProfileDiscoveryAuthority(", "issueMcpToolCallAuthority("]) {
    for (const file of inventory) {
      if (file.relativePath === ISSUANCE_DEFINITION_SITE) continue;
      if (!file.content.includes(callToken)) continue;
      if (!ISSUANCE_ALLOWED_CALL_SITES.has(file.relativePath)) {
        throw new Error(`Requester-authority issuance leaked into ${file.relativePath} via ${callToken})`);
      }
    }
  }
}

function listProductionTypeScriptSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return listProductionTypeScriptSources(fullPath);
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".vitest.ts") ||
      entry.name.endsWith(".d.ts")
    ) {
      return [];
    }
    return [fullPath];
  });
}

describe("extractMcpRequesterDiscoveryOutputInput", () => {
  it("maps a raw tools/list result onto the canonical discovery input shape", () => {
    const extracted = extractMcpRequesterDiscoveryOutputInput("tenant-mcp", {
      tools: [
        {
          name: " search ",
          description: "  Search safely  ",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
        { name: "plain" },
      ],
    });
    expect(extracted.tools).toEqual([
      {
        rawRemoteToolName: "search",
        canonicalToolName: "mcp.tenant-mcp.search",
        description: "Search safely",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
      { rawRemoteToolName: "plain", canonicalToolName: "mcp.tenant-mcp.plain", inputSchema: {} },
    ]);
    const normalized = normalizeMcpRequesterDiscoveryOutput("tenant-mcp", extracted, scanner());
    expect(normalized.tools).toHaveLength(2);
  });

  it("fails closed on malformed raw results", () => {
    for (const raw of [undefined, null, "tools", { tools: "nope" }, { tools: [{ name: 42 }] }, { tools: [{}] }]) {
      expect(() => extractMcpRequesterDiscoveryOutputInput("tenant-mcp", raw)).toThrowError(
        expect.objectContaining({ code: "discovery_output_invalid" }),
      );
    }
    expect(() =>
      extractMcpRequesterDiscoveryOutputInput("tenant-mcp", {
        tools: Array.from({ length: 65 }, (_, index) => ({ name: `tool-${index}` })),
      }),
    ).toThrowError(expect.objectContaining({ code: "discovery_output_too_large" }));
  });
});
