import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { ModelUsageAccountingService } from "@goatcitadel/gateway-core";
import { vi, type Mock } from "vitest";
import type { ClaudeCliSpawn } from "../services/claude-code-cli-process.js";
import { ClaudeCodeCliReadiness } from "../services/claude-code-cli-readiness.js";

/**
 * A fake `claude -p` for tool-bridge tests. It records argv, stdin and the bridge
 * files at spawn time, then plays one script per spawn. A tool step reports the
 * bridged tools, stops for tool_use and keeps stdout open like the real CLI does
 * while it waits on the inert stub, so the adapter must end the step itself.
 */

export interface FakeClaudeCliSpawnRecord {
  args: string[];
  stdin: () => string;
  mcpConfigAtSpawn?: Record<string, unknown>;
  toolsFileAtSpawn?: Record<string, unknown>;
  systemPromptAtSpawn?: string;
}

export interface FakeClaudeCliChild {
  stdout: PassThrough;
  stderr: PassThrough;
  exit: (code: number | null) => void;
}

export type FakeClaudeCliScript = (child: FakeClaudeCliChild, spawned: FakeClaudeCliSpawnRecord) => void;

export interface FakeClaudeCliCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export const FAKE_CLAUDE_CLI_STUB_PATH = path.join(os.tmpdir(), "gc-test-stub", "claude-code-cli-mcp-stub.js");
export const FAKE_CLAUDE_CLI_NODE_PATH = path.join(os.tmpdir(), "gc-test-node", "node.exe");

export const line = (value: unknown) => `${JSON.stringify(value)}\n`;
export const streamEvent = (event: Record<string, unknown>) => line({ type: "stream_event", event });

/** Bare tool names the step's tools.json served, or undefined for an unbridged step. */
export function manifestToolNames(spawned: FakeClaudeCliSpawnRecord): string[] | undefined {
  const tools = spawned.toolsFileAtSpawn?.tools;
  return Array.isArray(tools) ? tools.map((tool) => String((tool as { name?: unknown }).name)) : undefined;
}

export function bridgedInit(toolNames: readonly string[]): string {
  return line({
    type: "system",
    subtype: "init",
    tools: toolNames.map((name) => `mcp__goatcitadel__${name}`),
    mcp_servers: [{ name: "goatcitadel", status: "connected" }],
  });
}

/** The init a real CLI would print for this spawn: the bridged tools when bridged, a bare init otherwise. */
function initFor(spawned: FakeClaudeCliSpawnRecord, toolNames?: readonly string[]): string {
  const names = toolNames ?? manifestToolNames(spawned);
  return names ? bridgedInit(names) : line({ type: "system", subtype: "init" });
}

/** A text answer that ends the step with a result line and exit 0. */
export function textStepScript(text: string): FakeClaudeCliScript {
  return ({ stdout, exit }, spawned) => {
    stdout.write(initFor(spawned));
    stdout.write(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
    stdout.write(
      line({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, output_tokens: 1 } }),
    );
    exit(0);
  };
}

export const helloScript: FakeClaudeCliScript = textStepScript("hello");

/**
 * Modeled on the live probe: init, one message with tool_use blocks, tool_use stop, then no exit.
 * `toolNames` undefined echoes the spawn's own manifest, as the real CLI would.
 */
export function toolStepScript(
  toolNames: readonly string[] | undefined,
  calls: readonly FakeClaudeCliCall[],
  options: { stop?: boolean } = {},
): FakeClaudeCliScript {
  return ({ stdout }, spawned) => {
    stdout.write(initFor(spawned, toolNames));
    writeToolMessage(stdout, calls, options);
  };
}

