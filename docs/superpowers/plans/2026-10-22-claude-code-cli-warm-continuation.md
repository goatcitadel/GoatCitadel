# Claude Code CLI warm continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** The spec was approved on 2026-10-22: a separate flag off until live proof, a 10-minute park deadline, at most 3 parked processes, and a 40,000-character result gate.

**Goal:** Within one Chat turn, keep a bridged `claude -p` step's process parked while the runner executes its tool calls, then hand the results back to that same process instead of starting a new one. Fall back to today's cold step whenever anything differs.

**Architecture:**
- At a bridged step's tool-use `message_stop`, the adapter parks the live CLI in a per-Gateway registry instead of killing it. A drain watches stdout while it is parked.
- The next step's request is matched against the parked entry by a pure fingerprint. On a hit, the adapter opens the usage attempt, then writes nonce-bound result files that the parking stub delivers to the held `tools/call`s.
- A continuation-mode collector then maps the same process's next model message. On a miss, the entry is reaped and today's cold step runs unchanged.

**Tech Stack:** TypeScript (strict), Node `child_process` and `fs.watch`, newline-delimited JSON-RPC, vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-claude-code-cli-warm-continuation-design.md`. It builds on `docs/superpowers/specs/2026-10-20-claude-code-cli-tool-bridge-design.md`; read both.

## Global Constraints

- **Flag:** `claudeCliWarmContinuationEnabled`, env `GOATCITADEL_FEATURE_CLAUDE_CLI_WARM_CONTINUATION_ENABLED`, default `false` (`?? false`) in every place the bridge flag defaults. It applies only to bridged steps, so it is inert while `claudeCliToolBridgeEnabled` is off. Read per step, never cached.
- **Constants** (one exported `const` each, in `claude-code-cli-warm-registry.ts`):
  - `CLAUDE_CLI_WARM_PARK_DEADLINE_MS = 600_000`
  - `CLAUDE_CLI_WARM_MAX_PARKED = 3`
  - `CLAUDE_CLI_WARM_RESULT_MAX_CHARS = 40_000` (measured as JS `string.length`)
  - `CLAUDE_CLI_WARM_MCP_TOOL_TIMEOUT_MS = CLAUDE_CLI_WARM_PARK_DEADLINE_MS + 60_000`
- **CLI env:** on every bridged step while the warm flag is on, set `MCP_TOOL_TIMEOUT` to `String(CLAUDE_CLI_WARM_MCP_TOOL_TIMEOUT_MS)`. Set it explicitly on the child env; never copy it from the host env, and keep it off the allowlist.
- **Result files:**
  - path `<runDir>/results/<toolUseId>.json`, body `{ "nonce": string, "toolUseId": string, "text": string }`;
  - written as a `.tmp` file and then renamed;
  - `toolUseId` must match `^toolu_[A-Za-z0-9_-]{1,128}$` on both sides, or it is never used as a path.
- **Stub:** still imports only `node:fs` and `node:process`. It still executes nothing and writes nothing to disk. A `tools/call` without `_meta["claudecode/toolUseId"]`, or with an id failing the pattern, is held unanswered (no reply).
- **Ordering:** no result file may exist before the next step's `beginTrackedDispatch` resolves.
- **Miss reasons**, logged once per miss through the module logger as `{ reason }` only:
  - `warm_miss_attribution`, `warm_miss_fingerprint`, `warm_miss_messages`, `warm_miss_assistant`, `warm_miss_ids`;
  - `warm_miss_result_size`, `warm_miss_result_type`;
  - `warm_miss_expired`, `warm_miss_poisoned`, `warm_miss_exited`.
- **Warnings:** `claude_cli_warm_unattributed_call` and `claude_cli_warm_spill_detected`, logged with bounded fields only (counts and byte totals; no paths beyond the run-dir basename, no content).
- **No new reason codes.** Continuation faults use `claude_cli_bridge_mismatch`.
- **Untouched:** no changes to the runner, durable execution, policy or storage. In `gateway-service.ts`, exactly two added lines: the flag option and `await this.llmService.close()`. It is near its line budget; run `pnpm verify:architecture:metrics`.
- **Repo rules:**
  - vitest `--maxWorkers=2`, at low priority, one heavy job at a time;
  - never `git stash`;
  - files under 800 lines (`llm-provider-claude-code-cli.ts` is 537 now, so warm wiring goes in its own module);
  - no `prettier --write` on directory globs;
  - never spoof Claude Code's prompt;
  - no personal paths in tracked files.
- **Branch:** a new branch off `main`. The main checkout holds someone else's uncommitted storage WIP; leave it alone.

## Review Focus

- **Two sessions running the same prompt at the same moment:** their fingerprints are identical, but a step must never resume the other session's process. Test in Task 5.
- **A turn cancelled while its step is parked:** the turn signal aborts with no further request, and the entry must be reaped at once, not after 10 minutes. Test in Task 5.
- **A result with non-ASCII, CRLF or an empty string** (CJK file names, emoji, `""` from a tool with no output): it is delivered byte-identical, and the echo check accepts it. Test in Task 3 (stub) and Task 6 (echo).
- **A run dir whose path has spaces** (for example a temp dir under `C:\Users\Jane Doe\`): the stub finds `results/` and delivers. Test in Task 3.
- **A hostile or odd tool-use id** (`toolu_../../x`, empty, 200 characters): it is never used as a file path. The stub holds it unanswered (no reply), and the match is a miss. Test in Tasks 3 and 4.

---

### Task 1: Feature flag, runtime plumbing and shutdown hook

**Files:**
- Modify: `apps/gateway/src/config.ts`:
  - add `claudeCliWarmContinuationEnabled?: boolean` beside `claudeCliToolBridgeEnabled` (:121);
  - add the env tuple beside :882;
  - add the default `?? false` beside :1509.
- Modify: `apps/gateway/src/services/gateway/feature-flags.ts`: both places that carry the bridge flag (:78, :174), with `?? false`.
- Modify: `apps/gateway/src/services/gateway/runtime-settings.ts:180`, `apps/gateway/src/routes/dashboard.ts:271` (zod `z.boolean().optional()`), `packages/contracts/src/change-plan.ts:168` (add the flag to the list), and `packages/mission-control-shared/src/api/types.ts:636`.
- Modify: `apps/gateway/src/services/llm-service.ts`:
  - add `claudeCliWarmContinuationEnabled?: () => boolean` to `LlmServiceOptions` (:236);
  - add `public async close(): Promise<void>`, which awaits `this.claudeCodeCli.warm.reapAll("shutdown")`.
- Modify: `apps/gateway/src/services/llm-provider-claude-code-cli.ts`:
  - `createClaudeCodeCliRuntime`'s `serviceOptions` gains `claudeCliWarmContinuationEnabled?: () => boolean`;
  - `ClaudeCodeCliRuntime` gains `warmContinuationEnabled(): boolean` (false unless the bridge flag and the warm flag are both on) and `readonly warm: ClaudeCliWarmRegistry`, created in Task 5. Until then, stub it with an interface that has `reapAll`.
- Modify: `apps/gateway/src/services/gateway-service.ts`, exactly two lines:
  - beside :1687, add `claudeCliWarmContinuationEnabled: () => this.config.assistant.features.claudeCliWarmContinuationEnabled === true,`;
  - in `close()` before `await this.storage.close()`, add `await this.llmService.close();`.
- Test: `apps/gateway/src/services/gateway/feature-flags.test.ts`, `apps/gateway/src/services/llm-service.claude-code-cli-capabilities.test.ts`

**Interfaces:**
- Produces:
  - `ClaudeCodeCliRuntime.warmContinuationEnabled(): boolean`;
  - `ClaudeCodeCliRuntime.warm: ClaudeCliWarmRegistry`;
  - `LlmService.close(): Promise<void>`.

- [ ] **Step 1: Write the failing tests.**
  - `feature-flags.test.ts`:
    - "warm continuation defaults off" asserts `claudeCliWarmContinuationEnabled === false` with no config, no env and no stored value;
    - "warm continuation follows a stored true" asserts `true`.
  - `llm-service.claude-code-cli-capabilities.test.ts`: "warm continuation needs both flags" asserts `warmContinuationEnabled()` is `false` for (bridge off, warm on), `false` for (bridge on, warm off), and `true` for (bridge on, warm on). Also assert `toolCalling` is unchanged by the warm flag.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' --maxWorkers=2 'src/services/gateway/feature-flags.test.ts' 'src/services/llm-service.claude-code-cli-capabilities.test.ts'`. Expected: FAIL (property missing).
