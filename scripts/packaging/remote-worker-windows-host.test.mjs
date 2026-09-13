import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { buildWindowsWorkerHost, WORKER_HOST_IMAGE } from "./build-remote-worker-windows-host.mjs";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { renderWorkerWindowsLauncher } from "./lib/remote-worker-windows-launcher.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const worker = `import fs from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
const mode=process.env.GOATCITADEL_CONNECTED_WORKER_RUN_ID;
const report=process.env.GOATCITADEL_CONNECTED_WORKER_REPORT_FILE;
const ready=(extra={})=>fs.writeFileSync(report,JSON.stringify({pid:process.pid,parent:process.ppid,mode,nodeOptions:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,other:process.env.HOST_TEST_PRIVATE_VALUE??null,control:process.env.GOATCITADEL_CONNECTED_WORKER_HOST_CONTROL,registryFile:process.env.GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_FILE??null,registrySha256:process.env.GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_SHA256??null,...extra}));
// Every fixture self-expires even if the production lifecycle has a regression.
const watchdog=setTimeout(()=>process.exit(99),25000);
if(mode==='exit'){ready();process.exit(7)}
if(mode==='nested'){const probe=spawnSync(process.cwd()+'/bin/job-probe.exe',['--retain-breakaway'],{encoding:'utf8',windowsHide:true});ready({probe:JSON.parse(probe.stdout)});}
let child;
if(mode==='tree'||mode==='orphan'){
  const grandcode='setTimeout(()=>process.exit(99),25000)';
  const childcode='const fs=require("node:fs");const {spawn}=require("node:child_process");const grand=spawn(process.execPath,["-e",'+JSON.stringify(grandcode)+'],{stdio:"ignore",detached:true,windowsHide:true});fs.writeFileSync('+JSON.stringify(report+'.descendants')+',JSON.stringify({child:process.pid,grandchild:grand.pid}));setTimeout(()=>process.exit(99),25000)';
  child=spawn(process.execPath,['-e',childcode],{stdio:'ignore',detached:true,windowsHide:true});
  while(!fs.existsSync(report+'.descendants')) await new Promise(r=>setTimeout(r,10));
  ready(JSON.parse(fs.readFileSync(report+'.descendants','utf8')));
  if(mode==='orphan')process.exit(0);
}else if(mode!=='nested') ready();
if(mode!=='ignore'){
 process.stdin.on('end',()=>{clearTimeout(watchdog);process.stdin.pause();fs.writeFileSync(report+'.stopped','graceful');});
 process.stdin.resume();
}
`;

async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail("Timed out waiting for the task-owned fixture process.");
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test(
  "native worker host owns child lifetime and excludes ambient launch inputs",
  {
    skip: process.platform !== "win32",
    timeout: 120000,
  },
  async (t) => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Host "));
    t.diagnostic(`Retained native worker host evidence: ${output}`);
    const input = {
      target: "windows-x64",
      nodeSha256: sha(fs.readFileSync(process.execPath)),
      entrypointSha256: sha(worker),
    };
    const first = buildWindowsWorkerHost({ ...input, outputDirectory: path.join(output, "build-first") });
    const second = buildWindowsWorkerHost({ ...input, outputDirectory: path.join(output, "build-second") });
    assert.equal(first.receipt.artifact.sha256, second.receipt.artifact.sha256);
    const armFirst = buildWindowsWorkerHost({
      ...input,
      target: "windows-arm64",
      outputDirectory: path.join(output, "arm64-first"),
    });
    const armSecond = buildWindowsWorkerHost({
      ...input,
      target: "windows-arm64",
      outputDirectory: path.join(output, "arm64-second"),
    });
    assert.equal(armFirst.receipt.artifact.sha256, armSecond.receipt.artifact.sha256);
    const tools = resolveExactWindowsToolchain("windows-x64");
    const testBuild = path.join(output, "test-build");
    fs.mkdirSync(testBuild);
    const probe = compileTlsNative({
      target: "windows-x64",
      outputDirectory: testBuild,
      outputName: "job-probe.exe",
      sources: [path.resolve(import.meta.dirname, "../../apps/remote-worker-windows-host-native/tests/job_probe.cpp")],
    });
    const asan = compileTlsNative({
      target: "windows-x64",
      outputDirectory: testBuild,
      outputName: WORKER_HOST_IMAGE,
      asan: true,
      sources: ["main.cpp", "worker_host.cpp", "service_identity.cpp", "installed_worker_files.cpp"].map((name) =>
        path.join(output, "build-first/source", name),
      ),
      includes: [path.join(output, "build-first/source")],
    });
    const directProbeHost = buildWindowsWorkerHost({
      ...input,
      nodeSha256: sha(fs.readFileSync(probe)),
      outputDirectory: path.join(output, "probe-host"),
    });
    const outcomes = [];
    const fixture = (mode) => {
      const root = fs.mkdtempSync(path.join(output, `${mode}-`));
      for (const directory of ["bin", "app/runtime", "app/worker/dist"])
        fs.mkdirSync(path.join(root, directory), { recursive: true });
      const executable = path.join(root, "bin", WORKER_HOST_IMAGE);
      fs.copyFileSync(first.executable, executable);
      fs.copyFileSync(probe, path.join(root, "bin/job-probe.exe"));
      fs.writeFileSync(path.join(root, "bin/worker.ps1"), renderWorkerWindowsLauncher(), { flag: "wx" });
      fs.copyFileSync(process.execPath, path.join(root, "app/runtime/node.exe"));
      fs.writeFileSync(path.join(root, "app/worker/dist/main.js"), worker, { flag: "wx" });
      fs.writeFileSync(path.join(root, "app/worker/package.json"), '{"type":"module"}', { flag: "wx" });
      const report = path.join(output, `${path.basename(root)}.json`);
      const env = {
        SystemRoot: process.env.SystemRoot,
        GOATCITADEL_CONNECTED_WORKER_PROTECTED_KEY_FILE: path.join(output, "public-reference-unused-by-fixture.json"),
        GOATCITADEL_CONNECTED_WORKER_RUN_ID: mode,
        GOATCITADEL_CONNECTED_WORKER_REPORT_FILE: report,
        NODE_OPTIONS: "--invalid-host-fixture-option",
        NODE_PATH: "untrusted-preload-root",
        HOST_TEST_PRIVATE_VALUE: "fixture-only",
      };
      return { root, executable, report, env };
    };
    const run = (files, args = ["--foreground"], command = files.executable) => {
      const child = spawn(command, args, {
        env: files.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
        assert.ok(stdout.length < 4096);
      });
      child.stderr.on("data", (data) => {
        stderr += data;
        assert.ok(stderr.length < 4096);
      });
      const closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
      });
      return { child, closed };
    };
    await t.test("preserves the worker exit code and clears unlisted environment", async () => {
      const files = fixture("exit");
      files.env.GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_FILE = path.join(output, "operator-registry.json");
      files.env.GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_SHA256 = "a".repeat(64);
      const { child, closed } = run(files);
      try {
        const result = await closed;
        assert.equal(result.code, 7, result.stdout + result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          error: 0,
          childExitCode: 7,
          stopRequested: false,
          forced: false,
          jobEmpty: true,
        });
        const report = JSON.parse(fs.readFileSync(files.report));
        for (const key of ["nodeOptions", "nodePath", "other"]) assert.equal(report[key], null);
        assert.equal(report.control, "stdin-close-v1");
        assert.equal(report.registryFile, files.env.GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_FILE);
        assert.equal(report.registrySha256, files.env.GOATCITADEL_CONNECTED_WORKER_MESH_REGISTRY_SHA256);
        outcomes.push({ case: "exit-and-environment", passed: true });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
    await t.test("kernel limits are active and explicit process breakaway is denied", async () => {
      const files = fixture("exit");
      fs.copyFileSync(probe, path.join(files.root, "app/runtime/node.exe"));
      fs.copyFileSync(directProbeHost.executable, files.executable);
      const { child, closed } = run(files);
      try {
        const result = await closed;
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(files.report)), {
          processLimit: 64,
          memoryLimit: 4 * 1024 ** 3,
          killOnClose: true,
          breakawayAllowed: false,
          escapeError: 5,
          breakawayPid: 0,
        });
        outcomes.push({ case: "kernel-limits-and-breakaway", passed: true });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
    await t.test("leaving Node's nested job cannot escape the native host lifetime", async () => {
      const files = fixture("nested");
      const { child, closed } = run(files);
      try {
        await until(() => fs.existsSync(files.report));
        const report = JSON.parse(fs.readFileSync(files.report));
        assert.equal(report.probe.escapeError, 0);
        assert.ok(report.probe.breakawayPid > 0 && alive(report.probe.breakawayPid));
        assert.ok(child.kill());
        await closed;
        await until(() => !alive(report.probe.breakawayPid), 5000);
        outcomes.push({ case: "nested-job-breakaway-retained", passed: true });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
    await t.test("AddressSanitizer executes the same host lifecycle", async () => {
      const files = fixture("exit");
      fs.copyFileSync(asan, files.executable);
      files.env.PATH = path.dirname(tools.compilerPath);
      const { child, closed } = run(files);
      try {
        const result = await closed;
        assert.equal(result.code, 7, result.stdout + result.stderr);
        assert.equal(result.stderr, "");
        assert.equal(JSON.parse(result.stdout).jobEmpty, true);
        outcomes.push({ case: "address-sanitizer", passed: true });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
    await t.test("service dispatcher refuses a non-SCM invocation", async () => {
      const files = fixture("exit");
      const result = spawnSync(files.executable, [], { env: files.env, timeout: 10000, windowsHide: true });
      assert.equal(result.status, 1063);
      assert.equal(fs.existsSync(files.report), false);
      outcomes.push({ case: "scm-only-dispatch", passed: true });
    });
    await t.test("EOF requests graceful shutdown while executable paths remain pinned", async () => {
      const files = fixture("graceful");
      const { child, closed } = run(files);
      try {
        await until(() => fs.existsSync(files.report));
        assert.throws(() => fs.appendFileSync(path.join(files.root, "app/worker/dist/main.js"), "changed"));
        assert.throws(() => fs.renameSync(path.join(files.root, "app/runtime"), path.join(files.root, "app/replaced")));
        child.stdin.end();
        const result = await closed;
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.equal(fs.readFileSync(files.report + ".stopped", "utf8"), "graceful");
        assert.deepEqual(JSON.parse(result.stdout), {
          error: 0,
          childExitCode: 0,
          stopRequested: true,
          forced: false,
          jobEmpty: true,
        });
        // Leases release only after process cleanup.
        fs.renameSync(path.join(files.root, "app/runtime"), path.join(files.root, "app/released"));
        outcomes.push({ case: "graceful-stop-and-path-leases", passed: true });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
    await t.test("forced owner death terminates the detached child and grandchild", async () => {
      const files = fixture("tree");
      const { child, closed } = run(files);
      try {
        await until(() => fs.existsSync(files.report));
        const report = JSON.parse(fs.readFileSync(files.report));
        const pids = [report.pid, report.child, report.grandchild];
        assert.ok(pids.every(alive));
        assert.ok(child.kill());
        await closed;
        await until(() => pids.every((pid) => !alive(pid)), 5000);
        outcomes.push({ case: "forced-host-death", passed: true, observedPids: pids });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
    await t.test("unresponsive worker is terminated after the bounded grace period", async () => {
      const files = fixture("ignore");
      const { child, closed } = run(files);
      try {
        await until(() => fs.existsSync(files.report));
        const started = Date.now();
        child.stdin.end();
        const result = await closed;
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 9900 && elapsed < 17000, `elapsed=${elapsed}`);
        assert.equal(result.code, 1460, result.stdout + result.stderr);
        assert.equal(JSON.parse(result.stdout).jobEmpty, true);
        assert.equal(JSON.parse(result.stdout).forced, true);
        outcomes.push({ case: "bounded-forced-stop", passed: true, elapsed });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
    await t.test("worker exit cannot leave descendants running or report clean success", async () => {
      const files = fixture("orphan");
      const { child, closed } = run(files);
      try {
        const result = await closed;
        assert.equal(result.code, 1067, result.stdout + result.stderr);
        const report = JSON.parse(fs.readFileSync(files.report));
        assert.equal(JSON.parse(result.stdout).jobEmpty, true);
        await until(() => !alive(report.child) && !alive(report.grandchild));
        outcomes.push({ case: "orphan-cleanup", passed: true });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
    for (const mode of [
      "entrypoint-drift",
      "node-hardlink",
      "junction",
      "unknown-setting",
      "pem",
      "host-control",
      "operands",
    ]) {
      await t.test(`refuses ${mode} before worker execution`, async () => {
        const files = fixture("exit");
        let args = ["--foreground"];
        if (mode === "entrypoint-drift")
          fs.appendFileSync(path.join(files.root, "app/worker/dist/main.js"), "// drift");
        if (mode === "node-hardlink")
          fs.linkSync(path.join(files.root, "app/runtime/node.exe"), path.join(output, "node-alias.exe"));
        if (mode === "junction") {
          fs.renameSync(path.join(files.root, "app/runtime"), path.join(files.root, "app/aliased-runtime"));
          fs.symlinkSync(
            path.join(files.root, "app/aliased-runtime"),
            path.join(files.root, "app/runtime"),
            "junction",
          );
        }
        if (mode === "unknown-setting") files.env.GOATCITADEL_CONNECTED_WORKER_UNKNOWN = "refused";
        if (mode === "pem") files.env.GOATCITADEL_CONNECTED_WORKER_CLIENT_KEY_FILE = "refused";
        if (mode === "host-control") files.env.GOATCITADEL_CONNECTED_WORKER_HOST_CONTROL = "stdin-close-v1";
        if (mode === "operands") args.push("--arbitrary-command");
        const result = spawnSync(files.executable, args, {
          env: files.env,
          windowsHide: true,
          timeout: 10000,
          encoding: "utf8",
        });
        assert.notEqual(result.status, 0);
        assert.equal(result.error, undefined);
        assert.equal(fs.existsSync(files.report), false);
        outcomes.push({ case: mode, passed: true });
      });
    }
    await t.test("forced PowerShell launcher death closes native-host control and the process tree", async () => {
      const files = fixture("tree");
      const { child, closed } = run(
        files,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(files.root, "bin/worker.ps1"),
        ],
        path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      );
      try {
        await until(() => fs.existsSync(files.report));
        const report = JSON.parse(fs.readFileSync(files.report));
        const pids = [report.parent, report.pid, report.child, report.grandchild];
        assert.ok(pids.every(alive));
        assert.ok(child.kill());
        await closed;
        await until(() => pids.every((pid) => !alive(pid)), 16000);
        assert.equal(fs.readFileSync(files.report + ".stopped", "utf8"), "graceful");
        outcomes.push({ case: "forced-powershell-parent-death", passed: true, observedPids: pids });
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
    assert.equal(outcomes.length, 17);
    fs.writeFileSync(
      path.join(output, "acceptance.json"),
      JSON.stringify(
        {
          target: "windows-x64",
          outcomes,
          reproducible: true,
          receipt: first.receipt,
          arm64: { reproducible: true, executed: false, receipt: armFirst.receipt },
          boundary:
            "Real foreground Windows process lifetime; SCM installation, caller identity and protected custody unproven.",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  },
);
