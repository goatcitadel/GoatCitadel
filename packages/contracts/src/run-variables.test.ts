import { describe, expect, it } from "vitest";
import {
  buildRunVariableEvidence,
  hashRunVariableSchema,
  legacyPlaceholderSchema,
  resolveLegacyRunVariableTemplate,
  resolveRunVariableTemplate,
  RUN_VARIABLE_SCHEMA_VERSION,
  validateRunVariableBindings,
  type RunVariableSchema,
} from "./run-variables.js";

const schema: RunVariableSchema = {
  version: RUN_VARIABLE_SCHEMA_VERSION,
  fields: [
    { id: "topic", label: "Topic", type: "text", required: true, maxLength: 20 },
    { id: "count", label: "Count", type: "number", minimum: 1, maximum: 5, default: 2 },
    { id: "public", label: "Public", type: "boolean", default: false },
    { id: "format", label: "Format", type: "select", options: [{ value: "brief", label: "Brief" }] },
    { id: "source", label: "Source", type: "url" },
    { id: "due", label: "Due", type: "datetime" },
  ],
};

describe("typed run variables", () => {
  it("validates, defaults, resolves, and hashes deterministically", () => {
    const values = {
      topic: "goats",
      format: "brief",
      source: "https://example.test/a",
      due: "2026-07-28T09:30:00-07:00",
    };
    const result = validateRunVariableBindings(schema, values);
    expect(result.bindings).toEqual({ ...values, count: 2, public: false });
    expect(result.schemaHash).toBe(hashRunVariableSchema({ ...schema, fields: [...schema.fields] }));
    expect(resolveRunVariableTemplate("Write {{topic}} as {{format}}.", schema, result.bindings)).toBe(
      "Write goats as brief.",
    );
    const evidence = buildRunVariableEvidence(
      {
        ownerKind: "prompt_pack",
        ownerId: "pack-1",
        ownerRevision: "rev-1",
        schemaHash: result.schemaHash,
        values: result.bindings,
      },
      schema,
      "Write goats as brief.",
    );
    expect(evidence.bindings).toEqual(result.bindings);
    expect(evidence.resolvedInputHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects undeclared, stale, malformed, and out-of-bounds values", () => {
    expect(() => validateRunVariableBindings(schema, { topic: "goats", surprise: true })).toThrow(/Undeclared/u);
    expect(() => validateRunVariableBindings(schema, { topic: "this topic is much too long" })).toThrow(/length/u);
    expect(() => validateRunVariableBindings(schema, { topic: "goats", source: "file:///tmp/a" })).toThrow(/HTTP/u);
    expect(() => validateRunVariableBindings(schema, { topic: "goats", due: "2026-07-28T09:30:00" })).toThrow(
      /timezone/u,
    );
    expect(() => resolveRunVariableTemplate("{{not_declared}}", schema, { topic: "goats" })).toThrow(/undeclared/u);
    expect(() =>
      buildRunVariableEvidence(
        {
          ownerKind: "agent_preset",
          ownerId: "a",
          ownerRevision: "1",
          schemaHash: "stale",
          values: { topic: "goats" },
        },
        schema,
        "goats",
      ),
    ).toThrow(/schema changed/u);
  });

  it("normalizes legacy placeholders to required text fields", () => {
    expect(legacyPlaceholderSchema(["<TOPIC>", "<LOCAL PATH>"]).fields).toMatchObject([
      { id: "topic", type: "text", required: true },
      { id: "local_path", type: "text", required: true },
    ]);
  });

  it("resolves only declared legacy placeholders", () => {
    const legacySchema = legacyPlaceholderSchema(["<TOPIC>"]);
    expect(resolveLegacyRunVariableTemplate("Explain <TOPIC>", legacySchema, { topic: "leases" })).toBe(
      "Explain leases",
    );
    expect(() => resolveLegacyRunVariableTemplate("Explain <SECRET>", legacySchema, { topic: "leases" })).toThrow(
      /undeclared/u,
    );
  });
});