- [ ] **Step 3: Implement the flag and plumbing listed under Files.**
- [ ] **Step 4: Run the tests again.** Expected: PASS. Also run `pnpm --filter @goatcitadel/contracts build` (package tests read contracts from `dist`).
- [ ] **Step 5: Commit** `feat(gateway): add the claudeCliWarmContinuationEnabled flag (off by default)`.

### Task 2: Resumable CLI process session

**Files:**
- Create: `apps/gateway/src/services/claude-code-cli-session.ts`
- Modify: `apps/gateway/src/services/claude-code-cli-process.ts`. `runClaudeCli` becomes `startClaudeCliSession(input).segment(input)`; its observable behavior (yields, timers, kill-on-close, bounded close wait, error codes) stays identical.
- Test: `apps/gateway/src/services/claude-code-cli-session.test.ts` (new). The existing `claude-code-cli-process.test.ts` must pass unchanged.

**Interfaces:**
- Produces:
  ```ts
  interface ClaudeCliSegmentOptions { signal?: AbortSignal; overallTimeoutMs: number; idleTimeoutMs: number }
  type ClaudeCliParkDrain = (line: string) => "ok" | "fault";
  interface ClaudeCliSession {
    readonly pid: number | undefined;
    readonly exited: Promise<ClaudeCliExit>;
    /** One consumer at a time. Closing it kills the tree, unless park() was called first. */
    segment(options: ClaudeCliSegmentOptions): AsyncGenerator<string, ClaudeCliExit>;
    /** Stops the segment's timers and routes later lines to drain. "fault" or an exit kills the tree. */
    park(drain: ClaudeCliParkDrain, onFault: (reason: "line" | "exit") => void): void;
    /** Tree kill plus the bounded close wait (CLAUDE_CLI_KILL_CLOSE_WAIT_MS). Idempotent. */
    kill(): Promise<void>;
  }
  function startClaudeCliSession(input: RunClaudeCliInput): ClaudeCliSession;
  ```

