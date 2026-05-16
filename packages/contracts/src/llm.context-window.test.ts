import { describe, it, expectTypeOf } from "vitest";
import type { LlmApiStyle, LlmModelRecord, LlmProviderSummary, LlmRuntimeConfig } from "./llm.js";

describe("LLM context-window and output-token-limit fields", () => {
  it("LlmModelRecord accepts contextWindow and outputTokenLimit", () => {
    expectTypeOf<LlmModelRecord>().toHaveProperty("contextWindow").toEqualTypeOf<number | undefined>();
    expectTypeOf<LlmModelRecord>().toHaveProperty("outputTokenLimit").toEqualTypeOf<number | undefined>();
  });

  it("LlmProviderSummary accepts activeModelContextWindow and activeModelOutputTokenLimit", () => {
    expectTypeOf<LlmProviderSummary>().toHaveProperty("activeModelContextWindow").toEqualTypeOf<number | undefined>();
    expectTypeOf<LlmProviderSummary>()
      .toHaveProperty("activeModelOutputTokenLimit")
      .toEqualTypeOf<number | undefined>();
  });

  it("LlmRuntimeConfig accepts activeModelContextWindow and activeModelOutputTokenLimit", () => {
    expectTypeOf<LlmRuntimeConfig>().toHaveProperty("activeModelContextWindow").toEqualTypeOf<number | undefined>();
    expectTypeOf<LlmRuntimeConfig>().toHaveProperty("activeModelOutputTokenLimit").toEqualTypeOf<number | undefined>();
  });

  it("LlmApiStyle includes bedrock-messages", () => {
    expectTypeOf<"bedrock-messages">().toMatchTypeOf<LlmApiStyle>();
  });
});
