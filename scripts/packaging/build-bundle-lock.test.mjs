// Draft destination: scripts/packaging/build-bundle-lock.test.mjs
// Run only in the coordinator-owned Node 22 / pnpm 10.31.0 slot, from repo root.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../..", import.meta.url));
const pnpmVersion = "10.31.0";
const leafName = "goatcitadel-test-locked-leaf";
const localName = "@goatcitadel/test-workspace-lock-input";
const oldVersion = "1.0.0";
const newVersion = "1.0.1";
const copiedScripts = [
  "scripts/packaging/build-bundle.mjs",
  "scripts/packaging/lib/packaging-targets.mjs",
  "scripts/packaging/lib/package-renderers.mjs",
  "scripts/packaging/lib/desktop-artifact-provenance.mjs",
  "scripts/packaging/lib/release-payload-ownership.mjs",
  "scripts/packaging/safe-cleanup.mjs",
  "scripts/lib/ui-target.mjs",
];

test("bundle deploy keeps the pinned transitive package when a newer version satisfies the range", { timeout: 90_000 }, async (t) => {
  const scratchParent = await fs.realpath(os.tmpdir());
  const fixture = await fs.mkdtemp(path.join(scratchParent, "goatcitadel-bundle-lock-"));
  t.after(async () => {
    const stats = await fs.lstat(fixture);
    assert.ok(stats.isDirectory() && !stats.isSymbolicLink());
    assert.equal(await fs.realpath(fixture), fixture);
    assert.equal(path.dirname(fixture), scratchParent);
    assert.match(path.basename(fixture), /^goatcitadel-bundle-lock-[a-z0-9]+$/i);
    await fs.rm(fixture, { recursive: true, force: true });
  });
  const registry = await startRegistry();
  t.after(async () => {
    registry.server.closeAllConnections();
    await new Promise((resolve) => registry.server.close(resolve));
  });
  const env = await fixtureEnv(fixture, registry.url, "lock");
  await writeJson(fixture, "package.json", {
    name: "goatcitadel-bundle-lock-fixture", version: "1.0.0", private: true, packageManager: "pnpm@" + pnpmVersion,
  });
  await fs.writeFile(path.join(fixture, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  await writeJson(fixture, "apps/gateway/package.json", {
    name: "@goatcitadel/gateway", version: "1.0.0", files: ["dist"], dependencies: { [localName]: "workspace:*" },
  });
  await writeJson(fixture, "packages/lock-input/package.json", {
    name: localName, version: "1.0.0", files: ["dist"], dependencies: { [leafName]: "^1.0.0" },
  });
  for (const relative of ["apps/gateway", "packages/lock-input"]) {
    await fs.mkdir(path.join(fixture, relative, "dist"), { recursive: true });
    await fs.writeFile(path.join(fixture, relative, "dist", "marker.js"), "// synthetic workspace runtime\n");
  }
  for (const relative of copiedScripts) {
    const target = path.join(fixture, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(repo, relative), target);
  }
  const opts = { cwd: fixture, env, timeout: 25_000, windowsHide: true, maxBuffer: 1024 * 1024 };
  // Pinned pnpm supplies npm_execpath to scripts. This prerequisite is explicit and never auto-installs pnpm.
  const pnpm = process.env.GOATCITADEL_TEST_PNPM_ENTRY ?? process.env.npm_execpath;
  assert.ok(pnpm && path.isAbsolute(pnpm), "Set GOATCITADEL_TEST_PNPM_ENTRY to the installed pnpm 10.31.0 JS launcher");
  const version = await run(process.execPath, [pnpm, "--version"], opts);
  assert.equal(version.stdout.trim(), pnpmVersion);
  await run(process.execPath, [pnpm, "install", "--lockfile-only", "--ignore-scripts"], opts);
  const lockPath = path.join(fixture, "pnpm-lock.yaml");
  const gatewayManifest = path.join(fixture, "apps/gateway/package.json");
  const locked = await fs.readFile(lockPath);
  const manifest = await fs.readFile(gatewayManifest);
  assert.match(locked.toString(), /goatcitadel-test-locked-leaf@1\.0\.0/);
  assert.doesNotMatch(locked.toString(), /goatcitadel-test-locked-leaf@1\.0\.1/);
  // Isolated fixture Git metadata only. No source checkout mutation or external remote exists.
  await run("git", ["init", "--quiet"], opts);
  await run("git", ["-c", "user.name=Bundle Fixture", "-c", "user.email=bundle-fixture@example.test",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + path.join(fixture, "no-hooks"),
    "commit", "--quiet", "--allow-empty", "-m", "Synthetic bundle fixture"], opts);
  registry.advertiseNewVersion();
  const deploymentEnv = await fixtureEnv(fixture, registry.url, "deploy");
  const shimDir = await createPnpmShim(fixture, pnpm);
  deploymentEnv.PATH = shimDir + path.delimiter + (deploymentEnv.PATH ?? "");
  const deployOpts = { ...opts, env: deploymentEnv, timeout: 45_000 };
  const buildArgs = ["scripts/packaging/build-bundle.mjs", "--target", "linux-x64", "--skip-build", "--skip-desktop"];
  // Deliberately omit the launcher. The real entrypoint has just finished dependency deployment and ownership cleanup
  // before its first launcher copy. The exact missing file is our boundary sentinel, before any Node download.
  await assert.rejects(run(process.execPath, buildArgs, deployOpts), (error) =>
    error.code === 1 && /ENOENT/.test(error.stderr) && /goatcitadel\.mjs/.test(error.stderr));
  const deploy = path.join(fixture, "artifacts/installers/bundles/GoatCitadel-1.0.0-linux-x64/app/gateway");
  const leaf = JSON.parse(await fs.readFile(path.join(deploy, "node_modules", leafName, "package.json"), "utf8"));
  assert.equal(leaf.version, oldVersion, "deployed transitive must match workspace lock despite the newer satisfier");
  const local = path.join(deploy, "node_modules", localName);
  assert.ok((await fs.lstat(local)).isDirectory());
  assert.equal((await fs.lstat(local)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(local, "dist", "marker.js"), "utf8"), "// synthetic workspace runtime\n");
  assert.deepEqual(await fs.readFile(path.join(deploy, "package.json")), manifest);
  assert.deepEqual(await fs.readFile(lockPath), locked);
  assert.deepEqual(await fs.readFile(gatewayManifest), manifest);

  const checkoutForms = [fixture, fixture.split(path.sep).join("/"), pathToFileURL(fixture).href, JSON.stringify(fixture).slice(1, -1)];
  const residue = [];
  for (const file of ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"]) {
    const bytes = await fs.readFile(path.join(deploy, file), "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (bytes !== undefined) {
      residue.push({ file, refersToFixture: checkoutForms.some((form) => bytes.includes(form)) });
    }
  }
  assert.deepEqual(residue, [], "installed Gateway must exclude pnpm deployment metadata");

  const requestsBeforeMissingLock = registry.requestCount();
  await fs.rm(lockPath);
  await assert.rejects(run(process.execPath, [...buildArgs, "--out-dir", path.join(fixture, "missing-lock-out")], deployOpts),
    (error) => error.code === 1 && /canonical workspace lockfile/i.test(error.stderr));
  assert.equal(registry.requestCount(), requestsBeforeMissingLock, "a missing lock must stop before package resolution");
});

async function writeJson(root, relative, value) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

async function createPnpmShim(root, pnpm) {
  const shimDir = path.join(root, "shim");
  await fs.mkdir(shimDir);
  if (process.platform === "win32") {
    for (const value of [process.execPath, pnpm]) {
      assert.doesNotMatch(value, /["%!\r\n]/u, "fixture launcher path must be safe in a literal batch argument");
    }
    await fs.writeFile(path.join(shimDir, "pnpm.cmd"), '@"' + process.execPath + '" "' + pnpm + '" %*\r\n');
  } else {
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    await fs.writeFile(path.join(shimDir, "pnpm"), "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(pnpm) + ' "$@"\n', { mode: 0o700 });
  }
  return shimDir;
}

async function fixtureEnv(root, registry, phase) {
  const options = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key]) options[key] = process.env[key];
  }
  const privateHome = path.join(root, phase);
  await fs.mkdir(privateHome, { recursive: true });
  const emptyConfig = path.join(privateHome, "empty.npmrc");
  await fs.writeFile(emptyConfig, "");
  return {
    ...options,
    HOME: privateHome, USERPROFILE: privateHome, APPDATA: privateHome, LOCALAPPDATA: privateHome,
    XDG_CONFIG_HOME: privateHome, XDG_CACHE_HOME: privateHome, XDG_DATA_HOME: privateHome,
    npm_config_userconfig: emptyConfig, npm_config_globalconfig: emptyConfig,
    npm_config_registry: registry, npm_config_store_dir: path.join(privateHome, "store"),
    npm_config_cache_dir: path.join(privateHome, "cache"),
    npm_config_manage_package_manager_versions: "false", npm_config_ignore_scripts: "true",
    npm_config_network_concurrency: "1", npm_config_fetch_retries: "0",
    npm_config_update_notifier: "false",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig,
  };
}

async function startRegistry() {
  const tarballs = new Map([oldVersion, newVersion].map((version) => [version, makeTarball(version)]));
  let url;
  let latest = oldVersion;
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    const route = new URL(request.url, url).pathname;
    if (route === "/" + leafName) {
      const versions = [oldVersion, ...(latest === newVersion ? [newVersion] : [])];
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        name: leafName,
        "dist-tags": { latest },
        versions: Object.fromEntries(versions.map((version) => {
          const body = tarballs.get(version);
          return [version, {
            name: leafName, version,
            dist: {
              tarball: url + leafName + "/-/" + leafName + "-" + version + ".tgz",
              integrity: "sha512-" + createHash("sha512").update(body).digest("base64"),
            },
          }];
        })),
      }));
      return;
    }
    for (const [version, tarball] of tarballs) {
      if (route === "/" + leafName + "/-/" + leafName + "-" + version + ".tgz") {
        response.setHeader("Content-Type", "application/octet-stream");
        response.end(tarball);
        return;
      }
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  url = "http://127.0.0.1:" + server.address().port + "/";
  return { server, url, advertiseNewVersion: () => { latest = newVersion; }, requestCount: () => requests };
}

