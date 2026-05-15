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

describe("WindowsAppContainerSandboxAdapter loop32 diagnostics", () => {
  it("reports unsupported Windows hosts and blocks launch before writing a launcher", async () => {
    const root = await makeTempRoot();
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "6.1.7601",
      resolveCommand: () => undefined,
    });

    expect(adapter.probe(baseConfig())).toMatchObject({
      available: false,
      required: true,
      checksFailed: expect.arrayContaining(["win32_powershell_missing", "win32_appcontainer_os_unsupported"]),
      checksPassed: expect.arrayContaining(["win32_adapter_present"]),
    });

    await expect(
      adapter.prepareLaunch({
        runId: "loop32",
        nodePath: path.join(root, "node.exe"),
        harnessPath: path.join(root, "harness.mjs"),
        runTempRoot: path.join(root, "run"),
        heapMb: 256,
        env: {},
      }),
    ).rejects.toThrow(/win32_powershell_missing|win32_appcontainer_os_unsupported|unavailable/i);
    await expect(fs.stat(path.join(root, "run", "code-mode-appcontainer-launcher.ps1"))).rejects.toThrow();
  });

  it("returns an explicit launch spec with enforced temp workspace metadata", async () => {
    const root = await makeTempRoot();
    const runTempRoot = path.join(root, "run");
    const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const adapter = new WindowsAppContainerSandboxAdapter({
      platform: "win32",
      osRelease: "10.0.22631",
      resolveCommand: (command) => (command === "powershell.exe" ? powershell : undefined),
    });

    const spec = await adapter.prepareLaunch({
      runId: "loop32-run",
      nodePath: path.join(root, "node.exe"),
      harnessPath: path.join(root, "harness.mjs"),
      runTempRoot,
      heapMb: 384,
      env: { GOATCITADEL_CODE_MODE: "1" },
    });

    expect(spec).toMatchObject({
      executable: powershell,
      cwd: runTempRoot,
      env: { GOATCITADEL_CODE_MODE: "1" },
      shell: false,
      enforcedWorkspaceRoot: runTempRoot,
      advisoryUnsandboxed: false,
    });
    expect(spec.args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]));
    expect(spec.generatedArtifacts).toHaveLength(1);
    await expect(fs.readFile(spec.generatedArtifacts[0]!, "utf8")).resolves.toContain(
      "GoatCitadel.CodeMode.loop32-run",
    );
  });
});

function baseConfig(overrides?: Partial<CodeModeSandboxConfig>): CodeModeSandboxConfig {
  return {
    mode: "best_effort_host",
    required: overrides?.required ?? true,
    bestEffortHostEnabled: overrides?.bestEffortHostEnabled ?? true,
  };
}

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-win32-appcontainer-loop32-"));
  tempRoots.push(root);
  return root;
}
