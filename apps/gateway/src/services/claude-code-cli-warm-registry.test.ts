import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessage, ChatCompletionRequest } from "@goatcitadel/contracts";
import { createAssistantToolCallMessage } from "./chat-turn-agent-runner/provider-message-helpers.js";
import type { ClaudeCliParkDrain, ClaudeCliSession } from "./claude-code-cli-session.js";
import { buildClaudeCliToolManifest } from "./claude-code-cli-tool-bridge.js";
import { fingerprintClaudeCliStep, type ClaudeCliEmittedAssistant } from "./claude-code-cli-warm-match.js";
import {
  CLAUDE_CLI_WARM_PARK_DEADLINE_MS,
  ClaudeCliWarmRegistry,
  type ParkedClaudeCliStep,
} from "./claude-code-cli-warm-registry.js";

const warn = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock("@goatcitadel/gateway-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@goatcitadel/gateway-core")>();
  const spy = { warn, info, debug: vi.fn(), error: vi.fn() };
  return { ...actual, logger: { ...actual.logger, child: () => ({ ...spy, child: () => spy }) } };
});

const MODEL = "claude-haiku-5-5";
const ID_A = "toolu_01A";
const MANIFEST = buildClaudeCliToolManifest([
  { type: "function", function: { name: "notes_echo", description: "Echo", parameters: {} } },
]);
const BASE_MESSAGES: ChatCompletionMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "Echo once." },
];
const EMITTED: ClaudeCliEmittedAssistant = {
  text: "Calling a tool.",
  calls: [{ id: ID_A, name: "notes_echo", arguments: '{"text":"a"}' }],
};
const heartbeat = JSON.stringify({ type: "tool_progress", heartbeat: true });

const requestOf = (messages: ChatCompletionMessage[]): ChatCompletionRequest =>
  ({ model: MODEL, messages, tool_choice: "auto", parallel_tool_calls: true }) as ChatCompletionRequest;

const fingerprintOf = (messages: ChatCompletionMessage[], sessionId = "s1", turnId = "t1") =>
  fingerprintClaudeCliStep({
    request: requestOf(messages),
    attribution: { sessionId, turnId },
    model: MODEL,
    system: "You are helpful.",
    manifest: MANIFEST,
  })!;

const continuation = (resultText = "echoed a"): ChatCompletionMessage[] => [
  ...BASE_MESSAGES,
  createAssistantToolCallMessage({
    content: EMITTED.text,
    toolCalls: EMITTED.calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  }),
  { role: "tool", tool_call_id: ID_A, content: resultText } as ChatCompletionMessage,
];

interface FakeSession {
  session: ClaudeCliSession;
  kill: ReturnType<typeof vi.fn>;
  /** Feeds one stdout line to the installed drain, faulting the park as the real session does. */
  emit(line: string): "ok" | "fault";
  /** The CLI exits while parked. */
  exit(): void;
}

function fakeSession(): FakeSession {
  let drain: ClaudeCliParkDrain | undefined;
  let onFault: ((reason: "line" | "exit") => void) | undefined;
  const kill = vi.fn(async () => {
    drain = undefined;
    onFault = undefined;
  });
  const session: ClaudeCliSession = {
    pid: 4242,
    exited: new Promise(() => undefined),
    segment: vi.fn(),
    park: vi.fn((nextDrain: ClaudeCliParkDrain, nextOnFault: (reason: "line" | "exit") => void) => {
      drain = nextDrain;
      onFault = nextOnFault;
    }),
    kill,
  };
  return {
    session,
    kill,
    emit(line) {
      if (!drain) throw new Error("not parked");
      const verdict = drain(line);
      if (verdict === "fault") {
        const fault = onFault;
        drain = undefined;
        onFault = undefined;
        fault?.("line");
      }
      return verdict;
    },
    exit() {
      const fault = onFault;
      drain = undefined;
      onFault = undefined;
      fault?.("exit");
    },
  };
}

function stepOf(
  fake: FakeSession,
  overrides: { sessionId?: string; turnId?: string; runDir?: string; turnSignal?: AbortSignal } = {},
): ParkedClaudeCliStep {
  return {
    session: fake.session,
    runDir: overrides.runDir ?? `/scratch/run-${overrides.sessionId ?? "s1"}`,
    manifest: MANIFEST,
    fingerprint: fingerprintOf(BASE_MESSAGES, overrides.sessionId, overrides.turnId),
    emitted: EMITTED,
    pendingIds: [ID_A],
    ...(overrides.turnSignal ? { turnSignal: overrides.turnSignal } : {}),
  };
}

