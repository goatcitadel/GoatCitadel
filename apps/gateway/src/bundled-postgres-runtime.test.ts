import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBundledDockerContainerName, __bundledPostgresRuntimeInternals } from "./bundled-postgres-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-bundled-pg-"));
  tempDirs.push(dir);
  return dir;
}

function buildBundledConfig(rootDir: string, binDir?: string): never {
  return {
    rootDir,
    assistant: {
      dataDir: "data",
      database: {
        bundledPostgres: {
          binDir,
          dataDir: "data/postgres",
          port: 45432,
        },
      },
    },
  } as never;
}

describe("bundled postgres runtime helpers", () => {
  it("resolves native postgres commands only when both binaries are present", async () => {
    const rootDir = await makeTempDir();
    const binDir = path.join(rootDir, "pg-bin");
    await fs.mkdir(binDir, { recursive: true });

    expect(
      __bundledPostgresRuntimeInternals.resolveNativePostgresCommands(buildBundledConfig(rootDir, "pg-bin")),
    ).toBeUndefined();

    const extension = process.platform === "win32" ? ".exe" : "";
    await fs.writeFile(path.join(binDir, `initdb${extension}`), "", "utf8");
    await fs.writeFile(path.join(binDir, `pg_ctl${extension}`), "", "utf8");

    expect(
      __bundledPostgresRuntimeInternals.resolveNativePostgresCommands(buildBundledConfig(rootDir, "pg-bin")),
    ).toEqual({
      initdb: path.join(binDir, `initdb${extension}`),
      pgCtl: path.join(binDir, `pg_ctl${extension}`),
    });
  }, 15_000);

  it("normalizes filesystem, docker data-directory, quoted identifiers, and container names", () => {
    expect(__bundledPostgresRuntimeInternals.sameFilesystemPath("C:/Temp/../Temp/data", "C:/Temp/data")).toBe(true);
    expect(__bundledPostgresRuntimeInternals.isDockerPostgresDataDirectory("\\var\\lib\\postgresql\\data\\")).toBe(
      true,
    );
    expect(__bundledPostgresRuntimeInternals.isDockerPostgresDataDirectory("/tmp/postgres")).toBe(false);
    expect(__bundledPostgresRuntimeInternals.quoteIdentifier('operator"events')).toBe('"operator""events"');
    expect(buildBundledDockerContainerName("F:/code/personal-ai")).toMatch(
      /^goatcitadel-postgres-[a-z0-9-]+-[a-f0-9]{10}$/,
    );
  });

  it("formats transient startup probe errors on one line", () => {
    const error = new Error("the database system is starting up\nretry later") as NodeJS.ErrnoException;
    error.code = "57P03";

    expect(__bundledPostgresRuntimeInternals.formatBundledPostgresProbeFailure(error)).toBe(
      "the database system is starting up (code=57P03)",
    );
  });

  it("parses Windows excluded TCP port ranges from netsh output", () => {
    expect(
      __bundledPostgresRuntimeInternals.parseWindowsTcpPortExclusions(`
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
     54236       54335
     50000       50059     *
invalid
`),
    ).toEqual([
      { startPort: 54236, endPort: 54335, administered: false },
      { startPort: 50000, endPort: 50059, administered: true },
    ]);
  });

  it("accepts only loopback-published, non-trust Docker postgres containers", () => {
    const inspect = (hostIp: string, env: string[] = []) => [
      {
        State: { Running: true },
        Config: { Env: env },
        HostConfig: {
          PortBindings: {
            "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45432" }],
          },
        },
        NetworkSettings: {
          Ports: {
            "5432/tcp": [{ HostIp: hostIp, HostPort: "45432" }],
          },
        },
      },
    ];

    expect(__bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection(inspect("127.0.0.1"))).toEqual({
      loopbackOnly: true,
      trustAuth: false,
      details: [],
    });
    expect(__bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection(inspect("0.0.0.0"))).toEqual({
      loopbackOnly: false,
      trustAuth: false,
      details: ["non-loopback effective publish 0.0.0.0:45432", "declared and effective 5432/tcp bindings conflict"],
    });
    expect(
      __bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection(
        inspect("127.0.0.1", ["POSTGRES_HOST_AUTH_METHOD=trust"]),
      ),
    ).toEqual({
      loopbackOnly: true,
      trustAuth: true,
      details: ["POSTGRES_HOST_AUTH_METHOD=trust"],
    });
  });

  it("denies a running container without a declared binding", () => {
    const inspection = __bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection([
      {
        State: { Running: true },
        Config: { Env: [] },
        HostConfig: { PortBindings: {} },
        NetworkSettings: {
          Ports: {
            "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45432" }],
          },
        },
      },
    ]);

    expect(inspection).toEqual({
      loopbackOnly: false,
      trustAuth: false,
      details: ["missing declared 5432/tcp port binding"],
    });
  });

  it("accepts a stopped container from its declared loopback binding", () => {
    const inspection = __bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection([
      {
        State: { Running: false },
        Config: { Env: ["POSTGRES_PASSWORD=secret"] },
        HostConfig: {
          PortBindings: {
            "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45432" }],
          },
        },
        NetworkSettings: { Ports: {} },
      },
    ]);

    expect(inspection).toEqual({
      loopbackOnly: true,
      trustAuth: false,
      details: [],
    });
  });

  it("denies a stopped container whose declared mapping uses the wrong host port", () => {
    const inspection = __bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection(
      [
        {
          State: { Running: false },
          Config: { Env: [] },
          HostConfig: {
            PortBindings: {
              "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }],
            },
          },
          NetworkSettings: { Ports: {} },
        },
      ],
      45432,
    );

    expect(inspection).toEqual({
      loopbackOnly: false,
      trustAuth: false,
      details: ["5432/tcp publish does not use configured host port 45432"],
    });
  });

  it("denies stopped containers without a safe declared binding", () => {
    expect(
      __bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection([
        {
          State: { Running: false },
          Config: { Env: [] },
          HostConfig: { PortBindings: {} },
          NetworkSettings: { Ports: {} },
        },
      ]),
    ).toEqual({
      loopbackOnly: false,
      trustAuth: false,
      details: ["missing declared 5432/tcp port binding"],
    });

    expect(
      __bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection([
        {
          State: { Running: false },
          Config: { Env: [] },
          HostConfig: {
            PortBindings: {
              "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "45432" }],
            },
          },
          NetworkSettings: { Ports: {} },
        },
      ]),
    ).toEqual({
      loopbackOnly: false,
      trustAuth: false,
      details: ["non-loopback declared publish 0.0.0.0:45432"],
    });
  });

  it("denies contradictory running-container declarations", () => {
    const inspection = __bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection([
      {
        State: { Running: true },
        Config: { Env: [] },
        HostConfig: {
          PortBindings: {
            "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "45432" }],
          },
        },
        NetworkSettings: {
          Ports: {
            "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45432" }],
          },
        },
      },
    ]);

    expect(inspection).toEqual({
      loopbackOnly: false,
      trustAuth: false,
      details: ["non-loopback declared publish 0.0.0.0:45432", "declared and effective 5432/tcp bindings conflict"],
    });
  });

  it("denies conflicting loopback-only declared and effective mappings", () => {
    const inspection = __bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection(
      [
        {
          State: { Running: true },
          Config: { Env: [] },
          HostConfig: {
            PortBindings: {
              "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45432" }],
            },
          },
          NetworkSettings: {
            Ports: {
              "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }],
            },
          },
        },
      ],
      45432,
    );

    expect(inspection).toEqual({
      loopbackOnly: false,
      trustAuth: false,
      details: [
        "5432/tcp publish does not use configured host port 45432",
        "declared and effective 5432/tcp bindings conflict",
      ],
    });
  });

  it("requires an effective binding while the container is running", () => {
    const inspection = __bundledPostgresRuntimeInternals.parseDockerPostgresSecurityInspection([
      {
        State: { Running: true },
        Config: { Env: [] },
        HostConfig: {
          PortBindings: {
            "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "45432" }],
          },
        },
        NetworkSettings: { Ports: {} },
      },
    ]);

    expect(inspection).toEqual({
      loopbackOnly: false,
      trustAuth: false,
      details: ["missing effective 5432/tcp port binding"],
    });
  });
});
