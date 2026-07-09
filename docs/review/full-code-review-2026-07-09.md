# GoatCitadel Full Code Review — 2026-07-09

## Review Contract

- Review base: `c28b54bf1276482067f36bcfd12429ceca1f76c4` (`origin/main` at review start)
- Serial delivery:
  - `codex/review-00-proof-integrity` merged as PR #205 at `df0b3576ac1c4ae32efb44f6d94593b0886c7949`
  - `codex/review-01-network-side-effects` is the current security branch
- Canonical product surface: one Chat surface backed by the Gateway runtime
- Finding priorities: correctness, security, data durability, orchestration/agentic behavior, performance, runtime truth, and operator-facing UX behavior
- Excluded local state: `.env`, runtime databases, transcripts, audit logs, backups, dependency trees, build output, generated verification artifacts, and ignored legacy Mission Control residue
- Generated assets: review generator, provenance, schema, packaging, and regression behavior rather than generated rows or pixels line by line

## Finding Record

Every material finding records severity, confidence, release tier, certainty, evidence, reproduction, root cause, remediation, focused proof, broad proof, and final status.

Severity is `critical`, `high`, `medium`, or `low`. Release tier is `shipped`, `compatibility`, `experimental`, `generated`, `test-harness`, or `release-ops`. Certainty is `confirmed`, `likely`, or `runtime-validation-needed`.

## Baseline

| Check | Result | Evidence |
| --- | --- | --- |
| Git parity | Pass | Review base matched `origin/main`; clean dedicated worktree |
| Lint | Pass | `pnpm lint --max-warnings 0` |
| Typecheck | Pass | `pnpm typecheck` across 14 workspace projects |
| Build | Pass | `pnpm build`; canonical web and desktop bundles built |
| Fresh coverage | Pass | Final proof-branch source: 67.91% lines, 78.85% branches, 89.37% functions; 1,290/1,306 executable files covered |
| Production coverage tiers | Pass | storage/policy 97.31% lines; Gateway/shared 60.65% against 58% floor; Mission Control 88.85% |
| Documentation governance | Pass | `pnpm docs:check` |
| Repo/supply-chain posture | Pass | `pnpm verify:repo:hygiene`; `pnpm verify:supply-chain` |
| Agentic contracts/governance | Pass on review base | Fresh main baseline captured before this branch |
| Architecture metrics | Initial fail; fixed on review branch | Raw-text counter reported 950; symbol-aware metric reports and pins 900 typed host callbacks |
| Orchestration performance | Initial misleading pass; fix in progress | Original CLI reported three fixed samples dated 2026-06-17 instead of measuring current runtime |
| GitHub CodeQL | Pass | No open code-scanning alerts; current base SHA CodeQL runs succeeded |
| GitHub Dependabot | Pass | No open Dependabot alerts |
| GitHub secret scanning | Fixed | Secret scanning and push protection enabled; zero alerts immediately after enablement |

## Findings Ledger

### FR-001 — Orchestration performance lane does not execute or measure the runtime

- Severity: `high`
- Confidence: `high`
- Release tier: `test-harness`
- Certainty: `confirmed`
- Evidence: `apps/gateway/src/orchestration/performance-gates-cli.ts` supplies fixed timestamps, costs, counters, and passing quality gates.
- Reproduction: `pnpm verify:orchestration:perf` always reports `generatedAt=2026-06-17T00:00:03.000Z`, three samples, and the same sub-second latencies.
- Root cause: the CLI was implemented as a report-builder demonstration but named and documented as a performance verification lane; the report builder also accepted empty, invalid, backwards, negative, and non-finite sample data.
- Remediation: replace fixed samples with deterministic scenarios that execute current orchestration code and emit measured scenario plus aggregate artifacts; keep report arithmetic unit-tested.
- Focused proof: performance-gate unit tests and deterministic runner tests.
- Broad proof: `pnpm verify:orchestration:perf`, agentic proof, and `pnpm verify:fast`.
- Status: `partially fixed and honestly scoped — 11 measured routed engine runs, a production completion-service retry after injected 503, and zero duplicate dispatches; tool, approval pause/resume, durable/restart, long-context, concurrent-session, stalled transport, and variance-threshold scenarios remain open`

