import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWindowsScratchSecurity } from "./external-source-windows-security.js";

const UNSUPPORTED_CONNECTION = "Postgres backup requires a supported PostgreSQL connection URI. Use an external passfile for credentials that cannot be carried safely.";
const PRIVATE_SCRATCH_FAILURE = "Postgres backup could not establish or clean up private pg_dump credential storage.";
const DUMP_FAILURE = "pg_dump failed for the configured PostgreSQL connection. Check database access and pg_dump availability.";
const UNSUPPORTED_CONTROL_CHARACTERS = ["\u0000", "\n", "\r", "\u001a"] as const;

function hasUnsupportedControlCharacter(value: string): boolean {
  return UNSUPPORTED_CONTROL_CHARACTERS.some((character) => value.includes(character));
}

interface PostgresBackupConnection {
  uri: string;
  explicitPassword: boolean;
  password?: string;
}

export function preparePostgresBackupConnection(connectionString: string): PostgresBackupConnection {
  const prefix = /^(?:postgresql|postgres):\/\//u.exec(connectionString)?.[0];
  if (!prefix || hasUnsupportedControlCharacter(connectionString) || connectionString.includes("#")) {
    throw new Error(UNSUPPORTED_CONNECTION);
  }
  const queryIndex = connectionString.indexOf("?");
  const address = queryIndex < 0 ? connectionString : connectionString.slice(0, queryIndex);
  const authorityEnd = address.indexOf("/", prefix.length);
  const authority = address.slice(prefix.length, authorityEnd < 0 ? undefined : authorityEnd);
  const userInfoEnd = authority.indexOf("@");
  const userInfo = userInfoEnd < 0 ? "" : authority.slice(0, userInfoEnd);
  const passwordStart = userInfo.indexOf(":");
  const userPassword = passwordStart < 0 ? "" : readUriCredential(userInfo.slice(passwordStart + 1));
  const withoutUserPassword = passwordStart < 0
    ? address
    : prefix + userInfo.slice(0, passwordStart) + address.slice(prefix.length + userInfoEnd);
  const query = queryIndex < 0 ? "" : connectionString.slice(queryIndex + 1);
  // libpq searches for userinfo before a slash, including within a slashless
  // query. Require an unambiguous URI when query values contain a raw @.
  if (authorityEnd < 0 && query.includes("@")) throw new Error(UNSUPPORTED_CONNECTION);
  const fields: Array<{ key: string; raw: string }> = [];
  let queryPassword: string | undefined;
  const pairs = query.split("&");
  if (pairs.at(-1) === "") pairs.pop();
  for (const raw of pairs) {
    const separator = raw.indexOf("=");
    if (separator <= 0 || raw.indexOf("=", separator + 1) >= 0) throw new Error(UNSUPPORTED_CONNECTION);
    const key = readUriCredential(raw.slice(0, separator));
    const rawValue = raw.slice(separator + 1);
    if (key === "password") {
      queryPassword = readUriCredential(rawValue);
    } else {
      if (key === "sslpassword" && readUriCredential(rawValue)) throw new Error(UNSUPPORTED_CONNECTION);
      fields.push({ key, raw });
    }
  }

  const explicitPassword = queryPassword !== undefined || userPassword.length > 0;
  if (!explicitPassword) return { uri: connectionString, explicitPassword };
  const password = queryPassword ?? userPassword;
  const kept = fields.filter(({ key }) => !password || key !== "passfile").map(({ raw }) => raw);
  return {
    uri: withoutUserPassword + "?" + [...kept, "password="].join("&"),
    explicitPassword,
    ...(password ? { password } : {}),
  };
}

function readUriCredential(raw: string): string {
  try {
    const decoded = decodeURIComponent(raw);
    if (hasUnsupportedControlCharacter(decoded)) throw new Error();
    return decoded;
  } catch {
    throw new Error(UNSUPPORTED_CONNECTION);
  }
}

function passfileRecord(password: string): Buffer {
  return Buffer.from("*:*:*:*:" + password.replace(/[\\:]/gu, (character) => "\\" + character) + "\n", "utf8");
}

export function postgresBackupEnvironment(
  connection: PostgresBackupConnection,
  configuredNames: readonly (string | undefined)[],
): NodeJS.ProcessEnv {
  return scrubPostgresBackupEnvironment(configuredNames, !connection.explicitPassword);
}

export function postgresBackupAncillaryEnvironment(
  configuredNames: readonly (string | undefined)[],
): NodeJS.ProcessEnv {
  return scrubPostgresBackupEnvironment(configuredNames, false);
}

function scrubPostgresBackupEnvironment(
  configuredNames: readonly (string | undefined)[],
  allowAmbientPassword: boolean,
): NodeJS.ProcessEnv {
  const names = new Set(configuredNames
    .filter((name): name is string => Boolean(name?.trim()))
    .map((name) => name.trim().toUpperCase()));
  names.add("GOATCITADEL_POSTGRES_CONNECTION_STRING");
  names.add("GOATCITADEL_POSTGRES_PASSWORD");
  // When libpq has no explicit password, an existing ambient PGPASSWORD
  // remains its original fallback, including when it was named in settings.
  if (allowAmbientPassword) names.delete("PGPASSWORD");
  else names.add("PGPASSWORD");
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.has(name.toUpperCase())));
}

