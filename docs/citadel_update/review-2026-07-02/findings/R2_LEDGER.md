# GoatCitadel Review 2 — Fix-Verification Ledger

- **HEAD verified:** `a81eeccc4537cec3a9b71ae4cf569409ce352f83` (post-remediation)
- **Prior-review baseline:** `67c3adb64` (+ 18-file WIP, now committed)
- **Fix range:** `67c3adb64..a81eeccc4` — 16 commits, 148 files changed, 0 dependency changes
- **Captured:** 2026-07-02

---

## Section 1 — FIX VERIFICATION (63 prior findings)

### Headline tally

| Status | Count | Share |
|--------|------:|------:|
| ✅ RESOLVED | 27 | 43% |
| 🟡 PARTIAL | 8 | 13% |
| ❌ NOT_FIXED | 28 | 44% |
| 🔴 REGRESSED | 0 | 0% |
| ❓ CANT_TELL | 0 | 0% |
| **TOTAL** | **63** | |

**Fully-or-partially addressed: 35/63 (56%). Untouched: 28/63 (44%).** No prior finding was made worse *as reported* (0 REGRESSED at the prior-finding level), but the remediation introduced 5 new regressions tracked separately in Section 2. The fix effort concentrated in the MC front-end and storage/memory layers (both largely cleared) and left the security-hardening and Windows-parity backlogs mostly intact.

### By area

| Area | RESOLVED | PARTIAL | NOT_FIXED | Total |
|------|---------:|--------:|----------:|------:|
| security (gateway + xcut, FW-A) | 3 | 4 | 10 | 17 |
| orchestration | 1 | 1 | 2 | 4 |
| streaming | 2 | 0 | 0 | 2 |
| storage-memory | 4 | 0 | 2 | 6 |
| mc-rendering | 4 | 0 | 0 | 4 |
| mc-shell-wip | 7 | 0 | 6 | 13 |
| platform-config-xcut | 3 | 3 | 4 | 10 |
| windows-regression-sweep | 3 | 0 | 4 | 7 |
| **TOTAL** | **27** | **8** | **28** | **63** |

---

### ✅ RESOLVED (27)

