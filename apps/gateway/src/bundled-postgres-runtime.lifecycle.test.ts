import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakePostgresDatabaseClient {
    public readonly options: Record<string, unknown>;
    public readonly queries: Array<{ sql: string; args?: unknown[] }> = [];
    private readonly script: {
      queryOne?: unknown | Error;
      query?: unknown | Error;
    };

    public constructor(options: Record<string, unknown>) {
      this.options = options;
      this.script = mocks.dbScripts.shift() ?? {};
      mocks.clients.push(this);
    }

    public async queryOne<T>(sql: string, args?: unknown[]): Promise<T | undefined> {
      this.queries.push({ sql, args });
      if (this.script.queryOne instanceof Error) {
        throw this.script.queryOne;
      }
      return this.script.queryOne as T | undefined;
    }

    public async query(sql: string, args?: unknown[]): Promise<unknown> {
      this.queries.push({ sql, args });
      if (this.script.query instanceof Error) {
        throw this.script.query;
      }
      return this.script.query;
    }

    public async close(): Promise<void> {
      mocks.closedClients += 1;
    }
  }

  return {
    clients: [] as FakePostgresDatabaseClient[],
    closedClients: 0,
    dbScripts: [] as Array<{ queryOne?: unknown | Error; query?: unknown | Error }>,
    dockerRunningNames: [] as string[],
    dockerMountSources: new Map<string, string>(),
    dockerStates: [] as string[],
    execFileSync: vi.fn(),
    isBundledPostgresMode: vi.fn(),
    resolveGatewayPostgresConnectionOptions: vi.fn(),
    FakePostgresDatabaseClient,
  };
});

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock("@goatcitadel/storage", () => ({
  PostgresDatabaseClient: mocks.FakePostgresDatabaseClient,
}));

vi.mock("./postgres-runtime-config.js", () => ({
  isBundledPostgresMode: mocks.isBundledPostgresMode,
  resolveGatewayPostgresConnectionOptions: mocks.resolveGatewayPostgresConnectionOptions,
}));

import { buildBundledDockerContainerName, ensureBundledPostgresRuntime } from "./bundled-postgres-runtime.js";
import { NonRetryableStartupError } from "./startup-errors.js";

