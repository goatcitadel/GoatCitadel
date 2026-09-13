import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  remoteWorkerRuntimeBundleManifestSha256,
  MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
  MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  type MeshCapabilityInvocationDispatchEnvelope,
  type MeshCapabilityManifest,
  type MeshMcpServerCapabilityDescriptor,
  type RemoteWorkerMeshCapabilityResponse,
} from "@goatcitadel/contracts";
import { createWorkerMcpStdioTransport } from "./worker-mcp-stdio-transport.js";
import { executeWorkerMcpStdioTool } from "./worker-mcp-stdio-execution.js";
import { invokeWorkerMcpTool, WORKER_MCP_PROTOCOL_VERSION } from "./worker-mcp-tool-protocol.js";
import * as native from "./worker-windows-stdio-executor.js";
import type { WindowsWorkerStdioCompletion, WindowsWorkerStdioLaunch } from "./worker-windows-stdio-codec.js";
import { createFileWorkerDurableState } from "./worker-durable-state.js";
import { WorkerMeshCapabilityRuntime, type WorkerMeshCapabilityBinding } from "./worker-mesh-capability-runtime.js";
import { workerMeshHash } from "./worker-mesh-capability-data.js";
import type { exchangeWorkerMeshCapability } from "./worker-mesh-capability-client.js";
import type { RouteContext } from "./connected-worker-routes.js";

const tools = [
  {
    name: "fixture.echo",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
];
function fixture() {
  const queue: native.WindowsWorkerStdioOutput[] = [];
  let reader: ((value: native.WindowsWorkerStdioOutput | null) => void) | undefined;
  let ended = false,
    stops = 0,
    eof = 0,
    incoming = "";
  let resolveCompletion!: (value: WindowsWorkerStdioCompletion) => void;
  const result: WindowsWorkerStdioCompletion = {
    schemaVersion: "goatcitadel.worker-native-stdio.v1",
    bridgeError: 0,
    end: 0,
    error: 0,
    processExitCode: 0,
    processId: 123,
    runtimeBundleVerified: true,
    runtimeBundleSha256: "a".repeat(64),
    zeroProcessesVerified: true,
    outputDrained: true,
    appContainerVerified: true,
    launchFilesVerified: true,
    processImageVerified: true,
    protectedWorkspaceVerified: false,
    standardInputBytesWritten: 1,
    standardInputComplete: true,
    standardOutputBytes: 1,
    standardErrorBytes: 0,
  };
  const completion = new Promise<WindowsWorkerStdioCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
  const notify = () => {
    if (reader && (ended || queue.length)) {
      const current = reader;
      reader = undefined;
      current(queue.shift() ?? null);
    }
  };
  const raw = (bytes: Buffer, stream: "stdout" | "stderr" = "stdout") => {
    queue.push({ stream, bytes });
    notify();
  };
  const emit = (value: unknown) => raw(Buffer.from(`${JSON.stringify(value)}\n`));
  const messages: Record<string, unknown>[] = [];
  let handle = (rpc: Record<string, unknown>) => {
    if (rpc.id === undefined) return;
    let response: Record<string, unknown>;
    if (rpc.method === "initialize")
      response = { protocolVersion: WORKER_MCP_PROTOCOL_VERSION, capabilities: { tools: {} } };
    else if (rpc.method === "tools/list") response = { tools };
    else if (rpc.method === "tools/call")
      response = {
        content: [{ type: "text", text: "echoed" }],
        structuredContent: (rpc.params as Record<string, unknown>).arguments,
      };
    else response = {};
    emit({ jsonrpc: "2.0", id: rpc.id, result: response });
  };
  const session: native.WindowsWorkerStdioSession = {
    completion,
    write: async (bytes) => {
      incoming += Buffer.from(bytes).toString("utf8");
      let end: number;
      while ((end = incoming.indexOf("\n")) >= 0) {
        const rpc = JSON.parse(incoming.slice(0, end));
        incoming = incoming.slice(end + 1);
        messages.push(rpc);
        handle(rpc);
      }
    },
    endInput: async () => {
      eof++;
      ended = true;
      resolveCompletion(result);
      notify();
    },
    read: async () =>
      queue.length
        ? queue.shift()!
        : ended
          ? null
          : new Promise((resolve) => {
              reader = resolve;
            }),
    stop: async () => {
      stops++;
      ended = true;
      resolveCompletion(result);
      notify();
    },
  };
  return {
    session,
    raw,
    emit,
    messages,
    result,
    respond: handle,
    handle: (callback: typeof handle) => {
      handle = callback;
    },
    stops: () => stops,
    eof: () => eof,
  };
}
function launch(): WindowsWorkerStdioLaunch {
  const runtimeBundle = {
    schemaVersion: "goatcitadel.worker-runtime-bundle.v1" as const,
    files: [{ relativePath: "entry.exe", bytes: 3, sha256: "a".repeat(64) }],
  };
  return {
    jobName: `gc-cell-${"1".repeat(32)}`,
    appContainerName: `GoatCitadel.Worker.${"1".repeat(32)}`,
    image: "C:\\runtime\\entry.exe",
    commandLine: '"C:\\runtime\\entry.exe" serve',
    directory: "C:\\work",
    runtimeRoot: "C:\\runtime",
    imageSha256: "a".repeat(64),
    directoryIdentity: "1".repeat(48),
    runtimeRootIdentity: "2".repeat(48),
    runtimeBundle,
    runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle),
    environment: { SystemRoot: "C:\\Windows" },
    limits: {
      processLimit: 1,
      memoryBytes: 64 * 1024 * 1024,
      cpuMilli: 1000,
      wallMs: 5000,
      rawOutputBytes: 65536,
      diagnosticBytes: 1024,
      inputBytes: 65536,
    },
  };
}
const clients: Array<ReturnType<typeof createWorkerMcpStdioTransport>> = [];
const client = (f: ReturnType<typeof fixture>, signal = AbortSignal.timeout(5000), current = async () => undefined) => {
  const value = createWorkerMcpStdioTransport(f.session, { signal, assertCurrent: current });
  clients.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  vi.restoreAllMocks();
});

