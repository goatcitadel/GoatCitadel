import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Process exclusion only. This does not protect the vault from other users. */
export async function acquireWorkerStateOwnership(stateDir: string): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true });
  const canonicalPath = await realpath(stateDir);
  const identity = createHash("sha256")
    .update(process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath)
    .digest("hex");
  // Windows pipes and Linux abstract sockets are released by the OS on crash.
  // Other Unix hosts retain a stale socket on crash and require reconciliation;
  // never unlink a possibly live owner's socket to make another writer start.
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\GoatCitadel.RemoteWorker.${identity}`
      : process.platform === "linux"
        ? `\0goatcitadel-worker-${identity}`
        : join(tmpdir(), `gc-worker-${identity.slice(0, 40)}.sock`);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const failed = () =>
      reject(new Error("Worker state ownership is unavailable; another process may own this state."));
    server.once("error", failed);
    server.listen({ path: endpoint, exclusive: true }, () => {
      server.removeListener("error", failed);
      resolve();
    });
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
}
