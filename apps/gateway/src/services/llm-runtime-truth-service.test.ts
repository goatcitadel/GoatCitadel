import { describe, expect, it } from "vitest";
import type { LlmEvalProofRunRecord, LlmRuntimeMeasurementRecord } from "@goatcitadel/contracts";
import {
  buildLlmRuntimeMeasurementRecord,
  inferRuntimeEngineKind,
  LlmRuntimeTruthService,
} from "./llm-runtime-truth-service.js";

describe("LlmRuntimeTruthService", () => {
  it("builds measured records without fabricating unavailable metrics", () => {
    const record = buildLlmRuntimeMeasurementRecord({
      providerId: "ollama",
      model: "llama3",
      provider: { providerId: "ollama", baseUrl: "http://127.0.0.1:11434/v1" },
      response: {
        model: "llama3",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
        },
      },
      stream: false,
      startedAt: 1000,
      completedAt: 3000,
      path: "chat_completion",
      status: "completed",
    });

    expect(record).toMatchObject({
      providerId: "ollama",
      model: "llama3",
      engineKind: "ollama",
      source: "live",
      status: "completed",
      metrics: {
        latencyMs: 2000,
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        estimatedCostUsd: 0,
      },
    });
    expect(record.metrics.energyJoules).toBeUndefined();
  });

  it("reports local engine fit and eval Pareto evidence from stored measurements only", async () => {
    const measurements: LlmRuntimeMeasurementRecord[] = [
      {
        measurementId: "m-fast",
        providerId: "ollama",
        model: "llama3",
        engineKind: "ollama",
        source: "live",
        status: "completed",
        stream: false,
        collectedAt: "2026-05-29T00:00:00.000Z",
        metrics: { latencyMs: 1000, estimatedCostUsd: 0 },
        provenance: { collector: "gateway", path: "chat_completion" },
      },
      {
        measurementId: "m-slow",
        providerId: "remote",
        model: "model",
        engineKind: "remote_api",
        source: "live",
        status: "completed",
        stream: false,
        collectedAt: "2026-05-29T00:01:00.000Z",
        metrics: { latencyMs: 8000, estimatedCostUsd: 0.04 },
        provenance: { collector: "gateway", path: "chat_completion" },
      },
    ];
    const evalRuns: LlmEvalProofRunRecord[] = [];
    const service = new LlmRuntimeTruthService({
      storage: {
        llmRuntimeMeasurements: {
          insert: (record) => record,
          list: () => measurements,
          latest: (providerId, model) =>
            measurements.find((item) => item.providerId === providerId && item.model === model),
        },
        llmEvalProofRuns: {
          insert: (record) => {
            evalRuns.push(record);
            return record;
          },
          list: () => evalRuns,
          get: (runId) => evalRuns.find((run) => run.runId === runId),
        },
      },
      listProviders: () => [
        {
          providerId: "ollama",
          label: "Ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "llama3",
          hasApiKey: true,
          apiKeySource: "env",
        },
      ],
    });

    expect((await service.listLocalEngines()).items.find((item) => item.engineKind === "ollama")).toMatchObject({
      configured: true,
      fit: "strong",
      measurementSource: "live",
    });

    const proof = await service.runEvalProof({
      prompt: "Compare providers",
      candidates: [
        { providerId: "ollama", model: "llama3", qualityScore: 0.8 },
        { providerId: "remote", model: "model", qualityScore: 0.8 },
      ],
    });

    expect(proof.run.results.find((item) => item.providerId === "ollama")?.paretoOptimal).toBe(true);
    expect(proof.run.results.find((item) => item.providerId === "remote")?.paretoOptimal).toBe(false);
    expect(proof.run.warnings.join(" ")).toContain("does not call providers");

    const exported = await service.exportEvalProofRuns(5);
    expect(exported).toMatchObject({
      version: "llm.eval_proof_export.v1",
      format: "json",
      contentType: "application/json",
      sourceEndpoint: "/api/v1/llm/eval-proof?limit=5",
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
      },
      runs: [expect.objectContaining({ runId: proof.run.runId })],
    });
    expect(exported.content).toContain('"version": "llm.eval_proof_export.v1"');
    expect(exported.content).toContain("does not call providers");
  });

  it("infers known local engine kinds conservatively", () => {
    expect(inferRuntimeEngineKind({ providerId: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" })).toBe("lmstudio");
    expect(inferRuntimeEngineKind({ providerId: "openai", baseUrl: "https://api.openai.com/v1" })).toBe("remote_api");
  });
});
