import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { workerLocalStateActivity } from "./worker-local-state-activity.js";

interface NativeWriterGate {
  startStateWriterGate(): boolean;
  pauseStateWriterGate(): boolean;
  resumeStateWriterGate(): boolean;
}

/** Fixed installed addon only. The native owner derives protected custody from
 * its pinned package; no registry, environment or model path selects the guard. */
export function startWindowsWorkerStateWriterGate(): void {
  if (process.platform !== "win32") throw new Error("Installed writer custody requires Windows.");
  const native = createRequire(import.meta.url)(fileURLToPath(new URL("../native/GoatCitadelRemoteWorkerImageGuard.node", import.meta.url))) as NativeWriterGate;
  const { startStateWriterGate: start, pauseStateWriterGate: pause, resumeStateWriterGate: resume } = native;
  if (typeof start !== "function" || typeof pause !== "function" || typeof resume !== "function" || start() !== true)
    throw new Error("Installed worker writer custody is unavailable.");
  workerLocalStateActivity.installWriterGate({
    pause: () => { if (pause() !== true) throw new Error("Installed worker cannot pause writer custody."); },
    resume: async () => {
      const deadline = performance.now() + 5000;
      for (;;) {
        if (resume() === true) return;
        if (performance.now() >= deadline) throw new Error("Installed worker writer custody was not restored.");
        await delay(10);
      }
    },
  });
}
