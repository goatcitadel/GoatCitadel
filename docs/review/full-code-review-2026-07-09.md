# GoatCitadel Full Code Review — 2026-07-09

## Review Contract

- Review base: `c28b54bf1276482067f36bcfd12429ceca1f76c4` (`origin/main` at review start)
- Serial delivery:
  - `codex/review-00-proof-integrity` merged as PR #205 at `df0b3576ac1c4ae32efb44f6d94593b0886c7949`
  - `codex/review-01-network-side-effects` merged as PR #206 at `4df18536833a453c0e31f3a164c8d988abb14bc4`
  - `codex/review-02-secret-projection-containment` merged as PR #207 at `a183833af23ffb73cb48233736ff913d4796eb6e`
  - `codex/review-03-approval-commit-truth` is the current approval/data-integrity branch
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
- Status: `fixed, proven, and merged in PR #206 — one shared redirect-authority policy now blocks cross-origin credentials, bodies, and mutation methods before contact; same-origin authenticated and anonymous allowlisted GET redirects remain supported; central and both duplicate redirect loops are covered`

### FR-102 — Retry policy can duplicate ambiguous external writes

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: `tool-executor.ts` and `comms-executor.ts` retry 408/429/502/503/504 for every method, including Slack, Gmail, calendar, and webhook POST operations without transmitted provider idempotency keys.
- Reproduction: a Slack POST returning 503 and then 200 is issued twice and reported delivered once.
- Root cause: transport retryability is decided from status alone rather than HTTP method plus provider idempotency semantics.
- Fix: retry safe methods only by default; allow POST retry only when a stable provider-supported idempotency key is actually sent, otherwise enter manual reconciliation.
- Focused proof: ambiguous-success adapter tests; broad proof: external replay, channel runtime, and security eval lanes.
- Status: `fixed, proven, and merged in PR #206 — automatic retry is limited to GET/HEAD; ambiguous mutations issue once, become manual-reconciliation-required, retain that structured state through Gateway delivery, and cannot enter durable retry`

#### Review-01 closure evidence

