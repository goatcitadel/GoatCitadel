/** Controlled second-process fixture. The local effect is confined to the caller-created proof directory. */
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { MeshCapabilityManifest } from "@goatcitadel/contracts";
import { WorkerMeshCapabilityRuntime } from "../../../remote-worker/src/worker-mesh-capability-runtime.js";
import { exchangeWorkerMeshCapability } from "../../../remote-worker/src/worker-mesh-capability-client.js";
import { parseConnectedWorkerConfig } from "../../../remote-worker/src/worker-runtime-config.js";
import { runWorkerProcess } from "../../../remote-worker/src/worker-process-runtime.js";
import { acquireWorkerStateOwnership } from "../../../remote-worker/src/worker-state-ownership.js";
import { writeWorkerProcessReport } from "../../../remote-worker/src/worker-process-report.js";

const config = parseConnectedWorkerConfig();
const manifestFile = process.env.GOATCITADEL_TEST_MESH_MANIFEST_FILE!;
const effectFile = process.env.GOATCITADEL_TEST_MESH_EFFECT_FILE!;
if (!path.isAbsolute(manifestFile) || !path.isAbsolute(effectFile) ||
  path.dirname(effectFile) !== path.dirname(manifestFile) || path.basename(effectFile) !== "mesh-effect.jsonl")
  throw new Error("Controlled mesh effect path is invalid.");
const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as MeshCapabilityManifest;
const stopAt = process.env.GOATCITADEL_TEST_MESH_CUT;
async function cut(point: string): Promise<void> {
  if (stopAt !== point) return;
  process.send?.({ kind: "cut", point });
  await new Promise<void>(() => undefined);
}
const runtime = new WorkerMeshCapabilityRuntime([{ manifest, localId: "local.write", owner: {
  assertCurrent: async (request) => {
    request.signal.throwIfAborted();
    if (Object.keys(request.input).join() !== "message" || typeof request.input.message !== "string" || request.input.message.length > 128 ||
      request.entry.descriptor.permissions.filesystemWrite.join() !== "workspace://mesh-proof")
      throw new Error("Controlled local capability policy rejected input.");
  },
  execute: async (request) => {
    request.signal.throwIfAborted();
    await appendFile(effectFile, JSON.stringify({ invocationId: request.envelope.invocationId, message: request.input.message }) + "\n", "utf8");
    await cut("after_effect");
    return { disposition: "succeeded", output: { message: request.input.message } };
  },
} }], async (request) => {
  const response = await exchangeWorkerMeshCapability(request);
  if (request.payload.action === "settle") await cut("after_settlement");
  return response;
});
const release = await acquireWorkerStateOwnership(config.stateDir);
try {
  await runWorkerProcess(config, { signal: new AbortController().signal, meshCapabilities: runtime,
    publishReport: async (report) => {
      await writeWorkerProcessReport(config.reportFile, report);
      process.send?.({ kind: "report", report });
    } });
} finally {
  await release();
  process.disconnect?.();
}