- [ ] **Step 1: Write the failing tests** with the fake spawn in `apps/gateway/src/test/claude-code-cli-fake-spawn.ts`:
  - "a parked session survives its segment closing": `park()` then `return()` on the generator; `killTree` was not called.
  - "a resumed segment yields lines buffered while parked, after drain accepted them": the drain sees heartbeat lines; lines arriving after `segment()` is called again go to the new segment.
  - "drain fault kills the tree": the drain returns "fault"; `killTree` is called once, and `onFault("line")` fires.
  - "exit while parked reports a fault": `onFault("exit")` fires.
  - "parked time does not count against the next segment's idle timeout": with fake timers, park for 3× `idleTimeoutMs`, then resume; no `claude_cli_timeout`.
  - "kill is idempotent": two calls cause one `killTree`.
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' --maxWorkers=2 'src/services/claude-code-cli-session.test.ts' 'src/services/claude-code-cli-process.test.ts'`. Expected: the new file FAILs, and the process tests PASS.
- [ ] **Step 3: Implement `startClaudeCliSession`** by moving `runClaudeCli`'s child, queue, timer and close logic into the session. Timers and the abort listener belong to a segment. The stdout `data` handler checks whether the session is parked and, if so, calls the drain instead of queueing.
- [ ] **Step 4: Run the same command.** Expected: both files PASS.
- [ ] **Step 5: Commit** `refactor(gateway): run the Claude CLI through a parkable process session`.

