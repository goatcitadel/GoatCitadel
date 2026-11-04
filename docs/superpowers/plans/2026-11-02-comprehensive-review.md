# GoatCitadel Comprehensive Review and Remediation Plan

Goal: Find and fix confirmed bugs, incomplete shipped functionality, security weaknesses, UI/UX defects, and measurable performance problems across all maintained first-party code. This records the operator-approved chat plan and subsequent browser-errand handoff; the complete approved chat remains the specification.

## Constraints and execution

- Work only in the managed comprehensive-review-20261102 worktree. Preserve the primary checkout and every other worktree, process, credential, and user file.
- Initial pinned source: 7b4a8d9d77d1820aeb4a3adf5caeec21f7710c64 (main through browser errands PR 704). The three uncommitted primary PostgreSQL files are not included.
- Final baseline authorized by the operator: latest committed main, resolved to 7ec48bd6c4a1beb94b0a6b721a2aab5fd1882eef, including merged PR 705. The three uncommitted PostgreSQL files remain excluded. Branch codex/comprehensive-review-20261102 starts there; the already-published PR 706 patch is carried as uncommitted candidate work, with its original branch preserved.
- Astra planned; Sol 6.1 executes with parallel specialists and independent reviews. Read root/nested AGENTS, DESIGN, PRODUCT, runtime contracts, and security triage guidance.
- Latest handoff authorizes a branch and PR for four browser-errand follow-ups. Additional comprehensive-review changes remain separately tracked and unpublished unless subsequently authorized. Never merge or replace the daily install.
- Latest host constraint takes precedence over the original full-fast baseline: affected-file Vitest only, --maxWorkers=2, Gateway tests from apps/gateway, one heavy job at a time, no visible console windows. Record full-suite evidence as deferred, not passed.
- Keep runtime homes, browser storage, ports, databases and generated artifacts task-owned. Audit fixture/environment inheritance before invoking lanes. Use output-lock wrappers. Disable Husky only for worktree dependency installation; preserve shared Git configuration.
- No architecture baseline updates or new allowances. Existing owners remain under caps; gateway-service.ts <=13132 lines; new files have zero typed dependency reads.
- Preserve existing toolchain, API compatibility, denial/approval/path/auth boundaries and canonical durable authority. No speculative refactors or dependency churn.
- Execution clarification: this baseline already uses TypeScript 7.0.2 as the compiler and TypeScript 6 compatibility APIs for runtime/tooling, as documented in docs/typescript-7-compiler.md. Preserve that existing split; the chat plan's TS6-only label was stale. No TypeScript migration is part of this review.
- Security maintenance within the existing release toolchain: update Node 22.23.1 to the fixed 22.23.4 patch release for SEC-RUNTIME-001, then validate the candidate on that task-owned binary. Preserve the Node 22 release line and the installed host runtime.

## Task 1: Baseline, commit history, and evidence

- [ ] Inventory every first-parent commit from October 12 through the pinned final baseline; inspect diffs, merged branch changes, renames/deletions/reversions, dependencies and test baselines.
- [ ] Map each commit to intended behavior, owners, tests, and review disposition. Trace follow-ups into current source.
- [ ] Inventory every maintained app/package/script/native component/bundled capability/schema/workflow; prioritize recent changes without excluding unchanged first-party code.
- [ ] Reconcile older findings with fresh source. Preserve explicit source-reviewed, executed, blocked, and excluded-with-reason coverage.
- [ ] Every finding records ID, severity, trigger, expected/actual behavior, affected commit/file/function, confidence, evidence, regression, and disposition. Separate bugs, measured optimizations, suspicions, intentional limitations and roadmap.

## Task 2: Browser-errand handoff (first deliverable)

- [x] Write tests first for cleanup when connector.delivery completes after approval resolution or errand termination. Use a post-canonical-completion owner hook; clear only buttons, never approval state. Failures produce one bounded redacted warning.
- [x] Replace repeated inline screenshot base64 with a companion-only screenshot endpoint and digest-bound reference. Preserve approval-session ownership, exact SHA256, PNG, <=4 MiB and private,no-store. Keep line/page public-secret projection. Add negative authorization/scope/content tests and update the mobile contract note.
- [x] Investigate paired-phone initiation. Ordinary general_companion cannot send; separately provisioned session_control_client is not phone-origin support. Document required future authority/mobile work; add no new send route.
- [x] Reproduce Windows Discord inbound admission fake-provider fetch failure. Verify exact-file CI evidence. Fix demonstrated test or runtime cause, never skip/delete the test.
- [x] Run focused regression tests, Gateway tsc --noEmit, architecture metrics, Gateway async-boundary, no-empty-catch, docs checks, touched-file eslint, diff check, and independent review before publishing this scoped PR.

Completed in PR #706, commit 2f546295568f8eee517f8514539f44fb098784b5. The scoped verification manifest records 544 distinct focused tests plus 27 release-Node compatibility repeats. Remote Verification Fast remains separate pending evidence; this does not complete the broader review.

## Task 3: Comprehensive source and journey review