### FR-002 — Architecture baseline rejects the July decomposition without classifying its new seams

- Severity: `high`
- Confidence: `high`
- Release tier: `test-harness`
- Certainty: `confirmed`
- Evidence: the original verifier reported 950 raw `host.*` text matches against a 921 baseline while GatewayService shrank by 1,341 lines. The counter included comments, strings, `URL.host`, untyped lambda variables named `host`, and local backend variables.
- Reproduction: `pnpm verify:architecture:metrics` fails on the clean review base.
- Root cause: `architecture-metrics.mjs` used `/\bhost\./g` over raw source rather than parsed, symbol-bound TypeScript.
- Remediation: replace the regex with a TypeScript AST/symbol-aware counter, prove lexical lookalikes are ignored, audit the actual July delta, and pin the current typed-host baseline only after the ownership review.
- Focused proof: architecture metric unit/scenario tests.
- Broad proof: `pnpm verify:architecture:metrics`, typecheck, and `pnpm verify:fast`.
- Status: `fixed on branch — 900 typed host callbacks; zero baseline delta; July stream host is a narrow typed port`

### FR-003 — Gateway/shared coverage gate remains below its declared next ratchet

- Severity: `medium`
- Confidence: `high`
- Release tier: `test-harness`
- Certainty: `confirmed`
- Evidence: fresh Gateway/shared line coverage is 60.60%, while the enforced floor remains 52% and the policy names 60% as the next ratchet.
- Reproduction: `pnpm coverage:collect && pnpm coverage:gate:production` passes with the stale 52% tier threshold.
- Root cause: the coverage policy and comments were not updated after coverage recovered above the documented next target.
- Remediation: enforce 58% as the stability floor around the freshly measured 60.60%, retain 60% as the next ratchet, and add regression coverage around current orchestration blind spots.
- Focused proof: coverage tooling tests plus a fresh coverage collection.
- Broad proof: `pnpm coverage:gate:production` and Code Quality CI.
- Status: `fixed and proven — post-change Gateway/shared measured 60.65% against the 58% enforced floor`

### FR-004 — GitHub secret scanning and push protection are disabled on a public repository

- Severity: `medium`
- Confidence: `high`
- Release tier: `release-ops`
- Certainty: `confirmed`
- Evidence: GitHub repository API reports `secret_scanning=disabled` and `secret_scanning_push_protection=disabled`; the repository is public.
- Reproduction: query `repos/goatcitadel/GoatCitadel` security analysis state and the secret-scanning alerts endpoint.
- Root cause: repository security settings are not enabled despite the checked-in narrow fixture allowlist and synthetic-token guidance.
- Remediation: verify fixture exclusions, enable secret scanning and push protection, then query alerts and triage any result under `docs/security/findings-triage.md`.
- Focused proof: GitHub security settings and alerts API queries.
- Broad proof: CodeQL, Trivy, artifact redaction, supply-chain posture, and repository hygiene.
- Status: `fixed and verified — secret scanning and push protection enabled; alert API returned zero alerts`

### FR-005 — Two release-proof matrix lanes cannot produce the artifacts their workflow requires

- Severity: `high`
- Confidence: `high`
- Release tier: `release-ops`
- Certainty: `confirmed`
- Evidence: `verify:desktop` and `verify:extensions:package` originally ran standalone scripts, while the release workflow always followed each lane with `verify:review` and uploaded `artifacts/verification` using fail-on-missing behavior.
- Reproduction: hosted release run `29011596084` completed both underlying commands, then failed review/artifact steps because no verification run existed.
- Root cause: the matrix contract assumes every lane uses `scripts/verification/run.mjs`, but these two aliases bypassed it.
- Remediation: wrap both commands in named verification-context lanes, preserve raw internal aliases, and statically require every matrix lane to be verification-backed.
- Focused proof: release-certificate tests and the extensions package lane.
- Broad proof: scheduled release workflow on the publication SHA, including Windows desktop.
- Status: `fixed on branch — hosted Windows confirmation pending`

### FR-006 — Coverage gating accepts stale successful artifacts

