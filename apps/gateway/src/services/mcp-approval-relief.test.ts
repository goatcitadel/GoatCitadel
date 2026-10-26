import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  type DeploymentProfile,
  type McpApprovalPosture,
  type McpServerRecord,
  type McpToolRecord,
} from "@goatcitadel/contracts";
import { createMcpToolPolicyBinding } from "@goatcitadel/policy-engine";
import { resolveMcpApprovalRelief, type McpApprovalReliefPort } from "./mcp-approval-relief.js";

function server(overrides: Partial<McpServerRecord> = {}, posture?: McpApprovalPosture): McpServerRecord {
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
    ...overrides,
  } as McpServerRecord;
}

function tool(annotations?: McpToolRecord["annotations"], toolName = "tool.echo", serverId = "srv-1"): McpToolRecord {
  return {
    serverId,
    toolName,
    enabled: true,
    updatedAt: "2026-10-25T00:00:00.000Z",
    ...(annotations ? { annotations } : {}),
  };
}

function port(
  record: McpServerRecord | Error,
  tools: McpToolRecord[] = [tool({ readOnlyHint: true })],
  deploymentProfile: DeploymentProfile = "trusted_local",
) {
  return {
    getDeploymentProfile: vi.fn(() => deploymentProfile),
    requireMcpServer: vi.fn(async () => {
      if (record instanceof Error) throw record;
      return record;
    }),
    listMcpTools: vi.fn(async () => tools),
  } satisfies McpApprovalReliefPort;
}

const wrapper = (args: Record<string, unknown> = { serverId: "srv-1", toolName: "tool.echo", arguments: {} }) => ({
  toolName: "mcp.invoke",
  args,
});

describe("resolveMcpApprovalRelief", () => {
  it("relieves a wrapper call only from the saved setting and every stored entry for that tool", async () => {
    expect(await resolveMcpApprovalRelief(port(server({}, "reads_free")), wrapper())).toBeDefined();
    expect(await resolveMcpApprovalRelief(port(server({}, "everything_asks")), wrapper())).toBeUndefined();
    expect(await resolveMcpApprovalRelief(port(server()), wrapper())).toBeUndefined();
    const duplicates = port(server({}, "reads_free"), [tool({ readOnlyHint: true }), tool()]);
    expect(await resolveMcpApprovalRelief(duplicates, wrapper())).toBeUndefined();
    const otherServer = port(server({}, "reads_free"), [tool({ readOnlyHint: true }, "tool.echo", "srv-2")]);
    expect(await resolveMcpApprovalRelief(otherServer, wrapper())).toBeUndefined();
  });

  it.each([
    ["disabled", server({ enabled: false }, "nothing_asks")],
    ["quarantined", server({ trustTier: "quarantined" }, "nothing_asks")],
    ["requester-scoped", server({ connectionMode: "requester_scoped" }, "nothing_asks")],
  ])("gives a %s server no relief", async (_label, record) => {
    expect(await resolveMcpApprovalRelief(port(record), wrapper())).toBeUndefined();
  });

  it.each([
    ["a non-MCP tool", { toolName: "shell.exec", args: { serverId: "srv-1", toolName: "tool.echo" } }],
    ["a wrapper without a target", wrapper({ arguments: {} })],
    ["a non-string target", wrapper({ serverId: ["srv-1"], toolName: "tool.echo" })],
    ["a padded server id", wrapper({ serverId: " srv-1", toolName: "tool.echo" })],
    ["a padded tool name", wrapper({ serverId: "srv-1", toolName: "tool.echo " })],
    ["a remote A2A peer", { ...wrapper(), policyContext: { authActorSource: "a2a_peer" } }],
  ])("reads nothing for %s", async (_label, request) => {
    const reads = port(server({}, "nothing_asks"));
    expect(await resolveMcpApprovalRelief(reads, request)).toBeUndefined();
    expect(reads.requireMcpServer).not.toHaveBeenCalled();
    expect(reads.listMcpTools).not.toHaveBeenCalled();
  });

  it("treats an unknown server as no relief but surfaces any other read failure", async () => {
    expect(await resolveMcpApprovalRelief(port(new NotFoundError("Unknown MCP server: srv-1")), wrapper())).toBe(
      undefined,
    );
    await expect(resolveMcpApprovalRelief(port(new Error("registry unreadable")), wrapper())).rejects.toThrow(
      "registry unreadable",
    );
  });

  // R49: a remote_hardened install never relaxes an approval, like every other operator relaxation.
  it.each(["reads_free", "nothing_asks"] as const)(
    "never relieves a call on a remote_hardened install, even when %s and the labels would allow it",
    async (posture) => {
      const hardened = port(server({}, posture), [tool({ readOnlyHint: true })], "remote_hardened");
      expect(await resolveMcpApprovalRelief(hardened, wrapper())).toBeUndefined();
      for (const profile of ["local_dev", "trusted_local"] as const) {
        expect(await resolveMcpApprovalRelief(port(server({}, posture), undefined, profile), wrapper())).toBeDefined();
      }
    },
  );

  // R52: a money-moving server's saved nothing_asks is decided as reads_free.
  it.each([
    ["its host", { url: "https://mcp.paypal.com/sse", label: "Team wallet" }],
    ["its label", { label: "PayPal" }],
  ] as const)(
    "caps nothing_asks to reads_free on a server that moves money, found by %s",
    async (_label, overrides) => {
      const money = (annotations: McpToolRecord["annotations"]) =>
        port(server({ transport: "sse", ...overrides }, "nothing_asks"), [tool(annotations)]);
      expect(await resolveMcpApprovalRelief(money({ destructiveHint: false }), wrapper())).toBeUndefined();
      expect(await resolveMcpApprovalRelief(money({ readOnlyHint: true }), wrapper())).toBeDefined();
      // The same non-destructive change still runs on its own on a connector that doesn't move money.
      const other = port(server({ url: "https://mcp.docs.example/mcp" }, "nothing_asks"), [
        tool({ destructiveHint: false }),
      ]);
      expect(await resolveMcpApprovalRelief(other, wrapper())).toBeDefined();
    },
  );

  it("asks for a tool marked destructive under every setting, even when it is also marked read-only", async () => {
    for (const posture of ["reads_free", "nothing_asks"] as const) {
      const reads = port(server({}, posture), [tool({ readOnlyHint: true, destructiveHint: true })]);
      expect(await resolveMcpApprovalRelief(reads, wrapper())).toBeUndefined();
    }
  });

  it("takes a named call's target from its trusted binding, including dotted server ids", async () => {
    const binding = createMcpToolPolicyBinding({
      canonicalName: "mcp.acme.docs.search",
      serverId: "acme.docs",
      nativeToolName: "search",
    });
    const reads = port(server({ serverId: "acme.docs" }, "reads_free"), [
      tool({ readOnlyHint: true }, "search", "acme.docs"),
    ]);
    expect(await resolveMcpApprovalRelief(reads, { toolName: "mcp.acme.docs.search" }, binding)).toBeDefined();
    expect(reads.requireMcpServer).toHaveBeenCalledWith("acme.docs");
    await expect(resolveMcpApprovalRelief(reads, { toolName: "mcp.acme.docs.write" }, binding)).rejects.toThrow(
      /binding/,
    );
  });
});
