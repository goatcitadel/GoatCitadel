# Claude Code CLI tool bridge: warm continuation

Status: approved by the operator on 2026-10-22, with all four **Operator decisions** settled (listed at the end). Not built yet; the plan is `docs/superpowers/plans/2026-10-22-claude-code-cli-warm-continuation.md`. The probe facts below were measured on 2026-10-22.

Builds on the step-mode tool bridge (`docs/superpowers/specs/2026-10-20-claude-code-cli-tool-bridge-design.md`, PRs #457–#460). Everything that spec decided still holds unless this one says otherwise.

## Intent

Step mode starts a new `claude -p` process for every model step in a tool loop. Each step pays the CLI's start-up and re-sends the whole transcript as labelled text. The live proof measured about 4–7 s per step, and a sustained-coding turn can run up to 120 tool runs.

Warm continuation keeps the step's process alive while the runner executes the tool calls. Then it hands the results back to that same process, so the model continues without a new start and with its real `tool_use`/`tool_result` history. GoatCitadel still executes every tool call through the runner. The CLI still executes nothing.

Warm continuation is an optimization only. Whenever a condition below does not hold, the adapter kills the parked process and runs today's cold step. A cold step must always produce the same governed result.

## Goals

- A tool loop step whose next request is exactly "previous transcript + results for the pending calls" continues in the parked process.
- No change to the execution path: every call still runs `ChatTurnAgentRunner` → `executeToolCall` → `invokeTool`, with the same toolRun rows, audit, events, approvals, budgets and receipts.
- No network listener and no credential. Results reach the stub through files in the step's private run dir.
- The CLI never makes a model call before the matching usage intent is accepted.
- No tool output is written anywhere outside the Gateway-owned run dir.

## Non-goals

- Keeping a CLI process across turns or across an approval wait. OpenClaw keeps one warm process per conversation; most of its Claude CLI churn since July 2026 comes from that lifetime (account switches, prompt changes, warm-process cleanup, mid-turn steering).
- Using Claude Code's session persistence or `--resume`.
- Answering the CLI's own permission requests (`--permission-prompt-tool stdio`). Built-in tools stay off, so there is nothing to gate.
- Marking tools `readOnlyHint` so the CLI sends parallel calls concurrently. Results are staged before delivery, so the CLI's ordering costs nothing (see probe facts).
- Lowering the cost of cold steps.

## Anti-goals

These count as failures even if a turn completes:

- The CLI receiving any tool result that is not the runner's tool message for that call, including a result the CLI makes up itself on a timeout.
- A model API call from a parked process before the next step's usage intent is accepted, or after the turn has moved on.
- Tool output spilled into the operator's Claude profile (`~/.claude/projects/...`) or anywhere else outside the run dir.
- A parked process that outlives its deadline, its turn, or the Gateway.
- A warm/cold difference the runner can see: the runner must not need to know which path ran.

## What the probe found (2026-10-22, Claude Code 2.1.305, Windows, `--model haiku`)

The probe drove a real `claude -p` with the bridge's exact flags. The stub parked each `tools/call` until a result file appeared in the run dir, then answered it. A controller played the adapter: it read `tool_use` blocks from stdout at `message_stop`, waited, and staged results.

| Fact | Evidence |
|---|---|
| A parked `tools/call` can be answered later, and the same process continues. The model's next message used the result. | smoke run, 5 s park |
| Result file written → stub answer: 3 ms (via `fs.watch`). Answer → next `message_start`: 0.7–1.1 s. A cold step's first `message_start` came 1.6–1.9 s after spawn in the same probe. | smoke, parallel runs |
| While parked, the CLI makes no API call and sends a `tool_progress` heartbeat every 30 s. | parallel deadlock run, 240 s |
| A 20-minute park held. 40 heartbeats, still exactly two API calls in the whole run, and the model continued 1.0 s after the result was written. So the default `MCP_TOOL_TIMEOUT` is at least 20 minutes on this version. | park20m run, 1,200 s |
| **Two `tool_use` blocks in one message are sent to the MCP server one at a time.** The second `tools/call` is sent only after the first is answered. With `annotations.readOnlyHint: true` both are sent at once. | parallel runs |
| Results staged by `_meta["claudecode/toolUseId"]` before the CLI asks for them are delivered immediately when it does (1 ms). The model then makes exactly one more API call. | parallel-staged run |
| Answering parallel calls in reverse order works. | parallel-readonly run |
| **`MCP_TOOL_TIMEOUT` is honored. When it fires, the CLI writes its own error `tool_result` ("… timed out after 20s") and makes another API call by itself, about 0.7 s later.** | timeout-env run, 20 s |
| The CLI echoes every delivered result as a `user` line with a `tool_result` block, the same `tool_use_id`, the delivered text, and `tool_result_meta`. | smoke run |
| **A result above the CLI's size cap is replaced by an error, and the full result is written to `~/.claude/projects/<cwd slug>/<session>/tool-results/…txt`, even with `--no-session-persistence`.** 20,000 and 40,000 characters passed intact. 60,000, 120,000 and 400,000 characters were replaced. `MAX_MCP_OUTPUT_TOKENS=200000` did not change this. | size runs (spill files deleted after the probe) |
| Runs with results under the cap leave nothing in `~/.claude/projects`. | checked after every run |
| Killing the parent of a parked CLI (no tree kill) ended the CLI and the stub within 3 s. | orphan run |

Not verified, and relied on only through fallbacks or tripwires: the exact size cap (somewhere between 40,000 and 60,000 characters on this version), behavior on macOS/Linux, the exact default `MCP_TOOL_TIMEOUT` (only "at least 20 minutes"; the design sets it explicitly anyway), and how often a real Chat turn meets the match rules (see **Matching**; measured in the live proof).

## Design

### Lifecycle of one warm continuation

1. **Step N runs as today**, with two additions: the stub is the parking stub (below), and `MCP_TOOL_TIMEOUT` is set in the CLI's env. When the step ends at `message_stop` with `stop_reason: "tool_use"`, the adapter emits `tool_calls` and settles step N's usage, as today.
2. **Instead of killing the tree, the adapter parks it**, when every park condition holds. It moves the live process, its line source, and its run dir into a `ParkedClaudeCliStep` held by the runtime's registry. Otherwise it kills the tree exactly as today.
3. **While parked**, a drain reads the CLI's stdout. Heartbeats are dropped. Any other line poisons the entry and kills the tree.
4. **The runner executes the calls** as it does for every provider.
5. **Step N+1's request arrives.** The adapter looks for a parked entry that matches (see **Matching**). If none matches, it kills any parked entry for the same turn and runs a cold step.
6. **On a match**, the adapter first runs `beginTrackedDispatch` for step N+1. Only after the intent is accepted does it write the result files. Because the CLI is blocked on the stub, no model call can start before this point.
7. **The parked line source feeds a continuation mapper.** It accepts the echo lines for exactly the delivered results, then one model message, and ends that segment like any step: at the next `tool_use` `message_stop` (which can park again), or at `result` for a final answer.

### The parking stub

The step-mode stub keeps its constraints: it imports only `node:fs` and `node:process`, uses erasable TypeScript, has the 1 MiB line cap, and exits on stdin EOF. Changes:

- `tools/call` is held, keyed by `params._meta["claudecode/toolUseId"]`. A call without that id is answered with JSON-RPC error `-32602` and counts as a fault, because the adapter cannot bind it.
- The stub watches `<run dir>/results/` (`fs.watch` plus a 100 ms poll as backstop) for `<toolUseId>.json`. It also checks for an already-staged file when a call arrives, because the CLI asks for later calls only after earlier ones are answered.
- A result file is `{ nonce, toolUseId, text }`. The stub answers only when `nonce` matches the step's manifest nonce and `toolUseId` matches the held call. Otherwise it ignores the file, and the adapter's echo check turns the resulting timeout into a fault.
- The answer is `{ content: [{ type: "text", text }], isError: false }`. A runner tool message that reports a failure is still delivered as text, as in the cold transcript; `isError` is not inferred.
- It still never executes anything and never writes to disk.

My call: files rather than a pipe or socket, because a file needs no listener and no credential, and the run dir is already private. A local process running as the same OS user could write a result file. That process could also read the operator's Claude login, so it is outside this boundary. The nonce stops stale files from an earlier step being accepted by accident; it is not a secret against the same user.

### Park conditions (checked at step N's `message_stop`)

All must hold, or the step ends cold as today:

- the warm flag is on (see **Operator decisions**), the step was bridged, and `stop_reason` is `tool_use`;
- the step emitted every `tool_use` it saw. A `parallel_tool_calls: false` step that dropped calls is not parked;
- the request has a `sessionId` and `turnId` in its attribution;
- step N's `request.signal` has not aborted.

The registry cap never blocks a park: the oldest entry is evicted to make room (see **Reaping**).

### Matching (checked when step N+1 arrives)

The parked entry records: the attribution's session, turn and durable run ids; the model; hashes of the system text, the tool manifest, `tool_choice` and `parallel_tool_calls`; a hash of step N's request messages; the assistant message step N emitted (text plus `tool_calls`); and the set of pending `toolUseId`s.

Step N+1 continues warm only when:

- the attribution ids, model and every recorded hash match;
- `request.messages` is exactly step N's messages, then the recorded assistant message, then one `tool` message per pending id and nothing else, in any order;
- each tool message's content is a string of at most `WARM_RESULT_MAX_CHARS` characters (my call: 40,000, the largest size the probe saw pass);
- the entry is not poisoned, expired or exited.

Anything else is a cold step. That covers a steering message, the artifact-retry nudge, a repaired tool call, a changed catalog, a model change, a flag change, and a larger result. Each cold fallback after a park logs a bounded reason (`warm_miss_<reason>`, and nothing else), so the live proof can measure the hit rate.

**How the runner hands the assistant message back** (`chat-turn-agent-runner.ts`, the `createAssistantToolCallMessage` call after tool execution): it does not pass the adapter's message through. It rebuilds it from the message text, each call's `id`, the model name re-resolved through `canonicalToModel`, and each call's `rawArguments`. It also adds a runner-internal effect-potential key and may carry provider-native content. Near-miss calls that the runner could not repair come back as extra calls with the raw name and arguments `{}`. So matching compares a normalized form, and nothing else:

- the text content;
- the ordered list of `{ id, function.name, function.arguments }`.

Runner-internal keys and provider-native content are ignored. A repair-feedback call never matches what the CLI emitted, so that step runs cold, which is correct: the CLI's own history would disagree with the runner's. The plan pins this with a test built from a real runner-produced message, and the live proof measures the hit rate.

### Timeouts and the CLI's own timeout

- **Park deadline: 10 minutes.** When it passes, the entry is reaped: tree killed, run dir removed. Plan finding: the adapter never sees the turn deadline, only the step's `timeoutMs` (already capped by the remaining turn budget, but often shorter than a tool run). So the deadline is a flat 10 minutes. The turn's end is caught instead by the turn's `AbortSignal`, which the runner passes on every step: the parked entry listens to it and is reaped on abort.
- **`MCP_TOOL_TIMEOUT`** is set in the CLI's env to the park deadline plus 60 s. The adapter adds it explicitly; it is not read from the host env. The Gateway always reaps before the CLI's own timeout can fire, so the CLI never gets the chance to invent a result.
- **Tripwire:** a `user` line with a `tool_result` for an id the adapter has not delivered, or with text different from what it delivered, poisons the entry and kills the tree at once. A model call may already be in flight then. That call is not attributed to any usage intent, so it is logged as a bounded `claude_cli_warm_unattributed_call` warning. With the deadline ordering above it should never happen.
- The 120 s idle timeout does not apply while parked: heartbeats arrive every 30 s anyway, and the park deadline is the bound. It applies again from resume.

### Reaping

A parked entry ends, and its tree and run dir go, on whichever comes first:

- its park deadline;
- a step N+1 for the same session and turn that does not match (killed before the cold step starts);
- the registry cap, by evicting the oldest entry;
- Gateway shutdown (`GatewayService.close()` calls a new `LlmService.close()`);
- the turn's `AbortSignal` aborting, while parked or once resumed.

When a turn ends without another step (final answer elsewhere, approval wait, budget stop, error, cancellation), the deadline is the backstop. My call: the plan may add a runner-side "turn settled" notification so the entry goes at once, but correctness does not depend on it. An approval wait always ends warm continuation; the resumed turn starts cold, as today.

### Usage and accounting

- Step N settles at `message_stop`, as today.
- Step N+1 opens its own usage attempt before any result file exists, and settles from the continuation segment's `message_delta` or `result` usage.
- A parked process that is reaped makes no model call, so it settles nothing.

### Stream handling in a continuation segment

| Line | Behavior |
|---|---|
| `user` with `tool_result` for a delivered id and the delivered text | Accepted once per id; emits nothing. |
| any other `tool_result`, or one before delivery | Poison, kill, fail the step with `claude_cli_bridge_mismatch`. |
| `tool_progress` | Ignored. |
| first `message_start` after all pending ids are echoed | Starts the segment's model message. |
| `message_start` before all echoes, or a second one | `claude_cli_bridge_mismatch`. |
| everything else | As in step mode: tool blocks against the same manifest, text and thinking deltas forwarded, hook events fatal, `result` ends a text answer. |

The init tripwire ran at step 1 of the process; a second `system/init` is a mismatch.

### Size and spill guard

- A result over `WARM_RESULT_MAX_CHARS` never goes to the stub; that step runs cold, and the cold transcript carries the full text as today.
- **The adapter checks the operator's Claude projects folder for the run dir's slug** when it reaps an entry. If it finds a `tool-results` file there, it logs `claude_cli_warm_spill_detected` with the byte count only, and the live proof fails. The adapter does not delete files in the operator's Claude profile.

My call: no automatic cleanup in the profile. Deleting files in a directory the Gateway does not own is riskier than reporting them, and the size gate should make the spill impossible.

## Code shape (for the plan)

- `claude-code-cli-process.ts`: `runClaudeCli` gains a way to detach a running child without killing it, so a parked step can outlive the generator that started it. The kill-on-close default stays.
- New `claude-code-cli-warm-registry.ts`: the registry, park/match/reap, the drain, and the deadline timers. It is owned by `ClaudeCodeCliRuntime`, one per Gateway.
- `claude-code-cli-mcp-stub.ts`: parking and result-file delivery. The import pin test keeps holding.
- `claude-code-cli-tool-step.ts`: a continuation mode for the collector (echo acceptance, one message per segment).
- `llm-provider-claude-code-cli.ts`: park instead of kill when the conditions hold; on a request, match first, then either resume or run cold. The run dir's lifetime moves to the registry for parked steps.
- No runner, durable-execution, policy or storage changes. Keep edits out of `gateway-service.ts`.

## Tests

**Unit (fake spawn):**

- Park conditions: each failing condition ends the step cold, as today.
- Matching: an exact continuation resumes; each kind of mismatch (extra message, changed hash, missing id, extra id, oversize result, non-string content, expired, poisoned) runs cold and kills the parked entry first.
- Ordering: no result file exists before the next step's `beginTrackedDispatch` resolves. A failed intent kills the parked entry and writes nothing.
- Tripwires: an undelivered `tool_result`, a mismatched echo, a `message_start` before the echoes, and an exit while parked each poison and kill.
- Reaping: deadline, cap eviction, shutdown hook, abort; the run dir is gone after each.
- Stub: holds by `toolUseId`; delivers a pre-staged file at once; ignores a wrong nonce or id; answers a call without a `toolUseId` with `-32602`; the import list still pins `node:fs` and `node:process`.
- Env: `MCP_TOOL_TIMEOUT` is park deadline plus 60 s and is not taken from the host env.

**Runner integration (fake CLI through `LlmService`):**

- A three-step turn with two parallel calls continues warm twice and leaves the same toolRun rows, audit, events and receipts as the same turn run cold.
- An approval-required call ends the turn; the parked entry is reaped; the resumed turn starts cold.
- A steering message between steps causes one cold step and no warm resume.

**Named lanes:** as for the bridge spec: gateway typecheck, focused vitest (`--maxWorkers=2`), `pnpm verify:agentic:governance`, `pnpm verify:durable:recovery`, `pnpm verify:architecture:metrics`, `pnpm docs:check`, `git diff --check`.

**Live proof (operator's own login, opt-in):**

- A Chat turn with at least three tool steps runs warm. Record per-step latency and cache-read tokens against the same turn with the warm flag off.
- Record the warm hit rate and every `warm_miss_<reason>`.
- A tool that returns more than 40,000 characters runs cold, and nothing appears under the operator's Claude projects folder.
- Killing the Gateway with a parked step leaves no `claude` process within 10 s.
- The CLAUDE.md canary from the bridge spec still passes.

## Docs and public truth

- Update the bridge spec's cost line: tool steps reuse one CLI process within a turn when they can, and start a new one otherwise.
- Settings copy for the warm flag says plainly that it only changes speed, and that tools still run in GoatCitadel.
- Claim no sandboxing.

## Operator decisions (decided 2026-10-22)

1. **Flag and default:** a separate `claudeCliWarmContinuationEnabled` flag, off until the live proof passes, the same path the bridge flag took. It only applies while `claudeCliToolBridgeEnabled` is on.
2. **Park deadline:** 10 minutes, capped by the turn deadline. Longer tools then run cold on the next step, which is correct but slower. (Plan finding: the adapter cannot see the turn deadline, so the cap is the turn's abort signal instead; see **Timeouts**.)
3. **Registry cap:** 3 parked processes per Gateway. Each parked `claude` process holds memory but makes no calls.
4. **Result size gate:** 40,000 characters, the largest size measured as safe. Anything bigger runs cold.

## My calls, for checking while reading

- Results travel by run-dir file with a nonce, not by pipe or socket.
- Parallel calls are staged by `toolUseId` before delivery; tools are not marked `readOnlyHint`.
- `MCP_TOOL_TIMEOUT` is always set past the park deadline, and the Gateway reaps first.
- An unexpected `tool_result` is a fault, never a result.
- No warm process survives an approval wait or a turn.
- The Gateway reports spill files in the Claude profile but never deletes them.
- Spill check by run-dir slug at reap time.