| Prior ID | Area | Evidence (anchor) |
|----------|------|-------------------|
| XC-authz-injection-chains-6 | security | `executeMcpRuntime` now calls `enforceMcpServerScope(input)` unconditionally (tool-invocation-coordinator-service.ts:927); missing-host → blocked response (:1057-1064); `assertMcpServerInCapabilityScope` throws when resolver absent (gateway-service.ts:7943); resolver fault → `NO_CAPABILITIES` (capability-scope-resolver.ts:93). Accidental fail-open closed. **Over-reached → see R2-security…-1.** |
| GW-toolpolicy-b-1 | security | `create/updateMcpServer` reject caller `goatcitadel://` URLs via `isInternalMcpServerUrl` (mcp-server-admin-service.ts:62,104); `readMcpServers/Tools` filter/inject Gateway-owned defs (gateway-service.ts:8744,8834). Internal-server registration bypass closed. |
| GW-toolpolicy-b-2 | security | `handleInternalMcpDurableTasksInvoke` resolves workspace scope (fail-closed on missing workspaceId) and filters list/get/cancel by `durableRunMatchesScope` (mcp-durable-tasks.ts:105-149). Cross-run access closed. |
| GW-concurrency-1 | orchestration | New `assertAutonomousDurableRunAllowed()` gates the durable **executor** dispatch (durable-execution-service.ts:591 / :1063 / :1189) + defense-in-depth re-check (chat-proactive-service.ts:2165) + enqueue-side gates. TOCTOU on kill switch closed. Tests at durable-execution-service.test.ts:708/1026/1531. **Introduced a lost-run regression → see R2-orchestration-1.** |
| GW-streaming-1 | streaming | 15s SSE heartbeat (`: heartbeat`) added during silent gaps (chat.shared.ts:100-113), guarded + cleaned up + unref'd. Idle-proxy SSE drop closed. Test chat.shared.coalesce.test.ts:75-115; focused suite 33/33. |
| GW-streaming-2 | streaming | No fix required — prior finding self-classified as intended/corroboration-only; chat-turn-stream-service.ts byte-identical in range; happy path emits no synthetic split (`:1747`). Confirmed no regression. |
| GW-storage-correctness-1 | storage-memory | Unconditional `SAVEPOINT` (Postgres crash) replaced with `withAtomicBatchWrite` (chat-message-repo.ts:326-342); mirrored to cost-ledger-repo.ts:203 & operator-profile-repo.ts:114. Atomic on both dialects. Suites 9/9 + 69/69 + 56/56. |
| GW-memory-1 | storage-memory | `compose()` now `degradeUnsafeMemoryContext` (memory-context-service.ts:49-52) — honest degraded pack + fallback telemetry instead of uncaught throw (:613-655). Test passes. |
| GW-memory-3 | storage-memory | Compose/distiller prompt bounded at every layer (maxCharsPerCandidate 1400, maxCandidates 40, maxMemoryFiles 36, maxTranscriptEvents 80, distiller max_tokens ≤1400). Caveat: bounds byte-identical to base (already mitigated pre-round); prompt demonstrably bounded. |
| GW-memory-4 | storage-memory | `citation-validator.ts:8-25` upgraded to Map + rejects citation unless sourceType/sourceRef match AND score finite in [0,1]; fact→citation cross-check throws to fallback (memory-context-service.ts:296-299). Test passes. |
| MC-chat-render-markdown-1 | mc-rendering | `preserveMarkdownIndentation` (assistant-display-text.ts:216) preserves leading indent, collapses only interior runs; line-based `splitMarkdownFenceSegments` (:126). Verified live + chat-renderer-tail.test.tsx:208. 21/21. |
| MC-chat-render-markdown-2 | mc-rendering | `hasSameLineStreamingFenceClose` (AssistantMessageRenderer.tsx:498) applied to both split paths (:450, :608); single-line fence no longer pins tail forever. Byte-identical streaming proven; 21/21. |
| MC-state-hooks-2 | mc-rendering | Stale-generation guard: `loadSessionCoreStateInternal` returns false on stale gen (useChatSessionData.ts:367); secondary load bails (:451-454); both refs bumped on clear/switch (:604-612). Late poll can't clobber new session. Test :450; 18/18. |
| MC-virtualization-perf-1 | mc-rendering | Scoped per-message `useChannelActivitySnapshot` + scoped listeners (channel-activity-store.ts:120,129,155) kills O(n²) wake-storm; streaming-scroll signal bucketed (ThreadedTimeline.tsx:255). 29/29. |
| MC-a11y-3 | mc-shell-wip | Focus-steal deleted; replaced with polite live region `role="status" aria-live="polite"` (CoworkPanel.tsx:420-471). Approval arrival no longer yanks focus. |
| MC-a11y-4 | mc-shell-wip | `tabIndex={0}` added to all four tabpanels (CoworkPanel.tsx:192,213,219,225). Keyboard user can focus/scroll a childless panel. |
| MC-css-tokens-1 | mc-shell-wip | Footer pill accessible name `${label}: ${value}` via aria-label (MissionControlNextApp.tsx:1334,1350); explicit label props (:1085-1096). Minor caveat: aria-label on role-less div. |
| MC-css-tokens-2 | mc-shell-wip | Clickable Approvals pill (button) gets aria-label 'Approvals: N pending' (MissionControlNextApp.tsx:1342). Buttons reliably expose the name. |
| MC-wip-changeset-2 | mc-shell-wip | Route/model + tokens/cost always-visible header StatusChips regardless of composer-v2 flag (ThreadedComposer.tsx:62-93 → ThreadedSurfacePage.tsx:761-795). |
| MC-wip-changeset-3 | mc-shell-wip | `onModeOverride` wired + reachable (MissionThreadedControllerHost.tsx:3168-3171); interactive dropdown live (ThreadedModeControl.tsx:98; ThreadedSurfacePage.tsx:753-757). |
| MC-wip-changeset-4 | mc-shell-wip | Cowork Plan tab renders `emptyCopy` per PanelList when idle (CoworkPanel.tsx:194-208; PanelList.tsx:19,33-34). Not dead. |
| XC-config-drift-2 | platform-config | goatcitadel.example.json dead profiles map removed; tools.allow/deny reconciled to split (lines 211-259); deep-equal drift gate added (config-defaults.test.ts:76-80). 8 tests pass. |
| XC-config-drift-3 | platform-config | Explicit `action` on all 5 cron rows + `BUILT_IN_CRON_ACTIONS` repair (cron-job-config-helpers.ts:29-34,133). Test loop16 :160-216. No misleading task fallback. |
| XC-config-drift-6 | platform-config | withAssistantDefaults firecrawl flipped to enabled:true / defaultReadBackend firecrawl / apiKeyEnv default (config.ts). Built-in default now matches example. Test :59-66. |
| XC-supply-chain-4 | windows-sweep | Personal path `F:\code\personal-ai` → 'this GoatCitadel checkout' (spec :5, commit 2eefaa041); verify-repo-hygiene exits 0; fast.repo-hygiene GREEN. 6/6. **CI-unblocker.** |
| XC-windows-parity-5 | windows-sweep | `.gitattributes` gained `* text=auto eol=lf` + CRLF for .bat/.cmd/.ps1 (:1-4); enforced by new hygiene check (verify-repo-hygiene.mjs:127-139). |
| XC-supply-chain-1 | windows-sweep | `requireDigestPin` default flipped `?? false` → `?? true` (config.ts:978; mirrored code-mode-execution-backends.ts:157); example ships fail-closed. Tests updated. |

