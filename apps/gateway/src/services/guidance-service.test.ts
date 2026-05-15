import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuidanceDocType } from "@goatcitadel/contracts";
import { GuidanceService, type GuidanceServiceContext } from "./guidance-service.js";

describe("GuidanceService", () => {
  let rootDir: string;
  let originalKillSwitch: string | undefined;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-guidance-"));
    originalKillSwitch = process.env.GOATCITADEL_DISABLE_GUIDANCE_INJECTION;
    delete process.env.GOATCITADEL_DISABLE_GUIDANCE_INJECTION;
  });

  afterEach(async () => {
    if (originalKillSwitch === undefined) {
      delete process.env.GOATCITADEL_DISABLE_GUIDANCE_INJECTION;
    } else {
      process.env.GOATCITADEL_DISABLE_GUIDANCE_INJECTION = originalKillSwitch;
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("lists global and workspace guidance with normalized workspace IDs", async () => {
    await fs.writeFile(path.join(rootDir, "GOATCITADEL.md"), "global goat\n", "utf8");
    await fs.mkdir(path.join(rootDir, "workspaces", "workspace-one"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "workspaces", "workspace-one", "AGENTS.md"), "workspace agents\n", "utf8");
    const ctx = fakeContext(rootDir);
    const service = new GuidanceService(ctx);

    const globalDocs = await service.listGlobalGuidance();
    const workspace = await service.listWorkspaceGuidance(" Workspace One ");

    expect(globalDocs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ docType: "goatcitadel", scope: "global", exists: true, content: "global goat\n" }),
        expect.objectContaining({ docType: "agents", scope: "global", exists: false, content: "" }),
      ]),
    );
    expect(workspace.workspaceId).toBe("workspace-one");
    expect(workspace.workspace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          docType: "agents",
          scope: "workspace",
          workspaceId: "workspace-one",
          exists: true,
          content: "workspace agents\n",
        }),
      ]),
    );
    expect(ctx.storage.workspaces.get).toHaveBeenCalledWith("workspace-one");
  });

  it("updates guidance documents and publishes scope-specific realtime events", async () => {
    const ctx = fakeContext(rootDir);
    const service = new GuidanceService(ctx);

    await expect(service.updateGlobalGuidance("goatcitadel", "global\r\nnote")).resolves.toEqual(
      expect.objectContaining({ scope: "global", content: "global\nnote\n" }),
    );
    await expect(service.updateWorkspaceGuidance("Workspace Two", "agents", "workspace note")).resolves.toEqual(
      expect.objectContaining({ scope: "workspace", workspaceId: "workspace-two", content: "workspace note\n" }),
    );

    await expect(
      service.updateWorkspaceGuidance("Workspace Two", "security" as GuidanceDocType, "nope"),
    ).rejects.toThrow("Workspace override is not supported for security");
    expect(ctx.publishRealtime).toHaveBeenCalledWith("guidance_updated", "system", {
      scope: "global",
      docType: "goatcitadel",
    });
    expect(ctx.publishRealtime).toHaveBeenCalledWith("guidance_updated", "system", {
      scope: "workspace",
      workspaceId: "workspace-two",
      docType: "agents",
    });
    await expect(fs.readFile(path.join(rootDir, "GOATCITADEL.md"), "utf8")).resolves.toBe("global\nnote\n");
  });

  it("resolves runtime guidance with workspace precedence and truncation", async () => {
    const ctx = fakeContext(rootDir);
    const service = new GuidanceService(ctx);
    await fs.writeFile(path.join(rootDir, "GOATCITADEL.md"), "global goat", "utf8");
    await fs.writeFile(path.join(rootDir, "CLAUDE.md"), "c".repeat(7000), "utf8");
    await fs.mkdir(path.join(rootDir, "workspaces", "workspace-one"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "workspaces", "workspace-one", "AGENTS.md"), "workspace agents", "utf8");

    const guidance = await service.resolveRuntimeGuidance("Workspace One");

    expect(guidance.workspaceId).toBe("workspace-one");
    expect(guidance.globalFilesUsed).toEqual(["GOATCITADEL.md", "CLAUDE.md"]);
    expect(guidance.workspaceFilesUsed).toEqual(["AGENTS.md"]);
    expect(guidance.systemInstruction).toContain("Workspace context: workspace-one.");
    expect(guidance.systemInstruction).toContain("global goat");
    expect(guidance.systemInstruction).toContain("workspace agents");
    expect(guidance.systemInstruction).toContain("...[truncated]");
    expect(guidance.truncated).toBe(true);
  });

  it("honors the guidance injection kill switch", async () => {
    process.env.GOATCITADEL_DISABLE_GUIDANCE_INJECTION = " YeS ";
    const service = new GuidanceService(fakeContext(rootDir));

    await expect(service.resolveRuntimeGuidance("Workspace One")).resolves.toEqual({
      workspaceId: "workspace-one",
      globalFilesUsed: [],
      workspaceFilesUsed: [],
      truncated: false,
    });
  });
});

function fakeContext(rootDir: string): GuidanceServiceContext {
  return {
    config: { rootDir },
    storage: {
      workspaces: {
        get: vi.fn((workspaceId: string) => ({ workspaceId })),
      },
    } as never,
    publishRealtime: vi.fn(),
    normalizeWorkspaceId: vi.fn((workspaceId?: string) =>
      (workspaceId ?? "default").trim().toLowerCase().replace(/\s+/g, "-"),
    ),
  };
}
