# Claude Code CLI provider (`claude-code-cli`): design

Status: approved by the operator on 2026-10-19. This is PR 2 of the Claude-subscription switch. PR 1 is goatcitadel/GoatCitadel#447 (wizard copy and models for the token route). PR 3 will add wizard support for this provider.

## Intent

The operator wants GoatCitadel Chat to run on their Claude subscription instead of OpenAI Codex. The existing `claude-code` provider sends a `claude setup-token` OAuth token straight to `api.anthropic.com`. Anthropic's consumer terms limit that kind of token to Claude Code and claude.ai, and the API has been rejecting third-party use. This provider instead runs the operator's own locally installed Claude Code CLI (`claude -p`), signed in with their own `claude` login. GoatCitadel never holds, reads, or forwards a subscription credential.

## Goals

- A new provider the operator can select, which streams Chat replies through `claude -p`.
- Readiness means "the CLI is present and logged in", not "has an API key".
- Usage is recorded as subscription usage, in the subscription usage pool, with no invented dollar cost.
- GoatCitadel's policy, approvals, path jails, network allowlist, Citadel Ward, and usage accounting stay authoritative. The CLI runs as a pure text model with all of its own tools off.
- Windows-first: executable resolution, argv quoting, and process-tree cancellation all work on Windows.

## Non-goals

- Removing or changing the pasted-token `claude-code` route. It stays as it is.
- Wizard UI. That is PR 3. This PR only adds the provider template, so the provider can be picked anywhere templates are listed.
- Native tool calling (see the decisions below), vision, or audio in v1.
- Session resume or `--continue`. Each GoatCitadel turn is a fresh, stateless CLI run.

## Anti-goals

These would count as failures even if a reply streamed:

- Any "You are Claude Code" system-prompt spoof, or any reuse of the CLI's credential outside the CLI.
- The CLI's Bash, Edit, Read, WebFetch, MCP, hooks, plugins, or CLAUDE.md being active during a GoatCitadel turn.
- Spawning through a shell (`shell: true`), which is a quoting and injection hazard.
- The Gateway's `ANTHROPIC_API_KEY` leaking into the child process. The CLI would quietly bill that key instead of the subscription, and the usage would be recorded under the wrong pool.

## Decisions

### 1. A new provider id, apiStyle, and authMode, not a mode of `claude-code`

- providerId `claude-code-cli`, label "Claude Code CLI (local login)".
- `LlmApiStyle` gains `"claude-code-cli"`.
- `LlmProviderAuthMode` gains `"claude-code-cli-login"`. It stores no secret.

Why not a mode of `claude-code`: the transport (a child process instead of HTTP), auth (none held), readiness, capabilities and governance are all different. About a dozen call sites branch on `providerId === "claude-code"`. A mode flag would have to be threaded through every one of them, and one missed branch could send the pasted token over the CLI path or the other way round. Separate ids keep both routes independently supported and testable.

`baseUrl` is set to `https://api.anthropic.com/v1`. It is never fetched. It exists so that the existing `assertProviderHostAllowed` network allowlist and the Citadel Ward judge this provider as egress to Anthropic, which is honest: the CLI does talk to Anthropic. If the allowlist blocks Anthropic, this provider is blocked too.

### 2. Adapter shape

There is a new `apps/gateway/src/services/llm-provider-claude-code-cli.ts` that implements `LlmProviderAdapter` (`chatCompletions` and `chatCompletionsStream`) and is registered alongside the Anthropic and Bedrock adapters. The process plumbing lives in a separate small module, `claude-code-cli-process.ts`, behind an injectable `spawn` so tests can use a fake child process.

`LlmProviderAdapterHost` gains one method, `beginTrackedDispatch(input)`. It runs the same steps as `postTrackedJsonRequest` minus the `fetch`:

1. Citadel Ward check.
2. `modelUsageAccounting.prepareDispatch`.
3. Dispatch-guard authorization.
4. `reservation.accept()`.

It returns the `ModelUsageAttemptHandle`. The process is only spawned after the usage intent is accepted, the same ordering HTTP providers get. Credential lineage for `claude-code-cli-login` is `credentialType: "oauth"`, `credentialSource: "oauth"`, `usagePool: "subscription"`.

### 3. Spawning the CLI

Command:

```
<claude> -p --input-format stream-json --output-format stream-json --verbose
         --include-partial-messages --model <model>
         --system-prompt-file <tmp> --tools "" --strict-mcp-config
         --safe-mode --disable-slash-commands --no-session-persistence
         --permission-mode dontAsk --setting-sources "" --settings '{"disableAllHooks":true}'
```