- [ ] Chat/durable: send/edit/retry/cancel/review/reconnect/reload/partial output, competing tabs, delegation/schedules, approval resume, leases/fences, duplicate effects and terminal truth.
- [ ] Capabilities/plugins/skills/Code Mode: callable versus inspectable, grants/scopes, activation, install/uninstall races, Change Plans, provenance/secrets, artifact hashes/replay and browser action policy.
- [ ] Providers/context/memory/research: API/subscription/CLI streaming and tools, cancellation/fallback/usage, readiness/reasoning, warm sessions, memory lifecycle and scope, immutable context replay, citations, uploads/documents/truncation.
- [ ] Security: local-first threat model, loopback origin/host/auth and exposed hosts, resource scope, approval expiry/binding, filesystem/symlink/write-root security, uploads/artifacts/SSRF/OAuth/redaction, untrusted input crossing authority. Verify current advisories for reachable dependencies.
- [ ] Integrations/MCP/channels/comms: guided setup to usable connection, saved keys, inbound verification, reconnect/requester scope/revocation, receipts/deduplication and ambiguous external effects. Fixtures only for real sends/calendar changes.
- [ ] Storage/realtime: dual-lineage SQLite/PostgreSQL migrations, transactions/indexes/cancellation/paging/outbox/retention/backups, stale projections, bounded reads and reconnect load. Review any later completed Claude migration work separately before incorporating it.
- [ ] Cockpit: complete visible journeys across Chat, Inbox, Work, Capabilities, Library, System, Settings, Projects and Messaging; keyboard/focus, dialogs, desktop/laptop/phone, both themes, streaming/scroll, large content, loading/error/empty/stale/recovery states and actual backend outcomes. Classic compatibility only.
- [ ] Desktop/workers/tooling: native lifecycle/WebView/update verification, worker enrollment/TLS/authority, Docker shutdown, packaging/supply chain, SDK, CI and test harness correctness; source-review platforms unavailable locally.

## Task 4: Reproduction and remediation

For each confirmed finding, define exact files/interfaces/expected behavior, write a meaningful failing regression (or visual before/after proof), implement the smallest owner-aligned fix, run focused checks and obtain independent review. Fix every confirmed severity including small UX defects; do not manufacture scope from roadmap or speculate about performance.

Cross-cutting scenarios: (1) authority revocation during waits; (2) cancellation/disconnect/crash between an effect and receipt; (3) workspace/session switching during reads/streams; (4) large/malformed/adversarial/partial inputs; (5) empty/upgraded/interrupted installs and unavailable providers/credentials.

## Task 5: Validation and measurements

- [ ] Record source digest, base/candidate identity, toolchain/OS/browser, dataset, cache state, provider/stub, background load, run ID, exit code, totals/failures/skips. No edits during source-bound proof. Explicit manifests, never mutable latest pointers.
- [ ] Select runtime-truth/durable/realtime/auth/governance/memory/context/migration/async/MCP/channel/capability proof lanes according to reviewed and changed owners and host-load constraints.
- [ ] Use a disposable task-owned PostgreSQL server for storage/auth/memory/inbox/recovery/async proof; no user DB. CHECKPOINT means a separate schema alone is insufficient.
- [ ] Browser surface/accessibility/visual/usability/Chat proof with screenshots, console/network diagnostics; Chromium and available Firefox/WebKit plus native WebView separately.
- [ ] Measure matched baseline/candidate startup/navigation/typing/send feedback/context/provider dispatch/stream rendering/cancellation, event-loop/SSE/idle requests/DB waits/memory and large lists. Three cold runs, repeated warm median/tail measurements, seeded large data and bounded sustained use. No improvement claims from noise or unlike background load.
- [ ] Preserve cockpit limits: 20 startup requests, 12 idle, 10 elsewhere-turn, 350000 initial gzipped JS bytes, CLS 0.10. Stub application timings are distinct from live-provider latency. Never weaken budgets, migration tripwires, coverage or visual baselines to turn failures green.
- [ ] Desktop/worker and redaction/docs/diff proof appropriate to changed owners. Classify harness/environment/product failures, and leave unexecuted full-fast/platform lanes explicit under the newer host constraint.

## Task 6: Packaged desktop and final handoff

- [ ] Build/run candidate with separate home/app directory/WebView storage/ports/fixture data; inspect startup/navigation/Chat/approvals/reload/shutdown/restart/history/error recovery.
- [ ] Existing connected subscription only: <=20 model requests total, including retries/children/review calls, cap enforced before dispatch. Synthetic prompts/task-owned files, no paid API fallback/external sends. No silent account reconnect if auth unavailable.
- [ ] Cover streaming, follow-up/edit/retry/cancel, harmless tool task and approval/resume within shared cap. Separate model refusal/quality from product failure.
- [ ] Independent complete-diff review; reconcile all findings/commits/coverage and rerun affected proof after final corrections.
- [ ] Stop only task-owned processes, verify ports freed, preserve worktree and artifacts. Report changes, measured results, proof, unresolved findings and blockers honestly.

Acceptance is packaged-runtime proof only. Real installer/upgrade/rollback, daily-profile cutover, Windows identity/protocol registration, real channel delivery and unavailable hardware/platform proof remain unverified. Never claim bug-free or release-certified.
