import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRuntimeConfig } from "../config.js";
import { BackupRetentionService } from "./backup-retention-service.js";
import { preparePostgresBackupConnection } from "./postgres-backup-connection.js";

const { exec, userHome, verifyParent, applyAcl } = vi.hoisted(() => ({
  exec: vi.fn(),
  userHome: vi.fn(),
  verifyParent: vi.fn(),
  applyAcl: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: exec,
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, userInfo: () => ({ homedir: userHome() }) } };
});
vi.mock("./external-source-windows-security.js", () => ({
  createWindowsScratchSecurity: () => ({ verifyPrivateParent: verifyParent, applyOwnerOnlyAcl: applyAcl }),
}));

const roots: string[] = [];
const password = "fixture-dump-marker";
const uri = `postgresql://fixture:${password}@127.0.0.1:45432/fixture?sslmode=disable`;
const dump = Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0, 0xff]);
const syntheticSid = "S-1-5-21-1";

interface ChildOptions {
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const mock of [exec, userHome, verifyParent, applyAcl]) mock.mockReset();
  for (const root of roots.splice(0)) {
    const parent = await fs.realpath(os.tmpdir());
    const stat = await fs.lstat(root);
    expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
    expect(await fs.realpath(root)).toBe(root);
    expect(path.dirname(root)).toBe(parent);
    expect(path.basename(root)).toMatch(/^gc-backup-pg-test-[a-z0-9]+$/iu);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(mode: "external" | "bundled", connectionString = uri) {
  const rootDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gc-backup-pg-test-"));
  roots.push(rootDir);
  vi.stubEnv("GOATCITADEL_BACKUP_DIR", path.join(rootDir, "backup"));
  vi.stubEnv("GOATCITADEL_PG_DUMP_PATH", "synthetic-pg-dump");
  vi.stubEnv("GOATCITADEL_POSTGRES_CONNECTION_STRING", connectionString);
  vi.stubEnv("GC_TEST_DSN", connectionString);
  vi.stubEnv("GC_TEST_PASSWORD", password);
  vi.stubEnv("PGPASSWORD", "synthetic-ambient-password");
  vi.stubEnv("PGSERVICE", "synthetic-service");
  userHome.mockReturnValue(rootDir);
  verifyParent.mockResolvedValue({ ownerSid: syntheticSid });
  applyAcl.mockResolvedValue({ ownerSid: syntheticSid });
  const config = {
    rootDir,
    assistant: {
      dataDir: "data",
      transcriptsDir: "data/transcripts",
      auditDir: "data/audit",
      database: {
        driver: "postgres",
        postgres: { mode, connectionString, connectionStringEnv: "GC_TEST_DSN", passwordEnv: "GC_TEST_PASSWORD", pool: {} },
        bundledPostgres: {},
      },
    },
  } as GatewayRuntimeConfig;
  return { service: new BackupRetentionService({ config, storage: {} as never }), rootDir };
}

function recordCommands(options: {
  dockerFails?: boolean;
  nativeFails?: boolean;
  onAncillary?: (command: string, args: string[], options: ChildOptions) => void;
} = {}) {
  const calls: Array<{ command: string; args: string[]; options: ChildOptions; passfile?: string; record?: Buffer }> = [];
  exec.mockImplementation((command: string, args: string[], opts: ChildOptions) => {
    if (command === "where.exe" || command === "which") {
      options.onAncillary?.(command, args, opts);
      return "synthetic-pg-dump";
    }
    if (command === "docker" && args[0] === "info") {
      options.onAncillary?.(command, args, opts);
      return "";
    }
    if (command === "docker" && args[0] === "ps") {
      options.onAncillary?.(command, args, opts);
      return args[2]!.slice("name=^/".length, -1);
    }
    if (command === "git") {
      options.onAncillary?.(command, args, opts);
      return "synthetic";
    }
    if (command === "docker" && args[0] === "exec") {
      calls.push({ command, args, options: opts, ...(opts.input ? { record: Buffer.from(opts.input) } : {}) });
      if (options.dockerFails) throw Object.assign(new Error(password), { stderr: password });
      return dump;
    }
    if (command === "synthetic-pg-dump") {
      const passfile = new URL(args.at(-1)!).searchParams.get("passfile") ?? undefined;
      calls.push({ command, args, options: opts, ...(passfile ? { passfile } : {}), ...(passfile && args.includes("--no-password") ? { record: fsSync.readFileSync(passfile) } : {}) });
      if (options.nativeFails) throw Object.assign(new Error(password), { stderr: password });
      fsSync.writeFileSync(args[args.indexOf("--file") + 1]!, dump);
      return "";
    }
    throw new Error("Unexpected synthetic command");
  });
  return calls;
}

describe("Postgres backup subprocess credential custody", () => {
  it.each(["external", "bundled"] as const)("keeps the %s pg_dump credential out of argv and child env", async (mode) => {
    const { service, rootDir } = await fixture(mode);
    const calls = recordCommands();
    const aclSteps: string[] = [];
    applyAcl.mockImplementation(async (file: string, kind: "directory" | "file") => {
      aclSteps.push(kind);
      if (kind === "file") expect((await fs.stat(file)).size).toBe(0);
      return { ownerSid: syntheticSid };
    });

    const result = await service.createBackup({ name: "synthetic-dump" });
    expect(await fs.readFile(path.join(result.outputPath, "payload", "database", "postgres.dump"))).toEqual(dump);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.args.some((arg) => arg.includes(password)), "pg_dump or Docker argv contains the configured password").toBe(false);
    expect(JSON.stringify(call!.options.env).includes(password)).toBe(false);
    expect(call!.options.env).toMatchObject({ PGSERVICE: "synthetic-service" });
    expect(call!.options.env).not.toHaveProperty("PGPASSWORD");
    expect(call!.record?.toString()).toBe(`*:*:*:*:${password}\n`);
    const db = new URL(call!.args.at(-1)!);
    expect(db.searchParams.get("password")).toBe("");
    expect(db.searchParams.get("sslmode")).toBe("disable");
    expect(db.port).toBe(mode === "bundled" ? "5432" : "45432");
    if (mode === "bundled") {
      expect(call!.args.slice(0, 2)).toEqual(["exec", "-i"]);
      expect(call!.args).not.toContain("-t");
      expect(call!.options.input?.every((byte) => byte === 0)).toBe(true);
    } else {
      expect(call!.args).toContain("--no-password");
      expect(path.dirname(path.dirname(call!.passfile!))).toBe(rootDir);
      await expect(fs.stat(call!.passfile!)).rejects.toMatchObject({ code: "ENOENT" });
      if (process.platform === "win32") {
        expect(verifyParent).toHaveBeenCalledOnce();
        expect(aclSteps).toEqual(["directory", "file"]);
      }
    }
    expect(result.manifest.files.map((file) => file.path)).toEqual(["database/postgres.dump"]);
  });

  it.each([
    { mode: "external", explicit: true },
    { mode: "external", explicit: false },
    { mode: "bundled", explicit: false },
  ] as const)("scrubs database credentials from $mode ancillary children (explicit: $explicit)", async ({ mode, explicit }) => {
    const connection = explicit ? uri : "postgresql://fixture@127.0.0.1:45432/fixture?service=synth";
    const { service } = await fixture(mode, connection);
    vi.stubEnv("GOATCITADEL_PG_DUMP_PATH", "");
    vi.stubEnv("GOATCITADEL_POSTGRES_PASSWORD", "synthetic-bundled-password");
    vi.stubEnv("GC_TEST_ANCILLARY_KEEP", "synthetic-public-value");
    const ancillary: Array<{ purpose: string; credentialFree: boolean; keptPublicValue: boolean }> = [];
    const calls = recordCommands({
      onAncillary(command, args, options) {
        const effective = options.env ?? process.env;
        ancillary.push({
          purpose: command === "docker" ? args[0]! : command,
          credentialFree: [
            "GOATCITADEL_POSTGRES_CONNECTION_STRING",
            "GOATCITADEL_POSTGRES_PASSWORD",
            "GC_TEST_DSN",
            "GC_TEST_PASSWORD",
            "PGPASSWORD",
          ].every((name) => !Object.hasOwn(effective, name)),
          keptPublicValue: effective.GC_TEST_ANCILLARY_KEEP === "synthetic-public-value",
        });
      },
    });

    const result = await service.createBackup({ name: "synthetic-ancillary" });
    expect(result.manifest.gitRef).toBe("synthetic");
    expect(await fs.readFile(path.join(result.outputPath, "payload", "database", "postgres.dump"))).toEqual(dump);
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const purposes = mode === "external" ? [locator, "git"] : ["info", "ps", "git"];
    expect(ancillary).toEqual(purposes.map((purpose) => ({
      purpose, credentialFree: true, keptPublicValue: true,
    })));
    expect(calls).toHaveLength(1);
    if (mode === "external" && !explicit) {
      expect(calls[0]!.options.env?.PGPASSWORD).toBe("synthetic-ambient-password");
    }
  });

  it("uses a fresh protected native fallback after bundled failure and emits no child diagnostics", async () => {
    const { service } = await fixture("bundled");
    const calls = recordCommands({ dockerFails: true, nativeFails: true });
    const result = await service.createBackup({ name: "synthetic-failure" }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/^pg_dump failed/);
    expect((result as Error).message.includes(password)).toBe(false);
    expect((result as Error).cause).toBeUndefined();
    expect(calls.map((call) => call.command)).toEqual(["docker", "synthetic-pg-dump"]);
    expect(calls.every((call) => !call.args.some((arg) => arg.includes(password)))).toBe(true);
    expect(new URL(calls[1]!.args.at(-1)!).port).toBe("45432");
    await expect(fs.stat(calls[1]!.passfile!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["postgresql://fixture@127.0.0.1:45432/fixture?service=synth", true, false],
    [uri + "&password=&passfile=/operator-pgpass", false, true],
  ] as const)("preserves the passwordless or explicit-empty libpq selection", async (connectionString, ambient, explicit) => {
    const { service } = await fixture("external", connectionString);
    const calls = recordCommands();
    await service.createBackup({ name: "synthetic-default" });
    const [call] = calls;
    expect(call!.passfile).toBe(explicit ? "/operator-pgpass" : undefined);
    expect(call!.options.env?.PGPASSWORD).toBe(ambient ? "synthetic-ambient-password" : undefined);
    expect(new URL(call!.args.at(-1)!).searchParams.has("password")).toBe(explicit);
    expect(verifyParent).not.toHaveBeenCalled();
    expect(applyAcl).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")("fails closed before writing a secret when file ACL verification fails", async () => {
    const { service, rootDir } = await fixture("external");
    const calls = recordCommands();
    applyAcl.mockImplementation(async (file: string, kind: "directory" | "file") => {
      if (kind === "file") {
        expect((await fs.stat(file)).size).toBe(0);
        throw new Error(password);
      }
      return { ownerSid: syntheticSid };
    });
    await expect(service.createBackup({ name: "synthetic-denied" })).rejects.toThrow(/^Postgres backup could not establish/);
    expect(calls).toHaveLength(0);
    expect((await fs.readdir(rootDir)).some((name) => name.startsWith(".goatcitadel-pgdump-"))).toBe(false);
  });

  it.each([
    "host=localhost dbname=fixture password=" + password,
    "postgresql://fixture@localhost/db?sslpassword=" + password,
    "postgresql://fixture@localhost/db?password=invalid%0Aline",
    "socket:/fixture?db=sample",
  ])("fails closed before any child invocation for unsupported connection syntax", async (connectionString) => {
    const { service } = await fixture("bundled", connectionString);
    await expect(service.createBackup({ name: "synthetic-invalid" })).rejects.toThrow(/^Postgres backup requires a supported/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("Postgres backup URI projection", () => {
  it("keeps raw noncredential options and takes the final query password with libpq plus semantics", () => {
    expect(preparePostgresBackupConnection(
      "postgresql://user:unused@[::1]:5432/db?options=-c%20search_path%3Dtest&password=older&%70assword=x+%3A%5C%C3%A9&passfile=%2Fstale&sslkey=%2Ftls",
    )).toEqual({
      uri: "postgresql://user@[::1]:5432/db?options=-c%20search_path%3Dtest&sslkey=%2Ftls&password=",
      explicitPassword: true,
      password: "x+:\\é",
    });
  });

  it("keeps an encoded Unix socket host and explicit empty rather than reusing userinfo", () => {
    expect(preparePostgresBackupConnection("postgres://user:old@%2Ftmp%2Fsock/db?password=&service=fixture&passfile=%2Fexisting")).toEqual({
      uri: "postgres://user@%2Ftmp%2Fsock/db?service=fixture&passfile=%2Fexisting&password=",
      explicitPassword: true,
    });
  });
});
