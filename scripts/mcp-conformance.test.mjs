import assert from "node:assert/strict";
import { describe, it } from "node:test";

const fixtures = [
  {
    name: "initialize",
    request: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "goatcitadel-conformance", version: "1.0.0" },
      },
    },
    response: {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "goatcitadel", version: "1.0.0" },
      },
    },
  },
  {
    name: "tools/list",
    request: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    response: {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "goatcitadel.mcp.call_preview",
            description: "Preview a governed MCP tool call without invoking it.",
            inputSchema: { type: "object", properties: {}, additionalProperties: true },
          },
        ],
      },
    },
  },
  {
    name: "tools/call preview",
    request: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "goatcitadel.mcp.call_preview",
        arguments: { serverId: "local", toolName: "list" },
      },
    },
    response: {
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [{ type: "text", text: "preview only" }],
        isError: false,
        _meta: {
          sideEffectPosture: "preview_only",
          policy: "gateway_owned",
        },
      },
    },
  },
];

describe("MCP conformance fixtures", () => {
  for (const fixture of fixtures) {
    it(`accepts ${fixture.name} JSON-RPC envelopes`, () => {
      assertMcpRequestEnvelope(fixture.request);
      assertMcpResponseEnvelope(fixture.response, fixture.request.id);
    });
  }

  it("rejects malformed protocol envelopes before runtime invocation", () => {
    assert.throws(
      () =>
        assertMcpRequestEnvelope({
          id: 4,
          method: "tools/list",
          params: {},
        }),
      /jsonrpc/,
    );
    assert.throws(
      () =>
        assertMcpRequestEnvelope({
          jsonrpc: "2.0",
          id: 5,
          params: {},
        }),
      /method/,
    );
  });

  it("keeps conformance scope outside Docker/Linux command resolution", () => {
    const methods = fixtures.map((fixture) => fixture.request.method);
    assert.deepEqual(methods, ["initialize", "tools/list", "tools/call"]);
  });
});

function assertMcpRequestEnvelope(value) {
  assert.equal(value?.jsonrpc, "2.0", "request jsonrpc must be 2.0");
  assert.ok(typeof value.id === "number" || typeof value.id === "string", "request id must be scalar");
  assert.equal(typeof value.method, "string", "request method must be a string");
  assert.ok(value.params === undefined || isRecord(value.params), "request params must be an object when present");
}

function assertMcpResponseEnvelope(value, expectedId) {
  assert.equal(value?.jsonrpc, "2.0", "response jsonrpc must be 2.0");
  assert.equal(value.id, expectedId, "response id must match request id");
  assert.ok(isRecord(value.result) || isRecord(value.error), "response must include result or error object");
  if (value.result?.tools) {
    assert.ok(Array.isArray(value.result.tools), "tools/list result must include a tools array");
    for (const tool of value.result.tools) {
      assert.equal(typeof tool.name, "string", "tool name must be a string");
      assert.equal(typeof tool.description, "string", "tool description must be a string");
      assert.ok(isRecord(tool.inputSchema), "tool inputSchema must be an object");
    }
  }
  if (value.result?.content) {
    assert.ok(Array.isArray(value.result.content), "tools/call result must include content array");
    assert.equal(value.result._meta?.sideEffectPosture, "preview_only");
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
