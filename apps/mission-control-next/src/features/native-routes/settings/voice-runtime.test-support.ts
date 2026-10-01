import type { VoiceRuntimeStatus } from "@goatcitadel/contracts";
export function voiceRuntimeFixture(): VoiceRuntimeStatus {
  return {
    provider: "whisper.cpp",
    source: "managed",
    readiness: "ready",
    binaryReady: true,
    binaryPath: "/fixture/whisper-cli",
    ffmpegReady: true,
    selectedModelId: "small",
    selectedModelPath: "/fixture/small.bin",
    installedModels: [
      {
        modelId: "base",
        filePath: "/fixture/base.bin",
        sizeBytes: 100,
        installedAt: "2026-09-30T00:00:00.000Z",
        active: false,
      },
      {
        modelId: "small",
        filePath: "/fixture/small.bin",
        sizeBytes: 200,
        installedAt: "2026-09-30T00:00:00.000Z",
        active: true,
      },
    ],
    catalog: [
      {
        id: "base",
        label: "Base English",
        languageScope: "english",
        approxSizeLabel: "100 MB",
        sizeBytes: 100,
        defaultInstall: true,
      },
      {
        id: "small",
        label: "Small multilingual",
        languageScope: "multilingual",
        approxSizeLabel: "200 MB",
        sizeBytes: 200,
      },
    ],
  };
}
export function selectedVoiceRuntime(status: VoiceRuntimeStatus, modelId: string): VoiceRuntimeStatus {
  return {
    ...status,
    selectedModelId: modelId,
    selectedModelPath: status.installedModels.find((item) => item.modelId === modelId)?.filePath,
    installedModels: status.installedModels.map((item) => ({ ...item, active: item.modelId === modelId })),
  };
}