- Canonical ownership: HTTP redirect/retry authority is centralized in the policy engine; channel-delivery persistence and compare-and-swap transitions remain storage-owned; Gateway and MCP layers project the canonical structured outcome without reclassifying an unknown external write as blocked, retryable, or successful.
- Redirect and generic HTTP proof: same-origin and cross-origin redirect matrices cover credentials, caller-derived headers, methods, bodies, allowlists, one-shot fetch behavior, response-body limits, and post-send failures. Automatic retries are limited to GET/HEAD; mutation responses and exceptions after dispatch carry `externalOutcome=unknown_after_send` and `manualReconciliationRequired=true`.
- Channel proof: Slack, Telegram, WhatsApp, Gmail, calendar, generic channel sends, rich/multipart sends, and bounded-body failures preserve manual-reconciliation state and any known provider message ID. SQLite delivery claims and terminal transitions are lease-fenced across overlapping drains, independent runtimes, delayed losers, restarts, callbacks, and stale snapshots; no proven pre-send failure is mislabeled as externally ambiguous.
- MCP proof: `tools/call` is replayed only for an explicit server result declaring `phase=pre_dispatch` and `retrySafe=true`. Stdio and remote-HTTP post-dispatch transport failures, JSON-RPC errors, and `isError` results issue once and retain structured unknown/manual truth through diagnostics, realtime evidence, approvals, and the public response.
- Dual-dialect proof: the nullable lease compare-and-swap predicate uses dialect-correct PostgreSQL typing. The live disposable PostgreSQL suite passed 2/2 tests, including a null-lease CAS transition and a stale-snapshot attempt that could not overwrite a sent row/provider ID; the SQLite storage suite passed 694 tests with 2 intentional skips.
- Owning suites: Gateway passed 5,291 Vitest tests plus 17 Node tests; policy engine passed 627 tests; contracts passed 317 tests; storage passed 694 tests with 2 skips. Contracts, storage, policy-engine, and Gateway typechecks passed, as did zero-warning lint over every changed source/test file.
- Named proof: `verify:api:compat` (`2026-07-09T22-50-28-663Z-api-compat-08cd53f1`), `verify:channels:runtime` (`2026-07-09T23-25-22-112Z-agentic-channels-runtime-77c0f039`), `verify:runtime:truth` (`2026-07-09T23-25-22-065Z-runtime-truth-a47c084a`), `verify:mcp:conformance` (6/6), and `verify:security:evals` (`2026-07-09T23-25-22-065Z-security-evals-f5c4ada1`) passed on the final source.
- Broad proof: `docs:check` passed; `verify:fast` passed as `2026-07-09T23-25-53-533Z-fast-9ebfbb57`. The architecture guard initially rejected 29 new facade lines; the logic was moved into the existing channel-delivery helper owner, leaving GatewayService at the verifier's authoritative 8,292 lines (43 below the 8,335 baseline), 900 typed host callbacks (zero delta), and a passing `2026-07-09T23-25-22-060Z-architecture-metrics-76332783` artifact without a baseline ratchet.
- Hosted merge proof: PR #206's final head `1bbf7e4504a856a5f9e02d07223c66e28321febf` passed hosted fast verification (including fresh production coverage, real PostgreSQL, and artifact-redaction gates), JavaScript/TypeScript, C#, and Actions CodeQL, lint, Trivy, and both Code Mode canaries. Every automated review thread was rechecked and confirmed addressed before squash merge `4df18536833a453c0e31f3a164c8d988abb14bc4`.
- Hosted-review closure: automated review found three adjacent boundary errors and each was reproduced with a failing regression before correction. Safe attachment/preflight GET responses could falsely mark a later pre-dispatch failure as an ambiguous channel mutation; request tracking now accumulates mutation-started and mutation-response boundaries separately. Explicit MCP `pre_dispatch` truth could be overridden by expired-session wording; that phase is now authoritative and is not projected as unknown/manual. An already-aborted `http.post` could reach fetch and become unknown; it now exits before dispatch, while a paired abort-after-fetch regression remains `unknown_after_send`. Attachment 404s, response-stream failures, and pre-dispatch policy blocks remain `not_available`/`blocked`, while successful upload followed by a later attachment failure remains manual. The boundary suites, the 25-test channel-failure suite, and the full owning suites passed.
- Independent closure: three adversarial passes and a post-review boundary re-review separately returned safe-to-merge verdicts after testing redirected mutation authority, delayed delivery losers, stale-runtime fencing, provider-ID retention, nullable PostgreSQL predicates, MCP replay, preflight-versus-mutation boundaries, and adjacent failure paths. Their only shared residual proof caveat was live PostgreSQL execution; the 2/2 live PostgreSQL run above closed it before publication.

### FR-103 — Inline secrets cross storage, API, approval, audit, and model boundaries

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: key-pattern-only scrubbing in `tool-security.ts`; raw approval/tool arguments and URLs in orchestration evidence; approval-explainer prompts; raw integration connection configs returned by generic APIs; A2A bearer tokens stored directly.
- Reproduction: a webhook URL containing `key`/`token`, a short bearer value, and `DATABASE_PASSWORD` produced no detections, survived sanitization, and could enter the explainer request.
- Root cause: executable configuration, persisted evidence, and public/model DTOs share raw objects; redaction is neither key-aware enough nor URL/string-aware.
- Fix: reject inline secrets where secret references are required, introduce sanitized public/evidence/model projections, migrate persisted credentials forward to secret references, and preserve only resolvable references in executable state.
- Focused proof: storage/API/explainer redaction regressions; broad proof: artifact redaction, auth matrix, migration parity, and channel/A2A lanes.
- Status: `in progress — review-02 delivered broad response/model/evidence containment; review-03 removes remote-approval plaintext bearers from durable state and scrubs historical rows, but the remaining forward secret-reference migration and secondary public-surface queue keep FR-103 open`