### 🟡 PARTIAL (8)

| Prior ID | Area | What held / what remains |
|----------|------|--------------------------|
| GW-api-authz-1 | security | Arbitrary-env exfil narrowed via `resolveAllowlistedEnvSecret` + `ALLOWED_SECRET_ENV_PREFIXES` (integration-webhooks-shared.ts:72-97). **Remains:** allowlist includes `GOATCITADEL_`/`GC_`, so `botTokenEnv:'GOATCITADEL_POSTGRES_PASSWORD'` still exfiltrates to Telegram (telegram-target-discovery.ts:17). Mechanism narrowed, not eliminated. |
| XC-authz-injection-chains-3 | security | 2 English-only regex markers added (assembled-prompt-injection-guard.ts:6-7). **Remains:** scanner still has exactly ONE non-test caller (improvement-service.ts:5024); chat-turn assembly still never scans. Dead on the hot path. |
| XC-authz-injection-chains-5 / GW-toolpolicy-a-3 | security | `invokeApprovedExternalRuntimeTool` still calls overrideHandler with no internal re-eval (tool-invocation-coordinator-service.ts:700); safe **only** by caller ordering (gateway-service.ts:6263 re-gates via `executeApprovedAction`). Unchanged; matches original Low/no-exploit. |
| GW-turn-pipeline-1 | orchestration | Auto-route entry path hardened (surface-router-entry.ts:30-32 injects sticky mode when `autoRoute` set). **Remains:** sticky-cowork session with no mode + no autoRoute still diverges prompt(cowork) vs routing(chat) — chat-turn-prep-service.ts:358 unchanged. |
| XC-config-drift-4 | platform-config | Config row gets `action:improvement`. **Remains:** two-identity split unreconciled (`self_improvement_weekly_replay` vs hardcoded `improvement_weekly`). Harm shifted from generic-task to **silent no-op → see R2-platform-config-xcut-1.** |
| XC-config-drift-5 | platform-config | Specific 'hand-added profiles' repro defused by drift-2. **Remains:** generic edit-durability defect intact — split hand-edits overwritten every boot (config-sync-lib.ts:90-104, unchanged). Duplicate root of drift-2; Low. |
| XC-secrets-redaction-1 (platform dup) | platform-config | New `redactSecretText` (secret-redaction.ts) wired into channel/MCP/audit paths. **Remains:** logger.ts:38-41 still sk-/Bearer-only and does not import it — tokens under benign keys / in error.message still leak through the log sink. |

### ❌ NOT_FIXED (28)