- **Arguments:** an argv array with `shell: false` and `windowsHide: true`. No user text goes on the command line. The only argument values are the model id (validated against `^[A-Za-z0-9._:\[\]-]+$`) and a temp-file path.
- **Input:** a single stream-json user message is written to stdin, and stdin is then closed. This avoids the Windows 32K command-line limit and quoting problems.
- **System messages:** these are concatenated and written to a temp file in a Gateway-owned scratch dir (`--system-prompt-file`). The file is deleted when the run ends. This replaces Claude Code's default system prompt, so GoatCitadel's own guidance is the system prompt.
- **Conversation history:** prior user and assistant turns, plus tool results already in the transcript, are rendered as a labelled plain-text transcript inside that one user message. My call: the CLI cannot accept prior assistant turns in a fresh session. A fresh run per turn keeps GoatCitadel the owner of conversation state and durable execution.
- **Working directory:** an empty Gateway-owned scratch dir, so no project `CLAUDE.md` or settings get picked up. `--safe-mode` also turns off CLAUDE.md, hooks, plugins and MCP.
- **Flag check:** every flag above was checked against `claude --help` on Claude Code 2.1.212, the version installed on the dev host. That version is the tested floor. `--system-prompt-file` is not in the help list, but the `--bare` text names it. My call: if the CLI rejects it as an unknown option, the adapter retries once with the system text put at the top of the user message instead. Any other unknown-option failure maps to `claude_cli_incompatible`. Readiness records `claude --version` for diagnostics but does not gate on it.
- **Environment:** a small allowlist only: `PATH`, `PATHEXT`, `SystemRoot`, `SystemDrive`, `windir`, `ComSpec`, `ProgramData`, `USERPROFILE`, `USERNAME`, `USERDOMAIN`, `HOMEDRIVE`, `HOMEPATH`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, the proxy vars, and locale vars. My call: this list is broad enough for the CLI to find its own login (`~/.claude/.credentials.json` or the OS credential store). `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN` and every GoatCitadel secret are dropped.

### 4. Governance

Disabling the CLI's tools works in layers: `--tools ""` (no built-in tools), `--strict-mcp-config` with no `--mcp-config` (no MCP servers), `--safe-mode` (no hooks, plugins, skills or CLAUDE.md), and `--permission-mode dontAsk` (anything that slips through is denied rather than prompted). If the stream ever shows a `tool_use` block, the adapter treats it as a governance fault. It kills the process and fails the turn with `claude_cli_tool_use_blocked`, and does not forward the block.

The provider advertises `toolCalling: false`, `vision: false`, `audio: false`, `jsonMode: false` and `reasoning: true`. The CLI cannot do OpenAI-style function calling back to its caller, so `tools` are never passed to it. The operator decided how tool turns are handled:

- If a request requires a tool call (`tool_choice` is `"required"` or names a function), the turn fails before spawn with `claude_cli_tools_unsupported` and a hint to switch providers for agentic or Code Mode turns.
- If tools are only offered (`tool_choice` is absent, `"auto"` or `"none"`), they are dropped and the turn runs as plain text. My call: GoatCitadel tools through this provider would need a Gateway-hosted MCP bridge that goes through policy and approvals. That bridge was a follow-up to this PR; it is now designed in `2026-10-20-claude-code-cli-tool-bridge-design.md` and implemented behind the `claudeCliToolBridgeEnabled` flag. With the flag off (the default), this text-only behavior is unchanged.

### 5. Streaming into the normalized chat stream

The CLI's stream-json lines are mapped to the OpenAI-shaped chunks every other adapter yields:

| CLI line | Chunk |
|---|---|
| `stream_event` with a `content_block_delta` / `text_delta` | `choices[0].delta.content` |
| `stream_event` with a `thinking_delta` | the existing private reasoning-delta field. `llm-service` already strips it or forwards it per `streamReasoningDeltas`. |
| `assistant` with full text blocks | used only if no partial deltas arrived (older CLIs) |
| `result` with `subtype: "success"` | a final chunk with `finish_reason: "stop"`, plus `usage` in the same shape as the Anthropic Messages adapter (`prompt_tokens` = uncached input, cache read/creation fields passed through; omitted when the CLI reports none), tagged with the usage event id |
| `assistant` with `model: "<synthetic>"` | dropped: the CLI reports its own failures (e.g. "Failed to authenticate") this way before the error result |
| `result` with `is_error` or a non-success subtype | a mapped error (see section 7) |
| `system`, `rate_limit_event`, other lines | ignored; lines that are not JSON are dropped after a bounded length check |

