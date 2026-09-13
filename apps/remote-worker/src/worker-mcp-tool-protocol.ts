import { canonicalJsonString } from "@goatcitadel/contracts";
import { validateMeshCapabilityJson } from "@goatcitadel/contracts/mesh-schema-node";
import {
  snapshotWorkerMeshValue,
  workerMeshHash,
  workerMeshRecord,
  workerMeshRejected,
} from "./worker-mesh-capability-data.js";

export const WORKER_MCP_PROTOCOL_VERSION = "2025-06-18";
export interface WorkerMcpNativeTool {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}
export type WorkerMcpCall = (
  method: string,
  params: Record<string, unknown>,
  notification?: boolean,
) => Promise<Record<string, unknown> | undefined>;

/** Bound local authority/journal waits as well as transport waits. */
export async function runWorkerMcpStep<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        abort = () => reject(workerMeshRejected());
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export function normalizeWorkerMcpTools(value: unknown): readonly WorkerMcpNativeTool[] {
  const tools = snapshotWorkerMeshValue(value, 384 * 1024, true);
  if (!Array.isArray(tools) || !tools.length || tools.length > 128) throw workerMeshRejected();
  const names = new Set<string>();
  return tools.map((item) => {
    const tool = workerMeshRecord(item, ["name", "inputSchema", "outputSchema"], ["outputSchema"]);
    if (
      typeof tool.name !== "string" ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/u.test(tool.name) ||
      names.has(tool.name)
    )
      throw workerMeshRejected();
    names.add(tool.name);
    for (const schema of [tool.inputSchema, tool.outputSchema]) {
      if (schema === undefined) continue;
      if (
        !schema ||
        typeof schema !== "object" ||
        Array.isArray(schema) ||
        (schema as Record<string, unknown>).type !== "object"
      )
        throw workerMeshRejected();
      snapshotWorkerMeshValue(schema, 32 * 1024);
    }
    return tool as unknown as WorkerMcpNativeTool;
  });
}

/** Transport-independent discovery and one tool call. Never reconnects or retries. */
export async function invokeWorkerMcpTool(input: {
  readonly tools: readonly WorkerMcpNativeTool[];
  readonly tool: WorkerMcpNativeTool;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly maxResponseBytes: number;
  readonly call: WorkerMcpCall;
}): Promise<Record<string, unknown>> {
  const { call, tool, tools, args, signal } = input;
  signal.throwIfAborted();
  const initialized = await call("initialize", {
    protocolVersion: WORKER_MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "goatcitadel-destination-worker", version: "1.0.0" },
  });
  const capabilities = initialized?.capabilities as Record<string, unknown> | undefined;
  if (
    initialized?.protocolVersion !== WORKER_MCP_PROTOCOL_VERSION ||
    !capabilities?.tools ||
    typeof capabilities.tools !== "object" ||
    Array.isArray(capabilities.tools)
  )
    throw workerMeshRejected();
  await call("notifications/initialized", {}, true);
  const discovered = new Map<string, Record<string, unknown>>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 8; page++) {
    const listing = await call("tools/list", cursor ? { cursor } : {});
    if (!Array.isArray(listing?.tools) || listing.tools.length > 128) throw workerMeshRejected();
    for (const value of listing.tools) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.name !== "string" ||
        discovered.has(value.name) ||
        discovered.size >= 128
      )
        throw workerMeshRejected();
      discovered.set(value.name, value as Record<string, unknown>);
    }
    if (listing.nextCursor === undefined) {
      cursor = undefined;
      break;
    }
    if (
      typeof listing.nextCursor !== "string" ||
      !listing.nextCursor.length ||
      listing.nextCursor.length > 1024 ||
      cursors.has(listing.nextCursor)
    )
      throw workerMeshRejected();
    cursor = listing.nextCursor;
    cursors.add(cursor);
  }
  if (cursor !== undefined) throw workerMeshRejected();
  for (const expected of tools) {
    const actual = discovered.get(expected.name);
    if (
      !actual ||
      workerMeshHash(actual.inputSchema) !== workerMeshHash(expected.inputSchema) ||
      (actual.outputSchema === undefined) !== (expected.outputSchema === undefined) ||
      (expected.outputSchema && workerMeshHash(actual.outputSchema) !== workerMeshHash(expected.outputSchema))
    )
      throw workerMeshRejected();
  }
  const result = await call("tools/call", { name: tool.name, arguments: args });
  if (
    !result ||
    result.isError === true ||
    (result.isError !== undefined && result.isError !== false) ||
    !Array.isArray(result.content)
  )
    throw workerMeshRejected();
  for (const content of result.content) {
    if (
      !content ||
      typeof content !== "object" ||
      Array.isArray(content) ||
      typeof content.type !== "string" ||
      !["text", "image", "audio", "resource", "resource_link"].includes(content.type)
    )
      throw workerMeshRejected();
    if (content.type === "text" && typeof content.text !== "string") throw workerMeshRejected();
  }
  if (tool.outputSchema)
    await validateMeshCapabilityJson(
      canonicalJsonString(tool.outputSchema),
      canonicalJsonString(result.structuredContent),
      signal,
    );
  if (
    result.structuredContent !== undefined &&
    (!result.structuredContent ||
      typeof result.structuredContent !== "object" ||
      Array.isArray(result.structuredContent))
  )
    throw workerMeshRejected();
  const output = snapshotWorkerMeshValue(
    {
      content: result.content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      isError: false,
    },
    Math.min(input.maxResponseBytes, 64 * 1024),
    true,
  );
  signal.throwIfAborted();
  return output;
}
