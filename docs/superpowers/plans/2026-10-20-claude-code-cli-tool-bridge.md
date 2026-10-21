# Claude Code CLI tool bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** The spec was approved on 2026-10-20 (step mode, flag off by default, `--safe-mode` dropped on tool steps, per-step cost accepted including sustained coding). Implementation starts after #455 merges.

**Goal:** Let the `claude-code-cli` provider call GoatCitadel tools. Each `claude -p` run is one model step. The CLI sees tools through an inert stdio MCP stub, and the Gateway runner executes every call.

**Architecture:** A bridged step writes a tool manifest and an `mcp.json` into the step's run dir. It drops `--safe-mode` and adds `--mcp-config`, `--allowedTools mcp__goatcitadel` and `--permission-prompts none`. The stream mapper turns the CLI's `tool_use` blocks into OpenAI `tool_calls`, ends the step at `message_stop`, and kills the tree while the CLI is parked on the stub. The runner, `invokeTool`, approvals, durable resume, budgets and receipts are unchanged.

**Tech Stack:** TypeScript (strict), Node `child_process`, newline-delimited JSON-RPC (no MCP SDK dependency), vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-claude-code-cli-tool-bridge-design.md`

## Global Constraints

- **Server name:** the MCP server is named `goatcitadel`. The model sees tools as `mcp__goatcitadel__<name>`. The allow rule is exactly `mcp__goatcitadel`.
- **Names:** the manifest tool name is the runner's model-facing name from `request.tools[i].function.name`. If `"mcp__goatcitadel__".length + name.length > 64`, the tool is aliased to `t<index>_<first 8 hex of sha256(name)>`.
- **Bridged flags:** these are today's `buildClaudeCliArgs` flags with three changes:
  - remove `--safe-mode`;
  - insert `--mcp-config <runDir>/mcp.json` right after `-p`;
  - append `--allowedTools mcp__goatcitadel` and `--permission-prompts none`.
- **Unbridged steps:** argv is byte-identical to today's.
- **When a step is bridged:** the flag is on (read per step), `request.tools` is non-empty, and `request.tool_choice` is absent, `"auto"` or `{ type: "auto" }`. `"none"` gives an unbridged step. Required or named `tool_choice` still throws `claude_cli_tools_unsupported`.
- **`parallel_tool_calls === false`:** only the first `tool_use` of a step is emitted.
- **No recovery retry:** `claude_cli_bridge_unavailable`, `claude_cli_bridge_mismatch`, `claude_cli_tool_use_blocked` and `claude_cli_hook_blocked` are never retried by `shouldRetryToolProtocolError`.
- **Stub:** imports only `node:fs` and `node:process`. It never answers `tools/call`. It answers unknown requests with JSON-RPC error `-32601`. Stdin lines are capped at 1 MiB, and it exits on stdin EOF.
- **New reason codes:** `claude_cli_bridge_unavailable` and `claude_cli_bridge_mismatch`.
- **Feature flag:** `claudeCliToolBridgeEnabled`, with env `GOATCITADEL_FEATURE_CLAUDE_CLI_TOOL_BRIDGE_ENABLED`. It defaulted to `false` (operator decision 2) until the live proof passed on 2026-10-21; a separate follow-up PR then turned it on by default.
- **Capability:** for `apiStyle === "claude-code-cli"`, `toolCalling` equals the flag. Every other capability stays `false`.
- **Repo rules:**
  - vitest runs with `--maxWorkers=2`, at low priority, one heavy job at a time;
  - never `git stash`;
  - files stay under 800 lines;
  - no edits to `gateway-service.ts` beyond one option line, because it is near its line budget;
  - no `prettier --write` on directory globs;
  - never spoof Claude Code's prompt.
- **Base branch:** rebase on `main` after #455 merges. Tasks 1 and 7 depend on its `describeProviderToolSupport`.

## Review Focus

- **Run dir or stub path with spaces or non-ASCII** (for example `C:\Users\Jane Doe\AppData\Local\Temp`): `mcp.json` still launches the stub, because args are a JSON array and there is no shell. Test in Task 3.
- **Non-ASCII tool input** (CJK file names, emoji in a document title): `tool_calls[].function.arguments` round-trips unchanged. Test in Task 4.
- **Zero-argument tool** (`input: {}`): it becomes `arguments: "{}"`, not `""` or `"null"`. Test in Task 4.
- **Cancelled turn:** no `node` stub process survives. The stub exits on stdin EOF even if the tree kill misses it. Test in Task 2.
- **Large transcript after several tool results** (more than 2 MiB rendered): it reaches stdin intact as one stream-json line, with the per-message blocks in order. Test in Task 5.

---

### Task 1: Feature flag and capability truth

**Files:**
- Modify: `apps/gateway/src/services/gateway/runtime-settings.ts` (the features type)
- Modify: `apps/gateway/src/config.ts` (the features interface near :79, the env tuple list near :822, the default near :1426)
- Modify: `apps/gateway/src/services/gateway/feature-flags.ts` (carry the flag in `buildUpdatedFeatureFlags`)
- Modify: `apps/gateway/src/routes/dashboard.ts` (the feature patch zod near :228)
- Modify: `apps/gateway/src/services/llm-service.ts`:
  - add `claudeCliToolBridgeEnabled?: () => boolean` to `LlmServiceOptions`;
  - change `inferProviderCapabilities(provider, options)` so the `claude-code-cli` branch (near :6655) sets `toolCalling` from it;
  - update all three call sites (:526, :1263, :4705).
- Modify: `apps/gateway/src/services/gateway-service.ts:1648`: add one line, `claudeCliToolBridgeEnabled: () => this.config.assistant.features.claudeCliToolBridgeEnabled === true`. First confirm that `updateFeatureFlags` refreshes `config.assistant.features`. If it doesn't, read through the same owner `toolsInvoke.isFeatureEnabled` uses, as a cached sync snapshot.
- Test: `apps/gateway/src/services/llm-service.claude-code-cli-capabilities.test.ts` (new), `apps/gateway/src/services/gateway/feature-flags.test.ts`

**Interfaces:**
- Produces:
  - `LlmServiceOptions.claudeCliToolBridgeEnabled?: () => boolean`;
  - `LlmService.isClaudeCliToolBridgeEnabled(): boolean` (`false` when the option is absent);
  - `RuntimeSettings["features"].claudeCliToolBridgeEnabled?: boolean`.

Steps:

- [ ] Write the tests:
  - `claude-code-cli reports toolCalling true only when the bridge flag is on`: build an `LlmService` with a `claude-code-cli` provider and `claudeCliToolBridgeEnabled: () => true`, then `() => false`. Assert that the capabilities from the provider listing have `toolCalling === true`, then `false`. Also assert that `vision`, `audio`, `video`, `jsonMode`, `webSearch`, `reasoning`, `imageGenerate` and `imageEdit` are all `false` in both cases.
  - `a configured capabilities override cannot turn on claude-code-cli tool calling when the flag is off`.
  - `buildUpdatedFeatureFlags carries claudeCliToolBridgeEnabled`: with patch `{}` and the current value `true`, the result is `true`.
- [ ] Run the tests and confirm they fail: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/gateway' --maxWorkers=2 'src/services/llm-service.claude-code-cli-capabilities.test.ts' 'src/services/gateway/feature-flags.test.ts'`
- [ ] Implement the change.
- [ ] Run the tests and confirm they pass, then run `pnpm --filter @goatcitadel/gateway typecheck`.
- [ ] Commit with `feat(gateway): add the Claude Code CLI tool bridge flag and capability truth`.

