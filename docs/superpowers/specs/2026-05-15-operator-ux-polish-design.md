# Operator UX Polish — Design Spec (O19 + O17 + Operator Diagnostics)

**Date**: 2026-05-15
**Branch**: `goatrocity/zen-chatelet-e8461d` (current worktree branch; spec originally named `feature/operator-ux-polish` but worktree is already provisioned)
**Scope**: Single PR covering the full operator-UX-polish bundle from the upstream gap-review. Originally proposed as 3 PRs; consolidated into one at the user's direction. Big diff, slow review, but nothing falls through the cracks.

## What this PR ships

Three component areas plus four smaller follow-ups from the original out-of-scope list:

1. **O19 — Shell Command Explainer** (Approval Inbox + extras)
2. **O17 — Channel Bot-Loop Guard**
3. **Operator Diagnostics** (5 sub-items: phase spans + active-work labels, stale runtime-session markers, plugin doctor health rollup, supervisor restart handoffs, sessions CLI runtime line)
4. **O19 follow-ups** (originally out of scope, now in scope):
   - Persisted `ApprovalRequest.shellExplanations` on the contract + storage + realtime
   - Localization scaffold (English-only strings still, but routed through an `t(key, params)` shim)
   - Per-command policy gating (config-driven auto-elevation when shell risks cross a threshold)

## Why one PR

The user accepted the tradeoff: single review, single branch, single artifact. Reviewers should expect to use the spec document as a roadmap through the diff. Section headings below match the commit prefixes the implementation will use (`feat(o19-explainer)`, `feat(o19-policy)`, `feat(o17-loop-guard)`, `feat(diagnostics-phase-spans)` etc.) so reviewers can map commit → spec section.

---

## Component 1: O19 — Shell Command Explainer

### Goal

Approval Inbox in Mission Control Next currently renders shell commands as raw bullets. Operators must visually parse `git push --force origin main` and infer `--force` rewrites remote history. Add a structured explainer that decodes commands into a one-line summary, labeled detail rows, and risk findings.

The visual target was approved on 2026-05-15: `.superpowers/brainstorm/.../o19-before-after.html`.

### Architecture

```
packages/mission-control-shared/src/content/
  shell-command-explainer.ts          # pure logic, source of truth
  shell-command-explainer.test.ts     # vitest, ~16 cases

apps/gateway/src/services/
  shell-command-explainer.ts          # gateway wrapper (re-exports + storage hook)
  shell-command-explainer.test.ts     # wiring smoke test

apps/mission-control-next/src/features/native-routes/ops/
  ApprovalsRoutePage.tsx              # render explanations inside evidence panel
  ShellExplanationList.tsx            # new sibling component
  ShellExplanationList.test.tsx       # render assertions
  ApprovalsRoutePage.test.tsx         # integration test
```

### Parsing pipeline

1. **String-level risk pre-screen** (before tokenization, survives tokenize failures):
   - `... | sh` / `... | bash` → danger (`pipe-to-shell`)
   - `sudo ` prefix → caution (`sudo`)
   - `> /etc/...`, `> /usr/...`, `> /var/...`, `>> /etc/...` → danger (`system-path-write`)
   - `chmod 777` / `chmod -R 777` → caution (`world-writable`)
2. **Tokenize** with `shell-quote.parse` (pure JS, ~10KB, MIT, already common in npm).
3. **Program dispatch** on the first string token. Per-command handlers: `git`, `rm`, `curl`, `wget`, `npm`, `pnpm`, `yarn`, `ssh`, `chmod`, `mv`. Anything else → generic fallback handler.
4. **Tokenize failure** (e.g. unmatched quote): `{ parsed: false, command, summary: "Unparsed shell command", details: [], risks: <pre-screen findings> }`. UI still renders raw command + pre-screen risk chips.

### Risk pattern table (v1)

| Pattern | Level | Notes |
|---|---|---|
| `git push --force` / `-f` | danger | "rewrites remote branch history" |
| `git push --force-with-lease` | danger | "force-push with lease — still destructive" |
| `git reset --hard` | danger | "discards uncommitted work" |
| `rm -rf` / `rm -fr` / `rm -r -f` | danger | "recursively deletes without confirmation" |
| `rm -rf /` | danger | extra finding "deletes from filesystem root" |
| `<cmd> \| sh` / `<cmd> \| bash` | danger | "executes remote content as a shell script" |
| `sudo` prefix | caution | "runs as root" |
| `chmod 777` / `chmod -R 777` | caution | "world-writable" |
| `> /etc/...`, `> /usr/...`, `> /var/...` redirect | danger | "overwrites system file" |
| `ssh root@...` | caution | "root login" |
| `curl ... -k` / `--insecure` | caution | "skips TLS verification" |

