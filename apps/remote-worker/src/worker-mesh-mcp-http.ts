import type { MeshMcpServerCapabilityDescriptor } from "@goatcitadel/contracts";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { validateMeshCapabilityJson } from "@goatcitadel/contracts/mesh-schema-node";
import { snapshotWorkerMeshValue, workerMeshHash, workerMeshRecord, workerMeshRejected } from "./worker-mesh-capability-data.js";
import type { WorkerMeshCapabilityBinding, WorkerMeshCapabilityExecutionRequest } from "./worker-mesh-capability-runtime.js";
import { exchangeWorkerMcpHttp, workerMcpEndpoint, WORKER_MCP_PROTOCOL_VERSION } from "./worker-mcp-http-transport.js";
import { loadWorkerMcpBearerCredential, workerMcpBearerReference, type WorkerMcpBearerCredentialReference } from "./worker-mcp-bearer-credential.js";
import { invokeWorkerMcpTool, normalizeWorkerMcpTools as nativeTools, type WorkerMcpNativeTool } from "./worker-mcp-tool-protocol.js";
export type { WorkerMcpNativeTool } from "./worker-mcp-tool-protocol.js";

/** This grants a connection to a separately operated server, not host filesystem access. */
export function createWorkerMeshMcpHttpDescriptor(endpoint: string, tools: readonly WorkerMcpNativeTool[], authorization?: WorkerMcpBearerCredentialReference): MeshMcpServerCapabilityDescriptor {
  const url = workerMcpEndpoint(endpoint);
  const selected = nativeTools(tools);
  const credential = authorization === undefined ? undefined : workerMcpBearerReference(authorization);
  return { kind: "mcp_server", title: "Invoke an approved destination MCP server", semanticVersion: credential ? "1.1.0" : "1.0.0",
    ...(credential ? { configurationSha256: workerMeshHash({ endpoint, tools: selected, authorization: credential }) } : {}),
    protocol: "mcp", protocolVersion: WORKER_MCP_PROTOCOL_VERSION, effectPosture: "unknown",
    permissions: { schemaVersion: "goatcitadel.mesh-capability-permissions.v1", filesystemRead: [], filesystemWrite: [],
      networkOrigins: [url.origin], environmentNames: [], deviceCapabilities: [] },
    resourceLimits: { timeoutMs: 25_000, maxRequestBytes: 256 * 1024, maxResponseBytes: 64 * 1024 },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 120_000, timeoutMs: 5_000 },
    tools: selected.map((tool) => ({ name: tool.name, inputSchemaSha256: workerMeshHash(tool.inputSchema) })) };
}

export async function createWorkerMeshMcpHttpBinding(input: {
  readonly manifest: WorkerMeshCapabilityBinding["manifest"];
  readonly localId: string;
  readonly endpoint: string;
  readonly tools: readonly WorkerMcpNativeTool[];
  readonly authorization?: WorkerMcpBearerCredentialReference;
  readonly assertConfigurationCurrent: (signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
}): Promise<WorkerMeshCapabilityBinding> {
  input.signal.throwIfAborted();
  const manifest = snapshotWorkerMeshValue(input.manifest, 512 * 1024, true);
  const entry = manifest.entries.find((item) => item.localId === input.localId);
  const tools = nativeTools(input.tools);
  const endpoint = input.endpoint;
  const contract = createWorkerMeshMcpHttpDescriptor(endpoint, tools, input.authorization);
  if (!entry || entry.kind !== "mcp_server" || entry.descriptor.kind !== "mcp_server" ||
    entry.descriptor.semanticVersion !== contract.semanticVersion || entry.descriptor.effectPosture !== contract.effectPosture ||
    entry.descriptor.protocol !== contract.protocol || entry.descriptor.protocolVersion !== contract.protocolVersion ||
    entry.descriptor.configurationSha256 !== contract.configurationSha256 ||
    workerMeshHash(entry.descriptor.permissions) !== workerMeshHash(contract.permissions) ||
    workerMeshHash(entry.descriptor.tools) !== workerMeshHash(contract.tools)) throw workerMeshRejected();
  const assertConfigurationCurrent = input.assertConfigurationCurrent;
  const credential = input.authorization === undefined ? undefined :
    await loadWorkerMcpBearerCredential(input.authorization, assertConfigurationCurrent, input.signal);
  const assertLocalCurrent = async (signal: AbortSignal) => {
    await assertConfigurationCurrent(signal);
    await credential?.assertCurrent(signal);
    signal.throwIfAborted();
  };
  const resolve = (request: WorkerMeshCapabilityExecutionRequest) => {
    if (request.entry.entrySha256 !== entry.entrySha256 || request.envelope.manifestSha256 !== manifest.manifestSha256 ||
      request.envelope.workspaceId !== manifest.workspaceId || request.envelope.nodeId !== manifest.nodeId) throw workerMeshRejected();
    const args = workerMeshRecord(request.input, ["toolName", "arguments"]);
    const tool = tools.find((tool) => tool.name === args.toolName);
    if (!tool || !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) throw workerMeshRejected();
    return { tool, args: snapshotWorkerMeshValue(args.arguments as Record<string, unknown>, 256 * 1024, true) };
  };
  const assertCurrent = async (request: WorkerMeshCapabilityExecutionRequest) => {
    request.signal.throwIfAborted();
    if (typeof request.assertRemoteCurrent !== "function") throw workerMeshRejected();
    const { tool, args } = resolve(request);
    await validateMeshCapabilityJson(canonicalJsonString(tool.inputSchema), canonicalJsonString(args), request.signal);
    await assertLocalCurrent(request.signal);
    request.signal.throwIfAborted();
  };
  return { manifest, localId: input.localId, owner: {
    assertCurrent,
    execute: async (request) => {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.min(entry.descriptor.resourceLimits.timeoutMs, 25_000))]);
      let sessionId: string | undefined, dispatched = false, nextId = 1;
      const current = async () => { signal.throwIfAborted(); await assertLocalCurrent(signal); };
      const call = async (method: string, params: Record<string, unknown>, notification = false) => {
        const response = await exchangeWorkerMcpHttp({ endpoint, method, params, sessionId, signal,
          ...(credential ? { authorization: credential.authorization } : {}),
          ...(notification ? {} : { id: nextId++ }), assertCurrent: async () => {
            await current();
            if (method === "tools/call") { await request.assertRemoteCurrent!(); await current(); }
          },
          ...(method === "tools/call" ? { beforeSend: () => { dispatched = true; } } : {}) });
        sessionId = response.sessionId;
        return response.result;
      };
      try {
        await assertCurrent({ ...request, signal });
        const { tool, args } = resolve(request);
        const output = await invokeWorkerMcpTool({ tools, tool, args, signal,
          maxResponseBytes: entry.descriptor.resourceLimits.maxResponseBytes, call });
        credential?.assertOutputSafe(output);
        signal.throwIfAborted();
        return { disposition: "succeeded", output };
      } catch {
        return { disposition: dispatched ? "unknown" : "failed", errorCode: dispatched ? "destination_mcp_outcome_uncertain" : "destination_mcp_refused" };
      } finally {
        if (sessionId) {
          try {
            const cleanup = AbortSignal.timeout(2000);
            await exchangeWorkerMcpHttp({ endpoint, method: "close", params: {}, sessionId, closeSession: true,
              ...(credential ? { authorization: credential.authorization } : {}),
              signal: cleanup, assertCurrent: async () => { await assertLocalCurrent(cleanup); } });
          } catch { /* Session cleanup does not change a retained tool outcome or authorize a retry. */ }
        }
      }
    },
  } };
}
