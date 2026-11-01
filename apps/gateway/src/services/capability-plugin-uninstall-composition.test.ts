import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
  SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA,
  type ApprovalListResponse,
  type ApprovalRequest,
  type PromptPackRecord,
} from "@goatcitadel/contracts";
import {
  pluginUninstallSources,
  readPendingSkillSteps,
  type PluginUninstallShared,
} from "./capability-plugin-uninstall-composition.js";
import { resolvePromptPackExportPath } from "./prompt-pack/import-export.js";

// The uninstall's owners as the Gateway wires them: a prompt pack's delete with its export file, and the read of every
// waiting Skill Hub step.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function pack(packId: string, name = "Meeting checks"): PromptPackRecord {
  return { packId, name, testCount: 1, createdAt: "2026-10-31T12:00:00.000Z", updatedAt: "2026-10-31T12:00:00.000Z" };
}

/** The uninstall's prompt-pack delete over saved packs kept in memory, under a fresh install root. */
async function packOwner(saved: PromptPackRecord[]) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-plugin-uninstall-"));
  roots.push(rootDir);
  let packs = [...saved];
  const order: string[] = [];
  const promptPacks = {
    getPack: vi.fn(async (packId: string) => {
      const found = packs.find((item) => item.packId === packId);
      if (!found) throw new NotFoundError(`Prompt pack ${packId} not found`);
      return found;
    }),
    listPacks: vi.fn(async () => packs),
    deletePackCascade: vi.fn(async (packId: string) => {
      order.push(`cascade:${await exists(resolvePromptPackExportPath(rootDir, pack(packId)))}`);
      packs = packs.filter((item) => item.packId !== packId);
      return { deletedRuns: 0 };
    }),
  };
  const reportExportFileKept = vi.fn();
  const sources = pluginUninstallSources({ reportExportFileKept } as unknown as PluginUninstallShared, {
    rootDir,
    records: { promptPacks } as never,
    plans: {} as never,
    hooks: {} as never,
    mcp: {} as never,
    mcpAdministration: {} as never,
  });
  const exportFile = async (item: PromptPackRecord) => {
    const file = resolvePromptPackExportPath(rootDir, item);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "# Meeting checks\n");
    return file;
  };
  return { sources, promptPacks, reportExportFileKept, order, exportFile, rootDir };
}

async function exists(file: string): Promise<boolean> {
  return await fs.stat(file).then(
    () => true,
    () => false,
  );
}

describe("a plugin uninstall's prompt-pack delete", () => {
  it("removes the export file before the pack, so a stop between the two never leaves the file", async () => {
    const checks = pack("plugin-meeting-tools-checks");
    const { sources, promptPacks, order, exportFile } = await packOwner([checks]);
    const file = await exportFile(checks);
    // The first delete stops after the file went.
    promptPacks.deletePackCascade.mockRejectedValueOnce(new Error("database is locked"));

    await expect(sources.deletePromptPack(checks.packId)).rejects.toThrow("database is locked");
    expect(await exists(file)).toBe(false);

    // Uninstalling again finds the pack and deletes it; the file is already gone.
    await expect(sources.deletePromptPack(checks.packId)).resolves.toBe(true);
    expect(order).toEqual(["cascade:false"]);
    expect(promptPacks.deletePackCascade).toHaveBeenCalledTimes(2);
    // Once it's gone, a further delete has nothing to do.
    await expect(sources.deletePromptPack(checks.packId)).resolves.toBe(false);
    expect(promptPacks.deletePackCascade).toHaveBeenCalledTimes(2);
  });

  it("keeps an export file another saved pack also writes", async () => {
    // Two packs whose names and ids start alike write the same export file.
    const checks = pack("plugin-meeting-tools-checks");
    const other = pack("plugin-meeting-tools-other");
    const { sources, promptPacks, reportExportFileKept, exportFile } = await packOwner([checks, other]);
    const file = await exportFile(checks);
    expect(resolvePromptPackExportPath("root", other)).toBe(resolvePromptPackExportPath("root", checks));

    await sources.deletePromptPack(checks.packId);

    expect(await exists(file)).toBe(true);
    expect(promptPacks.deletePackCascade).toHaveBeenCalledExactlyOnceWith(checks.packId);
    expect(reportExportFileKept).not.toHaveBeenCalled();
  });

  it("keeps the export file, and reports it, when the saved packs can't all be read at once", async () => {
    const checks = pack("plugin-meeting-tools-checks");
    // As many saved packs as one read returns: one beyond it might write the same file.
    const many = Array.from({ length: 1_000 }, (_unused, index) => pack(`pack-${index}`, `Pack ${index}`));
    const { sources, promptPacks, reportExportFileKept, exportFile } = await packOwner([checks, ...many]);
    promptPacks.listPacks.mockResolvedValueOnce([checks, ...many].slice(0, 1_000));
    const file = await exportFile(checks);

    await expect(sources.deletePromptPack(checks.packId)).resolves.toBe(true);

    expect(await exists(file)).toBe(true);
    expect(reportExportFileKept).toHaveBeenCalledExactlyOnceWith(checks.packId, expect.any(Error));
    expect(promptPacks.deletePackCascade).toHaveBeenCalledExactlyOnceWith(checks.packId);
  });

  it("still deletes the pack when its export file can't be removed, and reports the file", async () => {
    const checks = pack("plugin-meeting-tools-checks");
    const { sources, promptPacks, reportExportFileKept, rootDir } = await packOwner([checks]);
    // A folder where the file should be can't be removed as a file.
    await fs.mkdir(resolvePromptPackExportPath(rootDir, checks), { recursive: true });

    await sources.deletePromptPack(checks.packId);

    expect(promptPacks.deletePackCascade).toHaveBeenCalledExactlyOnceWith(checks.packId);
    expect(reportExportFileKept).toHaveBeenCalledExactlyOnceWith(checks.packId, expect.any(Error));
  });
});