- Severity: `medium`
- Confidence: `high`
- Release tier: `test-harness`
- Certainty: `confirmed`
- Evidence: `coverage-gate.mjs` originally validated percentages and status but carried no source/test revision or content fingerprint.
- Reproduction: copy any prior successful `coverage-summary.json` over changed source and run `pnpm coverage:gate`; the original gate passed it.
- Root cause: collection provenance ended at a random run ID and timestamps that were never compared with current source.
- Remediation: hash current apps, packages, scripts, and coverage-affecting root configuration; record that fingerprint during collection and fail gating when it differs.
- Focused proof: coverage-tooling stale-artifact regression.
- Broad proof: fresh collection followed by production gating.
- Status: `fixed and proven — apps/packages/scripts plus coverage-affecting root configs are hashed; post-review-fix stored and recomputed fingerprint sha256:a2213122... matched; production gate passed`

### FR-007 — Verification, packaging, and release modules were excluded from ESLint

- Severity: `medium`
- Confidence: `high`
- Release tier: `test-harness/release-ops`
- Certainty: `confirmed`
- Evidence: the root ESLint config globally ignored every `.mjs` and `.cjs` file, covering 125 Node modules that implement verification, release, packaging, coverage, and CLI behavior.
- Reproduction: `pnpm lint` skipped those files; explicit no-ignore lint found an uncaught-error provenance defect in `benchmark/lib/targets.mjs` plus legacy script-rule incompatibilities.
- Root cause: Node and browser-injected globals were never modeled for script modules, so they were excluded wholesale.
- Remediation: add an explicit script-module ESLint environment/rule profile, remove global ignores, fix the confirmed error-cause defect, and discover all script tests rather than maintaining a partial hand list.
- Focused proof: release proof static regression, all script tests, and zero-warning lint.
- Broad proof: `verify:repo:hygiene` and Code Quality CI.
- Status: `fixed and proven — zero-warning full lint and all 115 discovered script tests passed`

### FR-008 — Cold contracts coverage import can exceed the generic unit timeout

- Severity: `low`
- Confidence: `high`
- Release tier: `test-harness`
- Certainty: `confirmed`
- Evidence: the first post-change `coverage:collect` failed only because `packages/contracts/src/module-load-smoke.test.ts` reached the generic 5-second timeout during a cold V8 coverage transform; the immediate focused rerun passed all 317 tests.
- Reproduction: run workspace coverage from cold build/transform state on Windows; the full contracts barrel import can cross five seconds.
- Root cause: a full export-barrel transform used a latency ceiling intended for ordinary unit tests.
- Remediation: give only that module-load smoke a documented 15-second ceiling; retain the global timeout everywhere else.
- Focused proof: contracts coverage suite.
- Broad proof: complete fresh coverage collection.
- Status: `fixed and proven — complete fresh collection passed all 317 contracts tests and the workspace`

### FR-009 — Failed orchestration performance gates discard their structured report

- Severity: `medium`
- Confidence: `high`
- Release tier: `test-harness/release-ops`
- Certainty: `confirmed`
- Evidence: the performance CLI writes its JSON artifact before setting a failing process exit code, while `runOrchestrationPerformanceLane` originally read that JSON only when the exit code was zero.
- Reproduction: make any performance threshold fail; the verification scenario records zero measured runs, no performance artifact, and raw logs instead of the report's threshold failures.
- Root cause: report availability was incorrectly coupled to process success even though the report is the canonical failure evidence.
- Remediation: read the report whenever it exists and use the exit code only as one input to pass/fail status.
- Focused proof: verification-scenario regression with a nonzero process result and a populated failing report.
- Broad proof: `pnpm verify:orchestration:perf`, repository hygiene, and the release-proof workflow.
- Status: `fixed and proven — the failing scenario retains measured metrics, threshold failures, and its performance artifact link`

## Confirmed Open Runtime Findings

The independent runtime, agentic, storage, provider, memory, integration, and native passes produced the following confirmed release blockers. These remain open after the proof-integrity branch and must be fixed in the serial branches named by the finding family.

