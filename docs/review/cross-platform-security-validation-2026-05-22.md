# Cross-Platform Security Validation Report - 2026-05-22

Baseline: `main...origin/main`, HEAD `c9d3b2b4 fix: harden cowork web access flow`.

This report consolidates the ChatGPT Pro static review, Claude Code handoff, Antigravity/Gemini notes, the Codex security CSV `codex-security-findings-2026-05-22T00-04-29.413Z.csv`, and live validation against the current dirty checkout. Existing dirty/concurrent edits were treated as the baseline and preserved unless they were directly part of a confirmed fix.

Disposition terms:

- `reportable`: survived current-tree validation and received a fix in this pass.
- `fixed/suppressed`: current code already contains the control, or the finding is suppressed by current tests/evidence.
- `deferred`: real risk or proof gap remains, but no surgical code change was made in this pass.
- `not applicable`: stale claim, no current code path, or refuted by current implementation.

## Executive Summary

The original consolidated pass found four submitted issues that survived validation and were fixed:

- Durable hook delivery retries used a manual retry API that rejects worker-owned `running` runs.
- Code Mode status listings could scan unbounded run history before slicing.
- Prompt Lab file prefetch could trigger from ordinary chat text that merely mentioned local filenames.
- Browser read tools reused stored page state by default, allowing authenticated state to leak into low-friction read tools.

Several CSV findings were validated as already fixed or suppressed by current code and regression tests: Discord/Telegram `/sethome` operator gates, Windows signing PATH/secrets scope, Linux firejail profile hardening, Firecrawl final URL enforcement, loopback recovery proxy handling, integration diagnostics SSRF/env-secret allowlisting, LLM preview host matching, and weekly improvement defaults/redaction.

After the operator signed into GitHub, the live GitHub Security pages were reviewed too. The Code Scanning page showed 3 open CodeQL alerts and the AI Findings page showed 6 findings in 3 files. Two CodeQL sanitizer alerts and the actionable AI Findings were fixed locally in this follow-up; the remaining CodeQL rate-limit alert was validated as a startup-hook false positive already annotated in code.

## Live GitHub Security Follow-up

### CodeQL Alert #172 - Shared Assistant Display HTML Comment Sanitization

Disposition: `reportable`, fixed locally.

Live source:

- GitHub Code Scanning: `js/incomplete-multi-character-sanitization`, high, `packages/mission-control-shared/src/components/chat/assistant-display-text.ts:55`.

Evidence and fix:

- `packages/mission-control-shared/src/components/chat/assistant-display-text.ts:54` now runs comment stripping through `stripRawHtmlComments`.
- `packages/mission-control-shared/src/components/chat/assistant-display-text.ts:67` strips raw comments iteratively without the one-pass multi-character regex replacement pattern.
- `packages/mission-control-shared/src/components/chat/chat-renderer-tail.test.tsx:197` proves a malformed comment marker that reveals another comment marker still renders visible content.

Validation:

- `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/components/chat/chat-renderer-tail.test.tsx` - passed after the sanitizer edge case was corrected.

### CodeQL Alert #171 - Mission Control Next Citation HTML Comment Sanitization

Disposition: `reportable`, fixed locally.

Live source:

- GitHub Code Scanning: `js/incomplete-multi-character-sanitization`, high, `apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx:38`.

Evidence and fix:

- `apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx:33` imports the shared `normalizeCitationDisplayText` sanitizer.
- `apps/mission-control-next/src/features/threaded-surface/ThreadedTimeline.tsx:156` and `:157` use the shared sanitizer for citation titles/snippets instead of a duplicate local regex chain.

Validation:

- `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface/ThreadedTimeline.test.tsx` - passed.

### CodeQL Alert #170 - Storage Plugin Missing Rate Limit

Disposition: `not applicable` locally; remote alert remains open until dismissed or rescanned.

Live source:

- GitHub Code Scanning: `js/missing-rate-limiting`, high, `apps/gateway/src/plugins/storage.ts:35`.

Evidence:

- `apps/gateway/src/plugins/storage.ts:35` is `fastify.addHook("onReady", async () => { ... })`, a process startup hook, not an HTTP route.
- `apps/gateway/src/plugins/storage.ts:34` already carries `// codeql[js/missing-rate-limiting] Startup initialization is not an HTTP route handler.`
- `docs/security/findings-triage.md` says route alerts should receive literal route rate limits, while structural false positives can be dismissed only with evidence. This one has no route to rate-limit.

No remote dismissal was performed in this pass; this report records the evidence for operator review.

### AI Findings - `llm-completion-service.ts`

Disposition: `reportable`, fixed locally as maintainability hardening.

Live source:

- GitHub AI Findings reported two suggestions in `apps/gateway/src/services/llm-completion-service.ts`: replace magic retry levels `1`/`2`, and document fallback retry labels.

Evidence and fix:

- `apps/gateway/src/services/llm-completion-service.ts:43` and `:44` define named retry levels.
- `apps/gateway/src/services/llm-completion-service.ts:289`, `:290`, `:685`, and `:686` use the named retry levels in non-streaming and streaming retry attempts.
- `apps/gateway/src/services/llm-completion-service.ts:319` and `:727` document what each retry level means before assigning fallback reasons.

Validation:

- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/llm-completion-service.test.ts src/services/orchestration-phase-execution-service.test.ts` - passed.

### AI Findings - `orchestration-phase-execution-service.ts`

Disposition: `reportable`, fixed locally as operator-message quality.

Live source:

- GitHub AI Findings reported that the durable child-user-input wait error explained the limitation but did not guide the operator toward the supported approval-wait path.

Evidence and fix:

- `apps/gateway/src/services/orchestration-phase-execution-service.ts:128` now tells the operator to refactor the phase to approval-based waits and resume after approval.
- `apps/gateway/src/services/orchestration-phase-execution-service.test.ts:306` pins the updated message.

Validation:

- Gateway focused LLM/orchestration test command above - passed.

### AI Findings - `capture-mission-control-screenshots.mjs`

Disposition: `reportable`, fixed locally.

Live source:

- GitHub AI Findings reported three issues in `packages/policy-engine/scripts/capture-mission-control-screenshots.mjs`: `settleMs` always falling back, `waitForSelector` not matching the manifest field, and `scrollY` truthiness making `0` unusable.

Evidence and fix:

- `packages/policy-engine/scripts/capture-mission-control-screenshots.mjs:79` materializes `settleMs` on each target, defaulting to `DEFAULT_SCREENSHOT_SETTLE_MS`.
- `packages/policy-engine/scripts/capture-mission-control-screenshots.mjs:525` and `:526` now wait on `target.readySelector`, matching the route manifest field mapped at `:77`.
- `packages/policy-engine/scripts/capture-mission-control-screenshots.mjs:539` treats `scrollY: 0` as a real configured value by checking `typeof target.scrollY === "number"`.

Validation:

- `node --check packages/policy-engine/scripts/capture-mission-control-screenshots.mjs` - passed.

## Reportable Findings Fixed This Pass

### 1. Durable Hook Delivery Retry Cannot Retry

Disposition: `reportable`, fixed.

Source and sink:

- Source: a failed hook delivery run inside `executeDurableHookDeliveryRun`.
- Sink: `retryDurableRun`, which is only valid for already-`failed` runs.
- Broken control: durable worker had already claimed the run, so persisted status was `running`; the manual retry API rejected the transition.

Evidence:

- `apps/gateway/src/services/durable-execution-service.ts:799` now calls `scheduleRunningWorkflowRetry`.
- `apps/gateway/src/services/durable-run-service.ts:535` adds the worker-owned running-run retry API.
- `apps/gateway/src/services/durable-run-service.test.ts:179` verifies `running -> queued`, retry row write, and lease clearing.
- `apps/gateway/src/services/durable-run-service.test.ts:240` verifies exhausted retries become `dead_lettered`.
- `apps/gateway/src/services/durable-execution-service.test.ts:594` and `:614` now fake the worker retry API, not the manual operator API.

Validation:

- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/durable-execution-service.test.ts src/services/durable-run-service.test.ts src/services/chat-agent-orchestrator.prompt-lab-repo-evidence.test.ts src/services/capability-system-service.test.ts` - passed.