| Prior ID | Area | One-line reason (file unchanged in range unless noted) |
|----------|------|--------------------------------------------------------|
| XC-authz-injection-chains-1 | security | Escalation-via-`permissionProfileId` intact; guards fire only on `remote_hardened` (gateway-service.ts:6526); `trusted_local_power` still reachable. |
| XC-authz-injection-chains-2 | security | chat-delegation-service.ts unchanged; child output still folded raw with no data-fence / promptware scan. |
| XC-authz-injection-chains-4 | security | SCHEDULED_RESTRICTED still `toolPatterns:['*']` denylist (policy.ts:156-158); only the type union changed. DRIFT-risk/static. |
| XC-secrets-redaction-1 | security | logger.ts unchanged; non-sk/Bearer secrets in string VALUES / error.stack still un-redacted. |
| XC-secrets-redaction-2 | security | network-guard.ts:491 still `throw error` on success path; userinfo-URL credential surfaces raw (integration-channel-activity.ts:229). CONFIRMED-REPRO. |
| XC-secrets-redaction-3 | security | _error-handler.ts:21 still logs raw non-GoatError; non-sk secret in Error.message logged verbatim. Log-only. |
| XC-secrets-redaction-4 | security | dev-diagnostics/service.ts:382 redacts by key + Bearer-value only; token under non-matching key persists in ring buffer. Dev-only. |
| GW-toolpolicy-a-1 | security | argument-risk-gate.ts:30-33 truncates to 8192 BEFORE pattern scan; padded destructive token auto-executes under bypass. CONFIRMED-REPRO. |
| GW-toolpolicy-a-2 | security | `syntheticPermissionProfiles` Map never evicted (gateway-service.ts:887,5734); one record per cron run forever. Unbounded growth. |
| GW-toolpolicy-b-3 | security | `ownerMatchesCaller` byte-identical (mcp-elicitation-service.ts:222-233); operatorId-only caller vs agent/session-scoped owner → hidden elicitation. Low correctness. |
| GW-orchestrator-a-1 | orchestration | message-path tool calls dropped (chat-agent-completion-adapters.ts:398-401); `aggregate.toolCalls` never populated from message path → terminal 'completed', no tool run. Repro test. |
| GW-orchestrator-a-2 | orchestration | `readToolCalls` returns `[]` for empty `tool_calls` array without falling through to serialized parse (:48-77); repair never triggers. Repro test. |
| GW-memory-2 | storage-memory | BM25 TF still `token.includes(term)` (candidate-ranker.ts:133); 'ai' matches 'email'/'detail'; also semanticHintScore :97. Mechanism intact. |
| P3.T1 | storage-memory | cowork-agentic-projection-service.ts unchanged; `getAgenticRunTree` still writes during GET read (:405,445,483). Pre-existing idempotency guards limit blast radius. |
| MC-css-tokens-3 | mc-shell-wip | composer.css untouched; `:not(.status-chip)` (`:954`) matches the primitive `mc-next-status-chip` → warning text tone still clobbered. |
| MC-responsive-1 | mc-shell-wip | Shell inspector still bottom-docks over composer ≤1180px (mission-control-next.css:2187-2195, unchanged); fix targeted the unrelated left rail. Scrim/Escape already existed at base. |
| MC-responsive-2 | mc-shell-wip | SideInspectorDrawer drag guard `<1024` vs CSS dock `≤1180`; 1024-1180px band grab still does nothing (SideInspectorDrawer.tsx:109,138, unchanged). |
| MC-responsive-3 | mc-shell-wip | Open shell inspector floats over is-work-area column with no reserved gutter (mission-control-next.css:1358-1366, unchanged). |
| MC-a11y-1 | mc-shell-wip | SideInspectorDrawer unchanged — no focus move/restore, no role=dialog/aria-modal, no inert on scrimmed bottom sheet. Fix went to the left rail. |
| MC-a11y-2 | mc-shell-wip | Chat right Context drawer still no Escape (ThreadedSurfacePage.tsx:644-677); new Escape gated on left-rail only (:346-360). Dismissable via visible button; Low. |
| XC-config-drift-1 | platform-config | policy-resolver.ts unchanged; absent profileName still yields `{*}` fail-open (:24-26). Shipped config safe incidentally (profile:'chat-agent'). Latent/operator-drift. |
| XC-secrets-redaction-2 (platform dup) | platform-config | network-guard.ts:491 success-path `throw error` unredacted; credential-bearing URL surfaces raw in `detail`. New redactor wired only to outbound channel content. |
| XC-perf-system-1 | platform-config | Dashboard `pendingApprovals` still materializes via `approvals.list("pending",10000).filter().length` (dashboard-route-service.ts:227-229); client poll still ungated 15s (use-shell-status.ts:47). Medium. |
| XC-perf-system-2 | platform-config | `chat_thread_updated` still `refreshSession:"full"` = 9 round-trips (chat-page-pure-helpers.ts:128-132); ~400ms double-fetch intact; 800ms coalesce doesn't dedupe. |
| XC-windows-parity-1 | windows-sweep | mcp-runtime.ts spawns `.cmd` with shell:false, no cmd.exe wrapper (:657-664, :1240-1242); synchronous EINVAL on modern Node. **→ R2-windows-regression-sweep-1.** |
| XC-supply-chain-2 | windows-sweep | run-unless-env.mjs:16-21 spawns `pnpm.cmd` shell:false, no try/catch; sync EINVAL escapes handler. **→ R2-windows-regression-sweep-2.** |
| XC-supply-chain-3 | windows-sweep | verify-extension-package-artifacts.mjs:64 `tar -xzf <C:\ path>` no `--force-local`; GNU/MSYS2 tar treats C: as rsh host. **→ R2-windows-regression-sweep-3.** |
| XC-supply-chain-5 | windows-sweep | security-trivy.yml untouched; no `pnpm audit` step added. Out-of-scope Low; no live exposure today. |

