import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeModeSandboxConfig } from "../../config.js";
import { WindowsAppContainerSandboxAdapter } from "./windows-appcontainer-adapter.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("WindowsAppContainerSandboxAdapter loop24 tails", () => {
  it("keeps the Windows AppContainer floor visible while reporting IPC as unavailable", () => {
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "6.2.9200",
      resolveCommand: (command) =>
        command === "powershell.exe" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : undefined,
    });

    const metadata = adapter.probe(baseConfig({ required: false }));

    expect(metadata).toMatchObject({
      platform: "win32",
      required: false,
      available: false,
    });
    expect(metadata.checksPassed).toEqual(
      expect.arrayContaining([
        "mode_best_effort_host",
        "best_effort_host_enabled",
        "win32_adapter_present",
        "win32_powershell_present",
        "win32_appcontainer_prerequisites_available",
      ]),
    );
    expect(metadata.checksFailed).toEqual([
      "win32_node_ipc_not_preserved",
      "network_isolation_not_enforced",
      "temp_workspace_not_enforced",
      "privilege_reduction_not_enforced",
      "windows_job_limits_not_enforced",
    ]);
  });

  it("rejects unsupported Windows launches before writing generated artifacts", async () => {
    const root = await createTempRoot();
    const runTempRoot = path.join(root, "run");
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "6.1.7601",
      resolveCommand: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    await expect(
      adapter.prepareLaunch({
        runId: "unsupported-os",
        nodePath: process.execPath,
        harnessPath: path.join(root, "harness.mjs"),
        runTempRoot,
        heapMb: 96,
        env: { GOATCITADEL_CODE_MODE: "1" },
      }),
    ).rejects.toThrow("win32_appcontainer_os_unsupported");
    await expect(fs.stat(runTempRoot)).rejects.toThrow();
  });

  it("blocks launch before writing a launcher while Windows IPC preservation is unavailable", async () => {
    const root = await createTempRoot();
    const runTempRoot = path.join(root, "run");
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    await expect(
      adapter.prepareLaunch({
        runId: "quote-tail",
        nodePath: path.join(root, "node.exe"),
        harnessPath: path.join(root, "path with space", "harness\\tail.mjs"),
        runTempRoot,
        heapMb: 0,
        env: {},
      }),
    ).rejects.toThrow("win32_node_ipc_not_preserved");
    await expect(fs.stat(path.join(runTempRoot, "code-mode-appcontainer-launcher.ps1"))).rejects.toThrow();
  });
});

function baseConfig(overrides?: Partial<CodeModeSandboxConfig>): CodeModeSandboxConfig {
  return {
    mode: "best_effort_host",
    required: overrides?.required ?? true,
    bestEffortHostEnabled: overrides?.bestEffortHostEnabled ?? true,
  };
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-win32-appcontainer-loop24-"));
  tempRoots.push(root);
  return root;
}