### FR-101 — Cross-origin redirects forward credentials and mutation bodies

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: `packages/policy-engine/src/sandbox/network-guard.ts:183-243` and duplicate wrappers in `tool-executor.ts:683-720` and `comms-executor.ts:4043-4080` reuse the original request init on every redirect hop.
- Reproduction: an allowlisted `api.example.com` redirect to allowlisted `cdn.example.com` received the original `Authorization`, `Cookie`, `X-API-Key`, and POST body.
- Root cause: redirect destinations are network-validated, but request authority is not rebound to the new origin.
- Fix: centralize redirect authority policy and default-deny credential-bearing or body-carrying cross-origin redirects.
- Focused proof: two-origin policy-engine regressions; broad proof: security evals, channel/MCP/A2A tests, and fast lane.
- Status: `fixed and proven on review-01 — one shared redirect-authority policy now blocks cross-origin credentials, bodies, and mutation methods before contact; same-origin authenticated and anonymous allowlisted GET redirects remain supported; central and both duplicate redirect loops are covered`

### FR-102 — Retry policy can duplicate ambiguous external writes

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: `tool-executor.ts` and `comms-executor.ts` retry 408/429/502/503/504 for every method, including Slack, Gmail, calendar, and webhook POST operations without transmitted provider idempotency keys.
- Reproduction: a Slack POST returning 503 and then 200 is issued twice and reported delivered once.
- Root cause: transport retryability is decided from status alone rather than HTTP method plus provider idempotency semantics.
- Fix: retry safe methods only by default; allow POST retry only when a stable provider-supported idempotency key is actually sent, otherwise enter manual reconciliation.
- Focused proof: ambiguous-success adapter tests; broad proof: external replay, channel runtime, and security eval lanes.
- Status: `fixed and proven on review-01 — automatic retry is limited to GET/HEAD; ambiguous mutations issue once, become manual-reconciliation-required, retain that structured state through Gateway delivery, and cannot enter durable retry`

#### Review-01 closure evidence

- Canonical ownership: HTTP redirect/retry authority is centralized in the policy engine; channel-delivery persistence and compare-and-swap transitions remain storage-owned; Gateway and MCP layers project the canonical structured outcome without reclassifying an unknown external write as blocked, retryable, or successful.
- Redirect and generic HTTP proof: same-origin and cross-origin redirect matrices cover credentials, caller-derived headers, methods, bodies, allowlists, one-shot fetch behavior, response-body limits, and post-send failures. Automatic retries are limited to GET/HEAD; mutation responses and exceptions after dispatch carry `externalOutcome=unknown_after_send` and `manualReconciliationRequired=true`.
- Channel proof: Slack, Telegram, WhatsApp, Gmail, calendar, generic channel sends, rich/multipart sends, and bounded-body failures preserve manual-reconciliation state and any known provider message ID. SQLite delivery claims and terminal transitions are lease-fenced across overlapping drains, independent runtimes, delayed losers, restarts, callbacks, and stale snapshots; no proven pre-send failure is mislabeled as externally ambiguous.
- MCP proof: `tools/call` is replayed only for an explicit server result declaring `phase=pre_dispatch` and `retrySafe=true`. Stdio and remote-HTTP post-dispatch transport failures, JSON-RPC errors, and `isError` results issue once and retain structured unknown/manual truth through diagnostics, realtime evidence, approvals, and the public response.
- Dual-dialect proof: the nullable lease compare-and-swap predicate uses dialect-correct PostgreSQL typing. The live disposable PostgreSQL suite passed 2/2 tests, including a null-lease CAS transition and a stale-snapshot attempt that could not overwrite a sent row/provider ID; the SQLite storage suite passed 694 tests with 2 intentional skips.
- Owning suites: Gateway passed 5,291 Vitest tests plus 17 Node tests; policy engine passed 627 tests; contracts passed 317 tests; storage passed 694 tests with 2 skips. Contracts, storage, policy-engine, and Gateway typechecks passed, as did zero-warning lint over every changed source/test file.
- Named proof: `verify:api:compat` (`2026-07-09T22-50-28-663Z-api-compat-08cd53f1`), `verify:channels:runtime` (`2026-07-09T23-25-22-112Z-agentic-channels-runtime-77c0f039`), `verify:runtime:truth` (`2026-07-09T23-25-22-065Z-runtime-truth-a47c084a`), `verify:mcp:conformance` (6/6), and `verify:security:evals` (`2026-07-09T23-25-22-065Z-security-evals-f5c4ada1`) passed on the final source.
- Broad proof: `docs:check` passed; `verify:fast` passed as `2026-07-09T23-25-53-533Z-fast-9ebfbb57`. The architecture guard initially rejected 29 new facade lines; the logic was moved into the existing channel-delivery helper owner, leaving GatewayService at the verifier's authoritative 8,292 lines (43 below the 8,335 baseline), 900 typed host callbacks (zero delta), and a passing `2026-07-09T23-25-22-060Z-architecture-metrics-76332783` artifact without a baseline ratchet.
- Hosted-review closure: automated review found three adjacent boundary errors and each was reproduced with a failing regression before correction. Safe attachment/preflight GET responses could falsely mark a later pre-dispatch failure as an ambiguous channel mutation; request tracking now accumulates mutation-started and mutation-response boundaries separately. Explicit MCP `pre_dispatch` truth could be overridden by expired-session wording; that phase is now authoritative and is not projected as unknown/manual. An already-aborted `http.post` could reach fetch and become unknown; it now exits before dispatch, while a paired abort-after-fetch regression remains `unknown_after_send`. Attachment 404s, response-stream failures, and pre-dispatch policy blocks remain `not_available`/`blocked`, while successful upload followed by a later attachment failure remains manual. The boundary suites, the 25-test channel-failure suite, and the full owning suites passed.
- Independent closure: three adversarial passes and a post-review boundary re-review separately returned safe-to-merge verdicts after testing redirected mutation authority, delayed delivery losers, stale-runtime fencing, provider-ID retention, nullable PostgreSQL predicates, MCP replay, preflight-versus-mutation boundaries, and adjacent failure paths. Their only shared residual proof caveat was live PostgreSQL execution; the 2/2 live PostgreSQL run above closed it before publication.

