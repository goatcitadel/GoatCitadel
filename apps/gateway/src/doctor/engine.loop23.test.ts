import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { __doctorEngineInternals } from "./engine.js";

describe("doctor engine internals loop 23", () => {
  it("normalizes roots, loopback hosts, and path containment checks", () => {
    expect(__doctorEngineInternals.normalizeBaseUrl("http://127.0.0.1:8787///")).toBe("http://127.0.0.1:8787");
    expect(__doctorEngineInternals.isLoopbackHost(" [::1] ")).toBe(true);
    expect(__doctorEngineInternals.isLoopbackHost("0.0.0.0")).toBe(false);

    const root = path.resolve("F:/code/personal-ai");
    expect(__doctorEngineInternals.isPathInsideRoot(root, path.join(root, "config", "assistant.config.json"))).toBe(
      true,
    );
    expect(__doctorEngineInternals.isPathInsideRoot(root, path.resolve(root, "..", "outside.txt"))).toBe(false);
  });

  it("requires explicit approval for guarded repairs unless yes mode is enabled", async () => {
    const promptConfirm = vi.fn(async () => true);

    await expect(
      __doctorEngineInternals.requestGuardedRepairApproval(
        {
          rootDir: "F:/code/personal-ai",
          configDir: "F:/code/personal-ai/config",
          gatewayBaseUrl: "http://127.0.0.1:8787",
          dataDir: "F:/code/personal-ai/data",
          transcriptsDir: "F:/code/personal-ai/data/transcripts",
          auditDir: "F:/code/personal-ai/data/audit",
          workspaceDir: "F:/code/personal-ai/workspace",
          worktreesDir: "F:/code/personal-ai/.worktrees",
          deep: false,
          auditOnly: false,
          noRepair: false,
          yes: false,
          promptConfirm,
        },
        "Apply guarded repair?",
      ),
    ).resolves.toBe(true);
    expect(promptConfirm).toHaveBeenCalledWith("Apply guarded repair?");

    await expect(
      __doctorEngineInternals.requestGuardedRepairApproval(
        {
          rootDir: "F:/code/personal-ai",
          configDir: "F:/code/personal-ai/config",
          gatewayBaseUrl: "http://127.0.0.1:8787",
          dataDir: "F:/code/personal-ai/data",
          transcriptsDir: "F:/code/personal-ai/data/transcripts",
          auditDir: "F:/code/personal-ai/data/audit",
          workspaceDir: "F:/code/personal-ai/workspace",
          worktreesDir: "F:/code/personal-ai/.worktrees",
          deep: false,
          auditOnly: false,
          noRepair: false,
          yes: true,
        },
        "Apply guarded repair?",
      ),
    ).resolves.toBe(true);
  });
});
