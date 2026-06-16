# GoatCitadel — 1.0 Readiness Re-Review — 2026-06-02

> Read-only re-review after the 2026-06-01 pass. No source modified. Verified against
> `main` at HEAD `9ed0ae64b` (clean tree, in sync with `origin/main`). Supersedes
> `goatcitadel-1_0-readiness-review-2026-06-01.md` where they differ.

## Verdict

**Conditional Go — one hard, mechanical blocker remains.**

The substance moved decisively in the right direction since yesterday. The previously-uncommitted
security work is now landed cleanly, and two new governed surfaces (A2A boundary, remote-MCP
promotion) shipped — all of it exemplary truth-first engineering. The product is, in capability
terms, a credible 1.0.

But a **release-proof run cannot pass cleanly today** because one required certification lane is
**currently RED on committed `main`** — caused by the very commits that just landed. It is
mechanical to fix (reconcile a baseline or extract ~90 lines), but until it is, you cannot produce
the empty-`acceptedFailures` certificate that public-trust distribution requires.

Net: **Go, gated on one concrete item (G2 below) + one should-fix (G3).** Hours of work, not days.

---

## What changed since 2026-06-01 (the delta)

### ✅ G1 (uncommitted tree) — RESOLVED
Yesterday's 79 uncommitted changes are committed and pushed across two commits
(`eaf023075 Promote governed readiness slices`, `9ed0ae64b Implement governed A2A gateway
boundary`). Tree is clean; `main` == `origin/main`. The "can't certify a dirty tree" blocker is gone.

### ✅ NEW — Governed A2A gateway boundary (`9ed0ae64b`) — TRUTH-GATED, no over-claim
A2A was previously "preview-only until side-effects/auth/lifecycle/audit are real." The new
881-line `a2a-route-service.ts` + contracts + storage migration clears that bar honestly:
- **Disabled by default**: `config.ts:1037-1050` → `a2a.enabled/inbound/outbound/publicDiscovery` all `false`; example configs ship all-`false`.
- **Separately authenticated, fenced**: new `a2a-peer` access class in the *enforce* group (`route-access.ts:152,184`); peer auth is a distinct `authActorSource: "a2a_peer"` (lowest trust) gated by `timingSafeStringEqual` Bearer tokens — it does **not** reuse operator auth. `requireA2APeerAccess` fails closed (500) if the service isn't installed. Operator-only routes wrapped `withRouteAccess(…, "operator")`. `/.well-known/agent-card.json` 404s unless explicitly enabled.
- **Replay-safe**: inbound dispatch keyed by a DB `UNIQUE INDEX … (peer_id, idempotency_key)` (migration v59); outbound routes through `runIdempotentExternalSideEffect` + the external side-effect ledger and `fetchAllowlisted` (SSRF-guarded).
- **Docs match code**: `1_0_CONTRACT.md` scopes callable A2A to JSON-RPC/HTTPS only, lists gRPC/HTTP+JSON/push as non-callable, and adds a "must not claim" entry. `agentic-capability-availability.ts:372` only reports `callable: true` when enabled+inbound+JSONRPC+≥1 peer.

### ✅ NEW — "Promote governed readiness slices" (`eaf023075`) — TRUTH-GATED
Four slices promoted, each backed by a substantive fail-closed verification lane (`scenarios.mjs` +572):
- **Remote HTTP/SSE MCP (incl. OAuth) is now runtime-supported by default** (was experimental-flag-gated). Real implementation: full MCP initialize/tools-list/tools-call, **all egress via `fetchAllowlisted`**, OAuth tokens stored as refs in the OS secret store. I confirmed the SSRF guard is fail-closed: an empty `networkAllowlist` denies all hosts (`policy-engine/src/sandbox/network-guard.ts:67-80`), so default-on remote MCP cannot reach anything until the operator allowlists the host. Honest and safe (usability note: remote MCP is "on" but inert until a host is allowlisted — correct posture).
- **Autonomous activation grants**: deny-by-default; `evaluate` allows only on an active, future-expiry, matching operator grant; subordinate to deny-wins policy. Lane proves deny→grant→allow→revoke→deny at the live `/api/v1/mcp/invoke` boundary.
- **Mesh readiness**: `enabled:false` default; real end-to-end lane (join → lease fencing → owner epoch takeover → replication → diagnostics). Governance-doc validator *tightened* to require the evidence wording (self-enforcing against drift).
- **Hostile-code sandbox correctly NOT promoted**: runtime metadata yields `publicClaimAllowed:false` / `not_promoted`; only the Windows AppContainer *slice* claims a green canary, with the cross-platform public claim explicitly withheld. README/AGENTS still say "do not claim hostile-code sandboxing." This is the model truth-gate.

This is genuinely disciplined work: every newly-surfaced capability is flag-disabled-by-default,
operator-fenced, fail-closed, and proven by a release-proof lane — not a label change.

---

## The one hard blocker

### 🔴 G2 — `verify:architecture:metrics` is RED on committed `main` (now real, not predicted)