Cost: the CLI's `total_cost_usd` is not shown as a charge. Usage is settled through `observeProviderUsageWithTrustedEstimate` with zero cost and the subscription usage pool, so Ops shows "subscription usage" with token counts.

`chatCompletions` (non-streaming) reuses the same run and concatenates the text.

### 6. Model selection, cancellation, and timeouts

- **Models:** the template's known models are `claude-sonnet-5-5` (default), `claude-opus-5-5`, `claude-haiku-5-5` and `claude-fable-5-1`, plus the aliases `sonnet`, `opus`, `haiku` and `fable`. The selected model is passed as `--model`. There is no `/models` discovery; the catalog is static.
- **Cancellation:** `request.signal` abort kills the process tree. On Windows that is `taskkill /PID <pid> /T /F`; elsewhere, `SIGTERM` and then `SIGKILL` after 3 s. The usage attempt is failed as cancelled.
- **Timeouts:** an overall cap of `resolveChatCompletionTimeoutMs(request.timeoutMs, 300000)`, plus a 120 s idle timeout with no stdout. Both kill the tree and map to `claude_cli_timeout`.
- **Bounds:** stdout lines are capped at 1 MiB each, and stderr is kept as a bounded 16 KiB tail for diagnostics. stderr is redacted before it is logged or shown.

### 7. Errors

All errors are typed with a bounded, secret-free `reasonCode` and an operator-readable message:

| Cause | reasonCode | Message hint |
|---|---|---|
| spawn `ENOENT`, or the resolver finds nothing | `claude_cli_missing` | Install Claude Code |
| exit or result text says not logged in, invalid API key, `/login`, or `authentication_error` | `claude_cli_logged_out` | Run `claude auth login` |
| usage or rate limit reached | `claude_cli_usage_limited` | Includes the reset time if the CLI gives one |
| unknown option or flag error | `claude_cli_incompatible` | Update Claude Code |
| model not found or invalid | `claude_cli_model_unavailable` | |
| a `tool_use` block appears | `claude_cli_tool_use_blocked` | |
| idle or overall timeout | `claude_cli_timeout` | |
| any other non-zero exit | `claude_cli_failed` | Includes the exit code and a redacted stderr tail |

### 8. Readiness

There is a new `ClaudeCodeCliReadiness` probe in the Gateway:

1. **Executable.** Reuse the `claude_code` entry in `agentic-harness-availability.ts`. A new shared helper there resolves it and returns every `where`/`which` line, not just the first. An optional explicit override, `GOATCITADEL_CLAUDE_CLI_PATH`, comes first.
2. **Login.** Run `claude auth status --json` (10 s timeout, the same sanitized env). On 2.1.212 a logged-out CLI returns `{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}`. The exact logged-in `authMethod` values have not been seen yet. My call: `loggedIn: true` with `apiProvider: "firstParty"` and an `authMethod` that does not mention an API key gives `ready`. `loggedIn: false` gives `missing` with reason `claude_cli_logged_out`. An API-key auth method gives `invalid` with reason `claude_cli_not_subscription_login`, because that would bill an API key and not the subscription.
3. **Cache.** The result is cached for 60 s. It is invalidated by a run that fails with `claude_cli_logged_out`.

A Gateway in Docker or a sandbox has no local `claude`, so it reports `claude_cli_missing`. That is the expected result there; this provider is meant for a native host. `resolveProvider` is already async, so the probe runs inline behind the cache. The probe is injectable for tests.

This feeds `LlmProviderAuthReadiness` (`source: "metadata"`, `liveVerified: true` only after a successful status probe). `resolveProvider({ requireAuth: true })` checks it, so a missing or logged-out CLI fails before a usage intent is created.

### 9. Windows executable resolution

- `where claude` can return `claude.exe` (native installer), `claude.cmd` or `claude.ps1` (npm shim), or an extensionless POSIX shim. The resolver prefers `.exe`.
- For a `.cmd` shim, it finds the npm package entry (`<shim dir>\node_modules\@anthropic-ai\claude-code\cli.js`) and spawns `process.execPath <cli.js>` instead. Node refuses to spawn `.cmd` without a shell, and the design never uses a shell.
- If neither works, readiness reports `claude_cli_unsupported_shim`, with a hint to install the native build or set `GOATCITADEL_CLAUDE_CLI_PATH`.