/** Lets the reaps a timer or listener started (not awaited by anyone) finish. */
const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe("ClaudeCliWarmRegistry", () => {
  let removeRunDir: ReturnType<typeof vi.fn<(dir: string) => Promise<void>>>;
  let registry: ClaudeCliWarmRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    warn.mockReset();
    info.mockReset();
    removeRunDir = vi.fn(async () => undefined);
    registry = new ClaudeCliWarmRegistry({ removeRunDir, claudeProjectsDir: () => undefined });
  });

  afterEach(async () => {
    await registry.reapAll("shutdown");
    vi.useRealTimers();
  });

  it("take hits only for the same session and turn", () => {
    const first = fakeSession();
    const second = fakeSession();
    const stepOne = stepOf(first, { sessionId: "s1" });
    const stepTwo = stepOf(second, { sessionId: "s2" });
    registry.park(stepOne);
    registry.park(stepTwo);
    expect(registry.size).toBe(2);

    const takeTwo = registry.take(fingerprintOf(continuation(), "s2"), requestOf(continuation()));
    expect(takeTwo).toEqual({ hit: true, step: stepTwo, results: [{ toolUseId: ID_A, text: "echoed a" }] });
    const takeOne = registry.take(fingerprintOf(continuation(), "s1"), requestOf(continuation()));
    expect(takeOne).toMatchObject({ hit: true, step: stepOne });

    expect(registry.size).toBe(0);
    expect(first.kill).not.toHaveBeenCalled();
    expect(second.kill).not.toHaveBeenCalled();
    // Nothing parked for another turn of the same session: no reason.
    expect(registry.take(fingerprintOf(continuation(), "s1", "t2"), requestOf(continuation()))).toEqual({
      hit: false,
    });
  });

  it("a hit hands the entry over: its deadline and turn signal no longer reap it", async () => {
    const fake = fakeSession();
    const controller = new AbortController();
    registry.park(stepOf(fake, { turnSignal: controller.signal }));
    expect(registry.take(fingerprintOf(continuation()), requestOf(continuation()))).toMatchObject({ hit: true });

    controller.abort();
    await vi.advanceTimersByTimeAsync(CLAUDE_CLI_WARM_PARK_DEADLINE_MS);
    expect(fake.kill).not.toHaveBeenCalled();
    expect(removeRunDir).not.toHaveBeenCalled();
  });

  it("a miss for the same session and turn reaps the parked entry before returning", async () => {
    const fake = fakeSession();
    registry.park(stepOf(fake));
    const changed = [
      ...BASE_MESSAGES.slice(0, 1),
      { role: "user", content: "Something else." },
      ...continuation().slice(2),
    ];

    const result = registry.take(
      fingerprintOf(changed as ChatCompletionMessage[]),
      requestOf(changed as ChatCompletionMessage[]),
    );

    expect(result).toEqual({ hit: false, reason: "warm_miss_messages" });
    expect(registry.size).toBe(0);
    expect(fake.kill).toHaveBeenCalledTimes(1);
    await settle();
    expect(removeRunDir).toHaveBeenCalledWith("/scratch/run-s1");
    expect(warn).toHaveBeenCalledWith(expect.any(String), { reason: "warm_miss_messages" });
  });

  it("turn signal abort reaps at once", async () => {
    const fake = fakeSession();
    const controller = new AbortController();
    registry.park(stepOf(fake, { turnSignal: controller.signal }));

    controller.abort();
    await settle();

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(removeRunDir).toHaveBeenCalledWith("/scratch/run-s1");
    expect(registry.size).toBe(0);
  });

  it("an already aborted turn signal reaps on park", async () => {
    const fake = fakeSession();
    const controller = new AbortController();
    controller.abort();
    registry.park(stepOf(fake, { turnSignal: controller.signal }));
    await settle();

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it("the deadline reaps after 600_000 ms", async () => {
    const fake = fakeSession();
    registry.park(stepOf(fake));

    await vi.advanceTimersByTimeAsync(CLAUDE_CLI_WARM_PARK_DEADLINE_MS - 1);
    expect(fake.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(removeRunDir).toHaveBeenCalledWith("/scratch/run-s1");
    expect(registry.size).toBe(0);
    expect(registry.take(fingerprintOf(continuation()), requestOf(continuation()))).toEqual({
      hit: false,
      reason: "warm_miss_expired",
    });
  });

  it("an entry past its deadline misses with warm_miss_expired even before its timer fires", async () => {
    let clock = 1_000;
    const timed = new ClaudeCliWarmRegistry({ removeRunDir, claudeProjectsDir: () => undefined, now: () => clock });
    const fake = fakeSession();
    timed.park(stepOf(fake));
    clock += CLAUDE_CLI_WARM_PARK_DEADLINE_MS;

    expect(timed.take(fingerprintOf(continuation()), requestOf(continuation()))).toEqual({
      hit: false,
      reason: "warm_miss_expired",
    });
    expect(fake.kill).toHaveBeenCalledTimes(1);
    await timed.reapAll("shutdown");
  });

  it("a fourth park evicts the oldest", async () => {
    const fakes = [fakeSession(), fakeSession(), fakeSession(), fakeSession()];
    fakes.forEach((fake, index) => {
      registry.park(stepOf(fake, { sessionId: `s${index}` }));
      vi.advanceTimersByTime(1);
    });
    await settle();

    expect(registry.size).toBe(3);
    expect(fakes[0]!.kill).toHaveBeenCalledTimes(1);
    expect(removeRunDir).toHaveBeenCalledWith("/scratch/run-s0");
    for (const fake of fakes.slice(1)) expect(fake.kill).not.toHaveBeenCalled();
  });

  it("a heartbeat keeps it parked; any other line poisons it, and a later take misses with warm_miss_poisoned", async () => {
    const fake = fakeSession();
    registry.park(stepOf(fake));

    expect(fake.emit(heartbeat)).toBe("ok");
    expect(registry.size).toBe(1);
    expect(fake.kill).not.toHaveBeenCalled();

    expect(fake.emit(JSON.stringify({ type: "stream_event", event: { type: "message_start" } }))).toBe("fault");
    await settle();
    expect(registry.size).toBe(0);
    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(removeRunDir).toHaveBeenCalledWith("/scratch/run-s1");

    expect(registry.take(fingerprintOf(continuation()), requestOf(continuation()))).toEqual({
      hit: false,
      reason: "warm_miss_poisoned",
    });
    // The tombstone is consumed by that take.
    expect(registry.take(fingerprintOf(continuation()), requestOf(continuation()))).toEqual({ hit: false });
  });

  it("a non-JSON line poisons, and an unexpected tool_result also logs an unattributed call", async () => {
    const garbled = fakeSession();
    registry.park(stepOf(garbled, { sessionId: "s1" }));
    expect(garbled.emit("not json")).toBe("fault");

    const echoed = fakeSession();
    registry.park(stepOf(echoed, { sessionId: "s2" }));
    const toolResult = {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: ID_A, content: "secret text" }] },
    };
    expect(echoed.emit(JSON.stringify(toolResult))).toBe("fault");
    await settle();

    const unattributed = warn.mock.calls.filter(([message]) => message === "claude_cli_warm_unattributed_call");
    expect(unattributed).toHaveLength(1);
    expect(JSON.stringify(unattributed)).not.toContain("secret text");
    expect(JSON.stringify(unattributed)).not.toContain("/scratch");
  });

  it("an exit while parked misses with warm_miss_exited", async () => {
    const fake = fakeSession();
    registry.park(stepOf(fake));
    fake.exit();
    await settle();

    expect(registry.size).toBe(0);
    expect(removeRunDir).toHaveBeenCalledWith("/scratch/run-s1");
    expect(registry.take(fingerprintOf(continuation()), requestOf(continuation()))).toEqual({
      hit: false,
      reason: "warm_miss_exited",
    });
  });

  it("reap is idempotent per entry and never throws", async () => {
    const fake = fakeSession();
    fake.kill.mockRejectedValueOnce(new Error("boom"));
    removeRunDir.mockRejectedValueOnce(new Error("busy"));
    const step = stepOf(fake);
    registry.park(step);

    await expect(registry.reap(step, "resumed_failure")).resolves.toBeUndefined();
    await registry.reap(step, "resumed_failure");

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(removeRunDir).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it("reapAll kills every entry", async () => {
    const fakes = [fakeSession(), fakeSession(), fakeSession()];
    fakes.forEach((fake, index) => registry.park(stepOf(fake, { sessionId: `s${index}` })));

    await registry.reapAll("shutdown");

    expect(registry.size).toBe(0);
    for (const fake of fakes) expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(removeRunDir).toHaveBeenCalledTimes(3);
  });
});