### Task 2: The inert stdio MCP stub

**Files:**
- Create: `apps/gateway/src/services/claude-code-cli-mcp-stub.ts`
- Test: `apps/gateway/src/services/claude-code-cli-mcp-stub.test.ts`

**Interfaces:**
- Produces:
  - `export interface ClaudeCliStubTool { name: string; description: string; inputSchema: Record<string, unknown> }`
  - `export function handleClaudeCliStubLine(tools: readonly ClaudeCliStubTool[], line: string): string | undefined`: returns the JSON-RPC reply line (no trailing newline), or `undefined` for notifications, `tools/call` and unparseable input.
  - `export const CLAUDE_CLI_STUB_MAX_LINE_BYTES = 1024 * 1024`
  - When run as a script (`node <file> <tools.json>`), it reads `tools.json` once (`{ tools: ClaudeCliStubTool[] }`), serves stdin and stdout, and exits on stdin EOF or an oversized line.

Steps:

- [ ] Write the tests:
  - `initialize echoes the client protocolVersion and advertises tools`: the reply `result.protocolVersion === "2025-11-25"`, `result.capabilities` deep-equals `{ tools: {} }`, and `result.serverInfo.name === "goatcitadel"`.
  - `tools/list returns exactly the manifest tools`.
  - `tools/call is never answered`: the return value is `undefined`.
  - `server/discover and unknown methods return -32601`, with the same `id`.
  - `notifications produce no reply`.
  - `the stub imports only node:fs and node:process`: read the source file and match every `from "…"` and `import("…")` against that set.
  - `the stub process exits on stdin EOF and never answers tools/call`: spawn `process.execPath` with the `.ts` file (Node 24 strips types) and a temp `tools.json`, send `initialize`, `tools/list` and a `tools/call`, and wait 1 s. Exactly 2 reply lines arrive. Then end stdin and expect exit within 2 s.
  - `an oversized stdin line ends the stub`.
