import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemSettingRecord, SystemSettingsRepository } from "@goatcitadel/storage";
import { ObsidianVaultService } from "./obsidian-vault-service.js";

class FakeSystemSettings {
  public readonly values = new Map<string, SystemSettingRecord<unknown>>();

  public get<T = unknown>(key: string): SystemSettingRecord<T> | undefined {
    return this.values.get(key) as SystemSettingRecord<T> | undefined;
  }

  public set<T>(key: string, value: T, now = new Date().toISOString()): SystemSettingRecord<T> {
    const record: SystemSettingRecord<T> = { key, value, updatedAt: now };
    this.values.set(key, record);
    return record;
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function createVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-obsidian-vault-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "GoatCitadel", "Inbox"), { recursive: true });
  await fs.mkdir(path.join(root, "GoatCitadel", "Tasks"), { recursive: true });
  await fs.writeFile(
    path.join(root, "GoatCitadel", "Alpha.md"),
    "Alpha note about release readiness and gateway diagnostics.",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "GoatCitadel", "Tasks", "Release Plan.md"),
    "The release plan mentions Alpha, task coordination, and evidence.",
    "utf8",
  );
  await fs.writeFile(path.join(root, "GoatCitadel", "Tasks", "Ignored.txt"), "Alpha", "utf8");
  return root;
}

function createService(settings = new FakeSystemSettings()): {
  service: ObsidianVaultService;
  settings: FakeSystemSettings;
} {
  return {
    service: new ObsidianVaultService(settings as unknown as SystemSettingsRepository),
    settings,
  };
}