### Task 3: Parking stub with result-file delivery

**Files:**
- Modify: `apps/gateway/src/services/claude-code-cli-mcp-stub.ts`
- Modify: `apps/gateway/src/services/claude-code-cli-tool-bridge.ts`. `writeClaudeCliBridgeFiles` also creates `<runDir>/results/` (mode `0o700`).
- Test: `apps/gateway/src/services/claude-code-cli-mcp-stub.test.ts`

**Interfaces:**
- Produces:
  - `CLAUDE_CLI_TOOL_USE_ID_PATTERN = /^toolu_[A-Za-z0-9_-]{1,128}$/`, exported from the stub module;
  - `CLAUDE_CLI_RESULTS_DIR = "results"`;
  - `handleClaudeCliStubLine` now returns `{ reply?: string; hold?: { rpcId: string | number; toolUseId: string } }`;
  - `buildClaudeCliStubCallResult(rpcId, text): string` builds the JSON-RPC success line.

- [ ] **Step 1: Write the failing tests.**
  - "tools/call is held by toolUseId": the handler returns `hold` with the id and no reply.
  - "tools/call without a toolUseId is held unanswered (no reply)".
  - "tools/call with toolu_../../x is held unanswered (no reply)": also covers an empty id and a 200-character id.
  - "a result file staged before the call is delivered when the call arrives" (spawn the real stub with `node`, in a temp dir whose path contains a space).
  - "a result file with the wrong nonce is ignored".
  - "a result file is delivered byte-identical": the text is `"名前 🐐\r\nline2"`, and separately `""`.
  - "the stub still imports only node:fs and node:process": the existing pin test must still pass.
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' --maxWorkers=2 'src/services/claude-code-cli-mcp-stub.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Build `serve()`'s results path by string join with `/` (no `node:path`).
  - Use `fs.watch` on the results dir plus a 100 ms `setInterval` poll (unref'd), plus a check when a call arrives.
  - Read each file once it parses as JSON. Check `nonce` against `tools.json`'s nonce and `toolUseId` against the held call, then answer `{ content: [{ type: "text", text }], isError: false }`.
  - Leave unreadable or partial files for the next poll.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): let the Claude CLI MCP stub deliver staged tool results`.

### Task 4: Warm match (pure)

**Files:**
- Create: `apps/gateway/src/services/claude-code-cli-warm-match.ts`
- Modify: `apps/gateway/src/services/claude-code-cli-stream.ts`: export the existing `renderContent` (:255) unchanged.
- Test: `apps/gateway/src/services/claude-code-cli-warm-match.test.ts`

**Interfaces:**
- Consumes: `ClaudeCliToolManifest.sha256`, `renderClaudeCliPrompt(...).system` and `renderContent` from the stream module, and `createAssistantToolCallMessage` from `chat-turn-agent-runner/provider-message-helpers.ts` (tests only).
- Produces:
  ```ts
  interface ClaudeCliWarmFingerprint {
    sessionId: string; turnId: string; durableRunId?: string; model: string;
    systemSha: string; manifestSha: string; toolChoiceSha: string; parallelToolCalls: boolean | undefined;
    messagesSha: string; messageCount: number;
  }
  interface ClaudeCliEmittedAssistant { text: string; calls: ReadonlyArray<{ id: string; name: string; arguments: string }> }
  type ClaudeCliWarmMissReason = "warm_miss_attribution" | "warm_miss_fingerprint" | "warm_miss_messages"
    | "warm_miss_assistant" | "warm_miss_ids" | "warm_miss_result_size" | "warm_miss_result_type"
    | "warm_miss_expired" | "warm_miss_poisoned" | "warm_miss_exited";
  function fingerprintClaudeCliStep(input: { request: ChatCompletionRequest; attribution: ModelUsageAttributionContext;
    model: string; system: string; manifest: ClaudeCliToolManifest }): ClaudeCliWarmFingerprint | undefined; // undefined without sessionId+turnId
  function matchClaudeCliWarmContinuation(input: { parked: { fingerprint: ClaudeCliWarmFingerprint; emitted: ClaudeCliEmittedAssistant; pendingIds: readonly string[] };
    next: ClaudeCliWarmFingerprint; request: ChatCompletionRequest }):
    | { hit: true; results: ReadonlyArray<{ toolUseId: string; text: string }> }
    | { hit: false; reason: ClaudeCliWarmMissReason };
  ```
- **Normalization** (used both for `messagesSha` and for the assistant comparison):
  - each message becomes `{ role, content: renderContent(content), tool_call_id?, tool_calls?: [{ id, name: function.name, arguments: function.arguments }] }`;
  - runner-internal keys and provider-native content are dropped.
  - The step N+1 prefix is its first `messageCount` messages; they must hash to `messagesSha`.

- [ ] **Step 1: Write the failing tests.** Build the assistant message with the runner's real `createAssistantToolCallMessage` (internal effect-potential key included), so the test pins the runner's rebuilt shape.
  - "exact continuation hits": the results come back in pending-id order, with the tool message text.
  - "tool messages in a different order still hit".
  - One miss test per reason:
    - extra user message (steering): `warm_miss_messages`;
    - changed system: `warm_miss_fingerprint`;
    - a repair-feedback call with `arguments: "{}"`: `warm_miss_assistant`;
    - a missing tool message: `warm_miss_ids`;
    - an extra tool message: `warm_miss_ids`;
    - a 40,001-character result: `warm_miss_result_size` (and 40,000 hits);
    - an array content result: `warm_miss_result_type`;
    - a different `sessionId`: `warm_miss_attribution`;
    - a pending id failing `CLAUDE_CLI_TOOL_USE_ID_PATTERN`: `warm_miss_ids`.
  - "fingerprint is undefined without turnId".
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' --maxWorkers=2 'src/services/claude-code-cli-warm-match.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement** with `sha256` over the canonical `JSON.stringify` of the normalized form.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): match a Claude CLI tool step to its warm continuation`.

