import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { ClaudeCliSession } from "./claude-code-cli-session.js";
import type { ClaudeCliToolManifest } from "./claude-code-cli-tool-bridge.js";
import {
  matchClaudeCliWarmContinuation,
  type ClaudeCliEmittedAssistant,
  type ClaudeCliWarmFingerprint,
  type ClaudeCliWarmMissReason,
} from "./claude-code-cli-warm-match.js";

/** How long a parked `claude -p` process may wait for its tool result before it is reaped. */
export const CLAUDE_CLI_WARM_PARK_DEADLINE_MS = 600_000;
/** The most parked processes held at once. */
export const CLAUDE_CLI_WARM_MAX_PARKED = 3;
/** The largest tool result (JS `string.length`) handed back to a parked process. */
export const CLAUDE_CLI_WARM_RESULT_MAX_CHARS = 40_000;
/** `MCP_TOOL_TIMEOUT` for a bridged step: the park deadline plus a minute of slack. */
export const CLAUDE_CLI_WARM_MCP_TOOL_TIMEOUT_MS = CLAUDE_CLI_WARM_PARK_DEADLINE_MS + 60_000;
/**
 * How long a resumed step waits, after staging, for the CLI to echo every delivered result.
 * Park deadline plus this stays under MCP_TOOL_TIMEOUT, so the CLI's own tool timeout never fires first.
 */
export const CLAUDE_CLI_WARM_ECHO_DEADLINE_MS = 30_000;

const log = logger.child("claude-code-cli-warm-registry");

/** A bridged step whose `claude -p` process waits, parked, for the runner's tool results. */
export interface ParkedClaudeCliStep {
  session: ClaudeCliSession;
  runDir: string;
  manifest: ClaudeCliToolManifest;
  fingerprint: ClaudeCliWarmFingerprint;
  emitted: ClaudeCliEmittedAssistant;
  pendingIds: readonly string[];
  turnSignal?: AbortSignal;
}

/** `resumed_done`: a resumed step ended without parking again; its owner releases what is left. */
export type ClaudeCliWarmReapReason =
  | "deadline"
  | "cap"
  | "miss"
  | "fault"
  | "abort"
  | "shutdown"
  | "resumed_failure"
  | "resumed_done";

export type ClaudeCliWarmTake =
  | { hit: true; step: ParkedClaudeCliStep; results: ReadonlyArray<{ toolUseId: string; text: string }> }
  | { hit: false; reason?: ClaudeCliWarmMissReason };

export interface ClaudeCliWarmRegistryOptions {
  removeRunDir: (dir: string) => Promise<void>;
  /** The operator's Claude projects folder, checked (never written) for spilled tool results on reap. */
  claudeProjectsDir: () => string | undefined;
  now?: () => number;
  maxParked?: number;
  parkDeadlineMs?: number;
}

interface WarmEntry {
  key: string;
  step: ParkedClaudeCliStep;
  parkedAt: number;
  timer: NodeJS.Timeout;
  detachSignal: () => void;
}

/** Why an entry for a session and turn went away before its continuation arrived. */
type WarmTombstone = "warm_miss_expired" | "warm_miss_poisoned" | "warm_miss_exited";

const TOOL_RESULTS_DIR = "tool-results";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyOf(fingerprint: Pick<ClaudeCliWarmFingerprint, "sessionId" | "turnId">): string {
  return JSON.stringify([fingerprint.sessionId, fingerprint.turnId]);
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code.slice(0, 32) : "unknown";
}

function countToolResultBlocks(parsed: unknown): number {
  if (!isRecord(parsed) || parsed.type !== "user" || !isRecord(parsed.message)) return 0;
  const content = parsed.message.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => isRecord(block) && block.type === "tool_result").length;
}

/** While parked only heartbeats are expected; any other line means the CLI moved on without us. */
function drainParkedLine(line: string): "ok" | "fault" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "fault";
  }
  if (isRecord(parsed) && parsed.type === "tool_progress") return "ok";
  const toolResults = countToolResultBlocks(parsed);
  // A tool result we never delivered: the CLI may already have a model call in flight.
  if (toolResults > 0) log.warn("claude_cli_warm_unattributed_call", { toolResults });
  return "fault";
}

