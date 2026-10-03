# Codex-inspired Chat display follow-up

Status: SD1–SD4 implemented and verified; SD0's pristine-checkpoint browser observations remain unfinished. The operator directly authorized starting SF6 in the main Chat on 2026-10-02 after committing all pending work. Checkpoint `67a32636f` contains those 25 pending files and passed its normal hooks, 393 focused Gateway tests, Gateway typecheck and docs checks. Direct commit and GitHub `main` publication were authorized on 2026-10-03. Current results, reproducible checkpoint/current parser-work counts, passing desktop/mobile lifecycle proof and broader lanes are tracked in the [implementation report](../reports/2026-10-02-sf6-chat-display-implementation.md).

Parent plan: [Codex follow-up improvements](2026-10-02-codex-followup-improvements.md), slice SF6. O1, the optional Codex app-server adapter, remains excluded. This work adapts display patterns to the existing browser UI; it does not introduce a second runtime or port the Rust terminal UI.

## Existing owners and source evidence

The checkpoint already had the following foundations. This owner inventory records the pre-change state; the implementation report describes the current fixes:

- `packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.tsx`: `StreamingMarkdown`, a memoized stable prefix and mutable tail, `splitIncremental`, fence tracking, reference-definition propagation, source-based copying, and safe link/code renderers. At the checkpoint, a new completed paragraph changed the single stable-prefix Markdown component's source; incremental boundary scanning alone did not establish that earlier Markdown blocks avoided reparsing.
- `AssistantMessageRenderer.incremental.test.tsx`: prefix equivalence, exact source reconstruction, turn/reset handling, streamed-versus-settled markup, fences, and reference links. Extend these tests instead of replacing them.
- `packages/mission-control-shared/src/state/chat-streaming-preview-store.ts` and the existing threaded-surface streaming controller: transient preview ownership. Keep incoming runtime events, UI animation, and canonical completion distinct.
- `apps/mission-control-next/src/cockpit/areas/chat/ChatTranscript.tsx`: selected-path turns, live preview, Virtuoso, follow-output behavior, canonical receipts, blockers, and existing source rendering.
- `ChatTurnDetails.tsx`, `ChatRunCard.tsx`, and the shared tool/run inspector components: expandable activity and runtime evidence. Do not recreate a parallel transcript-cell hierarchy.
- `chat-thread-reducer.ts` and Gateway-authored thread/turn/run APIs: reconciliation and canonical lifecycle truth. Rendering caches and a quiet event stream confer no execution authority.

Relevant upstream patterns inspected in the public Codex terminal UI:

- [ChatWidget](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/tui/src/chatwidget.rs): event-derived presentation state, committed history, and an active live cell.
- [Streaming controller](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/tui/src/streaming/controller.rs): stable/tail partitioning, table holdback, and explicit resize/finalization invariants.
- [Incremental renderer](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/tui/src/streaming/render.rs): retain completed top-level blocks and invalidate when references or other source-wide dependencies change.
- [History cells](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/tui/src/history_cell/mod.rs): compact/expanded activity, stable identity, source-based copying, and cache revision handling.

These links pin Codex `86a54b051c08f34f373c507ae16a91915ab08700`; the GoatCitadel baseline is `67a32636f`. The desktop app frontend is not established by these terminal sources. Similar architecture does not establish equivalent correctness or performance.

## Delivery order and acceptance

Deliver SD0–SD4 sequentially. Finish the current async-clarification proof and scoped checkpoint first. Re-read applicable AGENTS.md files and target files, inspect tracked and untracked work, and preserve the concurrent Cockpit navigation/settings changes. Do not reset the checkout to any comparison revision.

### SD0 — Crosswalk and measurable baseline

Inspect the owners above against pinned Codex sources. Identify concrete missing behavior or repeated work, and record satisfied requirements rather than rebuilding them. Establish deterministic parse/render counts and browser behavior for many completed paragraphs, an uninterrupted long line, a large code fence, a growing table, and tool activity during streaming. Separate boundary-scanning cost from Markdown parsing, syntax highlighting, React rendering, and layout work. Reuse current instrumentation or a bounded test fixture; do not add production telemetry merely for this review.

Acceptance **SF6-SD0**: a source/test crosswalk and reproducible baseline with actual results. Each subsequent change has a concrete failure or measured repeated-work justification. Existing equivalence tests remain authoritative evidence but are not a substitute for comparison with the settled Markdown parser.

### SD1 — Correct stable-block boundaries and mutable Markdown

Strengthen the existing splitter/renderer so content enters the stable region only when its top-level Markdown structure is settled. Reuse the installed Markdown parser and existing renderer; avoid a second approximate Markdown implementation. Keep incomplete tables, rows, fences, and any other transformable final block mutable. Make the first prose preview visible promptly without committing ambiguous Markdown or half-arrived link destinations. Adapt Codex's holdback principle to DOM layout rather than copying terminal column calculations.

