# GoatCitadel Latency, Speed, and Security Audit

Date: 2026-06-19

Scope: full repository static audit plus targeted local validation, focused only on latency, speed, and security.

## 1. Executive Summary

No fully exposed plaintext production secret was confirmed. A redacted secret-pattern scan found the known synthetic redaction fixture and token-shaped test values; the synthetic fixture is intentionally documented in `docs/security/findings-triage.md`.

This audit found and patched several high-impact issues:

- Stale PR-triggered verification workflows that previously exposed provider API secrets are no longer present on the rebased branch.
- File-backed transcript logs no longer derive file paths directly from user/session IDs.
- Generic inbound integration webhooks can no longer self-assign assistant/system provenance.
- `auth.mode=none` no longer silently accepts tailnet/private dev CORS origins by default.
- Installers now fail closed on lockfile mismatch unless an explicit local recovery flag is set.
- Example configs now keep sensitive self-improvement replay disabled by default.
- File-backed audit appends are serialized per stream and retention pruning is throttled.
- Loopback rate-limit exemption now rejects proxy-provenance requests.
- Embedding generation fan-out is bounded to reduce latency variance and provider pressure.
- Repo verification tooling now has a short temp-root path for `tsx`, current skill catalog coverage, repo-hygiene allowlists for intentional tracked templates, and the current protected Postgres migration hash.
- Existing `docs:check` failures were fixed.

Full local validation with `pnpm` available on `PATH` is now green, including frozen install, full tests, typecheck, build, `docs:check`, `verify:fast`, `dependency:risk`, `verify:security:evals`, `actionlint`, PowerShell parser validation, and `git diff --check`.

Provider audit-log review is still partially manual: GitHub metadata showed prior same-repo PR verification runs did execute the old secret-backed steps, but repo-level Actions secrets and repo environments are empty, and organization-level secret visibility is unavailable from this local token. Review provider consoles/org audit logs before release for the windows called out in section 12. Remote CodeQL also did not execute on PR #123 because GitHub Actions budget is preventing further use; rerun it after the budget block clears.

Final recommendation: do not merge yet; move to merge-after-review only after provider-console review and remote CodeQL rerun are complete. Do not release from this branch until those blockers and the remaining proposed hardening items are triaged.

## 2. Architecture Summary

GoatCitadel is a local-first AI operations console with a Fastify gateway as the runtime control plane. The gateway owns orchestration, approvals, policy enforcement, memory, integrations, audit trails, durable execution, and runtime APIs. Mission Control Next is the canonical client shell. Shared packages provide contracts, policy execution, storage, orchestration, memory, and UI/runtime API clients.

Primary runtime paths observed:

- Gateway entrypoints: `apps/gateway/src/main.ts`, `apps/gateway/src/app.ts`.
- Auth and request policy: `apps/gateway/src/plugins/auth.ts`, `apps/gateway/src/plugins/idempotency.ts`, `apps/gateway/src/deployment-profile-guard.ts`.
- Integrations and webhooks: `apps/gateway/src/routes/integration-webhooks.ts`, `apps/gateway/src/routes/integration-webhook-schemas.ts`.
- Tool and agent execution: `packages/policy-engine/src/tool-executor.ts`, `packages/policy-engine/src/engine.ts`.
- Storage and evidence: `packages/storage/src/*`, including audit, transcript, SQLite, Postgres, idempotency, and durable repositories.
- Frontend and native shells: `apps/mission-control-next`, `apps/mission-control-desktop`, `apps/mission-control-windows`.
- CI/deployment/install: `.github/workflows/*`, `Dockerfile`, `docker-compose.yaml`, `install.sh`, `install.ps1`, `scripts/packaging/*`.

## 3. Discovery Map

High-risk security files:

- `apps/gateway/src/app.ts`
- `apps/gateway/src/plugins/auth.ts`
- `apps/gateway/src/plugins/idempotency.ts`
- `apps/gateway/src/deployment-profile-guard.ts`
- `apps/gateway/src/routes/integration-webhooks.ts`
- `apps/gateway/src/routes/integration-webhook-schemas.ts`
- `apps/gateway/src/services/mcp-runtime.ts`
- `packages/policy-engine/src/tool-executor.ts`
- `packages/policy-engine/src/sandbox/network-guard.ts`
- `packages/orchestration/src/worktree-manager.ts`

Performance-critical hot paths:

- `apps/gateway/src/app.ts`
- `packages/storage/src/audit-log.ts`
- `packages/storage/src/chat-session-list-repo.ts`
- `packages/policy-engine/src/tool-executor.ts`
- `packages/policy-engine/src/ingestion-backends.ts`
- `packages/mission-control-shared/src/hooks/useApprovalQueue.ts`
- `apps/mission-control-next/src/features/native-routes/*`
- `apps/mission-control-desktop/src/main.ts`
- `apps/mission-control-windows/MainWindow.xaml.cs`

Config, secrets, deployment, and CI:

- `.github/workflows/verification-*.yml`
- `.github/workflows/release-installers.yml`
- `.github/workflows/publish-*.yml`
- `.github/secret_scanning.yml`
- `install.sh`
- `install.ps1`
- `Dockerfile`
- `docker-compose.yaml`
- `config/*.json`

Database, storage, persistence:

- `packages/storage/src/sqlite.ts`
- `packages/storage/src/postgres/*`
- `packages/storage/src/postgres-audit-log.ts`
- `packages/storage/src/postgres-transcript-log.ts`
- `packages/storage/src/audit-log.ts`
- `packages/storage/src/transcript-log.ts`
- `packages/storage/src/idempotency-repo.ts`

Network, API, tool, external-service boundaries:

- `apps/gateway/src/routes/*`
- `apps/gateway/src/services/*`
- `packages/policy-engine/src/sandbox/network-guard.ts`
- `packages/policy-engine/src/ingestion-backends.ts`
- `packages/policy-engine/src/tool-executor.ts`

Tests and validation:

- `apps/gateway/src/**/*.test.ts`
- `packages/storage/src/**/*.test.ts`
- `packages/policy-engine/src/**/*.test.ts`
- `scripts/verification/*`
- `scripts/check-*.mjs`

Docs that can affect operational safety:

- `docs/1_0_CONTRACT.md`
- `docs/CANONICAL_RUNTIME_STATE_MODEL.md`
- `docs/security/findings-triage.md`
- `docs/INSTALL_SETUP_TESTING.md`
- `.github/REQUIRED_CHECKS.md`

## 4. Threat Model

Main assets:

- Provider API keys, integration tokens, auth tokens, companion sessions, approval tokens.
- Operator transcripts, chat messages, memory items, tool payloads, audit evidence, code-mode artifacts.
- Local filesystem workspaces, worktrees, data directories, backups, and release artifacts.
- Gateway runtime authority over tools, providers, integrations, approvals, and durable execution.

Trust boundaries:

- Browser/origin to gateway.
- External integration webhooks to gateway.
- MCP/tool/plugin outputs to gateway and policy engine.
- User-controlled workspace paths to filesystem operations.
- Local runtime to Docker/native desktop/Windows launcher boundaries.
- GitHub PR code to CI secrets and package publishing.
- File-backed runtime state to Postgres cutover/import.

External inputs:

- HTTP API requests, webhook payloads, SSE/MCP HTTP responses, provider/tool responses.
- Config JSON, environment variables, installer scripts, GitHub workflow inputs.
- Local file paths, worktree paths, documents, archives, and generated artifacts.

Internal privileged operations:

- Tool execution, code-mode runs, browser automation, memory writes, external side effects.
- Approval resolution, integration sends, durable workflow resume, backup/restore, release signing.

Data flows:

- User/browser -> Mission Control -> Gateway -> storage/audit/realtime.
- External webhook -> signature/idempotency/host checks -> gateway integration ingestion -> transcript/session storage.
- Tool invocation -> policy engine -> network/filesystem/browser providers -> audit/evidence.
- Ingestion/memory -> chunking -> embeddings -> knowledge storage -> query/ranking.
- CI/release -> install/build/test/sign/publish artifacts.

Highest-impact abuse cases:

- PR code exfiltrates provider secrets from CI.
- Session IDs traverse out of transcript storage and write/delete arbitrary JSONL paths.
- Webhook sender forges assistant/system provenance to pollute transcript and audit truth.
- `auth:none` local dev CORS accepts private/tailnet origins controlled by an attacker.
- Installers refresh lockfiles during install and hide dependency drift.
- Unbounded audit/embedding/native polling paths create latency spikes or local denial of service.
- Remote MCP endpoint returns oversized bodies to cause memory and latency pressure.
- Release/publish workflows run from mutable refs/toolchains.

## 5. Top Findings, Prioritized by Severity

### F1: Stale PR verification workflows exposed provider secrets to PR code paths

