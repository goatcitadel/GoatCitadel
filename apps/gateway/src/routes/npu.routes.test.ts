import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { npuRoutes } from "./npu.js";

describe("npu runtime routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("projects credential-bearing runtime status and model diagnostics", async () => {
    const rawStatus = {
      enabled: true,
      desiredState: "running",
      processState: "error",
      sidecarUrl: "https://npu.example.test/access-token/status-path?token=status-query",
      healthy: false,
      backend: "qnn",
      capability: {
        platform: "win32",
        arch: "arm64",
        isWindowsArm64: true,
        onnxRuntimeAvailable: true,
        onnxRuntimeGenAiAvailable: true,
        qnnExecutionProviderAvailable: false,
        supported: false,
        details: ["Authorization: Bearer npu-capability-short"],
      },
      lastError: "NPU failed with Bearer npu-status-short",
      updatedAt: "2026-07-09T00:00:00.000Z",
      tokenId: "npu-token-id",
      requestCount: 5,
    };
    const rawModels = [
      {
        modelId: "qwen-local",
        label: "Qwen Local",
        fallbackReason:
          "Fetch https://models.example.test/api-key/model-path?token=model-query failed with Bearer model-short",
        enabled: false,
      },
    ];
    app = Fastify();
    app.decorate("services", {
      npu: {
        getNpuStatus: vi.fn(() => rawStatus),
        listNpuModels: vi.fn(async () => rawModels),
      },
    } as never);
    await app.register(npuRoutes);

    const status = await app.inject({ method: "GET", url: "/api/v1/npu/status" });
    const models = await app.inject({ method: "GET", url: "/api/v1/npu/models" });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      sidecarUrl: "https://npu.example.test/access-token/[REDACTED]?token=[REDACTED]",
      capability: { details: ["Authorization: [REDACTED]"] },
      lastError: "NPU failed with Bearer [REDACTED]",
      tokenId: "npu-token-id",
      requestCount: 5,
    });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({
      items: [
        {
          modelId: "qwen-local",
          label: "Qwen Local",
          fallbackReason:
            "Fetch https://models.example.test/api-key/[REDACTED]?token=[REDACTED] failed with Bearer [REDACTED]",
          enabled: false,
        },
      ],
    });
    expect(rawStatus.lastError).toContain("npu-status-short");
    expect(rawModels[0]!.fallbackReason).toContain("model-path");
  });
});
