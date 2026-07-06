import { describe, expect, it } from "vitest";
import {
  evaluateModelRouteForProvider,
  type ModelRouteProviderPosture,
  type ModelRouteVerdict,
  type ModelRoutingDecision,
} from "./citadel-model-routing.js";
import { isAggregatorProvider } from "./provider-templates.js";

const LOCAL: ModelRouteProviderPosture = { isLocal: true, isAggregator: false };
const CLOUD: ModelRouteProviderPosture = { isLocal: false, isAggregator: false };
const AGGREGATOR: ModelRouteProviderPosture = { isLocal: false, isAggregator: true };

// Full 6×3 posture matrix. Deny-wins: an aggregator is cloud AND additionally
// denied wherever the decision prefers local execution, because its ultimate
// model host is obscured.
const MATRIX: Array<[ModelRoutingDecision, ModelRouteVerdict, ModelRouteVerdict, ModelRouteVerdict]> = [
  // decision, local, cloud, aggregator
  ["any_approved", "allowed", "allowed", "allowed"],
  ["approved_cloud_or_local", "allowed", "allowed", "allowed"],
  ["cloud_with_approval", "allowed", "requires_approval", "requires_approval"],
  ["prefer_local", "allowed", "requires_disclosure", "denied"],
  ["local_only", "allowed", "denied", "denied"],
  ["never_send", "denied", "denied", "denied"],
];

describe("evaluateModelRouteForProvider", () => {
  it.each(MATRIX)("%s → local:%s cloud:%s aggregator:%s", (decision, local, cloud, aggregator) => {
    expect(evaluateModelRouteForProvider(decision, LOCAL)).toBe(local);
    expect(evaluateModelRouteForProvider(decision, CLOUD)).toBe(cloud);
    expect(evaluateModelRouteForProvider(decision, AGGREGATOR)).toBe(aggregator);
  });

  it("treats a contradictory local+aggregator posture as an aggregator (deny-wins)", () => {
    const contradictory: ModelRouteProviderPosture = { isLocal: true, isAggregator: true };
    expect(evaluateModelRouteForProvider("prefer_local", contradictory)).toBe("denied");
    expect(evaluateModelRouteForProvider("local_only", contradictory)).toBe("denied");
  });
});

describe("isAggregatorProvider", () => {
  it("classifies the aggregator templates and nothing else", () => {
    expect(isAggregatorProvider("openrouter")).toBe(true);
    expect(isAggregatorProvider("vercel")).toBe(true);
    expect(isAggregatorProvider("huggingface")).toBe(true);
    expect(isAggregatorProvider(" OpenRouter ")).toBe(true);
    for (const local of ["ollama", "llamacpp", "lmstudio", "localai", "genie-ir20"]) {
      expect(isAggregatorProvider(local), `${local} is a local engine, not an aggregator`).toBe(false);
    }
    for (const direct of ["anthropic", "openai", "google", "glm", "moonshot", "perplexity", "mistral", "deepseek"]) {
      expect(isAggregatorProvider(direct), `${direct} is a direct provider`).toBe(false);
    }
  });
});