/** One model message with tool_use blocks; with `stop` (the default) it ends at a tool_use stop and a heartbeat. */
function writeToolMessage(
  stdout: PassThrough,
  calls: readonly FakeClaudeCliCall[],
  options: { stop?: boolean } = {},
): void {
  stdout.write(streamEvent({ type: "message_start", message: { usage: { input_tokens: 2 } } }));
  calls.forEach((call, index) => {
    const name = `mcp__goatcitadel__${call.name}`;
    stdout.write(
      streamEvent({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name, input: {} },
      }),
    );
    stdout.write(
      streamEvent({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
      }),
    );
    stdout.write(
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: call.id, name, input: call.input }] },
      }),
    );
    stdout.write(streamEvent({ type: "content_block_stop", index }));
  });
  if (options.stop === false) return;
  stdout.write(
    streamEvent({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 5, output_tokens: 9 },
    }),
  );
  stdout.write(streamEvent({ type: "message_stop" }));
  // A heartbeat after the stop is ignored; the CLI never exits on its own here.
  stdout.write(line({ type: "tool_progress", heartbeat: true }));
}

/** What a warm continuation segment plays once every pending result is staged. */
export type FakeClaudeCliSegment = { calls: readonly FakeClaudeCliCall[] } | { text: string };

export interface FakeClaudeCliStaging {
  /** Every result file the fake CLI accepted, as `<toolUseId>.json`, in order. */
  read: string[];
}

const RESULT_POLL_MS = 5;

/**
 * A process that parks like the real CLI: one tool step, then, per segment, it echoes each
 * pending call's result back as a `tool_result` as soon as the Gateway stages that call's file
 * (checking the step's nonce, like the stub), and once all are echoed it plays the segment. A text
 * segment ends with a result line and exit 0; a tool segment stops for tool_use again.
 */
export function warmToolStepScript(
  calls: readonly FakeClaudeCliCall[],
  segments: readonly FakeClaudeCliSegment[],
  staging: FakeClaudeCliStaging = { read: [] },
): FakeClaudeCliScript {
  return ({ stdout, exit }, spawned) => {
    stdout.write(initFor(spawned));
    writeToolMessage(stdout, calls);
    const configPath = spawned.args[spawned.args.indexOf("--mcp-config") + 1] as string;
    const resultsDir = path.join(path.dirname(configPath), "results");
    const nonce = spawned.toolsFileAtSpawn?.nonce;
    let pending = calls.map((call) => call.id);
    let remaining = [...segments];
    const timer = setInterval(() => {
      if (stdout.writableEnded) {
        clearInterval(timer);
        return;
      }
      // Like the CLI: each call is answered, and echoed, in order, as soon as its own result is staged.
      while (pending.length > 0) {
        const id = pending[0] as string;
        const text = readStagedResult(resultsDir, id, nonce);
        if (text === undefined) return;
        staging.read.push(`${id}.json`);
        stdout.write(toolResultEcho(id, text));
        pending = pending.slice(1);
      }
      const [segment, ...rest] = remaining;
      remaining = rest;
      if (segment && "calls" in segment) {
        writeToolMessage(stdout, segment.calls);
        pending = segment.calls.map((call) => call.id);
        return;
      }
      clearInterval(timer);
      if (!segment) return;
      stdout.write(streamEvent({ type: "message_start", message: { usage: { input_tokens: 3 } } }));
      stdout.write(
        streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: segment.text } }),
      );
      stdout.write(streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }));
      stdout.write(streamEvent({ type: "message_stop" }));
      stdout.write(
        line({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 3, output_tokens: 4 } }),
      );
      exit(0);
    }, RESULT_POLL_MS);
    timer.unref();
  };
}

function readStagedResult(resultsDir: string, toolUseId: string, nonce: unknown): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(resultsDir, `${toolUseId}.json`), "utf8")) as Record<
      string,
      unknown
    >;
    const ours = parsed.nonce === nonce && parsed.toolUseId === toolUseId && typeof parsed.text === "string";
    return ours ? (parsed.text as string) : undefined;
  } catch {
    return undefined;
  }
}

/** The CLI's echo of a delivered result, in the shape Claude Code 2.1.305 prints. */
function toolResultEcho(toolUseId: string, text: string): string {
  return line({
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: toolUseId, type: "tool_result", content: [{ type: "text", text }] }],
    },
    parent_tool_use_id: null,
  });
}

