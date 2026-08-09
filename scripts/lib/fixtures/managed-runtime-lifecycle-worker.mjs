import fs from "node:fs";
import path from "node:path";

import {
  atomicCompareAndPublishJson,
  atomicCompareAndRemove,
  readManagedStateFile,
  withManagedLifecycleLock,
} from "../managed-runtime-lifecycle.mjs";

const [mode, fixtureRoot, holdValue = "0"] = process.argv.slice(2);
const holdMs = Number(holdValue);
if (!new Set(["launch", "stop", "hold"]).has(mode) || !fixtureRoot || !Number.isFinite(holdMs)) {
  throw new Error("Usage: managed-runtime-lifecycle-worker.mjs <launch|stop|hold> <fixture-root> [hold-ms]");
}

const lockPath = path.join(fixtureRoot, "gateway.lifecycle.lock");
const metadataPath = path.join(fixtureRoot, "gateway.pid");
const eventsPath = path.join(fixtureRoot, "events.ndjson");

await withManagedLifecycleLock(
  {
    lockPath,
    service: "gateway-fixture",
    timeoutMs: 15_000,
    staleHeartbeatMs: 500,
  },
  async () => {
    record("enter");
    if (mode === "launch") {
      const current = readManagedStateFile(metadataPath);
      if (!current.exists) {
        const publish = atomicCompareAndPublishJson({
          filePath: metadataPath,
          expectedFingerprint: current.fingerprint,
          value: { launchedBy: process.pid },
        });
        if (!publish.published) {
          throw new Error(`Launch fixture compare failed: ${publish.reason}`);
        }
        record("spawn");
      } else {
        record("attach");
      }
    }
    if (holdMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, holdMs));
    }
    if (mode === "stop") {
      const current = readManagedStateFile(metadataPath);
      const remove = atomicCompareAndRemove({
        filePath: metadataPath,
        expectedFingerprint: current.fingerprint,
      });
      if (!remove.removed) {
        throw new Error(`Stop fixture compare failed: ${remove.reason}`);
      }
      record("remove");
    }
    record("exit");
  },
);

function record(phase) {
  fs.appendFileSync(eventsPath, `${JSON.stringify({ mode, phase, pid: process.pid, at: Date.now() })}\n`, "utf8");
}
