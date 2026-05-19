import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinuxFirejailSandboxAdapter, __buildFirejailProfileForTests } from "./linux-firejail-adapter.js";

// Regression coverage for CODEX_FINDING #18: the Linux Code Mode sandbox
// previously used `read-only /` + a writable run-temp dir. That blocked
// writes to the host filesystem but permitted READS of the entire host
// fs. Because the guest runs inside Node's `vm` (not a security boundary),
// a malicious payload could escape and read host config / secrets. The
// fix uses `private` + `whitelist` so the guest can only see the run
// workspace at all.

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("firejail profile (codex #18)", () => {
  it("includes `private` and `whitelist` for the run workspace", () => {
    const profile = __buildFirejailProfileForTests("/tmp/run-1");
    expect(profile).toContain("private");
    expect(profile).toContain("whitelist /tmp/run-1");
  });

  it("does NOT use the permissive `read-only /` directive", () => {
    const profile = __buildFirejailProfileForTests("/tmp/run-1");
    expect(profile).not.toMatch(/^read-only \/$/m);
  });

  it("retains namespace and capability hardening directives", () => {
    const profile = __buildFirejailProfileForTests("/tmp/run-1");
    expect(profile).toContain("private-dev");
    expect(profile).toContain("private-tmp");
    expect(profile).toContain("net none");
    expect(profile).toContain("seccomp");
    expect(profile).toContain("caps.drop all");
    expect(profile).toContain("nonewprivs");
  });

  it("launches the harness from inside the private run workspace", async () => {
    const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-firejail-"));
    tempRoots.push(runTempRoot);
    const runHarnessPath = path.join(runTempRoot, "code-mode-harness.mjs");
    const sharedHarnessPath = path.join(path.dirname(runTempRoot), "code-mode-harness.mjs");
    const adapter = new LinuxFirejailSandboxAdapter({
      platform: "linux",
      osRelease: "6.8.0",
      resolveCommand: () => "/usr/bin/firejail",
    });

    const launch = await adapter.prepareLaunch({
      runId: "run-1",
      nodePath: "/usr/bin/node",
      harnessPath: runHarnessPath,
      runTempRoot,
      heapMb: 64,
      env: {},
    });

    expect(launch.args).toContain(`--private=${runTempRoot}`);
    expect(launch.args).toContain(runHarnessPath);
    expect(launch.args).not.toContain(sharedHarnessPath);
  });
});