### Data model

Exported from `packages/mission-control-shared/src/content/shell-command-explainer.ts`:

```typescript
export type ShellRiskLevel = "info" | "caution" | "danger";

export interface ShellRiskFinding {
  readonly level: ShellRiskLevel;
  readonly label: string;        // i18n key already resolved
  readonly explanation: string;  // i18n key already resolved
}

export interface ShellExplanationDetail {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly noteLevel?: ShellRiskLevel;
}

export interface ShellCommandExplanation {
  readonly command: string;
  readonly parsed: boolean;
  readonly program?: string;
  readonly summary: string;
  readonly details: readonly ShellExplanationDetail[];
  readonly risks: readonly ShellRiskFinding[];
  readonly highestRisk: ShellRiskLevel;
}

export function explainShellCommand(command: string, options?: { locale?: string }): ShellCommandExplanation;
```

### Contract + storage persistence (was out of scope)

Add `shellExplanations` to `ApprovalRequest` in `packages/contracts`:

```typescript
interface ApprovalRequest {
  // ...existing fields
  shellExplanations?: readonly ShellCommandExplanation[];
}
```

Storage repository gets a single new mutator:

```typescript
// packages/storage/src/approvals.ts
setShellExplanations(approvalId: string, explanations: readonly ShellCommandExplanation[]): boolean;
```

