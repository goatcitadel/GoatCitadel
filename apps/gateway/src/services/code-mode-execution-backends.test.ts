import { describe, expect, it } from "vitest";
import type { CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import {
  CODE_MODE_AIDER_ADAPTER_ID,
  buildCodeModeExecutionBackends,
  buildCodeModeRunExecutionBackendRef,
} from "./code-mode-execution-backends.js";

describe("code-mode-execution-backends", () => {
  const digestPinnedAiderImage =
    "ghcr.io/goatcitadel/aider-adapter@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  it("keeps Docker preview-only without explicit enablement and image config", () => {
    const response = buildCodeModeExecutionBackends({
      codeModeEnabled: true,
      sandbox: sandboxMetadata(),
      dockerBackend: { enabled: false, dockerCommand: "docker" },
      env: {
        GOATCITADEL_CODE_MODE_DOCKER_BACKEND_ENABLED: "false",
      },
    });
    const docker = response.items.find((item) => item.backendId === "docker-container");

    expect(response.activeBackendId).toBe("trusted-code-host");
    expect(docker).toMatchObject({
      status: "preview",
      runtimeSupport: "preview_only",
      callable: false,
      blockers: expect.arrayContaining(["Docker backend is not enabled."]),
      governance: expect.arrayContaining([
        "Must not replace auth, approvals, or operator-visible sandbox posture.",
        "Docker is extra isolation evidence, not sufficient evidence for a hostile-code sandbox claim.",
      ]),
    });
  });

  it("keeps Aider preview-only until Docker and Aider image config are both present", () => {
    const preview = buildCodeModeExecutionBackends({
      codeModeEnabled: true,
      sandbox: sandboxMetadata(),
      dockerBackend: {
        enabled: true,
        image:
          "ghcr.io/goatcitadel/code-mode-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
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
      dockerBackend: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
        requireDigestPin: false,
      },
      aiderAdapter: { enabled: true, image: digestPinnedAiderImage, command: "aider" },
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
        dockerBackend: {
          enabled: true,
          image: "ghcr.io/goatcitadel/code-mode-runner:preview",
          requireDigestPin: false,
        },
        aiderAdapter: { enabled: true, image: digestPinnedAiderImage },
        env: {},
      }),
    ).toMatchObject({
      backendId: CODE_MODE_AIDER_ADAPTER_ID,
      kind: "aider_adapter",
      isolationProfile: "docker/aider-audit/no_operator_workspace",
    });
  });

  it("blocks mutable tag-only Aider adapter images", () => {
    const response = buildCodeModeExecutionBackends({
      codeModeEnabled: true,
      sandbox: sandboxMetadata(),
      dockerBackend: {
        enabled: true,
        image:
          "ghcr.io/goatcitadel/code-mode-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      aiderAdapter: { enabled: true, image: "ghcr.io/goatcitadel/aider-adapter:preview" },
      env: {},
    });

    expect(response.items.find((item) => item.backendId === CODE_MODE_AIDER_ADAPTER_ID)).toMatchObject({
      status: "blocked",
      runtimeSupport: "not_available",
      callable: false,
      blockers: expect.arrayContaining(["Aider adapter requires a digest-pinned image (name@sha256:<64 hex chars>)."]),
    });
    expect(() =>
      buildCodeModeRunExecutionBackendRef(sandboxMetadata(), {
        requestedBackendId: CODE_MODE_AIDER_ADAPTER_ID,
        dockerBackend: {
          enabled: true,
          image:
            "ghcr.io/goatcitadel/code-mode-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        aiderAdapter: { enabled: true, image: "ghcr.io/goatcitadel/aider-adapter:preview" },
        env: {},
      }),
    ).toThrow("Aider adapter requires a digest-pinned image");
  });

  it("blocks Docker and dependent Aider catalog entries when digest pinning is required but the image is tag-only", () => {
    const response = buildCodeModeExecutionBackends({
      codeModeEnabled: true,
      sandbox: sandboxMetadata(),
      dockerBackend: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
        requireDigestPin: true,
      },
      aiderAdapter: { enabled: true, image: "ghcr.io/goatcitadel/aider-adapter:preview" },
      env: {},
    });

    expect(response.activeBackendId).toBe("trusted-code-host");
    expect(response.items.find((item) => item.backendId === "docker-container")).toMatchObject({
      status: "blocked",
      runtimeSupport: "not_available",
      callable: false,
      blockers: expect.arrayContaining(["Docker backend requires a digest-pinned image (name@sha256:<64 hex chars>)."]),
    });
    expect(response.items.find((item) => item.backendId === CODE_MODE_AIDER_ADAPTER_ID)).toMatchObject({
      status: "blocked",
      runtimeSupport: "not_available",
      callable: false,
      blockers: expect.arrayContaining(["Docker execution backend is not callable."]),
    });
    expect(() =>
      buildCodeModeRunExecutionBackendRef(sandboxMetadata(), {
        requestedBackendId: "docker-container",
        dockerBackend: {
          enabled: true,
          image: "ghcr.io/goatcitadel/code-mode-runner:preview",
          requireDigestPin: true,
        },
        env: {},
      }),
    ).toThrow("Docker backend requires a digest-pinned image");
  });

  it("requires Docker digest pinning by default when the backend is enabled", () => {
    const response = buildCodeModeExecutionBackends({
      codeModeEnabled: true,
      sandbox: sandboxMetadata(),
      dockerBackend: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      },
      env: {},
    });

    expect(response.activeBackendId).toBe("trusted-code-host");
    expect(response.items.find((item) => item.backendId === "docker-container")).toMatchObject({
      status: "blocked",
      callable: false,
      blockers: expect.arrayContaining(["Docker backend requires a digest-pinned image (name@sha256:<64 hex chars>)."]),
    });
  });

  it("includes unsupported backend candidates as evaluation-only metadata", () => {
    const response = buildCodeModeExecutionBackends({
      codeModeEnabled: true,
      sandbox: sandboxMetadata(),
      env: {},
    });

    const e2b = response.items.find((item) => item.backendId === "e2b-reference");
    const kubernetes = response.items.find((item) => item.backendId === "kubernetes-agent-sandbox-reference");

    expect(e2b).toMatchObject({
      callable: false,
      evaluationOnly: true,
      runtimeSupport: "preview_only",
      blockers: ["Reference/evaluation only: no configured GoatCitadel execution backend exists."],
      evaluation: {
        localFirstViability: "weak",
        requiredProofLanes: expect.arrayContaining(["verify:code-mode:sandbox", "docs:check"]),
      },
    });
    expect(kubernetes).toMatchObject({
      kind: "kubernetes_agent_sandbox",
      evaluationOnly: true,
      callable: false,
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
