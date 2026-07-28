import { describe, expect, it } from "vitest";
import { RUN_VARIABLE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { parsePromptPackRunVariableSchema, renderPromptPackRunVariableSchema } from "./run-variable-markdown.js";

describe("prompt-pack run-variable markdown", () => {
  it("round trips one deterministic JSON fence", () => {
    const schema = {
      version: RUN_VARIABLE_SCHEMA_VERSION,
      fields: [{ id: "topic", label: "Topic", type: "text" as const, required: true }],
    };
    const markdown = renderPromptPackRunVariableSchema(schema).join("\n");
    expect(parsePromptPackRunVariableSchema(markdown)).toEqual({
      ...schema,
      fields: [{ ...schema.fields[0], maxLength: 4000 }],
    });
  });

  it("rejects ambiguous or malformed fences", () => {
    expect(() =>
      parsePromptPackRunVariableSchema("```goatcitadel-variables\n{}\n```\n```goatcitadel-variables\n{}\n```"),
    ).toThrow(/only one/u);
    expect(() => parsePromptPackRunVariableSchema("```goatcitadel-variables\nnope\n```")).toThrow(/Invalid/u);
  });
});
