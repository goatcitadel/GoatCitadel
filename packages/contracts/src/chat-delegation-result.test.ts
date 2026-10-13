import { describe, expect, it } from "vitest";
import { readChatDelegationResultSchema, validateChatDelegationResult } from "./chat-delegation-result.js";

const schema = {
  type: "object",
  properties: {
    answer: { type: "string", maxLength: 100 },
    evidence: { type: "array", maxItems: 3, items: { type: "integer", minimum: 0 } },
  },
  required: ["answer", "evidence"],
  additionalProperties: false,
};
describe("bounded delegated result contracts", () => {
  it("validates exact JSON without coercion, defaults or stripping extra properties", () => {
    expect(readChatDelegationResultSchema(schema)).toEqual(schema);
    expect(validateChatDelegationResult(schema, '{"answer":"yes","evidence":[1,2]}')).toBe(true);
    for (const value of [
      '{"answer":"yes"}',
      '{"answer":"yes","evidence":["1"]}',
      '{"answer":"yes","evidence":[1],"extra":true}',
      "```json\n{}\n```",
      "{}",
    ]) {
      expect(validateChatDelegationResult(schema, value)).toBe(false);
    }
  });
  it.each([
    { type: "string" },
    { type: "array", items: { type: "null" } },
    { type: "string", maxLength: 10, pattern: "(a+)+$" },
    { type: "object", properties: {}, additionalProperties: true },
    { $ref: "https://example.test/schema" },
    { type: "string", maxLength: 8193 },
    { type: "array", maxItems: 129, items: { type: "null" } },
    { type: "boolean", unknown: true },
  ])("rejects unbounded or unsupported schema %s", (value) =>
    expect(() => readChatDelegationResultSchema(value)).toThrow(),
  );
  it("bounds depth, bytes and result size", () => {
    let deep: Record<string, unknown> = { type: "null" };
    for (let i = 0; i < 8; i++) deep = { type: "array", maxItems: 1, items: deep };
    expect(() => readChatDelegationResultSchema(deep)).toThrow();
    expect(() =>
      readChatDelegationResultSchema({
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          Array.from({ length: 32 }, (_, i) => [
            String(i),
            { type: "string", maxLength: 100, description: "x".repeat(500) },
          ]),
        ),
      }),
    ).toThrow();
    expect(validateChatDelegationResult(schema, " ".repeat(65537) + "{}")).toBe(false);
  });
});
