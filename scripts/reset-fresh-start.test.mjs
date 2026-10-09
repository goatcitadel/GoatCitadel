import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceScript = fileURLToPath(new URL("./reset-fresh-start.ps1", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-reset-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(relative, value) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, value);
  }
  function git(...args) {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  write("package.json", JSON.stringify({ name: "goatcitadel" }));
  write("scripts/reset-fresh-start.ps1", fs.readFileSync(sourceScript));
  write("config/example.json", "tracked default\n");
  write("data/.gitkeep", "");
  write("data/transcripts/.gitkeep", "");
  write("workspace/fixtures/input.txt", "fixture\n");
  write("src/code.txt", "original source\n");
  git("init", "--quiet");
  git("add", "--", "package.json", "scripts", "config/example.json", "data", "workspace/fixtures", "src");
  write("config/example.json", "user-edited tracked default\n");
  write("src/code.txt", "user-edited source\n");
  write("src/untracked.txt", "untracked user work\n");
  write(
    "config/assistant.config.json",
    JSON.stringify({ environment: "local", dataDir: "./data", workspaceDir: "./workspace" }),
  );
  write("config/.generations/last-good", "test config generation\n");
  write("data/index.db", "test database\n");
  write("data/transcripts/chat.jsonl", "test transcript\n");
  write("data/secrets/local-password", "test-only-value\n");
  write("runtime/launcher.json", "test runtime\n");
  write("workspace/chat/test-chat/output.md", "generated chat\n");
  write("workspace/memory/daily.md", "test memory\n");
  write("workspace/goatcitadel_out/report.md", "generated report\n");
  write(".worktrees/another-agent/work.txt", "another agent work\n");
  write("node_modules/example/index.js", "dependency\n");
  write(".env", "NODE_ENV=development\n");
  function run(args = [], env = {}, keepCredentials = true) {
    // Isolate the port guard from other tests/dev servers on the host. The actual
    // script still runs, including real file moves and its process ownership query.
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "function Get-NetTCPConnection { @() }; $resetOptions = @{}; if ($env:RESET_KEEP_CREDENTIALS -eq 'true') { $resetOptions.KeepCredentials = $true }; foreach ($name in @($env:RESET_TEST_ARGS | ConvertFrom-Json)) { $resetOptions[$name.TrimStart('-')] = $true }; & $env:RESET_TEST_SCRIPT -IncludeWorkspaceOutputs -ClearBrowserState @resetOptions",
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          NODE_ENV: "development",
          GOATCITADEL_DATABASE_DRIVER: "",
          GOATCITADEL_POSTGRES_MODE: "",
          GOATCITADEL_BUNDLED_POSTGRES_DATA_DIR: "",
          RESET_TEST_SCRIPT: path.join(root, "scripts/reset-fresh-start.ps1"),
          RESET_TEST_ARGS: JSON.stringify(args),
          RESET_KEEP_CREDENTIALS: String(keepCredentials),
          ...env,
        },
      },
    );
    return { ...result, output: `${result.stdout}\n${result.stderr}` };
  }
  function manifests() {
    const backupRoot = path.join(root, ".codex-tmp");
    if (!fs.existsSync(backupRoot)) return [];
    return fs.readdirSync(backupRoot).map((name) => {
      const dir = path.join(backupRoot, name);
      return { dir, manifest: JSON.parse(fs.readFileSync(path.join(dir, "reset-manifest.json"), "utf8")) };
    });
  }
  return { root, write, run, manifests };
}

test(
  "clear archives runtime state byte-for-byte and preserves dirty source, tracked defaults, dependencies, fixtures, and worktrees",
  windowsOnly,
  (t) => {
    const f = fixture(t);
    const result = f.run();
    assert.equal(result.status, 0, result.output);
    const [{ dir, manifest }] = f.manifests();
    for (const relative of [
      "data/index.db",
      "data/transcripts/chat.jsonl",
      "config/assistant.config.json",
      ".env",
      "workspace/chat/test-chat/output.md",
      "workspace/memory/daily.md",
    ]) {
      assert.equal(fs.existsSync(path.join(f.root, relative)), false, relative);
      assert.equal(fs.existsSync(path.join(dir, relative)), true, relative);
    }
    assert.equal(fs.readFileSync(path.join(dir, "data/index.db"), "utf8"), "test database\n");
    for (const [relative, value] of Object.entries({
      "config/example.json": "user-edited tracked default\n",
      "src/code.txt": "user-edited source\n",
      "src/untracked.txt": "untracked user work\n",
      "workspace/fixtures/input.txt": "fixture\n",
      ".worktrees/another-agent/work.txt": "another agent work\n",
      "node_modules/example/index.js": "dependency\n",
      "data/.gitkeep": "",
      "data/transcripts/.gitkeep": "",
    }))
      assert.equal(fs.readFileSync(path.join(f.root, relative), "utf8"), value, relative);
    assert.equal(manifest.credentialsCleared, false);
    assert.equal(manifest.includeWorkspaceOutputs, true);
    assert.equal(fs.readFileSync(path.join(f.root, "runtime/dev-reset-id"), "utf8").trim(), manifest.browserResetId);
    const second = f.run();
    assert.equal(second.status, 0, second.output);
    assert.equal(f.manifests().length, 2);
    const marker = fs.readFileSync(path.join(f.root, "runtime/dev-reset-id"), "utf8").trim();
    assert.notEqual(marker, manifest.browserResetId);
  },
);