- [ ] Run the tests and confirm they fail.
- [ ] Implement the stub.
- [ ] Run the tests and confirm they pass.
- [ ] Commit with `feat(gateway): add the inert MCP stub for the Claude Code CLI tool bridge`.

### Task 3: Manifest, run-dir files, and bridged arguments

**Files:**
- Create: `apps/gateway/src/services/claude-code-cli-tool-bridge.ts`
- Modify: `apps/gateway/src/services/claude-code-cli-process.ts`:
  - `buildClaudeCliArgs` gains `bridge?: { mcpConfigPath: string }`;
  - add the two reason codes to `CLAUDE_CLI_REASON_CODES`.
- Modify: `apps/gateway/src/services/claude-code-cli-stream.ts` (user messages for the new codes)
- Test: `apps/gateway/src/services/claude-code-cli-tool-bridge.test.ts`, `apps/gateway/src/services/claude-code-cli-process.test.ts`

**Interfaces:**
- Consumes: `ClaudeCliStubTool` (Task 2).
- Produces:
  - `export const CLAUDE_CLI_MCP_SERVER_NAME = "goatcitadel"` and `export const CLAUDE_CLI_MCP_TOOL_PREFIX = "mcp__goatcitadel__"`
  - `export interface ClaudeCliToolManifest { tools: ClaudeCliStubTool[]; cliNameToModelName: ReadonlyMap<string, string>; sha256: string; nonce: string }`. The map's keys are the full `mcp__goatcitadel__…` names.
  - `export function buildClaudeCliToolManifest(tools: ReadonlyArray<Record<string, unknown>>): ClaudeCliToolManifest`. It throws `ClaudeCliError("claude_cli_bridge_unavailable")` on a tool without a string `function.name`.
  - `export async function writeClaudeCliBridgeFiles(input: { runDir: string; manifest: ClaudeCliToolManifest; nodePath: string; stubPath: string }): Promise<{ mcpConfigPath: string }>`. It writes `tools.json` and `mcp.json` with mode `0o600`. `mcp.json` is the spec's JSON, with `env: {}`.
  - `export function resolveClaudeCliStubPath(fileExists: (p: string) => boolean): string | undefined`. It returns the compiled `.js` next to this module in `dist`, or the `.ts` in source runs.

Steps:

- [ ] Write the tests:
  - `manifest uses runner model names`: for `documents_create`, the map contains `mcp__goatcitadel__documents_create` → `documents_create`.
  - `names over 64 characters with the prefix are aliased and map back`: for a 50-character name, the key matches `/^mcp__goatcitadel__t0_[0-9a-f]{8}$/`.
  - `the manifest hash is stable for equal input`.
  - `mcp.json launches node with the stub and tools.json as array args`: use a run dir whose path contains `Jane Doe` and `ü`, then parse the file back and assert `args[1]` equals the tools path exactly.
  - `buildClaudeCliArgs with a bridge`:
    - no `--safe-mode`;
    - `--mcp-config` sits at index 1 and is followed by the path;
    - `--allowedTools mcp__goatcitadel` and `--permission-prompts none` are present;
    - `--tools ""`, `--strict-mcp-config`, `--permission-mode dontAsk` and `--setting-sources ""` are still present.
  - `buildClaudeCliArgs without a bridge is unchanged`: deep-equal to the current output (snapshot the array literally in the test).
