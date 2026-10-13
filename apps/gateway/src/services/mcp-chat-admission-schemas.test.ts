import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  type ChatTurnFeatureReferences,
  type McpRequesterAdmissionScope,
  type McpStaticAdmissionConnection,
} from "@goatcitadel/contracts";
import { createMcpRequesterAdmissionTurnContext } from "./mcp-requester-admission-context.js";
import { restoreMcpChatAdmissionSchemas } from "./mcp-chat-admission-schemas.js";
import type { NativeMcpChatToolSchema } from "./gateway/native-mcp-chat-catalog.js";

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
const staticReceipt: McpStaticAdmissionConnection = {
  version: "mcp.static.admission.v1",
  scope,
  serverId: "saved",
  transport: "http",
  configurationBindingId: "reviewed-config",
  connectionRevision: "b".repeat(64),
  serverRevision: "c".repeat(64),
  bindingSha256: "d".repeat(64),
  selectedTools: [
    {
      rawRemoteToolName: "read",
      canonicalToolName: "mcp.saved.read",
      modelName: `mcp_s_${"e".repeat(56)}`,
      inputSchema: { type: "object" },
      toolDefinitionSha256: "f".repeat(64),
    },
  ],
};
function fixture(kind: "static" | "requester" | "both" = "static") {
  const references: ChatTurnFeatureReferences = {
    version: "chat.turn.feature-references.v1",
    ...(kind !== "requester" ? { selectedStaticMcp: [staticReceipt] } : {}),
    ...(kind !== "static"
      ? {
          requesterConnections: [
            { connectionId: "actor-connection", generation: 1, schemaHash: "a".repeat(64), bindingId: "binding" },
          ],
        }
      : {}),
  };
  const binding = {
    references,
    referenceSha256: createHash("sha256").update(canonicalJsonString(references)).digest("hex"),
  };
  const assertCurrent = vi.fn(async () => undefined);
  const handle = createMcpRequesterAdmissionTurnContext(scope, binding.referenceSha256, assertCurrent);
  const schema = (name: string) =>
    ({
      canonicalName: name,
      modelName: name,
      providerDefinition: { type: "function", function: { name, parameters: {} } },
    }) as NativeMcpChatToolSchema;
  const ports = {
    readAdmission: vi.fn(async () => binding),
    restoreStatic: vi.fn(async () => [schema("static")]),
    restoreRequester: vi.fn(async () => [schema("requester")]),
  };
  return { references, binding, assertCurrent, handle, ports };
}
describe("canonical MCP admission schema composition", () => {
  it.each(["static", "requester", "both"] as const)("calls only the selected %s owners", async (kind) => {
    const f = fixture(kind);
    const result = await restoreMcpChatAdmissionSchemas(f.ports, f.handle);
    expect(result.map((tool) => tool.canonicalName)).toEqual(kind === "both" ? ["requester", "static"] : [kind]);
    expect(f.ports.restoreStatic).toHaveBeenCalledTimes(kind === "requester" ? 0 : 1);
    expect(f.ports.restoreRequester).toHaveBeenCalledTimes(kind === "static" ? 0 : 1);
    expect(f.assertCurrent).toHaveBeenCalledTimes(2);
  });
  it("rejects forged handles, changed evidence and stale claims before returning tools", async () => {
    const f = fixture();
    await expect(restoreMcpChatAdmissionSchemas(f.ports, {} as never)).rejects.toThrow(/live Chat admission/);
    f.references.selectedStaticMcp = [{ ...staticReceipt, connectionRevision: "0".repeat(64) }];
    await expect(restoreMcpChatAdmissionSchemas(f.ports, f.handle)).rejects.toThrow(/evidence changed/);
    expect(f.ports.restoreStatic).not.toHaveBeenCalled();
    const current = fixture();
    current.assertCurrent
      .mockImplementationOnce(async () => undefined)
      .mockRejectedValueOnce(new Error("claim revoked"));
    await expect(restoreMcpChatAdmissionSchemas(current.ports, current.handle)).rejects.toThrow("claim revoked");
  });
  it("refuses collisions across owners and propagates a live owner refusal", async () => {
    const f = fixture("both");
    f.ports.restoreStatic.mockImplementation(f.ports.restoreRequester);
    await expect(restoreMcpChatAdmissionSchemas(f.ports, f.handle)).rejects.toThrow(/ambiguous/);
    f.ports.restoreStatic.mockRejectedValue(new Error("connection revoked"));
    await expect(restoreMcpChatAdmissionSchemas(f.ports, f.handle)).rejects.toThrow("connection revoked");
  });
});