#### Review-02 containment scope and evidence

- Canonical ownership: contracts own context-aware structured/text redaction; the Gateway owns detached public/model projections and URL/argv/schema-specific shapes; storage/runtime owners retain raw executable state only where execution still requires it. Public projections never mutate service or repository objects.
- Response/model containment: approval REST/explainer/connector delivery, Chat threads/messages/streams/delegation/workbench execution, durable/orchestration/session/runtime exports, direct tool invocation, retained realtime, integrations/channels/hooks/comms, MCP, provider/settings/local-runtime status, agent/skill provenance, capability proposals/candidates/Code Mode, cron/Observe, A2A HTTP/JSON-RPC/gRPC/push, audit, evidence envelopes, and generated/tool artifacts now have regression-backed projection boundaries.
- Editable projections: integration/channel/hook settings, MCP argv/URLs/policy, llama.cpp command/args, provider request auth/headers/proxy/TLS/base URL, and cron config/output round trips restore only the current record's hidden leaves. Stable-ID arrays preserve per-record identity; ambiguous or moved markers fail closed; explicit empty arrays remain explicit. One-time auth, SSE, device/session, vault reveal, OAuth, remote-approval, and realtime-voice issuance responses remain intentionally unprojected.
- Truthful artifacts: newly stored evidence metadata is sanitized before hashing/writing. Legacy evidence and Code Mode/tool/generated-artifact reads are projected without rewriting the canonical bytes; additive `publicProjection` metadata states when content changed and that canonical hashes refer to stored artifacts.
- Realtime approval recovery: retained/list/default events contain no action token. Only an exact approval-resolution live event can carry the one-time browser token, and only to an operator-authenticated or direct loopback SSE subscriber; replay/live overlap prefers that authorized transient copy. Operator-only token reissue remains the reload/recovery path.
- Regression-first closure: every confirmed sink received a failing regression before its canonical projector/reconciliation fix. The first adversarial pass covered real image `b64Json`, settings GET-to-PATCH restoration, signed evidence manifests, schema-aware capability projection, context-manifest hash semantics, Chat metadata marker movement, and one- versus multi-tag reorder behavior. The final follow-up pass then reproduced and fixed cross-chunk secret reconstruction, stale-attempt writes/finalization, incomplete stream-codec variants, authorization scheme-plus-credential argv, duplicate-flag marker rebinding, cancellation unhandled rejection, and terminal-cancel compatibility during the 30-second retained-registration window. Hosted production coverage exposed one final proof/runtime-boundary regression: the token-aware realtime wrapper had bypassed EventEmitter's synchronous listener validation, allowing the reflective coverage sweep to register non-functions that crashed only during shutdown. Boundary validation and a publish-after-rejection regression now close that path.
- Stream projection closure: the canonical redactor passed 41 focused cases and the stateful stream projector passed eight exhaustive cases. An independent split-point harness exercised 4,598 boundaries across 135 credential/header/YAML/collection/Unicode/CLI/argv/raw-token cases with zero leaks or liveness failures; 1,201 cross-language safe-versus-secret code splits had zero safe-expression mutations or secret leaks. Canonical redaction stayed linear at 50k/100k/200k/400k inputs (42.6/84.1/163.2/328.4 ms), while the optimized projector processed 100,000 safe microchunks in about 220 ms and a 100,000-character unbroken safe chunk in about 5 ms on the review host.
- Runtime ownership and fidelity: `ChatTurnExecutionRegistry` now issues an immutable turn-and-registration-bound producer lease. Exact-lease write sequencing, completion, and close operations make last-registration-wins duplicate wakes fail closed without widening extracted-service hosts. Fresh retries remain live; pause/resume, user-input, retry, and lease-takeover continuations suppress unsafe partial text until a terminal chunk; stale producers cannot write errors, finalize durable state, or close a resumed stream. Stream codecs now round-trip `thinking_delta`, complete approval-governance fields, and `user_input_required` prompts.
- Editable projection closure: command/argv reconciliation covers `auth`, `authentication`, `authorization`, both proxy-authorization spellings, and `bearer` scheme pairs. It restores only the exact hidden raw slots, preserves safe sibling edits, and rejects duplicate credential-flag removal/reordering instead of rebinding a marker to a different secret.
- Owning suites on the final source: contracts 355/355; policy engine 630/630; storage 695 passed with 2 intentional skips; Gateway 5,454/5,454 Vitest tests plus 17/17 Node tests (5,471 total). Contracts, policy-engine, storage, and Gateway typechecks passed, as did strict zero-warning lint over every changed TypeScript file, formatting, and `git diff --check`.
- Security/data proof: artifact redaction passed 5/5 after every artifact-producing lane; auth matrix `2026-07-10T14-16-41-774Z-auth-matrix-7a1a3ce0`; security evals `2026-07-10T14-16-58-565Z-security-evals-57e99940`. The final fast lane refreshed repository hygiene at 118/118, including the six supply-chain posture cases.
- Runtime/integration proof: runtime truth `2026-07-10T14-17-08-009Z-runtime-truth-2b33d510`; refreshed realtime truth `2026-07-10T14-58-14-643Z-realtime-truth-4494a84f`; durable recovery `2026-07-10T14-17-58-911Z-durable-recovery-7b267550`; API compatibility `2026-07-10T14-18-28-647Z-api-compat-841fa057`; agentic contracts `2026-07-10T14-18-46-539Z-agentic-contracts-f133d06c`; agentic governance `2026-07-10T14-19-22-706Z-agentic-governance-17da9daa`; channels runtime `2026-07-10T14-21-23-018Z-agentic-channels-runtime-88608bc4`; MCP conformance 6/6; A2A full `2026-07-10T14-21-46-075Z-a2a-full-a9fd39c7`.
- Fresh coverage proof: collection `490a1aee-49b0-476e-9006-50f2b134d033` completed successfully from `2026-07-10T14:49:50.376Z` through `2026-07-10T14:55:50.079Z` against 1,409 source files. The production gate passed at 67.78% lines, 79.15% branches, and 89.65% functions versus 63%/45% required thresholds. The Gateway exercise completed its 2,322 reflective calls without a deferred-listener shutdown failure.
- Release/proof integrity: operator proof passed as `2026-07-10T14-20-30-919Z-operator-proof-730a54d6`. Refreshed architecture metrics passed as `2026-07-10T14-58-32-240Z-architecture-metrics-54f43164` with GatewayService at 8,289 lines and 896 typed host callbacks, four below the 900 baseline; no baseline ratchet was made. Final fast proof after the coverage correction passed as `2026-07-10T14-58-57-557Z-fast-9fbdc9a0`.
- Independent closure: the final read-only adversarial pass reran 131 focused lease, cancellation, continuation, provider-projection, settings, and codec tests; direct command/argv probes; Gateway typecheck; diff checks; and the architecture collector. After the hosted coverage correction, a second independent pass ran 15 realtime, approval-delivery, and events-route tests and re-proved redacted default delivery, exact-event privileged token delivery, retained/replay redaction, and idempotent wrapper cleanup. Both passes returned no remaining evidence-backed Review-02 blocker. Residual non-blocking risk is explicit: cross-process stale workers still rely on durable lease/CAS and external-side-effect idempotency, and future producer paths must continue passing the registry-issued lease.
- Review-02 local verdict: containment is safe for refreshed hosted exact-SHA checks; FR-103 intentionally remains open until the forward vault/secret-reference migration and residual sink queue are completed on subsequent serial branches.
- Residual FR-103 queue for the next security branch: forward vault/secret references and historical plaintext quarantine; memory structured metadata and maintenance output; Assembly/MatterGoat/prompt-pack/dev-verification model output; mesh replication payloads; legacy mobile audit reads; local-AI/onboarding/media/connector/voice/workspace structured diagnostics; remaining editable user-authored DTO round-trip review. These are confirmed containment gaps, not claims of closure or accepted risk.