describe("ClaudeCliWarmRegistry spill check", () => {
  let projectsDir: string;

  beforeEach(async () => {
    warn.mockReset();
    projectsDir = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-warm-spill-"));
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
  });

  it("the spill check logs counts and deletes nothing", async () => {
    const runDir = path.join(os.tmpdir(), "goatcitadel-claude-cli", "run-AbC123");
    const slug = runDir.replace(/[^A-Za-z0-9]/g, "-");
    const spillDir = path.join(projectsDir, slug, "session-1", "tool-results");
    await mkdir(spillDir, { recursive: true });
    await writeFile(path.join(spillDir, "one.txt"), "12345");
    await writeFile(path.join(spillDir, "two.txt"), "123");
    await writeFile(path.join(projectsDir, slug, "session-1.jsonl"), "not a spill");
    const registry = new ClaudeCliWarmRegistry({
      removeRunDir: async () => undefined,
      claudeProjectsDir: () => projectsDir,
    });
    const fake = fakeSession();
    const step = { ...stepOf(fake), runDir };
    registry.park(step);

    await registry.reap(step, "deadline");

    expect(warn).toHaveBeenCalledWith("claude_cli_warm_spill_detected", { files: 2, bytes: 8 });
    expect((await readdir(spillDir)).sort()).toEqual(["one.txt", "two.txt"]);
  });

  it("logs nothing when the slug folder has no tool results", async () => {
    const registry = new ClaudeCliWarmRegistry({
      removeRunDir: async () => undefined,
      claudeProjectsDir: () => projectsDir,
    });
    const fake = fakeSession();
    const step = stepOf(fake);
    registry.park(step);

    await registry.reap(step, "deadline");

    expect(warn.mock.calls.some(([message]) => message === "claude_cli_warm_spill_detected")).toBe(false);
  });
});