The gateway approval-creation flow runs `explainShellCommand` against each command extracted from the approval payload (using the same extraction logic as `buildApprovalEvidenceModel`'s `commands` traversal), then calls `setShellExplanations`. Persistence is synchronous on creation — no realtime needed for the initial write since the UI fetches the approval after creation.

Realtime: when explanations are added (e.g. retroactively via a doctor repair), publish on the existing `approval.updated` channel. No new event type.

### Localization scaffold (was out of scope)

Add a minimal i18n shim in `packages/mission-control-shared/src/content/i18n.ts`:

```typescript
type Locale = "en";
type I18nKey =
  | "shell.action.git_push"
  | "shell.action.rm"
  | "shell.action.curl"
  | "shell.risk.force_push.label"
  | "shell.risk.force_push.explanation"
  // ...
;
export function t(key: I18nKey, params?: Record<string, string>, locale?: Locale): string;
```

v1 ships English-only. The shim exists so future locale additions are not a Big Bang. All strings emitted by `shell-command-explainer.ts` go through `t()`. No new runtime dep — the shim is a plain TypeScript module with a frozen English bundle.

### Per-command policy gating (was out of scope)

New config section in `apps/gateway/src/config.ts`:

```typescript
interface ShellExplainerPolicyConfig {
  enabled: boolean;                         // default true (on)
  elevateOnDanger?: "caution" | "danger" | "nuclear";  // default "danger" (on)
  autoRejectOnDanger?: boolean;             // default false (destructive; opt-in only)
}
```

Gateway approval-creation flow checks the policy after computing explanations. If `enabled && elevateOnDanger` is set and any explanation has `highestRisk === "danger"`, the approval's `riskLevel` is elevated to at least the configured tier before the approval is stored. If `autoRejectOnDanger`, the approval is created with `status: "rejected"` and a `resolutionNote` indicating which command triggered the policy.

`enabled` and `elevateOnDanger` default on so the polish actually changes operator behavior out of the box: any approval with a danger shell finding is at least marked `danger`, regardless of what risk the upstream caller assigned. `autoRejectOnDanger` stays opt-in because auto-rejecting is destructive and should be a deliberate operator choice.

### Doctor backfill repair

`doctor --deep` gains a new repair check `approvals-shell-explanations-backfill`:
- Audit: counts pending approvals with `commands` evidence but no `shellExplanations` field. Reports as `warn` if any.
- Repair: walks those approvals, runs `explainShellCommand` against each command, calls `storage.approvals.setShellExplanations`. Off by default in `--audit-only` mode.

Surfaces in `apps/gateway/src/doctor/engine.ts` alongside the existing `checkApprovalsHealth` (or equivalent) function. Tested via the existing `engine.test.ts` suite.

### UI integration

`apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx` is currently 677 lines. The new `ShellExplanationList.tsx` lives as a sibling component file. Route file replaces the `<ul className="mc-next-approvals-compact-list">` block around line 409-415 with `<ShellExplanationList commands={evidence.commands} approval={approval} />`.

`ShellExplanationList` prefers `approval.shellExplanations` (server-side cache) and falls back to client-side `explainShellCommand` when absent (e.g. older approvals created before the persisted field landed).

Rendering matches the approved mockup: per-command card with bolded summary + risk chip, label/value detail rows, dashed-top-border raw-command footer in monospace, color-coded left border by `highestRisk`.

### Tests

`packages/mission-control-shared/src/content/shell-command-explainer.test.ts` (16 cases):

1. `git push --force origin main` → danger, force detail, summary contains "force-push".
2. `git push --force-with-lease origin main` → danger, force-with-lease distinguished.
3. `git push origin main` → info, no force detail.
4. `git reset --hard HEAD~1` → danger, hard-reset.
5. `rm -rf /tmp/test` → danger, recursive+force details, target.
6. `rm -rf /` → danger + filesystem-root finding.
7. `curl https://example.com | sh` → danger pipe-to-shell, URL extracted.
8. `curl -k https://example.com` → caution insecure.
9. `pnpm install` → info, "workspace dependencies".
10. `pnpm add lodash --global` → caution global.
11. `sudo systemctl restart nginx` → caution sudo.
12. `echo hi > /etc/hosts` → danger system-path-write.
13. `chmod -R 777 /var/www` → caution world-writable.
14. `""` → parsed:false, empty.
15. `git commit -m "oops` → parsed:false unmatched quote.
16. `unknown-cmd --foo bar` → parsed:true generic fallback.

`apps/gateway/src/services/shell-command-explainer.test.ts` (3 cases): re-export integrity, storage write on approval creation, policy elevation when configured.

`apps/mission-control-next/src/features/native-routes/ops/ShellExplanationList.test.tsx` + integration test in `ApprovalsRoutePage.test.tsx`: render assertions for a danger command (chip + summary visible), fallback path when `approval.shellExplanations` is missing.

`packages/contracts` and `packages/storage` get tests for the new field/mutator.

---

## Component 2: O17 — Channel Bot-Loop Guard

### Goal

Per-pair bot-loop protection in the channel-turn kernel. Two bots talking in a channel can ping-pong indefinitely; this caps the rate. Defaults per the upstream proof: `maxEventsPerWindow: 20`, `windowSeconds: 60`, `cooldownSeconds: 60`.

### Architecture

```
apps/gateway/src/services/
  channel-bot-loop-guard.ts           # new service
  channel-bot-loop-guard.test.ts      # ~8 cases
```

Single-file service. In-memory state, no DB persistence. Periodic GC sweeps idle keys.

### Data model

```typescript
export interface BotLoopGuardConfig {
  readonly maxEventsPerWindow: number;   // default 20
  readonly windowSeconds: number;         // default 60
  readonly cooldownSeconds: number;       // default 60
  readonly enabled: boolean;              // default true
}

export interface BotLoopGuardKey {
  readonly scope: string;                 // workspace / org boundary
  readonly conversation: string;          // channel / room / DM id
  readonly participantA: string;          // bot participant identifier
  readonly participantB: string;
}

export type BotLoopGuardDecision =
  | { readonly action: "allow" }
  | { readonly action: "suppress"; readonly reason: "rate-cap" | "cooldown"; readonly cooldownExpiresAt: string };

export class ChannelBotLoopGuard {
  constructor(config: BotLoopGuardConfig, now: () => number = Date.now);
  /** Record an attempted bot-authored event. Returns "allow" or "suppress". */
  decide(key: BotLoopGuardKey): BotLoopGuardDecision;
  /** Lookup current state without recording. */
  inspect(key: BotLoopGuardKey): { eventsInWindow: number; suppressedUntil?: string };
  /** GC idle keys older than the cooldown horizon. Called by scheduler. */
  gc(): number;
}
```

The pair key is canonicalized: `(participantA, participantB)` is sorted so `(bot1, bot2)` and `(bot2, bot1)` collide on the same bucket. Direction is irrelevant for loop detection.

### Bot-authored role inference (new prerequisite)

A codebase grep on 2026-05-15 confirmed there is no existing `isBot` / `authorRole === "bot"` predicate inside GoatCitadel's conversation graph. Bot detection today only exists at the webhook boundary (Telegram, Nextcloud Talk). O17 cannot gate something that isn't defined, so this PR first lands a small participant-role inference:

```
apps/gateway/src/services/
  channel-participant-role.ts         # new — single function
  channel-participant-role.test.ts
```

```typescript
export type ChannelParticipantRole = "human" | "bot" | "assistant" | "system" | "unknown";

export function inferChannelParticipantRole(participant: ChannelParticipant): ChannelParticipantRole;
```

Inference rules (v1):
- Participants linked to an agent profile → `assistant` (treated as bot for loop-guard purposes).
- Participants whose connector type is `discord-bot` / `telegram-bot` / `slack-bot` etc. → `bot`.
- Participants linked to a human user record → `human`.
- System-emitted events (no participant) → `system`.
- Anything else → `unknown` (treated as human for guarding — never gated, fails-open).

Only `bot` and `assistant` are considered "bot-authored" for the loop guard.

### Integration points (thorough coverage)

The guard hooks into every bot-event dispatcher. Primary path:

- `channel-delivery-runtime-service.ts` — outbound channel message enqueue.

Secondary paths surveyed during implementation, each either routed through the guard or documented as exempt:

- `channel-bot-live-probes.ts` — periodic liveness probes; routed through guard so a flapping probe doesn't trigger a runaway cascade.
- `agentic-improvement-bridge-service.ts` — cross-agent dispatch; routed through guard.
- `chat-agent-orchestrator.ts` — multi-agent loops; routed through guard.

At each call site:

```typescript
const decision = guard.decide(key);
if (decision.action === "suppress") {
  emitChannelSuppressedEvent({ key, reason: decision.reason, cooldownExpiresAt: decision.cooldownExpiresAt });
  return;
}
```

A new event type `channel.bot_event.suppressed` is added to the existing channel-event publisher so doctor/diagnostics can count suppressions. The event includes the key, reason, and `cooldownExpiresAt`.

Any additional bot-event dispatchers discovered by a grep on `participant.*role|inferChannelParticipantRole|publishChannelEvent` during implementation get the same treatment. If a path cannot be routed through the guard for a documented reason (e.g. system-emitted events, single-shot bootstrap events), that reason is recorded in a code comment at the call site.

### Configuration

Defaults from spec. Configurable via `apps/gateway/src/config.ts` under a new `channelBotLoopGuard` section. Env-overridable for ops.

### Tests

`channel-bot-loop-guard.test.ts`:

1. Allows the first 20 events in a 60s window for one pair.
2. Suppresses event 21 in the same window with `reason: "rate-cap"`.
3. After 60s cooldown elapses, allows new events.
4. While in cooldown, subsequent attempts return `reason: "cooldown"`.
5. Different pairs in the same conversation are independent (each gets its own 20).
6. Sorted-pair canonicalization: `(botA, botB)` and `(botB, botA)` share the same bucket.
7. `inspect()` reports state without mutating.
8. `gc()` evicts idle keys.

`channel-delivery-runtime-service.test.ts` gets a wiring test: feed in 21 bot-pair events, assert the 21st never reaches the underlying delivery and a `channel.bot_event.suppressed` event was emitted.

---

## Component 3: Operator Diagnostics

Five sub-items. Each gets its own commit prefix and section below.

### 3.1 Startup phase spans + owner-level attribution

**Goal**: Gateway startup currently logs only "listening on host:port". When startup is slow (Postgres recovery, plugin discovery), operators can't tell which phase ate the time. Add phase spans with owner labels.

**Architecture**:

```
apps/gateway/src/diagnostics/
  startup-phases.ts                   # new — phase registry + timing
  startup-phases.test.ts
```

A `StartupPhaseRecorder` is created early in `app.ts`'s `buildApp` and threaded through plugin registrations. Each phase has an `id`, `owner` (e.g. "auth", "storage", "plugins", "sidecar"), `startedAt`, `finishedAt`, `durationMs`, and `notes`. On `app.ready()`, all phases are flushed to the logger at INFO level and saved to a singleton `StartupPhaseSnapshot` queryable by `doctor --deep`.

Phases instrumented in v1:
- `env_load`
- `storage_init` (Postgres lifecycle)
- `auth_load`
- `plugin_discovery`
- `sidecar_init`
- `route_registration`
- `ready`

**Active-work labels**: long-running operations (≥ 5s) emit an interim `phase.in_progress` log every 10s with the current age. When `doctor --deep` queries phases mid-startup, the snapshot exposes "compacting session X for 47s"-style markers.

**Tests**: `startup-phases.test.ts` covers phase open/close, duration measurement, snapshot output, in-progress labels.

### 3.2 Stale runtime-session markers (adapted from upstream "terminal-bridge")

**Goal**: The upstream OpenClaw proof references "stale terminal-bridge markers". A codebase grep on 2026-05-15 confirmed GoatCitadel has no service named `terminal-bridge`. The functional gap the upstream change addresses — long-lived runtime sessions claiming "active" while their heartbeat has gone silent — applies to several GoatCitadel concepts: orchestration lifecycle runs, channel-delivery runtime records, TUI session rows surfaced by `sessions-list` route. v1 lands the generic mechanism and applies it to the two highest-leverage cases.

**Architecture**:

```
apps/gateway/src/diagnostics/
  stale-session-markers.ts            # new — generic stale-state computation
  stale-session-markers.test.ts
```

A pure function `markStaleSessions(records, options)` takes any record with a `lastHeartbeatAt` (or `updatedAt`) field and returns the same record with an added `runtimeState: "active" | "stale"` based on a threshold. Default threshold: 90s.

Applied at two surfaces in v1:
- **Channel delivery runtime records** (`channel-delivery-runtime-service.ts`): records whose `updatedAt` is older than the threshold and whose status is `running` or `retrying` are surfaced as `runtimeState: "stale"` in diagnostics output. The actual status field is untouched; only the diagnostics view reflects staleness.
- **Sessions list route** (`apps/gateway/src/routes/sessions-list.ts`): same treatment for session rows.

Doctor reports a `runtime-sessions` check at `warn` if any record is marked stale, with the count and the oldest stale record's age.

**Tests**: `stale-session-markers.test.ts` covers threshold computation, missing-heartbeat handling, never-stale-when-status-is-terminal. Integration test asserts doctor surfaces stale records.

### 3.3 Plugin doctor health rollup

**Goal**: `doctor` currently reports `plugins: ok` even when individual plugins have config warnings. Roll up so any plugin warning forces `plugins: warn`.

**Architecture**: Modify the plugin-check function in `apps/gateway/src/doctor/engine.ts`. After collecting per-plugin results, set the rollup status to `warn` if any individual plugin's status is `warn` or `fail`. Detail message lists the warning plugins.

**Tests**: `engine.test.ts` adds a case with a synthetic plugin warning and asserts rollup transitions from `ok` to `warn`.

### 3.4 Supervisor restart handoffs in `doctor --deep`

**Goal**: When the dev-supervisor restarts the gateway cleanly, `doctor --deep` should show "supervisor restart handoff at T1 → T2" instead of an opaque "service stopped" marker.

**Architecture**: Locate the supervisor (`apps/gateway/src/dev-supervisor.ts` per package.json). On clean restart, write a small handoff record to a known path (`<config>/runtime/supervisor-handoffs.jsonl`, append-only, capped at last 100 entries). `doctor --deep` reads that file when reporting the gateway-service check.

**Tests**: synthetic handoff file + doctor run asserts the handoff is surfaced.

### 3.5 Sessions CLI shows agent runtime/harness

**Goal**: The sessions TUI/CLI list currently omits the agent runtime/harness columns that `/status` shows. Add them so terminal output matches the web view.

**Architecture**: Locate the sessions list rendering (`apps/gateway/src/tui/main.ts` and `apps/gateway/src/routes/sessions-list.ts`). The route already exposes session metadata; add `agentRuntime` and `harness` fields if not already there, and render them in the TUI list.

**Tests**: TUI helper test asserts the rendered table contains the new columns.

---

## Cross-cutting concerns

### Branch strategy

- Single branch: `goatrocity/zen-chatelet-e8461d` (current worktree).
- Commit prefixes by component, listed in dependency order:
  1. `feat(o19-explainer-shared)` — pure parser in mission-control-shared
  2. `feat(o19-explainer-gateway)` — gateway wrapper
  3. `feat(o19-contracts)` — `ApprovalRequest.shellExplanations` field
  4. `feat(o19-storage)` — storage mutator
  5. `feat(o19-i18n)` — localization shim
  6. `feat(o19-policy)` — per-command policy gating (defaults on)
  7. `feat(o19-ui)` — ApprovalsRoutePage + ShellExplanationList
  8. `feat(o19-doctor-backfill)` — `doctor --deep` backfill repair
  9. `feat(o17-participant-role)` — `inferChannelParticipantRole` helper
  10. `feat(o17-loop-guard)` — channel bot-loop guard service
  11. `feat(o17-integration)` — wire guard into channel delivery + secondary paths
  12. `feat(diagnostics-phase-spans)` — startup phase recorder + active-work labels
  13. `feat(diagnostics-stale-sessions)` — stale runtime-session markers
  14. `feat(diagnostics-plugin-rollup)` — doctor plugin health rollup
  15. `feat(diagnostics-supervisor-handoff)` — restart handoff records
  16. `feat(diagnostics-sessions-cli)` — sessions CLI runtime line

Each commit lands its own tests. The PR is large but each commit is reviewable in isolation.

### Testing strategy

- TDD throughout: red → green → refactor.
- Vitest for unit and integration. Existing patterns honored (no test runner change).
- 80%+ coverage on new code per repo standard.
- Manual smoke test after the last commit: spin up the gateway, create an approval with each verification command, confirm UI render.

### Sequencing

1. Land all O19 commits first — they're the most user-visible polish and exercise the new shared-package + contract + storage + UI surface.
2. Then O17 — independent, no shared state with O19.
3. Then operator diagnostics — touches doctor, supervisor, and TUI, but no contract or storage changes.

If implementation hits a blocker on any one sub-item, the rest can still ship — the per-commit boundaries keep the work portable.

### Verification (the bundle's acceptance gate)

Manual + automated verification per the original upstream gap-review, plus the in-scope follow-ups:

- Approval Inbox renders structured explanations for `git push --force origin main`, `rm -rf /tmp/test`, `curl https://example.com | sh`, `pnpm install`. First three carry visible `Danger` chips.
- Approval with a danger shell finding has its `riskLevel` elevated to at least `danger` via the policy gate.
- Pre-existing approval missing `shellExplanations` is backfilled by `doctor --deep` repair.
- Two bots talking in a channel: after 20 events in 60s, additional bot-to-bot events suppressed for 60s. Lifted after.
- Suppression also fires for the secondary integration paths (live-probes, agentic-improvement-bridge, chat-agent-orchestrator).
- Gateway startup log shows phase spans (`env_load`, `storage_init`, `auth_load`, `plugin_discovery`, `sidecar_init`, `route_registration`, `ready`).
- A long-running phase (≥ 5s) surfaces an `in_progress` label visible to `doctor --deep`.
- Channel delivery or session record with no recent heartbeat shows `runtimeState: "stale"` in diagnostics; doctor reports `runtime-sessions: warn`.
- Stale plugin config → `doctor --deep` reports warnings AND `plugins` rollup status is `warn` not `ok`.
- Restart gateway via supervisor → `doctor --deep` shows recent restart handoff record.
- Sessions CLI output includes agent runtime + harness columns matching `/status`.

Plus:
- `pnpm typecheck`, `pnpm test`, `pnpm lint` green across changed packages.
- No new native deps. New runtime dep: `shell-quote` in `packages/mission-control-shared`.
- `ApprovalsRoutePage.tsx` stays under 800 lines (component extraction is part of the diff).
- Each new gateway service file under 800 lines (split if necessary).

## Resolved design decisions

All decisions reviewed and locked on 2026-05-15:

- **Localization shim**: in. `packages/mission-control-shared/src/content/i18n.ts` with English-only v1 bundle. ~150 lines, no external dep.
- **Policy gating defaults**: `enabled: true`, `elevateOnDanger: "danger"` on by default. `autoRejectOnDanger: false` (destructive, opt-in only).
- **`shellExplanations` backfill**: in. New `doctor --deep` repair `approvals-shell-explanations-backfill`. UI fallback to client-side compute remains as a belt-and-suspenders second layer.
- **O17 integration coverage**: thorough. Guard hooks into `channel-delivery-runtime-service` (primary), `channel-bot-live-probes`, `agentic-improvement-bridge-service`, `chat-agent-orchestrator`. Implementation greps for any additional dispatchers and routes them through the guard or records an exemption.
- **O17 bot-role definition**: confirmed missing from this codebase. Added `inferChannelParticipantRole` as a prerequisite commit before the guard wires in.
- **Diagnostics 3.2 (terminal-bridge)**: confirmed not present in codebase by name. Adapted to a generic "stale runtime-session markers" mechanism with two initial application surfaces (channel delivery records, sessions list). Same functional outcome as the upstream proof.
- **Diagnostics 3.4 (supervisor)**: confirmed at `apps/gateway/src/dev-supervisor.ts`. No further change.
