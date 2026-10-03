# Mission Control Cockpit Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This file is the program index: every phase links to its own task-level plan, and each phase plan is self-contained.

**Goal:** Fix every finding from the 2026-09-27 UI/UX review in today's Mission Control, then replace it area by area with the approved "conversation cockpit" design.

**Architecture:** Phase 0 fixes the classic shell with logic placed in shared modules (`packages/mission-control-shared`, `packages/threaded-surface-core`) so the cockpit reuses it. Phase 1 adds a second shell inside `apps/mission-control-next`, chosen at boot by a local preference. The two shells never load each other's CSS. Phases 2 to 8 rebuild one area at a time in the cockpit, and Phase 9 makes it the default and later removes the classic shell.

**Tech Stack:** React 19, TypeScript 7 compiler, Vite, pnpm 10.31.0 workspaces, vitest, `node:test` for scripts, Playwright (verification lanes), Radix (`radix-ui`), `cmdk`, `react-virtuoso`, `sonner`, `vaul`, `lucide-react`. Tailwind v4 is already installed and is used only in the cockpit. `@tanstack/react-query` is added in Phase 1. The Gateway is Fastify (`apps/gateway`).

**Spec:** [`docs/superpowers/specs/2026-09-27-mission-control-cockpit-design.md`](../specs/2026-09-27-mission-control-cockpit-design.md)

## Global Constraints

Every task in every phase plan implicitly includes these.