- Severity: High
- Pillar: Security
- File path: `.github/workflows/verification-truth-lanes.yml`, `.github/workflows/verification-operator-proof.yml`, `.github/workflows/verification-agentic-code-mode.yml`
- Code path/function: verification lane steps
- Evidence: workflows triggered on `pull_request` and the same run steps injected `secrets.OPENAI_API_KEY`, `secrets.ANTHROPIC_API_KEY`, and other provider secrets.
- Real-world impact: internal or compromised PR code could run verification scripts with provider credentials available in the environment.
- Validation method: static workflow inspection; rebased workflow grep confirmed the stale files are absent and the remaining provider-secret release-proof workflow is tag/manual only with a `main`/version-tag job guard for manual dispatch.
- Recommended fix: keep provider-secret verification out of `pull_request` workflows; run live provider verification only from protected non-PR release proof contexts and guarded refs.
- Patch status: Applied through preserving current-main deletion of stale workflows during rebase and adding a release-proof manual-dispatch ref guard.
- Test status: `pnpm verify:workflows` passed.

### F2: File-backed transcript log path traversal by session ID

- Severity: High
- Pillar: Security
- File path: `packages/storage/src/transcript-log.ts`
- Code path/function: `TranscriptLog.appendInternal`, `read`, `delete`
- Evidence: code joined `transcriptsDir` with `${sessionId}.jsonl`.
- Real-world impact: a malicious or corrupted session ID containing `../` could write, read, or delete JSONL files outside the transcript directory.
- Validation method: static path review; added traversal regression test.
- Recommended fix: derive safe filenames for unsafe IDs and assert resolved paths remain under the transcript root.
- Patch status: Applied
- Test status: Added

### F3: Generic inbound webhooks could self-assign assistant/system provenance

- Severity: High
- Pillar: Security
- File path: `apps/gateway/src/routes/integration-webhook-schemas.ts`, `apps/gateway/src/routes/integration-webhooks.security.test.ts`
- Code path/function: `channelInboundSchema` -> `ingestChannelMessage`
- Evidence: generic channel payloads accepted optional `actorType` and `role`; gateway ingestion uses those fields when present.
- Real-world impact: a signed/allowlisted generic inbound sender could make external content look like assistant or system-originated transcript content.
- Validation method: regression test failed before patch and passed after removing the fields.
- Recommended fix: do not accept provenance fields from generic external inbound payloads.
- Patch status: Applied
- Test status: Added

### F4: `auth:none` local dev could be widened by default private/tailnet CORS

- Severity: High
- Pillar: Security
- File path: `apps/gateway/src/app.ts`, `apps/gateway/src/deployment-profile-guard.ts`
- Code path/function: `resolveAllowTailnetDevOrigins`, CORS origin callback, `assertAuthNoneExposureSafety`
- Evidence: non-production default enabled tailnet/private dev origin acceptance; the startup guard only rejected explicit tailnet opt-in for auth-none.
- Real-world impact: an accepted private/tailnet dev origin could call a no-auth local gateway from browser context.
- Validation method: static trace plus startup guard regression test.
- Recommended fix: default tailnet/private dev origins to disabled and reject auth-none when they are enabled unless the explicit insecure local override is set.
- Patch status: Applied
- Test status: Added

### F5: Installers relaxed lockfile integrity and docs recommended pipe-to-shell

- Severity: High
- Pillar: Security
- File path: `install.sh`, `install.ps1`, `docs/INSTALL_SETUP_TESTING.md`
- Code path/function: dependency install recovery
- Evidence: frozen install failure retried with `--no-frozen-lockfile`; docs included `curl | bash` and `iwr | iex` from mutable `main`.
- Real-world impact: dependency drift could be accepted during install, and mutable remote script execution increases supply-chain risk.
- Validation method: static inspection; `bash -n install.sh` passed.
- Recommended fix: fail closed unless an explicit local recovery flag is set; remove pipe-to-shell recommendations.
- Patch status: Applied
- Test status: Existing/Not Applicable

### F6: Sensitive self-improvement replay enabled in shipped examples

- Severity: High
- Pillar: Security
- File path: `config/goatcitadel.example.json`, `config/private-beta.profile.example.json`, `config/cron-jobs.example.json`
- Code path/function: `self_improvement_weekly_replay`
- Evidence: one example disabled the job because it can send trace/tool payloads to an LLM without redaction, while two other shipped examples enabled it.
- Real-world impact: users starting from examples could opt into sensitive replay unintentionally.
- Validation method: static config comparison; JSON parse validation passed.
- Recommended fix: keep the job disabled in all examples/profiles until redaction and explicit opt-in are enforced.
- Patch status: Applied
- Test status: Not Applicable

