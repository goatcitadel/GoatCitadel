# Gateway Decomposition — Codex Handoff

**Date:** 2026-04-08
**Target file:** `apps/gateway/src/services/gateway-service.ts`
**Current size:** 16,019 lines
**Goal:** 6,000–8,000 lines
**Branch:** `main` (clean; last commit `d48b007` 8k.3)

---

## Context

Gateway-service.ts is being decomposed via a repeatable "host delegation" pattern:

1. Create a new service module `apps/gateway/src/services/<domain>-service.ts`.
2. At the top: `export type <Domain>Host = GatewayService;`
3. Move the method **body** into a pure exported function that takes `host: <Domain>Host` as its first argument. Replace every `this.x` with `host.x`.
4. In `gateway-service.ts`, collapse the original method to a one-line delegation: `return <domain>Service.<fn>(this, ...args);` — preserve the public signature exactly.
5. Any private member the extracted code touches must be promoted to `/** @internal */ public` (JSDoc tag, not real `internal`). This keeps the public type surface stable while allowing cross-module access.
6. Use `import * as <domain>Service from "./<domain>-service.js";` (namespace import) in gateway-service.ts.

### Mandatory gates (after every extraction, before commit)

```bash
pnpm --filter @goatcitadel/gateway typecheck
pnpm --filter @goatcitadel/gateway exec vitest run src/routes/chat.routes.test.ts src/routes/chat.messages.test.ts
```

Both must be clean. The chat route tests MUST stay 17/17 — they are the canary for host-surface regressions. Pre-commit hook runs prettier + eslint (`--max-warnings 0`); expect cosmetic line wraps to get auto-applied.

### Commit convention

`refactor(gateway): <what> (8<letter>.<n>)` — e.g. `refactor(gateway): extract channel setup orchestration (8i.1)`.

---

## Progress so far (do not redo)

This session (2026-04-08) shipped:

- **cb23ea3 (8k.1)** durable workflow executors + parsers → `durable-execution-service.ts` (−261)
- **32ed0d2 (8k.2)** durable recoverability (`isDurableWorkflowRecoverable`, `markDurableWorkflowUnrecoverable`) → `durable-execution-service.ts` (−159)
- **d48b007 (8k.3)** `parseChatCommand` (671-line method) → new `chat-command-service.ts` (−658)

Previously completed (confirmed by surveying the file — the old `joyful-mixing-wigderson.md` and `zany-wiggling-flame.md` plans are stale):

- **8f (tool approvals)** — DONE. All approval/grant methods at `gateway-service.ts:5802–5936` are already one-line delegations to `approvalLifecycleService`. Do NOT re-wrap them; it adds a hop with zero line savings.
- **8g (orchestration lifecycle)** — DONE. Methods at `gateway-service.ts:9715–9738` already delegate to `orchestrationLifecycleService`. `createCheckpoint`/`scheduleOrchestrationMemoryContext` as mentioned in the old plan no longer exist on the host.
- **8h (companion session/auth)** — DONE. All 16 companion/device/auth methods at `gateway-service.ts:7636–7756` already delegate to `settingsAuthService`.

**Do not waste cycles on 8f/8g/8h.** They are already refactored; only private helpers remain (e.g. `parseToolCallHookPatch` at 11859, `getAuthDeviceRequestByApprovalId` at 11289) — not worth separate commits.

---

## Remaining work — next targets, priority order

### 8i — Channel setup orchestration (NEXT)

**Cluster to hunt for.** Look for methods whose names start with `channelSetup*`, `buildChannelSetup*`, `runChannelSetupTest*`, `validateChannelSetup*`. Anchors already spotted:

- `gateway-service.ts:9844` `buildDefaultChannelSetupDraft` (already delegates to `channelSetupHelpers`)
- `gateway-service.ts:9848` `buildChannelSetupValidationResult` (delegates)
- `gateway-service.ts:9856` `getReusableChannelSetupTestResult` (delegates)
- `gateway-service.ts:9860` `buildEphemeralChannelConnection` (delegates)
- `recentChannelSetupTests` map at line 1385

The helpers exist. What remains on the host are the **public methods** that call them (`listChannelSetupDefinitions`, `validateChannelSetupDraft`, `runChannelSetupTest`, `submitChannelSetupDraft`, etc.). Grep:

```bash
grep -n -E "^  (public|private|async) .*ChannelSetup" apps/gateway/src/services/gateway-service.ts
```

Extract all of these into a new `channel-setup-service.ts` (or extend the existing helpers module into a full service). Expected delta: 300–500 lines.

### 8j — Integration diagnostics & connection checks

Target cluster starts around **gateway-service.ts:9864** (`buildIntegrationConnectionChecks`, ~300 lines of switch/case on `connection.key` with inline URL/secret validation). Also grep for:

```bash
grep -n -E "^  (public|private|async) (build|run|validate|test)(Integration|Connector|Connection)" apps/gateway/src/services/gateway-service.ts
```