---

## Section 2 — NEW / REGRESSION FINDINGS (9 surviving)

Most-severe first. **Regression** = introduced by a fix in `67c3adb64..a81eeccc4`; **Pre-existing** = surfaced this round but not caused by the fix set (all confirmed unfixed).

| # | Sev | Verdict | Reg? | File:line | Claim |
|---|-----|---------|------|-----------|-------|
| 1 | **High** | CONFIRMED-REPRO | 🔴 regression | tool-invocation-coordinator-service.ts:927 (+ gateway-service.ts, capability-scope-resolver.ts) | The XC-authz-injection-chains-6 fix removed the internal-server exemption in `executeMcpRuntime`. In any capability-scoped workspace the internal `goatcitadel-internal-approval-inbox` / `-durable-tasks` IDs are absent from the effective set → `PolicyViolationError` → approval-inbox & durable-tasks MCP surfaces blocked (governance/safety-path DoS). Resolver-fault fallback also flipped ALL→NO_CAPABILITIES, so a transient fault denies **all** MCP. |
| 2 | **High** | CONFIRMED-STATIC | 🔴 regression | durable-execution-service.ts:591 (+ durable-run-service.ts, gateway-service.ts) | The GW-concurrency-1 fix blocks autonomous runs by **throwing** from the executor. The throw routes through `drainQueuedRuns` → `failWorkflowRun` → terminal 'failed' with no retry ladder. Disengaging the kill switch does not re-drive 'failed' runs; the resume guard only covers 'paused'. Operator engages a temporary safety pause → silent **permanent cancel** of already-queued autonomy. |
| 3 | **High** | CONFIRMED-STATIC | Pre-existing | mcp-runtime.ts:658 | (Orig. XC-windows-parity-1, unfixed.) `withStdioMcpClient` spawns `resolveSpawnCommand`'s `.cmd` rewrite with shell:false / no cmd.exe wrapper. On Node ≥20.12/22 (this host: v24.14.0) spawn('npx.cmd', {shell:false}) throws EINVAL synchronously — bypassing the `child.on('error')` handler — for both `listMcpTools` discovery and `invokeMcpRuntimeTool`. Every `command:npx` stdio MCP server fails to launch on Windows. |
| 4 | **Medium** | CONFIRMED-REPRO | 🔴 regression | ThreadedSurfacePage.tsx / CoworkPanel.tsx / check-mission-control-next-budgets.mjs:115 | ThreadedSurfaceRoute lazy chunk = **973,602 B** vs 921,600 B budget → `perf:check` RED. Baseline (67c3adb64) already over at 969,989 B; the shell fix added +566 insertions into this chunk (~+3.6 KB worse). Worsening of an already-RED gate (not a GREEN→RED flip). |
| 5 | **Medium** | CONFIRMED-REPRO | 🔴 regression | improvement-service.ts:476 (+ cron-job-config-helpers.ts, cron-automation-service.ts, config/cron-jobs.example.json) | The XC-config-drift-4 fix sets config row `self_improvement_weekly_replay` → `action:improvement`, but the scheduler keys off a **different** row `improvement_weekly`. Enabling the config row dispatches improvement, which early-returns because the other (disabled) row is checked first → **silent no-op**. Pre-fix it created an inbox task; failure mode changed, not eliminated. |
| 6 | **Medium** | CONFIRMED-REPRO | Pre-existing | run-unless-env.mjs:16 | (Orig. XC-supply-chain-2, unfixed.) Gateway pretest/presmoke spawns `pnpm.cmd` shell:false, no try/catch; sync EINVAL escapes `child.on('error')` at :23 → uncaught, crashing `pnpm --filter @goatcitadel/gateway test` at the extensions-sdk prebuild on Windows. Bypass `GOATCITADEL_SKIP_EXTENSIONS_SDK_PREBUILD=1` works. Reproduced on this host. |
| 7 | **Medium** | CONFIRMED-REPRO | Pre-existing | verify-extension-package-artifacts.mjs:64 | (Orig. XC-supply-chain-3, unfixed.) `tar -xzf <C:\ tmp tarball> -C ...` lacks `--force-local`; GNU/MSYS2 tar interprets `C:` as an rsh host → exit 2, breaking `verify:extensions:package` in GNU-tar-first dev shells. **Two caveats bound to Medium:** CI lanes are ubuntu-latest (finding's CI claim overstated); default Windows PowerShell/cmd resolves to bsdtar which handles `C:\` fine. |
| 8 | **Low** | LIKELY | Pre-existing | useChatOutboundExecution.test.tsx:1716 | Suite fails non-deterministically at varying assertion lines (fake-timer + microtask race vs module-level `latest` harness), then passes on isolated re-run. **Not** a fix regression: the only in-range source change (:951) and test change (:870) are unrelated. Test-hygiene note only; mechanism plausible but the intermittent failure itself was not reproduced (6 clean runs). |
| 9 | **Low** | CONFIRMED-STATIC | 🔴 regression | dev.mjs:168 (+ run-ts7-workspace.mjs, build-bundle.mjs, build-desktop.mjs, bin/goatcitadel.mjs) | The Windows arg-hardening fix replaced backslash-escaping with `assertSafeWindowsCommandArg` that **throws** on `"`, `%`, CR/LF, NUL and bare-quotes values. A future/edge arg with a literal `%` or a path ending in `\` now throws or mis-parses at CommandLineToArgvW. `dev.mjs` passes user CLI passthrough, so a `%`-containing dev flag on Windows hits the throw (finding slightly understated reachability). Hardening trade-off; first-party callers pass safe values. |

### Severity counts (new/regression)

| Severity | Count |
|----------|------:|
| High | 3 |
| Medium | 4 |
| Low | 2 |
| **Total** | **9** |

Regression-introduced-by-fix: **5** (#1, #2, #4, #5, #9). Pre-existing surfaced-this-round: **4** (#3, #6, #7, #8).

---

## Verdict — did the remediation hold?

**Partially, with a net-negative risk profile on the two highest-value workstreams.** The front-end (mc-rendering 4/4, mc-shell-wip 7/13) and storage/memory (4/6) tracks landed genuine fixes, the streaming heartbeat and Postgres-atomicity corrections are solid, and the CI-unblocker (XC-supply-chain-4, the `F:\` path leak that reddened main's fast lane) is resolved. That is real progress: 27 of 63 findings fully closed with anchored evidence.

But the security-hardening backlog barely moved — **10 of 17 FW-A findings are NOT_FIXED and 4 more only PARTIAL**, meaning the arbitrary-env exfil, the `permissionProfileId` escalation, the argument-risk truncation bypass, the unscanned delegation/assembled-prompt injection paths, and the network-guard/logger secret leaks all remain live or near-live. The Windows-parity sweep is similarly stalled (4/7 NOT_FIXED), and its two most damaging items (the MCP-stdio and pnpm/tar spawn EINVALs) were even *demonstrated fixable* in this same batch on sibling scripts yet left untouched on the actual runtime path.

Most concerning, **two of the security/orchestration fixes that did land over-corrected into new High-severity regressions**: the capability-scope fail-closed rework (R2-security…-1) now denies the internal approval-inbox and durable-tasks MCP surfaces in exactly the scoped workspaces the feature targets — a governance-path DoS — and flips resolver faults to deny-all; and the autonomy-kill-switch TOCTOU fix (R2-orchestration-1) silently and permanently cancels already-queued autonomous runs when an operator engages a temporary pause. The perf gate also regressed (already-RED, now ~3.6 KB worse), and the self-improvement cron fix converted a generic-task fallback into a silent no-op.

Net: the remediation is safe to keep for the front-end/storage/streaming/CI work, but **the two High regressions (R2-security…-1, R2-orchestration-1) should block sign-off** — a fail-closed gate that DoSes safety surfaces and a pause control that destroys queued work are worse than the flaws they replaced. The security and Windows-parity backlogs remain the dominant open story going into Review 3.