### F7: Audit retention pruning was an O(n) append hot path

- Severity: High
- Pillar: Speed, Latency, Security
- File path: `packages/storage/src/audit-log.ts`
- Code path/function: `AuditLog.append`, `pruneAuditStreamIfNeeded`
- Evidence: with `GOAT_AUDIT_RETENTION_DAYS` set, every append read and possibly rewrote the entire stream before appending.
- Real-world impact: busy audit streams can suffer latency spikes and concurrent append races can lose or reorder governed evidence.
- Validation method: static review; added concurrent append test and reran retention tests.
- Recommended fix: serialize per-stream appends and throttle retention compaction.
- Patch status: Applied
- Test status: Added/Existing

### F8: Loopback rate-limit bypass ignored proxy provenance

- Severity: Medium
- Pillar: Security, Latency
- File path: `apps/gateway/src/app.ts`
- Code path/function: `isLoopbackRateLimitAllowlisted`
- Evidence: allowlist used only `request.ip`; auth loopback bypass has stronger proxy provenance checks.
- Real-world impact: deployments behind a local reverse proxy could accidentally exempt remote clients from throttling.
- Validation method: unit regression plus full route rate-limit test.
- Recommended fix: reject loopback allowlist when forwarded headers, real IP headers, or multi-hop IPs are present.
- Patch status: Applied
- Test status: Added/Existing

### F9: Embedding generation fanned out unbounded work

- Severity: Medium
- Pillar: Speed, Latency
- File path: `packages/policy-engine/src/tool-executor.ts`, `packages/policy-engine/src/ingestion-backends.ts`
- Code path/function: `memoryWrite`, `embeddingsQuery`, `ingestDocumentViaBackend`
- Evidence: `Promise.all(chunks.map(generateEmbedding))` over up to hundreds/thousands of chunks.
- Real-world impact: local or remote embedding providers can be saturated, causing request latency variance and transient failures.
- Validation method: static review; added ordered concurrency helper test; policy-engine typecheck passed.
- Recommended fix: bound embedding work with ordered concurrency.
- Patch status: Applied
- Test status: Added

### F10: Remote MCP HTTP/SSE bodies are read unbounded

- Severity: Medium
- Pillar: Security, Latency
- File path: `apps/gateway/src/services/mcp-runtime.ts`
- Code path/function: `readHttpJsonRpcEnvelope`
- Evidence: code uses `await response.text()` before parsing JSON/SSE.
- Real-world impact: an allowlisted MCP endpoint can return a very large body and cause memory/latency pressure.
- Validation method: static review.
- Recommended fix: add `Content-Length` precheck plus streaming byte cap for JSON and SSE responses.
- Patch status: Proposed
- Test status: Needed

### F11: Native runtime polling can overlap launcher subprocesses

- Severity: High
- Pillar: Latency, Speed
- File path: `apps/mission-control-desktop/src/main.ts`, `apps/mission-control-desktop/src-tauri/src/main.rs`, `apps/mission-control-windows/MainWindow.xaml.cs`, `apps/mission-control-windows/Services/LauncherService.cs`
- Code path/function: runtime status polling
- Evidence: fixed 10s timers can trigger new launcher status checks without in-flight guards or subprocess timeouts.
- Real-world impact: slow launcher checks can stack subprocesses and degrade desktop responsiveness.
- Validation method: static trace.
- Recommended fix: self-schedule after completion, add in-flight guard, and enforce subprocess timeout/cancellation.
- Patch status: Proposed
- Test status: Needed

### F12: Approvals queue fetches unbounded history on recurring refresh

- Severity: High
- Pillar: Latency, Speed
- File path: `packages/mission-control-shared/src/api/approvals.ts`, `packages/mission-control-shared/src/hooks/useApprovalQueue.ts`, `apps/mission-control-next/src/features/native-routes/ops/ApprovalsRoutePage.tsx`
- Code path/function: approval queue refresh/render
- Evidence: hook fetches pending/approved/rejected/edited without visible limits and renders all visible items on recurring refresh.
- Real-world impact: large approval history can slow Ops pages and increase gateway/client payloads every refresh.
- Validation method: static inspection.
- Recommended fix: add lane limits/cursors, lazy-load history tabs, and virtualize long lanes.
- Patch status: Proposed
- Test status: Needed

