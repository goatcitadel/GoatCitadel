#!/usr/bin/env node
// Operator-run, offline promotion only. This tool never replaces an installed profile.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireStorage = createRequire(path.join(repoRoot, "packages/storage/package.json"));
const roots = ["config", "data", "skills", "workspaces", "workspace", ".goatcitadel", ".env"];
const ignored = new Set([".git", "node_modules"]);
const excludedData = new Set(["postgres", "logs", "cache"]);

function assertNoLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Profile paths cannot traverse links.");
    if (path.dirname(current) === current) break;
  }
}
export function assertIndependentPaths(source, destination) {
  const a = path.resolve(source).toLowerCase(), b = path.resolve(destination).toLowerCase();
  if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep))
    throw new Error("Source, backup and destination must be independent directories.");
  assertNoLinks(source); assertNoLinks(destination);
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function copyProfile(source, destination, relative = "") {
  const from = path.join(source, relative);
  if (!fs.existsSync(from)) return;
  assertNoLinks(from);
  const stat = fs.lstatSync(from);
  if (stat.isDirectory()) {
    await fsp.mkdir(path.join(destination, relative), { recursive: true });
    for (const entry of await fsp.readdir(from)) {
      if (ignored.has(entry) || (relative === "data" && (excludedData.has(entry) || /^index\.db(?:-(?:wal|shm))?$/u.test(entry)))) continue;
      await copyProfile(source, destination, path.join(relative, entry));
    }
  } else if (stat.isFile()) {
    await fsp.mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
    await fsp.copyFile(from, path.join(destination, relative), fs.constants.COPYFILE_EXCL);
    if (await digest(from) !== await digest(path.join(destination, relative))) throw new Error("Profile changed during copy. Retry in a maintenance window.");
  } else throw new Error("Profile contains a non-regular file.");
}
async function filesIn(root, relative = "") {
  const records = [];
  for (const name of (await fsp.readdir(path.join(root, relative))).sort()) {
    const rel = path.join(relative, name), file = path.join(root, rel);
    assertNoLinks(file);
    if (fs.statSync(file).isDirectory()) records.push(...await filesIn(root, rel));
    else records.push({ path: rel.replaceAll("\\", "/"), sizeBytes: fs.statSync(file).size, sha256: await digest(file) });
  }
  return records;
}
function command(bin, name, args, env = process.env, quiet = false) {
  const executable = path.join(bin, name + (process.platform === "win32" ? ".exe" : ""));
  const result = spawnSync(executable, args, { env, encoding: "utf8", windowsHide: true,
    timeout: 180_000, maxBuffer: 4 * 1024 * 1024, stdio: quiet ? "ignore" : ["ignore", "pipe", "pipe"] });
  // Tool output and argv can contain profile data. Keep console errors secret-free.
  if (result.error || result.status !== 0) throw new Error(name + " failed. No installed profile was replaced.");
  return result.stdout ?? "";
}
async function connect(config, root, port) {
  const { Client } = requireStorage("pg");
  const password = fs.readFileSync(path.join(root, "data/secrets/postgres-bundled-password"), "utf8").trim();
  const client = new Client({ host: "127.0.0.1", port, user: "postgres", password,
    database: config.assistant.database.postgres.database || "goatcitadel", connectionTimeoutMillis: 10000 });
  await client.connect();
  return { client, password };
}
async function counts(client) {
  const result = {};
  for (const table of ["sessions", "chat_messages", "memory_items", "workspaces", "cron_jobs", "integration_connections"]) {
    const present = await client.query("SELECT to_regclass($1) AS relation", ["public." + table]);
    if (present.rows[0].relation) result[table] = Number((await client.query('SELECT count(*)::text AS count FROM "' + table + '"')).rows[0].count);
  }
  return result;
}
function requireBundled(config) {
  const database = config.assistant?.database;
  if (database?.driver !== "postgres" || database.postgres?.mode !== "bundled"
    || database.postgres.connectionString || database.postgres.connectionStringEnv || database.postgres.host
    || database.postgres.password || database.postgres.passwordEnv || database.postgres.user) {
    throw new Error("This migration tool requires the standard local bundled PostgreSQL profile.");
  }
  assertStandardProfileDirectories(config);
  if (config.assistant.database.bundledPostgres.dataDir !== "./data/postgres")
    throw new Error("Custom data directories require an operator-reviewed migration map.");
}