const DOCKER_PASSFILE_SCRIPT = [
  "umask 077",
  "scratch=$(mktemp -d /tmp/goatcitadel-pgdump.XXXXXXXXXX) || exit 1",
  'passfile="$scratch/pgpass"',
  "trap 'rm -f -- \"$passfile\"; rmdir -- \"$scratch\"' 0",
  "trap 'exit 1' HUP INT TERM",
  'cat > "$passfile" || exit 1',
  'pg_dump --format=custom --no-password --dbname "$1&passfile=$passfile"',
].join("\n");

export function runBundledPostgresDump(
  containerName: string,
  connection: PostgresBackupConnection,
  env: NodeJS.ProcessEnv,
): Buffer {
  const uri = connection.uri.replace(/@127\.0\.0\.1:\d+\//u, "@127.0.0.1:5432/");
  const record = connection.password ? passfileRecord(connection.password) : undefined;
  try {
    return execFileSync("docker", record
      ? ["exec", "-i", containerName, "sh", "-c", DOCKER_PASSFILE_SCRIPT, "goatcitadel-pgdump", uri]
      : ["exec", containerName, "pg_dump", "--format=custom", "--dbname", uri], {
      stdio: [record ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
      ...(record ? { input: record } : {}),
    });
  } finally {
    record?.fill(0);
  }
}

export async function runNativePostgresDump(
  command: string,
  dumpPath: string,
  connection: PostgresBackupConnection,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const dump = (uri: string) => {
    try {
      execFileSync(command, [
        "--format=custom", "--file", dumpPath, ...(connection.password ? ["--no-password"] : []), uri,
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env,
      });
    } catch {
      // Child diagnostics can echo connection parameters or credential bytes.
      throw new Error(DUMP_FAILURE);
    }
  };
  if (!connection.password) {
    dump(connection.uri);
    return;
  }
  const record = passfileRecord(connection.password);
  try {
    await withPrivatePassfile(record, (file) => dump(connection.uri + "&passfile=" + encodeURIComponent(file)));
  } finally {
    record.fill(0);
  }
}

async function withPrivatePassfile(record: Buffer, run: (file: string) => void): Promise<void> {
  const windows = process.platform === "win32" ? createWindowsScratchSecurity() : undefined;
  const signal = AbortSignal.timeout(30_000);
  let scratch: string | undefined;
  let file: string | undefined;
  try {
    const home = os.userInfo().homedir;
    const canonicalHome = await fs.realpath(home);
    if (!samePath(home, canonicalHome) || !(await fs.lstat(home)).isDirectory()) throw new Error();
    const owner = windows
      ? await windows.verifyPrivateParent(home, signal)
      : await verifyPosixPrivateParent(home);
    scratch = await fs.mkdtemp(path.join(home, ".goatcitadel-pgdump-"));
    const before = await fs.lstat(scratch, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error();
    if (windows && (await windows.applyOwnerOnlyAcl(scratch, "directory", signal)).ownerSid !== owner?.ownerSid) {
      throw new Error();
    }
    const secured = await fs.lstat(scratch, { bigint: true });
    if (!sameNode(before, secured) || !samePath(scratch, await fs.realpath(scratch)) ||
      (!windows && (secured.mode & 0o777n) !== 0o700n)) throw new Error();

    const candidate = path.join(scratch, "pgpass");
    const handle = await fs.open(candidate, "wx", 0o600);
    file = candidate;
    try {
      const opened = await handle.stat({ bigint: true });
      if (windows && (await windows.applyOwnerOnlyAcl(file, "file", signal)).ownerSid !== owner?.ownerSid) {
        throw new Error();
      }
      const final = await fs.lstat(file, { bigint: true });
      if (!sameNode(opened, final) || !final.isFile() || final.isSymbolicLink() || final.nlink !== 1n ||
        !samePath(file, await fs.realpath(file)) || (!windows && (final.mode & 0o777n) !== 0o600n)) throw new Error();
      await handle.writeFile(record);
    } finally {
      await handle.close();
    }
  } catch {
    await removePrivatePassfile(file, scratch);
    throw new Error(PRIVATE_SCRATCH_FAILURE);
  }
  try {
    run(file);
  } finally {
    await removePrivatePassfile(file, scratch);
  }
}

async function verifyPosixPrivateParent(home: string): Promise<undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error();
  let directory = home;
  while (true) {
    const stat = await fs.lstat(directory);
    const writableByOthers = (stat.mode & 0o022) !== 0;
    const trustedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0 && directory !== home;
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) || (writableByOthers && !trustedSticky)) {
      throw new Error();
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function removePrivatePassfile(file: string | undefined, scratch: string | undefined): Promise<void> {
  try {
    if (file) await fs.unlink(file);
    if (scratch) await fs.rmdir(scratch);
  } catch {
    throw new Error(PRIVATE_SCRATCH_FAILURE);
  }
}

function samePath(first: string, second: string): boolean {
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function sameNode(
  first: { dev: bigint; ino: bigint; birthtimeNs: bigint },
  second: { dev: bigint; ino: bigint; birthtimeNs: bigint },
): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.birthtimeNs === second.birthtimeNs;
}