/** Files (and their bytes) under any `tool-results` folder below dir; zero when dir is missing. */
async function countSpilledToolResults(dir: string): Promise<{ files: number; bytes: number }> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { files: 0, bytes: 0 };
    throw error;
  }
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!path.relative(dir, entry.parentPath).split(path.sep).includes(TOOL_RESULTS_DIR)) continue;
    files += 1;
    bytes += (await stat(path.join(entry.parentPath, entry.name))).size;
  }
  return { files, bytes };
}

/** Owns the parked `claude -p` processes between a bridged tool step and its continuation. */
export class ClaudeCliWarmRegistry {
  private readonly entries = new Map<string, WarmEntry>();
  private readonly tombstones = new Map<string, WarmTombstone>();
  /** One reap per step; a second reap() of the same step awaits the first. */
  private readonly reaping = new WeakMap<ParkedClaudeCliStep, Promise<void>>();
  /** Reaps still running, so reapAll() can wait for the ones a timer, miss or fault started. */
  private readonly pending = new Set<Promise<void>>();
  /** Set once reapAll() starts: the Gateway is shutting down and nothing parks again. */
  private closed = false;
  private readonly removeRunDir: (dir: string) => Promise<void>;
  private readonly claudeProjectsDir: () => string | undefined;
  private readonly now: () => number;
  private readonly maxParked: number;
  private readonly parkDeadlineMs: number;

