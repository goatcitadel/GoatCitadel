import { describe, expect, it } from "vitest";
import type { ChatTurnFeatureReferences, McpRequesterAdmissionScope } from "@goatcitadel/contracts";
import { projectMcpAdmissionContextBudgetTools } from "./mcp-admission-context-budget.js";
import { createMcpRequesterAdmissionConnection } from "./mcp-requester-admission-authority.js";
import { normalizeMcpRequesterDiscoveryOutput } from "./mcp-requester-resolution.js";
import { createMcpRequesterDiscoverySecretScanner } from "./mcp-resolution-secret-guard.js";
import { assertNativeMcpChatToolSchema } from "./gateway/native-mcp-chat-catalog.js";
import { staticAdmissionDigest } from "./mcp-static-admission.js";

function references(): ChatTurnFeatureReferences {
  const scope: McpRequesterAdmissionScope = {
    admissionId: "admission",
    sessionIncarnationId: "incarnation",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    aggregateRevision: 1,
    controllerGeneration: 1,
    materialSha256: "a".repeat(64),
    actorId: "actor",
    actorSource: "token",
  };
  const catalog = normalizeMcpRequesterDiscoveryOutput(
    "requester",
    {
      tools: [
        {
          rawRemoteToolName: "search",
          canonicalToolName: "mcp.requester.search",
          inputSchema: { type: "object", description: "requester schema" },
        },
      ],
    },
    createMcpRequesterDiscoverySecretScanner(),
  );
  const requester = createMcpRequesterAdmissionConnection({
    current: {
      scope,
      connectionId: "connection",
      generation: 1,
      revoked: false,
      server: {
        serverId: "requester",
        transport: "http",
        connectionMode: "requester_scoped",
        configurationRevision: 1,
        requesterResolution: {
          resolverId: "gateway.actor",
          resolverVersion: "1.0.0",
          configGeneration: 1,
          transportPolicy: {
            allowedSchemes: ["https"],
            allowedHosts: ["example.test"],
            allowedPorts: [443],
            allowedHeaderNames: [],
          },
        },
      },
    },
    catalog,
    selectedToolNames: ["mcp.requester.search"],
  });
  const staticMaterial = {
    version: "mcp.static.admission.v1" as const,
    scope,
    serverId: "static",
    transport: "http" as const,
    configurationBindingId: "configuration",
    connectionRevision: "b".repeat(64),
    serverRevision: "c".repeat(64),
    selectedTools: [
      {
        rawRemoteToolName: "read",
        canonicalToolName: "mcp.static.read",
        modelName: `mcp_s_${"d".repeat(56)}`,
        inputSchema: { type: "object", description: "static schema" },
        toolDefinitionSha256: "e".repeat(64),
      },
    ],
  };
  return {
    version: "chat.turn.feature-references.v1",
    requesterConnections: [requester],
    selectedStaticMcp: [{ ...staticMaterial, bindingSha256: staticAdmissionDigest(staticMaterial) }],
  };
}

describe("MCP pre-bind context sizing", () => {
  it("counts both selected owners' exact provider definitions without issuing callable schemas", () => {
    const refs = references();
    const projected = projectMcpAdmissionContextBudgetTools([], refs);
    expect(projected).toHaveLength(2);
    expect(projected.map((tool) => tool.function)).toEqual([
      {
        name: refs.requesterConnections![0]!.selectedTools[0]!.modelName,
        parameters: { type: "object", description: "requester schema" },
      },
      {
        name: refs.selectedStaticMcp![0]!.selectedTools[0]!.modelName,
        parameters: { type: "object", description: "static schema" },
      },
    ]);
    for (const tool of projected) expect(() => assertNativeMcpChatToolSchema(tool as never)).toThrow();
    (projected[1]!.function as { parameters: { description: string } }).parameters.description = "changed";
    expect(refs.selectedStaticMcp![0]!.selectedTools[0]!.inputSchema.description).toBe("static schema");
  });
  it("rejects changed receipt bytes or duplicate aliases", () => {
    const refs = references();
    const base = projectMcpAdmissionContextBudgetTools([], refs);
    expect(() => projectMcpAdmissionContextBudgetTools(base, refs)).toThrow(/ambiguous/);
    refs.selectedStaticMcp![0]!.selectedTools[0]!.inputSchema.extra = true;
    expect(() => projectMcpAdmissionContextBudgetTools([], refs)).toThrow(/evidence changed/);
  });
});
