# Claude Code CLI provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `claude-code-cli` LLM provider that streams Chat through the operator's local `claude -p` under their own login.

**Architecture:** The new apiStyle `claude-code-cli` is served by an `LlmProviderAdapter`. The adapter gets a usage intent from a new host method, `beginTrackedDispatch`, then spawns the CLI through an injectable spawner and maps its stream-json output to OpenAI-shaped chunks. Readiness is a cached `claude auth status --json` probe that runs on top of the harness executable lookup.

**Tech Stack:** TypeScript, Node `child_process`, vitest, zod (contracts).

**Spec:** `docs/superpowers/specs/2026-10-19-claude-code-cli-provider-design.md`

## Global Constraints

- **Ids:** providerId `claude-code-cli`; apiStyle `claude-code-cli`; authMode `claude-code-cli-login`; baseUrl `https://api.anthropic.com/v1`, never fetched.
- **Models:** the default model is `claude-sonnet-5-5`. The known models are `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, `sonnet`, `opus`, `haiku` and `fable`. Model ids must match `^[A-Za-z0-9._:\[\]-]+$`.
- **Spawning:** never `shell: true`; always `windowsHide: true`. User text never goes in argv.
- **Fixed flags:** `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <m> --system-prompt-file <tmp> --tools "" --strict-mcp-config --safe-mode --disable-slash-commands --no-session-persistence --permission-mode dontAsk`.
- **Child env:** use the spec section 3 allowlist only. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_OAUTH_TOKEN` must never reach the child.
- **Timeouts:**
  - overall: `resolveChatCompletionTimeoutMs(request.timeoutMs, 300000)`
  - idle: 120 s with no stdout
  - auth-status probe: 10 s
  - readiness cache: 60 s
- **Bounds:** stdout lines are capped at 1 MiB each, and stderr keeps a 16 KiB tail.
- **Reason codes:**
  - `claude_cli_missing`
  - `claude_cli_logged_out`
  - `claude_cli_usage_limited`
  - `claude_cli_incompatible`
  - `claude_cli_model_unavailable`
  - `claude_cli_tool_use_blocked`
  - `claude_cli_timeout`
  - `claude_cli_failed`
  - `claude_cli_tools_unsupported`
  - `claude_cli_not_subscription_login`
  - `claude_cli_unsupported_shim`
- **Usage:** the pool is `subscription`, with credentialType `oauth` and credentialSource `oauth`. No cost is attached.
- **Repo rules:** vitest runs with `--maxWorkers=2`. No `git stash`. Files stay under 800 lines.

## Review Focus

- **Non-ASCII prompt (emoji, CJK) on Windows:** it reaches the child as UTF-8 through stdin unchanged. Test in Task 2.
- **CLI exits 0 with no `result` line, after a crash:** the turn fails with `claude_cli_failed`, not a silent empty reply. Test in Task 3.
- **Abort arrives before the child spawns or after it exits:** no throw and no orphan `taskkill`. Test in Task 2.
- **The Gateway env has `ANTHROPIC_API_KEY` set:** it is absent from the child env. Test in Task 2.
- **The system prompt temp file:** it is deleted on success, on error and on abort. Test in Task 4.

---

### Task 1: Contracts

**Files:**
- Modify: `packages/contracts/src/llm.ts` (`LlmApiStyle`, `LLM_API_STYLES`, `LlmProviderAuthMode`, `LLM_PROVIDER_AUTH_MODES`)
- Modify: `packages/contracts/src/config-schemas.ts` (the apiStyle and authMode zod enums)
- Modify: `packages/contracts/src/provider-templates.ts` (add a template after `claude-code`, and its alias map entry)
- Test: `packages/contracts/src/config-schemas.test.ts`

**Interfaces:**
- Produces: `LlmApiStyle` includes `"claude-code-cli"`. `LlmProviderAuthMode` includes `"claude-code-cli-login"`. The template has `providerId: "claude-code-cli"`, label "Claude Code CLI (local login)", apiStyle `claude-code-cli` and authMode `claude-code-cli-login`.

Steps:

- [ ] Write the test `accepts apiStyle 'claude-code-cli' with authMode 'claude-code-cli-login'`. It asserts that `success` is true and that the apiStyle round-trips.
- [ ] Run the test and confirm it fails.
- [ ] Implement the change.
- [ ] Run the test and confirm it passes.
- [ ] Build contracts: `pnpm --filter @goatcitadel/contracts build`.
- [ ] Commit.

### Task 2: CLI process module

