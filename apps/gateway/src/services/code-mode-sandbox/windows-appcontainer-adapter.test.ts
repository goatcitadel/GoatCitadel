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

describe("WindowsAppContainerSandboxAdapter", () => {
  it("reports missing PowerShell and unsupported Windows releases as fail-closed probe checks", async () => {
    const root = await createTempRoot();
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "6.1.7601",
      resolveCommand: () => undefined,
    });

    const metadata = adapter.probe(baseConfig());

    expect(metadata).toMatchObject({
      platform: "win32",
      available: false,
      required: true,
    });
    expect(metadata.checksPassed).toEqual(
      expect.arrayContaining(["mode_best_effort_host", "best_effort_host_enabled", "win32_adapter_present"]),
    );
    expect(metadata.checksFailed).toEqual(
      expect.arrayContaining(["win32_powershell_missing", "win32_appcontainer_os_unsupported"]),
    );
    await expect(adapter.prepareLaunch(launchInput(root))).rejects.toThrow(
      /win32_powershell_missing.*win32_appcontainer_os_unsupported/,
    );
  });

  it("prepares an AppContainer stdio JSON-RPC launcher when Windows prerequisites are available", async () => {
    const root = await createTempRoot();
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: (command) => (command === "pwsh.exe" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : undefined),
    });

    const metadata = adapter.probe(baseConfig());

    expect(metadata).toMatchObject({
      available: true,
      required: true,
    });
    // Truth-first: Windows availability rests on intended (not adversarially-verified)
    // controls, so enforcement must NOT be reported as verified even though it launches.
    expect(metadata.enforcementVerified).toBe(false);
    expect(metadata.checksPassed).toEqual(
      expect.arrayContaining([
        "win32_powershell_present",
        "win32_appcontainer_prerequisites_available",
        "win32_stdio_jsonrpc_transport_intended",
        "network_isolation_intended",
        "temp_workspace_acl_intended",
        "privilege_reduction_intended",
        "windows_job_limits_intended",
      ]),
    );
    expect(metadata.checksFailed).toEqual([]);

    await fs.writeFile(path.join(root, "harness.mjs"), "process.exit(0);\n", "utf8");
    const launch = await adapter.prepareLaunch(launchInput(root));
    expect(launch).toMatchObject({
      transport: "stdio_jsonrpc",
      executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      cwd: path.join(root, "run"),
      advisoryUnsandboxed: false,
    });
    expect(launch.env.GOATCITADEL_CODE_MODE_TRANSPORT).toBe("stdio_jsonrpc");
    expect(launch.generatedArtifacts.map((artifact) => path.basename(artifact))).toEqual(
      expect.arrayContaining(["code-mode-appcontainer-launcher.ps1", "code-mode-node.exe", "code-mode-harness.mjs"]),
    );
    const launcherPath = path.join(root, "run", "code-mode-appcontainer-launcher.ps1");
    await expect(fs.stat(launcherPath)).resolves.toBeTruthy();
    const launcher = await fs.readFile(launcherPath, "utf8");
    expect(launcher).toContain("GetStdHandle");
    expect(launcher).toContain("STARTF_USESTDHANDLES");
    expect(launcher).toContain("$harnessPath");
    expect(launcher).toContain("GrantFileAccess(nodePath, sid");
    expect(launcher).toContain("GrantFileAccess(harnessPath, sid");
    await expect(fs.stat(path.join(root, "run", "code-mode-harness.mjs"))).resolves.toBeTruthy();
  });

  it("rejects launcher paths with unsafe profile characters before writing launch artifacts", async () => {
    const root = await createTempRoot();
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    await expect(
      adapter.prepareLaunch({
        ...launchInput(root),
        nodePath: `${process.execPath}\nunsafe`,
      }),
    ).rejects.toThrow("Code Mode sandbox path contains unsafe profile characters.");
    await expect(fs.stat(path.join(root, "run", "code-mode-appcontainer-launcher.ps1"))).rejects.toThrow();
  });

  it("treats unparsable Windows releases as unsupported during probe", () => {
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "not-a-version",
      resolveCommand: (command) =>
        command === "powershell.exe" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : undefined,
    });

    const metadata = adapter.probe(baseConfig());

    expect(metadata).toMatchObject({
      available: false,
      required: true,
    });
    expect(metadata.checksPassed).toEqual(
      expect.arrayContaining(["win32_adapter_present", "win32_powershell_present"]),
    );
    expect(metadata.checksFailed).toContain("win32_appcontainer_os_unsupported");
  });
});

function baseConfig(overrides?: Partial<CodeModeSandboxConfig>): CodeModeSandboxConfig {
  return {
    mode: "best_effort_host",
    required: overrides?.required ?? true,
    bestEffortHostEnabled: overrides?.bestEffortHostEnabled ?? true,
  };
}

function launchInput(root: string) {
  return {
    runId: "run appcontainer",
    nodePath: process.execPath,
    harnessPath: path.join(root, "harness.mjs"),
    runTempRoot: path.join(root, "run"),
    heapMb: 64,
    env: { GOATCITADEL_CODE_MODE: "1" },
  };
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-win32-appcontainer-"));
  tempRoots.push(root);
  return root;
}