- [ ] Run the tests and confirm they fail.
- [ ] Implement the change.
- [ ] Run the tests and confirm they pass.
- [ ] Commit with `feat(gateway): build the tool manifest and bridged CLI arguments`.

### Task 4: Bridged stream mapping (one model step)

**Files:**
- Create: `apps/gateway/src/services/claude-code-cli-tool-step.ts` (the bridged tripwires and tool-call collection; keeps `claude-code-cli-stream.ts` under 800 lines)
- Modify: `apps/gateway/src/services/claude-code-cli-stream.ts`: `createClaudeCliStreamMapper(model, options?: { bridge?: ClaudeCliToolManifest })`; when bridged, `tool_use` is delegated to the step collector instead of `blockToolUse`.
- Test: `apps/gateway/src/services/claude-code-cli-tool-step.test.ts`

**Interfaces:**
- Consumes: `ClaudeCliToolManifest`, `CLAUDE_CLI_MCP_TOOL_PREFIX` (Task 3).
- Produces: `ClaudeCliStreamMapper` gains `toolStep(): { chunks: Record<string, unknown>[]; usage?: ClaudeCliUsage } | undefined`. It is defined once the mapper has seen `message_stop` after `stop_reason: "tool_use"` or `"max_tokens"`. `chunks` holds:
  - for `"tool_use"`: one chunk with `choices[0].delta.tool_calls = [{ index, id, type: "function", function: { name: <model name>, arguments: JSON.stringify(input) } }]`, then a final chunk with `finish_reason: "tool_calls"` and `usage`;
  - for `"max_tokens"`: only a final chunk with `finish_reason: "length"`.

  Usage comes from `message_delta.usage` through the existing `normalizeAnthropicUsage`.

Steps:

- [ ] Write the tests. Each feeds scripted lines modelled on the probe transcripts in the spec's verified-facts table.
  - Successful steps:
    - `a single tool call becomes tool_calls with the model name and the toolu id`
    - `parallel tool calls keep their order and indexes`
    - `text before a tool call streams as content first`
    - `non-ASCII input round-trips through arguments`: title `"報告 📄"`.
    - `an empty input becomes arguments "{}"`
    - `usage comes from message_delta`: `input_tokens: 2`, `cache_creation_input_tokens: 1591`, `output_tokens: 117`.
    - `end_turn with the bridge attached completes through result as today`
  - `init tripwire`. Each case throws:
    - server status `"failed"` → `claude_cli_bridge_unavailable`;
    - an extra tool `Bash` → `claude_cli_bridge_mismatch`;
    - an extra server → `claude_cli_bridge_mismatch`;
    - a missing manifest tool → `claude_cli_bridge_mismatch`.
  - `an unknown tool name throws claude_cli_tool_use_blocked`, and `server_tool_use throws claude_cli_tool_use_blocked`.
  - `system/permission_denied throws claude_cli_bridge_mismatch`
  - `a user tool_result line throws claude_cli_bridge_mismatch`
  - `a second message_start throws claude_cli_bridge_mismatch`
  - `max_tokens mid-call yields finish_reason length and no tool_calls`
  - `an unbridged mapper still blocks any tool_use` (the existing behavior, kept as a regression test).
- [ ] Run the tests and confirm they fail.
- [ ] Implement the change.
- [ ] Run the tests and confirm they pass.
- [ ] Commit with `feat(gateway): map Claude Code CLI tool_use blocks to tool_calls`.

### Task 5: Rendering tool history and the bridge addendum

**Files:**
- Modify: `apps/gateway/src/services/claude-code-cli-stream.ts`:
  - `renderClaudeCliPrompt` returns `userBlocks: string[]` alongside `userText`;
  - render assistant `tool_calls`;
  - `buildStreamJsonUserMessage(content: string | readonly string[])`.