Acceptance **SF6-SD1**: arbitrary chunk boundaries reconstruct the exact input; streamed final markup matches rendering the complete source. Cover pipe-table header/delimiter splits, partial rows, escaped pipes, tables inside and outside fences, lists/quotes containing blank lines, setext headings, backtick/tilde fences, and definitions arriving after references. No duplicated/dropped source, prematurely finalized block, partial destination link, or cross-turn parser leak. Preserve existing link restrictions and structured-block behavior. Record already-satisfied cases without duplicate fixes.

### SD2 — Retain completed blocks with precise invalidation

Replace repeated rendering of the entire growing stable prefix with individually retained completed Markdown blocks when SD0 proves that repeated work. Give retained blocks stable identities based on the turn and their source boundaries/revision; keep the live tail separately updated. Reuse existing memoization and highlighting owners. Invalidate only the affected blocks for late reference definitions or other source-wide dependencies, and reset on replacement/shrink, edit/retry, session/turn changes, or rendering-policy changes. Keep caches local and bounded with an explicit release/reset path. Preserve canonical raw Markdown for copying, artifact creation, and settled output.

Acceptance **SF6-SD2**: deterministic instrumentation proves that appending tail text or a new independent block does not reparse unaffected completed blocks. Late definitions update affected links correctly, and required full invalidation does not retain stale content. Copy-before-completion is clearly partial and copies exact source; completion copies exact final source. Stress a long answer and large fence/table, report before/after work counts and browser observations, and make no speed claim based only on the splitter's scan counter.

### SD3 — Stable compact activity and disclosure

Improve the current tool/run presentation with a compact summary of in-flight and completed activity and inspectable details where the current presentation lacks them. Reuse `ChatTurnDetails`, `ChatRunCard`, existing inspector actions, and Gateway-authored IDs/status/evidence. Preserve chronological identity as tool results arrive or canonical data refreshes; retain the operator's expanded/collapsed state for the same activity. Show actual failed, blocked, running, and uncertain states. Required questions, approvals, and secure setup remain visible and keep their existing interaction owners; optional questions continue to report that independent work is active. Do not expose raw payloads as the primary UI or label inferred activity as canonical completion.

Acceptance **SF6-SD3**: repeated refreshes and reordered delivery do not duplicate activity, move one tool's disclosure state to another, lose focus or question input, or erase failure/provenance information. Compact counts/statuses match the canonical records. Keyboard operation and restrained live announcements work. Keep already-functional disclosure behavior with evidence; add only missing presentation or identity fixes.

### SD4 — Lifecycle, viewport, and final proof

Exercise the combined display through production Chat owners: optimistic send, live deltas, canonical hydration/reconnect, completion, failure, interruption/cancellation, branch switching, and session switching. Reuse current preview-store and reducer reconciliation; add no shadow canonical state. Preserve stable turn/activity keys and the existing virtualized transcript. Keep the reader's scroll position while they inspect older content; follow the active response only under the existing follow-output preference. Make table growth, code highlighting, activity expansion, and viewport resizing behave without unintended jumps, horizontal page overflow, or displaced controls.

Acceptance **SF6-SD4**: focused tests plus a deterministic Gateway-backed browser fixture pass at desktop and narrow mobile widths. Prove exact final content, no stale live tail/duplicate answer after canonical reconciliation, no cross-session preview, stable manual-scroll position, correct bottom-follow behavior, reduced-motion behavior, retained disclosure/input, and usable composer/Stop/approval controls. Resize during table/fence streaming and inspect captured images; final and refreshed renders must agree. Use loopback provider fixtures only. Repeat deliveries/reconnect events through existing owners without treating retained signals as durable history.

## Validation and definition of done

Run focused shared renderer/splitter, preview/reducer, and Cockpit transcript/activity tests before broader lanes. Use deterministic render/parse counts for performance regressions; browser timings are observations, not universal thresholds. Use output-lock-protected affected-package typechecks and the repository's applicable surface, accessibility, visual, runtime-truth, and docs verification lanes. Do not rebaseline visuals automatically or bypass a live lock. Record every executed result, skip, and blocker by SF6 acceptance ID.

SF6 is complete only when the crosswalk, necessary bounded fixes, targeted tests, and combined browser proof are delivered, with evidence for satisfied requirements and exact unfinished IDs for blockers. Update the parent report with changed files, actual validation, compatibility/rollout, remaining limits, and final repository state. Keep experimental additions disabled by default; ordinary correctness fixes retain existing public behavior. Preserve Chat-first UX, Gateway/durable execution authority, approvals, deny-wins policy, capability grants, artifact/source provenance, Windows support, and explicit Classic rollback compatibility. No new dependency without demonstrated need. No stage/commit/push/deploy, live/paid-provider work, or operator configuration change beyond the active main thread's explicit authorization.