function makeTarball(version) {
  const content = Buffer.from(JSON.stringify({ name: leafName, version }));
  const header = Buffer.alloc(512);
  const writeOctal = (value, offset, width) => header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
  header.write("package/package.json", 0, 100, "ascii");
  writeOctal(0o644, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(content.length, 124, 12);
  writeOctal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0" + "00", 257, 8, "ascii");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]));
}

test("frozen Gateway deploy includes the vendored transitive types package", { timeout: 60_000 }, async (t) => {
  const vendorPath = "vendor/webgpu-types-stub";
  const name = "@webgpu/types";
  const sourceManifest = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8"));
  const override = sourceManifest.pnpm.overrides[name];
  assert.equal(override, "link:" + vendorPath);
  const scratchParent = await fs.realpath(os.tmpdir());
  const fixture = await fs.mkdtemp(path.join(scratchParent, "gc-vendor-"));
  t.after(async () => {
    const stat = await fs.lstat(fixture);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(await fs.realpath(fixture), fixture);
    assert.equal(path.dirname(fixture), scratchParent);
    assert.match(path.basename(fixture), /^gc-vendor-[a-z0-9]+$/iu);
    await fs.rm(fixture, { recursive: true, force: true });
  });

  const leaf = "@goatcitadel/test-vendor-bridge";
  await writeJson(fixture, "package.json", {
    name: "goatcitadel-deploy-vendor-fixture", version: "1.0.0", private: true,
    packageManager: "pnpm@" + pnpmVersion, pnpm: { overrides: { [name]: override } },
  });
  await writeJson(fixture, "apps/gateway/package.json", {
    name: "@goatcitadel/gateway", version: "1.0.0", dependencies: { [leaf]: "workspace:*" },
  });
  await writeJson(fixture, "packages/vendor-bridge/package.json", {
    name: leaf, version: "1.0.0", dependencies: { [name]: "0.1.69" },
  });
  const vendorFiles = ["package.json", "index.d.ts"];
  await fs.mkdir(path.join(fixture, vendorPath), { recursive: true });
  for (const file of vendorFiles) {
    await fs.copyFile(path.join(repo, vendorPath, file), path.join(fixture, vendorPath, file));
  }
  const env = {
    ...await fixtureEnv(fixture, "http://127.0.0.1:1/", "offline"),
    npm_config_offline: "true", npm_config_ignore_pnpmfile: "true", HUSKY: "0",
  };
  const pnpm = process.env.GOATCITADEL_TEST_PNPM_ENTRY ?? process.env.npm_execpath;
  assert.ok(pnpm && path.isAbsolute(pnpm), "Set the installed pnpm 10.31.0 JS launcher");
  const opts = { cwd: fixture, env, timeout: 25_000, windowsHide: true, maxBuffer: 1024 * 1024 };
  assert.equal((await run(process.execPath, [pnpm, "--version"], opts)).stdout.trim(), pnpmVersion);
  // Read actual pnpm workspace membership, independent of YAML quoting or glob spelling.
  const discovery = await run(process.execPath, [
    pnpm, "--dir", path.resolve(repo), "--reporter=silent", "--recursive", "list", "--depth", "-1", "--json",
  ], { ...opts, cwd: path.resolve(repo) });
  const projects = JSON.parse(discovery.stdout);
  assert.ok(Array.isArray(projects));
  const vendorProjects = projects.filter((project) => project.name === name);
  assert.ok(vendorProjects.length <= 1, "Ambiguous workspace member for vendored @webgpu/types");
  if (vendorProjects.length) {
    assert.equal(await fs.realpath(vendorProjects[0].path), await fs.realpath(path.join(repo, vendorPath)));
  }
  const workspacePaths = ["apps/*", "packages/*", ...(vendorProjects.length ? [vendorPath] : [])];
  await fs.writeFile(path.join(fixture, "pnpm-workspace.yaml"),
    "packages:\n" + workspacePaths.map((entry) => "  - " + JSON.stringify(entry) + "\n").join(""));
  await run(process.execPath, [pnpm, "install", "--lockfile-only", "--ignore-scripts", "--offline"], opts);
  const lockPath = path.join(fixture, "pnpm-lock.yaml");
  const locked = await fs.readFile(lockPath);
  assert.match(locked.toString(), /version: link:\.\.\/\.\.\/vendor\/webgpu-types-stub/u);
  const deploy = path.join(fixture, "out");
  const deployArgs = [
    pnpm, "--dir", fixture, "--filter", "@goatcitadel/gateway", "deploy", "--prod",
    "--config.force-legacy-deploy=false", "--config.inject-workspace-packages=true",
    "--config.shared-workspace-lockfile=true", "--config.lockfile=true",
    "--config.lockfile-dir=" + fixture, "--config.node-linker=hoisted", "--config.package-import-method=copy",
    deploy,
  ];
  try {
    await run(process.execPath, deployArgs, opts);
  } catch (error) {
    const output = String(error.stdout ?? "") + String(error.stderr ?? "");
    const missingVendorSnapshot = /\bERR_PNPM_LOCKFILE_MISSING_DEPENDENCY\b/u.test(output) &&
      /Broken lockfile: no entry for '[^'\r\n]*webgpu-types-stub[^'\r\n]*'/u.test(output);
    assert.equal(missingVendorSnapshot, false, "Frozen deployment lost the vendored @webgpu/types snapshot");
    throw new Error("Frozen synthetic deploy did not complete", { cause: error });
  }
  assert.deepEqual(await fs.readFile(lockPath), locked);
  const target = path.join(deploy, "node_modules", name);
  const stat = await fs.lstat(target);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(await fs.realpath(target), target);
  for (const file of vendorFiles) {
    assert.deepEqual(await fs.readFile(path.join(target, file)), await fs.readFile(path.join(repo, vendorPath, file)));
  }
});
