import { describe, expect, it } from "vitest";
import {
  createMcpToolPolicyBinding,
  readMcpToolPolicyBinding,
  readMcpPolicyTargetFromWrapper,
  type McpToolPolicyBinding,
} from "./mcp-tool-policy-binding.js";

const mapping = { canonicalName: "mcp.docs.v1.read.items", serverId: "docs.v1", nativeToolName: "read.items" };
describe("native MCP policy binding", () => {
  it("projects the wrapper's normalized target without creating dispatch authority", () => {
    const projected = readMcpPolicyTargetFromWrapper({
      toolName: "mcp.invoke",
      args: { serverId: " docs.v1 ", toolName: " read.items ", canonicalName: "mcp.forged.target" },
    });
    expect(projected).toEqual({ ...mapping, policyToolName: "mcp.invoke" });
    expect(() => readMcpToolPolicyBinding(projected as unknown as McpToolPolicyBinding, mapping.canonicalName)).toThrow(
      /binding/,
    );
    expect(readMcpPolicyTargetFromWrapper({ toolName: mapping.canonicalName, args: {} })).toBeUndefined();
    expect(readMcpPolicyTargetFromWrapper({ toolName: "mcp.invoke", args: {} })).toBeUndefined();
    expect(() =>
      readMcpPolicyTargetFromWrapper({ toolName: "mcp.invoke", args: { serverId: "docs", toolName: "bad/name" } }),
    ).toThrow(/Invalid/);
  });
  it("retains explicit dotted identities without inferring a server by splitting dots", () => {
    const input = { ...mapping };
    const binding = createMcpToolPolicyBinding(input);
    input.serverId = "changed";
    expect(readMcpToolPolicyBinding(binding, mapping.canonicalName)).toEqual({
      ...mapping,
      policyToolName: "mcp.invoke",
    });
    expect(() => JSON.stringify(binding)).toThrow(/cannot be serialized/);
    expect(() => readMcpToolPolicyBinding({ ...binding }, mapping.canonicalName)).toThrow(/binding/);
    expect(() => readMcpToolPolicyBinding(binding, "mcp.other.tool")).toThrow(/binding/);
    expect(() => readMcpToolPolicyBinding({} as McpToolPolicyBinding, mapping.canonicalName)).toThrow(/binding/);
  });
  it.each([
    { ...mapping, serverId: "" },
    { ...mapping, nativeToolName: "" },
    { ...mapping, canonicalName: "mcp.invoke" },
    { ...mapping, canonicalName: "mcp.other.tool" },
    { canonicalName: "mcp.docs.read/../../file", serverId: "docs", nativeToolName: "read/../../file" },
  ])("rejects invalid mapping $canonicalName", (input) => {
    expect(() => createMcpToolPolicyBinding(input)).toThrow(/Invalid/);
  });
});