I **ran the lane** (`node scripts/verification/run.mjs architecture-metrics`) against HEAD.
Result: **`Status: failed`** — 6 non-increasing-metric regressions, all introduced by the two
commits that just landed (which grew the gateway surface without updating the baseline):

| Metric | Baseline | Now |
|---|---:|---:|
| GatewayService line count | 9047 | **9134** |
| GatewayService public method count | 255 | 257 |
| GatewayService `@internal` public count | 56 | 58 |
| GatewayRouteCompositionPort member count | 155 | 156 |
| (host callbacks) | 816 | 825 |
| (route-facing service count) | 57 | 58 |

`compareNonIncreasingMetric` has **zero tolerance** — any increase is a regression
(`architecture-metrics.mjs:1062`). This lane is a **required certification lane** in
`verification-1-0-release-proof.yml` and is **PR-gating** via `verification-truth-lanes.yml`
(`pull_request` paths on `apps/**`, `packages/**`). So today:
- a fresh release-proof run **cannot** produce an empty-`acceptedFailures` certificate, and
- any PR touching app/package source inherits a red required job.

Artifact: `artifacts/verification/2026-06-02T05-14-23-…-architecture-metrics-b4c25ab1/` (incl. a
generated `repair-plan.md`).

**Fix (pick one, both are quick):**
- **(a)** Decompose ~90 lines out of `gateway-service.ts` (continue the in-flight extraction
  pattern) to drop back under baseline — the principled option; or
- **(b)** Regenerate/commit the baseline **with explicit reviewer sign-off** acknowledging the
  growth as accepted debt.

Either way: stop letting this ratchet drift red on feature commits — it has now done so twice in
two days. Wire `verify:architecture:metrics` into the always-on PR lane so growth is caught at PR
time, not at release-cut time.

---

## Should-fix before tagging (not a hard gate)

### 🟡 G3 — A shipped defense is still disabled
`config/tool-policy.json:64` still ships `tools.loopDetection.enabled: false` — the
no-progress/loop/ping-pong guard never runs (2026-05-28 finding AGENTORCH-002, "trust theater").
For a trust-branded product, shipping a documented protection as dead config is the wrong look.
Either flip it on (it has sane thresholds already) or remove the dead block. (Caveat: this file's
`approvalMode: "bypass"` / `profile: "danger"` suggests it may be a dev/danger profile — confirm
the *shipped default* profile's value before deciding.)

---

## Residual nuances (watch, not block)

1. **A2A approval is delegated, not explicit.** Inbound peer messages execute a real LLM turn
   immediately; there is no A2A-specific approval interstitial. Side-effect safety rests entirely
   on the policy engine treating the `a2a_peer` actor source as lowest-trust and fencing high-risk
   tools behind approval. Recommend a focused policy-engine test asserting `a2a_peer` **cannot**
   auto-approve high-risk tools — since this is now the load-bearing guarantee for A2A.
2. **Remote-MCP usability vs safety.** Default-on but egress-denied-until-allowlisted is correct,
   but make sure the UI explains *why* a freshly-added remote MCP server can't reach its host
   (otherwise it reads as a bug, not a guardrail).
3. **Minor cleanups** (unchanged): dead ternary `mcp-oauth-token-service.ts:97`; autonomy grant
   counters can over-count on aborted Code Mode runs (conservative direction).

---

## Carry-over from 2026-06-01 (still applies)

- Strong engineering base: 821 `*.test.ts`, zero `.skip`/`.only`, disciplined coverage policy,
  real security audit with regression-tested fixes, C1 (Anthropic parallel tool-calls) fixed.
- The 2026-05-28 full-review High backlog is only partially landed on this branch — triage the
  genuine production-risk Highs (mesh-lease split-brain `STORAGE-002`, dead channel bot-loop guard
  `INTEG-001`, secret-redaction gap `COREPKG-017`, MCP Windows zombies `INFRA-001`) and either land
  or explicitly ticket-and-accept them.
- Fast-follow: install-path signing (`iwr|iex`), ESLint not run in CI, provider truth-lanes scoring
  auth-fail as `not_configured`, react-hooks lint unwired.

---

## How to prove Go now
1. **Fix G2** (decompose or sign-off-bump the baseline); re-run `verify:architecture:metrics` → green.
2. Decide G3 (flip or delete the loop-guard config).
3. `workflow_dispatch` `verification-1-0-release-proof.yml`; require **all lanes green**, including
   `architecture:metrics`, `mesh:readiness`, `code-mode:hostile-sandbox`, `visual:regression`.
4. Inspect `release-certificate.json`: **`acceptedFailures` empty**, Trivy clean.
5. Smoke the new surfaces: A2A disabled-by-default (agent-card 404s); add a remote MCP server and
   confirm it's inert until host-allowlisted; issue + revoke an autonomy grant and watch Run Detail.

## Bottom line
Substantively this is 1.0. The new A2A and remote-MCP work is the best kind of evidence for the
"trust machine" thesis — capability shipped *with* its governance, default-off, fail-closed,
proof-backed. The only thing standing between this tree and a defensible tag is a **red
architecture-metrics lane the latest commits caused** — reconcile that (and ideally flip the
dormant loop guard), get one clean release-proof run, and ship.
</content>