test("WhatIf creates no backup or browser marker and changes no runtime state", windowsOnly, (t) => {
  const f = fixture(t);
  const result = f.run(["-WhatIf"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Preview complete/);
  assert.equal(f.manifests().length, 0);
  assert.equal(fs.existsSync(path.join(f.root, "runtime/dev-reset-id")), false);
  assert.equal(fs.readFileSync(path.join(f.root, "data/index.db"), "utf8"), "test database\n");
});

for (const [name, config] of Object.entries({
  "external database": { database: { postgres: { mode: "external" } } },
  "custom data root": { dataDir: "../other-profile" },
  "custom postgres root": { database: { bundledPostgres: { dataDir: "../other-postgres" } } },
  "production profile": { environment: "production" },
  "explicit postgres endpoint": { database: { postgres: { connectionString: "postgres://example.invalid/test" } } },
}))
  test(`clear refuses ${name} before moving any data`, windowsOnly, (t) => {
    const f = fixture(t);
    f.write("config/assistant.config.json", JSON.stringify(config));
    const result = f.run();
    assert.notEqual(result.status, 0, result.output);
    assert.equal(f.manifests().length, 0);
    assert.equal(fs.existsSync(path.join(f.root, "data/index.db")), true);
  });

test("clear refuses production environment overrides", windowsOnly, (t) => {
  const f = fixture(t);
  const result = f.run([], { NODE_ENV: "production" });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /NODE_ENV=production/);
  assert.equal(f.manifests().length, 0);
});

test("clear refuses production .env before archiving anything", windowsOnly, (t) => {
  const f = fixture(t);
  f.write(".env", 'NODE_ENV="production"\n');
  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /NODE_ENV=production in .env/);
  assert.equal(f.manifests().length, 0);
});

test("clear refuses an unmarked PostgreSQL cluster, including Docker-managed data", windowsOnly, (t) => {
  const f = fixture(t);
  f.write("data/postgres/PG_VERSION", "16\n");
  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /not marked as GoatCitadel native PostgreSQL/);
  assert.equal(f.manifests().length, 0);
});

test("clear refuses junctions before moving config or following links outside the reset roots", windowsOnly, (t) => {
  const f = fixture(t);
  f.write("outside-models/keep.txt", "keep external content\n");
  fs.symlinkSync(path.join(f.root, "outside-models"), path.join(f.root, "data/linked-models"), "junction");
  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /symlink or junction/);
  assert.equal(f.manifests().length, 0);
  assert.equal(fs.existsSync(path.join(f.root, "config/assistant.config.json")), true);
  assert.equal(fs.readFileSync(path.join(f.root, "outside-models/keep.txt"), "utf8"), "keep external content\n");
});

