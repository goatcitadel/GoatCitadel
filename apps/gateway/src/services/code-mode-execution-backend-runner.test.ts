import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodeModeSandboxMetadata } from "@goatcitadel/contracts";
import type { CodeModeSandboxConfig } from "../config.js";
import { createCodeModeExecutionBackendRunner } from "./code-mode-execution-backend-runner.js";

describe("code-mode-execution-backend-runner", () => {
  it("routes the trusted host backend through sandbox launch preparation", async () => {
    const prepareHostLaunch = vi.fn(async (_config, launchInput, options) => ({
      metadata: options.metadata ?? sandboxMetadata(),
      launch: {
        transport: "node_ipc",
        executable: launchInput.nodePath,
        args: [launchInput.harnessPath],
        cwd: launchInput.runTempRoot,
        env: launchInput.env,
        shell: false as const,
        enforcedWorkspaceRoot: launchInput.runTempRoot,
        generatedArtifacts: [],
        advisoryUnsandboxed: false,
      },
    }));
    const sandbox = sandboxMetadata();
    const runner = createCodeModeExecutionBackendRunner({
      sandbox,
      sandboxConfig: sandboxConfig(),
      prepareHostLaunch,
    });

    await expect(runner.prepareLaunch(launchInput(sandbox))).resolves.toMatchObject({
      metadata: sandbox,
      launch: {
        executable: process.execPath,
        cwd: path.join("tmp", "code-mode-run"),
      },
    });
    expect(runner.backend.backendId).toBe("trusted-code-host");
    expect(runner.mode).toBe("child_harness");
    expect(prepareHostLaunch).toHaveBeenCalledWith(
      sandboxConfig(),
      expect.objectContaining({
        runId: "run-1",
        nodePath: process.execPath,
      }),
      { metadata: sandbox },
    );
  });

  it("fails closed for preview Docker and unconfigured Aider backends", () => {
    const sandbox = sandboxMetadata();
    try {
      createCodeModeExecutionBackendRunner({
        sandbox,
        sandboxConfig: sandboxConfig(),
        executionBackend: {
          backendId: "docker-container",
          kind: "docker",
          label: "Docker execution backend",
          status: "preview",
          runtimeSupport: "preview_only",
        },
      });
      throw new Error("expected Docker backend selection to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CODE_MODE_EXECUTION_BACKEND_UNAVAILABLE",
        message: "Docker Code Mode execution backend is preview-only and is not callable yet.",
      });
    }

    expect(() =>
      createCodeModeExecutionBackendRunner({
        sandbox,
        sandboxConfig: sandboxConfig(),
        executionBackend: {
          backendId: "aider-cli-adapter",
          kind: "aider_adapter",
          label: "Aider CLI adapter",
          status: "preview",
          runtimeSupport: "preview_only",
          adapterForBackendId: "docker-container",
        },
      }),
    ).toThrow("Aider Code Mode adapter is not callable with the current Docker and adapter configuration.");
  });

  it("prepares an explicit Docker launch through the stdio transport seam without making preview registry callable", async () => {
    const sandbox = sandboxMetadata();
    const prepareDockerLaunch = vi.fn(async (launchInput, options) => ({
      transport: "stdio_jsonrpc" as const,
      executable: options.dockerCommand ?? "docker",
      args: ["run", "--rm", "--network", "none", options.image, "node", launchInput.harnessPath],
      cwd: launchInput.runTempRoot,
      env: {},
      shell: false as const,
      enforcedWorkspaceRoot: launchInput.runTempRoot,
      generatedArtifacts: [],
      advisoryUnsandboxed: false,
    }));
    const runner = createCodeModeExecutionBackendRunner({
      sandbox,
      sandboxConfig: sandboxConfig(),
      executionBackend: {
        backendId: "docker-container",
        kind: "docker",
        label: "Docker execution backend",
        status: "preview",
        runtimeSupport: "preview_only",
      },
      dockerLaunch: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      },
      prepareDockerLaunch,
    });

    await expect(runner.prepareLaunch(launchInput(sandbox))).resolves.toMatchObject({
      metadata: sandbox,
      launch: {
        transport: "stdio_jsonrpc",
        executable: "docker",
        cwd: path.join("tmp", "code-mode-run"),
      },
    });
    expect(runner.backend.backendId).toBe("docker-container");
    expect(runner.mode).toBe("child_harness");
    expect(prepareDockerLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        harnessPath: path.join("tmp", "harness.mjs"),
      }),
      expect.objectContaining({
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      }),
    );
  });

  it("returns an Aider audit runner when Docker and adapter config are callable", async () => {
    const sandbox = sandboxMetadata();
    const executeAiderAdapter = vi.fn(async (input) => ({
      failed: false,
      outcome: "no_changes" as const,
      result: { aiderAdapter: { envelope: { replay: { policy: "audit_only", replaySafe: false } } } },
      stdout: "aider ok\n",
      stderr: "",
      bundle: {},
      observedInput: input,
    }));
    const runner = createCodeModeExecutionBackendRunner({
      sandbox,
      sandboxConfig: sandboxConfig(),
      executionBackend: {
        backendId: "aider-cli-adapter",
        kind: "aider_adapter",
        label: "Aider CLI adapter",
        status: "available",
        runtimeSupport: "active_runner",
        adapterForBackendId: "docker-container",
        isolationProfile: "docker/aider-audit/no_operator_workspace",
      },
      dockerBackendConfig: {
        enabled: true,
        image: "ghcr.io/goatcitadel/code-mode-runner:preview",
      },
      aiderAdapter: {
        enabled: true,
        image: "ghcr.io/goatcitadel/aider-adapter:preview",
        command: "aider",
      },
      executeAiderAdapter: executeAiderAdapter as never,
    });

    expect(runner.mode).toBe("aider_audit");
    await expect(runner.prepareLaunch(launchInput(sandbox))).rejects.toThrow(
      "Aider Code Mode adapter does not launch the child harness",
    );
    await expect(
      runner.executeAiderAdapter?.({
        runId: "run-1",
        runTempRoot: path.join("tmp", "code-mode-run"),
        language: "typescript",
        source: "return { ok: true };",
        requestMarkdown: "Review the temp file.",
        persister: {
          persistText: vi.fn(),
          persistJson: vi.fn(),
        },
      }),
    ).resolves.toMatchObject({
      failed: false,
      outcome: "no_changes",
      stdout: "aider ok\n",
    });
    expect(executeAiderAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        requestMarkdown: "Review the temp file.",
        aiderAdapter: expect.objectContaining({
          image: "ghcr.io/goatcitadel/aider-adapter:preview",
        }),
        dockerBackend: expect.objectContaining({
          enabled: true,
          image: "ghcr.io/goatcitadel/code-mode-runner:preview",
        }),
      }),
    );
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

function sandboxConfig(): CodeModeSandboxConfig {
  return {
    mode: "best_effort_host",
    required: true,
    bestEffortHostEnabled: true,
  };
}

function launchInput(sandbox: CodeModeSandboxMetadata) {
  return {
    sandbox,
    runId: "run-1",
    nodePath: process.execPath,
    harnessPath: path.join("tmp", "harness.mjs"),
    runTempRoot: path.join("tmp", "code-mode-run"),
    heapMb: 64,
    env: { GOATCITADEL_CODE_MODE: "1" },
  };
}
