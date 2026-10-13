import { describe, expect, it } from "vitest";
import {
  estimateSerializedProviderSchemaTokens,
  selectBoundedProviderSchemas,
  type ProviderSchemaCandidate,
} from "./chat-tool-schema-budget.js";

const candidate = (name: string, description = "A tool"): ProviderSchemaCandidate => ({
  canonicalName: name,
  modelName: name,
  definition: { type: "function", function: { name, description, parameters: {} } },
});

describe("serialized provider schema budget", () => {
  it("merges identical required candidates without inflating schemas or deferred counts", () => {
    const tool = candidate("read");
    const entries = [
      tool,
      { ...tool, requiredReason: "explicit" as const },
      { ...tool, requiredReason: "essential" as const },
    ];
    const before = JSON.stringify(entries);
    const result = selectBoundedProviderSchemas(entries, 0, 0);
    expect(result.selected).toEqual([{ ...tool, requiredReason: "essential" }]);
    expect(result.diagnostics).toMatchObject({
      candidateCount: 1,
      duplicateCandidateCount: 2,
      selectedCount: 1,
      deferredCount: 0,
      exceptions: [{ toolName: "read", reason: "essential" }],
    });
    expect(result.diagnostics.estimatedSchemaTokens).toBe(estimateSerializedProviderSchemaTokens([tool.definition]));
    expect(JSON.stringify(entries)).toBe(before);
  });

  it("merges schema objects independent of property insertion order", () => {
    const tool = candidate("read");
    const reordered = { function: { parameters: {}, description: "A tool", name: "read" }, type: "function" };
    expect(selectBoundedProviderSchemas([tool, { ...tool, definition: reordered }]).selected).toHaveLength(1);
  });

  it("refuses conflicting schema, alias and provider model-name bindings even when deferred", () => {
    const tool = candidate("read");
    for (const conflicting of [
      candidate("read", "Different schema"),
      { ...tool, modelName: "another_alias" },
      { ...tool, canonicalName: "different.tool" },
    ])
      expect(() => selectBoundedProviderSchemas([tool, conflicting], 0, 0)).toThrow("conflicting");
  });

  it("uses final provider JSON bytes, including schema contents and multibyte metadata", () => {
    const small = candidate("small");
    const huge = candidate("huge", "操作".repeat(2500));
    const result = selectBoundedProviderSchemas([huge, small]);
    expect(result.selected.map((entry) => entry.canonicalName)).toEqual(["small"]);
    expect(result.diagnostics.estimatedSchemaTokens).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify([small.definition]), "utf8") / 3),
    );
    expect(estimateSerializedProviderSchemaTokens([huge.definition])).toBeGreaterThan(2200);
  });

  it("keeps essential and explicit tools beyond soft limits and reports the exception", () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      ...candidate(`tool.${index}`, "x".repeat(1500)),
      requiredReason: "explicit" as const,
    }));
    const result = selectBoundedProviderSchemas([...entries, candidate("optional")]);
    expect(result.selected).toHaveLength(10);
    expect(result.diagnostics).toMatchObject({ exceededToolCap: true, exceededTokenBudget: true, deferredCount: 1 });
    expect(result.diagnostics.exceptions).toHaveLength(10);
  });

  it("limits ordinary tools to eight and returns stable provider ordering", () => {
    const result = selectBoundedProviderSchemas(
      Array.from({ length: 20 }, (_, index) => candidate(`tool.${String(20 - index).padStart(2, "0")}`)),
    );
    expect(result.selected).toHaveLength(8);
    expect(result.selected.map((entry) => entry.canonicalName)).toEqual(
      [...result.selected].map((entry) => entry.canonicalName).sort(),
    );
  });
});