### FR-104 — Approval effects can commit after the API reports failure

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: `approval-lifecycle-service.ts:649-689` commits resolution plus effects, then awaits fallible audit/realtime work; remote resolution consumes its token before the same fallible sequence; creation has the analogous post-commit path.
- Reproduction: inject audit failure after the transaction: the route returns 500 while the approval is resolved and its effect may execute; retry is then rejected as already resolved.
- Root cause: post-commit observability failure is represented as mutation failure, and HTTP-status-only idempotency finalization cannot distinguish commit state.
- Fix: durable audit/realtime outbox or explicit committed-result contract, with resumable remote-token claims and idempotency completion after committed mutations.
- Focused proof: post-commit failure injection; broad proof: approvals, remote resolution, durable recovery, auth matrix, and fast lane.
- Status: `fixed and proven on review-03 — canonical approval mutations commit with their events/effect envelopes; fallible follow-up work is leased and retryable; committed errors cannot revive an idempotency claim`

#### Review-03 approval commit-truth closure evidence

- Canonical ownership: generic, bulk, Chat-tool, Code Mode, device-access, improvement-activation, remote-token, and expiry paths now route approval resolution through the lifecycle or their explicit transaction owner. Approval state, linkage, events, pending-action state, wait reservations, remote-token invalidation, and durable effect envelopes commit together.
- Commit/result truth: audit and realtime delivery moved behind an idempotent observability effect lane with immutable predecessor ordering. A bounded post-commit settlement read returns a completed quick resume when the action worker finishes and otherwise reports the durable follow-up as pending; audit/realtime or settlement failure can no longer turn a committed approval into an HTTP-level retryable mutation. Approval, Chat-tool, device-access, remote-token, and tool-grant routes explicitly preserve committed idempotency state.
- Race and recovery proof: pending approvals, including never-polled device requests, are proactively expired. Operator resolution, expiry, duplicate remote claims, Code Mode terminalization, wait-run materialization, pending-action execution, improvement activation, and Chat cancellation/completion use transaction, lease, fingerprint, or compare-and-swap ownership instead of last-writer-wins state. Approval effect workers heartbeat leases, recover expired claims, and keep observability retryable without replaying an already executed action.
- Remote approval containment: raw `grat_...` bearers are generated only for one-time return/final transport hydration. Durable connector runs carry opaque token IDs plus OS-keychain references, reject raw bearers, bind opaque-ID resolution to the authenticated connector, enforce expiry at claim and dispatch, and retry protected-secret cleanup without replaying a successful external delivery. SQLite v139 and PostgreSQL v81 scrub historical durable, approval, audit, realtime, tool, and connector rows; frozen historical migration text was not modified.
- Chat commit truth: terminal cancellation/failure/completion uses status compare-and-swap ownership. Assistant message ingestion and the winning trace transition share the EventIngest transaction, so cancellation cannot leave a cancelled trace with a newly committed assistant response and late failure cannot overwrite another terminal winner.
- Focused and owning proof: the approval lifecycle/effect/remote-token/device/connector/Chat race suites passed. The final correction slice passed 16 Gateway files/301 tests and three policy files/215 tests; the complete policy suite passed 653/653, and the complete Gateway suite passed 5,563 Vitest tests plus 17 Node tests. Contracts remain 355/355, the complete storage suite and both-dialect PostgreSQL proof remain green, and contracts, gateway-core, storage, policy, and Gateway typechecks passed.
- Named proof on final source: auth matrix `2026-07-11T02-46-01-052Z-auth-matrix-79745047`; security evals `2026-07-11T02-46-23-300Z-security-evals-bce509c7`; API compatibility `2026-07-11T02-46-32-170Z-api-compat-0ee10ea4`; channels runtime `2026-07-11T02-46-57-105Z-agentic-channels-runtime-a36fb3a8`; runtime truth `2026-07-11T02-47-24-683Z-runtime-truth-dad089f5`; durable recovery `2026-07-11T02-47-55-610Z-durable-recovery-3831e9cd`; realtime truth `2026-07-11T02-48-26-226Z-realtime-truth-6b68e63b`; agentic contracts `2026-07-11T02-48-52-572Z-agentic-contracts-b775e5c0`; agentic governance `2026-07-11T02-49-30-746Z-agentic-governance-c8339f4b`; operator proof `2026-07-11T02-50-39-288Z-operator-proof-a65467fa`; Code Mode sandbox `2026-07-11T02-51-26-828Z-code-mode-sandbox-48c7b96f`; agentic proof `2026-07-11T02-51-49-969Z-agentic-proof-9a3dcbb0`. MCP conformance passed 6/6, artifact redaction passed 5/5, and strict repository lint plus diff checks passed.
- Broad proof: `verify:fast` passed as `2026-07-11T02-40-51-767Z-fast-6f3467ae`. The final architecture rerun passed as `2026-07-11T02-36-58-208Z-architecture-metrics-238433d0` with GatewayService at 8,332 lines, 268 public methods, 58 internal methods, 885 typed host reads, and 274 Chat host reads; every metric is at or below the existing baseline, so no ratchet was widened.
- Independent adversarial closure: hosted review first exposed missing integration callback hydration, and the initial correction was rejected because it hydrated before policy/provider dispatch. The final design keeps browser hydration inside the authorized live realtime event and carries only a template plus keychain reference through integration durable state, channel queues, hooks, policy, approvals, audits, and replay. Only the native Telegram provider adapter may resolve the bearer, after exact template, secret-reference, connector, expiry, pending-state, enabled/connected, and currently resolvable authenticated-webhook checks. Slack, Discord, and other providers receive explicit Mission Control fallback text without a bearer. Whole-argument scans reject bare or wrapped `grat_...` values before and after hooks and at the native executor; protected tool names and complete argument records are immutable through mutating hooks; plugin overrides and approved external-runtime replay cannot handle protected templates; malformed durable templates fail closed. Telegram/Discord ingress and the public browser endpoint enforce connector binding. Keychain deletion precedes terminal expiry state, transient cleanup failures remain selectable for reconciliation, and unknown external outcomes never replay a possibly completed send. Two independent read-only adversarial passes returned no remaining confirmed Review-03 blocker. Residual risk remains explicit: keychain references are node-local across shared-PostgreSQL hosts; internal connector binding is optional for future callers even though every production ingress is currently bound; proof is distributed across composed boundary slices rather than one monolithic end-to-end test; legacy already-expired rows may require observation before cleanup retries; external backups and excluded audit-log files are not rewritten by the forward scrub.
- Review-03 local verdict: the branch is safe to publish for exact-SHA hosted checks. This closes FR-104, FR-117, FR-118, and FR-119; it does not close the overall full-codebase review or the remaining FR-103 queue.

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