export function assertStandardProfileDirectories(config) {
  const defaults = { dataDir: "data", transcriptsDir: "data/transcripts", auditDir: "data/audit",
    workspaceDir: "workspace", worktreesDir: ".worktrees" };
  const capabilityDefaults = { candidateRoot: "data/capability-candidates",
    codeModeArtifactRoot: "data/code-mode-artifacts", tempRoot: "data/code-mode-temp" };
  for (const [settings, expected] of [[config.assistant ?? {}, defaults], [config.assistant?.capabilities ?? {}, capabilityDefaults]]) {
    for (const [name, directory] of Object.entries(expected)) {
      const value = settings[name] ?? directory;
      if (typeof value !== "string" || path.posix.normalize(value.replaceAll("\\", "/")) !== directory)
        throw new Error("Custom profile directories require an operator-reviewed migration map: " + name);
    }
  }
}

export function dailyEnvironment(raw, databasePort, pgBin) {
  const retained = raw.split(/\r?\n/u).filter(line => !/^\s*(?:export\s+)?(?:GOATCITADEL_(?:DATABASE_DRIVER|POSTGRES_[A-Z_]+|BUNDLED_POSTGRES_[A-Z_]+|ROOT_DIR|DISABLE_MAINTENANCE_SCHEDULER)|GATEWAY_(?:HOST|PORT))\s*=/u.test(line));
  return retained.join("\n").trimEnd() + "\nGOATCITADEL_DATABASE_DRIVER=postgres\nGOATCITADEL_POSTGRES_MODE=bundled\n"
    + "GOATCITADEL_BUNDLED_POSTGRES_PORT=" + databasePort + "\nGOATCITADEL_BUNDLED_POSTGRES_DATA_DIR=./data/postgres\n"
    + "GOATCITADEL_BUNDLED_POSTGRES_BIN_DIR=" + pgBin.replaceAll("\\", "/") + "\nGOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER=true\n";
}

