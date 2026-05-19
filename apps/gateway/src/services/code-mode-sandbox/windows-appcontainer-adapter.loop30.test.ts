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

describe("WindowsAppContainerSandboxAdapter loop30 coverage", () => {
  it("reports disabled best-effort host mode as unavailable even when Windows prerequisites exist", () => {
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    const metadata = adapter.probe(baseConfig({ bestEffortHostEnabled: false }));

    expect(metadata.available).toBe(false);
    expect(metadata.required).toBe(true);
    expect(metadata.checksFailed).toEqual(expect.arrayContaining(["best_effort_host_disabled"]));
    expect(metadata.checksPassed).toEqual(
      expect.arrayContaining(["win32_powershell_present", "win32_appcontainer_prerequisites_available"]),
    );
  });

  it("fails closed before generating profile scripts while Windows IPC preservation is unavailable", async () => {
    const root = await createTempRoot();
    const runTempRoot = path.join(root, "run");
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    await expect(
      adapter.prepareLaunch({
        runId: "run with unsafe chars !@#",
        nodePath: path.join(root, "node's", "node.exe"),
        harnessPath: path.join(root, "harness's.mjs"),
        runTempRoot,
        heapMb: 128,
        env: { GOATCITADEL_CODE_MODE: "1" },
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-win32-appcontainer-loop30-"));
  tempRoots.push(root);
  return root;
}