**Files:**
- Create: `apps/gateway/src/services/claude-code-cli-process.ts`
- Test: `apps/gateway/src/services/claude-code-cli-process.test.ts`

**Interfaces:**
- Produces:
  - `type ClaudeCliSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess`
  - `resolveClaudeCliInvocation(input: { env, platform?, whereLines: string[], fileExists: (p) => boolean, execPath?: string }): { command: string; prefixArgs: string[] } | { error: "claude_cli_missing" | "claude_cli_unsupported_shim" }`. `GOATCITADEL_CLAUDE_CLI_PATH` wins, then `.exe`, then a `.cmd` mapped to `[execPath, <dir>/node_modules/@anthropic-ai/claude-code/cli.js]`, then an extensionless path on non-Windows platforms.
  - `buildClaudeCliArgs(input: { model: string; systemPromptFile?: string }): string[]`. It throws `ClaudeCliError("claude_cli_model_unavailable")` on a bad model id.
  - `buildClaudeCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv`. It keeps only allowlisted keys, matched case-insensitively.
  - `class ClaudeCliError extends Error { reasonCode; exitCode?; stderrTail? }`
  - `runClaudeCli(input: { invocation; args; env; cwd; stdinPayload: string; signal?; overallTimeoutMs; idleTimeoutMs; spawn?: ClaudeCliSpawn; killTree?: (pid) => void }): AsyncGenerator<string, { exitCode: number | null; stderrTail: string }>`. It yields complete stdout lines, writes stdin as UTF-8 and ends it, uses tree kill on abort or timeout (`taskkill /PID n /T /F` on win32, otherwise SIGTERM then SIGKILL after 3 s), and maps `ENOENT` to `claude_cli_missing`.
- Also extract `listExecutableCandidates(command): string[]` (all `where`/`which` lines) in `agentic-harness-availability.ts`. Its existing first-line resolver uses it.

Tests, each written to fail first and using a fake `ChildProcess` (an EventEmitter with PassThrough stdio):

- `.exe` is preferred over `.cmd`
- `.cmd` is mapped to node plus `cli.js`
- unsupported shim
- the env override wins
- argv has no prompt text and contains `--tools ""`, `--safe-mode` and `--strict-mcp-config`
- a bad model id throws
- env strips `ANTHROPIC_API_KEY` but keeps `PATH`, `USERPROFILE` and `CLAUDE_CONFIG_DIR`
- `shell` is never true
- a UTF-8 emoji prompt reaches stdin as the same bytes
- lines split across chunks are joined
- a line over 1 MiB yields `claude_cli_failed`
- abort calls `killTree(pid)` once
- abort after exit does not kill
- idle timeout gives `claude_cli_timeout`
- `ENOENT` gives `claude_cli_missing`

Then implement, run `node_modules\.bin\vitest.cmd run --root apps/gateway src/services/claude-code-cli-process.test.ts --maxWorkers=2` until it passes, and commit.

### Task 3: Stream-json mapper

**Files:**
- Create: `apps/gateway/src/services/claude-code-cli-stream.ts`
- Test: `apps/gateway/src/services/claude-code-cli-stream.test.ts`

**Interfaces:**
- Produces:
  - `createClaudeCliStreamMapper(model: string): { push(line: string): Record<string, unknown>[]; finish(exit: { exitCode: number | null; stderrTail: string }): { finalChunk: Record<string, unknown>; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } }`. Errors are thrown as `ClaudeCliError`.
  - `classifyClaudeCliFailure(text: string, exitCode: number | null): ClaudeCliReasonCode`.
  - `renderClaudeCliPrompt(messages): { system: string; userText: string }`, plus `buildStreamJsonUserMessage(userText): string`, which returns `{"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}` followed by `\n`.

Chunk shapes:

- Delta chunk: `{ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content } }] }`.
- Thinking: `delta.reasoning_content`.
- Final chunk: `choices: [{ index: 0, delta: {}, finish_reason: "stop" }]` and `usage`. `prompt_tokens` = input + cache_read + cache_creation input tokens.

Tests:

- text deltas, then a result, map to deltas and a final chunk with the correct token sums
- a thinking delta maps to `reasoning_content`
- an `assistant` full-text message is used only when no deltas arrived
- a `tool_use` content block, or a `content_block_start` with `tool_use`, throws `claude_cli_tool_use_blocked`
- `result` with `is_error` and "Please run /login" maps to `claude_cli_logged_out`
- "usage limit reached" maps to `claude_cli_usage_limited`
- "unknown option" maps to `claude_cli_incompatible`
- "model ... not found" maps to `claude_cli_model_unavailable`
- exit 0 with no result maps to `claude_cli_failed`
- garbage and non-JSON lines are ignored
- the transcript renders system / user / assistant / tool roles with labels, and system text goes to `system`

