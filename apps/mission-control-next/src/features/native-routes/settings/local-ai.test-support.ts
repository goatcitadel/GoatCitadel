import type { LocalAiDownloadJob, LocalAiReadinessResponse } from "@goatcitadel/contracts";

export const localAiFixture = (): LocalAiReadinessResponse => ({
  hardware: {
    checkedAt: "2026-09-30T00:00:00Z",
    os: { platform: "win32", arch: "x64" },
    cpu: { model: "Fixture CPU", logicalCores: 8 },
    memory: { totalBytes: 16 * 1024 ** 3 },
    disk: {},
    gpu: [],
    runtimes: [
      { backend: "llama_cpp", detected: true, platformSupport: "native", notes: ["Version command detected"] },
    ],
  },
  catalog: [
    {
      modelId: "fixture-model",
      label: "Fixture model",
      family: "fixture",
      preferredBackends: ["llama_cpp"],
      tags: [],
      source: "builtin",
    },
  ],
  recommendations: [
    {
      modelId: "fixture-model",
      backend: "llama_cpp",
      fit: "good",
      confidence: "medium",
      reasons: ["Fits estimated host memory"],
      limitations: ["GPU memory not measured"],
      estimatedMemoryBytes: 4 * 1024 ** 3,
    },
  ],
  downloads: [],
  serveJobs: [],
  endpoints: [],
});
export const localAiJob = (): LocalAiDownloadJob => ({
  jobId: "job-1",
  approvalId: "approval-1",
  modelId: "fixture-model",
  backend: "llama_cpp",
  status: "requires_approval",
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  progressPercent: 0,
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