describe("ObsidianVaultService", () => {
  it("normalizes config updates and preserves allowed subpaths when omitted", () => {
    const { service, settings } = createService();

    expect(service.getConfig()).toEqual({
      enabled: false,
      vaultPath: "",
      mode: "read_append",
      allowedSubpaths: [
        "GoatCitadel",
        "GoatCitadel/Inbox",
        "GoatCitadel/Coordination",
        "GoatCitadel/Tasks",
        "GoatCitadel/Decisions",
      ],
    });

    const updated = service.updateConfig({
      enabled: true,
      vaultPath: "  C:/Vault  ",
      mode: "read_only",
      allowedSubpaths: [" /GoatCitadel/Inbox/ ", "GoatCitadel/Inbox"],
    });

    expect(updated).toEqual({
      enabled: true,
      vaultPath: "C:/Vault",
      mode: "read_only",
      allowedSubpaths: ["GoatCitadel/Inbox"],
    });

    expect(service.updateConfig({ mode: "read_append" }).allowedSubpaths).toEqual(["GoatCitadel/Inbox"]);
    expect(() => service.updateConfig({ allowedSubpaths: ["../escape"] })).toThrow(
      "Parent-directory segments are not allowed.",
    );
    expect(settings.get("obsidian_integration_v1")?.value).toMatchObject({
      enabled: true,
      mode: "read_append",
    });
  });

  it("reports vault status and keeps the latest operation timestamp", async () => {
    const vault = await createVault();
    const { service, settings } = createService();

    const disabled = await service.getStatus();
    expect(disabled.vaultReachable).toBe(false);
    expect(disabled.lastError).toBeUndefined();

    service.updateConfig({ enabled: true, vaultPath: "   " });
    await expect(service.getStatus()).resolves.toMatchObject({
      vaultReachable: false,
      lastError: "Obsidian integration enabled but vault path is empty.",
    });

    const notDirectory = path.join(vault, "GoatCitadel", "Alpha.md");
    service.updateConfig({ vaultPath: notDirectory });
    await expect(service.testConnection()).resolves.toMatchObject({
      vaultReachable: false,
      lastError: "Configured Obsidian vault path is not a directory.",
    });

    service.updateConfig({ vaultPath: vault, allowedSubpaths: ["GoatCitadel"] });
    const reachable = await service.getStatus();
    expect(reachable.vaultReachable).toBe(true);
    expect(reachable.lastError).toBeUndefined();

    const results = await service.searchNotes("alpha", 1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ relativePath: "GoatCitadel/Alpha.md", title: "Alpha" });

    const statusState = settings.get<{ lastOperationAt?: string; vaultReachable: boolean }>(
      "obsidian_integration_status_v1",
    )?.value;
    expect(statusState?.vaultReachable).toBe(true);
    expect(statusState?.lastOperationAt).toEqual(expect.any(String));
  });

  it("searches allowed markdown notes, scores title matches first, and rejects invalid searches", async () => {
    const vault = await createVault();
    const { service } = createService();

    await expect(service.searchNotes("alpha")).rejects.toThrow("Obsidian integration is disabled.");

    service.updateConfig({ enabled: true, vaultPath: vault, allowedSubpaths: ["GoatCitadel", "Missing"] });
    await expect(service.searchNotes("   ")).rejects.toThrow("query is required");

    const results = await service.searchNotes("alpha", 20);
    expect(results.map((result) => result.relativePath)).toEqual([
      "GoatCitadel/Alpha.md",
      "GoatCitadel/Tasks/Release Plan.md",
    ]);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[0]?.snippet).toBe("Alpha");
    await expect(service.searchNotes("evidence", 20)).resolves.toEqual([
      expect.objectContaining({
        relativePath: "GoatCitadel/Tasks/Release Plan.md",
        snippet: expect.stringContaining("evidence"),
      }),
    ]);
  });

  it("reads and appends only markdown notes inside configured allowed roots", async () => {
    const vault = await createVault();
    const { service } = createService();
    service.updateConfig({ enabled: true, vaultPath: vault, allowedSubpaths: ["GoatCitadel/Inbox"] });

    await expect(service.readNote("GoatCitadel/Alpha.md")).rejects.toThrow(
      "Path is outside configured Obsidian allowed subpaths.",
    );
    await expect(service.readNote("../GoatCitadel/Inbox/GoatCitadel Inbox.md")).rejects.toThrow(
      "Parent-directory segments are not allowed.",
    );
    await expect(service.readNote("GoatCitadel/Inbox/not-markdown.txt")).rejects.toThrow(
      "Only markdown note paths are allowed.",
    );

    await service.appendToNote("GoatCitadel/Inbox/GoatCitadel Inbox.md", "## New item");
    await expect(service.readNote("GoatCitadel/Inbox/GoatCitadel Inbox.md")).resolves.toEqual({
      relativePath: "GoatCitadel/Inbox/GoatCitadel Inbox.md",
      content: "\n\n## New item\n",
    });

    await expect(service.appendToNote("GoatCitadel/Inbox/Empty.md", "  ")).rejects.toThrow("markdownBlock is required");

    service.updateConfig({ mode: "read_only" });
    await expect(service.appendToNote("GoatCitadel/Inbox/Read Only.md", "content")).rejects.toThrow(
      "Obsidian integration is read-only.",
    );
  });

  it("captures sanitized inbox rows with defaults", async () => {
    const vault = await createVault();
    const { service } = createService();
    service.updateConfig({ enabled: true, vaultPath: vault, allowedSubpaths: ["GoatCitadel/Inbox"] });

    const captured = await service.captureInboxEntry({
      id: "GC|12",
      request: "Confirm release gate",
      notes: "needs | escaping",
    });

    expect(captured.relativePath).toBe("GoatCitadel/Inbox/GoatCitadel Inbox.md");
    expect(captured.row).toBe(
      "| GC\\|12 | Confirm release gate | feature | medium |  | Unassigned | new | [[GoatCitadel Tasks]] | - | needs \\| escaping |",
    );
    await expect(service.readNote(captured.relativePath)).resolves.toMatchObject({
      content: expect.stringContaining(captured.row),
    });

    await expect(service.captureInboxEntry({ id: "missing-request", request: "   " })).rejects.toThrow(
      "request is required",
    );
  });
});
