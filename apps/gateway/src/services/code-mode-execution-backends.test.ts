import { describe, expect, it } from "vitest";
import type { CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import {
  CODE_MODE_AIDER_ADAPTER_ID,
  buildCodeModeExecutionBackends,
  buildCodeModeRunExecutionBackendRef,
} from "./code-mode-execution-backends.js";

describe("code-mode-execution-backends", () => {
  it("keeps Aider preview-only until Docker and Aider image config are both present", () => {
    const preview = buildCodeModeExecutionBackends({
      codeModeEnabled: true,
      sandbox: sandboxMetadata(),
      dockerBackend: { enabled: true, image: "ghcr.io/goatcitadel/code-mode-runner:preview" },
      aiderAdapter: { enabled: true },
      env: {},
    }).items.find((item) => item.backendId === CODE_MODE_AIDER_ADAPTER_ID);

    expect(preview).toMatchObject({
      status: "preview",
      runtimeSupport: "preview_only",
      callable: false,
      blockers: expect.arrayContaining(["Aider adapter is enabled but no container image is configured."]),
    });
  });

  it("exposes a callable Aider adapter only as a Docker-backed audit runner", () => {
    const response = buildCodeModeExecutionBackends({
      codeModeEnabled: true,
      sandbox: sandboxMetadata(),
      dockerBackend: { enabled: true, image: "ghcr.io/goatcitadel/code-mode-runner:preview" },
      aiderAdapter: { enabled: true, image: "ghcr.io/goatcitadel/aider-adapter:preview", command: "aider" },
      env: {},
    });

    expect(response.items.find((item) => item.backendId === CODE_MODE_AIDER_ADAPTER_ID)).toMatchObject({
      status: "available",
      runtimeSupport: "active_runner",
      callable: true,
      adapterForBackendId: "docker-container",
      governance: expect.arrayContaining([
        "Runs only in run-temp/artifact space; operator workspace patches are not applied.",
        "Replay posture remains audit-only and non-replayable.",
      ]),
    });
    expect(
      buildCodeModeRunExecutionBackendRef(sandboxMetadata(), {
        requestedBackendId: CODE_MODE_AIDER_ADAPTER_ID,
        dockerBackend: { enabled: true, image: "ghcr.io/goatcitadel/code-mode-runner:preview" },
        aiderAdapter: { enabled: true, image: "ghcr.io/goatcitadel/aider-adapter:preview" },
        env: {},
      }),
    ).toMatchObject({
      backendId: CODE_MODE_AIDER_ADAPTER_ID,
      kind: "aider_adapter",
      isolationProfile: "docker/aider-audit/no_operator_workspace",
    });
  });
});

function sandboxMetadata(): CodeModeSandboxMetadata {
  return {
    runnerId: "goatcitadel.best-effort-host",
    runnerVersion: "0.2.0",
    platform: "linux",
    isolationProfile: "best_effort_host/temp_only/no_network",
    required: true,
    available: true,
    checksPassed: ["mode_best_effort_host"],
    checksFailed: [],
  };
}
