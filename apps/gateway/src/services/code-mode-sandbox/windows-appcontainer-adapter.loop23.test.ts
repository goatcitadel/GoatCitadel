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

describe("WindowsAppContainerSandboxAdapter loop 23", () => {
  it("keeps host-disabled probes fail-closed even when Windows prerequisites are available", () => {
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    const metadata = adapter.probe(baseConfig({ bestEffortHostEnabled: false }));

    expect(metadata.available).toBe(false);
    expect(metadata.checksPassed).toEqual(
      expect.arrayContaining(["win32_adapter_present", "win32_powershell_present"]),
    );
    expect(metadata.checksFailed).toEqual(
      expect.arrayContaining(["best_effort_host_disabled", "win32_node_ipc_not_preserved"]),
    );
    expect(metadata.failClosedReason).toContain("best_effort_host_disabled");
  });

  it("fails closed before writing a launcher until Windows IPC preservation is implemented", async () => {
    const root = await createTempRoot();
    const quotedRoot = path.join(root, "quote'root");
    const runTempRoot = path.join(quotedRoot, "run");
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: (command) =>
        command === "powershell.exe"
          ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
          : "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    });

    await expect(
      adapter.prepareLaunch({
        runId: "run; unsafe-ish",
        nodePath: path.join(quotedRoot, "node.exe"),
        harnessPath: path.join(quotedRoot, "harness.mjs"),
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-win32-appcontainer-loop23-"));
  tempRoots.push(root);
  return root;
}