### FR-103 — Inline secrets cross storage, API, approval, audit, and model boundaries

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: key-pattern-only scrubbing in `tool-security.ts`; raw approval/tool arguments and URLs in orchestration evidence; approval-explainer prompts; raw integration connection configs returned by generic APIs; A2A bearer tokens stored directly.
- Reproduction: a webhook URL containing `key`/`token`, a short bearer value, and `DATABASE_PASSWORD` produced no detections, survived sanitization, and could enter the explainer request.
- Root cause: executable configuration, persisted evidence, and public/model DTOs share raw objects; redaction is neither key-aware enough nor URL/string-aware.
- Fix: reject inline secrets where secret references are required, introduce sanitized public/evidence/model projections, migrate persisted credentials forward to secret references, and preserve only resolvable references in executable state.
- Focused proof: storage/API/explainer redaction regressions; broad proof: artifact redaction, auth matrix, migration parity, and channel/A2A lanes.
- Status: `open — secret-boundary security branch`

### FR-104 — Approval effects can commit after the API reports failure

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: `approval-lifecycle-service.ts:649-689` commits resolution plus effects, then awaits fallible audit/realtime work; remote resolution consumes its token before the same fallible sequence; creation has the analogous post-commit path.
- Reproduction: inject audit failure after the transaction: the route returns 500 while the approval is resolved and its effect may execute; retry is then rejected as already resolved.
- Root cause: post-commit observability failure is represented as mutation failure, and HTTP-status-only idempotency finalization cannot distinguish commit state.
- Fix: durable audit/realtime outbox or explicit committed-result contract, with resumable remote-token claims and idempotency completion after committed mutations.
- Focused proof: post-commit failure injection; broad proof: approvals, remote resolution, durable recovery, auth matrix, and fast lane.
- Status: `open — approval atomicity branch`

### FR-105 — A2A credentials do not enforce transport, method, or workspace scope

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: scopes are configured and returned, but `a2a-route-service.ts` dispatches JSON-RPC/HTTP without checking them; `SendMessage` accepts a peer-controlled workspace ID.
- Reproduction: a credential scoped for one transport can reach another enabled transport/method and request session/task creation in an arbitrary workspace.
- Root cause: authentication and authorization scopes are modeled separately but only authentication participates in dispatch.
- Fix: fail-closed transport/method scope matrix plus credential-bound workspace allowlist.
- Focused proof: cross-transport/method/workspace denial matrix; broad proof: `verify:a2a:full`, auth matrix, and agentic contracts.
- Status: `open — A2A authorization branch`