- **Worktree per phase.** Create a worktree from the latest `origin/main`: `git fetch origin && git worktree add ../personal-ai-<phase> -b ux/<phase> origin/main`. Then run `pnpm install` and `pnpm --filter @goatcitadel/contracts build` before any package tests.
- **Shared checkout rules.** Never `git stash`, because `refs/stash` is shared across worktrees. Stage explicit paths only (never `git add -A` or `git add .`). Run `git rev-parse --abbrev-ref HEAD` and `git status --short` before every commit. Other sessions may be editing Chat files in the main checkout.
- **Commit format.** `<type>: <description>` with type feat, fix, refactor, test, docs, chore, perf, or ci. No attribution footer.
- **Test runs.** Never run vitest and `tsc` at the same time. Run vitest with `--maxWorkers=2` and filter by file path, not `-t`. Run `apps/mission-control-next` tests from that directory or through `pnpm --filter @goatcitadel/mission-control-next`. After changing `packages/contracts`, rebuild it before running package tests.
- **Gateway gates.** Never run `architecture:baseline:update`; the baseline is pinned. New Gateway services must pass `pnpm verify:gateway:async-boundary`.
- **Tracked files.** No personal filesystem paths (drive-letter paths, user home directories) in tracked files; `verify:repo:hygiene` rejects them. Line endings follow `.editorconfig`: LF, and CRLF for `*.bat`, `*.cmd`, `*.ps1`.
- **Dependencies.** The only new runtime dependency is `@tanstack/react-query` (Phase 1), pinned exactly (`--save-exact`). Any other new dependency needs operator approval first.
- **Copy rules.** Sentence case. No raw enum values, IDs, URLs, API paths, or stack traces in visible text. Status labels come only from `packages/mission-control-shared/src/presentation/status-vocabulary.ts` (created in Phase 0a). Errors come only through `describeApiError` (created in Phase 0a).
- **React rules.** Never disable `react-hooks/exhaustive-deps`.
- **File size.** Files are at most 400 lines for new cockpit code and new shared modules, and 800 lines elsewhere. When a task touches a file over 800 lines, it moves code out rather than adding to it.
- **Truth rules.** Mission Control stays an API client. No task changes runtime authority, policy, approvals, or Gateway truth, except the read-only Inbox projection in Phase 3.
- **Visual baselines.** Rebaseline once at the end of each phase with `gh workflow run visual-rebaseline.yml --ref ux/<phase>`. The workflow pushes PNGs to `chore/visual-rebaseline-<runid>` because it cannot open a PR. Cherry-pick that commit into the phase branch and delete the chore branch. One non-ratio failure discards every regenerated baseline, so fix those failures first.
- **Per-phase validation before the PR:**
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm verify:fast`
  - `pnpm docs:check`
  - `pnpm --filter @goatcitadel/mission-control-next build` then `pnpm --filter @goatcitadel/mission-control-next perf:check`
  - `pnpm verify:ux:budgets` (from Phase 0a on)
  - `git diff --check`

## Phase overview

| Phase | Plan | Branch | Depends on | Exit criteria |
| --- | --- | --- | --- | --- |
| 0a | [Shared fixes and guardrails](./2026-09-27-mc-phase-0a-shared-fixes-and-guardrails.md) | `ux/phase-0a` | none | `verify:ux:budgets` exists and runs; zero toasts after a cold load; no raw request errors or raw enums on the reviewed routes |
| 0b | [Chat and shell fixes](./2026-09-27-mc-phase-0b-chat-and-shell-fixes.md) | `ux/phase-0b` | 0a | Chat message area ≥60% at 1440×900 and ≥55% at 390×844; sidebar reaches the bottom; one failure presentation |
| 0c | [Pages, lists, and setup fixes](./2026-09-27-mc-phase-0c-pages-lists-and-setup.md) | `ux/phase-0c` | 0a | No "Details" disclosures; list rows have description, status tone, trust; trust list windowed; setup screen consistent |
| 0d | [Navigation and CSS system](./2026-09-27-mc-phase-0d-navigation-and-css-system.md) | `ux/phase-0d` | 0b, 0c | Settings in 7 pages; no area over 6 sub-pages; all old URLs redirect; 4 breakpoints; typography gate tightened; oversized files split; rebaselined |
| 1 | [Cockpit foundations](./2026-09-27-mc-phase-1-cockpit-foundations.md) | `ux/phase-1` | 0a (0d recommended) | Shell switch works both ways; cockpit skeleton with sidebar, Ctrl+K, inspector host, and phone tab bar; the gallery renders every primitive in both themes; the UX lane (including axe) passes on every cockpit route |
| 2 | Cockpit Chat (plan written when Phase 1 exits) | `ux/phase-2` | 1, 0d | Spec §7.7 parity gate met; budget met in both shells' lanes |
| 3 | Inbox and Gateway projection (plan written when Phase 2 exits) | `ux/phase-3` | 2 | Every kind in spec §8.1 listed and actionable; counts consistent in sidebar, phone, and toasts |
| 4 | Library catalog | `ux/phase-4` | 1 | One catalog with row anatomy and detail sheet; trust matrix and duplicate tool lists retired in the cockpit |
| 5 | Work | `ux/phase-5` | 2 | Board, history, schedules, run page |
| 6 | System | `ux/phase-6` | 1 | Health (problems first, fix actions), spend, quality, diagnostics, activity log, dashboards |
| 7 | Settings | `ux/phase-7` | 1, 0d | Seven pages built with cockpit primitives, plus settings search |
| 8 | First run | `ux/phase-8` | 7 | Fresh install to first answer in under 3 minutes (timed in a lane) |
| 9 | Cutover | `ux/phase-9` | 2–8 | Cockpit is the default; docs, contract, manifest, and README updated; classic removed one release later with its CSS |

Phases 2 to 9 each get their own task-level plan when the phase before them exits. They depend on primitives and seams that Phase 0d and Phase 1 create, and those plans will cite them by exact name. The scope and exit criteria below are fixed now.

## Phase 2 — Cockpit Chat (scope)

- **Controller reuse.** Build the Chat area on the hooks extracted from `MissionThreadedControllerHost` in Phase 0d. No second controller.
- **Timeline components:**
  - `UserMessage`, `AssistantMessage` with `ReceiptLine`, `RunCard`, `ApprovalCard`
  - `UserInputForm`, `FailureMessage`, `SystemLine`
  - adapters for today's rich content: citations, OpenCode result cards, document previews, Mermaid, code
- **Composer and inspector.**
  - A composer with a footer chip row; the `/`, `@`, and `$` palette and typed run-variable forms are kept.
  - Inspector sheets: Run, Turn, Sources, Context, Files, Thread.
- **Thread sidebar.** Project folders, recent threads, status dots, search, archived filter.
- **Phone.** Full-height conversation, docked composer, inspector as a bottom sheet.
- **Screenshot baselines.** A cockpit visual lane captures the gallery and Chat in both themes, on desktop and phone. It stores baselines separately from the classic manifest, so the classic governance checks are unaffected. The Phase 2 plan designs it after reading the current visual-regression lane.
- **Exit criteria.**
  - The spec §7.7 parity checklist is proven by component tests and a Playwright journey per item.
  - `verify:ux:budgets` passes Chat on the cockpit at both sizes.

## Phase 3 — Inbox (scope)

- **Gateway.**
  - An `InboxProjectionService` (read-only) with `GET /api/v1/inbox`, contract types in `packages/contracts`, and an `inbox.changed` realtime event emitted after the owning transitions commit.
  - Route and service tests; `verify:gateway:async-boundary`; the architecture-metrics gate kept green without touching the pinned baseline.
- **Cockpit.**
  - Inbox list and detail with the item anatomy and actions from spec §8, and J/K/A/E/D/O keyboard triage.
  - Press-and-hold for Nuclear; no "always allow" for Danger or Nuclear.
  - Chat `ApprovalCard` bound to the same items.
  - Toasts rendered from new Inbox items only.
- **Exit criteria.**
  - Every kind is covered by a seeded fixture in a Playwright journey.
  - The sidebar, phone tab bar, and toast counts come from the same endpoint.
- **Known constraints (2026-09-27 research):**
  - **Template:** use the route-service port pattern from `apps/gateway/src/services/sessions-list-route-service.ts`. Never add to `gateway-service.ts`, which is already 13,252 lines against the pinned 13,132.
  - **Gates to check first:** confirm `pnpm verify:architecture:metrics` status on `origin/main` before starting. The new service needs an operator-reviewed allowance in `scripts/verification/baselines/architecture-new-service-allowances.json`.
  - **Per-owner list endpoints the projection reads:**
    - `GET /api/v1/approvals?status=pending`
    - `GET /api/v1/change-plans?status=…`, one call per status
    - `GET /api/v1/memory/trace-candidates?status=proposed`
    - `GET /api/v1/chat/document-patch-proposals?state=pending`
    - `GET /api/v1/capabilities/proposals`
    - `GET /api/v1/improvement/curator-review`
    - `GET /api/v1/durable/runs` and `/durable/dead-letters` (filter out entries with `resolvedAt`)
    - user-input waits through `storage.chatTurnTraces.listActive`
  - **What the projection must compute itself:**
    - "Needs attention" items (backup verification, spend coverage) are computed in the UI today (`buildNeedsAttentionItems` in `RuntimeRoutePage.tsx`); the projection computes them server-side from the same sources.
    - Document proposals and specialist candidates emit no realtime events, so the projection polls or re-derives them on `inbox.changed` from related events.
  - **Resolutions available:** approvals can't have explanations requested, so the Inbox displays them only when present. Dead letters resolve only through recover.

## Phases 4 to 9 (scope)

- **Phase 4, Library:**
  - one catalog with type, status, and trust filters
  - rows with icon, name, one-line description, status, trust, and last used
  - a detail sheet with Overview, Policy, Usage, Source, and Settings tabs
  - trust and policy become per-item and filters
- **Phase 5, Work:**
  - a board with Running, Waiting on you, Failed, and Done
  - history that merges Sessions and Activity
  - schedules
  - `/work/runs/:runId` showing plan, steps, delegation tree, tools, approvals, files, cost, and worktree
- **Phase 6, System:**
  - Health, with problems first and a fix action on each
  - Spend, with the unknown-cost caveat explained once
  - Quality, Diagnostics, Activity log, and Dashboards
  - a health dot in the sidebar footer
- **Phase 7, Settings:**
  - the seven pages from spec §5.2 built from cockpit primitives
  - logic extracted from the classic sections (for example `ProvidersSection`) into shared hooks, not copied
  - settings search
- **Phase 8, First run:**
  - a three-step full-screen setup: choose models, send a test message, set the safety posture
  - one readiness model (from Phase 0c)
  - a timed lane from fresh install to first answer
- **Phase 9, Cutover:**
  - make the cockpit the default preference
  - update `docs/1_0_CONTRACT.md` (nav wording), `docs/1_0_RELEASE_SURFACE_SCOPE.md`, `scripts/verification/lib/release-surface-manifest.mjs`, and the README, satisfying `scripts/validate-governance-docs.mjs`
  - one release later, delete the classic shell, its CSS, and its baselines

## Tracking

- [ ] Phase 0a merged
- [ ] Phase 0b merged
- [ ] Phase 0c merged
- [ ] Phase 0d merged
- [ ] Phase 1 merged
- [ ] Phase 2 plan written and merged
- [ ] Phase 3 plan written and merged
- [ ] Phases 4 to 8 plans written and merged
- [ ] Phase 9 default flip
- [ ] Classic shell removed (one release after the flip)
