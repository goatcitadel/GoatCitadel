// RELIABILITY: a timed-out shell child leaves no orphaned descendant process.
//
// Uses the SHIPPED tree killer (apps/gateway/dist/services/process-tree-killer.js,
// terminateProcessTree) the gateway uses to enforce code-mode/shell timeouts.
// We spawn a parent node process that itself spawns a long-sleeping grandchild and
// prints the grandchild PID; on "timeout" we terminate the tree and assert the
// grandchild PID is dead. An orphan = the grandchild still alive after kill.

import { spawn } from "node:child_process";
import { pass, fail, skip } from "../lib/harness.mjs";
import { importGoatCitadel } from "../lib/goatcitadel-modules.mjs";

function isAlive(pid) {
  if (typeof pid !== "number" || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // exists but not signalable
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parent program: spawn a detached, long-lived grandchild, print its pid, then idle.
const PARENT_SOURCE = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
process.stdout.write("GRANDCHILD_PID=" + grandchild.pid + "\\n");
setTimeout(() => {}, 120000);
`;

export default {
  id: "reliability.no-orphan-on-timeout",
  axis: "RELIABILITY",
  title: "Timed-out shell child leaves no orphan",
  description:
    "Spawn a child that spawns a grandchild, then enforce a timeout via the gateway's terminateProcessTree. " +
    "After termination the grandchild process is gone — no orphaned descendant survives the kill.",
  requiresEdges: [],
  mode: "in-process",

  async run(target) {
    if (target.kind === "competitor") {
      return skip(`${target.id} process lifecycle is not externally observable here`);
    }
    if (!target.distReady) {
      return skip(target.skipReason ?? "goatcitadel dist not built");
    }

    const { terminateProcessTree } = await importGoatCitadel("gateway/process-tree-killer");

    const child = spawn(process.execPath, ["-e", PARENT_SOURCE], { stdio: ["ignore", "pipe", "ignore"] });
    let grandchildPid;
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const match = buffered.match(/GRANDCHILD_PID=(\d+)/);
      if (match) grandchildPid = Number(match[1]);
    });

    // Wait until the grandchild PID is reported (simulated work begins), with a cap.
    const deadline = Date.now() + 8000;
    while (grandchildPid === undefined && Date.now() < deadline && child.exitCode === null) {
      await delay(100);
    }
    if (grandchildPid === undefined) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      return fail("grandchild PID was never reported; could not set up the orphan probe");
    }

    if (!isAlive(grandchildPid)) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      return fail(`grandchild ${grandchildPid} died before the timeout fired; probe is inconclusive`);
    }

    // Enforce the "timeout": terminate the whole tree the way the gateway does.
    terminateProcessTree({ child, label: "benchmark-timeout", graceMs: 500 });

    // Give the OS a moment to reap the tree.
    const killDeadline = Date.now() + 6000;
    while ((isAlive(grandchildPid) || child.exitCode === null) && Date.now() < killDeadline) {
      await delay(150);
    }

    const orphanAlive = isAlive(grandchildPid);
    if (orphanAlive) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // best-effort cleanup so the benchmark never leaks a process
      }
      return fail(`grandchild ${grandchildPid} survived tree termination — orphan leaked`);
    }

    return pass(`grandchild ${grandchildPid} terminated with the tree; parent exit=${child.exitCode}; no orphan left`, {
      grandchildPid,
      parentExitCode: child.exitCode,
    });
  },
};
