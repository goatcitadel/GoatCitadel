import { describe, expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest, LocalAiHardwareSnapshot } from "@goatcitadel/contracts";
import {
  LOCAL_AI_BUILTIN_CATALOG,
  buildLocalAiFitRecommendations,
  createLocalAiRouteService,
} from "./local-ai-route-service.js";

const SMALL_MODEL_ID = "llama3.2:3b-instruct-q4_K_M";
const LARGE_MODEL_ID = "mixtral:8x7b-instruct-q4_K_M";

describe("local AI route service", () => {
  it("returns a readiness snapshot with catalog, fit recommendations, and in-memory state", async () => {
    const service = createLocalAiRouteService({
      clock: fixedClock,
      hardwareSnapshot: async () => hardwareSnapshot({ totalGiB: 32, detectedBackends: ["ollama"] }),
      idFactory: idSequence(),
    });

    const readiness = await service.getReadiness();

    expect(readiness.hardware.memory.totalBytes).toBe(32 * 1024 * 1024 * 1024);
    expect(readiness.hardware.runtimes).toEqual(
      expect.arrayContaining([expect.objectContaining({ backend: "ollama", detected: true })]),
    );
    expect(readiness.catalog.map((item) => item.modelId)).toContain(SMALL_MODEL_ID);
    expect(readiness.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: SMALL_MODEL_ID,
          backend: "ollama",
          fit: "excellent",
        }),
      ]),
    );
    expect(readiness.downloads).toEqual([]);
    expect(readiness.serveJobs).toEqual([]);
    expect(readiness.endpoints).toEqual([]);
  });

  it("scores small CPU-friendly models above oversized server models on constrained hardware", () => {
    const recommendations = buildLocalAiFitRecommendations(
      hardwareSnapshot({
        totalGiB: 16,
        detectedBackends: ["ollama"],
      }),
      LOCAL_AI_BUILTIN_CATALOG,
    );

    const small = findRecommendation(recommendations, SMALL_MODEL_ID, "ollama");
    const large = findRecommendation(recommendations, LARGE_MODEL_ID, "vllm");

    expect(small.fit).toBe("excellent");
    expect(small.reasons).toEqual(expect.arrayContaining([expect.stringContaining("system memory")]));
    expect(large.fit).toBe("not_recommended");
    expect(large.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("exceeds the conservative system-memory budget")]),
    );
  });

  it("keeps download, serve, and stop jobs approval-required by default", async () => {
    const service = createLocalAiRouteService({
      clock: fixedClock,
      hardwareSnapshot: async () => hardwareSnapshot({ totalGiB: 32, detectedBackends: ["ollama"] }),
      idFactory: idSequence(),
    });

    const download = await service.startDownload({ modelId: SMALL_MODEL_ID, backend: "ollama" });
    const serve = await service.startServe({ modelId: SMALL_MODEL_ID, backend: "ollama", port: 11435 });
    const stop = await service.requestServeStop(serve.jobId);
    const readiness = await service.getReadiness();

    expect(download).toEqual(
      expect.objectContaining({
        status: "requires_approval",
        approvalId: "local-ai-approval-download-id-1",
        progressPercent: 0,
      }),
    );
    expect(serve).toEqual(
      expect.objectContaining({
        status: "requires_approval",
        approvalId: "local-ai-approval-serve-id-2",
        endpointUrl: "http://127.0.0.1:11435",
        health: "unknown",
      }),
    );
    expect(stop).toEqual(
      expect.objectContaining({
        jobId: serve.jobId,
        status: "requires_approval",
        approvalId: "local-ai-approval-serve-stop-id-3",
        health: "unknown",
      }),
    );
    expect(readiness.downloads).toEqual([download]);
    expect(readiness.serveJobs).toEqual([stop]);
  });

  it("uses the Gateway approval lifecycle when local AI actions are requested", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createLocalAiRouteService({
      clock: fixedClock,
      createApproval,
      hardwareSnapshot: async () => hardwareSnapshot({ totalGiB: 32, detectedBackends: ["ollama"] }),
      idFactory: idSequence(),
    });

    const serve = await service.startServe({ modelId: SMALL_MODEL_ID, backend: "ollama", port: 11435 });

    expect(serve).toEqual(
      expect.objectContaining({
        status: "requires_approval",
        approvalId: "22222222-2222-4222-8222-222222222222",
      }),
    );
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "local_ai.serve",
        riskLevel: "danger",
        payload: expect.objectContaining({
          action: "serve",
          modelId: SMALL_MODEL_ID,
          backend: "ollama",
          port: 11435,
        }),
      }),
    );
  });

  it("records endpoint registrations without probing or mutating external providers", () => {
    const service = createLocalAiRouteService({
      clock: fixedClock,
      idFactory: idSequence(),
      hardwareSnapshot: async () => hardwareSnapshot({ totalGiB: 32, detectedBackends: [] }),
    });

    const endpoint = service.registerEndpoint({
      label: "Ollama workstation",
      backend: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: SMALL_MODEL_ID,
    });

    expect(endpoint).toEqual(
      expect.objectContaining({
        endpointId: "local-ai-endpoint-id-1",
        providerId: "local-ai-ollama-llama3.2-3b-instruct-q4_k_m",
        smokeStatus: "pending",
        evidenceRef: "local-ai:endpoint:id-1:smoke-pending-no-network-probe",
      }),
    );
  });
});