### Task 5: Warm registry: park, take, reap

**Files:**
- Create: `apps/gateway/src/services/claude-code-cli-warm-registry.ts`
- Modify: `apps/gateway/src/services/llm-provider-claude-code-cli.ts`: the runtime creates one registry.
- Test: `apps/gateway/src/services/claude-code-cli-warm-registry.test.ts`

**Interfaces:**
- Consumes: `ClaudeCliSession` (Task 2), and `ClaudeCliWarmFingerprint` and `matchClaudeCliWarmContinuation` (Task 4).
- Produces:
  ```ts
  interface ParkedClaudeCliStep {
    session: ClaudeCliSession; runDir: string; manifest: ClaudeCliToolManifest;
    fingerprint: ClaudeCliWarmFingerprint; emitted: ClaudeCliEmittedAssistant; pendingIds: readonly string[];
    turnSignal?: AbortSignal;
  }
  type ClaudeCliWarmReapReason = "deadline" | "cap" | "miss" | "fault" | "abort" | "shutdown" | "resumed_failure";
  class ClaudeCliWarmRegistry {
    constructor(options: { removeRunDir: (dir: string) => Promise<void>; claudeProjectsDir: () => string | undefined;
      now?: () => number; maxParked?: number; parkDeadlineMs?: number });
    park(step: ParkedClaudeCliStep): void;   // evicts oldest at cap; starts the deadline timer; listens to turnSignal; installs the drain
    take(next: ClaudeCliWarmFingerprint, request: ChatCompletionRequest):
      | { hit: true; step: ParkedClaudeCliStep; results: ReadonlyArray<{ toolUseId: string; text: string }> }
      | { hit: false; reason?: ClaudeCliWarmMissReason }; // no reason when nothing was parked for this session+turn
    reap(step: ParkedClaudeCliStep, reason: ClaudeCliWarmReapReason): Promise<void>;
    reapAll(reason: "shutdown"): Promise<void>;
    readonly size: number;
  }
  ```