### FR-116 — Safe demo bootstrap and install proof retain retired surface semantics

- Severity: `medium`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: the demo bootstrap still seeded separate Chat/Cowork/Code sessions while the canonical owner normalized every mode to Chat; a second bootstrap therefore accumulated five sessions instead of reusing one. The install verifier simultaneously required retired Cowork and Code primary-surface anchors.
- Reproduction: invoke safe demo bootstrap twice, then inspect canonical sessions and run `verify:install`; normalized sessions duplicate and the verifier asserts product semantics that no longer exist.
- Root cause: bootstrap identity and release proof were keyed to legacy input modes rather than the one-Chat canonical stored/runtime mode.
- Fix: seed one reusable Chat session, place agentic and governed code starter tasks inside Chat, return `/chat`, retain compatibility flags as false, and assert current product truth in install proof.
- Focused proof: demo route 9/9; broad proof: install smoke 7/7 and operator proof 3/3 on the final Review-02 source.
- Status: `fixed on review-02 — one canonical Chat demo session is idempotent and release proof no longer requires retired primary surfaces`

### FR-117 — Real PostgreSQL proof did not replay the complete migration ledger

- Severity: `high`; confidence: `high`; release tier: `test-harness/release-ops`; certainty: `confirmed`.
- Evidence: existing real-PostgreSQL tests constructed current schemas or exercised narrow migrator cases instead of applying every historical migration in order. A complete replay exposed PostgreSQL v79 SQL using the reserved alias `grant`, which the prior lane never parsed or executed.
- Reproduction: provision an empty PostgreSQL 16 database and apply migrations 1 through 80; v79 fails before current-head tests can run.
- Root cause: live database proof validated current behavior without proving that an actual historical database could traverse the full release ledger.
- Fix: add a disposable-PostgreSQL full-ledger test that applies versions 1–80, seeds representative historical plaintext rows, applies v81, and verifies the forward scrub; rename the v79 alias without changing historical schema semantics.
- Focused proof: complete-ledger PostgreSQL replay/scrub test; broad proof: real PostgreSQL suite, migration parity, storage typecheck, and fast lane.
- Status: `fixed and proven on review-03 — PostgreSQL 16 replays the complete ledger and the new forward scrub from an empty database`

