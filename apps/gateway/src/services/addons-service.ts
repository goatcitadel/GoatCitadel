import fs from "node:fs/promises";
import fsSync, { type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { z } from "zod";
import { buildAddonChildEnv } from "./addon-child-env.js";
import type {
  AddonActionResponse,
  AddonCatalogEntry,
  AddonHealthCheckRecord,
  AddonInstalledRecord,
  AddonInstallRequest,
  AddonStatusRecord,
  AddonUninstallResponse,
} from "@goatcitadel/contracts";
import { AddonSlotService } from "./addon-slot-service.js";
import { readBoundedResponseJson } from "./bounded-response-reader.js";

export interface AddonsServiceOptions {
  slotService?: AddonSlotService;
}

interface AddonManifestFile {
  items: Record<string, AddonInstalledRecord>;
}

const AddonInstalledRecordSchema = z.object({
  addonId: z.string().min(1),
  installedPath: z.string().min(1),
  repoUrl: z.string().url(),
  owner: z.string().min(1),
  sameOwnerAsGoatCitadel: z.boolean(),
  trustTier: z.enum(["trusted", "restricted", "community"]),
  runtimeType: z.literal("separate_repo_app"),
  webEntryMode: z.enum(["none", "external_local_url", "embedded_proxy"]),
  launchUrl: z.string().url().optional(),
  installRef: z.string().min(1).optional(),
  installedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  consentedAt: z.string().min(1),
  consentedBy: z.string().min(1),
  enabled: z.boolean().default(true),
  runtimeStatus: z.enum(["not_installed", "installed", "disabled", "running", "stopped", "error"]),
  pid: z.number().int().positive().optional(),
  lastError: z.string().min(1).optional(),
});

const AddonManifestFileSchema = z.object({
  items: z.record(AddonInstalledRecordSchema).default({}),
});

const ARENA_REPO_URL = "https://github.com/spurnout/goatcitadel-arena";
// Add-on install/build executes repository code on the host. Pin the reviewed
// source revision so a moving default branch cannot change between operator
// consent and execution. Updates move only when GoatCitadel ships a new pin.
const ARENA_REPO_REF = "afce1692c9504aee816423fbb0dcb6bd24496053";
const ARENA_DATABASE_FILE = "arena.db";
const ARENA_DATABASE_COMPANION_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const ARENA_SERVER_PORT = 3099;
const ARENA_SERVER_HEALTH_URL = `http://127.0.0.1:${ARENA_SERVER_PORT}/health`;
const ARENA_LAUNCH_URL = `http://127.0.0.1:${ARENA_SERVER_PORT}/`;
const COREPACK_ENTRYPOINT_RELATIVE_PATH = ["node_modules", "corepack", "dist", "corepack.js"] as const;
const MANIFEST_VERSION: AddonManifestFile = {
  items: {},
};

interface ArenaHealthProbe {
  ready: boolean;
  statusOk: boolean;
  uiReady: boolean;
  uiEntryPath?: string;
}

const ArenaHealthPayloadSchema = z.object({
  status: z.string().optional(),
  uiReady: z.boolean().optional(),
  uiEntryPath: z.string().optional(),
});

const ADDON_CATALOG: AddonCatalogEntry[] = [
  {
    addonId: "arena",
    label: "Arena",
    description: "Optional AI gladiator arena add-on for match play, commentary, and fun agent battles.",
    owner: "spurnout",
    repoUrl: ARENA_REPO_URL,
    sameOwnerAsGoatCitadel: true,
    trustTier: "restricted",
    category: "fun_optional",
    runtimeType: "separate_repo_app",
    installCommands: [
      {
        command: "git",
        args: ["init", "<install-dir>"],
        note: "Creates the isolated add-on repository under the GoatCitadel add-ons root.",
      },
      {
        command: "git",
        args: ["-C", "<install-dir>", "fetch", "--depth", "1", "--no-tags", ARENA_REPO_URL, ARENA_REPO_REF],
        note: "Downloads the immutable Arena revision shipped with this GoatCitadel build.",
      },
      {
        command: "git",
        args: ["-C", "<install-dir>", "checkout", "--detach", ARENA_REPO_REF],
        note: "Checks out the pinned revision before any package or build command runs.",
      },
      {
        command: "corepack",
        args: ["pnpm", "install", "--frozen-lockfile"],
        note: "Installs the Arena workspace dependencies.",
      },
      {
        command: "corepack",
        args: ["pnpm", "-r", "run", "build"],
        note: "Builds the Arena packages and server.",
      },
    ],
    webEntryMode: "external_local_url",
    launchUrl: ARENA_LAUNCH_URL,
    requiresSeparateRepoDownload: true,
    healthChecks: [
      {
        key: "provenance",
        status: "warn",
        message: "Arena downloads code from a separate repository owned by the same publisher as GoatCitadel.",
      },
      {
        key: "ui",
        status: "pass",
        message: "Arena exposes a stable local web entry and launches as a separate local app from the Add-ons page.",
      },
    ],
  },
];

export class AddonsService {
  private readonly goatHomeDir: string;
  private readonly addonsRootDir: string;
  private readonly manifestPath: string;
  private readonly slotService?: AddonSlotService;

  public constructor(
    private readonly rootDir: string,
    options: AddonsServiceOptions = {},
  ) {
    this.goatHomeDir = resolveGoatCitadelHome(rootDir);
    this.addonsRootDir = path.join(this.goatHomeDir, "addons");
    this.manifestPath = path.join(this.addonsRootDir, "manifest.json");
    this.slotService = options.slotService;
  }

  public listCatalog(): AddonCatalogEntry[] {
    return ADDON_CATALOG.map((item) => structuredClone(item));
  }

  public async listInstalled(): Promise<AddonInstalledRecord[]> {
    const manifest = await this.readManifest();
    return Object.values(manifest.items).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async getStatus(addonId: string): Promise<AddonStatusRecord> {
    const addon = this.requireCatalogEntry(addonId);
    const manifest = await this.readManifest();
    const installed = manifest.items[addonId];
    const refreshed = installed ? await this.refreshInstalledRecord(addon, installed) : undefined;
    if (refreshed && this.hasInstalledRecordChanged(installed, refreshed)) {
      manifest.items[addonId] = refreshed;
      await this.writeManifest(manifest);
    }
    return {
      addon,
      installed: refreshed,
      status: refreshed?.runtimeStatus ?? "not_installed",
      healthChecks: await this.buildHealthChecks(addon, refreshed),
    };
  }

  public async install(addonId: string, input: AddonInstallRequest): Promise<AddonActionResponse> {
    const addon = this.requireCatalogEntry(addonId);
    if (!input.confirmRepoDownload) {
      throw new Error("Addon install requires explicit confirmation that a separate repository will be downloaded.");
    }
    await fs.mkdir(this.addonsRootDir, { recursive: true });

    const manifest = await this.readManifest();
    const targetDir = path.join(this.addonsRootDir, addonId);
    if (fsSync.existsSync(targetDir)) {
      const existing = manifest.items[addonId];
      if (existing) {
        return { status: await this.getStatus(addonId) };
      }
      throw new Error(`Addon target path already exists: ${targetDir}`);
    }

    const stagingDir = await this.preparePinnedAddonBuild(addon);
    try {
      // Rename is the admission check too: if anything appeared at the
      // operator-visible target after the earlier existence check, fail closed.
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      await removeManagedAddonTempDirectory(stagingDir, this.addonsRootDir);
      throw error;
    }

    const now = new Date().toISOString();
    manifest.items[addonId] = {
      addonId,
      installedPath: targetDir,
      repoUrl: addon.repoUrl,
      owner: addon.owner,
      sameOwnerAsGoatCitadel: addon.sameOwnerAsGoatCitadel,
      trustTier: addon.trustTier,
      runtimeType: addon.runtimeType,
      webEntryMode: addon.webEntryMode,
      launchUrl: addon.launchUrl,
      installRef: readGitRef(targetDir),
      installedAt: now,
      updatedAt: now,
      consentedAt: now,
      consentedBy: input.actorId?.trim() || "operator",
      enabled: false,
      runtimeStatus: "disabled",
    };
    try {
      await this.writeManifest(manifest);
    } catch (error) {
      await removeNewAddonInstall(targetDir, this.addonsRootDir, addonId);
      throw error;
    }
    this.slotService?.unregister(addonId);
    return {
      status: await this.getStatus(addonId),
    };
  }

  public async enable(addonId: string): Promise<AddonActionResponse> {
    const addon = this.requireCatalogEntry(addonId);
    const manifest = await this.readManifest();
    const current = this.requireInstalledRecord(addonId, manifest);
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    if (!fsSync.existsSync(installedPath)) {
      throw new Error(`Installed add-on path is missing: ${installedPath}`);
    }
    manifest.items[addonId] = {
      ...current,
      installedPath,
      enabled: true,
      runtimeStatus: current.runtimeStatus === "disabled" ? "installed" : current.runtimeStatus,
      updatedAt: new Date().toISOString(),
      lastError: undefined,
    };
    await this.writeManifest(manifest);
    this.slotService?.registerDeclarations(addonId, addon.dashboardSlots ?? []);
    return {
      status: await this.getStatus(addonId),
    };
  }

  public async disable(addonId: string): Promise<AddonActionResponse> {
    this.requireCatalogEntry(addonId);
    const manifest = await this.readManifest();
    const current = this.requireInstalledRecord(addonId, manifest);
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    if (typeof current.pid === "number") {
      killProcessTree(current.pid);
    }
    manifest.items[addonId] = {
      ...current,
      installedPath,
      enabled: false,
      pid: undefined,
      runtimeStatus: "disabled",
      updatedAt: new Date().toISOString(),
      lastError: undefined,
    };
    await this.writeManifest(manifest);
    this.slotService?.unregister(addonId);
    return {
      status: await this.getStatus(addonId),
    };
  }

  public async update(addonId: string): Promise<AddonActionResponse> {
    const addon = this.requireCatalogEntry(addonId);
    const manifest = await this.readManifest();
    const current = this.requireInstalledRecord(addonId, manifest);
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    const backupDir = path.join(this.addonsRootDir, `.${addonId}-update-backup`);
    await recoverInterruptedAddonUpdate({
      installedPath,
      backupDir,
      manifestInstallRef: current.installRef,
      addonsRootDir: this.addonsRootDir,
    });
    if (!fsSync.existsSync(installedPath)) {
      throw new Error(`Installed add-on path is missing: ${installedPath}`);
    }
    if (typeof current.pid === "number" && isProcessRunning(current.pid)) {
      throw new Error(`Stop add-on ${addonId} before updating it.`);
    }
    if (addonId === "arena") {
      await prepareArenaDataPath(installedPath, this.addonsRootDir);
    }
    let stagingDir: string | undefined;
    let oldMoved = false;
    let newPlaced = false;
    try {
      stagingDir = await this.preparePinnedAddonBuild(addon);
      await fs.rename(installedPath, backupDir);
      oldMoved = true;
      await fs.rename(stagingDir, installedPath);
      stagingDir = undefined;
      newPlaced = true;
      manifest.items[addonId] = {
        ...current,
        installedPath,
        webEntryMode: addon.webEntryMode,
        launchUrl: current.launchUrl ?? addon.launchUrl,
        installRef: readGitRef(installedPath),
        updatedAt: new Date().toISOString(),
        runtimeStatus:
          current.enabled === false ? "disabled" : current.runtimeStatus === "running" ? "running" : "installed",
        lastError: undefined,
      };
      await this.writeManifest(manifest);
    } catch (error) {
      if (newPlaced) {
        const failedInstallDir = path.join(this.addonsRootDir, `.${addonId}-staging-${randomUUID()}`);
        await fs.rename(installedPath, failedInstallDir);
        stagingDir = failedInstallDir;
      }
      if (oldMoved) {
        await fs.rename(backupDir, installedPath);
      }
      if (stagingDir) {
        await removeManagedAddonTempDirectory(stagingDir, this.addonsRootDir);
      }
      manifest.items[addonId] = {
        ...current,
        installedPath,
        updatedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      await this.writeManifest(manifest);
      throw error;
    }
    await removeManagedAddonTempDirectory(backupDir, this.addonsRootDir);
    return {
      status: await this.getStatus(addonId),
    };
  }

  private async preparePinnedAddonBuild(addon: AddonCatalogEntry): Promise<string> {
    const stagingDir = await fs.mkdtemp(path.join(this.addonsRootDir, `.${addon.addonId}-staging-`));
    const disabledHooksDir = await fs.mkdtemp(path.join(this.addonsRootDir, ".git-hooks-"));
    const isolatedGlobalConfig = path.join(disabledHooksDir, "global.gitconfig");
    await fs.writeFile(isolatedGlobalConfig, "", { encoding: "utf8", flag: "wx" });
    const isolatedGitEnv = {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: isolatedGlobalConfig,
    };
    try {
      checkoutPinnedAddonRevision({
        repoUrl: addon.repoUrl,
        targetDir: stagingDir,
        disabledHooksDir,
        isolatedGlobalConfig,
      });
      runCommand("corepack", ["pnpm", "install", "--frozen-lockfile"], stagingDir, isolatedGitEnv);
      runCommand("corepack", ["pnpm", "-r", "run", "build"], stagingDir, isolatedGitEnv);
      return stagingDir;
    } catch (error) {
      await removeManagedAddonTempDirectory(stagingDir, this.addonsRootDir);
      throw error;
    } finally {
      await removeManagedAddonTempDirectory(disabledHooksDir, this.addonsRootDir);
    }
  }

  public async launch(addonId: string): Promise<AddonActionResponse> {
    const addon = this.requireCatalogEntry(addonId);
    const manifest = await this.readManifest();
    const current = this.requireInstalledRecord(addonId, manifest);
    if (current.enabled === false || current.runtimeStatus === "disabled") {
      throw new Error(`Add-on ${addonId} is disabled. Enable it before launch.`);
    }
    if (addonId !== "arena") {
      throw new Error(`Launch flow is not implemented for add-on ${addonId}.`);
    }
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    if (!fsSync.existsSync(installedPath)) {
      throw new Error(`Installed add-on path is missing: ${installedPath}`);
    }
    const alreadyRunning = typeof current.pid === "number" && isProcessRunning(current.pid);
    if (!alreadyRunning) {
      const arenaDbPath = await prepareArenaDataPath(installedPath, this.addonsRootDir);
      const child = spawnDetachedCommand("corepack", ["pnpm", "--filter", "@arena/server", "start"], installedPath, {
        ARENA_HOST: "127.0.0.1",
        ARENA_PORT: String(ARENA_SERVER_PORT),
        CORS_ORIGIN: ARENA_LAUNCH_URL.replace(/\/$/, ""),
        GOATCITADEL_BASE_URL: "http://127.0.0.1:8787",
        ARENA_DB_PATH: arenaDbPath,
      });
      current.pid = child.pid;
    }

    const probe = await waitForArenaReady(ARENA_SERVER_HEALTH_URL, 12_000);
    const ready = probe?.ready ?? false;
    const updated: AddonInstalledRecord = {
      ...current,
      installedPath,
      enabled: true,
      webEntryMode: addon.webEntryMode,
      launchUrl: current.launchUrl ?? addon.launchUrl,
      runtimeStatus: ready ? "running" : "error",
      updatedAt: new Date().toISOString(),
      lastError: ready ? undefined : `Arena health check did not report uiReady at ${ARENA_SERVER_HEALTH_URL}.`,
    };
    manifest.items[addonId] = updated;
    await this.writeManifest(manifest);
    return {
      status: await this.getStatus(addonId),
    };
  }

  public async stop(addonId: string): Promise<AddonActionResponse> {
    this.requireCatalogEntry(addonId);
    const manifest = await this.readManifest();
    const current = this.requireInstalledRecord(addonId, manifest);
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    if (typeof current.pid === "number") {
      killProcessTree(current.pid);
    }
    const updated: AddonInstalledRecord = {
      ...current,
      installedPath,
      enabled: current.enabled ?? true,
      pid: undefined,
      launchUrl: current.launchUrl ?? ARENA_LAUNCH_URL,
      runtimeStatus: current.enabled === false ? "disabled" : "stopped",
      updatedAt: new Date().toISOString(),
      lastError: undefined,
    };
    manifest.items[addonId] = updated;
    await this.writeManifest(manifest);
    return {
      status: await this.getStatus(addonId),
    };
  }

  public async uninstall(addonId: string): Promise<AddonUninstallResponse> {
    this.requireCatalogEntry(addonId);
    const manifest = await this.readManifest();
    const current = this.requireInstalledRecord(addonId, manifest);
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    if (typeof current.pid === "number") {
      killProcessTree(current.pid);
    }
    await fs.rm(installedPath, { recursive: true, force: true });
    delete manifest.items[addonId];
    await this.writeManifest(manifest);
    this.slotService?.unregister(addonId);
    return {
      addonId,
      removed: true,
    };
  }

  private async buildHealthChecks(
    addon: AddonCatalogEntry,
    installed?: AddonInstalledRecord,
  ): Promise<AddonHealthCheckRecord[]> {
    const checks: AddonHealthCheckRecord[] = [...addon.healthChecks];
    if (!installed) {
      checks.push({
        key: "install",
        status: "warn",
        message: "Add-on is not installed yet.",
      });
      return checks;
    }

    if (installed.enabled === false || installed.runtimeStatus === "disabled") {
      checks.push({
        key: "enabled",
        status: "warn",
        message: "Add-on is installed but disabled. Enable it before launch or dashboard slot registration.",
      });
    } else {
      checks.push({
        key: "enabled",
        status: "pass",
        message: "Add-on is enabled for operator-controlled launch and slot registration.",
      });
    }

    const installedPath = assertAddonPathWithinRoot(installed.installedPath, this.addonsRootDir);
    checks.push({
      key: "installed_path",
      status: fsSync.existsSync(installedPath) ? "pass" : "fail",
      message: fsSync.existsSync(installedPath)
        ? `Installed at ${installedPath}.`
        : `Installed path is missing: ${installedPath}.`,
    });

    const arenaServerEntry = path.join(installedPath, "apps", "server", "dist", "index.js");
    const arenaWebEntry = path.join(installedPath, "apps", "web", "dist", "index.html");
    checks.push({
      key: "build_output",
      status: fsSync.existsSync(arenaServerEntry) ? "pass" : "warn",
      message: fsSync.existsSync(arenaServerEntry)
        ? "Arena server build output exists."
        : "Arena build output is missing; rerun update/build if launch fails.",
    });
    checks.push({
      key: "web_build",
      status: fsSync.existsSync(arenaWebEntry) ? "pass" : "warn",
      message: fsSync.existsSync(arenaWebEntry)
        ? "Arena web build output exists."
        : "Arena web build output is missing; rebuild Arena before trying to open it from GoatCitadel.",
    });

    if (installed.runtimeStatus === "running") {
      const probe = await readArenaHealth(ARENA_SERVER_HEALTH_URL, 1_500);
      const healthy = probe?.ready ?? false;
      checks.push({
        key: "health",
        status: healthy ? "pass" : "fail",
        message: healthy
          ? `Health check passed at ${ARENA_SERVER_HEALTH_URL} and Arena reported uiReady.`
          : `Health check failed or Arena did not report uiReady at ${ARENA_SERVER_HEALTH_URL}.`,
      });
    } else {
      checks.push({
        key: "health",
        status: "warn",
        message: "Add-on runtime is not running yet.",
      });
    }

    return checks;
  }

  private async refreshInstalledRecord(
    addon: AddonCatalogEntry,
    installed: AddonInstalledRecord,
  ): Promise<AddonInstalledRecord> {
    const installedPath = assertAddonPathWithinRoot(installed.installedPath, this.addonsRootDir);
    const normalizedRecord: AddonInstalledRecord = {
      ...installed,
      installedPath,
      enabled: installed.enabled ?? true,
      webEntryMode: addon.webEntryMode,
      launchUrl: installed.launchUrl ?? addon.launchUrl,
    };
    if (normalizedRecord.enabled === false || normalizedRecord.runtimeStatus === "disabled") {
      return {
        ...normalizedRecord,
        pid: undefined,
        runtimeStatus: "disabled",
        lastError: undefined,
      };
    }
    if (!fsSync.existsSync(installedPath)) {
      return {
        ...normalizedRecord,
        runtimeStatus: "error",
        lastError: `Installed path is missing: ${installedPath}.`,
        updatedAt: new Date().toISOString(),
      };
    }
    const hasRunningPid = typeof installed.pid === "number" && isProcessRunning(installed.pid);
    if (!hasRunningPid && installed.runtimeStatus === "running") {
      return {
        ...normalizedRecord,
        pid: undefined,
        runtimeStatus: "stopped",
        updatedAt: new Date().toISOString(),
      };
    }
    if (addon.addonId === "arena" && hasRunningPid) {
      const probe = await readArenaHealth(ARENA_SERVER_HEALTH_URL, 1_500);
      if (!(probe?.ready ?? false)) {
        return {
          ...normalizedRecord,
          runtimeStatus: "error",
          lastError: `Arena process is running but the health check did not report uiReady at ${ARENA_SERVER_HEALTH_URL}.`,
          updatedAt: new Date().toISOString(),
        };
      }
    }
    return normalizedRecord;
  }

  private requireCatalogEntry(addonId: string): AddonCatalogEntry {
    const addon = ADDON_CATALOG.find((item) => item.addonId === addonId);
    if (!addon) {
      throw new Error(`Unknown add-on: ${addonId}`);
    }
    return structuredClone(addon);
  }

  private requireInstalledRecord(addonId: string, manifest: AddonManifestFile): AddonInstalledRecord {
    const installed = manifest.items[addonId];
    if (!installed) {
      throw new Error(`Add-on ${addonId} is not installed.`);
    }
    return installed;
  }

  private async readManifest(): Promise<AddonManifestFile> {
    await fs.mkdir(this.addonsRootDir, { recursive: true });
    if (!fsSync.existsSync(this.manifestPath)) {
      return structuredClone(MANIFEST_VERSION);
    }
    let manifest: AddonManifestFile;
    try {
      const raw = await fs.readFile(this.manifestPath, "utf8");
      const parsed = AddonManifestFileSchema.parse(JSON.parse(raw));
      const items = Object.fromEntries(
        Object.entries(parsed.items).map(([addonId, record]) => {
          if (record.addonId !== addonId) {
            throw new Error(`Invalid add-on manifest at ${this.manifestPath}.`);
          }
          return [
            addonId,
            { ...record, installedPath: assertAddonPathWithinRoot(record.installedPath, this.addonsRootDir) },
          ];
        }),
      );
      manifest = { items };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError || error instanceof Error) {
        throw new Error(`Invalid add-on manifest at ${this.manifestPath}.`, { cause: error });
      }
      return structuredClone(MANIFEST_VERSION);
    }
    for (const [addonId, record] of Object.entries(manifest.items)) {
      await recoverInterruptedAddonUpdate({
        installedPath: record.installedPath,
        backupDir: path.join(this.addonsRootDir, `.${addonId}-update-backup`),
        manifestInstallRef: record.installRef,
        addonsRootDir: this.addonsRootDir,
      });
    }
    return manifest;
  }

  private async writeManifest(manifest: AddonManifestFile): Promise<void> {
    await fs.mkdir(this.addonsRootDir, { recursive: true });
    const temporaryPath = path.join(this.addonsRootDir, `.manifest-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporaryPath, this.manifestPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private hasInstalledRecordChanged(previous: AddonInstalledRecord | undefined, next: AddonInstalledRecord): boolean {
    return JSON.stringify(previous) !== JSON.stringify(next);
  }
}

function resolveGoatCitadelHome(rootDir: string): string {
  const envHome = process.env.GOATCITADEL_HOME?.trim();
  if (envHome) {
    return path.resolve(envHome);
  }

  const normalizedRoot = path.resolve(rootDir);
  if (path.basename(normalizedRoot).toLowerCase() === "app") {
    const parent = path.dirname(normalizedRoot);
    if (path.basename(parent).toLowerCase() === ".goatcitadel") {
      return parent;
    }
  }

  return path.join(os.homedir(), ".GoatCitadel");
}

function runCommand(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  const resolved = resolveCommandInvocation(command, args);
  return execFileSync(resolved.file, resolved.args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    env: buildAddonChildEnv(extraEnv),
  });
}

function resolveCommandInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  nodeExecutable: string = process.execPath,
): { file: string; args: string[] } {
  if (platform !== "win32" || command !== "corepack") {
    return { file: command, args };
  }

  const nodeDir = path.win32.dirname(nodeExecutable);
  const corepackEntrypoint = path.win32.join(nodeDir, ...COREPACK_ENTRYPOINT_RELATIVE_PATH);
  if (nodeExecutable === process.execPath && !fsSync.existsSync(corepackEntrypoint)) {
    throw new Error(`Unable to resolve the Corepack entrypoint at ${corepackEntrypoint}.`);
  }

  return {
    file: nodeExecutable,
    args: [corepackEntrypoint, ...args],
  };
}

function spawnDetachedCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>,
): { pid: number } {
  const resolved = resolveCommandInvocation(command, args);
  const child = spawn(resolved.file, resolved.args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: buildAddonChildEnv(extraEnv),
  });
  child.unref();
  if (typeof child.pid !== "number") {
    throw new Error("Failed to start add-on process.");
  }
  return { pid: child.pid };
}

function checkoutPinnedAddonRevision(input: {
  repoUrl: string;
  targetDir: string;
  disabledHooksDir: string;
  isolatedGlobalConfig: string;
}): void {
  const hookStats = fsSync.lstatSync(input.disabledHooksDir);
  if (!hookStats.isDirectory() || hookStats.isSymbolicLink()) {
    throw new Error("Refusing to use an unsafe Git hooks directory for add-on checkout.");
  }
  const gitArgs = (...args: string[]) => [
    "-c",
    `core.hooksPath=${input.disabledHooksDir}`,
    "-c",
    "core.fsmonitor=false",
    ...args,
  ];
  const gitEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: input.isolatedGlobalConfig,
  };
  runCommand("git", gitArgs("init", input.targetDir), path.dirname(input.targetDir), gitEnv);
  runCommand(
    "git",
    gitArgs("-C", input.targetDir, "fetch", "--depth", "1", "--no-tags", input.repoUrl, ARENA_REPO_REF),
    input.targetDir,
    gitEnv,
  );
  runCommand(
    "git",
    gitArgs("-C", input.targetDir, "checkout", "--detach", "--force", ARENA_REPO_REF),
    input.targetDir,
    gitEnv,
  );
  const checkedOutRef = readGitRef(input.targetDir, gitEnv);
  if (checkedOutRef?.toLowerCase() !== ARENA_REPO_REF) {
    throw new Error(
      `Arena checkout integrity mismatch: expected ${ARENA_REPO_REF}, received ${checkedOutRef ?? "missing"}.`,
    );
  }
  const worktreeState = runCommand(
    "git",
    gitArgs("-C", input.targetDir, "status", "--porcelain=v1", "--untracked-files=all"),
    input.targetDir,
    gitEnv,
  ).trim();
  if (worktreeState) {
    throw new Error("Arena checkout is not clean after pinned checkout; refusing to install or build it.");
  }
}

function readGitRef(targetDir: string, extraEnv: Record<string, string> = {}): string | undefined {
  try {
    const result = execFileSync("git", ["-C", targetDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: "pipe",
      env: buildAddonChildEnv(extraEnv),
    });
    return result.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    process.kill(pid, "SIGTERM");
  } catch {
    // Best effort stop; status refresh will mark failures later.
  }
}

async function readArenaHealth(url: string, timeoutMs: number): Promise<ArenaHealthProbe | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      return null;
    }
    const payload = ArenaHealthPayloadSchema.safeParse(
      await readBoundedResponseJson(response, {
        maxBytes: 32 * 1024,
        timeoutMs,
        label: "Arena health",
      }),
    );
    if (!payload.success) {
      return null;
    }
    return {
      ready: payload.data.status === "ok" && payload.data.uiReady === true,
      statusOk: payload.data.status === "ok",
      uiReady: payload.data.uiReady === true,
      uiEntryPath: payload.data.uiEntryPath,
    };
  } catch {
    return null;
  }
}

async function waitForArenaReady(url: string, timeoutMs: number): Promise<ArenaHealthProbe | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const probe = await readArenaHealth(url, 1_000);
    if (probe?.ready) {
      return probe;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

function assertAddonPathWithinRoot(installedPath: string, addonsRootDir: string): string {
  const resolvedRoot = path.resolve(addonsRootDir);
  const resolvedPath = path.resolve(installedPath);
  const rootVariants = pathVariantsForAddonBoundary(resolvedRoot);
  const pathVariants = pathVariantsForAddonBoundary(resolvedPath);
  const allowed = pathVariants.every((candidate) =>
    rootVariants.some((rootVariant) => {
      const relative = path.relative(rootVariant, candidate);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    }),
  );
  if (allowed) {
    return resolvedPath;
  }
  throw new Error(`Add-on path escapes add-ons root: ${installedPath}`);
}

function pathVariantsForAddonBoundary(inputPath: string): string[] {
  const resolved = path.resolve(inputPath);
  if (!fsSync.existsSync(resolved)) {
    return [resolved];
  }
  const real = fsSync.realpathSync.native(resolved);
  return real === resolved ? [resolved] : [resolved, real];
}

async function removeManagedAddonTempDirectory(targetDir: string, addonsRootDir: string): Promise<void> {
  const resolved = assertAddonPathWithinRoot(targetDir, addonsRootDir);
  const name = path.basename(resolved);
  if (
    !/^\.(?:[a-z0-9_-]+-staging|[a-z0-9_-]+-backup|git-hooks)-/i.test(name) &&
    !/^\.[a-z0-9_-]+-update-backup$/i.test(name)
  ) {
    throw new Error(`Refusing to remove an unmanaged add-on directory: ${resolved}`);
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

async function prepareArenaDataPath(installedPath: string, addonsRootDir: string): Promise<string> {
  const safeInstalledPath = assertAddonPathWithinRoot(installedPath, addonsRootDir);
  const dataDirectory = path.join(addonsRootDir, "data", "arena");
  await ensureAddonDirectoryWithoutLinks(dataDirectory, addonsRootDir);

  for (const suffix of ARENA_DATABASE_COMPANION_SUFFIXES) {
    const fileName = `${ARENA_DATABASE_FILE}${suffix}`;
    const legacyPath = path.join(safeInstalledPath, fileName);
    const durablePath = path.join(dataDirectory, fileName);
    const legacyStats = await lstatIfPresent(legacyPath);
    const durableStats = await lstatIfPresent(durablePath);
    assertRegularAddonDataFile(legacyPath, legacyStats);
    assertRegularAddonDataFile(durablePath, durableStats);
    if (legacyStats && durableStats) {
      throw new Error(`Arena database migration is ambiguous because both ${legacyPath} and ${durablePath} exist.`);
    }
    if (legacyStats) {
      await fs.rename(legacyPath, durablePath);
    }
  }

  return path.join(dataDirectory, ARENA_DATABASE_FILE);
}

async function recoverInterruptedAddonUpdate(input: {
  installedPath: string;
  backupDir: string;
  manifestInstallRef?: string;
  addonsRootDir: string;
}): Promise<void> {
  const installedPath = assertAddonPathWithinRoot(input.installedPath, input.addonsRootDir);
  const backupDir = assertAddonPathWithinRoot(input.backupDir, input.addonsRootDir);
  const backupStats = await lstatIfPresent(backupDir);
  if (!backupStats) {
    return;
  }
  if (!backupStats.isDirectory() || backupStats.isSymbolicLink()) {
    throw new Error(`Refusing to recover from an unsafe add-on update backup: ${backupDir}`);
  }

  const installedStats = await lstatIfPresent(installedPath);
  if (!installedStats) {
    await fs.rename(backupDir, installedPath);
    return;
  }
  if (!installedStats.isDirectory() || installedStats.isSymbolicLink()) {
    throw new Error(`Refusing to recover over an unsafe add-on install path: ${installedPath}`);
  }

  const installedRef = readGitRef(installedPath);
  const backupRef = readGitRef(backupDir);
  if (input.manifestInstallRef && installedRef === input.manifestInstallRef) {
    await removeManagedAddonTempDirectory(backupDir, input.addonsRootDir);
    return;
  }
  if (!input.manifestInstallRef || backupRef === input.manifestInstallRef) {
    const interruptedInstallDir = path.join(
      input.addonsRootDir,
      `.${path.basename(installedPath)}-staging-${randomUUID()}`,
    );
    await fs.rename(installedPath, interruptedInstallDir);
    try {
      await fs.rename(backupDir, installedPath);
    } catch (error) {
      await fs.rename(interruptedInstallDir, installedPath);
      throw error;
    }
    await removeManagedAddonTempDirectory(interruptedInstallDir, input.addonsRootDir);
    return;
  }

  throw new Error(
    `Unable to determine the committed add-on update state for ${installedPath}; both install and backup were preserved.`,
  );
}

async function ensureAddonDirectoryWithoutLinks(directory: string, addonsRootDir: string): Promise<void> {
  const root = path.resolve(addonsRootDir);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Add-on data path escapes add-ons root: ${directory}`);
  }
  await fs.mkdir(root, { recursive: true });
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const existing = await lstatIfPresent(current);
    if (!existing) {
      await fs.mkdir(current);
    }
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Refusing to use a linked or non-directory add-on data path: ${current}`);
    }
  }
}

async function lstatIfPresent(targetPath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function assertRegularAddonDataFile(targetPath: string, stats: Stats | undefined): void {
  if (stats && (!stats.isFile() || stats.isSymbolicLink())) {
    throw new Error(`Refusing to use a linked or non-file Arena database path: ${targetPath}`);
  }
}

async function removeNewAddonInstall(targetDir: string, addonsRootDir: string, addonId: string): Promise<void> {
  const resolved = assertAddonPathWithinRoot(targetDir, addonsRootDir);
  const expected = path.resolve(addonsRootDir, addonId);
  if (resolved !== expected) {
    throw new Error(`Refusing to remove unexpected add-on install path: ${resolved}`);
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

export const __internal = {
  ARENA_REPO_REF,
  AddonManifestFileSchema,
  assertAddonPathWithinRoot,
  buildAddonChildEnv,
  checkoutPinnedAddonRevision,
  prepareArenaDataPath,
  recoverInterruptedAddonUpdate,
  resolveCommandInvocation,
};
