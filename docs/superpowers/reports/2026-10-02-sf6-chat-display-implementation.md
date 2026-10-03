# SF6 Chat display implementation report

Status: SD1–SD4 implemented and verified; SD0 has one historical browser-baseline gap described below. The operator requested “commit whatever isn't committed yet, then start the sf6 display work.” The pending 25-file checkpoint is `67a32636f`; normal Prettier/ESLint hooks, 393 Gateway tests, Gateway typecheck and `pnpm docs:check` passed. The checkout was clean before SF6. On 2026-10-03, the operator explicitly authorized committing SF6 and pushing local `main` to GitHub. No deployment was requested or performed.

## SD0 source crosswalk and baseline

GoatCitadel baseline: `67a32636f`. Public Codex `main` was resolved with `git ls-remote` to **`86a54b051c08f34f373c507ae16a91915ab08700`**. The four referenced terminal sources were fetched at that exact revision. They establish terminal UI patterns; they do not establish the Codex desktop frontend's behavior.

| Requirement/pattern | Pinned Codex source | Existing GoatCitadel owner and action |
| --- | --- | --- |
| Completed blocks plus mutable final block | [streaming/render.rs](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/tui/src/streaming/render.rs#L130) | `AssistantMessageRenderer.tsx` had a memoized growing prefix, but reparsed it on each newly completed paragraph. Replaced the blank-line boundary heuristic with the same CommonMark/GFM parser ReactMarkdown uses, and retained individual ASTs in `streaming-markdown.ts`. |
| Transformable table/fence holdback | [streaming/controller.rs](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/tui/src/streaming/controller.rs#L12) | Existing tail and highlighting context reused. Keep the last top-level block mutable and require a completed opening line before using a later block as a boundary. DOM tables remain live; terminal column calculations were not ported. |
| Cache identity and committed versus active state | [chatwidget.rs](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/tui/src/chatwidget.rs#L795) | Existing preview store and reducer remain projections of Gateway records. Added session/turn keys to Virtuoso; renderer retention resets on replacement/shrink, turn or presentation-policy changes and unmount. |
| Original-source copy and compact inspectable activity | [history_cell/mod.rs](https://github.com/openai/codex/blob/86a54b051c08f34f373c507ae16a91915ab08700/codex-rs/tui/src/history_cell/mod.rs#L216) | Existing toolbar, `ChatTurnDetails`, `ChatRunCard`, diagnostics/effect-truth and run inspectors reused. Copy exact source, label partial copies, add truthful status counts/guidance, and retain tool identity/order through results and replay. |

`AssistantMessageRenderer.work-counts.test.tsx` instruments the installed Unified parser and ReactMarkdown wrapper. Identical 20-update fixtures were replayed against the checkpoint renderer and current renderer with `node scripts/verification/chat-markdown-work-counts.mjs 67a32636f`. The script reads the checkpoint through `git show` into an ignored test-only copy; it never resets or replaces the checkout. Each replay selected one measurement test and deliberately omitted the independent retained-block assertion; the full current suite runs both tests. Results are in `.tmp/sf6/replayed-work-counts.log`.

The new path includes its semantic-boundary grammar work. Feeding a retained AST to ReactMarkdown dispatches its parser interface but does not run the Markdown grammar again; instrumentation excludes that zero-input AST dispatch. These counts are separate from splitter scans, syntax highlighting and browser layout.

| Fixture | Final source characters | Before parses / parsed characters | After parses / parsed characters |
| --- | ---: | ---: | ---: |
| 20 completed paragraphs | 690 | 39 / 7,155 | 20 / 1,925 |
| Uninterrupted line | 2,560 | 20 / 26,880 | 20 / 26,880 |
| Growing large fence | 1,715 | 23 / 19,670 | 22 / 19,670 |
| Growing table | 401 | 21 / 4,465 | 21 / 4,465 |

| Fixture | Before Markdown wrapper renders / input characters | After Markdown wrapper renders / input characters |
| --- | ---: | ---: |
| 20 completed paragraphs | 39 / 7,155 | 38 / 1,925 |
| Uninterrupted line | 20 / 26,880 | 20 / 26,880 |
| Growing large fence | 23 / 19,670 | 22 / 19,670 |
| Growing table | 21 / 4,465 | 21 / 4,465 |

These are deterministic parsing-work counts, not speed claims. Long lines, open fences and growing tables still require parsing the mutable block. Existing `HighlightedCode.tsx` suppresses highlighting in the mutable tail and bounds settled highlighting; it is reused without modification. There is no production telemetry or global rendering cache.

## Implementation and targeted evidence

- **SF6-SD1:** implemented. Every character prefix of table delimiter/row, escaped pipe, fenced-table, backtick/tilde fence, loose/nested list, quote, setext heading and indented-code fixtures reconstructs the exact source and matches the settled parser's AST. Running DOM structure is compared with settled rendering before toggling `running` off. Incomplete reference definitions and bare URL destinations remain non-navigable. Existing safe links and structured/code renderers remain authoritative.
- **SF6-SD2:** implemented. Retain at most 512 completed blocks, with the remainder in the ordinary mutable tail. Reference dependency candidates are validated by the installed parser; only blocks that really depend on changed definitions are reparsed. Tests prove retained AST identity, first-definition precedence, multiline titles, escaped labels, unused-definition behavior and reset/release. Actual parser instrumentation proves tail/new-block appends exclude unaffected retained source. Copy tests verify exact partial and final source.
- **SF6-SD3:** implemented. Tool results replace their original slot rather than moving the call to the end. Replayed starts or approval waits cannot erase executed/failed/blocked results; approval-required calls can still resume to started. The final replay regression first failed because an approval wait replaced an executed result, then passed for all three terminal statuses after the fix (`replay-regression-before.log` and `replay-regression-after.log`). Canonical refresh still replaces state from its existing owner. Native disclosure, tool IDs, focus and question/approval owners are reused. Status summaries distinguish running/done/failed/blocked/approval-needed/needs-review/unknown; recorded effect uncertainty and failure guidance remain inspectable, without a live announcement on every refresh. Missing stream-signal risk metadata is hydrated through the existing approval API only from the matching pending canonical record. Missing, settled or unrelated records still leave approval unavailable; dangerous approval review remains with its existing owner.
- **SF6-SD4:** implemented and verified. The controllable loopback-provider fixture uses production default Cockpit, Virtuoso, durable Gateway execution and fresh disposable runtime/session state. Desktop 1440×1024 (resized to 900×760) and reduced-motion mobile 390×844 (resized to 360×640) both pass. Evidence covers partial/exact final copy, optimistic admission, streaming tables/fences and late references, real wheel scrolling while more content arrives, return-to-bottom follow, retained keyboard focus/disclosure, live reconnect, canonical refresh without duplicates, session isolation, retry/branch switching, approval and failed-tool handling, and canonical cancellation followed by refresh. Both Chat accessibility audits report zero violations.

Production browser runs exposed three concrete display defects: streaming-row layout could disable pinned follow, retained approval signals lacked risk metadata, and a long uninterrupted word was clipped. Fixes reuse the shared scroll/read owner and canonical approval API, preserve stable native listeners across callback refreshes, and add only prose wrapping/retained-block spacing CSS. Screenshots of live fences, approval/failure activity, completed answers and refreshed answers were inspected; composer/Stop/navigation remain usable, prose wraps at narrow widths, and code/table scrolling remains inside its existing boundaries. Final and refreshed semantic content and source agree; scroll position and transient copy-confirmation state can differ.

Earlier failing fixture runs are retained in ignored artifacts. Oversized chunks, secret-projector framing, ambiguous scroller locators and premature lifecycle assertions were corrected in the fixture; the production redaction boundary was preserved. Stop visibility alone is not treated as cancellation proof: the scenario polls the corresponding canonical cancelled turn before refreshing.

Current actual validation:

| Command/lane | Result |
| --- | --- |
| Focused shared renderer/parser/reducer/preview/media-query tests | 8 files, 67 tests passed |
| Focused Cockpit transcript/pending-question/composer/risk-action tests | 4 files, 44 tests passed |
| Focused threaded-core outbound/preview/streaming/orchestration/reducer tests | 5 files, 101 tests passed |
| Full `@goatcitadel/mission-control-shared` test suite | 165 files, 1,074 tests passed |
| Full `@goatcitadel/mission-control-next` test suite | 389 files, 3,310 tests passed |
| Deterministic provider fixture tests plus accessibility helpers | 26 passed, 0 skipped; includes all 19 provider fixture tests |
| Checkpoint/current parser-work replay | 1 selected measurement test passed per revision; 1 intentionally unselected per replay |
| Production-owner SF6 browser proof | 2 scenarios passed, 0 failed/skipped; desktop/mobile Chat axe audits: 0 violations |
| `pnpm verify:surface:regression` | 101 passed, 0 failed/skipped |
| `pnpm verify:runtime:truth` | 4 passed, 0 failed/skipped, including approval restart/durable resume |
| `pnpm verify:accessibility:smoke` | 8 passed, 0 failed/skipped; explicit Classic fixture scope, see limitation below |
| Scoped `pnpm verify:visual:regression` | 4 passed, 0 failed/skipped; Chat/Cockpit Chat × desktop/mobile dark, no rebaseline |
| Output-lock-protected shared/core/Next typechecks | passed |
| Cockpit `perf:check` | passed |
| Scoped ESLint on changed TypeScript and verification scripts | passed |
| `pnpm docs:check` | passed |
| `git diff --check` | passed |

The full shared and Next suites and all three affected typechecks were repeated after the final replay guard. The combined browser and final visual captures include the final scroll binding, approval hydration and wrapping/spacing CSS; the later replay-only guard is covered by focused reducer and full-suite tests. Logs are retained under `.tmp/sf6/`.

Publication checks on 2026-10-03: focused Chat transcript and Tailwind-isolation tests passed **2 files / 23 tests** with one worker; scoped ESLint, `pnpm docs:check` and Cockpit `perf:check` passed. The first focused run had a worker-startup timeout (only the two isolation tests ran); it is not counted as a passing transcript run. The first fresh browser rerun timed out waiting for Gateway health before any Chat assertions ran, with empty Gateway stdout/stderr. Its failed artifact is retained at `artifacts/verification/2026-10-03T13-53-06-343Z-usability-58afe2f5`; fixture cleanup released the output lock and Gateway port 58473. These failures do not establish a Chat assertion failure or a root cause for the startup delay.

The next browser run reached both Chat scenarios and caught a publication-preparation regression: the separate CSS import was bundled before Tailwind's layer-order declaration, putting the base reset above components and eliminating retained-paragraph spacing. Both scenarios failed that spacing assertion (`artifacts/verification/2026-10-03T13-59-51-824Z-usability-24c3a65c`). The Chat stylesheet now declares the same theme/base/components/utilities order before its component rules, preserving their original cascade precedence. No failed artifact was replaced or rebaselined.

After that fix, desktop passed the complete lifecycle and both viewports passed the spacing/wrapping checks; mobile timed out waiting for the tiny stalled cancellation prefix (`artifacts/verification/2026-10-03T14-04-11-308Z-usability-ea3a29bc`). The stream was running, with no console/network failure. The cancellation fixture now reuses the controlled-stream owner: a bounded first phase arrives in token-sized frames, with the next phase held until cancellation. Canonical cancellation and refreshed partial-source assertions remain mandatory; the production secret projector is unchanged.

Final publication browser proof passed **both desktop/mobile scenarios, zero failures or skips**, at `artifacts/verification/2026-10-03T14-08-00-494Z-usability-d4e462df`. This validates the separate stylesheet's cascade order, retained-paragraph spacing, long-word wrapping, the complete lifecycle and canonical cancellation after partial output. Desktop/mobile completed-answer screenshots were inspected again. Docs and scoped ESLint were also repeated successfully after the fixture adjustment.

Final browser/lane artifacts:

- SF6: `artifacts/verification/2026-10-03T05-47-50-255Z-usability-f3ddadb7`.
- Publication SF6 repeat: `artifacts/verification/2026-10-03T14-08-00-494Z-usability-d4e462df`.
- Surface: `artifacts/verification/2026-10-03T05-26-20-737Z-surface-regression-b6eee88d`.
- Runtime truth: `artifacts/verification/2026-10-03T05-37-15-910Z-runtime-truth-018a6a22`.
- Accessibility: `artifacts/verification/2026-10-03T05-42-33-989Z-accessibility-smoke-3d3eee50`.
- Final scoped visual: `artifacts/verification/2026-10-03T05-54-46-415Z-visual-regression-9594b0fb`.

Reproduce the display proof with `node scripts/verification/chat-streaming-display-proof.mjs`. The normal verification stack supplies isolated build/runtime/provider fixtures and closes its owned resources in `finally`. The scoped visual run used process-local `GOATCITADEL_VERIFY_VISUAL_ROUTE_SLUGS=chat,cockpit-chat` and `GOATCITADEL_VERIFY_VISUAL_VARIANT_SLUGS=desktop-dark,mobile-dark`; these are verification selectors, not operator configuration.

## Compatibility, rollout and remaining work

These are existing display correctness fixes; no new experiment was enabled. Gateway/durable authority, approvals, deny-wins policy, capability grants, artifact provenance, operator configuration and Classic rollback remain intact. Unified 11.0.5, remark-parse 11.0.0 and the existing mdast types were made explicit dependencies to reuse the already-installed parser; no package version or parser implementation was introduced. Offline frozen-lock installation passed.

Unfinished acceptance evidence: **SF6-SD0 pristine-checkpoint browser baseline observations** were not captured before source changes. The historical renderer's grammar/render counts are reproducible, and pre-fix browser failures justify the display fixes, but there is no matched full-stack checkpoint/current browser comparison or timing/highlighting/layout measurement. SD1–SD4 are delivered; the strict whole-SF6 definition of done is not claimed. This is an evidence gap, not an external blocker. The supplied W0–W6 specification is still absent; O1 remains excluded. No root `verify:fast`, full-workspace typecheck, live/paid-provider, installed-desktop/installer, CI/security, deployment or release-readiness proof is claimed.

The first named accessibility run failed eight scenarios because fixtures written for Classic drawers and selectors silently navigated to the new default Cockpit. Those eight routes now explicitly select `?shell=classic`; the corrected lane passes, and default Cockpit Chat is audited independently in both SF6 browser scenarios. The original run also found an unrelated, unchanged Cockpit Access-settings issue at **`accessibility-smoke.mobile-landscape-access-touch`**: duplicate “Gateway authentication” regions and two undersized touch targets. Evidence remains at `artifacts/verification/2026-10-03T05-31-15-948Z-accessibility-smoke-97ed4d0b`. Passing the corrected Classic lane does not clear that Cockpit issue.

Source publication to GitHub `main` was authorized on 2026-10-03. No experimental capability flag was enabled, operator configuration changed, runtime data migrated or live-provider request made. Rendering caches are local/bounded and confer no runtime authority. Windows native paths and repository output-lock/verification wrappers were used. For publication, the two new CSS rules were moved unchanged into the Chat-owned `chat-display.css` import, retaining their `components` layer and selectors so the normal commit formatter does not reformat the pre-existing Cockpit stylesheet.

## Changed files and final repository state

SF6 changes 27 paths (19 tracked modifications, 8 new files). Publication checks also corrected the governance validator's stale unused-import requirement: route coverage is supplied by the existing canonical `resolveSurfaceRegressionManifest()` call, which is now the checked source boundary.

```text
apps/mission-control-next/src/cockpit/areas/chat/ChatBlockers.tsx
apps/mission-control-next/src/cockpit/areas/chat/ChatTranscript.test.tsx
apps/mission-control-next/src/cockpit/areas/chat/ChatTranscript.tsx
apps/mission-control-next/src/cockpit/areas/chat/ChatTurnDetails.tsx
apps/mission-control-next/src/cockpit/styles/chat-display.css
docs/superpowers/plans/2026-10-02-codex-chat-display-layer-followup.md
docs/superpowers/plans/2026-10-02-codex-followup-improvements.md
docs/superpowers/reports/2026-10-02-sf6-chat-display-implementation.md
packages/mission-control-shared/package.json
packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.incremental.test.tsx
packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.tsx
packages/mission-control-shared/src/components/chat/AssistantMessageRenderer.work-counts.test.tsx
packages/mission-control-shared/src/components/chat/chat-renderer-memo.test.tsx
packages/mission-control-shared/src/components/chat/chat-renderer-tail.test.tsx
packages/mission-control-shared/src/components/chat/chat-thread-reducer.test.ts
packages/mission-control-shared/src/components/chat/chat-thread-reducer.ts
packages/mission-control-shared/src/components/chat/streaming-markdown.test.ts
packages/mission-control-shared/src/components/chat/streaming-markdown.ts
pnpm-lock.yaml
scripts/validate-governance-docs.mjs
scripts/verification/chat-markdown-work-counts.mjs
scripts/verification/chat-streaming-display-proof.mjs
scripts/verification/lib/scenarios.mjs
scripts/verification/lib/scenarios/accessibility-smoke-lane.mjs
scripts/verification/lib/scenarios/chat-streaming-display-proof.mjs
scripts/verification/lib/scenarios/deterministic-llm-stub.mjs
scripts/verification/lib/scenarios/deterministic-llm-stub.test.mjs
```

Pre-publication verification state: branch `main` was four commits ahead of `origin/main`, with HEAD `67a32636f`; the index was empty and all 26 SF6 paths were uncommitted. Publication preparation moved the Chat CSS rules and corrected the stale governance source check, bringing the final scope to 27 paths. The authorized SF6 commit includes the paths above and this report. Checkpoint/user/concurrent-agent work is preserved. Test-only baseline copies, logs and browser artifacts are ignored and retained. Task-owned verification stacks and provider stubs were closed after their runs, and output locks released. No pre-existing service was stopped. Publication result and exact commit identity are reported in the accompanying Chat handoff after Git confirms the push.
