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
  it("keeps the Windows AppContainer floor visible when prerequisites are available", () => {
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
      available: true,
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
    expect(metadata.checksFailed).toEqual([]);
    expect(metadata.checksPassed).toEqual(
      expect.arrayContaining(["win32_stdio_jsonrpc_transport_intended", "windows_job_limits_intended"]),
    );
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

  it("writes the launcher once AppContainer prerequisites are available", async () => {
    const root = await createTempRoot();
    const runTempRoot = path.join(root, "run");
    const nodePath = path.join(root, "node.exe");
    const harnessPath = path.join(root, "path with space", "harness", "tail.mjs");
    await fs.writeFile(nodePath, "test node", "utf8");
    await fs.mkdir(path.dirname(harnessPath), { recursive: true });
    await fs.writeFile(harnessPath, "process.exit(0);\n", "utf8");
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    const launch = await adapter.prepareLaunch({
      runId: "quote-tail",
      nodePath,
      harnessPath,
      runTempRoot,
      heapMb: 0,
      env: { GOATCITADEL_CODE_MODE: "1" },
    });

    expect(launch.transport).toBe("stdio_jsonrpc");
    await expect(fs.stat(path.join(runTempRoot, "code-mode-appcontainer-launcher.ps1"))).resolves.toBeTruthy();
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