- **Drain rule:** accept `tool_progress` lines only. Anything else, or exit, poisons the entry and reaps it. An unexpected `user` `tool_result` line also logs `claude_cli_warm_unattributed_call`.
- **Spill check (on every reap):** the slug is the run dir with every character outside `[A-Za-z0-9]` replaced by `-`. If `<claudeProjectsDir>/<slug>` has any file under a `tool-results` folder, log `claude_cli_warm_spill_detected` with `{ files, bytes }`. Never delete there. `claudeProjectsDir` is `CLAUDE_CONFIG_DIR ?? <home>/.claude` plus `/projects`.

- [ ] **Step 1: Write the failing tests** (fake session, fake timers).
  - "take hits only for the same session and turn": two parked entries with identical transcripts and different `sessionId`s; each take gets its own entry (Review Focus 1).
  - "a miss for the same session and turn reaps the parked entry before returning".
  - "turn signal abort reaps at once": an abort while parked kills the tree and removes the run dir, with no wait for the deadline (Review Focus 2).
  - "the deadline reaps after 600_000 ms".
  - "a fourth park evicts the oldest".
  - "a heartbeat keeps it parked; any other line poisons it, and a later take misses with warm_miss_poisoned".
  - "reapAll kills every entry".
  - "the spill check logs counts and deletes nothing" (temp dir as `claudeProjectsDir`).
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' --maxWorkers=2 'src/services/claude-code-cli-warm-registry.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement.** A hit removes the entry from the registry and detaches its signal listener and timer; the caller then owns the session and run dir.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): park and reap warm Claude CLI tool steps`.

### Task 6: Continuation mode in the stream mapper

**Files:**
- Modify: `apps/gateway/src/services/claude-code-cli-tool-step.ts`
- Modify: `apps/gateway/src/services/claude-code-cli-stream.ts`. `ClaudeCliStreamMapperOptions` gains `continuation?: { delivered: ReadonlyMap<string, string> }`, keyed by tool-use id to the delivered text.
- Test: `apps/gateway/src/services/claude-code-cli-stream.test.ts`

**Interfaces:**
- Produces:
  - `createClaudeCliToolStepCollector(manifest, identity, options?: { continuation?: { delivered: ReadonlyMap<string, string> } })`. In continuation mode `sawInit` starts true, and a `system/init` is a mismatch.
  - `ClaudeCliStreamMapper.emittedAssistant(): ClaudeCliEmittedAssistant | undefined` returns the text and calls the step emitted, for the next park. Defined once `toolStep()` is.

- [ ] **Step 1: Write the failing tests.**
  - "continuation accepts one echo per delivered id, then a model message": the echoed text equals the delivered text, including `"名前 🐐\r\nline2"` and `""` (Review Focus 3).
  - "echo with different text is claude_cli_bridge_mismatch".
  - "echo for an undelivered id is claude_cli_bridge_mismatch".
  - "message_start before every echo is claude_cli_bridge_mismatch".
  - "a second message_start is claude_cli_bridge_mismatch".
  - "init in continuation is claude_cli_bridge_mismatch".
  - "a continuation that ends in another tool_use yields tool_calls and emittedAssistant".
  - "a continuation that ends with a result finishes as text".
  - Every existing step-mode test still passes.
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' --maxWorkers=2 'src/services/claude-code-cli-stream.test.ts'`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Replace step mode's blanket "any `tool_result` is a fault" with: in continuation mode, a `tool_result` is accepted once if its id is in `delivered`, its text (joined text blocks, or a string) equals the delivered text, and it arrives before the segment's `message_start`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): map a warm Claude CLI continuation segment`.

### Task 7: Adapter wiring

**Files:**
- Create: `apps/gateway/src/services/claude-code-cli-warm-step.ts`, holding the resume and park helpers so the adapter file stays under 800 lines.
- Modify: `apps/gateway/src/services/llm-provider-claude-code-cli.ts`, in `chatCompletionsStream` and the `finally` that removes the run dir.
- Modify: `apps/gateway/src/services/claude-code-cli-process.ts`. `buildClaudeCliEnv` is unchanged; the adapter adds `MCP_TOOL_TIMEOUT` to a copy of `runtime.env`.
- Test: `apps/gateway/src/services/llm-provider-claude-code-cli.test.ts` and `apps/gateway/src/services/llm-service.claude-code-cli-bridge.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces:
  - `tryResumeClaudeCliWarmStep(input): AsyncGenerator<Record<string, unknown>> | undefined`. It returns `undefined` on a miss, after reaping and logging the reason.
  - `parkClaudeCliStep(input): boolean`. It returns `false` when a park condition fails, and the caller then kills as today.