## Contracts touched

- `packages/contracts`: `LlmApiStyle`, `LLM_API_STYLES`, `LlmProviderAuthMode`, `LLM_PROVIDER_AUTH_MODES`, the zod enum in `config-schemas.ts`, `change-plan.ts` validation (it already reads `LLM_API_STYLES`), and a provider template entry with `apiStyle: "claude-code-cli"` and `authMode: "claude-code-cli-login"`.
- `llm-service.ts`:
  - register the adapter
  - `normalizeProviderApiStyle` and `defaultAuthModeForProvider` for the new id
  - credential lineage
  - the readiness hook in `resolveProvider`
  - `resolveProviderExecutionApiStyle` and the API-style allowlist near line 3849
  - make sure the `isClaudeCodeOAuthProvider` / `anthropic` branches do not match the new id
- Any exhaustive `switch` over `LlmApiStyle` in the Gateway or Mission Control gets the new case. Typecheck will find these.

## Tests

- A fake child process that emits scripted stream-json, including:
  - text deltas, then a result, which streams the reply with correct usage and the subscription pool
  - thinking deltas
  - the fallback with no partial messages
  - an injected `tool_use`, which kills the process and blocks the turn
  - abort, which calls the tree kill
  - idle timeout
  - each error mapping row
- Checks that argv has no user text, that `shell` is false, and that the env has no `ANTHROPIC_API_KEY`.
- Windows resolver cases: `.exe` preferred, `.cmd` mapped to node plus `cli.js`, and an unsupported shim.
- Readiness from a faked `auth status`.
- Through `LlmService.chatCompletionsStream`, a configured `claude-code-cli` provider streams a reply with the fake spawn injected via `LlmServiceOptions`.
- Typecheck for the gateway and contracts.

## Left to the builder

- The exact helper names and file split, keeping files under 800 lines.
- The exact transcript labels used when rendering history.
- Whether to ship the alias models in `knownModels` or document them only.

## Follow-ups (not in this PR)

- PR 3: wizard support, with a "Use my local Claude Code login" path, a readiness panel, and the logged-out remediation copy.
- A Gateway-hosted MCP bridge, so GoatCitadel tools can be offered to the CLI under policy and approvals. Designed in `2026-10-20-claude-code-cli-tool-bridge-design.md` and implemented behind the `claudeCliToolBridgeEnabled` feature flag, which defaults to off until the live proof passes. Tools run in GoatCitadel, not in Claude Code, and each tool step is a separate CLI run.
- Image input via stream-json content blocks.

## Terms note

This route uses the operator's own Claude Code install, under their own login, on their own machine, through Claude Code's documented headless mode. GoatCitadel does not extract, store, or re-send the credential. Whether automated use through `claude -p` fits a given plan's usage limits and terms is the operator's call. The UI copy in PR 3 should say so plainly and not imply that Anthropic endorses it.

## Review follow-ups (PR #448)

- **Pinned egress origin.** The profile `baseUrl` is forced to `https://api.anthropic.com/v1`. The allowlist and ward authorize that origin, because it is the one the CLI actually reaches, so an edited profile cannot slip past a blocked Anthropic host.
- **Managed hooks.** Organization-managed hooks run even with `--safe-mode` and `disableAllHooks`. Two layers handle this:
  1. Readiness refuses the provider (`claude_cli_managed_hooks_active`) when a managed settings file or drop-in defines hooks, and fails closed if that file is unreadable. The files checked are `%ProgramFiles%\ClaudeCode` and `%ProgramData%\ClaudeCode` on Windows, `/Library/Application Support/ClaudeCode` on macOS, and `/etc/claude-code` on Linux.
  2. `--include-hook-events` acts as a tripwire. Any hook event fails the turn with `claude_cli_hook_blocked`.

  Residual risk: server-delivered managed settings and Windows registry policies are not read locally, so only the tripwire covers them. A hook that runs at session start may already have run when the turn fails.
- **API-style mismatch.** The `claude-code-cli` apiStyle is rejected on any other provider id, both in the zod schema and in normalization. It is not silently swapped for an HTTP style.
- **Readiness before profile freeze.** `LlmService.ensureProviderReadiness()` runs before the Chat capability profile is frozen, so a newly started Gateway does not record "auth missing" for a logged-in CLI.
