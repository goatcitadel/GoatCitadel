# Manual verification — cron + subagent control knobs

Branch: `feature/cron-no-agent-subagent-controls`.

This is the manual-probe checklist for O3/O4/O5/O6 from the 2026-05-15 upstream gap review. The unit tests in this PR cover all paths; this doc is for sanity-checking the integration end-to-end against a running gateway.

## Prereqs

- Build the gateway: `pnpm --filter @goatcitadel/gateway build`
- The compiled `cron-cli` binary is available as `goatcitadel-cron` (registered in `apps/gateway/package.json`).

## O4 — `no_agent` cron kind

### Empty stdout → silent

1. Create a job that echoes nothing:
   ```bash
   # via gateway API or whatever you use to create cron jobs
   # action: "no_agent"
   # actionConfig: { noAgent: { command: "echo", args: [""] } }
   # schedule: any valid cron schedule
   ```
2. Trigger it: `goatcitadel-cron run probe-empty`
3. Inspect the realtime event stream. Assert **no** `cron_no_agent_output` event fires.
4. `goatcitadel-cron runs --run-id <id>` returns a record whose `output` is **undefined** (omitted from the JSON).

### Non-empty stdout → verbatim delivery

1. Create a job:
   ```jsonc
   {
     "action": "no_agent",
     "actionConfig": { "noAgent": { "command": "echo", "args": ["alert"] } },
     "schedule": "0 */6 * * * UTC"
   }
   ```
2. Trigger: `goatcitadel-cron run probe-alert`
3. Realtime event payload includes:
   ```jsonc
   { "type": "cron_no_agent_output", "output": "alert", ... }
   ```
   (Trailing newlines are stripped; the payload reflects raw stdout otherwise.)
4. Job snapshot has `lastRunOutput: "alert"` and `lastRunId` set.

## O5 — `context_from` chaining + per-job `workdir`

### `context_from` resolution

1. Create upstream job:
   ```jsonc
   { "jobId": "upstream", "action": "no_agent", "actionConfig": { "noAgent": { "command": "echo", "args": ["X"] } }, ... }
   ```
2. Trigger upstream. Verify `lastRunOutput: "X"`.
3. Create downstream:
   ```jsonc
   { "jobId": "downstream", "action": "task", "contextFrom": "upstream", ... }
   ```
4. Trigger downstream. The task handler receives `{ contextFrom: "upstream", contextOutput: "X" }` as its second argument. The downstream task can prepend `contextOutput` to its prompt.

(The cron service resolves context. Whether the task handler actually prepends it to the LLM prompt is the handler's responsibility — see `apps/gateway/src/services/gateway-service.ts` for the task-handler wiring.)

### `workdir`

1. Create a `no_agent` job with `workdir: "/tmp/test"` (or `C:\\temp` on Windows). Command: `pwd` (Unix) or `cd` (Windows).
2. Trigger. The realtime event's `output` equals the workdir path.

## O6 — `goatcitadel-cron run --wait` + `cron runs --run-id`

### Blocking run

```bash
goatcitadel-cron run my-job --wait --timeout 60000 --poll-interval 250
```

- Blocks until the job completes (or the 60s timeout).
- Prints the final run snapshot as JSON and exits 0.
- Without `--wait`, the call returns immediately after queuing and prints just `{ jobId, runId, status }`.

### Timeout

```bash
goatcitadel-cron run my-job --wait --timeout 100 --poll-interval 50
```

If the run doesn't complete in 100ms, the CLI rejects with `cron run --wait timed out after 100ms (runId=...)` and exits 1.

### Lookup by run id

```bash
goatcitadel-cron runs --run-id <id>
```

Prints the snapshot from `lastRunId` if it matches any job; errors otherwise.

## O3 — Subagent budgets

### `timeout_exceeded`

1. Configure: in gateway config, set `agents.defaults.subagents.childTimeoutSeconds: 1` (1 second for fast verification).
2. Trigger a delegation whose child run takes longer than 1s (e.g., a slow LLM call).
3. The parent run fails with diagnostic `code: "timeout_exceeded"`. The `agentSendChatMessage` call inside the dominant LLM path is aborted via `AbortSignal` and the underlying `fetch` is canceled.

### `max_depth_exceeded`

1. Configure: `agents.defaults.subagents.maxDepth: 2`.
2. Trigger a delegation chain that nests 2+ levels deep (one delegation that itself spawns a delegation).
3. The grandchild spawn is rejected with diagnostic `code: "max_depth_exceeded"` before `agentSendChatMessage` is called.

The parent depth is auto-inferred for in-session subagent callers from `taskSubagents.findByAgentSessionId(...).metadata.depth`. Explicit `parentSubagentDepth` on the request still overrides the lookup.

## Known limitations / follow-ups

- **AbortSignal scope.** Plumbed through the dominant LLM path chokepoint (`runAgentSendChatMessageLlmPath`). Integration transports (Slack/etc.), durable runs, and orchestration phase execution still use their existing cancellation lifecycles — the budget race throws on schedule but in-flight calls on those paths aren't hard-aborted. Wire those if/when a use case appears.
- **Two-migration split.** Postgres migrations 32 and 33 split the 4 new cron-job columns into two ALTERs; could be merged into one. No functional difference, idempotent (`IF NOT EXISTS`).
- **Unrelated kanban commit.** `f2f9b0c1 feat(kanban): TaskDistressEngine helpers` landed on this branch via a subagent that picked up untracked files from a concurrent feature worktree. It does not conflict with cron/subagent work but should probably be moved to its own branch before merging the PR.
