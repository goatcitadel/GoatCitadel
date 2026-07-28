import { describe, expect, it } from "vitest";
import { RUN_VARIABLE_SCHEMA_VERSION, hashRunVariableSchema, type PromptPackRecord } from "@goatcitadel/contracts";
import { resolvePromptPackRunVariables } from "./prompt-pack-service.js";

const schema = {
  version: RUN_VARIABLE_SCHEMA_VERSION,
  fields: [{ id: "topic", label: "Topic", type: "text" as const, required: true }],
};
const pack: PromptPackRecord = {
  packId: "pack-1",
  name: "Typed pack",
  testCount: 1,
  runVariableSchema: schema,
  runVariableSchemaHash: hashRunVariableSchema(schema),
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

describe("resolvePromptPackRunVariables", () => {
  it("resolves typed and legacy templates with evidence over the final prompt", () => {
    const hashes: string[] = [];
    for (const prompt of ["Explain {{topic}}.", "Explain <TOPIC>."]) {
      const result = resolvePromptPackRunVariables(pack, prompt, {
        bindings: { topic: "leases" },
        schemaHash: hashRunVariableSchema(schema),
      });
      expect(result.prompt).toBe("Explain leases.");
      expect(result.evidence?.resolvedInputHash).toMatch(/^[a-f0-9]{64}$/u);
      hashes.push(result.evidence!.resolvedInputHash);
    }
    expect(new Set(hashes).size).toBe(1);
  });

  it("rejects undeclared and stale input", () => {
    expect(() =>
      resolvePromptPackRunVariables(pack, "{{topic}}", {
        bindings: { topic: "leases", surprise: "injected" },
        schemaHash: hashRunVariableSchema(schema),
      }),
    ).toThrow(/Undeclared/u);
    expect(() =>
      resolvePromptPackRunVariables(pack, "{{topic}}", {
        bindings: { topic: "leases" },
        schemaHash: "0".repeat(64),
      }),
    ).toThrow(/schema changed/u);
  });
});