export async function backupProfile({ source, destination, pgBin }) {
  assertIndependentPaths(source, destination);
  if (fs.existsSync(destination)) throw new Error("Backup destination already exists.");
  if (fs.existsSync(path.join(source, "config/.generations/transaction.json")))
    throw new Error("Finish the pending configuration transaction before taking a migration backup.");
  const config = JSON.parse(fs.readFileSync(path.join(source, "config/goatcitadel.json"), "utf8"));
  assertStandardProfileDirectories(config);
  await fsp.mkdir(destination, { recursive: true });
  const payload = path.join(destination, "payload");
  await fsp.mkdir(payload);
  let database;
  if (config.assistant.database.driver === "postgres") {
    requireBundled(config);
    const port = config.assistant.database.bundledPostgres.port;
    const { client, password } = await connect(config, source, port);
    try {
      const dataDirectory = (await client.query("SHOW data_directory")).rows[0].data_directory;
      if (path.resolve(dataDirectory).toLowerCase() !== path.resolve(source, config.assistant.database.bundledPostgres.dataDir).toLowerCase())
        throw new Error("Source database does not belong to this profile.");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshot = (await client.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
      database = { driver: "postgres", schemaVersion: Number((await client.query("SELECT max(version) AS version FROM schema_migrations")).rows[0].version),
        counts: await counts(client), port };
      await fsp.mkdir(path.join(payload, "database"));
      command(pgBin, "pg_dump", ["-w", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres",
        "-d", config.assistant.database.postgres.database || "goatcitadel", "--format=custom",
        "--snapshot", snapshot, "--file", path.join(payload, "database/postgres.dump")], { ...process.env, PGPASSWORD: password });
      await client.query("COMMIT");
      command(pgBin, "pg_restore", ["--list", path.join(payload, "database/postgres.dump")]);
    } finally { await client.end(); }
  } else if (config.assistant.database.driver === "sqlite") {
    const { DatabaseSync, backup } = await import("node:sqlite");
    await fsp.mkdir(path.join(payload, "data"));
    const db = new DatabaseSync(path.join(source, "data/index.db"), { readOnly: true });
    try { await backup(db, path.join(payload, "data/index.db")); }
    finally { db.close(); }
    const copy = new DatabaseSync(path.join(payload, "data/index.db"), { readOnly: true });
    try { if (copy.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("SQLite backup integrity check failed."); }
    finally { copy.close(); }
    database = { driver: "sqlite", integrity: "ok" };
  } else throw new Error("Unsupported profile database.");
  for (const relative of roots) await copyProfile(source, payload, relative);
  const manifest = { schemaVersion: 1, source: path.resolve(source), createdAt: new Date().toISOString(),
    onlineSnapshot: true, database, files: await filesIn(payload) };
  await fsp.writeFile(path.join(destination, "profile-backup.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await verifyProfileBackup(destination);
  return { destination, database, files: manifest.files.length };
}
export async function verifyProfileBackup(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "profile-backup.json"), "utf8"));
  const actual = await filesIn(path.join(directory, "payload"));
  if (manifest.schemaVersion !== 1 || JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error("Profile backup checksum verification failed.");
  return manifest;
}

export async function restoreDailyProfile({ backup, profile, pgBin, databasePort = 45433, supportedSchema }) {
  const manifest = await verifyProfileBackup(backup);
  assertIndependentPaths(backup, profile); assertIndependentPaths(manifest.source, profile);
  if (manifest.database.driver !== "postgres") throw new Error("Daily restore requires the development PostgreSQL backup.");
  const { POSTGRES_MIGRATIONS } = await import(pathToFileURL(path.join(repoRoot, "packages/storage/dist/postgres/migrations.js")));
  const compiledSchema = Math.max(...POSTGRES_MIGRATIONS.map(migration => migration.version));
  const schemaLimit = supportedSchema === undefined ? compiledSchema : Math.min(supportedSchema, compiledSchema);
  if (!Number.isInteger(schemaLimit) || manifest.database.schemaVersion > schemaLimit)
    throw new Error("The profile schema is newer than this app. Land its migrations before restoring.");
  if (!Number.isInteger(databasePort) || databasePort < 1024 || databasePort > 65535 || databasePort === manifest.database.port)
    throw new Error("Choose a separate valid database port.");
  if (fs.existsSync(profile)) throw new Error("Restore destination already exists. Installed profiles are never overwritten.");
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error("Daily database port is occupied. Choose another port or stop its owning instance.")));
    server.listen(databasePort, "127.0.0.1", () => server.close(resolve));
  });
  await fsp.mkdir(profile, { recursive: true });
  for (const relative of roots) await copyProfile(path.join(backup, "payload"), profile, relative);
  const { ConfigGenerationService } = await import(pathToFileURL(path.join(repoRoot, "apps/gateway/dist/services/config-generation-service.js")));
  const owner = new ConfigGenerationService(profile);
  const config = owner.getActivePayload();
  requireBundled(config);
  const enabledSchedules = (config.cronJobs.jobs ?? []).filter(job => job.enabled).map(job => job.jobId);
  config.cronJobs.jobs = (config.cronJobs.jobs ?? []).map(job => ({ ...job, enabled: false }));
  config.assistant.database.bundledPostgres = { ...config.assistant.database.bundledPostgres,
    enabled: true, autoStart: true, port: databasePort, dataDir: "./data/postgres", binDir: pgBin };
  await owner.commit({ expectedRevision: owner.getRevision(), buildCandidate: () => ({ payload: config, runtime: null }),
    previousRuntime: null, apply: async () => {}, restore: async () => {} });
  const envFile = path.join(profile, ".env");
  await fsp.writeFile(envFile, dailyEnvironment(fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "", databasePort, pgBin));
  await fsp.writeFile(path.join(profile, ".daily-profile-pending-review"), "Review daily-migration-review.json before activation.\n", { flag: "wx" });
  await fsp.mkdir(path.join(profile, "data/secrets"), { recursive: true });
  const passwordFile = path.join(profile, "data/secrets/postgres-bundled-password");
  await fsp.writeFile(passwordFile, randomBytes(24).toString("base64url"), { mode: 0o600 });
  const dataDir = path.join(profile, "data/postgres");
  command(pgBin, "initdb", ["-D", dataDir, "-U", "postgres", "-A", "scram-sha-256", "--pwfile", passwordFile, "--encoding", "UTF8"]);
  await fsp.writeFile(path.join(dataDir, ".goatcitadel-native-bundled-postgres"), "native\n");
  try {
    command(pgBin, "pg_ctl", ["-D", dataDir, "-l", path.join(profile, "postgres-restore.log"),
      "-o", "-h 127.0.0.1 -p " + databasePort, "-w", "-t", "30", "start"], process.env, true);
    const password = fs.readFileSync(passwordFile, "utf8").trim();
    const pgEnv = { ...process.env, PGPASSWORD: password };
    const args = ["-w", "-h", "127.0.0.1", "-p", String(databasePort), "-U", "postgres"];
    command(pgBin, "createdb", [...args, config.assistant.database.postgres.database || "goatcitadel"], pgEnv);
    command(pgBin, "pg_restore", [...args, "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges",
      "-d", config.assistant.database.postgres.database || "goatcitadel", path.join(backup, "payload/database/postgres.dump")], pgEnv);
    const { client } = await connect(config, profile, databasePort);
    try {
      if (JSON.stringify(await counts(client)) !== JSON.stringify(manifest.database.counts)) throw new Error("Restored history counts differ from the verified snapshot.");
      const integrations = (await client.query("SELECT connection_id FROM integration_connections WHERE enabled = 1")).rows.map(row => row.connection_id);
      const schedules = (await client.query("SELECT job_id FROM cron_jobs WHERE enabled = 1")).rows.map(row => row.job_id);
      await client.query("BEGIN");
      await client.query("UPDATE integration_connections SET enabled = 0 WHERE enabled = 1");
      await client.query("UPDATE cron_jobs SET enabled = 0 WHERE enabled = 1");
      await client.query("COMMIT");
      const runs = (await client.query("SELECT status, count(*)::text AS count FROM durable_runs WHERE status IN ('queued','running','waiting','paused') GROUP BY status")).rows;
      await fsp.writeFile(path.join(profile, "daily-migration-review.json"), JSON.stringify({
        sourceBackup: path.resolve(backup), databasePort, schemaVersion: manifest.database.schemaVersion,
        counts: manifest.database.counts, integrationsToReview: integrations, schedulesToReview: schedules,
        configuredSchedulesToReview: enabledSchedules, copiedUnfinishedRuns: runs,
        readyForActivation: false, instructions: "Review credentials, paths and unfinished runs before first Gateway start. Keep development schedules separate.",
      }, null, 2) + "\n");
    } finally { await client.end(); }
  } finally {
    // pg_ctl can time out after spawning postgres. Only this newly created cluster is ours to stop.
    if (fs.existsSync(path.join(dataDir, "postmaster.pid")))
      command(pgBin, "pg_ctl", ["-D", dataDir, "-w", "-t", "30", "stop", "-m", "fast"], process.env, true);
  }
  return { profile, databasePort, restored: true, readyForActivation: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(3);
  const options = Object.fromEntries(args.map((value, index) => value.startsWith("--") ? [value.slice(2), args[index + 1]] : null).filter(Boolean));
  try {
    const result = process.argv[2] === "backup"
      ? await backupProfile({ source: options.source, destination: options.output, pgBin: options["pg-bin"] })
      : process.argv[2] === "verify" ? await verifyProfileBackup(options.backup).then(value => ({ verified: true, files: value.files.length }))
      : process.argv[2] === "restore" ? await restoreDailyProfile({ backup: options.backup, profile: options.profile,
        pgBin: options["pg-bin"], databasePort: Number(options.port ?? 45433),
        supportedSchema: options["supported-schema"] === undefined ? undefined : Number(options["supported-schema"]) })
      : (() => { throw new Error("Use backup, verify or restore; see docs/desktop-updates.md."); })();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "Profile preparation failed.") + "\n");
    process.exitCode = 1;
  }
}
