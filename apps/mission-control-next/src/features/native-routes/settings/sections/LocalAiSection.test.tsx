import { describe, expect, it } from "vitest";
import type { LocalAiFitRecommendation } from "@goatcitadel/contracts";
import { groupLocalAiRecommendations } from "./LocalAiSection";

describe("groupLocalAiRecommendations", () => {
  it("groups backend-specific fit truth under one model without losing limitations", () => {
    const recommendations: LocalAiFitRecommendation[] = [
      {
        modelId: "qwen3-8b",
        backend: "llama_cpp",
        fit: "good",
        confidence: "high",
        reasons: ["Fits available memory."],
        limitations: ["CPU-only inference is slower."],
      },
      {
        modelId: "qwen3-8b",
        backend: "ollama",
        fit: "borderline",
        confidence: "medium",
        reasons: ["Fits available memory."],
        limitations: ["Runtime is not detected."],
      },
      {
        modelId: "large-model",
        backend: "vllm",
        fit: "not_recommended",
        confidence: "high",
        reasons: ["Insufficient accelerator memory."],
        limitations: [],
      },
    ];

    expect(groupLocalAiRecommendations(recommendations)).toEqual([
      {
        id: "qwen3-8b",
        label: "qwen3-8b",
        description: "Fits available memory. CPU-only inference is slower. Runtime is not detected.",
        meta: "llama_cpp: good (high) · ollama: borderline (medium)",
        actionLabel: "Candidate",
      },
      {
        id: "large-model",
        label: "large-model",
        description: "Insufficient accelerator memory.",
        meta: "vllm: not recommended (high)",
        actionLabel: "Advisory",
      },
    ]);
  });
});
