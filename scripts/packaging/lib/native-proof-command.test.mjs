import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { inspectProcessBindingWithRetry, queryProcessCreationIdentity } from "../../lib/managed-runtime-lifecycle.mjs";
import { GATEWAY_PROOF_DEADLINE_MS, nativeProvisioningBridgeBudget, runBoundedNativeProofCommand } from "./native-proof-command.mjs";

test("the bridge aggregate accounts for the real 48-source batches, 18 tests and one per-test hook", () => {
  const budget = nativeProvisioningBridgeBudget(48);
  assert.equal(GATEWAY_PROOF_DEADLINE_MS, 600_000);
  assert.equal(budget.fullClosureCompilerCalls, 7); assert.equal(budget.compilerCalls, 19);
  assert.equal(budget.parentFixtureCalls, 11); assert.equal(budget.rawCalls, 66);
  assert.equal(budget.totalMs, 2_954_000);
  assert.throws(() => nativeProvisioningBridgeBudget(0));
});

async function fixture(t) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, "goat-proof-command-"));
  const exact = fs.realpathSync.native(directory);
  assert.equal(path.dirname(exact), parent); assert.equal(path.resolve(directory), exact);
  let cleanupVerified = false;
  t.after(() => {
    assert.equal(cleanupVerified, true, "Retain fixture evidence while owned process closure is unconfirmed.");
    assert.equal(fs.realpathSync.native(directory), exact);
    assert.equal(path.dirname(exact), parent); assert.ok(path.basename(exact).startsWith("goat-proof-command-"));
    const status = fs.lstatSync(exact); assert.ok(status.isDirectory() && !status.isSymbolicLink());
    fs.rmSync(exact, { recursive: true, force: false });
  });
  return { directory, permitCleanup: () => { cleanupVerified = true; } };
}

async function exactClosed(identity, pid) {
  const deadline = Date.now() + 10_000;
  do {
    const current = queryProcessCreationIdentity(pid);
    if (current.status === "missing" || (current.status === "running" && current.identity !== identity)) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  } while (Date.now() < deadline);
  return false;
}

for (const outcome of ["complete", "deadline"]) test(`real owned root and grandchild close after ${outcome}`, { timeout: 90_000 }, async (t) => {
  const allocation = await fixture(t), { directory } = allocation;
  const pidPath = path.join(directory, "grandchild.json"), finishPath = path.join(directory, "finish");
  const leaf = `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0)},50)`;
  const root = `const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)},process.argv[2]],{windowsHide:true,stdio:['ignore','inherit','inherit']});fs.writeFileSync(process.argv[1],JSON.stringify({pid:child.pid,rootPid:process.pid}),{flag:'wx'});console.log('root-ready');child.on('exit',()=>process.exit(0));setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const running = runBoundedNativeProofCommand({ executablePath: process.execPath, args: ["-e", root, pidPath, finishPath],
    cwd: directory, environment: process.env, outputDirectory: directory, signal: controller.signal, deadlineMs: 30_000 });
  // Immediately observe the pending rejection without changing the command's result.
  const observed = running.then(receipt => ({ receipt }), error => ({ error, receipt: error.receipt }));
  let ownedPid, ownedIdentity;
  try {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(pidPath)) { assert.ok(Date.now() < deadline, "The exact owned fixture never published its child PID."); await delay(50); }
    ownedPid = JSON.parse(fs.readFileSync(pidPath, "utf8")).pid;
    assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 0);
    const identity = queryProcessCreationIdentity(ownedPid); assert.equal(identity.status, "running"); ownedIdentity = identity.identity;
    // This PID came only from our fixed fixture program, not from Gateway or product output.
    const rootPid = JSON.parse(fs.readFileSync(pidPath, "utf8")).rootPid;
    assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0); assert.equal((await inspectProcessBindingWithRetry({ rootPid, servingPid: ownedPid })).status, "verified");
    if (outcome === "complete") fs.writeFileSync(finishPath, "finish", { flag: "wx" });
    // The deadline case reaches the helper's actual timer with both known processes still alive.
    const result = await observed;
    if (outcome === "complete") { assert.equal(result.error, undefined); assert.equal(result.receipt.result.exitCode, 0); }
    else { assert.ok(result.error); assert.equal(result.receipt.result.stopReason, "deadline"); }
    assert.equal(result.receipt.rootClosure.status, "verified_original_root_absent");
    assert.equal(result.receipt.result.cleanupUnconfirmed, false);
    assert.equal(result.receipt.result.descendantsStopped, "not_verified");
    assert.equal(await exactClosed(ownedIdentity, ownedPid), true, "The observed fixture grandchild remained alive.");
    assert.match(fs.readFileSync(path.join(directory, "gateway-tests.log"), "utf8"), /root-ready/u);
  } finally {
    controller.abort("supervisor_close"); const final = await observed;
    if (ownedPid && ownedIdentity) {
      const current = queryProcessCreationIdentity(ownedPid);
      if (current.status === "running" && current.identity === ownedIdentity) process.kill(ownedPid, "SIGKILL");
      assert.equal(await exactClosed(ownedIdentity, ownedPid), true);
      if (final.receipt?.rootClosure.status === "verified_original_root_absent") allocation.permitCleanup();
    }
  }
});