- **Flow on a request:**
  1. If `warmContinuationEnabled()` and the step is bridged, compute the fingerprint and `take`.
  2. On a hit, `beginTrackedDispatch` first. If it throws, reap (`resumed_failure`) and rethrow, having written no file.
  3. Write the result files, then consume `step.session.segment({ signal: request.signal, overallTimeoutMs, idleTimeoutMs })` through a continuation mapper.
  4. At its tool-use `message_stop`, try to park again; otherwise end as today.
- **Park conditions:**
  - the warm flag is on and the step is bridged;
  - `stop_reason` is `tool_use`;
  - the fingerprint is defined;
  - no `keepFirstToolCall` truncation;
  - the signal is not aborted.
- **Run dir:** the `finally` removes the run dir only when the step was not parked.

- [ ] **Step 1: Write the failing tests** (fake spawn plus a real stub process where noted).
  - "a parked step's run dir survives the call, and the tree is not killed".
  - "the next matching request resumes the same pid: no second spawn, and usage is two attempts".
  - "no result file exists until beginTrackedDispatch resolves": assert with a dispatch that awaits a gate.
  - "a failed dispatch reaps the parked step and writes no file".
  - "a miss kills the parked tree, then spawns cold" (the second spawn's argv matches today's bridged argv).
  - "MCP_TOOL_TIMEOUT is 660000 on bridged steps with the warm flag on, absent otherwise, and never copied from the host env".
  - "warm flag off is byte-identical to today": argv, env and kill-at-stop.
  - "parallel_tool_calls false with two tool_use blocks is not parked".
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' --maxWorkers=2 'src/services/llm-provider-claude-code-cli.test.ts' 'src/services/llm-service.claude-code-cli-bridge.test.ts'`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the flow above.**
- [ ] **Step 4: Run the same command, plus** `pnpm --filter @goatcitadel/gateway typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): continue Claude CLI tool steps in the parked process`.

### Task 8: Runner integration proof

**Files:**
- Test: `apps/gateway/src/services/llm-service.claude-code-cli-bridge.test.ts`, or a new `chat-turn-agent-runner.claude-code-cli-warm.test.ts` if that file passes 800 lines. Drive the real `ChatTurnAgentRunner` with a fake CLI behind `LlmService`.

**Interfaces:**
- Consumes: everything above. Production code changes only if a test exposes a gap. If Chat requests arrive without `sessionId`/`turnId` attribution, thread them through the existing attribution path in `chat-turn-agent-runner/usage-and-attribution.ts` and nowhere else.