  constructor(options: ClaudeCliWarmRegistryOptions) {
    this.removeRunDir = options.removeRunDir;
    this.claudeProjectsDir = options.claudeProjectsDir;
    this.now = options.now ?? Date.now;
    this.maxParked = options.maxParked ?? CLAUDE_CLI_WARM_MAX_PARKED;
    this.parkDeadlineMs = options.parkDeadlineMs ?? CLAUDE_CLI_WARM_PARK_DEADLINE_MS;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Parks the step's session: evicts the oldest entry at the cap, starts the deadline,
   * listens to the turn signal, and installs the heartbeat-only drain.
   */
  park(step: ParkedClaudeCliStep): void {
    if (this.closed) {
      void this.reap(step, "shutdown");
      return;
    }
    // A reaped step's session is dead and its run dir gone; it can never wait again.
    if (this.reaping.has(step)) return;
    const key = keyOf(step.fingerprint);
    // First, so a session that cannot park throws before anything else is evicted.
    step.session.park(drainParkedLine, (reason) => this.onParkFault(step, reason));
    this.tombstones.delete(key);
    const previous = this.entries.get(key);
    if (previous) void this.reap(previous.step, "miss");
    while (this.entries.size >= this.maxParked) {
      const oldest = this.oldestEntry();
      if (!oldest) break;
      void this.reap(oldest.step, "cap");
    }

    const timer = setTimeout(() => {
      this.tombstone(key, "warm_miss_expired");
      void this.reap(step, "deadline");
    }, this.parkDeadlineMs);
    timer.unref?.();
    const onAbort = () => void this.reap(step, "abort");
    step.turnSignal?.addEventListener("abort", onAbort, { once: true });
    this.entries.set(key, {
      key,
      step,
      parkedAt: this.now(),
      timer,
      detachSignal: () => step.turnSignal?.removeEventListener("abort", onAbort),
    });
    if (step.turnSignal?.aborted) onAbort();
  }

  /**
   * Hands over the parked step for next's session and turn when the request continues it;
   * the caller then owns its session and run dir. A non-matching entry is reaped first.
   */
  take(next: ClaudeCliWarmFingerprint, request: ChatCompletionRequest): ClaudeCliWarmTake {
    const key = keyOf(next);
    const entry = this.entries.get(key);
    if (!entry) {
      const tombstone = this.tombstones.get(key);
      if (!tombstone) return { hit: false };
      this.tombstones.delete(key);
      return this.miss(tombstone);
    }
    if (this.now() - entry.parkedAt >= this.parkDeadlineMs) {
      void this.reap(entry.step, "deadline");
      return this.miss("warm_miss_expired");
    }
    const match = matchClaudeCliWarmContinuation({ parked: entry.step, next, request });
    if (!match.hit) {
      // The kill is issued synchronously, so the tree is signalled before any cold step starts.
      void this.reap(entry.step, "miss");
      return this.miss(match.reason);
    }
    this.detach(entry);
    return { hit: true, step: entry.step, results: match.results };
  }

  /**
   * A request for this session and turn that will not continue warm: reaps its parked entry
   * (the kill is signalled before this returns) and forgets any tombstone for it.
   */
  reapTurn(sessionId: string, turnId: string): Promise<void> {
    const key = keyOf({ sessionId, turnId });
    this.tombstones.delete(key);
    const entry = this.entries.get(key);
    return entry ? this.reap(entry.step, "miss") : Promise.resolve();
  }

  /** Kills the tree, removes the run dir, then checks for spilled tool results. Idempotent; never throws. */
  reap(step: ParkedClaudeCliStep, reason: ClaudeCliWarmReapReason): Promise<void> {
    // Detach first, unconditionally, so a registered step always leaves the map (cap eviction relies on it).
    const entry = this.entries.get(keyOf(step.fingerprint));
    if (entry?.step === step) this.detach(entry);
    const running = this.reaping.get(step);
    if (running) return running;
    const reaped = this.finishReap(step, reason);
    this.reaping.set(step, reaped);
    this.pending.add(reaped);
    void reaped.finally(() => this.pending.delete(reaped));
    return reaped;
  }

  /** Kills every parked process, clears their run directories, and waits for reaps already running. */
  async reapAll(reason: "shutdown"): Promise<void> {
    this.closed = true;
    this.tombstones.clear();
    for (const entry of [...this.entries.values()]) void this.reap(entry.step, reason);
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async finishReap(step: ParkedClaudeCliStep, reason: ClaudeCliWarmReapReason): Promise<void> {
    try {
      await step.session.kill();
    } catch (error) {
      log.warn("Claude Code CLI warm reap kill failed", { reason, code: errorCode(error) });
    }
    try {
      await this.removeRunDir(step.runDir);
    } catch (error) {
      log.warn("Claude Code CLI warm reap run dir cleanup failed", { reason, code: errorCode(error) });
    }
    try {
      await this.checkSpill(step.runDir);
    } catch (error) {
      log.warn("Claude Code CLI warm spill check failed", { reason, code: errorCode(error) });
    }
  }

  private miss(reason: ClaudeCliWarmMissReason): ClaudeCliWarmTake {
    log.warn("claude_cli_warm_miss", { reason });
    return { hit: false, reason };
  }

  /** The session's onFault; it must never throw, because the session does not guard it. */
  private onParkFault(step: ParkedClaudeCliStep, reason: "line" | "exit"): void {
    try {
      const key = keyOf(step.fingerprint);
      // A step already handed over (or reaped) belongs to someone else now.
      if (this.entries.get(key)?.step !== step) return;
      this.tombstone(key, reason === "line" ? "warm_miss_poisoned" : "warm_miss_exited");
      void this.reap(step, "fault");
    } catch (error) {
      log.warn("Claude Code CLI warm fault handling failed", { code: errorCode(error) });
    }
  }

  private detach(entry: WarmEntry): void {
    this.entries.delete(entry.key);
    clearTimeout(entry.timer);
    entry.detachSignal();
  }

  /** Remembers why an entry went away; bounded like the entries themselves. */
  private tombstone(key: string, reason: WarmTombstone): void {
    this.tombstones.delete(key);
    this.tombstones.set(key, reason);
    while (this.tombstones.size > this.maxParked) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
  }

  private oldestEntry(): WarmEntry | undefined {
    let oldest: WarmEntry | undefined;
    for (const entry of this.entries.values()) {
      if (!oldest || entry.parkedAt < oldest.parkedAt) oldest = entry;
    }
    return oldest;
  }

  /** Reports (never deletes) tool results the CLI spilled into the operator's Claude profile. */
  private async checkSpill(runDir: string): Promise<void> {
    const projectsDir = this.claudeProjectsDir();
    if (!projectsDir) return;
    const slug = runDir.replace(/[^A-Za-z0-9]/g, "-");
    const spilled = await countSpilledToolResults(path.join(projectsDir, slug));
    if (spilled.files > 0) log.warn("claude_cli_warm_spill_detected", spilled);
  }
}