### 2. Code Mode Status Listing Performs Unbounded Reads

Disposition: `reportable`, fixed.

Source and sink:

- Source: operator-facing Code Mode list/status filters.
- Sink: synchronous storage reads and service hydration.
- Broken control: status hydration queries and service fallback could read full history before slicing to the caller's limit.

Evidence:

- `packages/storage/src/code-mode-run-repo.ts:110` and `:119` add bounded status-hydration query limits.
- `packages/storage/src/code-mode-run-repo.ts:240` and `:283` compute bounded scan windows.
- `apps/gateway/src/services/capability-system-service.ts:428` passes `limit` through to storage.
- `apps/gateway/src/services/capability-system-service.ts:436` replaces the previous unbounded fallback with a bounded scan window.
- `packages/storage/src/sqlite.ts:932` and `packages/storage/src/postgres/migrations.ts:1325` add status/created listing indexes for migrated databases.
- `packages/storage/src/code-mode-run-repo.test.ts:240` asserts bounded hydration scan behavior.
- `apps/gateway/src/services/capability-system-service.test.ts:1668` asserts the service passes bounded limits into storage.

Validation:

- Gateway focused suite above - passed.
- `pnpm --filter @goatcitadel/storage exec tsx --test src/code-mode-run-repo.test.ts src/sqlite-migration-versioning.test.ts src/postgres-runtime-schema.test.ts` - passed.

### 3. Prompt Text Can Trigger Hidden Local File Prefetch

Disposition: `reportable`, fixed.

Source and sink:

- Source: user-visible prompt text containing local-looking filenames.
- Sink: automatic local file prefetch injected into model context before explicit tool use.
- Broken control: ordinary chat text could activate Prompt Lab prefetch intent.

Evidence:

- `apps/gateway/src/services/chat-agent-orchestrator.ts:264` defines sensitive filename exclusions.
- `apps/gateway/src/services/chat-agent-orchestrator.ts:513` gates prefetch to explicit Prompt Lab/repo-evidence contracts.
- `apps/gateway/src/services/chat-agent-orchestrator.ts:13780` filters automatic prefetch paths.
- `apps/gateway/src/services/chat-agent-orchestrator.prompt-lab-repo-evidence.test.ts:301` proves ordinary chat text mentioning `.env`/`package.json` does not prefetch.
- `apps/gateway/src/services/chat-agent-orchestrator.prompt-lab-repo-evidence.test.ts:347` proves sensitive filenames are skipped even in explicit Prompt Lab prefetch.

Validation:

- Gateway focused suite above - passed.

### 4. Browser State Reused by Auto-Approved Read Tools

Disposition: `reportable`, fixed.

Source and sink:

- Source: stored browser cookies/localStorage/sessionStorage for a browser session.
- Sink: low-friction browser read tools such as navigate/extract/search/screenshot.
- Broken control: read tools inherited stored page state by default.

Evidence:

- `packages/policy-engine/src/browser-tools.ts:120` introduces explicit page state modes.
- `packages/policy-engine/src/browser-tools.ts:738` keeps session state only for `browser.interact`.
- `packages/policy-engine/src/browser-tools.ts:1464` makes `withBrowserPage` stateless by default.
- `packages/policy-engine/src/browser-tools.session-id-override.security.test.ts:40` proves read tools are stateless.
- `packages/policy-engine/src/browser-tools.coverage.test.ts:2287` proves navigation does not apply stored session state.

Validation:

- `pnpm --filter @goatcitadel/policy-engine exec vitest run src/browser-tools.session-id-override.security.test.ts src/browser-tools.coverage.test.ts` - passed.

## Fixed/Suppressed Findings

### Discord Users Can Redirect Home Channel

Disposition: `fixed/suppressed`.

Evidence:

- `apps/gateway/src/services/discord-runtime-bridge-service.ts:147` exposes the Discord operator predicate.
- `apps/gateway/src/services/discord-runtime-bridge-service.ts:398` checks operator status before `/sethome` mutates integration config.
- `apps/gateway/src/services/telegram-channel-commands.ts:77` applies the same operator gate for Telegram `/sethome`.
- `apps/gateway/src/services/sethome-operator-gate.security.test.ts:35` and `:49` cover Discord and Telegram operator-gate behavior.

### Windows Signing Secret Can Be Stolen via PATH Hijack

Disposition: `fixed/suppressed`.

Evidence:

- `.github/workflows/release-installers.yml:34` documents step-scoped signing secret handling.
- `.github/workflows/release-installers.yml:111` and `:149` resolve `signtool.exe` from the Windows SDK path instead of `PATH`.
- `apps/gateway/src/release-installers-signing-scope.security.test.ts:45` pins the no-`Get-Command signtool.exe` behavior.

### Linux Code Mode Sandbox Allows Host File Reads

Disposition: `fixed/suppressed`.

Evidence:

- `apps/gateway/src/services/code-mode-sandbox/linux-firejail-adapter.ts:76` launches with `--private-tmp`.
- `apps/gateway/src/services/code-mode-sandbox/linux-firejail-adapter.ts:77` launches with `--private=<runTempRoot>`.
- `apps/gateway/src/services/code-mode-sandbox/linux-firejail-adapter.ts:116` explicitly avoids claiming hostile-code sandboxing.
- `apps/gateway/src/services/code-mode-sandbox/linux-firejail-adapter.security.test.ts:30` proves the permissive `read-only /` directive is gone.

Boundary note: Code Mode remains a governed trusted-code surface with approval/artifact checks. This report does not claim hostile-code sandboxing.

### Firecrawl Scrape Bypasses Network Allowlist on Redirects

Disposition: `fixed/suppressed`.

Evidence:

- `packages/policy-engine/src/ingestion-backends.ts:352` validates Firecrawl-reported final source URLs.
- `packages/policy-engine/src/ingestion-backends.coverage.test.ts:619` rejects final URLs outside the granted source host boundary.
- `packages/policy-engine/src/ingestion-backends.coverage.test.ts:655` rejects final URLs outside the runtime network allowlist.
- `packages/policy-engine/src/browser-tools.coverage.test.ts:948` rejects private Firecrawl final URLs for browser tools.

### Implicit Loopback Recovery Can Grant Remote Operator Access

Disposition: `fixed/suppressed`.

Evidence:

- `apps/gateway/src/plugins/auth.ts:130` inspects the socket remote address.
- `apps/gateway/src/plugins/auth.ts:147` only treats requests as loopback when proxy provenance is absent.
- `apps/gateway/src/plugins/auth.ts:166` gates first-run recovery on clean loopback requests.
- `apps/gateway/src/plugins/auth.loopback-recovery.security.test.ts:141` and `:164` cover proxy-provenance rejection.

### Live Diagnostics Can Exfiltrate Env Secrets via SSRF

Disposition: `fixed/suppressed`.

Evidence:

- `apps/gateway/src/services/integration-diagnostics-service.ts:96` uses connection URL allowlist checks in diagnostics.
- `apps/gateway/src/services/integration-secret-envvar-allowlist.security.test.ts:20` rejects gateway/infra secrets.
- `apps/gateway/src/services/integration-secret-envvar-allowlist.security.test.ts:40` accepts only conventionally named integration secrets.

### LLM Model Preview Can Exfiltrate Stored Provider Secrets

Disposition: `fixed/suppressed`.

Evidence:

- `apps/gateway/src/services/llm-service.ts:531` handles preview model requests.
- `apps/gateway/src/services/llm-service.ts:547` compares requested and configured provider hosts.
- `apps/gateway/src/services/llm-service.ts:564` avoids inheriting stored credentials when preview host differs.
- `apps/gateway/src/services/llm-service.export-config.security.test.ts:19` and `:23` cover host mismatch and private host rejection.

### Weekly Audit Leaks Chat/Tool Data to External LLMs by Default