- [ ] **Step 1: Write the tests.**
  - "a three-step turn with two parallel calls resumes warm twice": one spawn in total. The toolRun rows, audit rows, `tool_start`/`tool_result` events and the receipt equal the same turn with the warm flag off.
  - "Chat tool-loop requests reach the adapter with sessionId and turnId".
  - "an approval-required call ends the turn, the parked entry is reaped, and the resumed turn spawns cold".
  - "a steering message between steps makes one cold step, and the parked process is killed".
  - "a cancelled turn leaves no parked entry" (registry size 0 right after the abort).
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' --maxWorkers=2 <that file>`. Expected: PASS. A failure is a real gap: fix it in the owning task's module, not in the test.
- [ ] **Step 3: Run the named lanes, one at a time:** `pnpm verify:agentic:governance`, `pnpm verify:durable:recovery`, `pnpm verify:architecture:metrics`. Expected: each exits 0.
- [ ] **Step 4: Commit** `test(gateway): prove warm Claude CLI continuation through the Chat runner`.

### Task 9: Settings toggle

**Files:**
- Create: `apps/mission-control-next/src/cockpit/areas/settings/ClaudeCliWarmContinuationControl.tsx` and its `.test.tsx`, mirroring `ClaudeCliToolBridgeControl.tsx` (same change-plan flow, approval owner, recovery anchor).
- Modify: `apps/mission-control-next/src/cockpit/areas/settings/settings-approval-owner.ts` (and its test) to accept `feature:claudeCliWarmContinuationEnabled`. Mount the control under the bridge control in Settings › Models.

**Interfaces:**
- Produces:
  - anchor `CLAUDE_CLI_WARM_CONTINUATION_ANCHOR = "claude-cli-warm-continuation"`;
  - the control is disabled, with a note, while the bridge flag is off.
- **Copy (exact):** "Faster Claude Code tool steps. Keeps one Claude Code process running between tool steps in a turn instead of starting a new one. Tools still run in GoatCitadel. Experimental and off by default."

- [ ] **Step 1: Write the failing tests:**
  - "the control shows the exact copy and is off by default";
  - "it is disabled while the tool bridge is off";
  - "toggling raises a feature_flag change plan for claudeCliWarmContinuationEnabled".
- [ ] **Step 2: Run** `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' --maxWorkers=2 'src/cockpit/areas/settings/ClaudeCliWarmContinuationControl.test.tsx' 'src/cockpit/areas/settings/settings-approval-owner.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement** by copying the bridge control's structure.
- [ ] **Step 4: Run the same command.** Expected: PASS. Then run `pnpm verify:surface:regression` if Settings › Models baselines are affected.
- [ ] **Step 5: Commit** `feat(mission-control): add the Claude CLI warm continuation switch`.

### Task 10: Docs and live proof

**Files:**
- Modify: `docs/superpowers/specs/2026-10-20-claude-code-cli-tool-bridge-design.md`, the cost line. It now says tool steps reuse one CLI process within a turn when they can, and start a new one otherwise.
- Modify: `docs/superpowers/specs/2026-10-22-claude-code-cli-warm-continuation-design.md`, the status line and live-proof results.

- [ ] **Step 1: Run** `pnpm docs:check` and `git diff --check`. Expected: both pass.
- [ ] **Step 2: Live proof.** Use the operator's own login, opt-in, in a zero-mutation sandbox: copy only `git ls-files config` plus `skills/` into a scratch root. Turn on both flags through env and run a Chat turn with at least three tool steps. Record:
  - per-step latency and cache-read tokens, warm against the same turn with the warm flag off;
  - the warm hit rate and every `warm_miss_<reason>`;
  - for a tool returning more than 40,000 characters: that step runs cold, and nothing appears under the operator's Claude projects folder;
  - after killing the Gateway with a step parked: no `claude` process within 10 s;
  - the CLAUDE.md canary from the bridge spec passes.
- [ ] **Step 3:** Write the recorded results into the spec. Commit `docs: record the Claude CLI warm continuation live proof`.
- [ ] **Step 4:** Flipping the default to on is a separate follow-up PR, after the operator reviews the proof (the same path as #460).