### FR-106 — Provider streams can truncate at EOF and still become completed turns

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: OpenAI and Anthropic SSE parsers accept EOF without required terminal events; OpenAI `response.incomplete` is ignored; completion service marks any yielded stream completed.
- Reproduction: end an OpenAI or Anthropic fixture after content/tool deltas but before `response.completed`/`response.incomplete` or `message_stop`; current collectors synthesize success.
- Root cause: parser EOF is treated as protocol completion instead of transport interruption with provider-specific terminal state.
- Fix: require terminal events, propagate incomplete reasons and partial usage, and route interruption through retry/fallback rules without replaying already-emitted output.
- Focused proof: documented terminal-event fixtures and partial tool-call tests; broad proof: provider normalization, runtime truth, and fast lanes.
- Status: `open — provider stream-truth branch`

### FR-107 — Anthropic streaming drops prompt and cache usage

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: `message_start.message.usage` is ignored and later `message_delta.usage` replaces the usage object; the existing fixture incorrectly places all usage in the delta.
- Reproduction: use the provider's documented event shape: input/cache tokens become zero while only output tokens survive.
- Root cause: usage is replaced per event instead of merged according to Anthropic's cumulative stream semantics.
- Fix: capture start usage and merge deltas while preserving input/cache fields and updating cumulative output.
- Focused proof: canonical Anthropic event fixture; broad proof: provider cost/budget and runtime truth lanes.
- Status: `open — provider accounting branch`

### FR-108 — Bulk memory forget silently stops after 500 matches

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: `listMemoryItems` clamps to 500 while namespace/query forget requests 2,000 and treats the capped response as exhaustive.
- Reproduction: seed more than 500 matching active memories and forget by namespace/query; the API reports success with matches still active.
- Root cause: a presentation-oriented list API is reused as the mutation's complete selection mechanism.
- Fix: paginate to exhaustion or perform an atomic set-based scoped mutation with truthful affected counts.
- Focused proof: >500-item forget regression; broad proof: memory truth, PostgreSQL, and fast lanes.
- Status: `open — memory lifecycle branch`

### FR-109 — Cutover can certify empty or content-mismatched imports

- Severity: `high`; confidence: `high`; release tier: `release-ops`; certainty: `confirmed`.
- Evidence: `database-cutover-service.ts` hard-codes default backup paths, normalizes missing snapshot sources to zero, imports with `ON CONFLICT DO NOTHING`, and verifies row counts only.
- Reproduction: a custom-path SQLite backup inspects zero tables and can pass; a same-key/same-count target containing different content also returns `verified:true`.
- Root cause: cutover uses pathname assumptions and cardinality as a proxy for identity/integrity.
- Fix: resolve semantic manifest roles, fail on missing required sources, and compare deterministic table/content digests before cutover.
- Focused proof: custom-path and same-count/different-content regressions; broad proof: migration parity, PostgreSQL, backup roundtrip, and install proof.
- Status: `open — cutover integrity branch`

### FR-110 — Migration immutability proof omits most current migrations

- Severity: `high`; confidence: `high`; release tier: `test-harness/release-ops`; certainty: `confirmed`.
- Evidence: protected PostgreSQL hashes stop at v28 while current history ends at v78; regex extraction silently omits v62/v63 when comments precede `version`.
- Reproduction: mutate v57 name/hash and run migration parity; the original verifier reports no immutability error and extracts only 76 records.
- Root cause: a partial manual baseline plus source-format-sensitive regex stands in for parsed migration provenance.
- Fix: parse the canonical migration arrays structurally, lock every historical version/name/hash, and reject gaps/duplicates in both dialects without changing frozen SQL.
- Focused proof: mutation/gap/comment-shape tests; broad proof: migration parity, PostgreSQL, and fast lanes.
- Status: `open — migration proof branch`

### FR-111 — PostgreSQL claims and event sequences are cross-process racy

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: mutation-idempotency claim is select-then-insert; transcript/audit logs calculate `MAX(event_sequence)+1`; PostgreSQL maps `transaction("immediate")` to plain READ COMMITTED `BEGIN`.
- Reproduction: two independent clients can observe the same absence/max; one then fails a uniqueness constraint instead of returning stable in-progress state or persisting both events.
- Root cause: SQLite locking assumptions leak through a dialect-neutral transaction label that PostgreSQL does not implement.
- Fix: atomic insert/conflict claim semantics and per-stream atomic sequence allocation or advisory locking, with real two-client PostgreSQL tests.
- Focused proof: concurrent independent-client tests; broad proof: PostgreSQL, replay, runtime truth, and fast lanes.
- Status: `open — PostgreSQL concurrency branch`

