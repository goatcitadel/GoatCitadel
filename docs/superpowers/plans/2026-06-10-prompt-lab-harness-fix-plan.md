# Prompt Lab Harness Fix Plan — 2026-06-10

## Context

Two back-to-back runs of the same 36-test pack (`pack-73e8956b-3ed4-4f22-aa6d-6f45b91955d2`) against `openai-codex/gpt-5.5`, execution style `agentic`, scorer `2026-06-v3.2`:

| Metric | Run 1 (01:10Z report) | Run 2 (02:06Z report) |
| --- | --- | --- |
| Scored rows | 26/36 | 26/36 |
| Pass / Fail / Review | 18 / 4 / 4 | 20 / 2 / 4 |
| Effective pass rate | 69.2% | 76.9% |
| Runtime failures (failed + paused + invalid) | 3 + 6 + 1 = 10 | 6 + 4 + 0 = 10 |
| Cowork W505–W512 scored | 0/8 | 0/8 |

Review of both artifacts (`artifacts/prompt-lab/runs/manual-import_2026-06-10_01-10-02Z_…` and `…_02-06-17Z_…`) established that **every unscored run and every fail verdict except one (D502 run 2) was harness-caused**. Test-retest agreement between two identical-config runs is poor (12+ tests changed status/verdict/score band), so the harness — not the model — is the dominant variance source.

Decisive evidence: D509's and D505's `responseText` checksums are **byte-identical across both runs** (`3e56a856…`, `dca3bc46…`) despite different sessions, run IDs, and tool timelines — deterministic harness text, not model output. D510's output matches the canned answer hardcoded in `chat-agent-orchestrator.ts` word for word.

## Root causes (with anchors)

