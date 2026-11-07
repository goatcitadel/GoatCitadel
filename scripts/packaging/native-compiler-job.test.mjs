// Proposed scripts/packaging/native-compiler-job.test.mjs. Not executable until
// the independently reviewed helper exists. Fixtures are synthetic Node programs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runOwnedWindowsCompilerSync } from "./lib/native-compiler-job.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gc-job-fixture-")));
  const identity = fs.lstatSync(root);
  t.after(() => {
    const current = fs.lstatSync(root);
    assert(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    assert.equal(fs.realpathSync.native(root), root);
    fs.rmSync(root, { recursive: true });
  });
  return root;
}
function programs(root) {
  const ready = path.join(root, "owned-child-ready.json"),
    late = path.join(root, "owned-child-late.json");
  const child = path.join(root, "long-child.mjs"),
    compiler = path.join(root, "fake-compiler.mjs");
  fs.writeFileSync(
    child,
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid}), {flag:"wx"});\nsetTimeout(()=>fs.writeFileSync(${JSON.stringify(late)}, "late", {flag:"wx"}),1200);\nsetInterval(()=>{},500);\n`,
    { flag: "wx" },
  );
  fs.writeFileSync(
    compiler,
    `import fs from "node:fs";\nimport {spawn} from "node:child_process";\nconst child=spawn(process.execPath,[${JSON.stringify(child)}],{stdio:"inherit",windowsHide:true,detached:true});child.unref();\nconst until=Date.now()+3000;while(!fs.existsSync(${JSON.stringify(ready)})&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);\nif(!fs.existsSync(${JSON.stringify(ready)}))process.exit(91);\nprocess.stdout.write("compiler stdout\\n");process.stderr.write("compiler stderr\\n");\nif(process.argv[3]==="stall")setInterval(()=>{},500);else process.exit(Number(process.argv[2]));\n`,
    { flag: "wx" },
  );
  return { ready, late, compiler };
}

for (const code of [0, 7])
  test(
    `owned compiler preserves root ${code} and retires a long-lived descendant`,
    {
      skip: process.platform !== "win32",
      timeout: 20_000,
    },
    async (t) => {
      const root = fixture(t),
        files = programs(root);
      const originalSpawnSync = childProcess.spawnSync;
      const powerShell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
      const expectedCache = path.join(root, "powershell-module-analysis-cache");
      const cacheChecks = [];
      let result;
      try {
        // Capture only a boolean about each actual bootstrap environment. Delegate
        // unchanged launches; never retain argv, environment or user cache contents.
        childProcess.spawnSync = (command, args, options) => {
          if (command === powerShell) cacheChecks.push(options?.env?.PSModuleAnalysisCachePath === expectedCache);
          return originalSpawnSync(command, args, options);
        };
        syncBuiltinESMExports();
        result = runOwnedWindowsCompilerSync(process.execPath, [files.compiler, String(code)], {
          cwd: root,
          env: { SystemRoot: process.env.SystemRoot },
          timeout: 10_000,
          encoding: "utf8",
          windowsHide: true,
          scratch: root,
        });
      } finally {
        childProcess.spawnSync = originalSpawnSync;
        syncBuiltinESMExports();
      }
      assert.equal(childProcess.spawnSync, originalSpawnSync);
      assert.equal(spawnSync, originalSpawnSync);
      // The first case queries caller identity and runs the bridge; the second uses
      // its cached identity. Both paths must receive the confined cache destination.
      assert.equal(cacheChecks.length, code === 0 ? 2 : 1);
      assert(
        cacheChecks.every(Boolean),
        "Every PowerShell bootstrap must confine its module cache to verified scratch",
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, code);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "compiler stdout\n");
      assert.equal(result.stderr, "compiler stderr\n");
      assert(fs.existsSync(files.ready), "The descendant must actually start before root completion");
      assert.equal(result.ownership.rootExited, true);
      assert.equal(result.ownership.callerVerified, true);
      assert.equal(result.ownership.atomicMembership, true);
      assert.equal(result.ownership.rootExitCode, code);
      assert(result.ownership.descendantsRetired >= 1);
      assert.equal(result.ownership.jobEmpty, true);
      await wait(1500);
      assert.equal(fs.existsSync(files.late), false, "An owned descendant must not write after return");
    },
  );

test(
  "compiler deadline remains failed and leaves no descendant capable of late writes",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  async (t) => {
    const root = fixture(t),
      files = programs(root);
    // Give bootstrap and child readiness room, while the fake compiler stalls.
    // This fixture must use a child late-write delay beyond the execution deadline.
    fs.writeFileSync(
      path.join(root, "long-child.mjs"),
      fs.readFileSync(path.join(root, "long-child.mjs"), "utf8").replace("1200", "9000"),
    );
    const result = runOwnedWindowsCompilerSync(process.execPath, [files.compiler, "0", "stall"], {
      cwd: root,
      env: { SystemRoot: process.env.SystemRoot },
      timeout: 5000,
      encoding: "utf8",
      windowsHide: true,
      scratch: root,
    });
    assert(fs.existsSync(files.ready));
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.equal(result.ownership.deadline, true);
    assert.equal(result.ownership.jobEmpty, true);
    assert.notEqual(result.status, 0);
    await wait(Math.max(0, fs.statSync(files.ready).mtimeMs + 9200 - Date.now()));
    assert.equal(fs.existsSync(files.late), false);
  },
);

test(
  "compiler cleanup does not terminate an unrelated test-owned sibling",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  async (t) => {
    const root = fixture(t),
      files = programs(root);
    const sibling = spawn(process.execPath, ["-e", "setInterval(()=>{},500)"], { stdio: "ignore", windowsHide: true });
    assert(sibling.pid);
    let siblingExited = false;
    sibling.once("exit", () => {
      siblingExited = true;
    });
    t.after(async () => {
      if (sibling.exitCode === null && sibling.signalCode === null) {
        const ended = new Promise((resolve) => sibling.once("exit", resolve));
        sibling.kill(); // Only this exact ChildProcess handle, created by this test.
        await ended;
      }
    });
    const result = runOwnedWindowsCompilerSync(process.execPath, [files.compiler, "0"], {
      cwd: root,
      env: { SystemRoot: process.env.SystemRoot },
      timeout: 10_000,
      encoding: "utf8",
      windowsHide: true,
      scratch: root,
    });
    assert.equal(result.status, 0);
    assert.equal(result.ownership.jobEmpty, true);
    await wait(100);
    assert.equal(siblingExited, false);
    assert.equal(sibling.exitCode, null);
    assert.equal(sibling.signalCode, null);
  },
);

test(
  "owned compiler preserves Windows argument quoting and explicit environment",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  (t) => {
    const root = fixture(t),
      script = path.join(root, "quoted fixture.mjs");
    fs.writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({args:process.argv.slice(2),fixture:process.env.GC_COMPILER_FIXTURE,missing:process.env.GC_UNRELATED_FIXTURE===undefined}));\n",
      { flag: "wx" },
    );
    const args = ["", "two words", 'embedded"quote', "trailing\\", "two\\\\slashes", "日本語", "%NAME% & | $(literal)"];
    const previous = process.env.GC_UNRELATED_FIXTURE;
    process.env.GC_UNRELATED_FIXTURE = "must-not-enter-compiler";
    try {
      const result = runOwnedWindowsCompilerSync(process.execPath, [script, ...args], {
        cwd: root,
        env: { SystemRoot: process.env.SystemRoot, GC_COMPILER_FIXTURE: "synthetic-value" },
        timeout: 10_000,
        encoding: "utf8",
        windowsHide: true,
        scratch: root,
      });
      assert.equal(result.status, 0);
      assert.equal(result.ownership.jobEmpty, true);
      assert.deepEqual(JSON.parse(result.stdout), { args, fixture: "synthetic-value", missing: true });
    } finally {
      if (previous === undefined) delete process.env.GC_UNRELATED_FIXTURE;
      else process.env.GC_UNRELATED_FIXTURE = previous;
    }
  },
);

test(
  "owned compiler startup failure stays failed and leaves an empty Job",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  (t) => {
    const root = fixture(t);
    const result = runOwnedWindowsCompilerSync(path.join(root, "missing-compiler.exe"), [], {
      cwd: root,
      env: { SystemRoot: process.env.SystemRoot },
      timeout: 10_000,
      encoding: "utf8",
      windowsHide: true,
      scratch: root,
    });
    assert.equal(result.error?.code, "ENOENT");
    assert.notEqual(result.status, 0);
    assert.equal(result.ownership.jobEmpty, true);
  },
);

test(
  "owned compiler output overflow is bounded and remains failed",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  (t) => {
    const root = fixture(t),
      script = path.join(root, "overflow.mjs");
    fs.writeFileSync(script, 'process.stdout.write("x".repeat(100000));setInterval(()=>{},500);\n', { flag: "wx" });
    const result = runOwnedWindowsCompilerSync(process.execPath, [script], {
      cwd: root,
      env: { SystemRoot: process.env.SystemRoot },
      timeout: 10_000,
      maxBuffer: 1024,
      encoding: "utf8",
      windowsHide: true,
      scratch: root,
    });
    assert.equal(result.error?.code, "ENOBUFS");
    assert.notEqual(result.status, 0);
    assert(Buffer.byteLength(result.stdout) <= 1024);
    assert.equal(result.ownership.jobEmpty, true);
  },
);

test(
  "actual caller death closes ownership Jobs and retires compiler descendants",
  {
    skip: process.platform !== "win32",
    timeout: 25_000,
  },
  async (t) => {
    const root = fixture(t),
      files = programs(root);
    const helper = pathToFileURL(path.join(import.meta.dirname, "lib/native-compiler-job.mjs")).href;
    const source = `import {runOwnedWindowsCompilerSync} from ${JSON.stringify(helper)};runOwnedWindowsCompilerSync(process.execPath,${JSON.stringify([files.compiler, "0", "stall"])},${JSON.stringify({ cwd: root, env: { SystemRoot: process.env.SystemRoot }, timeout: 15000, encoding: "utf8", windowsHide: true, scratch: root })});`;
    const caller = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: "ignore",
      windowsHide: true,
    });
    t.after(async () => {
      if (caller.exitCode === null && caller.signalCode === null) {
        const ended = new Promise((resolve) => caller.once("exit", resolve));
        caller.kill();
        await ended;
      }
    });
    const readyBy = Date.now() + 15000;
    while (!fs.existsSync(files.ready) && Date.now() < readyBy) await wait(25);
    assert(fs.existsSync(files.ready), "Kill the caller only after compiler child execution is proven");
    const { pid: ownedPid } = JSON.parse(fs.readFileSync(files.ready, "utf8"));
    assert(Number.isSafeInteger(ownedPid) && ownedPid > 4 && ownedPid !== process.pid && ownedPid !== caller.pid);
    const ended = new Promise((resolve) => caller.once("exit", resolve));
    caller.kill(); // The exact test-created caller, never a global PID or name.
    await ended;
    // The non-detached PowerShell owner may itself be killed by the caller's
    // libuv Job. Closing its compiler Job then retires descendants. A killed
    // owner cannot promise a receipt; query only the already-proven owned PID.
    let retired = false;
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      try {
        process.kill(ownedPid, 0);
      } catch (error) {
        assert.equal(error.code, "ESRCH");
        retired = true;
        break;
      }
      await wait(25);
    }
    assert.equal(retired, true, "The exact compiler descendant must actually retire");
    const receiptName = fs
      .readdirSync(root)
      .find((name) => name.startsWith("native-compiler-result-") && name.endsWith(".json"));
    if (receiptName) {
      const receipt = JSON.parse(fs.readFileSync(path.join(root, receiptName), "utf8"));
      assert.equal(receipt.ParentExited, true);
      assert.equal(receipt.CallerVerified, true);
      assert.equal(receipt.JobEmpty, true);
    }
    await wait(1500);
    assert.equal(fs.existsSync(files.late), false);
  },
);

test(
  "a mismatched caller creation identity prevents compiler dispatch",
  {
    skip: process.platform !== "win32",
    timeout: 10_000,
  },
  (t) => {
    const root = fixture(t),
      files = programs(root);
    const requestPath = path.join(root, "invalid-caller-request.json");
    const resultPath = path.join(root, "native-compiler-result-" + process.pid + "-0000000000000000.json");
    const source = path.join(import.meta.dirname, "lib/NativeCompilerJob.cs");
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        command: process.execPath,
        arguments: [files.compiler, "0"],
        cwd: root,
        environment: { SystemRoot: process.env.SystemRoot },
        resultPath,
        callerPid: process.pid,
        callerCreation: "1",
        callerImage: process.execPath,
        deadlineUnixMs: Date.now() + 5000,
        maxBuffer: 1024,
        sourceSha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
      }),
      { flag: "wx" },
    );
    const powerShell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const result = spawnSync(
      powerShell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(import.meta.dirname, "lib/native-compiler-job.ps1"),
        "-RequestPath",
        requestPath,
      ],
      {
        env: { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root },
        windowsHide: true,
        timeout: 5000,
        encoding: "utf8",
        maxBuffer: 65536,
      },
    );
    assert.equal(result.status, 1);
    const receipt = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.equal(receipt.ErrorCode, "ECOMPILERBOOTSTRAP");
    assert.equal(receipt.RootExited, false);
    assert.equal(receipt.CallerVerified, false);
    assert.equal(fs.existsSync(files.ready), false);
  },
);

test(
  "owned compiler bridge overrides inherited process Restricted without changing persistent policy",
  { skip: process.platform !== "win32", timeout: 20_000, concurrency: false },
  (t) => {
    const root = fixture(t);
    const compiler = path.join(root, "policy-compiler.mjs");
    fs.writeFileSync(compiler, 'process.stdout.write("policy-compiler-ran\\n");\n', { flag: "wx" });
    const powerShell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const bridge = path.join(import.meta.dirname, "lib/native-compiler-job.ps1");
    const originalSpawnSync = childProcess.spawnSync;
    const parentPolicy = process.env.PSExecutionPolicyPreference;
    let intercepted = 0;
    let result;
    try {
      childProcess.spawnSync = (command, args, options) => {
        const fileIndex = Array.isArray(args) ? args.indexOf("-File") : -1;
        if (command === powerShell && fileIndex >= 0 && args[fileIndex + 1] === bridge) {
          intercepted++;
          // Assert the real closed environment before adding this test-only trigger.
          assert.deepEqual(Object.keys(options.env).sort(), ["PSModuleAnalysisCachePath", "SystemRoot", "TEMP", "TMP"]);
          assert.equal(options.env.PSModuleAnalysisCachePath, path.join(root, "powershell-module-analysis-cache"));
          assert.equal(options.windowsHide, true);
          return originalSpawnSync(command, args, {
            ...options,
            env: { ...options.env, PSExecutionPolicyPreference: "Restricted" },
          });
        }
        // The actual caller-identity query and every other launch are unchanged.
        return originalSpawnSync(command, args, options);
      };
      syncBuiltinESMExports();
      result = runOwnedWindowsCompilerSync(process.execPath, [compiler], {
        cwd: root, env: { SystemRoot: process.env.SystemRoot }, timeout: 10_000,
        encoding: "utf8", windowsHide: true, scratch: root,
      });
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
    }
    assert.equal(intercepted, 1, "The actual bridge -File spawn must be exercised exactly once");
    assert.equal(childProcess.spawnSync, originalSpawnSync);
    assert.equal(spawnSync, originalSpawnSync);
    assert.equal(process.env.PSExecutionPolicyPreference, parentPolicy);
    assert.equal(result.error, undefined, "The checked local bridge must run despite process-only Restricted injection");
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "policy-compiler-ran\n");
    assert.equal(result.ownership.callerVerified, true);
    assert.equal(result.ownership.atomicMembership, true);
    assert.equal(result.ownership.rootExited, true);
    assert.equal(result.ownership.rootExitCode, 0);
    assert.equal(result.ownership.jobEmpty, true);
  },
);