describe("worker MCP stdio transport", () => {
  it("initializes, discovers exact schemas, calls once and joins input EOF and native cleanup", async () => {
    const f = fixture(),
      c = client(f),
      signal = AbortSignal.timeout(5000);
    const result = await invokeWorkerMcpTool({
      tools,
      tool: tools[0]!,
      args: { value: "goat 🐐" },
      signal,
      maxResponseBytes: 65536,
      call: c.call,
    });
    await c.finish();
    expect(result.structuredContent).toEqual({ value: "goat 🐐" });
    expect(f.messages.map((rpc) => rpc.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(f.eof()).toBe(1);
    expect(f.stops()).toBe(0);
  });
  it("preserves a UTF-8 character split across native chunks and discards stderr", async () => {
    const f = fixture(),
      c = client(f);
    f.handle((rpc) => {
      f.raw(Buffer.from("operator-only diagnostic"), "stderr");
      const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { value: "🐐" } })}\n`);
      for (const byte of bytes) f.raw(Buffer.from([byte]));
    });
    await expect(c.call("ping", {})).resolves.toEqual({ value: "🐐" });
    await c.finish();
  });
  it("answers ping and refuses sampling without running a client capability", async () => {
    const f = fixture(),
      c = client(f);
    f.handle((rpc) => {
      if (rpc.method === "tools/list") {
        f.emit({ jsonrpc: "2.0", id: "server-ping", method: "ping" });
        f.emit({ jsonrpc: "2.0", id: "server-sampling", method: "sampling/createMessage", params: {} });
        f.emit({ jsonrpc: "2.0", id: rpc.id, result: { tools } });
      }
    });
    await c.call("tools/list", {});
    await c.finish();
    expect(f.messages).toContainEqual({ jsonrpc: "2.0", id: "server-ping", result: {} });
    expect(f.messages).toContainEqual({
      jsonrpc: "2.0",
      id: "server-sampling",
      error: { code: -32601, message: "Client method unavailable" },
    });
  });
  it.each(["wrong-id", "duplicate", "invalid-utf8", "unframed", "catalog-changed", "oversized", "server-error"])(
    "stops the owned session after %s protocol failure",
    async (mode) => {
      const f = fixture(),
        c = client(f);
      f.handle((rpc) => {
        if (mode === "wrong-id") f.emit({ jsonrpc: "2.0", id: 1000, result: {} });
        if (mode === "duplicate")
          f.raw(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {} })}\n`.repeat(2)));
        if (mode === "invalid-utf8") f.raw(Buffer.from([0xff, 10]));
        if (mode === "unframed") f.raw(Buffer.from("debug log\n"));
        if (mode === "catalog-changed") f.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        if (mode === "oversized") f.raw(Buffer.alloc(512 * 1024 + 1, 120));
        if (mode === "server-error")
          f.emit({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "sensitive details" } });
      });
      await expect(c.call("tools/list", {})).rejects.toThrow();
      expect(f.stops()).toBe(1);
    },
  );
  it("rejects a partial final frame at EOF", async () => {
    const f = fixture(),
      c = client(f);
    await c.call("ping", {});
    f.raw(Buffer.from('{"jsonrpc":'));
    await expect(c.finish()).rejects.toThrow();
    expect(f.stops()).toBe(1);
  });
  it("cannot report success after an unconfirmed native cleanup", async () => {
    const f = fixture(),
      c = client(f);
    Object.assign(f.result, { zeroProcessesVerified: false });
    await c.call("ping", {});
    await expect(c.finish()).rejects.toThrow();
  });
  it("bounds an authority callback that never resolves, without writing the request", async () => {
    const f = fixture(),
      abort = new AbortController();
    const c = client(f, abort.signal, () => new Promise(() => undefined));
    const waiting = c.call("tools/list", {});
    abort.abort();
    await expect(waiting).rejects.toThrow();
    expect(f.messages).toEqual([]);
    expect(f.stops()).toBe(1);
  });
  it("stops a waiting response on revocation and never replays it", async () => {
    const f = fixture(),
      abort = new AbortController(),
      c = client(f, abort.signal);
    f.handle(() => {
      abort.abort();
    });
    await expect(c.call("tools/call", {})).rejects.toThrow();
    expect(f.messages).toHaveLength(1);
  });
});