### F13: Native route lazy chunk co-loads unrelated screens

- Severity: Medium
- Pillar: Latency
- File path: `apps/mission-control-next/src/app/lazy-legacy-pages.tsx`, `apps/mission-control-next/src/features/native-routes/NativeRoutePages.tsx`
- Code path/function: Mission Control route lazy imports
- Evidence: one native route chunk imports Projects, Cowork, Ops, and Library pages; existing built chunk observed near 398 KB raw / 103 KB gzip.
- Real-world impact: first navigation to native routes loads unnecessary UI code.
- Validation method: static import graph and existing dist asset observation.
- Recommended fix: split route chunks by section/page and prefetch intentionally.
- Patch status: Proposed
- Test status: Needed

### F14: Projects first paint pulls large data sets

- Severity: Medium
- Pillar: Latency, Speed
- File path: `apps/mission-control-next/src/features/native-routes/projects/ProjectsRoutePage.tsx`
- Code path/function: Projects route initial load
- Evidence: initial load requests up to 300 projects, 1000 sessions, and 1000 artifacts, then maps/scans them client-side.
- Real-world impact: large workspaces can suffer slow first paint and high memory use.
- Validation method: static inspection.
- Recommended fix: server summary endpoint, lower initial limits, pagination, and virtualization.
- Patch status: Proposed
- Test status: Needed

### F15: Tauri iframe/navigation policy is weaker than Windows

- Severity: Medium
- Pillar: Security
- File path: `apps/mission-control-desktop/index.html`, `apps/mission-control-desktop/src/main.ts`, `apps/mission-control-desktop/src-tauri/src/main.rs`
- Code path/function: runtime URL display and iframe navigation
- Evidence: iframe lacks sandbox; URL assignment accepts launcher target URL; CSP allows broad loopback frames.
- Real-world impact: malformed or compromised launcher output could navigate the WebView to a broader local target than intended.
- Validation method: static comparison with Windows `NavigationPolicy`.
- Recommended fix: centralize URL validation, reject userinfo, restrict ports, add iframe `sandbox` and `referrerpolicy`, align CSP.
- Patch status: Proposed
- Test status: Needed

### F16: Postgres audit/transcript sequence allocation can race

- Severity: Medium
- Pillar: Speed, Security
- File path: `packages/storage/src/postgres-transcript-log.ts`, `packages/storage/src/postgres-audit-log.ts`
- Code path/function: event sequence allocation
- Evidence: plain transactions use `SELECT MAX(event_sequence)+1`; concurrent writers can collide on unique constraints.
- Real-world impact: multi-process/shared-host Postgres can fail inserts under concurrent evidence writes.
- Validation method: static SQL review.
- Recommended fix: sequence table with `UPDATE ... RETURNING`, advisory locks, or serializable retry.
- Patch status: Proposed
- Test status: Needed

### F17: Chat session search uses unindexed `%LIKE%`

- Severity: Medium
- Pillar: Speed, Latency
- File path: `packages/storage/src/chat-session-list-repo.ts`
- Code path/function: session search/list query
- Evidence: query searches message content and JSON tag text with `%LIKE%`; indexes cover session/time but not text search.
- Real-world impact: large chat history can cause slow session list/search responses.
- Validation method: static query/index comparison.
- Recommended fix: SQLite FTS and Postgres `tsvector`/trigram indexes; normalized tags.
- Patch status: Proposed
- Test status: Needed

### F18: Docker runtime image copies builder workspace and uses Vite preview

- Severity: Medium
- Pillar: Security, Speed, Latency
- File path: `Dockerfile`, `scripts/docker-start.mjs`
- Code path/function: container runtime image/start
- Evidence: runtime stage copies broad builder workspace and starts UI through Vite preview/dev dependencies.
- Real-world impact: larger attack surface, larger image, slower cold starts.
- Validation method: static Docker review.
- Recommended fix: copy only runtime dist/assets/production dependencies and serve static UI with a minimal production server.
- Patch status: Proposed
- Test status: Needed

### F19: Release signing path depends on mutable toolchain inputs

- Severity: Medium
- Pillar: Security
- File path: `.github/workflows/release-installers.yml`
- Code path/function: release installer workflow
- Evidence: floating installer tools/actions and `pnpm dlx` SBOM tooling.
- Real-world impact: signed release artifacts can vary with mutable upstream toolchains.
- Validation method: static workflow review.
- Recommended fix: pin action SHAs/tool versions/digests and protect signing jobs with GitHub environments.
- Patch status: Proposed
- Test status: Needed

