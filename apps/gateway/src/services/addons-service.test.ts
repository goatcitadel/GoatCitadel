import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() =>
  vi.fn(() => ({
    pid: 4321,
    unref: vi.fn(),
  })),
);

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  spawn: spawnMock,
}));

import { AddonsService, __internal } from "./addons-service.js";
import { AddonSlotService } from "./addon-slot-service.js";

describe("AddonsService", () => {
  let tempDir: string;
  let goatHome: string;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    execFileSyncMock.mockReset();
    spawnMock.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-addons-"));
    goatHome = path.join(tempDir, ".GoatCitadel");
    process.env.GOATCITADEL_HOME = goatHome;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.GOATCITADEL_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("resolves corepack to the local Node entrypoint on Windows", () => {
    const resolved = __internal.resolveCommandInvocation(
      "corepack",
      ["pnpm", "install", "--frozen-lockfile"],
      "win32",
      "C:\\Program Files\\nodejs\\node.exe",
    );

    expect(resolved).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\corepack.js",
        "pnpm",
        "install",
        "--frozen-lockfile",
      ],
    });
  });

  it("rejects addon paths that escape the addons root", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    await fs.mkdir(addonsRoot, { recursive: true });

    expect(() =>
      __internal.assertAddonPathWithinRoot(path.join(addonsRoot, "..", "..", "Documents"), addonsRoot),
    ).toThrow("escapes add-ons root");
  });

  it("builds add-on child environments without inherited provider keys or auth secrets", () => {
    const originalOpenAi = process.env.OPENAI_API_KEY;
    const originalAuthToken = process.env.GOATCITADEL_AUTH_TOKEN;
    const originalPostgresPassword = process.env.GOATCITADEL_POSTGRES_PASSWORD;
    const originalNpmUserConfig = process.env.NPM_CONFIG_USERCONFIG;
    const originalNpmRegistry = process.env.NPM_CONFIG_REGISTRY;
    try {
      process.env.OPENAI_API_KEY = "sk-secret";
      process.env.GOATCITADEL_AUTH_TOKEN = "operator-token";
      process.env.GOATCITADEL_POSTGRES_PASSWORD = "postgres-secret";
      process.env.NPM_CONFIG_USERCONFIG = "C:\\Users\\operator\\.npmrc";
      process.env.NPM_CONFIG_REGISTRY = "https://user:secret@registry.example.test";

      const env = __internal.buildAddonChildEnv({
        ARENA_PORT: "3099",
        GOATCITADEL_BASE_URL: "http://127.0.0.1:8787",
      });

      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GOATCITADEL_AUTH_TOKEN).toBeUndefined();
      expect(env.GOATCITADEL_POSTGRES_PASSWORD).toBeUndefined();
      expect(env.NPM_CONFIG_USERCONFIG).toBeUndefined();
      expect(env.NPM_CONFIG_REGISTRY).toBeUndefined();
      expect(env.ARENA_PORT).toBe("3099");
      expect(env.GOATCITADEL_BASE_URL).toBe("http://127.0.0.1:8787");
    } finally {
      if (originalOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAi;
      }
      if (originalAuthToken === undefined) {
        delete process.env.GOATCITADEL_AUTH_TOKEN;
      } else {
        process.env.GOATCITADEL_AUTH_TOKEN = originalAuthToken;
      }
      if (originalPostgresPassword === undefined) {
        delete process.env.GOATCITADEL_POSTGRES_PASSWORD;
      } else {
        process.env.GOATCITADEL_POSTGRES_PASSWORD = originalPostgresPassword;
      }
      if (originalNpmUserConfig === undefined) {
        delete process.env.NPM_CONFIG_USERCONFIG;
      } else {
        process.env.NPM_CONFIG_USERCONFIG = originalNpmUserConfig;
      }
      if (originalNpmRegistry === undefined) {
        delete process.env.NPM_CONFIG_REGISTRY;
      } else {
        process.env.NPM_CONFIG_REGISTRY = originalNpmRegistry;
      }
    }
  });

  it("rejects a tampered manifest before uninstalling", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    await fs.mkdir(addonsRoot, { recursive: true });
    await fs.writeFile(
      path.join(addonsRoot, "manifest.json"),
      `${JSON.stringify(
        {
          items: {
            arena: {
              addonId: "arena",
              installedPath: path.join(addonsRoot, "..", "..", "Documents"),
              repoUrl: "https://github.com/spurnout/goatcitadel-arena",
              owner: "spurnout",
              sameOwnerAsGoatCitadel: true,
              trustTier: "restricted",
              runtimeType: "separate_repo_app",
              webEntryMode: "external_local_url",
              launchUrl: "http://127.0.0.1:3099/",
              installedAt: "2026-03-06T00:00:00.000Z",
              updatedAt: "2026-03-06T00:00:00.000Z",
              consentedAt: "2026-03-06T00:00:00.000Z",
              consentedBy: "operator",
              runtimeStatus: "installed",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const service = new AddonsService(tempDir);

    await expect(service.uninstall("arena")).rejects.toThrow("Invalid add-on manifest");
  });

  it("rejects unsupported manifest rows before process or filesystem lifecycle actions", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    const addonPath = path.join(addonsRoot, "rogue");
    await fs.mkdir(addonPath, { recursive: true });
    await fs.writeFile(
      path.join(addonsRoot, "manifest.json"),
      `${JSON.stringify(
        {
          items: {
            rogue: {
              addonId: "rogue",
              installedPath: addonPath,
              repoUrl: "https://github.com/example/rogue-addon",
              owner: "example",
              sameOwnerAsGoatCitadel: false,
              trustTier: "community",
              runtimeType: "separate_repo_app",
              webEntryMode: "external_local_url",
              launchUrl: "http://127.0.0.1:3999/",
              installedAt: "2026-03-06T00:00:00.000Z",
              updatedAt: "2026-03-06T00:00:00.000Z",
              consentedAt: "2026-03-06T00:00:00.000Z",
              consentedBy: "operator",
              enabled: true,
              runtimeStatus: "stopped",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const service = new AddonsService(tempDir);

    await expect(service.disable("rogue")).rejects.toThrow("Unknown add-on: rogue");
    await expect(service.stop("rogue")).rejects.toThrow("Unknown add-on: rogue");
    await expect(service.uninstall("rogue")).rejects.toThrow("Unknown add-on: rogue");
    await expect(fs.stat(addonPath)).resolves.toBeDefined();
  });

  it("leaves the installed add-on untouched when a staged update build fails", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    const addonPath = path.join(addonsRoot, "arena");
    await fs.mkdir(addonPath, { recursive: true });
    await fs.writeFile(path.join(addonPath, "existing-install.txt"), "preserve me", "utf8");
    await fs.writeFile(
      path.join(addonsRoot, "manifest.json"),
      `${JSON.stringify(
        {
          items: {
            arena: {
              addonId: "arena",
              installedPath: addonPath,
              repoUrl: "https://github.com/spurnout/goatcitadel-arena",
              owner: "spurnout",
              sameOwnerAsGoatCitadel: true,
              trustTier: "restricted",
              runtimeType: "separate_repo_app",
              webEntryMode: "external_local_url",
              launchUrl: "http://127.0.0.1:3099/",
              installRef: "abc123",
              installedAt: "2026-03-06T00:00:00.000Z",
              updatedAt: "2026-03-06T00:00:00.000Z",
              consentedAt: "2026-03-06T00:00:00.000Z",
              consentedBy: "operator",
              runtimeStatus: "installed",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    execFileSyncMock.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === "git" && args?.includes("rev-parse")) {
        return `${__internal.ARENA_REPO_REF}\n`;
      }
      const joined = (args ?? []).join(" ");
      if ((cmd === "corepack" || cmd.endsWith("node.exe")) && joined.includes("pnpm install --frozen-lockfile")) {
        throw new Error("pnpm install failed");
      }
      if (cmd === "git" && args?.includes("fetch")) {
        return "";
      }
      return "";
    });

    const service = new AddonsService(tempDir);

    await expect(service.update("arena")).rejects.toThrow("pnpm install failed");

    await expect(fs.readFile(path.join(addonPath, "existing-install.txt"), "utf8")).resolves.toBe("preserve me");
    expect(execFileSyncMock.mock.calls.some(([command, args]) => command === "git" && args?.includes("reset"))).toBe(
      false,
    );
    const installCall = execFileSyncMock.mock.calls.find(
      ([command, args]) =>
        (command === "corepack" || String(command).endsWith("node.exe")) &&
        Array.isArray(args) &&
        args.join(" ").includes("pnpm install --frozen-lockfile"),
    );
    expect(installCall?.[2]).toEqual(expect.objectContaining({ cwd: expect.stringContaining(".arena-staging-") }));

    const manifest = JSON.parse(await fs.readFile(path.join(addonsRoot, "manifest.json"), "utf8")) as {
      items: Record<string, { installRef?: string; lastError?: string }>;
    };
    expect(manifest.items.arena).toBeDefined();
    expect(manifest.items.arena!.installRef).toBe("abc123");
    expect(manifest.items.arena!.lastError).toContain("pnpm install failed");
  });

  it("moves Arena SQLite state into durable add-on data storage", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    const addonPath = path.join(addonsRoot, "arena");
    await fs.mkdir(addonPath, { recursive: true });
    await fs.writeFile(path.join(addonPath, "arena.db"), "database", "utf8");
    await fs.writeFile(path.join(addonPath, "arena.db-wal"), "wal", "utf8");

    const databasePath = await __internal.prepareArenaDataPath(addonPath, addonsRoot);

    expect(databasePath).toBe(path.join(addonsRoot, "data", "arena", "arena.db"));
    await expect(fs.readFile(databasePath, "utf8")).resolves.toBe("database");
    await expect(fs.readFile(`${databasePath}-wal`, "utf8")).resolves.toBe("wal");
    await expect(fs.stat(path.join(addonPath, "arena.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the previous add-on when a staged swap was interrupted before manifest commit", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    const addonPath = path.join(addonsRoot, "arena");
    const backupPath = path.join(addonsRoot, ".arena-update-backup");
    await fs.mkdir(addonPath, { recursive: true });
    await fs.mkdir(backupPath, { recursive: true });
    await fs.writeFile(path.join(addonPath, "new.txt"), "new", "utf8");
    await fs.writeFile(path.join(backupPath, "old.txt"), "old", "utf8");
    execFileSyncMock.mockImplementation((_command: string, args?: string[]) =>
      args?.[1] === backupPath ? "old-ref\n" : "new-ref\n",
    );

    await __internal.recoverInterruptedAddonUpdate({
      installedPath: addonPath,
      backupDir: backupPath,
      manifestInstallRef: "old-ref",
      addonsRootDir: addonsRoot,
    });

    await expect(fs.readFile(path.join(addonPath, "old.txt"), "utf8")).resolves.toBe("old");
    await expect(fs.stat(path.join(addonPath, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the committed add-on and removes its backup after interrupted cleanup", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    const addonPath = path.join(addonsRoot, "arena");
    const backupPath = path.join(addonsRoot, ".arena-update-backup");
    await fs.mkdir(addonPath, { recursive: true });
    await fs.mkdir(backupPath, { recursive: true });
    await fs.writeFile(path.join(addonPath, "new.txt"), "new", "utf8");
    await fs.writeFile(path.join(backupPath, "old.txt"), "old", "utf8");
    execFileSyncMock.mockImplementation((_command: string, args?: string[]) =>
      args?.[1] === addonPath ? "new-ref\n" : "old-ref\n",
    );

    await __internal.recoverInterruptedAddonUpdate({
      installedPath: addonPath,
      backupDir: backupPath,
      manifestInstallRef: "new-ref",
      addonsRootDir: addonsRoot,
    });

    await expect(fs.readFile(path.join(addonPath, "new.txt"), "utf8")).resolves.toBe("new");
    await expect(fs.stat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("conservatively restores the backup for an interrupted legacy update without a manifest ref", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    const addonPath = path.join(addonsRoot, "arena");
    const backupPath = path.join(addonsRoot, ".arena-update-backup");
    await fs.mkdir(addonPath, { recursive: true });
    await fs.mkdir(backupPath, { recursive: true });
    await fs.writeFile(path.join(addonPath, "new.txt"), "new", "utf8");
    await fs.writeFile(path.join(backupPath, "old.txt"), "old", "utf8");
    execFileSyncMock.mockReturnValue("unknown-ref\n");

    await __internal.recoverInterruptedAddonUpdate({
      installedPath: addonPath,
      backupDir: backupPath,
      addonsRootDir: addonsRoot,
    });

    await expect(fs.readFile(path.join(addonPath, "old.txt"), "utf8")).resolves.toBe("old");
    await expect(fs.stat(path.join(addonPath, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a lone update backup when the install rename was interrupted", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    const addonPath = path.join(addonsRoot, "arena");
    const backupPath = path.join(addonsRoot, ".arena-update-backup");
    await fs.mkdir(backupPath, { recursive: true });
    await fs.writeFile(path.join(backupPath, "old.txt"), "old", "utf8");

    await __internal.recoverInterruptedAddonUpdate({
      installedPath: addonPath,
      backupDir: backupPath,
      manifestInstallRef: "old-ref",
      addonsRootDir: addonsRoot,
    });

    await expect(fs.readFile(path.join(addonPath, "old.txt"), "utf8")).resolves.toBe("old");
    await expect(fs.stat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes Arena as an external local app with a launch URL", () => {
    const service = new AddonsService(tempDir);

    expect(service.listCatalog()).toEqual([
      expect.objectContaining({
        addonId: "arena",
        webEntryMode: "external_local_url",
        launchUrl: "http://127.0.0.1:3099/",
      }),
    ]);
    expect(service.listCatalog()[0]?.installCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "git",
          args: [
            "-C",
            "<install-dir>",
            "fetch",
            "--depth",
            "1",
            "--no-tags",
            "https://github.com/spurnout/goatcitadel-arena",
            __internal.ARENA_REPO_REF,
          ],
        }),
        expect.objectContaining({
          command: "git",
          args: ["-C", "<install-dir>", "checkout", "--detach", __internal.ARENA_REPO_REF],
        }),
      ]),
    );
  });

  it("refuses to run package or build commands when the pinned checkout does not match", async () => {
    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === "git" && args?.includes("rev-parse")) {
        return `${"f".repeat(40)}\n`;
      }
      return "";
    });
    const service = new AddonsService(tempDir);

    await expect(service.install("arena", { confirmRepoDownload: true })).rejects.toThrow(
      "Arena checkout integrity mismatch",
    );
    expect(
      execFileSyncMock.mock.calls.some(
        ([command, args]) =>
          (command === "corepack" || String(command).endsWith("node.exe")) &&
          Array.isArray(args) &&
          args.includes("pnpm"),
      ),
    ).toBe(false);
  });

  it("refuses to build a pinned checkout containing unexpected untracked state", async () => {
    execFileSyncMock.mockImplementation((command: string, args?: string[]) => {
      if (command === "git" && args?.includes("rev-parse")) {
        return `${__internal.ARENA_REPO_REF}\n`;
      }
      if (command === "git" && args?.includes("status")) {
        return "?? .npmrc\n";
      }
      return "";
    });
    const service = new AddonsService(tempDir);

    await expect(service.install("arena", { confirmRepoDownload: true })).rejects.toThrow(
      "Arena checkout is not clean",
    );
    expect(
      execFileSyncMock.mock.calls.some(
        ([command, args]) =>
          (command === "corepack" || String(command).endsWith("node.exe")) &&
          Array.isArray(args) &&
          args.includes("pnpm"),
      ),
    ).toBe(false);
  });

  it("launches Arena with the local web origin and persists the launch URL when uiReady is true", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    const addonPath = path.join(addonsRoot, "arena");
    await fs.mkdir(path.join(addonPath, "apps", "server", "dist"), { recursive: true });
    await fs.mkdir(path.join(addonPath, "apps", "web", "dist"), { recursive: true });
    await fs.writeFile(path.join(addonPath, "apps", "server", "dist", "index.js"), "console.log('arena');\n", "utf8");
    await fs.writeFile(path.join(addonPath, "apps", "web", "dist", "index.html"), "<!doctype html>\n", "utf8");
    await fs.writeFile(path.join(addonPath, "arena.db"), "database", "utf8");
    await fs.writeFile(
      path.join(addonsRoot, "manifest.json"),
      `${JSON.stringify(
        {
          items: {
            arena: {
              addonId: "arena",
              installedPath: addonPath,
              repoUrl: "https://github.com/spurnout/goatcitadel-arena",
              owner: "spurnout",
              sameOwnerAsGoatCitadel: true,
              trustTier: "restricted",
              runtimeType: "separate_repo_app",
              webEntryMode: "external_local_url",
              installedAt: "2026-03-06T00:00:00.000Z",
              updatedAt: "2026-03-06T00:00:00.000Z",
              consentedAt: "2026-03-06T00:00:00.000Z",
              consentedBy: "operator",
              runtimeStatus: "installed",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: "ok",
            uiReady: true,
            uiEntryPath: "/",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    spawnMock.mockImplementationOnce(() => ({
      pid: process.pid,
      unref: vi.fn(),
    }));

    const service = new AddonsService(tempDir);
    const result = await service.launch("arena");

    expect(result.status.status).toBe("running");
    expect(result.status.installed?.launchUrl).toBe("http://127.0.0.1:3099/");
    expect(result.status.healthChecks).toContainEqual(
      expect.objectContaining({
        key: "web_build",
        status: "pass",
      }),
    );
    const [spawnFile, spawnArgs, spawnOptions] = spawnMock.mock.calls[0] ?? [];
    expect(spawnFile === "corepack" || spawnFile === process.execPath).toBe(true);
    expect(spawnArgs).toEqual(expect.arrayContaining(["pnpm", "--filter", "@arena/server", "start"]));
    if (spawnFile === process.execPath) {
      expect(spawnArgs).toEqual(expect.arrayContaining([expect.stringContaining("corepack.js")]));
    }
    expect(spawnOptions).toEqual(
      expect.objectContaining({
        cwd: addonPath,
        env: expect.objectContaining({
          ARENA_HOST: "127.0.0.1",
          ARENA_PORT: "3099",
          CORS_ORIGIN: "http://127.0.0.1:3099",
          GOATCITADEL_BASE_URL: "http://127.0.0.1:8787",
          ARENA_DB_PATH: path.join(addonsRoot, "data", "arena", "arena.db"),
        }),
      }),
    );
    await expect(fs.readFile(path.join(addonsRoot, "data", "arena", "arena.db"), "utf8")).resolves.toBe("database");
    await expect(fs.stat(path.join(addonPath, "arena.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps new add-ons disabled until enabled and registers dashboard slots on enable", async () => {
    execFileSyncMock.mockImplementation((command: string, args?: string[]) =>
      command === "git" && args?.includes("rev-parse") ? `${__internal.ARENA_REPO_REF}\n` : "",
    );
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ status: "ok", uiReady: true, uiEntryPath: "/" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const slotService = new AddonSlotService();
    slotService.registerDeclarations("arena", [{ slot: "ops.approvals.actions" }]);
    const registerSpy = vi.spyOn(slotService, "registerDeclarations");
    const unregisterSpy = vi.spyOn(slotService, "unregister");
    const service = new AddonsService(tempDir, { slotService });

    const installResult = await service.install("arena", { confirmRepoDownload: true, actorId: "operator" });
    await expect(service.launch("arena")).rejects.toThrow("disabled");

    expect(installResult.status.status).toBe("disabled");
    expect(installResult.status.installed?.enabled).toBe(false);
    expect(unregisterSpy).toHaveBeenCalledWith("arena");
    expect(slotService.listAllRegistrations()).toEqual([]);
    expect(registerSpy).not.toHaveBeenCalled();

    await fs.mkdir(path.join(goatHome, "addons", "arena"), { recursive: true });
    const enableResult = await service.enable("arena");

    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith("arena", expect.any(Array));
    expect(enableResult.status.status).toBe("installed");
    expect(enableResult.status.installed?.enabled).toBe(true);
    const [addonIdArg, declarationsArg] = registerSpy.mock.calls[0] ?? [];
    expect(addonIdArg).toBe("arena");
    expect(Array.isArray(declarationsArg)).toBe(true);
  });

  it("unregisters dashboard slot declarations from the slot service on uninstall", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    const addonPath = path.join(addonsRoot, "arena");
    await fs.mkdir(addonPath, { recursive: true });
    await fs.writeFile(
      path.join(addonsRoot, "manifest.json"),
      `${JSON.stringify(
        {
          items: {
            arena: {
              addonId: "arena",
              installedPath: addonPath,
              repoUrl: "https://github.com/spurnout/goatcitadel-arena",
              owner: "spurnout",
              sameOwnerAsGoatCitadel: true,
              trustTier: "restricted",
              runtimeType: "separate_repo_app",
              webEntryMode: "external_local_url",
              launchUrl: "http://127.0.0.1:3099/",
              installedAt: "2026-03-06T00:00:00.000Z",
              updatedAt: "2026-03-06T00:00:00.000Z",
              consentedAt: "2026-03-06T00:00:00.000Z",
              consentedBy: "operator",
              runtimeStatus: "installed",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const slotService = new AddonSlotService();
    slotService.registerDeclarations("arena", [{ slot: "ops.approvals.actions" }]);
    const unregisterSpy = vi.spyOn(slotService, "unregister");
    const service = new AddonsService(tempDir, { slotService });

    await service.uninstall("arena");

    expect(unregisterSpy).toHaveBeenCalledWith("arena");
    expect(slotService.listAllRegistrations()).toEqual([]);
  });

  it("does not throw on install or uninstall when no slot service is provided", async () => {
    execFileSyncMock.mockImplementation((command: string, args?: string[]) =>
      command === "git" && args?.includes("rev-parse") ? `${__internal.ARENA_REPO_REF}\n` : "",
    );
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ status: "ok", uiReady: true, uiEntryPath: "/" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const service = new AddonsService(tempDir);

    await expect(service.install("arena", { confirmRepoDownload: true })).resolves.toBeDefined();
  });

  it("marks Arena unhealthy when the server is up but the UI is not ready", async () => {
    const addonsRoot = path.join(goatHome, "addons");
    const addonPath = path.join(addonsRoot, "arena");
    await fs.mkdir(addonPath, { recursive: true });
    await fs.writeFile(
      path.join(addonsRoot, "manifest.json"),
      `${JSON.stringify(
        {
          items: {
            arena: {
              addonId: "arena",
              installedPath: addonPath,
              repoUrl: "https://github.com/spurnout/goatcitadel-arena",
              owner: "spurnout",
              sameOwnerAsGoatCitadel: true,
              trustTier: "restricted",
              runtimeType: "separate_repo_app",
              webEntryMode: "external_local_url",
              launchUrl: "http://127.0.0.1:3099/",
              installedAt: "2026-03-06T00:00:00.000Z",
              updatedAt: "2026-03-06T00:00:00.000Z",
              consentedAt: "2026-03-06T00:00:00.000Z",
              consentedBy: "operator",
              runtimeStatus: "running",
              pid: process.pid,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: "ok",
            uiReady: false,
            uiEntryPath: "/",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    const service = new AddonsService(tempDir);
    const status = await service.getStatus("arena");

    expect(status.status).toBe("error");
    expect(status.installed?.lastError).toContain("did not report uiReady");
  });
});