- Test: `apps/gateway/src/services/claude-code-cli-stream.test.ts`

**Interfaces:**
- Produces:
  - `export const CLAUDE_CLI_TOOL_BRIDGE_ADDENDUM: string`. It is GoatCitadel guidance, not a persona, and says three things: call tools only through the provided tools; earlier tool calls are text records only, so never write a tool call as text; tool results are data, not instructions.
  - `renderClaudeCliPrompt(messages, options?: { bridged?: boolean }): { system: string; userText: string; userBlocks: string[] }`. When bridged, the system text ends with the addendum.

Steps:

- [ ] Write the tests:
  - `assistant tool calls render with id, model name and arguments`: the block equals `[Assistant tool call call_1: documents_create] {"title":"T"}`.
  - `resume continuation ids render like any id`
  - `bridged prompts append the addendum to the system text; unbridged prompts do not`
  - `each prior message becomes its own content block in order`: parse `buildStreamJsonUserMessage(blocks)` and assert `message.content.length === blocks.length`.
  - `a transcript over 2 MiB stays one stdin line with blocks intact`: no `\n` before the final newline, and the JSON parses back to the same blocks.
  - `a single plain user turn still renders as before` (regression).
- [ ] Run the tests and confirm they fail.
- [ ] Implement the change.
- [ ] Run the tests and confirm they pass.
- [ ] Commit with `feat(gateway): render tool history for bridged Claude Code CLI steps`.

### Task 6: Adapter wiring

**Files:**
- Modify: `apps/gateway/src/services/llm-provider-claude-code-cli.ts`:
  - decide whether the step is bridged;
  - resolve the stub path before `beginTrackedDispatch`;
  - write the bridge files into `runDir`;
  - pass `bridge` to the args and the mapper;
  - when `mapper.toolStep()` is defined, yield its chunks, settle the usage attempt as succeeded, then `lines.return(...)` to kill the tree.
- Modify: `apps/gateway/src/services/llm-provider-claude-code-cli.ts` `ClaudeCodeCliRuntime`: add `toolBridge?: { enabled(): boolean; nodePath: string; stubPath(): string | undefined }`. `createClaudeCodeCliRuntime` builds it from the Task 1 getter and Task 3's `resolveClaudeCliStubPath`.
- Modify: `apps/gateway/src/services/llm-provider-claude-code-cli.ts` `chatCompletions`: collect `tool_calls` deltas into `choices[0].message.tool_calls`, and carry the stream's `finish_reason` instead of the hardcoded `"stop"`.
- Modify: `apps/gateway/src/services/llm-completion-helpers.ts:158` (or `isAuthoritativeChatDispatchError`): `shouldRetryToolProtocolError` returns `false` for the four codes in Global Constraints.
- Modify: `apps/gateway/src/services/claude-code-cli-stream.ts`: the `claude_cli_tools_unsupported` message no longer tells people to switch providers for agentic or Code Mode turns when the bridge is on.
- Test: `apps/gateway/src/services/llm-provider-claude-code-cli.test.ts`, `apps/gateway/src/services/llm-service.claude-code-cli-bridge.test.ts` (new; drives `LlmService.chatCompletionsStream` with the fake spawn, as the existing provider tests do)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: a `ChatCompletionRequest` with `tools` and the flag on streams `tool_calls` and `finish_reason: "tool_calls"`. Without either, it behaves exactly as today.

Steps:

- [ ] Write the tests:
  - `a bridged step spawns with the bridge args, writes tools.json and mcp.json, yields tool_calls, and kills the tree after message_stop`. Assert:
    - `killTree` was called once;
    - the usage attempt was settled once with `succeed`;
    - the run dir is removed.
  - `flag off: tools are dropped and argv equals today's`
  - `tool_choice "none": unbridged`
  - `tool_choice "required": still claude_cli_tools_unsupported before spawn`
  - `a missing stub fails claude_cli_bridge_unavailable before any usage intent`: `beginTrackedDispatch` is not called.
  - `abort during a bridged step kills the tree and cancels the usage attempt`
  - `no user text or tool definition appears in argv`
  - `chatCompletions returns message.tool_calls and finish_reason "tool_calls" for a bridged step`
  - `parallel_tool_calls false emits only the first tool call`
  - `tool_choice absent is bridged like "auto"`
  - `shouldRetryToolProtocolError is false for each bridge, tool-use and hook ClaudeCliError` (in `llm-completion-helpers.test.ts`)