### F20: Manual package publish workflows lack ref/tag guard in YAML

- Severity: Medium
- Pillar: Security
- File path: `.github/workflows/publish-contracts.yml`, `.github/workflows/publish-extensions-sdk.yml`
- Code path/function: manual package publish jobs
- Evidence: `workflow_dispatch` plus package write/publish behavior without visible ref or tag validation.
- Real-world impact: accidental or compromised manual dispatch can publish from the wrong ref.
- Validation method: static workflow review.
- Recommended fix: require protected environment approval and validate ref matches package version/tag before publish.
- Patch status: Proposed
- Test status: Needed

### F21: Mutable container image tags

- Severity: Medium
- Pillar: Security
- File path: `Dockerfile`, `docker-compose.yaml`, `.github/workflows/verification-fast.yml`
- Code path/function: base image/runtime service images
- Evidence: tag-based `node:22-bookworm-slim` and `postgres:16-alpine`.
- Real-world impact: builds can change without source changes.
- Validation method: static grep.
- Recommended fix: pin image digests and update via dependency automation.
- Patch status: Proposed
- Test status: Needed

### F22: Token-shaped test fixtures outside narrow secret-scan allowlist

- Severity: Medium
- Pillar: Security
- File path: `.github/secret_scanning.yml`, `apps/gateway/src/routes/integrations.slack-oauth.test.ts`, `apps/gateway/src/routes/citadels.test.ts`
- Code path/function: test fixtures
- Evidence: redacted scan found provider-token-shaped strings outside the documented synthetic fixture path.
- Real-world impact: noisy secret scanning and risk of normalizing realistic token shapes in tests.
- Validation method: redacted regex scan; no real secret confirmed.
- Recommended fix: replace with obviously fake non-provider-shaped strings or move deliberate fixtures under an allowlisted fixture path with triage notes.
- Patch status: Proposed
- Test status: Needed

### F23: Worktree removal package boundary lacks root guard

- Severity: Low-Medium
- Pillar: Security
- File path: `packages/orchestration/src/worktree-manager.ts`
- Code path/function: `WorktreeManager.remove`
- Evidence: `create` has containment checks but `remove` trusts the caller path; current gateway caller checks first.
- Real-world impact: future direct package callers could remove arbitrary Git worktrees.
- Validation method: static package/caller review.
- Recommended fix: duplicate root containment guard inside `remove`.
- Patch status: Proposed
- Test status: Needed

## 6. Validated Security Issues

Validated and patched:

- F1 PR workflow secret exposure.
- F2 transcript path traversal.
- F3 generic webhook provenance spoofing.
- F4 auth-none private/tailnet CORS exposure.
- F5 installer lockfile refresh and pipe-to-shell docs.
- F6 self-improvement replay enabled in examples.
- F8 loopback rate-limit proxy provenance.

Validated but not patched in this pass:

- F10 remote MCP unbounded response bodies.
- F15 Tauri iframe/navigation policy gap.
- F16 Postgres event sequence race.
- F18 Docker runtime breadth.
- F19 release mutable toolchain.
- F20 manual publish ref guard.
- F21 mutable container images.
- F22 token-shaped test fixtures.
- F23 worktree remove guard.

## 7. Validated Speed Issues

Patched:

- F7 audit retention pruning on every append.
- F9 unbounded embedding fan-out.

Validated/proposed:

- F11 overlapping desktop/native runtime status polling.
- F12 unbounded approval queue refresh.
- F14 Projects initial large data load.
- F16 Postgres sequence race under concurrent writes.
- F17 unindexed chat search.
- F18 Docker image/startup inefficiency.

## 8. Validated Latency Issues

Patched:

- F7 audit append hot path.
- F8 rate-limit proxy provenance prevents accidental abuse of latency-sensitive routes.
- F9 embedding backpressure.

Validated/proposed:

- F10 remote MCP body-size cap.
- F11 native runtime polling in-flight guard and timeout.
- F12 approval queue pagination/virtualization.
- F13 route chunk split.
- F14 Projects summary/pagination.
- F17 text search indexing.

## 9. Concrete Patches Applied