describe("the waiting Skill Hub steps an uninstall reads", () => {
  function approval(
    approvalId: string,
    intent: { operationKind: string; workspaceId?: string; snapshotId: string },
    overrides: Partial<ApprovalRequest> = {},
  ): ApprovalRequest {
    return {
      approvalId,
      kind: SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
      riskLevel: "caution",
      status: "pending",
      payload: {},
      preview: {
        schemaVersion: SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA,
        intent: { workspaceId: "default", ...intent },
      },
      createdAt: "2026-10-01T00:00:00.000Z",
      explanationStatus: "not_requested",
      ...overrides,
    } as ApprovalRequest;
  }

  it("finds each check's own waiting step on any page, never only the newest approvals", async () => {
    const pages: ApprovalListResponse[] = [
      {
        items: [
          approval("approval-revoke", { operationKind: "revoke", snapshotId: "check-a" }),
          approval("approval-elsewhere", { operationKind: "activate", workspaceId: "other", snapshotId: "check-a" }),
          approval("approval-unrelated", { operationKind: "activate", snapshotId: "check-z" }),
          approval("approval-other-kind", { operationKind: "activate", snapshotId: "check-a" }, { kind: "tool" }),
        ],
        nextCursor: "page-2",
      },
      {
        items: [
          approval("approval-activate", { operationKind: "activate", snapshotId: "check-a" }),
          approval("approval-install", { operationKind: "install_inactive", snapshotId: "check-b" }),
        ],
      },
    ];
    const listPage = vi.fn(async ({ cursor }: { cursor?: string }) => pages[cursor ? 1 : 0]!);

    const steps = await readPendingSkillSteps(listPage, "default", ["check-a", "check-b", "check-c"]);

    expect(steps).toEqual(
      new Map([
        ["check-a", { approvalId: "approval-activate", operation: "activate" }],
        ["check-b", { approvalId: "approval-install", operation: "install_inactive" }],
      ]),
    );
    expect(listPage.mock.calls).toEqual([
      [{ status: "pending", limit: 200 }],
      [{ status: "pending", limit: 200, cursor: "page-2" }],
    ]);
  });

  it("fails the read rather than answer from part of a list longer than it reads", async () => {
    const listPage = vi.fn(async () => ({ items: [], nextCursor: "more" }));

    await expect(readPendingSkillSteps(listPage, "default", ["check-a"])).rejects.toThrow(
      "More than 25 pages of waiting approvals",
    );
    expect(listPage).toHaveBeenCalledTimes(25);
  });
});
