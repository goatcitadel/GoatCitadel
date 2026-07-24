import { describe, expect, it } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import {
  listMcpRequesterScopePostures,
  type McpRequesterScopeDiagnosticsReadPort,
  type McpRequesterScopePostureHost,
} from "./mcp-diagnostics-service.js";
import type { McpRequesterScopeLastOutcome } from "./mcp-requester-resolution-service.js";

function requesterScopedServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    serverId: "tenant-mcp",
    label: "Tenant MCP",
    transport: "http",
    connectionMode: "requester_scoped",
    configurationRevision: 7,
    requesterResolution: {
      resolverId: "gateway.tenant",
      resolverVersion: "1.2.3",
      configGeneration: 4,
      transportPolicy: {
        allowedSchemes: ["https"],
        allowedHosts: ["a.example.test"],
        allowedPorts: [443],
        allowedHeaderNames: ["authorization"],
      },
    },
    authType: "none",
    enabled: true,
    status: "disconnected",
    category: "automation",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "off",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
    },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as McpServerRecord;
}

function staticServer(): McpServerRecord {
  return requesterScopedServer({
    serverId: "static-mcp",
    connectionMode: undefined,
    requesterResolution: undefined,
    url: "https://static.example.test/mcp?token=static-canary",
    command: "run-static --token=static-canary",
  } as Partial<McpServerRecord>);
}

function readPort(overrides: Partial<McpRequesterScopeDiagnosticsReadPort> = {}): McpRequesterScopeDiagnosticsReadPort {
  return {
    resolveRegistrationPosture: () => "registered",
    loadLastOutcome: () => undefined,
    ...overrides,
  };
}

function hostFor(
  servers: McpServerRecord[],
  port: McpRequesterScopeDiagnosticsReadPort = readPort(),
): McpRequesterScopePostureHost {
  return { listMcpServers: () => servers, requesterScopeDiagnostics: port };
}

const LAST_OUTCOME: McpRequesterScopeLastOutcome = Object.freeze({
  serverId: "tenant-mcp",
  outcomeClass: "resolver_failed",
  atMs: 1_753_182_000_000,
  connectionGenerationClass: "absent",
  expiryClass: "absent",
  networkPolicyDecision: "not_evaluated",
  profileDrift: false,
});

const ALLOWED_POSTURE_KEYS = new Set([
  "serverId",
  "connectionMode",
  "requesterContextRequired",
  "enabled",
  "resolverId",
  "resolverVersion",
  "resolverConfigGeneration",
  "resolverRegistration",
  "lastOutcome",
  "outcomeClass",
  "atMs",
  "connectionGenerationClass",
  "expiryClass",
  "networkPolicyDecision",
  "profileDrift",
]);

function collectKeysDeep(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeysDeep(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeysDeep(child, keys);
    }
  }
  return keys;
}

describe("listMcpRequesterScopePostures (HX-415 operator diagnostics)", () => {
  it("projects only requester-scoped servers with explicit non-secret fields", () => {
    const postures = listMcpRequesterScopePostures(hostFor([requesterScopedServer(), staticServer()]));
    expect(postures).toHaveLength(1);
    expect(postures[0]).toEqual({
      serverId: "tenant-mcp",
      connectionMode: "requester_scoped",
      requesterContextRequired: true,
      enabled: true,
      resolverId: "gateway.tenant",
      resolverVersion: "1.2.3",
      resolverConfigGeneration: 4,
      resolverRegistration: "registered",
    });
    expect(Object.isFrozen(postures[0])).toBe(true);
  });

  it("reports resolver_missing posture for a stock deployment and drift for a mismatched binding", () => {
    const missing = listMcpRequesterScopePostures(
      hostFor([requesterScopedServer()], readPort({ resolveRegistrationPosture: () => "resolver_missing" })),
    );
    expect(missing[0]?.resolverRegistration).toBe("resolver_missing");
    const drifted = listMcpRequesterScopePostures(
      hostFor([requesterScopedServer()], readPort({ resolveRegistrationPosture: () => "resolver_binding_drift" })),
    );
    expect(drifted[0]?.resolverRegistration).toBe("resolver_binding_drift");
  });

  it("copies the recorder's last outcome classes field by field", () => {
    const postures = listMcpRequesterScopePostures(
      hostFor([requesterScopedServer()], readPort({ loadLastOutcome: () => LAST_OUTCOME })),
    );
    expect(postures[0]?.lastOutcome).toEqual({
      outcomeClass: "resolver_failed",
      atMs: 1_753_182_000_000,
      connectionGenerationClass: "absent",
      expiryClass: "absent",
      networkPolicyDecision: "not_evaluated",
      profileDrift: false,
    });
    expect(Object.isFrozen(postures[0]?.lastOutcome)).toBe(true);
  });

  it("serializes to exactly the allowlisted secret-free keys — no url/command/header/auth field can appear", () => {
    const hostileServer = requesterScopedServer({
      // A hostile/malformed record carrying static-looking material must never
      // leak: the projection copies explicit fields only.
      url: "https://leak.example.test/mcp?token=canary-secret",
      command: "leak --authorization=Bearer canary-secret",
    } as Partial<McpServerRecord>);
    const postures = listMcpRequesterScopePostures(
      hostFor([hostileServer], readPort({ loadLastOutcome: () => LAST_OUTCOME })),
    );
    const serialized = JSON.stringify(postures);
    expect(serialized).not.toContain("canary-secret");
    expect(serialized).not.toContain("leak.example.test");
    expect(serialized).not.toContain("Bearer");
    for (const key of collectKeysDeep(postures)) {
      expect(ALLOWED_POSTURE_KEYS.has(key), `unexpected projected key: ${key}`).toBe(true);
    }
  });

  it("skips malformed records and unreadable hosts fail-closed", () => {
    expect(
      listMcpRequesterScopePostures(
        hostFor([
          requesterScopedServer({ requesterResolution: undefined } as Partial<McpServerRecord>),
          requesterScopedServer({ connectionMode: "bogus" as never } as Partial<McpServerRecord>),
        ]),
      ),
    ).toEqual([]);
    expect(
      listMcpRequesterScopePostures({
        listMcpServers: () => {
          throw new Error("unreadable");
        },
        requesterScopeDiagnostics: readPort(),
      }),
    ).toEqual([]);
    // A throwing read port skips that server rather than surfacing partial rows.
    expect(
      listMcpRequesterScopePostures(
        hostFor(
          [requesterScopedServer()],
          readPort({
            resolveRegistrationPosture: () => {
              throw new Error("port unavailable");
            },
          }),
        ),
      ),
    ).toEqual([]);
  });
});