function readJson(filePath: string | undefined): Record<string, unknown> | undefined {
  return filePath ? (JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>) : undefined;
}

export interface FakeClaudeCliHarness {
  spawns: FakeClaudeCliSpawnRecord[];
  spawn: Mock<ClaudeCliSpawn>;
  killTree: Mock<(pid: number) => void>;
  readiness: ClaudeCodeCliReadiness;
}

/** Plays `scripts[n]` for the n-th spawn; spawns past the end answer "hello". */
export function createFakeClaudeCliHarness(scripts: FakeClaudeCliScript[]): FakeClaudeCliHarness {
  const spawns: FakeClaudeCliSpawnRecord[] = [];
  const exitsByPid = new Map<number, (code: number | null) => void>();
  // Like a real tree kill, the killed fake child closes (stdout ends, then "close").
  const killTree = vi.fn<(pid: number) => void>((pid) => exitsByPid.get(pid)?.(null));
  const spawn = vi.fn<ClaudeCliSpawn>((_command, args) => {
    const emitter = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    Object.assign(emitter, { stdout, stderr, stdin, pid: 7000 + spawns.length, exitCode: null });
    const configIndex = args.indexOf("--mcp-config");
    const mcpConfigAtSpawn = readJson(configIndex >= 0 ? args[configIndex + 1] : undefined);
    const server = (mcpConfigAtSpawn?.mcpServers as Record<string, { args?: string[] }> | undefined)?.goatcitadel;
    const systemIndex = args.indexOf("--system-prompt-file");
    const spawned: FakeClaudeCliSpawnRecord = {
      args,
      stdin: () => Buffer.concat(chunks).toString("utf8"),
      mcpConfigAtSpawn,
      toolsFileAtSpawn: readJson(server?.args?.[1]),
      systemPromptAtSpawn: systemIndex >= 0 ? readFileSync(args[systemIndex + 1] as string, "utf8") : undefined,
    };
    spawns.push(spawned);
    const script = scripts[spawns.length - 1] ?? helloScript;
    let exited = false;
    const exit = (code: number | null) => {
      if (exited) return;
      exited = true;
      Object.assign(emitter, { exitCode: code });
      stdout.end();
      stderr.end();
      setImmediate(() => emitter.emit("close", code, null));
    };
    exitsByPid.set(emitter.pid as number, exit);
    setImmediate(() => script({ stdout, stderr, exit }, spawned));
    return emitter;
  });
  const readiness = new ClaudeCodeCliReadiness({
    run: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
    }),
  });
  return { spawns, spawn, killTree, readiness };
}

type AsyncMock = Mock<(...args: unknown[]) => Promise<void>>;

export interface FakeModelUsageHandle {
  eventId: string;
  renewLease: AsyncMock;
  observe: Mock<(...args: unknown[]) => void>;
  observeNormalized: Mock<(...args: unknown[]) => void>;
  succeed: AsyncMock;
  fail: AsyncMock;
  cancel: AsyncMock;
}

export interface FakeModelUsageAccounting {
  handle: FakeModelUsageHandle;
  prepareDispatch: Mock<(...args: unknown[]) => Promise<unknown>>;
  service: ModelUsageAccountingService;
}

/** Usage accounting that accepts every dispatch, so tests can count settle calls. */
export function createFakeModelUsageAccounting(): FakeModelUsageAccounting {
  const asyncMock = (): AsyncMock => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
  const handle: FakeModelUsageHandle = {
    eventId: "usage-event-bridge",
    renewLease: asyncMock(),
    observe: vi.fn<(...args: unknown[]) => void>(),
    observeNormalized: vi.fn<(...args: unknown[]) => void>(),
    succeed: asyncMock(),
    fail: asyncMock(),
    cancel: asyncMock(),
  };
  const prepareDispatch = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    eventId: handle.eventId,
    accept: async () => handle,
    abandon: async () => undefined,
    markDispatchUnknown: async () => undefined,
  }));
  return { handle, prepareDispatch, service: { prepareDispatch } as unknown as ModelUsageAccountingService };
}