describe("worker MCP stdio launch outcome", () => {
  const execute = (extra: Partial<Parameters<typeof executeWorkerMcpStdioTool>[0]> = {}) =>
    executeWorkerMcpStdioTool({
      launch: launch(),
      tools,
      toolName: "fixture.echo",
      arguments: { value: "hello" },
      maxResponseBytes: 65536,
      signal: AbortSignal.timeout(5000),
      assertCurrent: async () => undefined,
      beforeLaunch: async () => undefined,
      ...extra,
    });
  it("finishes the canonical prelaunch hook before the native owner can run", async () => {
    const f = fixture(),
      order: string[] = [];
    vi.spyOn(native, "startWindowsWorkerStdio").mockImplementation(async () => {
      order.push("native");
      return f.session;
    });
    const result = await execute({
      beforeLaunch: async () => {
        order.push("journal");
      },
    });
    expect(result.disposition).toBe("succeeded");
    expect(order).toEqual(["journal", "native"]);
    expect(f.eof()).toBe(1);
  });
  it("freezes arguments and launch before asynchronous admission", async () => {
    const f = fixture(),
      arguments_ = { value: "reviewed" },
      configuration = launch();
    const initialCommand = configuration.commandLine;
    vi.spyOn(native, "startWindowsWorkerStdio").mockImplementation(async (actual) => {
      expect((actual as WindowsWorkerStdioLaunch).commandLine).toBe(initialCommand);
      return f.session;
    });
    const result = await execute({
      launch: configuration,
      arguments: arguments_,
      beforeLaunch: async () => {
        arguments_.value = "changed";
        Object.assign(configuration, { commandLine: "changed" });
      },
    });
    expect(result).toMatchObject({ disposition: "succeeded", output: { structuredContent: { value: "reviewed" } } });
  });
  it.each(["invalid-input", "journal-failed", "journal-stalled"])("does not launch after %s", async (mode) => {
    const nativeStart = vi.spyOn(native, "startWindowsWorkerStdio");
    const result = await execute({
      ...(mode === "invalid-input" ? { arguments: { unexpected: true } } : {}),
      ...(mode === "journal-failed"
        ? {
            beforeLaunch: async () => {
              throw new Error("disk failure");
            },
          }
        : {}),
      ...(mode === "journal-stalled"
        ? { signal: AbortSignal.timeout(30), beforeLaunch: () => new Promise(() => undefined) }
        : {}),
    });
    expect(result.disposition).toBe("failed");
    expect(nativeStart).not.toHaveBeenCalled();
  });
  it.each(["launch", "discovery", "schema-drift", "tool-result", "output-schema", "cleanup"])(
    "retains %s failure after launch as uncertain",
    async (mode) => {
      const f = fixture();
      const nativeStart = vi.spyOn(native, "startWindowsWorkerStdio").mockImplementation(async () => {
        if (mode === "launch") throw new Error("launch completion lost");
        return f.session;
      });
      if (mode === "discovery") f.handle((rpc) => f.emit({ jsonrpc: "2.0", id: rpc.id, result: {} }));
      if (mode === "schema-drift")
        f.handle((rpc) =>
          rpc.method === "tools/list"
            ? f.emit({
                jsonrpc: "2.0",
                id: rpc.id,
                result: { tools: [{ ...tools[0], inputSchema: { type: "object" } }] },
              })
            : f.respond(rpc),
        );
      if (mode === "tool-result")
        f.handle((rpc) =>
          rpc.method === "tools/call"
            ? f.emit({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "refused" } })
            : f.respond(rpc),
        );
      if (mode === "output-schema")
        f.handle((rpc) =>
          rpc.method === "tools/call"
            ? f.emit({ jsonrpc: "2.0", id: rpc.id, result: { content: [], structuredContent: { value: 1 } } })
            : f.respond(rpc),
        );
      if (mode === "cleanup") Object.assign(f.result, { processExitCode: 1 });
      const result = await execute();
      expect(result).toEqual({ disposition: "unknown", errorCode: "destination_mcp_outcome_uncertain" });
      expect(nativeStart).toHaveBeenCalledTimes(1);
      if (mode === "schema-drift") expect(f.messages.some((rpc) => rpc.method === "tools/call")).toBe(false);
      if (mode === "tool-result" || mode === "output-schema")
        expect(f.messages.filter((rpc) => rpc.method === "tools/call")).toHaveLength(1);
    },
  );
});

