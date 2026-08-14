import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const helperPath = process.env.GOATCITADEL_SOURCE_UPDATE_HELPER_TEST_PATH
  ? path.resolve(process.env.GOATCITADEL_SOURCE_UPDATE_HELPER_TEST_PATH)
  : path.join(repoRoot, "apps", "product-source-update-helper", "bin", "x64", "Debug", "net10.0-windows10.0.19041.0", "GoatCitadel-Product-Source-Update-Helper.exe");

test("native helper restores the exact prior tree when post-restart smoke fails", { timeout: 45_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows helper proof runs only on Windows.");
  await fs.access(helperPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-native-source-update-"));
  const sourceRoot = path.join(root, "source");
  const operationRoot = path.join(root, "private", "operation-1");
  const serverPath = path.join(root, "restart-server.mjs");
  const pidPath = path.join(root, "restart-server.pid");
  let serverPid;
  t.after(async () => {
    try {
      serverPid ??= Number(await fs.readFile(pidPath, "utf8"));
      if (Number.isSafeInteger(serverPid) && serverPid > 0) await stopProcess(serverPid);
    } catch {}
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  await createSourceFixture(sourceRoot);
  await fs.mkdir(operationRoot, { recursive: true });
  const target = path.join(sourceRoot, "apps", "gateway", "src", "native-helper-fixture.ts");
  const before = await fs.readFile(target);
  const baseSha = git(sourceRoot, ["rev-parse", "HEAD"]);
  const baseTree = git(sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  await fs.writeFile(target, "export const nativeHelperFixture = 2;\n", "utf8");
  const after = await fs.readFile(target);
  const patch = gitRaw(sourceRoot, ["diff", "--binary", "--full-index", "HEAD", "--", "."]);
  const rollback = gitRaw(sourceRoot, ["diff", "-R", "--binary", "--full-index", "HEAD", "--", "."]);
  await fs.writeFile(target, before);
  assert.equal(git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

  const patchPath = path.join(operationRoot, "approved.patch");
  const compensationPath = path.join(operationRoot, "rollback.patch");
  const resultPath = path.join(operationRoot, "apply-helper-result.json");
  const journalPath = path.join(operationRoot, "native-helper-journal.jsonl");
  const requestPath = path.join(operationRoot, "apply-helper-request.json");
  await fs.writeFile(patchPath, patch, "utf8");
  await fs.writeFile(compensationPath, rollback, "utf8");
  const port = 47_000 + Math.floor(Math.random() * 1_000);
  await fs.writeFile(serverPath, `
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const sourceRoot = process.argv[2];
const port = Number(process.argv[3]);
const pidPath = process.argv[4];
const content = fs.readFileSync(path.join(sourceRoot, "apps", "gateway", "src", "native-helper-fixture.ts"), "utf8");
if (content.includes("= 2")) process.exit(19);
const server = http.createServer((_request, response) => { response.writeHead(200); response.end("ok"); });
server.listen(port, "127.0.0.1", () => fs.writeFileSync(pidPath, String(process.pid)));
setTimeout(() => server.close(() => process.exit(0)), 30_000).unref();
`, "utf8");
  const request = {
    schemaVersion: 1,
    operation: "apply",
    planId: "plan-native-1",
    manifestId: "manifest-native-1",
    manifestSha256: "1".repeat(64),
    installId: "install-native-1",
    installRevision: 2,
    sourceRoot,
    expectedHead: baseSha,
    expectedTree: baseTree,
    patchPath,
    patchSha256: sha256(patch),
    compensationPath,
    compensationSha256: sha256(rollback),
    changedFiles: [{
      path: "apps/gateway/src/native-helper-fixture.ts",
      changeKind: "modified",
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
    }],
    approvalIds: ["approval-native-1"],
    parentPid: 2_000_000_000,
    parentStartedAtUnixMs: Date.now(),
    restart: {
      executable: process.execPath,
      args: [serverPath, sourceRoot, String(port), pidPath],
      workingDirectory: sourceRoot,
      healthUrl: `http://127.0.0.1:${port}/health`,
      healthTimeoutMs: 5_000,
    },
    resultPath,
    journalPath,
    createdAt: new Date().toISOString(),
  };
  const requestBytes = `${JSON.stringify(request)}\n`;
  await fs.writeFile(requestPath, requestBytes, "utf8");
  const exitCode = await runHelper(requestPath, sha256(requestBytes));
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  const journal = await fs.readFile(journalPath, "utf8");
  assert.equal(exitCode, 6, `${JSON.stringify(result)}\n${journal}`);
  assert.equal(result.status, "rolled_back");
  assert.equal(await fs.readFile(target, "utf8"), before.toString("utf8"));
  assert.equal(git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.equal(git(sourceRoot, ["rev-parse", "HEAD^{tree}"]), baseTree);
  assert.notEqual(git(sourceRoot, ["rev-parse", "HEAD"]), baseSha);
  assert.match(journal, /"eventType":"apply_failed"/u);
  assert.match(journal, /"eventType":"automatic_rollback_succeeded"/u);
});

test("native helper resumes the exact request after process death around the commit boundary", { timeout: 90_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows helper proof runs only on Windows.");
  await fs.access(helperPath);
  for (const phase of ["patch_applied", "patch_committed"]) {
    const fixture = await createSuccessfulOperationFixture(phase);
    t.after(async () => {
      try {
        const serverPid = Number(await fs.readFile(fixture.pidPath, "utf8"));
        if (Number.isSafeInteger(serverPid) && serverPid > 0) await stopProcess(serverPid);
      } catch {}
      await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    const first = spawnHelper(fixture.requestPath, fixture.requestSha256);
    await waitForJournalEvent(fixture.journalPath, phase, first);
    first.child.kill();
    await first.exited;
    await assert.rejects(fs.access(fixture.resultPath));

    const exitCode = await runHelper(fixture.requestPath, fixture.requestSha256);
    const result = JSON.parse(await fs.readFile(fixture.resultPath, "utf8"));
    const journal = await fs.readFile(fixture.journalPath, "utf8");
    assert.equal(exitCode, 0, `${phase}: ${JSON.stringify(result)}\n${journal}`);
    assert.equal(result.status, "succeeded");
    assert.equal(await fs.readFile(fixture.target, "utf8"), "export const nativeHelperFixture = 2;\n");
    assert.equal(git(fixture.sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.match(journal, /"eventType":"patch_recovered"/u);
    if (phase === "patch_applied") {
      // A git child already launched at the journal boundary may complete its
      // atomic commit while the helper process is being terminated. Both
      // recognized states are safe and must resume without repeating apply.
      assert.match(journal, /"state":"patch(?:staged|committed)"/u);
    } else {
      assert.match(journal, /"state":"patchcommitted"/u);
    }
  }
});

async function createSuccessfulOperationFixture(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `goatcitadel-native-source-recovery-${label}-`));
  const sourceRoot = path.join(root, "source");
  const operationRoot = path.join(root, "private", "operation-1");
  const serverPath = path.join(root, "restart-server.mjs");
  const pidPath = path.join(root, "restart-server.pid");
  await createSourceFixture(sourceRoot);
  await fs.mkdir(operationRoot, { recursive: true });
  const target = path.join(sourceRoot, "apps", "gateway", "src", "native-helper-fixture.ts");
  const before = await fs.readFile(target);
  const baseSha = git(sourceRoot, ["rev-parse", "HEAD"]);
  const baseTree = git(sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  await fs.writeFile(target, "export const nativeHelperFixture = 2;\n", "utf8");
  const after = await fs.readFile(target);
  const patch = gitRaw(sourceRoot, ["diff", "--binary", "--full-index", "HEAD", "--", "."]);
  const rollback = gitRaw(sourceRoot, ["diff", "-R", "--binary", "--full-index", "HEAD", "--", "."]);
  await fs.writeFile(target, before);
  const patchPath = path.join(operationRoot, "approved.patch");
  const compensationPath = path.join(operationRoot, "rollback.patch");
  const resultPath = path.join(operationRoot, "apply-helper-result.json");
  const journalPath = path.join(operationRoot, "native-helper-journal.jsonl");
  const requestPath = path.join(operationRoot, "apply-helper-request.json");
  await fs.writeFile(patchPath, patch, "utf8");
  await fs.writeFile(compensationPath, rollback, "utf8");
  const port = 48_000 + Math.floor(Math.random() * 1_000);
  await fs.writeFile(serverPath, `
import http from "node:http";
import fs from "node:fs";
const port = Number(process.argv[2]);
const pidPath = process.argv[3];
const server = http.createServer((_request, response) => { response.writeHead(200); response.end("ok"); });
server.listen(port, "127.0.0.1", () => fs.writeFileSync(pidPath, String(process.pid)));
setTimeout(() => server.close(() => process.exit(0)), 45_000).unref();
`, "utf8");
  const request = {
    schemaVersion: 1,
    operation: "apply",
    planId: `plan-native-recovery-${label}`,
    manifestId: `manifest-native-recovery-${label}`,
    manifestSha256: "1".repeat(64),
    installId: "install-native-recovery",
    installRevision: 2,
    sourceRoot,
    expectedHead: baseSha,
    expectedTree: baseTree,
    patchPath,
    patchSha256: sha256(patch),
    compensationPath,
    compensationSha256: sha256(rollback),
    changedFiles: [{
      path: "apps/gateway/src/native-helper-fixture.ts",
      changeKind: "modified",
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
    }],
    approvalIds: ["approval-native-recovery"],
    parentPid: 2_000_000_000,
    parentStartedAtUnixMs: Date.now(),
    restart: {
      executable: process.execPath,
      args: [serverPath, String(port), pidPath],
      workingDirectory: sourceRoot,
      healthUrl: `http://127.0.0.1:${port}/health`,
      healthTimeoutMs: 5_000,
    },
    resultPath,
    journalPath,
    createdAt: new Date().toISOString(),
  };
  const requestBytes = `${JSON.stringify(request)}\n`;
  await fs.writeFile(requestPath, requestBytes, "utf8");
  return {
    root,
    sourceRoot,
    operationRoot,
    serverPath,
    pidPath,
    target,
    resultPath,
    journalPath,
    requestPath,
    requestSha256: sha256(requestBytes),
  };
}

function spawnHelper(requestPath, requestSha256) {
  const child = spawn(helperPath, ["--request", requestPath, "--request-sha256", requestSha256], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, exited };
}

async function waitForJournalEvent(journalPath, eventType, helper) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fs.readFile(journalPath, "utf8")).includes(`"eventType":"${eventType}"`)) return;
    } catch {}
    if (helper.child.exitCode !== null) {
      const exited = await helper.exited;
      let journal = "";
      try { journal = await fs.readFile(journalPath, "utf8"); } catch {}
      throw new Error(`Native helper exited before ${eventType}: ${JSON.stringify(exited)}\n${journal}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for native helper journal event ${eventType}.`);
}

async function stopProcess(pid) {
  try { process.kill(pid); } catch { return; }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function createSourceFixture(sourceRoot) {
  await fs.mkdir(path.join(sourceRoot, "apps", "gateway", "src"), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, "apps", "mission-control-next"), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "goatcitadel" }), "utf8");
  await fs.writeFile(path.join(sourceRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
  await fs.writeFile(path.join(sourceRoot, "apps", "gateway", "package.json"), JSON.stringify({ name: "@goatcitadel/gateway" }), "utf8");
  await fs.writeFile(path.join(sourceRoot, "apps", "mission-control-next", "package.json"), JSON.stringify({ name: "@goatcitadel/mission-control-next" }), "utf8");
  await fs.writeFile(path.join(sourceRoot, "docs", "1_0_CONTRACT.md"), "# Contract\n", "utf8");
  await fs.writeFile(path.join(sourceRoot, "apps", "gateway", "src", "native-helper-fixture.ts"), "export const nativeHelperFixture = 1;\n", "utf8");
  git(sourceRoot, ["init"]);
  git(sourceRoot, ["config", "user.name", "GoatCitadel Test"]);
  git(sourceRoot, ["config", "user.email", "goatcitadel@example.invalid"]);
  git(sourceRoot, ["config", "core.autocrlf", "false"]);
  git(sourceRoot, ["add", "."]);
  git(sourceRoot, ["commit", "-m", "baseline"]);
}

function runHelper(requestPath, requestSha256) {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, ["--request", requestPath, "--request-sha256", requestSha256], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Native helper exited by ${signal}: ${stderr}`));
      else resolve(code);
    });
  });
}

function git(root, args) {
  return gitRaw(root, args).trim();
}

function gitRaw(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