- Preserved current-main deletion of three stale provider-secret PR verification workflows during rebase.
- Added a manual-dispatch ref guard to the provider-secret release-proof workflow.
- Added `pnpm verify:workflows` for actionlint plus tracked PowerShell parser validation and wired it into Verification Fast.
- Refreshed the active Code Quality workflow comment so it no longer claims Verification Fast is disabled.
- Removed `actorType` and `role` from generic inbound webhook schema.
- Added safe transcript filename derivation and root containment checks.
- Changed tailnet/private dev CORS default to opt-in and rejected it with auth-none.
- Added proxy-provenance rejection for loopback rate-limit allowlist.
- Disabled self-improvement replay in shipped examples/profiles.
- Made installers fail closed on lockfile mismatch unless `GOATCITADEL_INSTALL_ALLOW_LOCKFILE_REFRESH=1`.
- Removed pipe-to-shell install recommendations from setup docs.
- Serialized audit appends per stream and throttled retention pruning to once per stream per hour.
- Added `mapWithConcurrency` and bounded embedding work at concurrency 8.
- Fixed existing `docs:check` failures by adjusting literal button references and empty-catch comments.
- Added `GC-P2-13` parity status and provider-template count alignment for current contracts.
- Hardened gateway/path tests for portable path roots, artifact traversal, realpath-aware grant roots, and route-event SSE readiness.
- Updated repo verification tooling: short fast-lane temp roots for macOS `tsx` IPC paths, Citadel Mason skill catalog coverage, repo-hygiene allowlist for intentional tracked templates, redacted local QA source paths, and corrected the protected Postgres migration hash pin.

## 10. Tests Added or Updated

- `apps/gateway/src/routes/integration-webhooks.security.test.ts`: provenance spoofing regression.
- `apps/gateway/src/app.test.ts`: auth-none tailnet/private origin guard and proxy-provenance rate-limit guard.
- `packages/storage/src/transcript-log.test.ts`: unsafe session ID stays inside transcript root.
- `packages/storage/src/audit-log.test.ts`: concurrent audit appends preserve records/order.
- `packages/policy-engine/src/async-utils.test.ts`: ordered bounded concurrency.
- `apps/mission-control-next/src/features/threaded-surface/ThreadedBtwSideChatPanel.test.tsx`: jsdom/localStorage harness alignment.
- `packages/mission-control-shared/src/api/client-event-stream.test.ts`: cursor timer/window harness alignment.
- `scripts/verify-repo-hygiene.test.mjs`: intentional tracked ignored-file allowlist coverage.
- `scripts/verify-workflows.mjs`: actionlint and tracked PowerShell parser validation lane.

## 11. Commands Run

Discovery and inspection:

- `ls`
- `find apps packages -maxdepth 2 -name package.json`
- `sed` and `rg` over gateway, storage, policy-engine, desktop, workflows, config, installers, docs.
- Redacted secret-pattern scans excluding `.git`, `node_modules`, generated output, coverage, artifacts, reports, workspace data.
- Read `docs/security/findings-triage.md` before interpreting secret/CodeQL-style findings.
- Used subagents for workflow/PowerShell validation, GitHub Actions/provider-exposure history, and local CI-equivalent validation lanes.

Validation:

- Created a temporary `pnpm` wrapper on `PATH`; `pnpm -v`: passed, `10.31.0`.
- `pnpm install --frozen-lockfile`: passed; warning: `msw@2.13.2` build script remains ignored by pnpm.
- `pnpm test`: passed across the monorepo after rebase; gateway passed 564 Vitest files/3977 tests plus 17 Node tests.
- `pnpm typecheck`: passed after rebase.
- `pnpm build`: passed after rebase; Vite emitted the existing `node:crypto` browser-external warning for `packages/contracts/dist/citadel-vault.js`.
- `pnpm docs:check`: initially failed on pre-existing button/empty-catch checks; passed after fixes and passed again after rebase.
- `pnpm verify:fast`: initially failed on skill catalog coverage, repo hygiene, storage migration hash pin, and local `tsx` IPC path length; passed after fixes and passed again on the final tree (`artifacts/verification/2026-06-19T03-24-25-970Z-fast-0595063c`).
- `pnpm verify:workflows`: passed; actionlint passed and PowerShell parser validation passed for 3 tracked `.ps1` files.
- `pnpm verify:skills:catalog`: passed after adding `extra:citadel-mason` coverage.
- `pnpm verify:repo:hygiene`: passed after redacting QA local paths and allowlisting intentional tracked templates.
- `pnpm verify:storage:migration-parity`: passed after aligning the protected v3 hash pin with current migrations.
- `pnpm dependency:risk`: passed.
- `pnpm verify:security:evals`: passed (`artifacts/verification/2026-06-19T03-28-46-970Z-security-evals-5aa5118a`).
- `actionlint`: passed for workflows.
- PowerShell parser validation: passed for tracked `.ps1` files.
- `git diff --check`: passed.
- Focused gateway regression set: passed, 307 tests across 13 files.
- Full gateway package test: passed after rebase, 564 Vitest files/3977 tests plus 17 Node tests.
- `pnpm --filter @goatcitadel/contracts test`: passed.
- `pnpm --filter @goatcitadel/mission-control-shared exec vitest run src/api/client-event-stream.test.ts`: passed.
- `pnpm --filter @goatcitadel/policy-engine exec vitest run src/tool-executor-edges.coverage.test.ts src/tool-executor-loop20-branch.test.ts src/tool-executor-tail.coverage.test.ts src/tool-executor.test.ts src/sandbox/fetch-allowlisted.security.test.ts`: passed, 134 tests.
- `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/threaded-surface/ThreadedBtwSideChatPanel.test.tsx`: passed.
- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/tool-path-resolution.test.ts src/services/tool-path-resolution.loop20.test.ts`: passed.
- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/chat-workbench-service.test.ts src/services/chat-tool-artifact-service.test.ts src/services/prompt-pack-service.execution.test.ts`: passed, 66 tests.