Then implement, pass the tests, and commit.

### Task 4: Adapter, host dispatch, and LlmService wiring

**Files:**
- Create: `apps/gateway/src/services/llm-provider-claude-code-cli.ts`
- Modify: `apps/gateway/src/services/llm-provider-adapter.ts`. Add `beginTrackedDispatch(input: Omit<LlmProviderJsonRequestInput, "target" | "payload" | "timeoutMs"> & { targetUrl: string }): Promise<{ usage?: ModelUsageAttemptHandle; priorModelUsageEventIds?: string[] }>` and an optional `claudeCli?: ClaudeCliAdapterRuntime` on the host.
- Modify: `apps/gateway/src/services/llm-service.ts`:
  - register the adapter
  - `normalizeProviderApiStyle` and `resolveProviderExecutionApiStyle` (keep `claude-code-cli`)
  - `defaultAuthModeForProvider` and `normalizeProvider` (force `claude-code-cli-login`)
  - credential lineage (subscription / oauth / oauth)
  - `normalizeRequestedModel` (strip a `claude-code-cli/` prefix)
  - `inferForeignProviderForModel` (anthropic models are allowed)
  - `LlmServiceOptions.claudeCli?: { spawn?; killTree?; resolveInvocation?; authStatus?; scratchDir? }`
  - readiness check in `resolveProvider` when `requireAuth`
- Test: `apps/gateway/src/services/llm-provider-claude-code-cli.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: `claudeCodeCliProviderAdapter: LlmProviderAdapter`. A required tool choice throws `ClaudeCliError("claude_cli_tools_unsupported")` before dispatch. Offered tools are dropped. The system prompt goes to a temp file under `scratchDir`, which is deleted in `finally`. If an "unknown option" failure mentions `--system-prompt-file`, the adapter retries once with the system text put at the top of the user message.

Tests: run through `new LlmService(config, { ANTHROPIC_API_KEY: "sk-ant-should-not-leak" }, { claudeCli: fakes, secretStore: createNoopSecretStore() })`.

- `chatCompletionsStream` yields "hello " and "world", then a final chunk whose usage is 7/2.
- The spawned env has no `ANTHROPIC_API_KEY`.
- The argv model is `claude-sonnet-5-5`.
- `chatCompletions` returns the joined text.
- `tool_choice: "required"` rejects with `claude_cli_tools_unsupported`, and spawn is never called.
- `tools` with `auto` succeed, and stdin has no tool schema.
- A logged-out probe rejects before spawn.
- The temp file is gone after success, error and abort.
- The existing `claude-code` provider still resolves to `anthropic-messages`.

Then implement, pass the tests, and commit.

### Task 5: Readiness probe

**Files:**
- Create: `apps/gateway/src/services/claude-code-cli-readiness.ts`
- Test: `apps/gateway/src/services/claude-code-cli-readiness.test.ts`
- Modify: wherever `LlmProviderAuthReadiness` / `oauthStatus` is built for providers (in `llm-service.ts` provider listing), so `claude-code-cli` reports from the probe.

**Interfaces:**
- Produces: `class ClaudeCodeCliReadiness { constructor(opts: { run: (args) => Promise<{ exitCode; stdout }>; now?: () => number; ttlMs?: number }); check(): Promise<{ status: "ready" | "missing" | "invalid" | "unavailable"; reasonCode: string; liveVerified: boolean }>; invalidate(): void }`.

Tests:

- `{loggedIn:false}` gives missing with `claude_cli_logged_out`
- `{loggedIn:true, authMethod:"claude.ai", apiProvider:"firstParty"}` gives ready
- an authMethod containing "api" gives invalid with `claude_cli_not_subscription_login`
- a timeout or bad JSON gives unavailable
- a cache hit within 60 s, and a refetch after `invalidate()`

Then implement, pass the tests, and commit.

### Task 6: Verify and open the PR

- [ ] Run `pnpm --filter @goatcitadel/contracts typecheck` and the gateway typecheck script. Fix any exhaustive switches the new apiStyle breaks.
- [ ] Run the focused gateway tests from Tasks 2 through 5, plus `llm-provider-anthropic.test.ts` and `llm-service.fake-provider.test.ts`, with `--maxWorkers=2`.
- [ ] Run `git diff --check`.
- [ ] Commit, push, and open a PR against main that links #447 and the spec.