### FR-112 — PostgreSQL and custom-path backups cannot satisfy the advertised contract

- Severity: `high`; confidence: `high`; release tier: `release-ops`; certainty: `confirmed`.
- Evidence: PostgreSQL backups contain a dump plus config but verifier requires transcript/audit sections; manifest classification also recognizes only default SQLite `data/...` paths despite configurable directories.
- Reproduction: a service-shaped PostgreSQL manifest is payload-verified but contract-unverified for missing transcript/audit; valid custom-path SQLite backups fail the same classification.
- Root cause: backup roles are inferred from default relative path strings rather than backend/config-aware semantic roles.
- Fix: emit semantic manifest roles and backend-specific minimum contracts, then prove configured-path create/verify/restore and PostgreSQL dump validation.
- Focused proof: custom-path SQLite and disposable PostgreSQL variants; broad proof: backup roundtrip, PostgreSQL, and release proof.
- Status: `open — backup contract branch`

### FR-113 — Automatic Chat orchestration is absent from the canonical run projection and advertises dead controls

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: the host queries `/agentic/runs?surface=chat`, while taskless projection accepts only absent/`cowork`; projected cancel/retry controls route to a Task-backed handler and deterministically cannot find taskless runs.
- Reproduction: create a taskless Chat orchestration, list with `surface=chat`, then invoke every enabled projected control; the run is absent, or the control fails `Agentic run not found`.
- Root cause: legacy Cowork projection and Task control semantics were not normalized to the one-Chat product/runtime authority.
- Fix: include Chat-normalized taskless runs, filter before limiting, use Chat board provenance, and disable state-only controls until a canonical handler exists.
- Focused proof: mixed-surface list/tree/control integration tests; broad proof: agentic contracts/proof, runtime truth, and UI parity.
- Status: `open — agentic projection branch`

### FR-114 — One-Chat mode hides the rich workflow panel and agentic Stop control

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: real surface state always normalizes to `chat`, while workflow panel and Stop resolver remain gated on legacy `cowork`/`code`; tests mock impossible legacy modes.
- Reproduction: render the real host with an active taskless or Task-backed run; canonical Chat cannot reach the workflow panel/run control.
- Root cause: product normalization changed the mode source without changing downstream visibility predicates.
- Fix: key visibility to canonical agentic activity and executable control state, never revive separate primary Cowork/Code surfaces.
- Focused proof: real-hook Chat host/composer tests; broad proof: UI parity, surface regression, and agentic proof.
- Status: `open — one-Chat runtime truth branch`

### FR-115 — Manual Task-backed delegation lacks a durable parent continuation

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: manual delegation creates Task/run rows but no durable parent; SSE disconnect aborts execution; approval/user-input child wake has no generic parent continuation; Task cancellation lacks a live durable target.
- Reproduction: two-step manual delegation where step one waits, disconnect the observer, approve or provide input, restart, and observe missing downstream work/inconsistent terminal state.
- Root cause: streamed request lifetime owns the workflow that should be durably checkpointed and observer-independent.
- Fix: top-level durable delegation parent with idempotent child completion events, checkpointed fan-in/synthesis, passive disconnect detach, and explicit parent/child cancellation.
- Focused proof: approval and user-input disconnect/restart scenarios; broad proof: durable recovery, agentic proof, operator proof, and runtime truth.
- Status: `open — durable delegation branch`

## Confirmed Medium Queue

