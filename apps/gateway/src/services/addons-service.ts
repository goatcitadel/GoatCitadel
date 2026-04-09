import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { z } from "zod";
import type {
  AddonActionResponse,
  AddonCatalogEntry,
  AddonHealthCheckRecord,
  AddonInstalledRecord,
  AddonInstallRequest,
  AddonStatusRecord,
  AddonUninstallResponse,
} from "@goatcitadel/contracts";

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
  runtimeStatus: z.enum(["not_installed", "installed", "running", "stopped", "error"]),
  pid: z.number().int().positive().optional(),
  lastError: z.string().min(1).optional(),
});

const AddonManifestFileSchema = z.object({
  items: z.record(AddonInstalledRecordSchema).default({}),
});

const ARENA_REPO_URL = "https://github.com/spurnout/goatcitadel-arena";
const ARENA_SERVER_PORT = 3099;
const ARENA_SERVER_HEALTH_URL = `http://127.0.0.1:${ARENA_SERVER_PORT}/health`;
const ARENA_LAUNCH_URL = `http://127.0.0.1:${ARENA_SERVER_PORT}/`;
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
        args: ["clone", "--depth", "1", ARENA_REPO_URL, "<install-dir>"],
        note: "Downloads the add-on into the GoatCitadel add-ons root.",
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

  public constructor(private readonly rootDir: string) {
    this.goatHomeDir = resolveGoatCitadelHome(rootDir);
    this.addonsRootDir = path.join(this.goatHomeDir, "addons");
    this.manifestPath = path.join(this.addonsRootDir, "manifest.json");
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

    runCommand("git", ["clone", "--depth", "1", addon.repoUrl, targetDir], this.rootDir);
    runCommand("corepack", ["pnpm", "install", "--frozen-lockfile"], targetDir);
    runCommand("corepack", ["pnpm", "-r", "run", "build"], targetDir);

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
      runtimeStatus: "installed",
    };
    await this.writeManifest(manifest);
    return {
      status: await this.getStatus(addonId),
    };
  }

  public async update(addonId: string): Promise<AddonActionResponse> {
    const addon = this.requireCatalogEntry(addonId);
    const manifest = await this.readManifest();
    const current = this.requireInstalledRecord(addonId, manifest);
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    if (!fsSync.existsSync(installedPath)) {
      throw new Error(`Installed add-on path is missing: ${installedPath}`);
    }
    const previousRef = readGitRef(installedPath);
    try {
      runCommand("git", ["-C", installedPath, "pull", "--ff-only"], this.rootDir);
      runCommand("corepack", ["pnpm", "install", "--frozen-lockfile"], installedPath);
      runCommand("corepack", ["pnpm", "-r", "run", "build"], installedPath);
      manifest.items[addonId] = {
        ...current,
        installedPath,
        webEntryMode: addon.webEntryMode,
        launchUrl: current.launchUrl ?? addon.launchUrl,
        installRef: readGitRef(installedPath),
        updatedAt: new Date().toISOString(),
        runtimeStatus: current.runtimeStatus === "running" ? "running" : "installed",
        lastError: undefined,
      };
      await this.writeManifest(manifest);
      return {
        status: await this.getStatus(addonId),
      };
    } catch (error) {
      rollbackAddonRepo(installedPath, previousRef);
      manifest.items[addonId] = {
        ...current,
        installedPath,
        updatedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      };
      await this.writeManifest(manifest);
      throw error;
    }
  }

  public async launch(addonId: string): Promise<AddonActionResponse> {
    const addon = this.requireCatalogEntry(addonId);
    const manifest = await this.readManifest();
    const current = this.requireInstalledRecord(addonId, manifest);
    if (addonId !== "arena") {
      throw new Error(`Launch flow is not implemented for add-on ${addonId}.`);
    }
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    if (!fsSync.existsSync(installedPath)) {
      throw new Error(`Installed add-on path is missing: ${installedPath}`);
    }
    const alreadyRunning = typeof current.pid === "number" && isProcessRunning(current.pid);
    if (!alreadyRunning) {
      const child = spawnDetachedCommand("corepack", ["pnpm", "--filter", "@arena/server", "start"], installedPath, {
        ARENA_HOST: "127.0.0.1",
        ARENA_PORT: String(ARENA_SERVER_PORT),
        CORS_ORIGIN: ARENA_LAUNCH_URL.replace(/\/$/, ""),
        GOATCITADEL_BASE_URL: "http://127.0.0.1:8787",
      });
      current.pid = child.pid;
    }

    const probe = await waitForArenaReady(ARENA_SERVER_HEALTH_URL, 12_000);
    const ready = probe?.ready ?? false;
    const updated: AddonInstalledRecord = {
      ...current,
      installedPath,
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
    const manifest = await this.readManifest();
    const current = this.requireInstalledRecord(addonId, manifest);
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    if (typeof current.pid === "number") {
      killProcessTree(current.pid);
    }
    const updated: AddonInstalledRecord = {
      ...current,
      installedPath,
      pid: undefined,
      launchUrl: current.launchUrl ?? ARENA_LAUNCH_URL,
      runtimeStatus: "stopped",
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
    const manifest = await this.readManifest();
    const current = this.requireInstalledRecord(addonId, manifest);
    const installedPath = assertAddonPathWithinRoot(current.installedPath, this.addonsRootDir);
    if (typeof current.pid === "number") {
      killProcessTree(current.pid);
    }
    await fs.rm(installedPath, { recursive: true, force: true });
    delete manifest.items[addonId];
    await this.writeManifest(manifest);
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
      webEntryMode: addon.webEntryMode,
      launchUrl: installed.launchUrl ?? addon.launchUrl,
    };
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
      return { items };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError || error instanceof Error) {
        throw new Error(`Invalid add-on manifest at ${this.manifestPath}.`, { cause: error });
      }
      return structuredClone(MANIFEST_VERSION);
    }
  }

  private async writeManifest(manifest: AddonManifestFile): Promise<void> {
    await fs.mkdir(this.addonsRootDir, { recursive: true });
    await fs.writeFile(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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

function runCommand(command: string, args: string[], cwd: string): void {
  if (process.platform === "win32") {
    const commandLine = buildWindowsCommand([command, ...args]);
    execFileSync("cmd.exe", ["/d", "/s", "/c", commandLine], {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
    });
    return;
  }
  execFileSync(command, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
  });
}

function buildWindowsCommand(parts: string[]): string {
  return parts.map((value) => quoteWindowsCommandArg(value)).join(" ");
}

function quoteWindowsCommandArg(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (!/[\s"&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function spawnDetachedCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>,
): { pid: number } {
  if (process.platform === "win32") {
    const commandLine = buildWindowsCommand([command, ...args]);
    const child = spawn("cmd.exe", ["/d", "/s", "/c", commandLine], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    child.unref();
    if (typeof child.pid !== "number") {
      throw new Error("Failed to start add-on process.");
    }
    return { pid: child.pid };
  }

  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  child.unref();
  if (typeof child.pid !== "number") {
    throw new Error("Failed to start add-on process.");
  }
  return { pid: child.pid };
}

function readGitRef(targetDir: string): string | undefined {
  try {
    const result = execFileSync("git", ["-C", targetDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: "pipe",
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
    const payload = ArenaHealthPayloadSchema.safeParse(await response.json());
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
  const safeRoot = fsSync.existsSync(resolvedRoot) ? fsSync.realpathSync.native(resolvedRoot) : resolvedRoot;
  const safePath = fsSync.existsSync(resolvedPath) ? fsSync.realpathSync.native(resolvedPath) : resolvedPath;
  const relative = path.relative(safeRoot, safePath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return safePath;
  }
  throw new Error(`Add-on path escapes add-ons root: ${installedPath}`);
}

function rollbackAddonRepo(targetDir: string, previousRef: string | undefined): void {
  if (!previousRef) {
    return;
  }
  try {
    runCommand("git", ["-C", targetDir, "reset", "--hard", previousRef], targetDir);
  } catch {
    // Best-effort rollback; the original failure is more important to surface.
  }
}

export const __internal = {
  AddonManifestFileSchema,
  assertAddonPathWithinRoot,
  buildWindowsCommand,
  quoteWindowsCommandArg,
};
