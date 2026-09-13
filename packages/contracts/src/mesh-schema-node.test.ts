import { describe, expect, it } from "vitest";
import { MeshSchemaValidationError, validateMeshCapabilityInput, validateMeshCapabilityJson } from "./mesh-schema-node.js";
import { MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION, type MeshMcpServerCapabilityDescriptor } from "./mesh-capability-publication.js";

const check = (schema: unknown, value: unknown, signal?: AbortSignal) =>
  validateMeshCapabilityJson(JSON.stringify(schema), JSON.stringify(value), signal);

describe("bounded published JSON Schema validation", () => {
  it("enforces published MCP selector names and leaves native schema validation with the local owner", async () => {
    const descriptor: MeshMcpServerCapabilityDescriptor = {
      kind: "mcp_server", title: "Native fixture", semanticVersion: "1.0.0", effectPosture: "unknown",
      permissions: { schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION, filesystemRead: [], filesystemWrite: [],
        networkOrigins: [], environmentNames: [], deviceCapabilities: [] },
      resourceLimits: { timeoutMs: 30_000, maxRequestBytes: 1024, maxResponseBytes: 1024 },
      healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 30_000, timeoutMs: 5_000 },
      protocol: "mcp", protocolVersion: "2025-11-25", tools: [{ name: "native.echo", inputSchemaSha256: "a".repeat(64) }],
    };
    await expect(validateMeshCapabilityInput(descriptor, JSON.stringify({ toolName: "native.echo", arguments: { value: 1 } })))
      .resolves.toBeUndefined();
    for (const input of [{ toolName: "unknown", arguments: {} }, { toolName: "native.echo", arguments: [] },
      { toolName: "native.echo", arguments: {}, endpoint: "unapproved" }])
      await expect(validateMeshCapabilityInput(descriptor, JSON.stringify(input))).rejects.toMatchObject({ reason: "invalid" });
  });

  it("enforces draft 2020-12 references, composition and unevaluated properties", async () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { positive: { type: "integer", minimum: 1 } },
      type: "object",
      allOf: [{ properties: { count: { $ref: "#/$defs/positive" } }, required: ["count"] }],
      unevaluatedProperties: false,
    };
    await expect(check(schema, { count: 2 })).resolves.toBeUndefined();
    for (const value of [{ count: "2" }, { count: 0 }, {}, { count: 2, extra: true }])
      await expect(check(schema, value)).rejects.toMatchObject({ reason: "invalid" });
  });

  it("validates tuples, formats and object requirements without changing input", async () => {
    const schema = { type: "object", properties: {
      pair: { type: "array", prefixItems: [{ type: "string", format: "date" }, { type: "integer" }],
        minItems: 2, maxItems: 2 },
      added: { type: "string", default: "not approved" },
    }, required: ["pair"], additionalProperties: false };
    const input = { pair: ["2026-09-11", 1] };
    await expect(check(schema, input)).resolves.toBeUndefined();
    expect(input).toEqual({ pair: ["2026-09-11", 1] });
    for (const pair of [["invalid", 1], ["2026-09-11", "1"], ["2026-09-11", 1, 2]])
      await expect(check(schema, { pair })).rejects.toMatchObject({ reason: "invalid" });
  });

  it("distinguishes schema references from literal data and property names", async () => {
    const value = { $ref: "literal value", nested: { $async: "literal value" } };
    const schema = { type: "object", properties: {
      $ref: { const: "literal value" }, nested: { const: { $async: "literal value" } },
    }, required: ["$ref", "nested"], additionalProperties: false };
    await expect(check(schema, value)).resolves.toBeUndefined();
  });

  it.each([
    { type: "object", $ref: "https://example.invalid/private-schema" },
    { type: "object", $ref: "relative-schema.json" },
    { type: "object", $dynamicRef: "https://example.invalid/dynamic" },
    { type: "object", properties: { nested: { $ref: "relative-schema.json" } } },
    { type: "object", $async: true },
    { type: "object", unsupportedKeyword: true },
    { type: "object", required: "invalid" },
    { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
  ])("rejects unavailable or unsupported schemas without exposing content: %j", async (schema) => {
    const error = await check(schema, { confidential: "private payload" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(MeshSchemaValidationError);
    expect(String(error)).toBe("MeshSchemaValidationError: Mesh capability schema validation invalid.");
  });

  it("bounds encoded sizes, depth and malformed JSON", async () => {
    await expect(validateMeshCapabilityJson("not JSON", "{}")).rejects.toMatchObject({ reason: "invalid" });
    await expect(check({ type: "string" }, "x".repeat(512 * 1024))).rejects.toMatchObject({ reason: "invalid" });
    let nested: unknown = "value";
    for (let i = 0; i < 35; i += 1) nested = [nested];
    await expect(check({ type: "array" }, nested)).rejects.toMatchObject({ reason: "invalid" });
  });

  it("terminates pathological regex validation while the main event loop stays responsive", async () => {
    let ticks = 0;
    const pulse = setInterval(() => { ticks += 1; }, 25);
    const startedAt = performance.now();
    try {
      await expect(check({ type: "string", pattern: "^(a+)+$" }, "a".repeat(50) + "!"))
        .rejects.toMatchObject({ reason: "unavailable" });
      expect(ticks).toBeGreaterThan(5);
      expect(performance.now() - startedAt).toBeLessThan(8_000);
    } finally { clearInterval(pulse); }
    // A subsequent real validation proves the terminated isolate released its slot.
    await expect(check({ type: "object" }, {})).resolves.toBeUndefined();
  }, 15_000);

  it("bounds concurrency and joins cancellation before accepting new validations", async () => {
    const controller = new AbortController();
    const work = Array.from({ length: 4 }, () =>
      check({ type: "string", pattern: "^(a+)+$" }, "a".repeat(50) + "!", controller.signal)
        .then(() => "unexpected success", (error: MeshSchemaValidationError) => error.reason));
    await expect(check({ type: "object" }, {})).rejects.toMatchObject({ reason: "unavailable" });
    controller.abort();
    expect(await Promise.all(work)).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
    await expect(check({ type: "object" }, {})).resolves.toBeUndefined();
    await expect(check({ type: "object" }, {}, AbortSignal.abort())).rejects.toMatchObject({ reason: "unavailable" });
  });
});
