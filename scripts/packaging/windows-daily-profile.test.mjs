import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertIndependentPaths, assertStandardProfileDirectories, backupProfile, verifyProfileBackup, restoreDailyProfile, dailyEnvironment } from "./windows-daily-profile.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-daily-test-"));
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), "goatcitadel-daily-test-"))); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
test("migration requires independent paths and replaces only database environment overrides", () => {
  assert.throws(() => assertIndependentPaths("C:/profile", "C:/profile/backup"), /independent/);
  assert.throws(() => assertIndependentPaths("C:/profile", "C:/profile"), /independent/);
  const output = dailyEnvironment("PROVIDER_KEY=fixture\nGOATCITADEL_DATABASE_DRIVER=sqlite\nGOATCITADEL_POSTGRES_CONNECTION_STRING=old\n", 45433, "C:\\Postgres\\bin");
  assert.match(output, /PROVIDER_KEY=fixture/);
  assert.match(output, /GOATCITADEL_DATABASE_DRIVER=postgres/);
  assert.match(output, /GOATCITADEL_BUNDLED_POSTGRES_PORT=45433/);
  assert.doesNotMatch(output, /=old|=sqlite/);
  assertStandardProfileDirectories({ assistant: { transcriptsDir: "./data/transcripts" } });
  assert.throws(() => assertStandardProfileDirectories({ assistant: { transcriptsDir: "F:/development/data/transcripts" } }), /migration map/);
  assert.throws(() => assertStandardProfileDirectories({ assistant: { capabilities: { tempRoot: "../shared" } } }), /migration map/);
});
test("SQLite backup includes WAL history, preserves configuration and detects later tampering", async (t) => {
  const root = fixture(t), source = path.join(root, "source"), output = path.join(root, "backup");
  fs.mkdirSync(path.join(source, "config"), { recursive: true });
  fs.mkdirSync(path.join(source, "data"));
  fs.writeFileSync(path.join(source, "config/goatcitadel.json"), JSON.stringify({ assistant: { database: { driver: "sqlite" } } }));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(source, "data/index.db"));
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE history (body TEXT); INSERT INTO history VALUES ('keep me');");
    await backupProfile({ source, destination: output });
    const copy = new DatabaseSync(path.join(output, "payload/data/index.db"), { readOnly: true });
    try { assert.equal(copy.prepare("SELECT body FROM history").get().body, "keep me"); }
    finally { copy.close(); }
    assert.equal((await verifyProfileBackup(output)).database.integrity, "ok");
    fs.appendFileSync(path.join(output, "payload/config/goatcitadel.json"), " ");
    await assert.rejects(verifyProfileBackup(output), /checksum/);
  } finally { db.close(); }
});

test("PostgreSQL dump restores to an independent held profile with history and disabled automation", {
  skip: !process.env.GOATCITADEL_TEST_PG_BIN, timeout: 120000,
}, async (t) => {
  const root = fixture(t), source = path.join(root, "source"), output = path.join(root, "backup"), profile = path.join(root, "daily");
  const bin = process.env.GOATCITADEL_TEST_PG_BIN;
  const sourcePort = await freePort(), destinationPort = await freePort();
  assert.notEqual(sourcePort, destinationPort);
  fs.mkdirSync(path.join(source, "config"), { recursive: true });
  fs.mkdirSync(path.join(source, "data/secrets"), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(repo, "config/goatcitadel.example.json"), "utf8"));
  config.assistant.database.driver = "postgres";
  config.assistant.database.postgres = { ...config.assistant.database.postgres, mode: "bundled", database: "goatcitadel" };
  config.assistant.database.bundledPostgres = { enabled: true, autoStart: true, port: sourcePort, dataDir: "./data/postgres", binDir: bin };
  fs.writeFileSync(path.join(source, "config/goatcitadel.json"), JSON.stringify(config));
  const passwordFile = path.join(source, "data/secrets/postgres-bundled-password");
  fs.writeFileSync(passwordFile, "synthetic-local-test-password-only");
  const dataDir = path.join(source, "data/postgres");
  pg("initdb", ["-D", dataDir, "-U", "postgres", "-A", "scram-sha-256", "--pwfile", passwordFile, "--encoding", "UTF8"]);
  let client;
  try {
    pg("pg_ctl", ["-D", dataDir, "-l", path.join(source, "postgres.log"), "-o", "-h 127.0.0.1 -p " + sourcePort, "-w", "start"], true);
    pg("createdb", ["-w", "-h", "127.0.0.1", "-p", String(sourcePort), "-U", "postgres", "goatcitadel"]);
    const { Client } = createRequire(path.join(repo, "packages/storage/package.json"))("pg");
    client = new Client({ host: "127.0.0.1", port: sourcePort, database: "goatcitadel", user: "postgres", password: "synthetic-local-test-password-only" });
    await client.connect();
    await client.query("CREATE TABLE schema_migrations(version integer); INSERT INTO schema_migrations VALUES (1); CREATE TABLE sessions(id text); INSERT INTO sessions VALUES ('retained'); CREATE TABLE cron_jobs(job_id text,enabled integer); INSERT INTO cron_jobs VALUES ('schedule',1); CREATE TABLE integration_connections(connection_id text, enabled integer); INSERT INTO integration_connections VALUES ('integration',1); CREATE TABLE durable_runs(status text); INSERT INTO durable_runs VALUES ('waiting');");
    const info = await backupProfile({ source, destination: output, pgBin: bin });
    assert.equal(info.database.counts.sessions, 1);
    await assert.rejects(restoreDailyProfile({ backup: output, profile, pgBin: bin, databasePort: destinationPort, supportedSchema: 0 }), /newer/);
    assert.equal(fs.existsSync(profile), false);
    const restored = await restoreDailyProfile({ backup: output, profile, pgBin: bin, databasePort: destinationPort, supportedSchema: 1 });
    assert.equal(restored.readyForActivation, false);
    assert.ok(fs.existsSync(path.join(profile, ".daily-profile-pending-review")));
    const review = JSON.parse(fs.readFileSync(path.join(profile, "daily-migration-review.json")));
    assert.equal(review.counts.sessions, 1);
    assert.deepEqual(review.integrationsToReview, ["integration"]);
    assert.deepEqual(review.schedulesToReview, ["schedule"]);
    assert.equal((await client.query("SELECT enabled FROM cron_jobs")).rows[0].enabled, 1, "development schedules remain unchanged");
    assert.equal(JSON.parse(fs.readFileSync(path.join(source, "config/goatcitadel.json"))).assistant.database.bundledPostgres.port, sourcePort);
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "config/goatcitadel.json"))).assistant.database.bundledPostgres.port, destinationPort);
  } finally {
    if (client) await client.end();
    if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) pg("pg_ctl", ["-D", dataDir, "-w", "stop", "-m", "fast"], true);
  }
  function pg(name, args, quiet = false) {
    const result = spawnSync(path.join(bin, name + (process.platform === "win32" ? ".exe" : "")), args,
      { stdio: quiet ? "ignore" : "pipe", windowsHide: true, encoding: "utf8", timeout: 45000,
        env: { ...process.env, PGPASSWORD: "synthetic-local-test-password-only" } });
    assert.equal(result.status, 0, name + " failed: " + (result.stderr ?? result.error?.message ?? ""));
  }
});
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
