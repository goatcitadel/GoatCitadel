import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __doctorEngineInternals } from "./engine.js";

const tempRoots: string[] = [];

afterEach(async () => {
  delete process.env.GOATCITADEL_ROOT_DIR;
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("doctor engine loop30 internals", () => {
  it("summarizes check status and repair counts into operator exit semantics", () => {
    expect(
      __doctorEngineInternals.summarizeDoctor(
        [
          { status: "ok", severity: "info" },
          { status: "warn", severity: "warning" },
          { status: "fixed", severity: "warning" },
          { status: "skipped", severity: "info" },
          { status: "fail", severity: "error" },
        ] as never,
        [{ applied: true }, { applied: false }] as never,
      ),
    ).toEqual({
      totalChecks: 5,
      ok: 1,
      warn: 1,
      fail: 1,
      fixed: 1,
      skipped: 1,
      unresolvedWarnings: 1,
      hardFailures: 1,
      repairedCount: 1,
      exitCode: 2,
    });
  });

  it("normalizes URLs, loopback checks, root paths, and guarded repair approvals", async () => {
    expect(__doctorEngineInternals.normalizeBaseUrl("http://127.0.0.1:8787///")).toBe("http://127.0.0.1:8787");
    expect(__doctorEngineInternals.isLoopbackHost("localhost")).toBe(true);
    expect(__doctorEngineInternals.isLoopbackHost("0.0.0.0")).toBe(false);
    expect(__doctorEngineInternals.isPathInsideRoot("F:/code/personal-ai", "F:/code/personal-ai/apps/gateway")).toBe(
      true,
    );
    expect(__doctorEngineInternals.isPathInsideRoot("F:/code/personal-ai", "F:/outside")).toBe(false);
    expect(
      __doctorEngineInternals.buildRemoteMissionControlUrl("http://mission.local/app?mode=ops", "token value"),
    ).toBe("http://mission.local/app?mode=ops&tab=dashboard#access_token=token%20value");

    const promptConfirm = vi.fn(async () => true);
    await expect(__doctorEngineInternals.requestGuardedRepairApproval({ yes: true } as never, "repair?")).resolves.toBe(
      true,
    );
    await expect(__doctorEngineInternals.requestGuardedRepairApproval({} as never, "repair?")).resolves.toBe(false);
    await expect(
      __doctorEngineInternals.requestGuardedRepairApproval({ promptConfirm } as never, "repair?"),
    ).resolves.toBe(true);
    expect(promptConfirm).toHaveBeenCalledWith("repair?");
  });

  it("reports config issues and rebuilds unified config from split files with backup evidence", async () => {
    const rootDir = await makeTempRoot();
    const configDir = path.join(rootDir, "config");
    await fs.mkdir(configDir, { recursive: true });

    expect(
      __doctorEngineInternals.collectConfigIssues(
        { path: "goatcitadel.json", exists: true, valid: false, error: "bad json" },
        [
          { path: "assistant.config.json", exists: false, valid: false },
          { path: "tool-policy.json", exists: true, valid: false, error: "trailing comma" },
        ],
      ),
    ).toEqual([
      "Unified config is invalid JSON (bad json).",
      "assistant.config.json is missing.",
      "tool-policy.json is invalid JSON (trailing comma).",
    ]);

    await Promise.all(
      [
        ["assistant.config.json", { environment: "local" }],
        ["tool-policy.json", { tools: { allow: [] } }],
        ["budgets.json", { mode: "balanced" }],
        ["llm-providers.json", { providers: [] }],
        ["cron-jobs.json", { jobs: [] }],
      ].map(([filename, value]) =>
        fs.writeFile(path.join(configDir, filename as string), JSON.stringify(value), "utf8"),
      ),
    );
    await fs.writeFile(path.join(configDir, "goatcitadel.json"), '{"old":true}\n', "utf8");

    await expect(__doctorEngineInternals.rebuildUnifiedFromSplit({ configDir } as never)).resolves.toEqual({
      rebuilt: true,
      message: "Rebuilt unified config from split config files.",
    });
    const unified = JSON.parse(await fs.readFile(path.join(configDir, "goatcitadel.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(unified).toMatchObject({
      version: 1,
      assistant: { environment: "local" },
      cronJobs: { jobs: [] },
    });
    expect((await fs.readdir(configDir)).some((entry) => entry.startsWith("goatcitadel.json.bak."))).toBe(true);
  });

  it("detects managed workspace tooling gaps and resolves root directory fallbacks", async () => {
    const rootDir = await makeTempRoot();
    await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "package.json"), '{"private":true}\n', "utf8");
    await fs.writeFile(path.join(rootDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
    await fs.writeFile(path.join(rootDir, "config", "assistant.config.json"), "{}\n", "utf8");

    expect(__doctorEngineInternals.commandLooksLikeRepoRoot(rootDir)).toBe(true);
    expect(__doctorEngineInternals.inspectManagedWorkspaceTooling(rootDir)).toEqual({
      isWorkspace: true,
      missing: [
        {
          label: "workspace dependencies",
          purpose: "GoatCitadel package commands and local tool binaries",
        },
      ],
    });

    process.env.GOATCITADEL_ROOT_DIR = ` ${rootDir} `;
    expect(__doctorEngineInternals.resolveDoctorRootDir()).toBe(path.resolve(rootDir));
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-doctor-loop30-"));
  tempRoots.push(root);
  return root;
}