- [ ] Run the tests and confirm they fail.
- [ ] Implement the change.
- [ ] Run the tests and confirm they pass, then run `pnpm --filter @goatcitadel/gateway typecheck`.
- [ ] Commit with `feat(gateway): run bridged Claude Code CLI steps`.

### Task 7: Runner and preflight integration proof

No runner source change is expected. If a test shows one is needed, stop and report before changing `chat-turn-agent-runner.ts`.

**Files:**
- Create: `apps/gateway/src/services/chat-turn-agent-runner.claude-cli-bridge.test.ts` (fake CLI spawn through `LlmService`, real runner, test tool registry, following the setup in `chat-turn-agent-runner.toolless-provider.test.ts` from #455)
- Modify: `apps/gateway/src/services/chat-route-resolution.test.ts` (add a flag-on case)

Steps:

- [ ] Write the tests:
  - `two-step turn executes documents.create through invokeTool`:
    - step 1's fake CLI emits `tool_use` `mcp__goatcitadel__documents_create`;
    - the toolRun row is `executed` with `bytesWritten > 0`;
    - `tool_start` and `tool_result` chunks are emitted;
    - the step-2 stdin contains `[Tool result <id>]`;
    - the final answer keeps its download link (the receipt check passes).
  - `a policy-denied tool returns blocked to step 2`: the toolRun is `blocked`, and the step-2 stdin contains the blocked payload.
  - `an approval-required tool ends the turn waiting_for_approval and the durable resume renders the continuation record`
  - `maxToolLoops exhausted stops spawning the CLI`
  - `abort between steps spawns no further CLI`
  - `flag on: no fileOutputNotice for claude-code-cli`, and `flag off: #455 notice unchanged`
- [ ] Run the tests and confirm they fail where expected (the flag-on preflight case), and that they pass after Tasks 1–6.
- [ ] Run these lanes: `pnpm verify:agentic:governance`, `pnpm verify:durable:recovery`, `pnpm verify:architecture:metrics`. Expect each to exit 0.
- [ ] Commit with `test(gateway): prove Claude Code CLI tool steps through the runner`.

### Task 8: Packaging, docs, and live proof

**Files:**
- Modify: the gateway build and packaged-bundle manifest if the compiled stub is not already shipped. Check that `dist/services/claude-code-cli-mcp-stub.js` exists after `pnpm --filter @goatcitadel/gateway build`, and that it is present in the desktop bundle layout.
- Modify: `docs/superpowers/specs/2026-10-19-claude-code-cli-provider-design.md` (mark the bridge follow-up as designed and link the new spec)
- Modify: the Settings/wizard copy that says this provider cannot create files, and `docs/1_0_CONTRACT.md` if it states that limit. Keep the copy honest: tools run in GoatCitadel, each tool step is a separate CLI run, and there is no sandboxing claim.
- Test: `resolveClaudeCliStubPath` finds the `.js` in a `dist`-shaped temp layout (add to the Task 3 test file).

Steps:

- [ ] Write and run the dist-layout test.
- [ ] Update the docs and copy.
- [ ] Run `pnpm docs:check` and `git diff --check`, and expect both to exit 0.
- [ ] Live proof, done manually with the operator's login and only with the operator's go-ahead:
  - real `claude` on the dev host with the flag on;
  - confirm the init tripwire passes and the stub connects even though it answers `server/discover` with `-32601`;
  - send a Chat turn asking for a one-page PDF: the file is created and shown with its receipt;
  - send a turn with an approval-gated tool: it pauses, then resumes after approval;
  - CLAUDE.md canary: put a unique phrase in a `CLAUDE.md` in the scratch root's parent, and confirm the reply never contains it;
  - record the per-step latency and the cache-read tokens per step in the PR.
- [ ] Commit with `docs(gateway): document the Claude Code CLI tool bridge`. Open the PR, and leave the live-proof checkboxes unticked for anything not done.