const tempDirs: string[] = [];

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.closedClients = 0;
  mocks.dbScripts.length = 0;
  mocks.dockerRunningNames.length = 0;
  mocks.dockerMountSources.clear();
  mocks.dockerStates.length = 0;
  mocks.execFileSync.mockReset();
  mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
    if (command === "docker" && args[0] === "info") {
      return "";
    }
    if (command === "docker" && args[0] === "ps") {
      return args.includes("--all") ? (mocks.dockerStates.shift() ?? "") : mocks.dockerRunningNames.join("\n");
    }
    if (command === "docker" && args[0] === "inspect" && args.includes("{{json .Mounts}}")) {
      const containerName = args.at(-1) ?? "";
      const source = mocks.dockerMountSources.get(containerName);
      return JSON.stringify(source ? [{ Destination: "/var/lib/postgresql/data", Source: source }] : []);
    }
    if (command === "docker" && args[0] === "inspect") {
      return JSON.stringify([
        {
          State: { Running: true },
          Config: { Env: ["POSTGRES_HOST_AUTH_METHOD=scram-sha-256"] },
          HostConfig: {
            PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45432" }] },
          },
          NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45432" }] } },
        },
      ]);
    }
    return "";
  });
  mocks.isBundledPostgresMode.mockImplementation((config: ReturnType<typeof buildConfig>) =>
    Boolean(config.assistant.database.bundledPostgres.enabled),
  );
  mocks.resolveGatewayPostgresConnectionOptions.mockImplementation(
    (config: ReturnType<typeof buildConfig>, options?: { applicationName?: string; databaseOverride?: string }) => ({
      applicationName: options?.applicationName,
      database: options?.databaseOverride ?? config.assistant.database.name,
    }),
  );
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("bundled postgres runtime lifecycle", () => {
  it("does nothing when bundled Postgres mode is disabled", async () => {
    const rootDir = await makeTempDir();
    mocks.isBundledPostgresMode.mockReturnValue(false);

    await expect(ensureBundledPostgresRuntime(buildConfig(rootDir))).resolves.toBeUndefined();

    expect(mocks.clients).toHaveLength(0);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it("returns no handle when the expected runtime is already reachable and creates a missing app database", async () => {
    const rootDir = await makeTempDir();
    mocks.dbScripts.push(
      {
        queryOne: {
          data_directory: path.resolve(rootDir, "data", "postgres"),
        },
      },
      {
        queryOne: undefined,
        query: {},
      },
    );

    await expect(ensureBundledPostgresRuntime(buildConfig(rootDir))).resolves.toBeUndefined();

    expect(mocks.clients).toHaveLength(2);
    expect(mocks.clients[1]?.queries).toEqual([
      { sql: "SELECT 1 AS present FROM pg_database WHERE datname = $1", args: ["goat-db"] },
      { sql: 'CREATE DATABASE "goat-db"', args: undefined },
    ]);
    expect(mocks.closedClients).toBe(2);
  });

  it("skips app database creation when the configured target database is postgres", async () => {
    const rootDir = await makeTempDir();
    mocks.resolveGatewayPostgresConnectionOptions.mockImplementation(
      (_config: ReturnType<typeof buildConfig>, options?: { applicationName?: string; databaseOverride?: string }) => ({
        applicationName: options?.applicationName,
        database: options?.databaseOverride ?? "postgres",
      }),
    );
    mocks.dbScripts.push({
      queryOne: {
        data_directory: path.resolve(rootDir, "data", "postgres"),
      },
    });

    await expect(ensureBundledPostgresRuntime(buildConfig(rootDir))).resolves.toBeUndefined();

    expect(mocks.clients).toHaveLength(1);
    expect(mocks.closedClients).toBe(1);
  });

  it("blocks when the configured port belongs to a different Postgres data root", async () => {
    const rootDir = await makeTempDir();
    mocks.dbScripts.push({
      queryOne: {
        data_directory: path.resolve(rootDir, "..", "other-postgres"),
      },
    });

    await expect(ensureBundledPostgresRuntime(buildConfig(rootDir))).rejects.toThrow(
      "is reachable but does not belong to this runtime root",
    );
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it("blocks unreachable bundled Postgres when autostart is disabled", async () => {
    const rootDir = await makeTempDir();
    mocks.dbScripts.push({ queryOne: new Error("ECONNREFUSED") });

    await expect(ensureBundledPostgresRuntime(buildConfig(rootDir, { autoStart: false }))).rejects.toThrow(
      "autoStart is disabled",
    );
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it("starts and stops a new Docker-backed runtime when native binaries are unavailable", async () => {
    const rootDir = await makeTempDir();
    mockHardenedRunningDockerContainer(rootDir);
    mocks.dbScripts.push(
      { queryOne: new Error("ECONNREFUSED") },
      { queryOne: { data_directory: "/var/lib/postgresql/data" } },
      { queryOne: { present: 1 } },
    );
    mocks.dockerStates.push("", "running");

    const handle = await ensureBundledPostgresRuntime(buildConfig(rootDir));

    expect(handle?.strategy).toBe("docker");
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "--detach", "--publish", "127.0.0.1:45432:5432"]),
      expect.any(Object),
    );

    await handle?.stop();
    expect(mocks.execFileSync).toHaveBeenCalledWith("docker", expect.arrayContaining(["stop"]), expect.any(Object));
  });

  it("starts an existing stopped Docker container and ignores shutdown failures", async () => {
    const rootDir = await makeTempDir();
    mockHardenedRunningDockerContainer(rootDir);
    mocks.dbScripts.push(
      { queryOne: new Error("ECONNREFUSED") },
      { queryOne: { data_directory: "/var/lib/postgresql/data" } },
      { queryOne: { present: 1 } },
    );
    mocks.dockerStates.push("exited", "running");
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "docker" && args[0] === "info") {
        return "";
      }
      if (command === "docker" && args[0] === "ps") {
        return args.includes("--all") ? (mocks.dockerStates.shift() ?? "") : mocks.dockerRunningNames.join("\n");
      }
      if (command === "docker" && args[0] === "inspect" && args.includes("{{json .Mounts}}")) {
        const containerName = args.at(-1) ?? "";
        const source = mocks.dockerMountSources.get(containerName);
        return JSON.stringify(source ? [{ Destination: "/var/lib/postgresql/data", Source: source }] : []);
      }
      if (command === "docker" && args[0] === "inspect") {
        return JSON.stringify([
          {
            State: { Running: false },
            Config: { Env: ["POSTGRES_HOST_AUTH_METHOD=scram-sha-256"] },
            HostConfig: {
              PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45432" }] },
            },
            NetworkSettings: { Ports: {} },
          },
        ]);
      }
      if (command === "docker" && args[0] === "stop") {
        throw new Error("already stopped");
      }
      return "";
    });

    const handle = await ensureBundledPostgresRuntime(buildConfig(rootDir));

    expect(handle?.strategy).toBe("docker");
    expect(mocks.execFileSync).toHaveBeenCalledWith("docker", expect.arrayContaining(["start"]), expect.any(Object));
    await expect(handle?.stop()).resolves.toBeUndefined();
  });

  it("fails once with an operator repair command for an unsafe stopped container", async () => {
    const rootDir = await makeTempDir();
    const containerName = buildBundledDockerContainerName(rootDir);
    mocks.dbScripts.push({ queryOne: new Error("ECONNREFUSED") });
    mocks.dockerStates.push("exited");
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "docker" && args[0] === "info") {
        return "";
      }
      if (command === "docker" && args[0] === "ps") {
        return args.includes("--all") ? (mocks.dockerStates.shift() ?? "") : "";
      }
      if (command === "docker" && args[0] === "inspect") {
        return JSON.stringify([
          {
            State: { Running: false },
            Config: { Env: ["POSTGRES_PASSWORD=secret"] },
            HostConfig: {
              PortBindings: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "45432" }] },
            },
            NetworkSettings: { Ports: {} },
          },
        ]);
      }
      return "";
    });

    const action = ensureBundledPostgresRuntime(buildConfig(rootDir));

    await expect(action).rejects.toBeInstanceOf(NonRetryableStartupError);
    await expect(action).rejects.toThrow(`Run: docker rm ${containerName}`);
    await expect(action).rejects.toThrow("GoatCitadel will not remove or recreate an existing container automatically");
    expect(mocks.execFileSync).not.toHaveBeenCalledWith("docker", expect.arrayContaining(["rm"]), expect.anything());
  });

  it("fails clearly when neither native binaries nor Docker are available", async () => {
    const rootDir = await makeTempDir();
    mocks.dbScripts.push({ queryOne: new Error("ECONNREFUSED") });
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "docker" && args[0] === "info") {
        throw new Error("docker unavailable");
      }
      return "";
    });

    await expect(ensureBundledPostgresRuntime(buildConfig(rootDir))).rejects.toThrow(
      "no managed runtime backend is available",
    );
  });

  it("accepts native pg_ctl startup failures when the fallback probe reaches the expected data directory", async () => {
    const rootDir = await makeTempDir();
    const binDir = path.join(rootDir, "pg-bin");
    await fs.mkdir(binDir, { recursive: true });
    const extension = process.platform === "win32" ? ".exe" : "";
    const initdb = path.join(binDir, `initdb${extension}`);
    const pgCtl = path.join(binDir, `pg_ctl${extension}`);
    await fs.writeFile(initdb, "", "utf8");
    await fs.writeFile(pgCtl, "", "utf8");

    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === pgCtl && args.includes("start")) {
        throw new Error("pg_ctl start reported a stale pid file");
      }
      if (command === pgCtl && args.includes("stop")) {
        throw new Error("already stopped");
      }
      return "";
    });
    mocks.dbScripts.push(
      { queryOne: new Error("ECONNREFUSED") },
      { queryOne: { data_directory: path.resolve(rootDir, "data", "postgres") } },
      { queryOne: { data_directory: path.resolve(rootDir, "data", "postgres") } },
      { queryOne: { present: 1 } },
    );

    const handle = await ensureBundledPostgresRuntime(buildConfig(rootDir, { binDir: "pg-bin" }));

    expect(handle?.strategy).toBe("native");
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      initdb,
      ["-D", path.resolve(rootDir, "data", "postgres"), "-U", "postgres", "-A", "trust", "--encoding", "UTF8"],
      expect.any(Object),
    );

    await expect(handle?.stop()).resolves.toBeUndefined();
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      pgCtl,
      ["-D", path.resolve(rootDir, "data", "postgres"), "-w", "stop", "-m", "fast"],
      expect.any(Object),
    );
  });

  it("treats Docker inspect failures as a missing container", async () => {
    const rootDir = await makeTempDir();
    mockHardenedRunningDockerContainer(rootDir);
    mocks.dbScripts.push(
      { queryOne: new Error("ECONNREFUSED") },
      { queryOne: { data_directory: "/var/lib/postgresql/data" } },
      { queryOne: { present: 1 } },
    );
    let dockerPsCalls = 0;
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "docker" && args[0] === "info") {
        return "";
      }
      if (command === "docker" && args[0] === "ps") {
        dockerPsCalls += 1;
        if (args.includes("--all") && dockerPsCalls === 1) {
          throw new Error("docker ps failed");
        }
        return args.includes("--all") ? "" : mocks.dockerRunningNames.join("\n");
      }
      if (command === "docker" && args[0] === "inspect" && args.includes("{{json .Mounts}}")) {
        const containerName = args.at(-1) ?? "";
        const source = mocks.dockerMountSources.get(containerName);
        return JSON.stringify(source ? [{ Destination: "/var/lib/postgresql/data", Source: source }] : []);
      }
      return "";
    });

    const handle = await ensureBundledPostgresRuntime(buildConfig(rootDir));

    expect(handle?.strategy).toBe("docker");
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "--detach"]),
      expect.any(Object),
    );
  });

  it("fails closed instead of falling back to Docker when configured native startup fails", async () => {
    const rootDir = await makeTempDir();
    const binDir = path.join(rootDir, "pg-bin");
    await fs.mkdir(binDir, { recursive: true });
    const extension = process.platform === "win32" ? ".exe" : "";
    const initdb = path.join(binDir, `initdb${extension}`);
    const pgCtl = path.join(binDir, `pg_ctl${extension}`);
    await fs.writeFile(initdb, "", "utf8");
    await fs.writeFile(pgCtl, "", "utf8");
    let dockerPsCalls = 0;
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === pgCtl && args.includes("start")) {
        throw new Error("pg_ctl native start failed");
      }
      if (command === "docker" && args[0] === "info") {
        return "";
      }
      if (command === "docker" && args[0] === "ps") {
        dockerPsCalls += 1;
        return dockerPsCalls === 1 ? "" : "running";
      }
      return "";
    });
    mocks.dbScripts.push(
      { queryOne: new Error("ECONNREFUSED") },
      { queryOne: new Error("still refused after native failure") },
      { queryOne: { data_directory: "/var/lib/postgresql/data" } },
      { queryOne: { present: 1 } },
    );

    await expect(ensureBundledPostgresRuntime(buildConfig(rootDir, { binDir: "pg-bin" }))).rejects.toThrow(
      /pg_ctl native start failed/,
    );
    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "--detach"]),
      expect.any(Object),
    );
  });

  it("rethrows native startup failures when the fallback probe cannot reach the expected runtime", async () => {
    const rootDir = await makeTempDir();
    const binDir = path.join(rootDir, "pg-bin");
    await fs.mkdir(binDir, { recursive: true });
    const extension = process.platform === "win32" ? ".exe" : "";
    const initdb = path.join(binDir, `initdb${extension}`);
    const pgCtl = path.join(binDir, `pg_ctl${extension}`);
    await fs.writeFile(initdb, "", "utf8");
    await fs.writeFile(pgCtl, "", "utf8");
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === pgCtl && args.includes("start")) {
        const nativeError = new Error("pg_ctl start failed") as Error & { stderr: Buffer };
        nativeError.stderr = Buffer.from("bind failed");
        throw nativeError;
      }
      if (command === "docker" && args[0] === "info") {
        throw new Error("docker unavailable");
      }
      return "";
    });
    mocks.dbScripts.push({ queryOne: new Error("ECONNREFUSED") }, { queryOne: new Error("still refused") });
    await fs.mkdir(path.join(rootDir, "data", "logs"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "data", "logs", "goatcitadel-postgres.log"),
      'older line\ncould not bind IPv4 address "127.0.0.1": Permission denied\n',
      "utf8",
    );

    const action = ensureBundledPostgresRuntime(buildConfig(rootDir, { binDir: "pg-bin" }));
    await expect(action).rejects.toThrow("Native bundled Postgres failed to start on 127.0.0.1:45432");
    await expect(action).rejects.toThrow("could not bind IPv4 address");
    await expect(action).rejects.toThrow("GOATCITADEL_BUNDLED_POSTGRES_PORT");
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-bundled-pg-runtime-"));
  tempDirs.push(dir);
  return dir;
}

function mockHardenedRunningDockerContainer(rootDir: string): void {
  const containerName = buildBundledDockerContainerName(rootDir);
  mocks.dockerRunningNames.push(containerName);
  mocks.dockerMountSources.set(containerName, path.resolve(rootDir, "data", "postgres"));
}

function buildConfig(
  rootDir: string,
  options: {
    autoStart?: boolean;
    binDir?: string;
  } = {},
) {
  return {
    rootDir,
    assistant: {
      dataDir: "data",
      database: {
        name: "goat-db",
        bundledPostgres: {
          enabled: true,
          autoStart: options.autoStart ?? true,
          binDir: options.binDir,
          dataDir: "data/postgres",
          port: 45432,
          startTimeoutMs: 10_000,
        },
      },
    },
  } as never;
}