Move the big switch statement and its helper closures (`requireSecretRef`, `requireText`, `checkUrl`) into `integration-diagnostics-service.ts`. Expected delta: 400–600 lines.

### 8k.4+ — Discord pairing / channel pairing flows

Grep:

```bash
grep -n -E "^  (public|private|async) .*(Discord|Pair|pair)" apps/gateway/src/services/gateway-service.ts
```

There are pairing-code lifecycle methods (create, confirm, revoke, list) that still have inline bodies. Extract into `channel-pairing-service.ts`. Expected delta: 200–400 lines.

### 8l — Prompt pack execution (if not already done)

Check `gateway-service.ts:runPromptPackFromChat` (already promoted `/** @internal */ public`). The method body itself may still be inline. If it's >50 lines, move to `prompt-pack-service.ts` (that module already exists). Expected delta: 100–300 lines.

### 8m — Any remaining large clusters

From earlier `awk` method-span analysis, other large inline clusters sit near:

- line ~6587 (~354 lines) — unidentified, explore first
- line ~9783 (~342 lines) — feature flag area; `readFeatureFlags`/`updateFeatureFlags` may be inline and extractable to `feature-flags-service.ts`
- line ~11683 (~259 lines) — unidentified

For each: `sed -n 'START,+10p' gateway-service.ts` to identify the method name, then decide a target module.

---

## Step 9 — api/client.ts barrel split (separate from gateway-service)

**File:** `apps/mission-control/src/api/client.ts` (or similar — confirm path)
**Current:** 5,208 lines
**Target:** 9 domain files under `apps/mission-control/src/api/` (e.g. `chat.ts`, `approvals.ts`, `orchestration.ts`, `memory.ts`, `skills.ts`, `integrations.ts`, `diagnostics.ts`, `auth.ts`, `system.ts`), re-exported from a thin `client.ts` barrel.

Pattern: each method on the client is a thin `fetch()` wrapper. Group by URL prefix / contract namespace. Keep the exported type surface identical so mission-control pages don't need edits.

---

## Step 10 — Page slimming (mission-control UI)

| Page | Current | Target |
|---|---|---|
| `ChatPage` | 3,258 | <1,000 |
| `OfficePage` | TBD | <1,000 |
| `IntegrationsPage` | TBD | <1,000 |
| `SettingsPage` | TBD | <1,000 |

Pattern: extract sub-sections into feature components under `apps/mission-control/src/features/<page>/components/`, custom hooks for state/effects into `hooks/use<Thing>.ts`, and data-shaping helpers into `lib/`.

---

## Step 11 — Webhook handler factory

Webhook route handlers in `apps/gateway/src/routes/webhooks/*` share a repeated validate → authenticate → dispatch → audit shape. Extract a `createWebhookHandler({ source, verifySignature, parsePayload, dispatch })` factory. Expected to remove 30–50% of each handler file.

---

## Step 12 — Proof-lane consolidation

Multiple services compute "proof lane" status (fastLane/normalLane/slowLane) independently. Consolidate into one `proof-lane-service.ts` with a single `computeProofLane(context)` function. Audit first — grep for `proofLane` and `fastLane` before extracting.

---

## Watchouts / landmines

1. **Do NOT amend commits** — always create new ones. Pre-commit hook failures leave the previous commit intact; amending would destroy work.
2. **`/** @internal */ public` is the only way to expose private state** to extracted modules without polluting the real public API. Always use the JSDoc form.
3. **Namespace imports only** (`import * as xService from ...`) — avoid named imports from extracted modules; it makes adding new helpers require touching two files.
4. **Route tests are the canary** — if `chat.routes.test.ts` or `chat.messages.test.ts` drops below 17/17, revert immediately and re-slice smaller.
5. **Linter will reformat** chained calls across multiple lines on commit — expected, ignore.
6. **Stale plans:** `docs/plans/joyful-mixing-wigderson.md` and any `zany-wiggling-flame.md` are out of date. This handoff doc supersedes them.
7. **Memory file:** `C:\Users\spurn\.claude\projects\F--code-personal-ai\memory\gateway_service_decomposition.md` holds the authoritative pattern notes — update it as steps land.
8. **Windows + bash:** use forward slashes and `/dev/null` (not `NUL`) in shell commands.

---

## Quick-start for Codex

```bash
cd F:/code/personal-ai
git status                                          # should be clean
wc -l apps/gateway/src/services/gateway-service.ts  # baseline
grep -n -E "^  (public|private|async) .*ChannelSetup" apps/gateway/src/services/gateway-service.ts
# Pick a method cluster, extract per pattern above, run gates, commit.
```

Gate loop:

```bash
pnpm --filter @goatcitadel/gateway typecheck && \
pnpm --filter @goatcitadel/gateway exec vitest run src/routes/chat.routes.test.ts src/routes/chat.messages.test.ts
```

Start with **8i (channel setup)** — it's the next clean chunk and the helpers module already exists.
