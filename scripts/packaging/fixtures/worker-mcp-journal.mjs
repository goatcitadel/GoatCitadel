import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Controlled transport and binding; real worker journal/runtime and native MCP.
 * This fixture grants no installed-service or live Gateway acceptance. */
export async function runJournaledMcpFixture({ root, workerDist, invocation, execute }) {
  const load = (name) => import(pathToFileURL(path.join(workerDist, name)));
  const { createFileWorkerDurableState } = await load("worker-durable-state.js");
  const { WorkerMeshCapabilityRuntime } = await load("worker-mesh-capability-runtime.js");
  const { workerMeshHash: hash } = await load("worker-mesh-capability-data.js");
  const { WORKER_MCP_PROTOCOL_VERSION } = await load("worker-mcp-tool-protocol.js");
  const stateRoot = path.join(root, "worker-journal");
  const state = createFileWorkerDurableState(stateRoot);
  const args = { toolName: invocation.toolName, arguments: invocation.arguments };
  const descriptor = {
    kind: "mcp_server", title: "Protected stdio journal fixture", semanticVersion: "1.0.0", effectPosture: "unknown",
    protocol: "mcp", protocolVersion: WORKER_MCP_PROTOCOL_VERSION,
    configurationSha256: hash({ launch: invocation.launch, tools: invocation.tools }),
    permissions: { schemaVersion: "goatcitadel.mesh-capability-permissions.v1", filesystemRead: [], filesystemWrite: [],
      networkOrigins: [], environmentNames: [], deviceCapabilities: [] },
    resourceLimits: { timeoutMs: 12000, maxRequestBytes: 65536, maxResponseBytes: 65536 },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 30000, timeoutMs: 5000 },
    tools: invocation.tools.map((tool) => ({ name: tool.name, inputSchemaSha256: hash(tool.inputSchema) })),
  };
  const unsignedEntry = { localId: "fixture.mcp", kind: "mcp_server", capabilityId: "mesh:node-a:mcp_server:fixture.mcp", descriptor,
    descriptorSha256: hash(descriptor), permissionEnvelopeSha256: hash(descriptor.permissions) };
  const entry = { ...unsignedEntry, entrySha256: hash(unsignedEntry) };
  const unsignedManifest = { schemaVersion: "goatcitadel.mesh-capability-manifest.v1", workspaceId: "workspace-a", nodeId: "node-a",
    admissionGeneration: 1, publisherGeneration: 2, publicationKey: "owned-local", publicationLeaseFencingToken: 3,
    entries: [entry], createdAt: new Date().toISOString() };
  const manifest = { ...unsignedManifest, manifestSha256: hash(unsignedManifest) };
  const envelope = { schemaVersion: "goatcitadel.mesh-capability-invocation-envelope.v1", invocationId: "invocation-a", idempotencyKey: "mcp:a",
    workspaceId: "workspace-a", sessionId: "session-a", turnId: "turn-a", runId: "run-a", capabilityId: entry.capabilityId,
    executionProfileSha256: hash("profile"), manifestSha256: manifest.manifestSha256, entrySha256: entry.entrySha256,
    descriptorSha256: entry.descriptorSha256, permissionEnvelopeSha256: entry.permissionEnvelopeSha256,
    activationId: "activation-a", activationRevision: 4, nodeId: "node-a", publisherGeneration: 2, publicationLeaseFencingToken: 3,
    inputSha256: hash(args), deadlineAt: new Date(Date.now() + 12000).toISOString(), approvalId: "approval-a" };
  const key = `mesh-execution-${hash({ workspaceId: "workspace-a", nodeId: "node-a", registryWorkspaceId: "registry-a", workerGeneration: 1 })}`;
  let entries = 0, outcome;
  const exchange = async ({ payload }) => {
    assert.equal(Object.hasOwn(payload, "nativeWorkspace"), false);
    let result;
    if (payload.action === "pending") result = { items: [envelope] };
    else if (payload.action === "input") result = { invocationId: envelope.invocationId, inputSha256: envelope.inputSha256, input: args };
    else if (payload.action === "progress") result = { accepted: true, sequence: 1 };
    else if (payload.action === "settle") {
      const active = JSON.parse(await state.read(key)).active;
      assert.deepEqual(active.submission, payload.submission);
      assert.deepEqual(active.nativeWorkspace.workspace, invocation.launch.protectedWorkspace);
      const { output: _output, ...durable } = payload.submission;
      const material = { workspaceId: envelope.workspaceId, ...durable,
        idempotencyKey: `mesh-capability-settlement:node:${envelope.nodeId}:${envelope.invocationId}` };
      result = { settlement: { ...material, requestSha256: hash(material), settledAt: new Date().toISOString() }, replayed: false };
    } else throw new Error("Unexpected controlled mesh action");
    return { schemaVersion: payload.schemaVersion, operation: "mesh.capability.exchange", action: payload.action,
      workspaceId: payload.workspaceId, nodeId: "node-a", result };
  };
  const binding = { manifest, localId: entry.localId, owner: { assertCurrent: async () => undefined, execute: async (request) => {
    entries++;
    outcome = await execute({ ...request, beforeNative: async (launch) => {
      const active = JSON.parse(await createFileWorkerDurableState(stateRoot).read(key)).active;
      assert.equal(active.phase, "executing");
      assert.equal(active.nativeWorkspace.launchSha256, hash(launch));
      assert.equal(active.nativeWorkspace.envelopeSha256, hash(envelope));
    } });
    return outcome;
  } } };
  const input = { state, context: { credential: { registryWorkspaceId: "registry-a", workerGeneration: 1 } }, workspaceId: "workspace-a", nodeId: "node-a" };
  const result = await new WorkerMeshCapabilityRuntime([binding], exchange).runNext(input);
  assert.equal(result.status, "settled");
  assert.equal(result.receipt.disposition, outcome.disposition);
  assert.equal(Object.hasOwn(result.receipt, "nativeWorkspace"), false);
  const persisted = JSON.parse(await state.read(key));
  assert.equal(persisted.schemaVersion, "goatcitadel.worker-mesh-capability-journal.v2");
  assert.equal(persisted.active, undefined);
  assert.deepEqual(persisted.receipts[0].nativeWorkspace.workspace, invocation.launch.protectedWorkspace);
  const restart = new WorkerMeshCapabilityRuntime([binding], exchange).runNext({ ...input, state: createFileWorkerDurableState(stateRoot) });
  if (outcome.disposition === "unknown") await assert.rejects(restart);
  else assert.deepEqual(await restart, { status: "idle" });
  assert.equal(entries, 1);
  return { outcome, journalProof: { entries, noReplayAfterRestart: true, stateFile: path.join(stateRoot, `${key}.json`),
    recordSha256: persisted.receipts[0].nativeWorkspace.recordSha256 } };
}