| ID | Finding family | Confidence / tier | Evidence and reproduction | Required fix/proof | Status |
| --- | --- | --- | --- | --- | --- |
| FR-201 | Windows path-jail validation | High / shipped | Drive-absolute, drive-relative, UNC/device paths pass `chat-project-repo` validation and become allowed roots | Shared cross-platform relative-path validator plus resolver defense; storage/tool tests | Open |
| FR-202 | Workbench process-tree cleanup | High / shipped | Timeout calls `child.kill()` and force-settles while descendants can survive | Existing process-tree killer plus descendant sentinel proof | Open |
| FR-203 | Concrete idempotency identity | High / shipped | Same key/body across distinct approval route params collides | Include canonical params and semantic query hash; route tests | Open |
| FR-204 | Stale mutation claims | High / shipped | Crash after claim leaves permanent `pending`; no lease/reconciliation | Unknown/stale state with route-owned reconciliation; restart tests | Open |
| FR-205 | Learned-memory atomicity | High / shipped | Rebuild clears before reading; item/source/conflict writes split across statements | Transactional replacement/batch mutations; failure injection | Open |
| FR-206 | Restore and cleanup atomicity | High / release-ops | Offline restore can partially overwrite; backup temp dirs leak; Chat hard-delete truncates paths and swallows cleanup failure | Staging/rollback and durable cleanup jobs; backup/session deletion proof | Open |
| FR-207 | Durable queue starvation/N+1 | High / shipped | 500 future-gated oldest rows hide ready row 501 and cause 500 retry reads | Eligibility query/index and query-plan regression | Open |
| FR-208 | PostgreSQL audit retention | High / shipped | `auditDays` prunes files only; PG audit rows remain | Backend prune capability and PG retention test | Open |
| FR-209 | Migration lineage/table quoting | High / release-ops | SQLite ignores applied-name drift; async PG migrator interpolates configurable table name | Fail-closed lineage and identifier quoting tests | Open |
| FR-210 | Provider credential cache | High / shipped | Secret rotation leaves model/auth caches keyed by raw API key | Invalidate on mutation and use non-secret fingerprint; provider tests | Open |
| FR-211 | Agentic stale tree/pagination/bounds | High / shipped | Session-only tree load, merged cursor loss, unbounded roles/steps, ephemeral fanout provenance | Run-keyed refresh, stable pagination, hard budgets, durable provenance | Open |
| FR-212 | WinUI/Tauri process and SSE lifecycle | High / release-ops | Overlapping poll children, endless launcher wait, EOF hot reconnect, watcher overlap | Single-flight/timeouts/tree cleanup/backoff/join proof | Open |
| FR-213 | Docker and installer cleanup safety | High / release-ops | `child.killed` suppresses escalation; unmarked install directories are recursively replaced | Exit-observed escalation and marker/explicit takeover guards | Open |
| FR-214 | Experimental no-agent cron bounds | High / experimental | Unbounded stdout/stderr and parent-only kill | Bounded capture and process-tree cleanup; experimental tests | Open |

## Scope Ledger

| Subsystem | Release tier | Review status | Required closeout |
| --- | --- | --- | --- |
| Contracts and shared runtime types | shipped | In progress | API compatibility and focused tests |
| Gateway composition and Chat runtime | shipped | In progress | Focused tests, typecheck, fast/runtime truth |
| Storage, migrations, audit, and backup | shipped | In progress | SQLite/Postgres parity and recovery proof |
| Policy, approvals, tools, and Code Mode | shipped | In progress | Auth/policy/adversarial and sandbox proof |
| Orchestration, delegation, durable execution | shipped | In progress | Cross-path parity, recovery, and performance proof |
| Memory, skills, capabilities, and knowledge | shipped | In progress | Memory truth and callable/inspectable governance |
| Providers, channels, integrations, MCP, A2A | shipped/experimental | In progress | Adapter tests and truthful degraded states |
| Mission Control Next and shared renderer | shipped | In progress | Functional, accessibility, performance, and surface proof |
| Tauri, WinUI, launcher, Docker, installers | release-ops | In progress | Native, packaging, install, and workflow proof |
| Verification, coverage, benchmarks, and docs | test-harness/release-ops | In progress | Honest lane semantics and final evidence |

## Positive Signals

- Current `main` is lint-, typecheck-, build-, CodeQL-, Dependabot-, and fast-lane clean.
- Storage and policy/security-critical coverage is above 97% lines and 89% branches.
- The recent decomposition materially reduced `GatewayService` size while preserving public method counts and route-service boundaries.
- Existing verification artifacts make failures inspectable; this review will tighten what each lane is allowed to claim.

## Final Verdict

Pending. The review remains open until every scope row is closed, confirmed high/medium bugs are fixed or explicitly deferred, performance evidence is measured from current code, and final proof passes on the publication SHA.