function findRecommendation(
  recommendations: ReturnType<typeof buildLocalAiFitRecommendations>,
  modelId: string,
  backend: string,
) {
  const recommendation = recommendations.find((item) => item.modelId === modelId && item.backend === backend);
  expect(recommendation).toBeDefined();
  return recommendation!;
}

function fixedClock(): Date {
  return new Date("2026-06-05T12:00:00.000Z");
}

function hardwareSnapshot(input: {
  detectedBackends: Array<LocalAiHardwareSnapshot["runtimes"][number]["backend"]>;
  totalGiB: number;
}): LocalAiHardwareSnapshot {
  return {
    checkedAt: "2026-06-05T12:00:00.000Z",
    os: {
      platform: "linux",
      arch: "x64",
      release: "6.8.0",
    },
    cpu: {
      model: "Test CPU",
      logicalCores: 12,
    },
    memory: {
      totalBytes: input.totalGiB * 1024 * 1024 * 1024,
      freeBytes: Math.floor(input.totalGiB * 0.7) * 1024 * 1024 * 1024,
    },
    gpu: [],
    disk: {
      modelsRootPath: "/tmp/goatcitadel/local-ai/models",
    },
    runtimes: ["ollama", "llama_cpp", "vllm", "sglang"].map((backend) => ({
      backend: backend as LocalAiHardwareSnapshot["runtimes"][number]["backend"],
      detected: input.detectedBackends.includes(backend as LocalAiHardwareSnapshot["runtimes"][number]["backend"]),
      command: input.detectedBackends.includes(backend as LocalAiHardwareSnapshot["runtimes"][number]["backend"])
        ? `/usr/bin/${backend}`
        : undefined,
      baseUrl: "http://127.0.0.1:11434",
      platformSupport: "native",
      notes: ["test snapshot"],
    })),
  };
}

function idSequence(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `id-${index}`;
  };
}

function createApprovalRecord(input: ApprovalCreateInput): ApprovalRequest {
  return {
    approvalId: "22222222-2222-4222-8222-222222222222",
    kind: input.kind,
    riskLevel: input.riskLevel,
    status: "pending",
    payload: input.payload,
    preview: input.preview,
    linkage: input.linkage,
    rollbackNote: input.rollbackNote,
    createdAt: "2026-06-05T12:00:00.000Z",
    explanationStatus: "not_requested",
  };
}
