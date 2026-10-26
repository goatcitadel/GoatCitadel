import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  McpApprovalPosture,
  McpServerRecord,
  McpToolRecord,
  ToolAccessEvaluateRequest,
} from "@goatcitadel/contracts";
import { createMcpToolPolicyBinding } from "@goatcitadel/policy-engine";
import { loadGatewayConfig } from "../config.js";
import { GatewayService } from "./gateway-service.js";

function server(posture?: McpApprovalPosture): McpServerRecord {
  return {
    serverId: "srv-1",
    label: "Fixture MCP",
    transport: "stdio",
    authType: "none",
    enabled: true,
    status: "connected",
    category: "automation",
    trustTier: "restricted",
    costTier: "unknown",
    policy: {
      requireFirstToolApproval: false,
      redactionMode: "off",
      allowedToolPatterns: [],
      blockedToolPatterns: [],
      schemaSource: "cached_inventory",
      ...(posture ? { approvalPosture: posture } : {}),
    },
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  } as McpServerRecord;
}

function tool(annotations?: McpToolRecord["annotations"]): McpToolRecord {
  return {
    serverId: "srv-1",
    toolName: "tool.echo",
    enabled: true,
    updatedAt: "2026-10-25T00:00:00.000Z",
    ...(annotations ? { annotations } : {}),
  };
}

const base = {
  agentId: "assistant",
  sessionId: "relief-probe-session",
  workspaceId: "default",
  surface: "chat",
} satisfies Partial<ToolAccessEvaluateRequest>;
const wrapper: ToolAccessEvaluateRequest = {
  ...base,
  toolName: "mcp.invoke",
  args: { serverId: "srv-1", toolName: "tool.echo", arguments: {} },
};
const named: ToolAccessEvaluateRequest = { ...base, toolName: "mcp.srv-1.tool.echo", args: {} };
const catalogBinding = () => ({
  mcpCatalogPolicyBinding: createMcpToolPolicyBinding({
    canonicalName: "mcp.srv-1.tool.echo",
    serverId: "srv-1",
    nativeToolName: "tool.echo",
  }),
});

describe("GatewayService access probes report the MCP approval setting", () => {
  let tempRoot: string;
  let gateway: GatewayService | undefined;
  const previousDriver = process.env.GOATCITADEL_DATABASE_DRIVER;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-mcp-relief-probe-"));
    process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
    // Seed the temp root with the repository config fixtures (same pattern as the HX-415 wiring test).
    const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
    await fs.cp(path.join(repoRoot, "config"), path.join(tempRoot, "config"), { recursive: true });
    const config = await loadGatewayConfig(tempRoot);
    // The shipped default asks for every danger tool; MCP is denied until an operator allows it.
    config.toolPolicy.tools.approvalMode = "approve_risky";
    config.toolPolicy.tools.deny = config.toolPolicy.tools.deny.filter((name) => name !== "mcp.invoke");
    config.toolPolicy.tools.allow = [...config.toolPolicy.tools.allow, "mcp.invoke"];
    gateway = new GatewayService(config);
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (previousDriver === undefined) delete process.env.GOATCITADEL_DATABASE_DRIVER;
    else process.env.GOATCITADEL_DATABASE_DRIVER = previousDriver;
    await gateway?.close().catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  async function probe(posture: McpApprovalPosture | undefined, annotations: McpToolRecord["annotations"], extra = {}) {
    const service = gateway!;
    vi.spyOn(service, "requireMcpServer").mockResolvedValue(server(posture));
    vi.spyOn(service, "listMcpTools").mockResolvedValue([tool(annotations)]);
    return [
      await service.evaluateToolAccess({ ...wrapper, ...extra }),
      await service.inspectToolAccess({ ...wrapper, ...extra }),
      await service.inspectToolAccess({ ...named, ...extra }, catalogBinding()),
    ];
  }

  it.each([
    ["a relaxed read-only tool", "reads_free", { readOnlyHint: true }, false],
    ["the same tool under Everything asks", "everything_asks", { readOnlyHint: true }, true],
    ["a relaxed tool with no labels", "reads_free", undefined, true],
    ["a read-only tool with no setting", undefined, { readOnlyHint: true }, true],
  ] as const)("reports whether %s asks under an approve_risky profile", async (_label, posture, annotations, asks) => {
    // An operator's own profile that asks only before risky tools (the shipped config default mode).
    const operatorId = "operator-relief";
    const profile = await gateway!.createPermissionProfile({
      label: `Ask before risky: ${_label}`,
      scope: "operator",
      scopeRef: operatorId,
      approvalMode: "approve_risky",
      toolPatterns: ["*"],
      createdBy: operatorId,
    });
    const selected = { permissionProfileId: profile.profileId, policyContext: { operatorId } };
    for (const access of await probe(posture, annotations, selected)) {
      expect(access).toMatchObject({ allowed: true, requiresApproval: asks, permissionProfileId: profile.profileId });
      expect(access.reasonCodes.includes("mcp_approval_relief")).toBe(!asks);
    }
  });

  it("still asks for a relaxed read under the default Safe profile, which asks before every tool", async () => {
    for (const access of await probe("nothing_asks", { readOnlyHint: true })) {
      expect(access).toMatchObject({ allowed: true, requiresApproval: true, permissionProfileId: "safe" });
      expect(access.reasonCodes).toContain("approval_mode_all");
      expect(access.reasonCodes).not.toContain("mcp_approval_relief");
    }
  });
});