Disposition: `fixed/suppressed`.

Evidence:

- `config/cron-jobs.example.json:4` defines the shipped weekly replay job.
- `config/cron-jobs.example.json:8` disables the shipped weekly replay job by default.
- `apps/gateway/src/services/improvement-service.ts:467` keeps first-run persistent defaults disabled unless explicitly enabled.
- `apps/gateway/src/services/improvement-service.ts:4785` redacts sampled payloads before model-judge use.
- `apps/gateway/src/improvement-cron-disabled.security.test.ts:33` and `apps/gateway/src/services/improvement-service.first-run-default.security.test.ts:24` cover disabled defaults.
- `apps/gateway/src/services/improvement-common.redaction.security.test.ts:13` covers secret/PII redaction.

Local ignored runtime state such as `config/cron-jobs.json` was not mutated.

### Code Mode Failure Realtime Metadata

Disposition: `fixed/suppressed`.

Evidence:

- `apps/gateway/src/services/approval-code-mode-terminal.ts:79` and `:140` publish `code_mode_run_failed` events with explicit metadata.
- `apps/gateway/src/services/approval-lifecycle-service.test.ts:543` asserts the realtime metadata envelope.

### Mission Control LocalStorage Crash Paths

Disposition: `fixed/suppressed`.

Evidence:

- `packages/threaded-surface-core/src/chat/useChatLocalPersistence.ts:20` guards `localStorage.setItem`.
- `packages/threaded-surface-core/src/chat/useChatMultimodalControls.ts:221` guards speak-replies initialization.
- `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx:526` guards stream preference reads.
- `packages/threaded-surface-core/src/chat/useChatWorkbench.ts:84` guards workbench UI state writes.

## Deferred Items

### Current Full-Web Default and Audit Posture

Disposition: `deferred`.

Claude Code flagged that the dirty baseline changes public-web behavior from explicit opt-in to opt-out for eligible browser tools, removes the visible composer toggle, and skips the old danger-profile network-bypass audit path when full-web is active.

Current evidence:

- `packages/policy-engine/src/engine.ts:81` treats eligible browser tools as full-web unless `fullWebAccess === false`.
- `packages/policy-engine/src/tool-executor.ts:256` mirrors the opt-out behavior for execution.
- `packages/threaded-surface-core/src/MissionThreadedControllerHost.tsx:517` defaults Mission threaded sessions to full web access.
- `apps/mission-control-next/src/features/threaded-surface/ThreadedComposer.tsx:478` still shows a passive "Full web" chip when enabled.

No code change was made because this is part of the user/concurrent dirty baseline and requires a product/security decision: keep full-web-by-default and add a distinct audit event, or restore explicit operator opt-in. Existing policy tests still prove private/reserved hosts are not opened by the wildcard public-web path, but audit semantics should be resolved before release.

### Memory Search/Read In-Memory Scans

Disposition: `deferred`.

ChatGPT Pro identified bounded but broad memory read/search scans in `packages/policy-engine/src/tool-executor.ts`. The current implementation has hard caps, so this is not a correctness bug in the present release pass. It remains a scalability follow-up for indexed/paginated ranking if memory volume grows.

### Realtime Metadata Fail-Loud Coverage

Disposition: `deferred`.

The producer-side `code_mode_run_failed` metadata drift is fixed, but storage-level fail-loud enforcement for `code_mode_run_failed`/`code_mode_run_succeeded` remains a follow-up hardening item.

### Approval-Effects Worker Not Triggered

Disposition: `not applicable`.

The submitted claim was rechecked and refuted by current implementation: the approval effects worker is triggered from the approval-resolution effects path. No fix was made.

## Validation Ledger

Passed:

- Live GitHub Security review via authenticated browser: `https://github.com/goatcitadel/GoatCitadel/security/quality/ai-findings` showed 6 AI Findings in 3 files.
- Live GitHub Code Scanning query: `gh api --paginate "repos/goatcitadel/GoatCitadel/code-scanning/alerts?state=open&per_page=100"` showed open alerts #170, #171, and #172.
- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/durable-execution-service.test.ts src/services/durable-run-service.test.ts src/services/chat-agent-orchestrator.prompt-lab-repo-evidence.test.ts src/services/capability-system-service.test.ts` - 154 tests.
- `pnpm --filter @goatcitadel/storage exec tsx --test src/code-mode-run-repo.test.ts src/sqlite-migration-versioning.test.ts src/postgres-runtime-schema.test.ts` - 36 tests.
- `pnpm --filter @goatcitadel/policy-engine exec vitest run src/browser-tools.session-id-override.security.test.ts src/browser-tools.coverage.test.ts` - 65 tests.
- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/approval-lifecycle-service.test.ts src/release-installers-signing-scope.security.test.ts src/plugins/auth.loopback-recovery.security.test.ts src/services/llm-service.export-config.security.test.ts src/services/integration-secret-envvar-allowlist.security.test.ts src/services/code-mode-sandbox/linux-firejail-adapter.security.test.ts src/improvement-cron-disabled.security.test.ts src/services/improvement-common.redaction.security.test.ts src/services/improvement-service.first-run-default.security.test.ts src/services/sethome-operator-gate.security.test.ts src/services/discord-runtime-bridge-service.contract.test.ts` - 89 tests.
- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/llm-completion-service.test.ts src/services/orchestration-phase-execution-service.test.ts` - 30 tests.
- `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/components/chat/chat-renderer-tail.test.tsx` - 7 tests after fixing the sanitizer edge case.
- `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface/ThreadedTimeline.test.tsx` - 13 tests.
- `node --check packages/policy-engine/scripts/capture-mission-control-screenshots.mjs`.
- `pnpm --filter @goatcitadel/policy-engine test` - 439 tests.
- `pnpm --filter @goatcitadel/mission-control-shared test` - 461 tests.
- `pnpm --filter @goatcitadel/threaded-surface-core test` - 281 tests.
- `pnpm --filter @goatcitadel/mission-control-next test` - 333 tests.
- `pnpm --filter @goatcitadel/storage test` - 521 passed, 1 skipped.
- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/chat-agent-orchestrator.test.ts src/services/chat-agent-orchestrator.prompt-lab-repo-evidence.test.ts` - 60 tests after fixing local-path search inference drift.
- `pnpm typecheck`.
- `pnpm docs:check`.
- `pnpm verify:fast` - passed on final rerun, certificate `2026-05-22T01-24-56-560Z-fast-db1c9ff7`.
- `pnpm verify:durable:recovery` - certificate `2026-05-22T01-12-54-721Z-durable-recovery-514a647f`.
- `pnpm verify:runtime:truth` - certificate `2026-05-22T01-13-24-122Z-runtime-truth-916d5d4b`.
- `pnpm verify:code-mode:sandbox` - certificate `2026-05-22T01-13-47-100Z-code-mode-sandbox-1e247689`.
- `git diff --check` - passed with CRLF normalization warnings only.

Observed and fixed during validation:

- `pnpm typecheck` initially failed on a TypeScript narrowing issue in `packages/storage/src/code-mode-run-repo.ts`; the status-hydration control flow was tightened and typecheck then passed.
- The first `pnpm verify:fast` run failed in `fast.test` on `apps/gateway/src/services/chat-agent-orchestrator.test.ts`; explicit local-path `code.search` inference had drifted to the file path instead of the repo search root. The inference was restored, the focused orchestrator tests passed, and `verify:fast` passed on rerun.
- The first focused shared renderer test for the CodeQL sanitizer fix failed because the new helper dropped visible text after a malformed residual comment marker. The helper was tightened, the focused test passed, and the full shared suite passed.

Not validated in this pass:

- `pnpm verify:visual:regression` was not run because no visual UI behavior was changed beyond preserving the existing dirty full-web chip/toggle baseline.
- Desktop installer packaging was not run; Windows signing workflow controls were validated through static regression tests and workflow inspection.
- Live external integrations were not exercised; diagnostics/security behavior was validated through unit/security tests.