1. **Score-facing response rewriting still live (post-06-09 remediation gap).** `runPromptPackTest` passes `normalizationProfile: "prompt_pack_harness"` (`apps/gateway/src/services/prompt-pack-service.ts:524`) → `applyPromptPackHarnessNormalization` (`apps/gateway/src/services/prompt-pack-harness-normalization.ts:20`) → `normalizePromptLabContractOutput` / `normalizeRepoGroundedInspectionOutput` (`apps/gateway/src/services/chat-agent-orchestrator.ts:13902`) rewrite the assistant text **before persistence**, so the 06-09 "score the raw responseText" fix scores already-fabricated text. Specific offenders:
   - Unconditional replacement for auto-score-route prompts: `chat-agent-orchestrator.ts:14026-14029` (`looksLikePromptLabPromptPackAutoScoreRouteTask`) → `buildRepoGroundedEvidenceRepairContent` (`:13615`) "## Exact files used / ## Patch points" stub. Killed D505/D509 in both runs.
   - Canned answer banks: `chat-agent-orchestrator.ts:~10020-10130` (`buildPromptPackAutoScoreRouteSourceMapFallback`, mission-control canned answer at `:10072` = D510's exact output) and `buildPromptLabConcreteEvidenceFallback` (`:10635`).
   - Citation appendix: `appendPromptLabWebCitationsIfNeeded` (`:10148`) appends unopened search-result URLs ("Source URLs:") — failed C511 run 1 (70.5), degraded C507 both runs, dinged C511 run 2 (84.9, judge complaint). Recovers items from **search listings**, not opened pages.
   - Per-test steering injected into run contracts between runs (run 2's W505 contract contains "Portland weekend activity prompt: synthesize…" coaching lines) — contract assembly must not contain test-specific answer shaping.
   - No integrity signal is emitted when rewriting occurs (reports show "Signals: none").

2. **Harness-forced "prefetch" tool runs park headless turns.** For prompt-lab evidence contracts the orchestrator force-executes reads/searches itself (`prefetch-file-*` at `chat-agent-orchestrator.ts:~981-1061`, `prefetch-search-read-*` at `:1111-1167`), injecting synthetic assistant tool-call messages. Defects:
   - Paths come from `extractExplicitLocalFilePathsFromPrompt` + `filterPromptLabPrefetchFilePaths` (`:561-562`), which treat backticked **tool names** in the contract as file paths → `file.read_range(path:"browser.search"|"browser.navigate"|"browser.extract")` in W509/W512, both runs, same order (deterministic).
   - `describeInvalidLocalToolPath` (`:6594`) guards a hardcoded tool-name list that **omits `browser.extract`** → the third call escapes the block, hits the approval gate.
   - All synthetic paths set `finalStatus = "waiting_for_approval"` **unconditionally** on `approval_required` (`:1037`, `:1143`, etc.), bypassing `shouldSoftFailApprovalRequiredTool` (`:6087`) which the normal tool loop applies (`:2274-2287`). Headless run + approval = parked 10–23 min, finalized unscored.
   - Prefetch also force-reads junk search hits (`selectPromptLabConcreteReadPathsFromSearchResult`, `:1072`) — `.codex-temp/`, `.claude/worktrees/` copies — which then appear in fabricated "Exact files used" lists and draw judge penalties ("extraneous temp/worktree paths").
   - Model-initiated file/code calls on cowork surfaces (codex's `code.search_files {"query":"agents.md"}` habit, W507 run 1, W505 run 1) also route to approval and park in child turns (cowork engine sub-turns lack the run-contract marker, so the soft-fail prompt check fails there).

3. **Durable kernel reaps healthy runs.** `DURABLE_LEASE_TTL_MS = 15_000`, heartbeat 5s on the main event loop (`apps/gateway/src/services/durable-run-service.ts:39-42`). Concurrent native `browser.navigate` (22–77s) and repo-wide `code.search_files` (17–93s) starve the loop → lease lapses → `failExpiredOrphanedWorkflowRun` fails the run at checkpoint `run_started`. `prompt-pack-service.ts:548-556` then records the run `failed` even when the trace completed with full output (D502 run 1: zero tools, complete answer, finish reason stop, still failed). Killed D502/W506/W508 run 1; contributed to run 2's W505–W508.

4. **Turn budget vs slow tools.** Code-mode prompt-lab rows run under `CHAT_TURN_BUDGET_MS_BY_MODE.off = 120_000` (`apps/gateway/src/services/chat-agent-budget.ts:42-57`). A single polluted-repo search took 93s (run 2 D505), leaving 18.6s for the final completion ("Chat completion timed out after 18637ms", deadline math in `llm-completion-helpers.ts:234-284`); run 1 D511 burned the budget the same way ("response budget ran out after 120 seconds" → `trace_failure`, invalid). Run 2 D510 died on "Streaming completion failed after partial output; **non-streaming fallback suppressed**" — fallback suppression is a live-chat UX choice that should not apply to evals.

5. **Repo pollution.** `.codex-temp/` (full repo copy), `.claude/worktrees/agent-*`, `data/tool-artifacts/*.json` (stored tool outputs incl. prior model answers), and pack sources (`goatcitadel_prompt_pack_v5_overall.md`) are searchable: 17–93s scans, self-referential evidence (D511 run 1 found the pack file and prior answers), judge penalties for junk paths.

6. **Cowork orchestration engine fragility (agentic style only).** `agentic_surface` re-enables multi-role orchestration (`prompt-pack-service.ts:5686`) that the default path disables for reliability (comment at `:5704-5715`). Defects compound:
   - Web caps (1 search / 2 opens / 4 web attempts **per turn**, counting blocked/failed attempts — `describePromptLabWebToolCapBlock`, `chat-agent-orchestrator.ts:6494-6532`) are shared across all roles → researcher N≥2 is born over-budget.
   - Circuit breaker marks a step **failed** for repeating a blocked call even when the step produced complete output (`:2328-2338`; W505 run 2 researchers both "failed" with full answers in their handoffs).
   - `getMissingHandoffFailure` (`apps/gateway/src/orchestration/engine.ts:157-184`) requires ALL declared dependencies completed → one failed researcher blocks critic + synthesizer → "Synthesis Incomplete" → durable failed. The run-contract text also leaks into the fallback output's `Objective:` field (`engine.ts:~770-814`).
   - Wiped out W505–W508 in both runs (0/8 scored across 16 attempts).

7. **Web layer fidelity.** Run 1 W505: native-backend `browser.navigate` returned the same Eventbrite page for three different requested URLs (args url ≠ result url; over-loose reuse matcher — "reuse: yes … matching_recent_browser_result"). Cookie walls and 403 automation blocks consume open-cap slots.

8. **Attribution dishonesty.** All degraded rows get `model_reasoning_failure (low)` via `non_pass_without_specific_rule_signal` even when the report's own platform signals say "review routing or harness policy before attributing this solely to model quality". Rule scorer rates the fabricated stubs highly (formatAdherence 4 vs judge 0 on D509) because they were built to satisfy rule signals → systematic `major_disagreement` noise.

Genuine model findings the eval did surface (keep these scorable): D502 run 2's internally inconsistent example JSON (78.6 fail — legitimate); W502 missing the required "Next experiment" section; identical-query retries after cap guidance; C512 two-sentence format miss.

## Fixes

### P0 — make scores measure the model (blocks all further pack use)

1. **Kill orchestrator-side response rewriting for scored runs.**
   - In `applyPromptPackHarnessNormalization`, return identity (or gate behind `PROMPT_LAB_LEGACY_NORMALIZATION=1`) so `responseText` is the model's text. Remove call sites' effects: `normalizePromptLabContractOutput`, `normalizeRepoGroundedInspectionOutput`, `appendPromptLabWebCitationsIfNeeded`, and the repair/fallback farm (`buildRepoGroundedEvidenceRepairContent`, canned banks `:10020-10130`, `buildPromptLabConcreteEvidenceFallback`).
   - Anything kept must: never replace content; record a `derivedResponseSignals` entry; surface in the report Integrity section; preserve pre-rewrite text.
   - Delete test-specific steering from contract assembly (grep contract builders for prompt-keyed lines like "Portland weekend activity prompt").
   - Acceptance: re-run D505/D509/D510/C511 twice → no "## Exact files used"/"## Patch points" stubs, no appended "Source URLs:", checksums differ between runs for long outputs.

2. **Headless runs can never wait for approval.**
   - Apply `shouldSoftFailApprovalRequiredTool` on every synthetic/prefetch path (`:1037`, `:1143`, `:1315`, `:1422`, `:1606`, `:1788`, `:1824` region) — same soft-fail + compliance note as the main loop (`:2274-2345`).
   - Belt-and-braces: in the tool approval layer, when the session origin is `prompt_pack` (`prompt-pack-service.ts:488`), convert `approval_required` → deny-with-guidance.
   - Fix child-turn detection: cowork engine sub-turns must inherit the harness marker (or pass an explicit `headless` flag on `agentSendChatMessage`) so the soft-fail check doesn't depend on contract text in the prompt.
   - Acceptance: full pack run has 0 `approval_paused` rows.

3. **Fix or remove the prefetch subsystem.**
   - Validate extracted "paths": reject anything matching a tool-catalog name (replace the hardcoded regex in `describeInvalidLocalToolPath` with a catalog lookup), require path-like shape (separator or known file extension).
   - Don't prefetch file/code tools on non-code surfaces at all (it triggers the harness's own "unexpected file/code tools on non-code surface" signal).
   - Exclude junk dirs from `selectPromptLabConcreteReadPathsFromSearchResult` (see P1.6 ignore list).
   - Preferred end state: drop forced prefetches entirely — let the model's own tool use be what's evaluated.

### P1 — healthy runs must be recorded as completed

4. **Durable lease.** Raise `DURABLE_LEASE_TTL_MS` (≥120s) and make reaping require N consecutive missed heartbeats, not a single TTL lapse; move heartbeat off the starved path (worker thread or `setInterval` with drift tolerance). In `prompt-pack-service.ts:548-556`, when trace completed AND output non-empty AND only `failedByDurable`, record `completed` + integrity signal `durable_failed` (degraded) instead of `failed`. Acceptance: D502-run-1 scenario scores.
5. **Budgets and fallbacks.** Raise prompt-lab code-row turn budget to ≥240s (or scale to tool-latency reality after P1.6 lands); enforce `minSynthesisReserveMs` for the FINAL completion (never hand the closing completion <60s); allow non-streaming fallback for prompt-pack sessions (locate the suppression branch behind "non-streaming fallback suppressed" in `chat-agent-orchestrator.ts`).
6. **Search hygiene + speed.** `code.search` / `code.search_files` / prefetch selection must exclude `.codex-temp/`, `.claude/`, `data/tool-artifacts/`, `artifacts/prompt-lab/`, pack source files, build dirs; respect `.gitignore`. Also physically delete `.codex-temp/` and stale `.claude/worktrees/agent-*` from the working tree. Acceptance: repo-wide filename search <5s; D509-style traces contain no junk-copy reads; searches stop matching prior answers.

### P2 — cowork lane under agentic style

7. **Don't run the fragile engine by default.** Flip `agentic_surface` to the single-agent path (`prompt-pack-service.ts:5686`) or make orchestration opt-in per test. This alone likely rescues W505–W508.
8. If orchestration stays: count web caps per role-step and per success (not per attempt, not per turn); treat breaker-tripped steps with non-empty output as degraded-completed so `getMissingHandoffFailure` lets critic/synthesizer proceed; stop leaking the run contract into the `Objective:` field of fallback output.
9. **Web fidelity.** Fail `browser.navigate` when result URL ≠ requested URL (trace already records both); tighten the `matching_recent_browser_result` reuse matcher; don't count failed opens (403/wrong-page) against the open cap.

### P3 — reporting honesty

10. Prefer platform/harness attribution when platform signals fire (don't emit `model_reasoning_failure` on rows whose runtime cluster says "review routing or harness policy").
11. Surface any response-text mutation as a visible integrity signal in the per-test report section.
12. Determinism tripwire in report generation: identical responseText checksum (>200 chars) across different run IDs for the same test ⇒ flag `deterministic_response_suspected_fabrication`. (This is how D505/D509/D510 were caught.)

## Verification protocol

1. Land P0, re-run the pack twice back-to-back.
2. Expect: 36/36 scored; 0 approval_paused; 0 durable-failed-with-complete-trace; no repeated checksums on long outputs; cowork rows scored (after P2.7).
3. Diff the two new reports: status/verdict flips should be limited to genuinely borderline rows (target <3 of 36).
4. Only then compare model lanes — current and prior pack scores (both runs reviewed here, and everything pre-v3.2) are not comparable evidence of model quality.

## Implementation log (2026-06-10)

Implemented in-tree the same day. Goal restated by the operator: GoatCitadel must
demonstrate REAL agentic + orchestration behavior in the pack before real-world
use — so P2.7 (flipping `agentic_surface` to single-agent) was deliberately NOT
done; orchestration stays on and the engine was made survivable instead.

- **Master switch**: `promptLabEvalIntegrityTurn` in `chat-agent-orchestrator.ts`
  (`normalizationProfile === "prompt_pack_harness" || isPromptLabHarnessContent`).
  Children inherit the profile via the delegated-step dispatch, so the switch
  covers cowork sub-turns.
- **P0a**: `applyPromptPackHarnessNormalization` is a permanent identity pass;
  the orchestrator's harness-normalization + citation-append pipeline stages were
  deleted; cowork deterministic normalization and the tool-failure appendix are
  skipped on eval turns; deterministic empty-output synthesis returns "" on eval
  turns (genuine model re-asks remain); `buildRecoveredRepoGroundedAnswer`
  shortcuts removed from synthesis/repair; all nine test-keyed contract steering
  blocks removed from `buildPromptPackPromptInput`.
- **P0b**: all 8 synthetic approval-parking sites + the main loop soft-fail are
  gated on the master switch; eval turns can never enter `waiting_for_approval`.
- **P0c**: all forced/prefetch tool blocks (file, search-read, local search,
  memory, session-status, required-web search, live-data search) are disabled on
  eval turns by gating their source variables and entry conditions; the
  tool-name-as-path guard now covers the full canonical tool list.
- **Bonus fix found during verification**: the main loop previously *silently
  filtered the model's own file-tool calls* on non-code eval turns
  (`toolCalls.filter(...)` at ~line 2028). Removed — every model tool call now
  reaches the policy layer and is denied visibly if disallowed.
- **P1a**: `DURABLE_LEASE_TTL_MS` 15s → 120s; heartbeat tolerates 2 consecutive
  renewal failures (aborts on the 3rd; immediate abort on definitive ownership
  loss); prompt-pack status mapping keeps durable-failed + completed trace +
  output as `completed` with a non-invalidating `durable_failed` signal.
- **P1b**: prompt-lab harness rows floored at 240s turn / 150s completion; the
  final synthesis completion is guaranteed `minSynthesisReserveMs`; streaming
  partial-output failure falls back to non-streaming on eval turns.
- **P1c**: `shouldSkipSearchEntry` extended (.codex-temp, .claude, .scratch,
  artifacts, tool-artifacts, logs, postgres, obj, .turbo, .cache) + 1.5MB
  content-read cap in `searchFileContents`; `.codex-temp/` deleted from the tree
  (`.claude/worktrees` left alone — concurrent sessions may own them).
- **P2 (revised)**: engine accepts failed-with-output steps as usable handoffs
  (`isUsableHandoffStep`), stage progression continues on them, dependency check
  is `.some(...)`; web caps count `executed` runs only; orchestration objective
  is the extracted user task (fixes the Objective contract leak and child-prompt
  contamination).
- **P3**: platform-signal-aware attribution before the `model_reasoning_failure`
  default; completion repairs surface as `response_repaired_*` integrity signals
  (degraded-only); determinism alarm in the report for byte-identical long
  outputs across runs of the same test.
- **Tests**: ~132 tests across 19 files pinned the old fabrication behavior and
  were rewritten/deleted per `.scratch/eval-integrity-test-doctrine.md`.

### Adversarial review round (same day)

A five-lens adversarial review of the diff surfaced material issues that were
fixed before completion:

- **Profile-only master switch**: `promptLabEvalIntegrityTurn`, the budget
  `promptLabHarness` flag, the approval soft-fail, and the fallback eval check
  are now keyed STRICTLY on the server-set `normalizationProfile` — a live user
  pasting a run contract can no longer flip approval/user-input/streaming
  semantics or double the turn budget. A live-boundary test pins parking.
- **Surviving query steering killed**: `preflightToolInvocation` no longer
  rewrites the model's tool arguments on eval turns — no curated
  `derivePromptSpecificWebQuery` replacements, no search→navigate promotion,
  no URL redirection, no missing-arg invention (missing args block with
  guidance). The two tests that had blessed the curated queries now assert
  verbatim pass-through.
- **fs.list access-check probe** gated off eval turns (it could previously
  replace the whole answer with controller-authored probe text).
- **Search exclusions narrowed**: only unambiguous junk names skip globally;
  heavy dirs (artifacts, logs, workspace, data/postgres, data/tool-artifacts)
  skip ONLY directly under the search root — `packages/storage/src/postgres`
  is searchable again. Results now carry `skippedDirs` / `skippedOversizeFiles`
  counters so silent false negatives are visible.
- **Synthesis-reserve floor** applies to eval turns only (live turns keep the
  strict responsiveness deadline).
- **Durable lease**: clean `renewLease` CAS loss aborts immediately (definitive
  ownership loss, no strikes); strike tolerance is additionally wall-clock
  bounded by the TTL to prevent double-runs under extreme starvation.
- **Engine handoffs**: failed-step output equal to the error string or wait
  placeholders does not count as usable; two engine tests pin both directions.
- **Scoring honesty tightened**: only genuine model re-ask repair kinds
  (`incomplete_truncated_completion`, `degraded_answer_synthesis`) are
  non-invalidating; deterministic/normalization repair kinds invalidate.
  Platform attribution only fires for definitive runtime signals
  (protocol/trace failure) — model-caused off-surface tool use and budget
  overruns stay under model attribution. Determinism alarm is one-pass.
- **Child dispatchers**: chat-delegation children inherit the eval profile from
  prompt-pack session origin. KNOWN GAP: orchestration-phase-execution-service
  children do not (path is operator-routine-driven, unreachable from
  prompt-pack today; revisit if that changes).

## Related

- `docs/superpowers/plans/2026-06-09-prompt-lab-scoring-integrity.md` (predecessor; removed the service-side fabrication layer — this plan removes the orchestrator-side layer it missed)
- Run artifacts: `artifacts/prompt-lab/runs/manual-import_2026-06-10_01-10-02Z_openai-codex_gpt-5.5_agentic.md`, `…_02-06-17Z_…`