test("clear stops only a dev process whose script belongs to the fixture checkout", windowsOnly, async (t) => {
  const f = fixture(t);
  f.write("scripts/dev.mjs", 'console.log("ready"); setInterval(() => {}, 1000);\n');
  const other = fixture(t);
  other.write("scripts/dev.mjs", 'console.log("ready"); setInterval(() => {}, 1000);\n');
  const unrelated = spawn(process.execPath, [path.join(other.root, "scripts/dev.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const unrelatedExited = new Promise((resolve) => unrelated.once("exit", resolve));
  const child = spawn(process.execPath, [path.join(f.root, "scripts/dev.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill();
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
  });
  const result = f.run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`Stopped GoatCitadel dev supervisor PID ${child.pid}`));
  await exited;
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
  unrelated.kill();
  await unrelatedExited;
});

// Exercise the real PowerShell -> PowerShell transport with a fake vault,
// never the user's keychain. A direct Node -> PowerShell call misses quoting bugs.
for (const scenario of ["populated", "empty", "unavailable"]) {
  test(`nested credential cleanup handles a ${scenario} vault without touching other apps`, windowsOnly, (t) => {
    const f = fixture(t);
    const helper = fs
      .readFileSync(sourceScript, "utf8")
      .match(/function Clear-GoatCitadelCredentials \{[\s\S]*?\r?\n\}\r?\n(?=\r?\nWrite-Host "Preparing)/u)?.[0];
    assert.ok(helper);
    const fakeVault = `$vault = New-Object PSObject
$vault | Add-Member -MemberType ScriptMethod -Name RetrieveAll -Value {
  if ($env:RESET_VAULT_SCENARIO -eq 'empty') { throw [Runtime.InteropServices.COMException]::new('empty', -2147023728) }
  if ($env:RESET_VAULT_SCENARIO -eq 'unavailable') { throw [Runtime.InteropServices.COMException]::new('unavailable', -2147024891) }
  return @([pscustomobject]@{Resource='goatcitadel'}, [pscustomobject]@{Resource='other-app'})
}
$vault | Add-Member -MemberType ScriptMethod -Name Remove -Value { param($entry)
  if ($entry.Resource -ne 'goatcitadel') { throw 'Wrong credential scope' }
  Write-Output 'removed-goatcitadel'
}`;
    const safeHelper = helper
      .replace(/^Add-Type[^\r\n]*\r?\n/mu, "")
      .replace(/^\$vault = \[Windows[^\r\n]*$/mu, fakeVault);
    f.write(
      "scripts/credential-helper-proof.ps1",
      `[CmdletBinding(SupportsShouldProcess = $true)]\nparam()\n$KeepCredentials = $false\n${safeHelper}\nClear-GoatCitadelCredentials\n`,
    );
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", path.join(f.root, "scripts/credential-helper-proof.ps1")],
      {
        encoding: "utf8",
        env: { ...process.env, RESET_VAULT_SCENARIO: scenario },
        timeout: 10_000,
      },
    );
    if (scenario === "unavailable") {
      assert.notEqual(result.status, 0);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Removed ${scenario === "empty" ? 0 : 1} GoatCitadel`));
      assert.equal(result.stdout.includes("removed-goatcitadel"), scenario === "populated");
    }

    // Also run the complete reset with credentials enabled, replacing only the
    // vault backend. Verify failure receipts and retry, not just helper syntax.
    f.write(
      "scripts/reset-fresh-start.ps1",
      fs
        .readFileSync(sourceScript, "utf8")
        .replace(/^Add-Type[^\r\n]*\r?\n/mu, "")
        .replace(/^\$vault = \[Windows[^\r\n]*$/mu, fakeVault),
    );
    const reset = f.run([], { RESET_VAULT_SCENARIO: scenario }, false);
    assert.equal(reset.status === 0, scenario !== "unavailable", reset.output);
    const [{ dir, manifest }] = f.manifests();
    assert.equal(fs.readFileSync(path.join(dir, "data/index.db"), "utf8"), "test database\n");
    assert.equal(manifest.resetStatus, scenario === "unavailable" ? "failed" : "complete");
    assert.equal(manifest.credentialResetStatus, scenario === "unavailable" ? "failed" : "cleared");
    assert.equal(manifest.credentialsCleared, scenario !== "unavailable");
    if (scenario === "unavailable") {
      assert.equal(manifest.browserResetId, null);
      assert.equal(fs.existsSync(path.join(f.root, "runtime/dev-reset-id")), false);
      assert.match(reset.output, /Reset incomplete.*reset manifest.*preserved/);
      const retry = f.run([], { RESET_VAULT_SCENARIO: "empty" }, false);
      assert.equal(retry.status, 0, retry.output);
      assert.equal(f.manifests().length, 2);
      assert.equal(fs.readFileSync(path.join(dir, "data/index.db"), "utf8"), "test database\n");
    } else {
      assert.equal(fs.readFileSync(path.join(f.root, "runtime/dev-reset-id"), "utf8").trim(), manifest.browserResetId);
    }
  });
}

test(
  "clear gracefully stops and archives a real native cluster, then permits fresh initialization",
  windowsOnly,
  async (t) => {
    const pgBin = path.join(process.env.ProgramFiles ?? "C:/Program Files", "PostgreSQL/16/bin");
    if (!fs.existsSync(path.join(pgBin, "pg_ctl.exe"))) return t.skip("native PostgreSQL 16 tools are unavailable");
    const f = fixture(t);
    const dataDir = path.join(f.root, "data/postgres");
    function pg(program, args) {
      const result = spawnSync(path.join(pgBin, `${program}.exe`), args, { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--locale=C"]);
    f.write("data/postgres/.goatcitadel-native-bundled-postgres", "backend=native\n");
    pg("pg_ctl", [
      "-D",
      dataDir,
      "-l",
      path.join(f.root, "postgres-test.log"),
      "-o",
      `-h 127.0.0.1 -p ${port}`,
      "-w",
      "-t",
      "20",
      "start",
    ]);
    try {
      const result = f.run();
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /Stopped bundled PostgreSQL/);
      const [{ dir }] = f.manifests();
      assert.equal(fs.existsSync(path.join(dir, "data/postgres/PG_VERSION")), true);
      assert.equal(fs.existsSync(path.join(dir, "data/postgres/postmaster.pid")), false);
      assert.equal(fs.existsSync(dataDir), false);
      pg("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--locale=C"]);
    } finally {
      // Only this fixture's exact data directory can be stopped here.
      if (fs.existsSync(path.join(dataDir, "postmaster.pid")))
        pg("pg_ctl", ["-D", dataDir, "-w", "-t", "20", "stop", "-m", "fast"]);
    }
  },
);