describe("MCP stdio through the canonical worker journal", () => {
  it.each(["succeeded", "unknown"] as const)(
    "persists the protected workspace before launch and does not repeat a retained %s invocation",
    async (disposition) => {
      const root = await mkdtemp(path.join(tmpdir(), "goat-mcp-stdio-journal-"));
      try {
        const state = createFileWorkerDurableState(root),
          f = fixture();
        const identity = (value: string) => "1".repeat(16) + value.repeat(32);
        const admittedLaunch = { ...launch(), directoryIdentity: identity("5"), runtimeRootIdentity: identity("4"),
          protectedWorkspace: { parentPath: "C:\\private-cells", parentIdentity: identity("1"), rootIdentity: identity("2"),
            controlIdentity: identity("3"), runtimeIdentity: identity("4"), workIdentity: identity("5"),
            ownerSid: "S-1-5-21-1-2-3-1001", controllerSid: "S-1-5-80-1-2-3-4-5" } };
        Object.assign(f.result, { protectedWorkspaceVerified: true });
        const args = { toolName: "fixture.echo", arguments: { value: "journal proof" } };
        const descriptor: MeshMcpServerCapabilityDescriptor = {
          kind: "mcp_server",
          title: "Controlled stdio owner",
          semanticVersion: "1.0.0",
          effectPosture: "unknown",
          protocol: "mcp",
          protocolVersion: WORKER_MCP_PROTOCOL_VERSION,
          configurationSha256: workerMeshHash({ launch: admittedLaunch, tools }),
          permissions: {
            schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
            filesystemRead: [],
            filesystemWrite: [],
            networkOrigins: [],
            environmentNames: [],
            deviceCapabilities: [],
          },
          resourceLimits: { timeoutMs: 5000, maxRequestBytes: 65536, maxResponseBytes: 65536 },
          healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 30000, timeoutMs: 5000 },
          tools: tools.map((tool) => ({ name: tool.name, inputSchemaSha256: workerMeshHash(tool.inputSchema) })),
        };
        const unsignedEntry = {
          localId: "fixture.mcp",
          kind: "mcp_server" as const,
          capabilityId: "mesh:node-a:mcp_server:fixture.mcp",
          descriptor,
          descriptorSha256: workerMeshHash(descriptor),
          permissionEnvelopeSha256: workerMeshHash(descriptor.permissions),
        };
        const entry = { ...unsignedEntry, entrySha256: workerMeshHash(unsignedEntry) };
        const unsignedManifest = {
          schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
          workspaceId: "workspace-a",
          nodeId: "node-a",
          admissionGeneration: 1,
          publisherGeneration: 2,
          publicationKey: "owned-local",
          publicationLeaseFencingToken: 3,
          entries: [entry],
          createdAt: new Date().toISOString(),
        };
        const manifest: MeshCapabilityManifest = {
          ...unsignedManifest,
          manifestSha256: workerMeshHash(unsignedManifest),
        };
        const envelope: MeshCapabilityInvocationDispatchEnvelope = {
          schemaVersion: MESH_CAPABILITY_INVOCATION_ENVELOPE_SCHEMA_VERSION,
          invocationId: "invocation-a",
          idempotencyKey: "mcp:a",
          workspaceId: "workspace-a",
          sessionId: "session-a",
          turnId: "turn-a",
          runId: "run-a",
          capabilityId: entry.capabilityId,
          executionProfileSha256: workerMeshHash("profile"),
          manifestSha256: manifest.manifestSha256,
          entrySha256: entry.entrySha256,
          descriptorSha256: entry.descriptorSha256,
          permissionEnvelopeSha256: entry.permissionEnvelopeSha256,
          activationId: "activation-a",
          activationRevision: 4,
          nodeId: "node-a",
          publisherGeneration: 2,
          publicationLeaseFencingToken: 3,
          inputSha256: workerMeshHash(args),
          deadlineAt: new Date(Date.now() + 5000).toISOString(),
          approvalId: "approval-a",
        };
        const journalKey = `mesh-execution-${workerMeshHash({ workspaceId: "workspace-a", nodeId: "node-a", registryWorkspaceId: "registry-a", workerGeneration: 1 })}`;
        const exchange: typeof exchangeWorkerMeshCapability = async ({ payload }) => {
          let result: unknown;
          if (payload.action === "pending") result = { items: [envelope] };
          else if (payload.action === "input")
            result = { invocationId: envelope.invocationId, inputSha256: envelope.inputSha256, input: args };
          else if (payload.action === "progress") result = { accepted: true, sequence: 1 };
          else if (payload.action === "settle") {
            expect(JSON.parse((await state.read(journalKey))!).active.submission).toEqual(payload.submission);
            expect(JSON.stringify(payload)).not.toContain("private-cells");
            const { output: _output, ...durable } = payload.submission;
            const material = {
              workspaceId: envelope.workspaceId,
              ...durable,
              idempotencyKey: `mesh-capability-settlement:node:${envelope.nodeId}:${envelope.invocationId}`,
            };
            result = {
              settlement: { ...material, requestSha256: workerMeshHash(material), settledAt: new Date().toISOString() },
              replayed: false,
            };
          } else throw new Error("Unexpected exchange");
          return {
            schemaVersion: payload.schemaVersion,
            operation: "mesh.capability.exchange",
            action: payload.action,
            workspaceId: payload.workspaceId,
            nodeId: "node-a",
            result,
          } as RemoteWorkerMeshCapabilityResponse;
        };
        const nativeStart = vi.spyOn(native, "startWindowsWorkerStdio").mockImplementation(async (frozenLaunch) => {
          const active = JSON.parse((await createFileWorkerDurableState(root).read(journalKey))!).active;
          expect(active.phase).toBe("executing");
          expect(active.nativeWorkspace).toMatchObject({ invocationId: envelope.invocationId,
            envelopeSha256: workerMeshHash(envelope), launchSha256: workerMeshHash(frozenLaunch),
            workspace: admittedLaunch.protectedWorkspace });
          return f.session;
        });
        if (disposition === "unknown") f.handle(() => f.raw(Buffer.from("interrupted before initialization\n")));
        const binding: WorkerMeshCapabilityBinding = {
          manifest,
          localId: entry.localId,
          owner: {
            assertCurrent: async () => undefined,
            execute: async (request) =>
              executeWorkerMcpStdioTool({
                launch: admittedLaunch,
                tools,
                toolName: args.toolName,
                arguments: request.input.arguments as Record<string, unknown>,
                maxResponseBytes: 65536,
                signal: request.signal,
                beforeLaunch: async (_signal, frozenLaunch) => {
                  expect(JSON.parse((await state.read(journalKey))!).active.phase).toBe("executing");
                  await request.retainNativeWorkspace!(frozenLaunch);
                },
                assertCurrent: async () => {
                  await request.assertRemoteCurrent!();
                },
              }),
          },
        };
        const input = {
          state,
          context: { credential: { registryWorkspaceId: "registry-a", workerGeneration: 1 } } as RouteContext,
          workspaceId: "workspace-a",
          nodeId: "node-a",
        };
        const result = await new WorkerMeshCapabilityRuntime([binding], exchange).runNext(input);
        expect(result).toMatchObject({
          status: "settled",
          receipt: { disposition },
          manualReconciliationRequired: disposition === "unknown",
        });
        expect(JSON.parse((await createFileWorkerDurableState(root).read(journalKey))!).receipts[0].nativeWorkspace.workspace)
          .toEqual(admittedLaunch.protectedWorkspace);
        expect(JSON.stringify(result)).not.toContain("private-cells");
        const restart = new WorkerMeshCapabilityRuntime([binding], exchange).runNext({
          ...input,
          state: createFileWorkerDurableState(root),
        });
        if (disposition === "unknown") await expect(restart).rejects.toThrow();
        else await expect(restart).resolves.toEqual({ status: "idle" });
        expect(nativeStart).toHaveBeenCalledTimes(1);
      } finally {
        expect(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}goat-mcp-stdio-journal-`)).toBe(true);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