## 12. Remaining Risks

- Provider audit logs still require human/provider-console review. GitHub Actions metadata showed prior same-repo PR runs executed the old secret-backed verification steps; repo-level Actions secrets and repo environments were empty, while org-level secrets were not inspectable with the local token. Review provider usage around 2026-06-17T23:51Z to 2026-06-18T00:01Z and the sampled late-May PR window before release.
- Remote CodeQL did not execute on PR #123 because GitHub Actions budget is preventing further use; rerun CodeQL after the budget block is cleared before treating remote security checks as complete.
- Audit append serialization is per `AuditLog` instance/process; cross-process file locking is still not implemented.
- Remote MCP HTTP/SSE body-size caps remain proposed.
- Native desktop polling, approvals pagination, route chunk splitting, Projects pagination, Docker runtime slimming, release signing pinning, publish guards, and Postgres event sequence retries remain follow-up work.
- Build still emits the existing Mission Control Next Vite warning about `node:crypto` in the contracts vault bundle; it did not fail CI but should be triaged before release hardening.
- `pnpm install --frozen-lockfile` still reports ignored build scripts for `msw@2.13.2`; this is expected under current pnpm policy, but release owners should keep the approved-builds posture deliberate.

## 13. Recommended Next Steps

1. Review provider-side usage/audit logs for the old PR verification windows before release.
2. Rerun PR #123 CodeQL after the GitHub Actions budget block is cleared.
3. Keep live provider verification limited to protected non-PR contexts.
4. Implement bounded HTTP/SSE response reading for remote MCP.
5. Add native runtime status in-flight guards and subprocess timeouts.
6. Add approval queue pagination/virtualization.
7. Add SQLite FTS/Postgres text indexes for chat search.
8. Pin release/toolchain/container inputs by SHA, digest, or exact version.
9. Add cross-process audit log locking or move governed audit evidence to DB-backed writes by default.
10. Triage the `node:crypto` Mission Control build warning and the pnpm ignored-build-script policy before release signoff.

## 14. Trade-Off Decision Memo

- Tailnet/private CORS opt-in improves security for auth-none local dev. Trade-off: users who relied on implicit private-network dev origins must set `GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS=true` and cannot combine it with auth-none without the existing explicit insecure-local override. Recommendation: accept.
- Lockfile install fail-closed improves supply-chain integrity. Trade-off: installer recovery is less automatic when manifests and lockfile drift. Recommendation: accept; the new env flag preserves deliberate local repair.
- Audit prune throttling improves append latency. Trade-off: expired audit rows may remain until the next hourly prune check. Recommendation: accept; retention is still enforced periodically and append hot paths stay bounded.
- Embedding concurrency improves stability and latency variance. Trade-off: very small ingests on high-capacity providers may complete slightly slower than unbounded fan-out. Recommendation: accept; bounded backpressure is safer for local-first runtimes.
- Removing/keeping live-provider verification out of PR workflows and guarding release-proof manual dispatch improves CI credential safety. Trade-off: live provider lanes can no longer be run from arbitrary branch refs and must run from `main` or version tags. Recommendation: accept.
