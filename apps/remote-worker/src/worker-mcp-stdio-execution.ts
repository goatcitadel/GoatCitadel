import { canonicalJsonString, type MeshCapabilityNodeExecutionResult } from "@goatcitadel/contracts";
import { validateMeshCapabilityJson } from "@goatcitadel/contracts/mesh-schema-node";
import { snapshotWorkerMeshValue, workerMeshRejected } from "./worker-mesh-capability-data.js";
import { createWorkerMcpStdioTransport, type WorkerMcpStdioTransport } from "./worker-mcp-stdio-transport.js";
import {
  invokeWorkerMcpTool,
  normalizeWorkerMcpTools,
  runWorkerMcpStep,
  type WorkerMcpNativeTool,
} from "./worker-mcp-tool-protocol.js";
import { normalizeWindowsWorkerStdioLaunch, type WindowsWorkerStdioLaunch } from "./worker-windows-stdio-codec.js";
import {
  startWindowsWorkerStdio,
  type WindowsWorkerStdioImageGuard,
  type WindowsWorkerStdioSession,
} from "./worker-windows-stdio-executor.js";

/** Internal execution owner for a previously admitted bundle. The caller must
 * retain its canonical executing journal before beforeLaunch resolves. No registry
 * entrypoint is exposed until protected workspace/process composition owns launch.
 * The optional process owner is trusted constructor composition, never JSON input. */
export async function executeWorkerMcpStdioTool(
  input: {
    readonly launch: unknown;
    readonly tools: readonly WorkerMcpNativeTool[];
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly maxResponseBytes: number;
    readonly signal: AbortSignal;
    readonly beforeLaunch: (signal: AbortSignal, launch: WindowsWorkerStdioLaunch) => Promise<void>;
    readonly assertCurrent: (signal: AbortSignal) => Promise<void>;
    readonly imageGuard?: WindowsWorkerStdioImageGuard;
  },
  startProcess: typeof startWindowsWorkerStdio = startWindowsWorkerStdio,
): Promise<MeshCapabilityNodeExecutionResult> {
  let attempted = false;
  let session: WindowsWorkerStdioSession | undefined, transport: WorkerMcpStdioTransport | undefined;
  try {
    input.signal.throwIfAborted();
    const launch = normalizeWindowsWorkerStdioLaunch(input.launch);
    const tools = normalizeWorkerMcpTools(input.tools);
    const args = snapshotWorkerMeshValue(input.arguments, 256 * 1024, true);
    const tool = tools.find((tool) => tool.name === input.toolName);
    const beforeLaunch = input.beforeLaunch,
      assertCurrent = input.assertCurrent;
    const imageGuard = input.imageGuard,
      maxResponseBytes = input.maxResponseBytes;
    if (
      !tool ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      typeof input.beforeLaunch !== "function" ||
      typeof input.assertCurrent !== "function" ||
      !Number.isSafeInteger(input.maxResponseBytes) ||
      input.maxResponseBytes < 1 ||
      input.maxResponseBytes > 64 * 1024
    )
      throw workerMeshRejected();
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(launch.limits.wallMs)]);
    await validateMeshCapabilityJson(canonicalJsonString(tool.inputSchema), canonicalJsonString(args), signal);
    const current = () => runWorkerMcpStep(signal, () => assertCurrent(signal));
    await current();
    await runWorkerMcpStep(signal, () => beforeLaunch(signal, launch));
    // Starting a server can cause effects before the first JSON-RPC request.
    // Any failure from this point remains uncertain; there is no launch retry.
    attempted = true;
    session = await startProcess(launch, { signal, assertCurrent: current, ...(imageGuard ? { imageGuard } : {}) });
    transport = createWorkerMcpStdioTransport(session, { signal, assertCurrent: current });
    const output = await invokeWorkerMcpTool({ tools, tool, args, signal, maxResponseBytes, call: transport.call });
    await transport.finish();
    signal.throwIfAborted();
    return { disposition: "succeeded", output };
  } catch {
    return {
      disposition: attempted ? "unknown" : "failed",
      errorCode: attempted ? "destination_mcp_outcome_uncertain" : "destination_mcp_refused",
    };
  } finally {
    if (transport) await transport.stop();
    else await session?.stop();
  }
}