### FR-118 — Remote approval bearers persisted beyond their one-time transport boundary

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: connector delivery payloads/checkpoints and adjacent approval/audit/realtime/tool rows could retain raw `grat_...` bearer values; opaque token-ID resolution did not require the calling connector; protected values could outlive expiry or terminal delivery.
- Reproduction: issue an interactive remote approval action, inspect the durable connector run and derivative rows, then resolve its opaque token ID from a different connector or leave it undispatched past expiry.
- Root cause: token generation, durable orchestration, transport hydration, connector authorization, and secret cleanup shared one raw DTO instead of an opaque-record plus protected-secret boundary.
- Fix: persist only token IDs, expiry metadata, and OS-keychain references; hydrate the bearer at the final browser/channel transport; bind opaque-ID claims to the connector; fail closed at claim/dispatch expiry; make cleanup retryable; reject raw durable bearers; scrub historical database rows with forward migrations.
- Focused proof: secret-store, connector-delivery, durable-run, opaque-claim, expiry, cleanup, and migration regressions; broad proof: auth matrix, artifact redaction, channels runtime, MCP conformance, migration parity, PostgreSQL, and security evals.
- Status: `fixed and proven on review-03 — the bearer is one-time response/final-transport data, not durable orchestration state`

### FR-119 — Chat terminal writers could commit mutually inconsistent winners

- Severity: `high`; confidence: `high`; release tier: `shipped`; certainty: `confirmed`.
- Evidence: cancellation, background failure, non-stream completion, and streaming completion patched the same trace without a terminal ownership compare-and-swap; assistant message ingestion and trace completion used separate transactions.
- Reproduction: pause immediately before assistant-message persistence, cancel the turn, then release completion; the assistant message could commit after the trace became cancelled, or a late failure/completion could overwrite a different terminal state.
- Root cause: abort checks were advisory snapshots and terminal state/message writes lacked one transactional owner.
- Fix: add repository status-CAS support and retrying cancellation ownership, preserve existing terminal winners, propagate non-NotFound ownership errors, and execute assistant-message upsert plus the winning trace transition inside one EventIngest transaction callback.
- Focused proof: cancellation/completion/failure race tests for streamed and non-streamed turns plus EventIngest rollback tests; broad proof: Gateway, durable recovery, realtime truth, operator proof, and fast lane.
- Status: `fixed and proven on review-03 — cancellation, failure, and completion cannot overwrite another terminal winner or split message/trace commit truth`

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
