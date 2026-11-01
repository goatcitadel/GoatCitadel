import { describe, expect, it, vi } from "vitest";
import type { CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import { CapabilitySystemService } from "./capability-system-service.js";

interface Harness {
  service: CapabilitySystemService;
  flags: Record<string, boolean | undefined>;
}

function buildHarness(options: {
  flags: Record<string, boolean | undefined>;
  configHostEnabled?: boolean;
  supported?: boolean;
}): Harness {
  const flags = { ...options.flags };
  const supported = options.supported ?? true;
  const service = new CapabilitySystemService({
    rootDir: "C:/tmp/goatcitadel-code-mode-readiness",
    runtimeConfig: {
      candidateRoot: "./data/capability-candidates",
      codeModeArtifactRoot: "./data/code-mode-artifacts",
      tempRoot: "./data/code-mode-temp",
      codeModeSandbox: {
        mode: "best_effort_host",
        required: true,
        bestEffortHostEnabled: options.configHostEnabled ?? false,
      },
    },
    storage: {} as never,
    readFeatureFlags: async () => flags as never,
    // The adapter is available only when the host supports it and the switch is on.
    resolveSandboxMetadata: (config) =>
      ({
        runnerId: "test",
        runnerVersion: "1",
        platform: "win32",
        isolationProfile: "test",
        required: config.required,
        available: supported && config.bestEffortHostEnabled,
      }) as CodeModeSandboxMetadata,
    listToolCatalog: () => [],
    listLoadedSkills: () => [],
    readSkillStates: async () => new Map(),
    invokeTool: vi.fn(),
    createApproval: vi.fn(),
    resolveApproval: vi.fn(),
    publishRealtime: vi.fn(async () => undefined),
    readPolicySnapshot: async () => ({}),
  });
  return { service, flags };
}

describe("CapabilitySystemService.getCodeModeReadiness", () => {
  it("reports code_mode_off by default", async () => {
    const { service } = buildHarness({ flags: { codeModeV1Enabled: false } });
    expect(await service.getCodeModeReadiness()).toMatchObject({
      enabled: false,
      canRun: false,
      reason: "code_mode_off",
    });
  });

  it("reads the stored host-sandbox flag live instead of the startup config", async () => {
    const { service, flags } = buildHarness({
      flags: { codeModeV1Enabled: true, codeModeHostSandboxEnabled: true },
      configHostEnabled: false,
    });
    expect(await service.getCodeModeReadiness()).toEqual({
      enabled: true,
      sandboxEnabled: true,
      sandboxSupported: true,
      canRun: true,
    });
    flags.codeModeHostSandboxEnabled = false;
    expect(await service.getCodeModeReadiness()).toMatchObject({
      canRun: false,
      sandboxEnabled: false,
      sandboxSupported: true,
      reason: "sandbox_off",
    });
  });

  it("falls back to the config value while the runtime flag is unset", async () => {
    const { service } = buildHarness({ flags: { codeModeV1Enabled: true }, configHostEnabled: true });
    expect(await service.getCodeModeReadiness()).toMatchObject({ canRun: true, sandboxEnabled: true });
  });

  it("never reports canRun on an unsupported host", async () => {
    const { service } = buildHarness({
      flags: { codeModeV1Enabled: true, codeModeHostSandboxEnabled: true },
      supported: false,
    });
    expect(await service.getCodeModeReadiness()).toMatchObject({
      canRun: false,
      sandboxSupported: false,
      reason: "sandbox_unsupported",
    });
  });

  it("reports sandbox_unsupported before code_mode_off, so an unsupported host is never offered the switch", async () => {
    const { service } = buildHarness({ flags: { codeModeV1Enabled: false }, supported: false });
    expect(await service.getCodeModeReadiness()).toMatchObject({
      enabled: false,
      canRun: false,
      sandboxSupported: false,
      reason: "sandbox_unsupported",
    });
  });
});
