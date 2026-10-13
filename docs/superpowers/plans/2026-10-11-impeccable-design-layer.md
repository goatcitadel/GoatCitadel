# Impeccable Design Layer Implementation Plan

> Implementation-plan artifact only. This document may name proposed files, commands, tests, and runtime behavior; treat those as plan intent, not shipped 1.0 truth, unless the current implementation and release evidence prove them.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make [pbakaus/impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0) GoatCitadel's design layer for markup the model writes, fix the parts of the native artifact renderers that impeccable cannot reach, and keep every claim about design quality backed by a render-and-look proof.

**Architecture:** Vendor impeccable's prose as a bundled, exact-byte-governed skill with a pinned upstream SHA and no launcher, binary, hook, or live mode. Route skill modules per detected command from a code-owned table inside the existing governed-skill receipt path. Give the skill operator-owned PRODUCT/DESIGN context through GuidanceService. Add an advisory TypeScript detector, a jailed Playwright render step for HTML artifacts, and native craft fixes for PPTX/PDF/DOCX. Document the limits truthfully.

**Tech Stack:** TypeScript, Vitest (gateway, skills, policy-engine, threaded-surface-core), `tsx --test` (storage), Playwright 1.58.2 (already a root and policy-engine dependency), Fastify, React. No new npm dependencies.

**Review basis:** read-only review of the current design layer on 2026-10-11 (main `0b381318e`). Findings that shape this plan:

- impeccable is not in the tree and no commit mentions it.
- `skills/bundled/design-intelligence` is injected index-only: `governed-skill-instruction-service.ts` loads `SKILL.md`, or only `presentation.md` on slide intent; the other eight modules are never injected.
- Activation is substring keyword matching (`packages/skills/src/activation.ts`, `routing-hints.generated.ts`, which is hand-edited despite its name).
- Artifact looks are decided by fixed renderer templates (`presentation-pptx-renderers.ts`, `presentation-pdf.ts`, `document-artifacts.ts`); the model supplies content only. `artifact-design.ts` picks presets by a content regex and ships accent `7C3AED`, which `design-quality.ts` itself flags as `default-indigo`.
- A sandboxed HTML preview already exists (`GeneratedArtifactViewer.tsx`, `<iframe sandbox="" srcDoc>`); it is reused, not rebuilt.
- Any file change to an already-trusted bundled skill demotes it to `candidate` with no re-trust path (`capability-system-service.ts` `resolveSkillLifecycle`). That is tracked as a separate prerequisite task (see D1).
- `/`-prefixed composer drafts go to the local chat-command path and answer "Unknown command"; `$skill` palette inserts are not explicit activation (only `@skill X` and `use X` are).

**What impeccable cannot do here:** it cannot change how PPTX, PDF, or DOCX files are drawn, because those renderers never see model-authored markup. It does own what goes on the slides and pages (structure, titles, bullets, archetypes, grounding) through its `artifacts.md` module. Phase 5 fixes the drawing natively and the docs must say so.

---

## Decisions

- [ ] **D1 Bundled-skill re-trust.** Prerequisite PR (separate task): release-bound re-trust for `built_in`/`managed` skills via a generated lock (`packages/skills/src/bundled-skill-lock.generated.ts`) checked by `check-skill-catalog.mjs`; `resolveSkillLifecycle` re-trusts only when the current tree equals the lock entry and the existing row was `trusted` (never `revoked`), with an audited lifecycle event. Until it lands: do not edit `skills/bundled/design-intelligence` files, and do not re-sync impeccable after its first ship.
- [x] **D2 Ownership (decided 2026-10-11).** impeccable is the single design skill and activates for anything that could use design: web UI code, HTML artifacts, Mission Control work, and decks/documents. It absorbs design-intelligence's deck and document grounding as a GoatCitadel-authored module `reference/artifacts.md` (≤ 8 KiB, adapted from `presentation.md`, not upstream content). design-intelligence stays untouched on disk for one release (no file edits, so no trust demotion) but is removed from routing and from every code reference, then deleted in the release after D1 lands. Folding impeccable into design-intelligence was rejected: it would require editing design-intelligence's files now (demotion on upgraded installs), it would keep the weaker skill as the host, and it would make upstream re-syncs impossible.
- [x] **D3 Context scope (decided 2026-10-11).** PRODUCT/DESIGN guidance is workspace-scoped only; no global fallback, so the repo's own root `DESIGN.md` never becomes runtime guidance in source dev. One workspace can hold a family design, another a company design with its brand colors. DESIGN.md carries a small machine-readable brand block (colors, fonts) that Phase 2 passes to `artifact-design.ts` as `design.brand`, so decks and documents use the workspace brand too.
- [x] **D4 Preview CSP (decided 2026-10-11).** Allow embedded fonts: change the gateway baseline policy in `apps/gateway/src/app.ts` from `font-src 'self'` to `font-src 'self' data:` (one token; `style-src` already allows inline styles and `img-src` already allows `data:`), with a one-line security note in the PR (font bytes cannot execute; the preview iframe keeps `sandbox=""`). The Phase 4 render step injects the same policy so screenshots match the preview. The stricter per-route policies in `routes/files.ts` and `routes/chat.attachments.ts` stay as they are. All UI touchpoints for this program live in the cockpit (`apps/mission-control-next/src/cockpit`); the Classic shell (`features/native-routes`, `features/threaded-surface`) is being retired and receives no new design-layer UI.
- [x] **D5 Reference set (decided 2026-10-11, narrowed during Phase 0).** Vendor the prose-safe command references listed in the Phase 0 task breakdown; exclude launcher-driven and native-platform files; split references over 20 KiB deterministically by H2 heading into `reference/<name>/NN-<slug>.md` with `reference/<name>.md` as the index, and record every split and exclusion in `UPSTREAM.md`.
- [x] **D6 Mission Control conventions (decided 2026-10-11).** The cockpit adopts impeccable's craft floor, including the kicker ban; the Classic shell is being retired and is out of scope. Measured on 2026-10-11: cockpit TSX has zero kickers of its own and only three CSS hooks (`chat-build-editor.css`, `cockpit.css`) that restyle kickers coming from shared components; the cockpit embeds four shared components that carry five kickers (`CommandPalette`, `GatewayAccessGate`, `PageErrorBoundary`, `GeneratedArtifactViewer` in `packages/mission-control-shared`); the remaining 141 hits in 53 files live in `features/native-routes` and `features/threaded-surface` (Classic) plus twelve shared components the cockpit never imports. Phase 6 removes the four embedded kickers and the three CSS hooks. The Mission Control DESIGN.md does not pin kickers.

---

## Phase 0: Vendor impeccable (explicit activation only)

Ships on its own. New directory, no changes to existing skills. The executable task breakdown for this phase is at the end of this document.

### Files

- [x] Create `skills/bundled/impeccable/SKILL.md` generated from upstream `skill/SKILL.src.md`: frontmatter keeps `name` and `description`, drops `allowed-tools`, `argument-hint`, `user-invocable`, `license`, and adds `metadata` (version, tags, narrow keywords); the Setup section is rewritten so no launcher is run and context comes from the workspace design documents; placeholders are resolved; launcher, pin, hooks, doctor, drift, and live sections are removed; an Apache 4(b) modification notice follows the frontmatter (the loader requires `---` on line 1).
- [x] Create `skills/bundled/impeccable/reference/` with the vendored references (see the task breakdown for the exact list and exclusions).
- [x] Create `skills/bundled/impeccable/reference/artifacts.md` (GoatCitadel-authored, ≤ 8 KiB): the deck and document grounding rules currently in `skills/bundled/design-intelligence/presentation.md`, rewritten in impeccable's voice and mapped to its Modes; marked as not upstream content in `UPSTREAM.md` and `NOTICE`.
- [x] Create `skills/bundled/impeccable/LICENSE` (upstream copy), `NOTICE` (generated: upstream attribution plus GoatCitadel modification statement), `UPSTREAM.md` (generated: repository URL, pinned commit SHA, per-file upstream and vendored sha256, exclusions with reasons, transforms applied, local files; no personal paths).
- [x] Create `THIRD_PARTY_NOTICES.md` at the repo root with the impeccable entry; confirm the installer bundle copies the whole `skills/` tree.
- [x] Create `scripts/sync-impeccable.mjs`: takes a local upstream checkout path and SHA as arguments, never downloads or executes anything; copies the allowed files; normalizes to LF and trims trailing whitespace; applies the transforms; fails if any launcher string, unresolved placeholder, or `grok`/`xai`/`x.ai` mention remains; writes `UPSTREAM.md`.
- [x] Modify `skills/catalog-coverage.json`: add `bundled:impeccable` (owner `mission-control-next`, riskTier `medium`, `catalogExposure: "suggestable"`). Confirm the SKILL.md bytes/4 estimate stays within the 40000 token budget.

### Tests

- [x] New `apps/gateway/src/services/bundled-skill-promptware.test.ts`: `scanPromptwareContent` over every `.md` in every bundled skill and over the assembled bundle for each Phase 1 module combination.
- [x] `packages/skills/src/bundled-skill.test.ts`: impeccable loads; identifier-safe name; activates on `use impeccable` / `@skill impeccable`; does not activate on "fix the backend bug".
- [x] New `scripts/sync-impeccable.test.mjs`: fixture-driven coverage of every transform, the forbidden-string guard, the split, idempotency, and stale-file removal.

### Proof

`pnpm verify:skills:catalog`, focused vitest, `pnpm verify:design:quality` (unchanged), `pnpm verify:repo:hygiene`, `git diff --check`.

### Out of scope

Routing hints, any change to design-intelligence, the launcher, the detector, live mode.

---

## Phase 1: Module-aware injection, arbitration, invocation

No design-intelligence file changes (D1).

### 1a Module routes in code

- [x] Create `packages/skills/src/skill-module-routes.ts`: typed table keyed by `skillId` with `core[]`, `commands{name → {modules[], maxBytes}}`, `intents[{pattern, command}]`, `budgetBytes`, optional `contextDocs`; pure `resolveSkillModules(skillId, text, explicitCommand)`. The impeccable entry: artifact intent (pptx/docx/pdf/slides/report/brief) → `SKILL.md` + `reference/artifacts.md` only (no craft-floor; the renderer ignores CSS); any other design intent → `SKILL.md` + `reference/craft-floor.md` + at most one command module; total budget about 24 KiB (constant to agree). The design-intelligence entry reproduces today's behavior byte for byte only until Phase 1b removes it from activation. Export from `packages/skills/src/index.ts`.
- [x] Modify `apps/gateway/src/services/governed-skill-instruction-service.ts`: replace the hard-coded `DESIGN_SKILL_ID`/`PRESENTATION_MODULE` branch with `resolveSkillModules`; enforce per-module and total byte budgets by throwing, never truncating; keep per-module manifest verification; old frozen profiles keep rendering because render uses `expected.modules`.

### 1b One design skill: broad activation for impeccable, retire design-intelligence from activation (code only, no file edits under `skills/bundled/design-intelligence`)

- [x] Modify `packages/contracts/src/skills.ts` `SkillRoutingHints`: add optional `commands?: Array<{ name: string; summary: string }>`. Rebuild `@goatcitadel/contracts` before package tests.
- [x] Modify `packages/skills/src/routing-hints.generated.ts`: add `impeccable` with broad design coverage (design, redesign, polish, critique, landing page, website, dashboard UI, component, page, form, onboarding, empty state, typography, color, layout, animation, html, slides, deck, pptx, docx, pdf, report, brief, artifact) plus `commands`; replace the `design-intelligence` entry with an empty hint set so it never activates by keyword (keep the phrases `design-quality.ts` requires in the file only until Phase 6 switches that checker to impeccable).
- [x] Modify activation so artifact intents also activate impeccable: `apps/gateway/src/services/gateway-service.ts` `resolveActivatedSkills` passes the turn's `presentationArtifactIntent`/`documentArtifactIntent` (from `chat-artifact-intent.ts`) and the module router treats them as the artifacts route.
- [x] Replace every code reference to `design-intelligence` with `impeccable`: `chat-turn-agent-runner.ts` `attachArtifactDesignSkillArgs` and `buildToolAccessProbeArgs`, `chat-turn-agent-runner/artifact-write-helpers.ts`, `packages/policy-engine/src/tool-registry.ts` (`skillId` enum and usage hints), `packages/policy-engine/src/artifact-design.ts` (`skillId` type and report copy), `governed-skill-instruction-service.ts` (`DESIGN_SKILL_ID`/`PRESENTATION_MODULE` constants fold into the route table), `scripts/verification/research-artifact-reliability.mjs` and `async-gateway-postgres-proof.mjs` (module path and ≤ 8 KiB assertion now point at `skills/bundled/impeccable/reference/artifacts.md`).
- [x] Modify `scripts/evaluate-skill-selection.ts`: impeccable cases for UI, deck, document, and negative (backend) prompts.

### 1c Explicit invocation

- [x] Modify `apps/gateway/src/services/callable-skill-activation.ts` and `packages/skills/src/activation.ts`: recognise `$<skillId>` as explicit (closes the `1_0_CONTRACT.md` line 34 "compatibility `$` alias" gap); parse the word after an explicit `impeccable` mention as the command (`@skill impeccable critique …`).
- [x] Modify `packages/threaded-surface-core/src/chat/useChatComposerPaletteController.ts`: for callable skills with `routingHints.commands`, add palette items labelled `/impeccable <cmd>` whose `applyValue` is `@skill impeccable <cmd> `; the draft does not start with `/`, so it sends as a normal message and needs no Gateway command plumbing. Confirm the skills list route returns `routingHints`.

### Tests

- [x] `governed-skill-instruction-service.test.ts`: module selection per command; budget overflow throws; design-intelligence presentation receipt identical byte for byte to today's; an old receipt still renders.
- [x] `activation.test.ts`: broad activation matrix (UI, deck, document, negative), design-intelligence never selected by keyword, `$` explicit parsing, command extraction.
- [x] `useChatComposerPaletteController.test.ts`: command items present only when impeccable is callable.
- [x] `bundled-skill.test.ts`: impeccable routing precision (no activation on backend prompts; activation on "polish this landing page").

### Proof

Focused vitest (gateway, skills, threaded-surface-core), `pnpm --filter @goatcitadel/contracts build`, `pnpm typecheck`, `pnpm verify:skills:catalog`, `pnpm verify:design:quality`, `pnpm verify:research-artifact:reliability` (presentation module unchanged, ≤ 8 KiB), `pnpm verify:routed-context:snapshots`.

### Out of scope

A Gateway `/design` command; editing or deleting design-intelligence files (deletion is Phase 6, after D1); a per-skill `skill-modules.json` sidecar for managed/workspace skills (v2, after D1).

---

## Phase 2: Project context (PRODUCT.md / DESIGN.md, operator-owned)

- [x] Modify `packages/contracts/src/workspaces.ts` `GuidanceDocType`: add `"product" | "design"`.
- [x] Modify `apps/gateway/src/services/guidance-doc-files.ts`: map to `PRODUCT.md` and `DESIGN.md`.
- [x] Modify `apps/gateway/src/services/guidance-service.ts`: add both to `WORKSPACE_GUIDANCE_DOC_TYPES`; do not add to `RUNTIME_GUIDANCE_DOC_TYPES` (the 6000-character shared budget must not be spent on design text every turn); exclude from global listing and global writes (D3).
- [x] Modify `apps/gateway/src/routes/workspaces.ts`: add both to the workspace zod enum only.
- [x] Modify `governed-skill-instruction-service.ts`: when a module route declares `contextDocs`, read the workspace docs; scan them with a distinct guidance-security error (not "skill security"); truncate deterministically to about 6 KiB each with a `truncated` flag; append a "Project design context" section; record `contextDocuments?: [{docType, scope, sha256, bytes, truncated}]` in the receipt.
- [x] Modify `packages/contracts/src/chat-capability-profile.ts`: optional receipt field, omitted when empty so earlier frozen profiles stay canonical-JSON-equal.
- [x] Brand block: define a small fenced block in DESIGN.md (name, up to six hex colors, up to three font names, optional logo path inside the workspace jail) parsed by a pure helper in `packages/skills`; `attachArtifactDesignSkillArgs` fills `design.brand` from it when the turn has a design receipt and the model supplied none, so `artifact-design.ts` `applyBrandColors`/`resolveTypography` use the workspace brand for decks and documents.
- [x] Writing the documents (`init` / `document` commands): the model drafts PRODUCT.md/DESIGN.md as a normal reply; the operator saves it as a generated artifact (existing `createChatGeneratedArtifactFromTurn`); a new explicit operator action "Apply as workspace DESIGN.md / PRODUCT.md" calls `updateWorkspaceGuidance` and records the artifact hash. Add a minimal guidance editor plus apply control as a new cockpit settings section (`apps/mission-control-next/src/cockpit/areas/settings/WorkspaceDesignContextSettings.tsx`, following `AppearanceSettings.tsx` patterns), since no guidance editor UI exists in the cockpit today. No Classic counterpart.
- [x] Create root `DESIGN.md` and `PRODUCT.md` for repo coding agents only, seeded from `docs/superpowers/specs/2026-09-27-mission-control-cockpit-design.md`, `docs/superpowers/specs/2026-09-22-goatcitadel-mark-and-icons-design.md`, `docs/review/mission-control-claude-design-convergence-audit.md`, `apps/mission-control-next/src/styles/mission-control-next-tokens.css`, `apps/mission-control-next/src/cockpit/styles/cockpit-tokens.css`, and the AGENTS.md North Star / UI-UX Direction sections; the cockpit follows impeccable's craft floor (D6) and Classic is marked retiring and out of scope. One sentence in AGENTS.md pointing to them.

### Tests

- [x] `guidance-service.test.ts`: workspace-only types; global listing excludes them.
- [x] `routes/workspaces.test.ts`: enum.
- [x] Receipt test: context hash drift fails closed with a clear message; old receipts unaffected.
- [x] Mission Control component test for the apply action.

### Proof

`pnpm verify:routed-context:snapshots`, `pnpm verify:runtime:truth`, `pnpm docs:check`, `pnpm verify:surface:regression`.

### Out of scope

Reading DESIGN.md from a project repository root (later: explicit "import from project" action); silent writes by the model.

---

## Phase 3: Deterministic detector (advisory only)

- [x] Create `packages/skills/src/design-detector/rules.ts` and `detect.ts`: move `ANTI_SLOP_PATTERNS` from `design-quality.ts` unchanged and import them back (no behavior change); add about ten text-detectable craft-floor rules (gradient text, side-stripe border > 1px, zero-blur offset shadow, default `backdrop-filter` glass, `01`/`02` section markers, emoji icons, kicker/eyebrow class heuristic, invented metrics, placeholder copy, bounce/elastic easing). Each rule: id, severity (always advisory), pointer to the craft-floor section. Attribute ported rules in `NOTICE`. Never claim parity with impeccable's 59-rule engine.
- [x] Modify `apps/gateway/src/services/chat-turn-agent-runner.ts` tool-result path (next to the artifact design hook near `attachArtifactDesignSkillArgs`): when the frozen profile holds a design-group receipt and the tool is `fs.write`/`fs.patch` on `.tsx`/`.jsx`/`.css`/`.html`/`.vue`/`.svelte`, add `designAdvisories` to the result from the written content (added lines only for patches; never re-read disk); cap at 8 findings and about 1 KiB; must pass `assertNoToolOutputInjection`.
- [x] Modify `apps/gateway/src/services/chat-generated-artifact-service.ts`: run the detector on HTML generated artifacts and attach the advisories on every read (derived and memoized per content hash, not stored: the artifact table is column-based on both engines; see the Task 20 ruling).
- [x] Surface per-turn advisories in `cockpit/areas/chat/ChatTurnDetails.tsx`. Ops Quality stays repo-scope (its posture says it reads repo files only): add one advisory P2 repo check running the shared rules over `apps/mission-control-next/src/cockpit` and `packages/mission-control-shared/src/components`, excluding the Classic directories (`features/native-routes`, `features/threaded-surface`); findings are counts, informational, never blocking.

### Tests

- [x] `design-detector.test.ts`: one positive and one negative per rule.
- [x] Gateway advisory injection test: only with a design receipt; bounded; passes the output-injection assertion.
- [x] `design-quality.test.ts`: unchanged behavior plus the new check.

### Proof

Focused vitest, `pnpm verify:design:quality`, `pnpm verify:gateway:async-boundary`.

### Out of scope

Blocking writes, auto-fix, contrast checks (need rendering, Phase 4), the impeccable hook system.

---

## Phase 4: Render and look (preview already exists)

- [x] Create `packages/policy-engine/src/playwright-runtime.ts`: move and export `loadPlaywright` and `launchPlaywrightChromium` (with the existing WebRTC security args) out of `browser-tools.ts`, which then imports them. (Done 2026-10-12.)
- [x] Create `packages/policy-engine/src/html-render.ts` with `renderHtmlSnapshot({ html, viewports, outputDir, writeJailRoots, signal, timeoutMs })`: `assertWritePathInJail`; HTML size cap (512 KiB) and timeout; `javaScriptEnabled: false` to match the preview's `sandbox=""`; `offline: true` and block every route except `data:` and `about:`; inject a CSP `<meta>` equal to the Mission Control baseline so the critique sees what the operator sees; PNG at 1440×900 and 390×844 (no `page.pdf()`: not needed by any consumer); missing Chromium returns the existing manual-install diagnostic. Blocked requests are recorded from the page's `requestfailed` events because the injected CSP refuses them before the route layer. (Done 2026-10-12.)
- [x] Create gateway `html-artifact-render-service.ts` and route `POST /api/v1/chat/generated-artifacts/:artifactId/renders` (`GET` lists): workspace-bound, idempotency markers, rate-limited. PNGs stored as chat attachments named `render-<hash16>-<viewport>.png` with analysis skipped, keyed by the artifact `contentHash`; the artifact itself is never changed (`1_0_CONTRACT.md` line 42 holds). (Done 2026-10-12.)
- [x] Modify `packages/policy-engine/src/document-artifacts.ts` and `tool-registry.ts`: `documents.create` with `format: "html"` accepts an optional full `html` document argument when the turn carries a design receipt (the runner deletes it otherwise); the Phase 3 runner hook scans it; the design report records `markup: "model-authored"` instead of the template. Without a receipt the existing template path stays. (Done 2026-10-12.)
- [x] Critique: `POST …/:artifactId/critique` dispatches a normal Chat turn with `@skill impeccable critique`, the artifact as routed context, and the PNGs attached only when the effective provider is capability-detected as vision-capable; otherwise a text-only critique labelled "Render evidence unavailable". A follow-up produces a new artifact version; nothing edits in place. The trimmed `critique` reference is re-vendored without the launcher loop as a single-context routed turn. (Done 2026-10-12.)
- [x] Cockpit only: "Render" and "Critique render" actions under every cockpit `GeneratedArtifactViewer` (Chat inspector, Library detail, Run artifacts) through a host-provided actions slot (`GeneratedArtifactActionsContext`) filled once in `CockpitApp`, so the three dense area files are not reformatted. The Classic consumers (`features/threaded-surface/*`, `features/native-routes/library/LibraryArtifactsSection.tsx`) provide no slot value and are untouched. (Done 2026-10-12.)
- [x] D4: baseline policy pinned to `MISSION_CONTROL_BASELINE_CSP` (`font-src 'self' data:`). Packaged shell verified through the gateway header test; the Vite dev shell was verified by config inspection only (`apps/mission-control-next/vite.config.ts` sets no Content-Security-Policy, so the dev preview runs unpoliced), not by a browser check. Font limit and the same-origin caveat (shell assets can load in the preview but not in the offline renders) recorded in `DESIGN.md` and `docs/1_0_CONTRACT.md`. (Done 2026-10-12; narrowed from the original two-shell browser verification.)

### Tests

- [x] `html-render.test.ts`: jail rejection, blocked network request (route layer with a mocked browser; CSP refusal in a real headless render), JS disabled, size cap, missing-Chromium diagnostic.
- [x] Route tests: workspace scope (400), 409 mapping, 201/202 shapes, idempotency markers; auth comes from the global plugin (not re-tested per route).
- [x] `document-artifacts.test.ts`: raw-HTML path gated on receipt (runner test strips/keeps `html`).
- [x] Mission Control component test for the actions (`ArtifactRenderActions.test.tsx`, including the viewer slot).

### Proof

Focused vitest, `pnpm verify:surface:regression`, `pnpm verify:visual:regression`, `pnpm verify:auth:matrix`, plus a browser proof screenshot of a rendered artifact.

### Out of scope

A new preview component; running JavaScript in renders; replacing `presentations.create` with an HTML-first deck; live mode.

---

## Phase 5: Native renderer craft (impeccable cannot do this)

- [x] Modify `packages/policy-engine/src/presentation-pptx-renderers.ts`: remove the 0.13-inch accent side stripe and the bold accent `01` slide number; quiet page number; drop the bordered card as the default body container on narrative slides. Update `presentation-pptx-audit.ts`, `presentation-pptx-fallback.ts`, and `scripts/verification/lib/pptx-package-audit.mjs` together (the audit keys on `gc:slide-number` and `gc:layout:`).
- [x] Modify `packages/policy-engine/src/presentation-pdf.ts` for the same frame and container changes.
- [x] Modify `packages/policy-engine/src/artifact-design.ts`: stop choosing a preset by content regex; default `clean-professional` unless an explicit `preset` or `brand` is supplied; replace `7C3AED` in the `pitch` preset; make `design-skill-applied` report the injected module list from the receipt rather than "planned".
- [x] Modify `packages/policy-engine/src/presentation-pptx.ts` and `document-artifacts.ts`: replace the hashed SVG blob with no visual or a typographic treatment when no provider image exists; never ship the blob as a DOCX hero.
- [ ] (deferred, unchanged in Phase 5) PDF font embedding (`pdf-writer.ts`, Helvetica only) is flagged as a separate large item; not bundled here.

### Tests

- [x] `presentation-pptx.test.ts`, `presentation-pptx-audit.test.ts`, `presentation-pdf.test.ts`, `artifact-design.test.ts`, `document-artifacts.hero.test.ts` (new), `tool-executor-tail.coverage.test.ts`, `pptx-package-audit.test.mjs`, `research-artifact-powerpoint.test.mjs`.

### Proof

`pnpm verify:research-artifact:reliability`, `pnpm verify:research-artifact:powerpoint` (Windows), `pnpm verify:ux:budgets`, `pnpm verify:visual:regression` (re-baselining is all-or-nothing), plus rendered before/after deck PNGs attached to the PR.

### Out of scope

DOCX theming beyond the blob removal; PDF font embedding.

---

## Phase 6: Docs, contract, evidence

- [x] `docs/1_0_CONTRACT.md`: one paragraph on the design layer: vendored impeccable prose at a pinned SHA with no launcher or binary; module receipts; the advisory detector is a subset, not impeccable's engine; rendering is evidence, not a quality claim; vision critique is capability-gated. Line 42 stays. Fix line 34 if `$` handling changes.
- [x] `docs/CANONICAL_RUNTIME_STATE_MODEL.md`: receipts with `contextDocuments`.
- [x] `packages/skills/src/design-quality.ts`: switch `REQUIRED_SKILL_MODULES`, `REQUIRED_SKILL_PHRASES`, and `REQUIRED_ROUTING_PHRASES` to the impeccable module set and routing entry; add impeccable checks (`UPSTREAM.md`, `LICENSE`, `NOTICE` present; no launcher strings; no broken links; `artifacts.md` ≤ 8 KiB).
- [ ] Delete `skills/bundled/design-intelligence/` in a small follow-up PR after D1 has shipped, and remove `bundled:design-intelligence` from `skills/catalog-coverage.json`. Confirm a stale lifecycle row for a skill that no longer loads is tolerated by `listSkills` and the Library skills view on an upgraded install (dual-lineage test).
- [x] Cockpit craft-floor alignment (D6): remove the kicker label from the four shared components the cockpit embeds (`packages/mission-control-shared/src/components/CommandPalette.tsx`, `GatewayAccessGate.tsx`, `PageErrorBoundary.tsx`, `chat/GeneratedArtifactViewer.tsx`) where the heading already carries the meaning, and drop the three cockpit CSS hooks (`cockpit/areas/chat/chat-build-editor.css`, `cockpit/styles/cockpit.css`). Classic also renders those four components, so its baselines shift in the same all-or-nothing visual rebaseline; no other Classic file is touched.
- [x] Ops Quality UI copy in the cockpit (`cockpit/areas/system/quality/QualityDesign.tsx`) lists the new checks; the Classic `QualityDashboardRoutePage.tsx` is not updated.
- [x] README verification table: mention the new checks only if a lane name changes.

### Proof

`pnpm docs:check`, `pnpm verify:design:quality`, `pnpm verify:skills:catalog`, `pnpm verify:fast`, `git diff --check`.

Proof results (2026-10-13, branch `feat/impeccable-phase-6`): `docs:check`, `verify:skills:catalog`, and `git diff --check` pass. `verify:design:quality` passes every `impeccable.*` check and exits 1 only on the pre-existing `mission-control.raw-color-budget` (95 raw colours against the 92 budget in `__demo__/chat-demo.css`), which this phase does not touch and leaves open. `verify:fast` passed 22 of 24 lanes; `fast.repo-hygiene` was the GNU-tar-under-Git-Bash false red (green under PowerShell) and `fast.test.gateway.shard3` was the remote-worker restart e2e under full-lane load (green alone). `verify:visual:regression` ran as report only: 554 passed, 62 failed, the same cockpit pages and diff ratios as before this phase; baselines were not updated and that drift stays open.

---

## Dependencies

- Phase 0 ships alone.
- D1 (separate task) must land before any impeccable re-sync and before any edit to design-intelligence files.
- Phase 1 depends on 0. Phase 2 depends on 1a. Phase 3 depends on 1. Phase 4 depends on 0 and 1 and uses the detector if present. Phase 5 is independent and can run in parallel. Phase 6 trails each phase.
- No new npm dependencies.

## Risks

- **HIGH: bundled-skill trust demotion.** Any file change to an installed bundled skill leaves it non-callable with no re-trust path. Mitigation: D1 prerequisite; module routes live in code; no design-intelligence file edits in this program.
- **HIGH: prompt byte growth.** No cap exists on activated skills or total bytes; impeccable references are large; small-context and local models suffer. Mitigation: one design skill, intent-based module routing (artifacts route skips craft-floor), per-skill budgets, oversize references split, catalog estimator checked.
- **MEDIUM: promptware false blocks**, mainly the 96-character `tool_execution_without_approval` window, including across module boundaries. Mitigation: CI scan of every file and every assembled bundle; the sync script rewrites flagged sentences and records it in `UPSTREAM.md`.
- **MEDIUM: receipt shape change** (`contextDocuments`) breaking canonical-JSON equality for earlier frozen profiles. Mitigation: omit when empty; replay test.
- **MEDIUM: preview and render diverge from the craft floor** (JS disabled in both; shared components still carry kickers until Phase 6). Mitigation: D4 allows embedded fonts; render under the same CSP as the preview; D6 removes the embedded kickers.
- **MEDIUM: vision critique overclaim.** Mitigation: capability detection and the "not visually inspected" label.
- **LOW: licensing** (Apache-2.0 into Apache-2.0). Mitigation: LICENSE, NOTICE, 4(b) notices, root third-party notice.
- **LOW: banned xAI/Grok surfaces** from upstream provider folders. Mitigation: only skill prose is vendored; the sync script fails on `grok|xai`.

## Estimated Complexity

| Phase | Size | Estimate |
| --- | --- | --- |
| D1 prerequisite (separate task) | M | 2–3 days with security review |
| 0 | M | 1–2 days |
| 1 | M–L | 3–4 days |
| 2 | M | 3 days |
| 3 | M | 2–3 days |
| 4 | L | 4–6 days |
| 5 | L | 4–6 days, excluding PDF font embedding |
| 6 | S | 1 day |

Overall: L/XL, about 3–5 focused weeks.

---

## Phase 0 Task Breakdown (execution order; TDD per task)

Upstream snapshot for this run: pbakaus/impeccable commit `c63b8dd7dd5a5f3c32eaabe1af76d0694f863ed2`, cloned read-only into the session scratchpad. A survey of that snapshot narrowed D5: the newer upstream drives `critique`, `new-work`, `component-review`, `visualize`, `routing`, `region-map`, `generate`, `live`, `hooks`, `doctor`, and all `agents/*` through launcher subcommands (critique-storage, concept-seed, surface-brief, build-phase, comp-spec, component-review). Those files are excluded in Phase 0 and recorded in `UPSTREAM.md`; `SKILL.md` carries an inline no-argument routing rule instead of `routing.md`. Phase 4 revisits `critique` once the render step exists.

### Task 1: Sync script with fixture-driven tests

Files: `scripts/sync-impeccable.mjs` (new), `scripts/sync-impeccable.test.mjs` (new, node:test).

Vendored allowlist (upstream `skill/reference/`): craft-floor, mode-persuade, mode-operate, mode-read, operate, shape, init, document, extract, audit, polish, bolder, quieter, distill, harden, onboard, animate, colorize, typeset, layout, delight, overdrive, clarify, adapt, optimize. Plus `skill/SKILL.src.md` -> `SKILL.md`, `LICENSE`, and a generated `NOTICE` and `UPSTREAM.md`. Local (never written or deleted by the script): `reference/artifacts.md`.

Transforms, in order: (1) frontmatter rewrite: keep name and description, drop allowed-tools, argument-hint, user-invocable, license; add `metadata` with version `0.1.0`, tags, and the Phase 0 keywords; (2) Apache 4(b) modification notice as a blockquote right after the frontmatter; (3) replace the Setup section body (this also removes the "Launcher unavailable" paragraph); (4) targeted clause rewrites: routing bullets (inline no-argument rule, drop the workflow-questions bullet, "as the project design context directs", the teach/shape line), mode files' concept-seed clause, init.md's PRODUCT.md path sentence, polish.md's context sentence; (5) drop the document.md "Step 4b" sidecar section and the "Never repair drift" paragraph; (6) drop Commands rows for craft, critique, live, generate and the native-reference suffixes, then add a "Not available in this vendored build" line; (7) drop fenced code blocks whose every non-blank line is a launcher invocation, together with a lead-in line ending in a colon; (8) drop any remaining line containing a launcher invocation or an `.impeccable/` path (this covers Pin, Hooks, Doctor, and "After init writes PRODUCT.md"); (9) placeholders: `{{command_prefix}}impeccable` -> `@skill impeccable`, other `{{command_prefix}}` -> `@skill impeccable `, `{{ask_instruction}}` -> "Ask the operator with the user_input.request tool and wait for the answer.", `{{available_commands}}` -> the vendored command list; (10) links to references outside the allowlist become plain text with "(not vendored in this GoatCitadel build)"; (11) LF, trailing-whitespace trim, final newline; (12) split files over 20 KiB by H2 (fence-aware) into `reference/<name>/NN-<slug>.md` with `reference/<name>.md` as the index; (13) forbidden-string guard over every output file: `{{`, `npx impeccable`, `impeccable detect|pin|hooks|context|doctor`, `~/.impeccable`, `.impeccable/`, `grok`, `xai`, `x.ai`; (14) remove stale vendored files not in the allowlist and not local; (15) write `UPSTREAM.md` (repository, commit, per-file upstream and vendored sha256, exclusions with reasons, transforms applied, local files).

Steps:
1. Write `scripts/sync-impeccable.test.mjs` building a synthetic upstream fixture in a temp dir (SKILL.src.md with the real section shapes, references including an oversize one with three H2 sections and a fenced fake heading, an excluded one containing `npx impeccable` and `grok`, a launcher-only code block with a lead-in, each placeholder). Cases: usage error without `--source`/`--sha`; refusal when `skill/SKILL.src.md` or `LICENSE` is missing; allowlist only; SKILL.md frontmatter and notice; Commands rows and unavailable line; routing rewrites; dropped paragraphs; placeholder resolution; link rewrites; launcher line and block drops plus targeted clauses; sidecar section drop and the split with index; LF and whitespace normalization; guard failure naming file and line; UPSTREAM.md contents; local file preserved and listed; stale vendored file removed; second run produces identical bytes; `scanForbiddenStrings` unit case.
2. Run `node --test scripts/sync-impeccable.test.mjs`. Expected: fails because `scripts/sync-impeccable.mjs` does not exist.
3. Implement `scripts/sync-impeccable.mjs` (ESM, node builtins only, never downloads or executes anything; exports the sync function and helpers; `--out` overrides the default `skills/bundled/impeccable`).
4. Run `node --test scripts/sync-impeccable.test.mjs`. Expected: all cases pass.
5. Commit: `feat(skills): add impeccable vendoring sync script`.

### Task 2: Vendor impeccable from the pinned upstream and author artifacts.md

Files: `skills/bundled/impeccable/**` (generated plus `reference/artifacts.md`), `packages/skills/src/bundled-skill.test.ts` (impeccable block).

Steps:
1. Add an `impeccable bundled skill` describe block to `packages/skills/src/bundled-skill.test.ts`: parses frontmatter (name `impeccable`, keywords include `impeccable` and `landing page`); loads with skillId `bundled:impeccable`; activates on "use impeccable for this page", "@skill impeccable polish the settings page", and "polish this landing page hero"; does not activate on "fix the TypeScript error in the gateway route and add a regression test".
2. Run `pnpm --filter @goatcitadel/skills exec vitest run src/bundled-skill.test.ts`. Expected: the impeccable block fails (skill directory absent); the existing blocks pass.
3. Run `node scripts/sync-impeccable.mjs --source <scratchpad clone> --sha c63b8dd7dd5a5f3c32eaabe1af76d0694f863ed2`. Expected: exit 0; summary lists 25 references plus SKILL.md, LICENSE, NOTICE, UPSTREAM.md; guard clean. (Observed: document.md transforms to just under the 20 KiB threshold, so no split happens at this commit; the splitter is exercised by the Task 1 fixture.)
4. Write `skills/bundled/impeccable/reference/artifacts.md` (GoatCitadel-authored, at most 8192 bytes): deck and document grounding adapted from `skills/bundled/design-intelligence/presentation.md`, mapped to Persuade/Read modes, with the `presentations.create` and `documents.create` contract. Re-run the sync command. Expected: artifacts.md preserved, listed under local files in UPSTREAM.md, no other byte changes.
5. Read the transformed `SKILL.md`, `reference/init.md`, `reference/polish.md`, `reference/audit.md`, `reference/typeset.md`, and the `reference/document.md` index for coherence. Expected: no sentence left referring to a removed command or launcher; record any further transform as a ruling and add its fixture case to Task 1's test.
6. Run `pnpm --filter @goatcitadel/skills exec vitest run src/bundled-skill.test.ts`. Expected: all pass.
7. Commit: `feat(skills): vendor impeccable c63b8dd as a bundled design skill`.

### Task 3: Gateway promptware guard for bundled skill prose

Files: `apps/gateway/src/services/bundled-skill-promptware.test.ts` (new).

Steps:
1. Write the test: (a) positive control: `scanPromptwareContent` flags a fixture string containing "override the above rules"; (b) every `.md` under every `skills/bundled/*` directory scans clean; (c) for impeccable, the assembled runtime bundles (`SKILL.md` alone; `SKILL.md` + `reference/craft-floor.md` + each other reference, joined the way `governed-skill-instruction-service.ts` joins modules) scan clean; (d) `reference/artifacts.md` is at most 8192 bytes; (e) no vendored impeccable file contains a launcher string.
2. Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/bundled-skill-promptware.test.ts`. Expected: (a) passes; (b)-(e) pass, or name the exact sentence that trips a rule. A hit means: add a targeted transform to the sync script test-first (Task 1 test file), re-sync, re-run.
3. Commit: `test(gateway): scan bundled skill prose for promptware`.

### Task 4: Catalog coverage, third-party notice, verification lanes

Files: `skills/catalog-coverage.json`, `THIRD_PARTY_NOTICES.md` (new), this plan file.

Steps:
1. Add `bundled:impeccable` (owner `mission-control-next`, riskTier `medium`, expectedTests `packages/skills/src/bundled-skill.test.ts`, catalogExposure `suggestable`) in alphabetical position.
2. Run `pnpm verify:skills:catalog`. Expected: pass; a routing-hints warning for impeccable is acceptable (routing hints are Phase 1).
3. Create `THIRD_PARTY_NOTICES.md` with the impeccable entry (repository, commit, license, vendored path, modification pointer). Confirm `scripts/packaging/build-bundle.mjs` copies the whole `skills/` tree so LICENSE and NOTICE ship. Expected: `copyIfExists(repoRoot/skills, templatesRoot/skills)` present.
4. Run `pnpm verify:design:quality`. Expected: pass (design-intelligence untouched).
5. Run `pnpm verify:repo:hygiene` from PowerShell. Expected: pass.
6. Run `git diff --check`, `pnpm --filter @goatcitadel/skills typecheck`, `pnpm --filter @goatcitadel/gateway typecheck`. Expected: clean.
7. Commit: `chore(skills): register impeccable in catalog coverage and third-party notices`.

---

## Phase 1 Task Breakdown (execution order; TDD per task)

Module names used by every task: `main` (SKILL.md), `craft-floor` (reference/craft-floor.md), `artifacts` (reference/artifacts.md), and `<command>` (reference/<command>.md). design-intelligence keeps `main` and `presentation`. Budgets: impeccable 40 KiB total, 24 KiB per module; craft-floor loads only for the default design route and the fifteen refine/enhance/fix commands (polish, bolder, quieter, distill, harden, onboard, animate, colorize, typeset, layout, delight, overdrive, clarify, adapt, optimize), never for shape, init, document, extract, audit, or the artifacts route.

### Task 5: Module route table and explicit command parsing

Files: `packages/contracts/src/skills.ts` (add `commands?: Array<{ name: string; summary: string }>` to `SkillRoutingHints`), `packages/skills/src/skill-module-routes.ts` (new), `packages/skills/src/skill-module-routes.test.ts` (new), `packages/skills/src/index.ts` (export).

Produces: `resolveSkillModules({ skillId, skillName, text, artifactIntent? }) -> { routeId, command?, modules: Array<{ name, relativePath, maxBytes? }>, budgetBytes }`; `extractExplicitSkillCommand(text, skillName, commands) -> string | undefined` (accepts `@skill impeccable <cmd>`, `use impeccable <cmd>`, `$bundled:impeccable <cmd>`); constants `IMPECCABLE_COMMANDS`, `IMPECCABLE_CRAFT_COMMANDS`, `IMPECCABLE_BUDGET_BYTES`, `IMPECCABLE_MODULE_MAX_BYTES`. The design-intelligence route reproduces today's rule byte for byte: the presentation regex selects `presentation.md` (maxBytes 8192) else `SKILL.md`; any other skill gets `main` only. Budget for those: 64 KiB.

Steps:
1. Write `skill-module-routes.test.ts`: impeccable default text -> `main` + `craft-floor`; artifact intent (presentation or document) -> `main` + `artifacts`; `@skill impeccable polish the settings page` -> `main` + `craft-floor` + `polish`; `@skill impeccable document` -> `main` + `document` (no craft-floor); `$bundled:impeccable typeset the hero` -> `typeset`; `use impeccable audit this page` -> `audit`; `@skill impeccable fly` (unknown word) -> default route; design-intelligence "Create a slide deck" -> `[{ name: "presentation", relativePath: "presentation.md", maxBytes: 8192 }]`; design-intelligence other text -> `[{ name: "main", relativePath: "SKILL.md" }]`; an unknown skill -> `main`; `extractExplicitSkillCommand` unit cases.
2. Run `pnpm --filter @goatcitadel/skills exec vitest run src/skill-module-routes.test.ts`. Expected: fails (module missing).
3. Add the contract field, implement the module, export it from the package index.
4. Run `pnpm --filter @goatcitadel/contracts build`, then the test. Expected: pass. `pnpm --filter @goatcitadel/skills typecheck` clean.
5. Commit: `feat(skills): add per-command module routes for runtime skills`.

### Task 6: Governed injection routes modules per command with byte budgets

Files: `apps/gateway/src/services/governed-skill-instruction-service.ts`, `governed-skill-instruction-service.test.ts`, `apps/gateway/src/services/gateway-service.ts` (`resolveActivatedSkills` computes `artifactIntent` with `detectPresentationArtifactIntent` and `detectDocumentArtifactIntent` from `chat-artifact-intent.ts`).

Steps:
1. Extend the test with an impeccable harness (temp skill dir: SKILL.md, reference/craft-floor.md, reference/polish.md, reference/document.md, reference/artifacts.md; trusted lifecycle; `name: "impeccable"`): "Polish the settings page" -> modules `main`, `craft-floor`; `artifactIntent: { presentation: true, document: false }` -> `main`, `artifacts`; "@skill impeccable polish the settings page" -> `main`, `craft-floor`, `polish` and the rendered instruction contains `Runtime skill module: bundled:impeccable/polish`; an oversized reference/polish.md (25 KiB) -> throws `/exceeds the 24576-byte limit/`; three 15 KiB modules -> throws `/exceeds the 40960-byte budget/`; the existing design-intelligence cases stay green and the presentation receipt's modules equal `[{ name: "presentation", relativePath: "presentation.md", sha256, bytes }]`.
2. Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/governed-skill-instruction-service.test.ts`. Expected: new cases fail.
3. Implement: drop the `DESIGN_SKILL_ID`/`PRESENTATION_*` constants; `buildReceipt` takes `modulePaths` from `resolveSkillModules` (fresh receipts) or `expected.modules` (render); enforce per-module `maxBytes` (message `<name> module exceeds the <max>-byte limit`) and the route budget (message `exceeds the <budget>-byte budget`); `buildGovernedActivatedSkillReceipts` accepts `artifactIntent`; `gateway-service.ts` passes it.
4. Run the service test, `chat-turn-prep-service.governed-skills.test.ts`, and `pnpm --filter @goatcitadel/gateway typecheck`. Expected: pass.
5. Commit: `feat(gateway): route governed skill modules per command with byte budgets`.

### Task 7: Activation routes design prompts to impeccable; design-intelligence leaves keyword routing

Files: `packages/skills/src/routing-hints.generated.ts`, `activation.ts`, `activation.test.ts`, `bundled-skill.test.ts`; `apps/gateway/src/services/callable-skill-activation.ts`; `scripts/evaluate-skill-selection.ts`.

Steps:
1. Tests first: `activation.test.ts` -> impeccable (with its generated hints) activates on "Create a real PowerPoint slide deck and a PDF brief with good document design." with `routing_keyword` and `routing_phrase`, on "Make the dashboard landing page look less generic.", and not on "Fix the TypeScript error in the gateway route and add a regression test."; design-intelligence (with its generated hints) does not activate on the deck prompt; `$bundled:impeccable polish this` is explicit for a skill whose skillId is `bundled:impeccable`; `bundled-skill.test.ts` keyword precision stays green.
2. Run the skills tests. Expected: new cases fail.
3. Implement: impeccable hints (phrases including every phrase `design-quality.ts` requires: design quality, anti-slop, visual polish, design-system audit, document design, presentation design; keywords including pptx and artifact; `commands` with the twenty command summaries); design-intelligence hints become empty `phrases` and `keywords`; `activation.ts` and `callable-skill-activation.ts` accept `$<skillId|name>` as explicit and match explicit tokens against `skillId` as well as `name`; `evaluate-skill-selection.ts` expects impeccable.
4. Run the skills tests, `pnpm verify:design:quality`, `pnpm verify:skills:catalog` (impeccable warning gone), `pnpm tsx scripts/evaluate-skill-selection.ts` (every case hits). Expected: pass.
5. Commit: `feat(skills): route design prompts to impeccable and retire design-intelligence keywords`.

### Task 8: Point artifact design references at impeccable

Files: `apps/gateway/src/services/chat-turn-agent-runner.ts` (`buildToolAccessProbeArgs`, `attachArtifactDesignSkillArgs`), `apps/gateway/src/services/chat-turn-agent-runner/artifact-write-helpers.ts`, `packages/policy-engine/src/tool-registry.ts` (enum and usage hints), `packages/policy-engine/src/artifact-design.ts` (type literal, check detail, report copy), `scripts/verification/research-artifact-reliability.mjs` and `scripts/verification/async-gateway-postgres-proof.mjs` (module path becomes `skills/bundled/impeccable/reference/artifacts.md`), `scripts/verification/lib/ccg-research-deck-fixture.mjs`; tests: `chat-turn-agent-runner.loop24.test.ts`, `chat-turn-prep-service.governed-skills.test.ts`, `artifact-design.test.ts`, `tool-executor-tail.coverage.test.ts`, `engine.test.ts`, `policy-support.coverage.test.ts`, `tool-registry.test.ts`.

Steps:
1. Update the test expectations first (`skillId: "impeccable"` / `"bundled:impeccable"`, enum `["impeccable"]`). Run `tool-registry.test.ts` and `artifact-design.test.ts`. Expected: fail.
2. Implement the renames. Run the policy-engine tests named above, the two gateway tests, and `pnpm --filter @goatcitadel/policy-engine typecheck`. Expected: pass. `node --check` both verification scripts.
3. Commit: `refactor: point artifact design skill references at impeccable`.

### Task 9: Composer palette offers impeccable commands as explicit mentions

Files: `packages/threaded-surface-core/src/chat/useChatComposerPaletteController.ts`, `useChatComposerPaletteController.test.ts`.

Steps:
1. Test first: with an installed, enabled, callable skill `bundled:impeccable` whose `routingHints.commands` is `[{ name: "polish", summary: "Final quality pass before shipping" }]`, the skills source yields an item with `command: "/impeccable polish"`, `applyValue: "@skill impeccable polish "`, `action: { type: "insert_command", value: "@skill impeccable polish " }`; with `callable: false` no command item exists. Expected: fails.
2. Implement in the skills source. Run the test and `pnpm --filter @goatcitadel/threaded-surface-core typecheck`. Expected: pass.
3. Commit: `feat(composer): offer impeccable commands as explicit skill mentions`.

### Task 10: Proof lanes and plan ticks

Steps:
1. `pnpm typecheck` (root), `pnpm verify:skills:catalog`, `pnpm verify:design:quality`, `pnpm verify:routed-context:snapshots`, `git diff --check`. Expected: pass; record any lane that cannot run locally with its reason.
2. Tick the Phase 1 boxes in this plan. Commit: `docs(plan): mark impeccable Phase 1 done`.

---

## Phase 2 Task Breakdown (execution order; TDD per task)

Vocabulary used by every task: a **context doc** is a workspace guidance document of type `product` (file `PRODUCT.md`) or `design` (file `DESIGN.md`) under `workspaces/<workspaceId>/`; there is never a global copy (D3). The **brand block** is a fenced code block in DESIGN.md whose info string is `brand`, holding `key: value` lines (`name`, `colors`, `fonts`, `logo`). The **context ceiling** is 6144 bytes per doc. Context docs are injected only through impeccable's module routes, never through `resolveRuntimeGuidance` (its 6000-character budget stays for GOATCITADEL/AGENTS/CLAUDE).

### Task 11: Workspace-only PRODUCT.md and DESIGN.md guidance docs

Files: `packages/contracts/src/workspaces.ts` (`GuidanceDocType` gains `"product" | "design"`), `apps/gateway/src/services/guidance-doc-files.ts` (`product: "PRODUCT.md"`, `design: "DESIGN.md"`), `apps/gateway/src/services/guidance-service.ts` (`WORKSPACE_GUIDANCE_DOC_TYPES` gains both; new `WORKSPACE_ONLY_GUIDANCE_DOC_TYPES = ["product", "design"]`; `listGlobalGuidance` skips them; `updateGlobalGuidance` throws `Global guidance is not supported for <docType>; it is workspace-only.`; `RUNTIME_GUIDANCE_DOC_TYPES` unchanged), `apps/gateway/src/routes/workspaces.ts` (`workspaceDocTypeSchema` gains both; `globalDocTypeSchema` unchanged), tests `guidance-service.test.ts`, `routes/workspaces.test.ts`.

Produces: `GuidanceDocType` includes `product`/`design`; `GET /api/v1/workspaces/:id/guidance` returns them in `workspace`; `PUT /api/v1/workspaces/:id/guidance/design` writes `workspaces/<id>/DESIGN.md`; `PUT /api/v1/guidance/global/design` is a 400 (enum); `GuidanceService.updateGlobalGuidance("design", …)` throws.

Steps:
1. Tests first: `guidance-service.test.ts` — workspace listing includes `product` and `design` records with `fileName` `PRODUCT.md`/`DESIGN.md`; global listing has no `product`/`design`; `updateGlobalGuidance("design", "x")` rejects with `/workspace-only/`; `resolveRuntimeGuidance` ignores a workspace DESIGN.md (no `DESIGN.md` in `workspaceFilesUsed`). `routes/workspaces.test.ts` — PUT workspace `design` reaches the service with `("default", "design", content)`; PUT global `design` is 400.
2. Run `pnpm --filter @goatcitadel/gateway exec vitest run src/services/guidance-service.test.ts src/routes/workspaces.test.ts`. Expected: new cases fail.
3. Implement; `pnpm --filter @goatcitadel/contracts build`; rerun; `pnpm --filter @goatcitadel/gateway typecheck`. Expected: pass.
4. Commit: `feat(guidance): add workspace-only PRODUCT.md and DESIGN.md guidance docs`.

### Task 12: Brand block parser

Files: `packages/skills/src/design-brand.ts` (new), `design-brand.test.ts` (new), `packages/skills/src/index.ts` (export).

Produces: `parseDesignBrandBlock(markdown: string): DesignBrand | undefined` where `DesignBrand = { name?: string; colors?: string[]; fonts?: string[]; logoPath?: string }` (same shape as policy-engine `ArtifactBrandInput`, which this package must not import). Rules: first fenced block whose info string is exactly `brand` (case-insensitive) wins; lines are `key: value`, unknown keys ignored; `colors` is comma-separated, each normalised to `#rrggbb` (accepts `#rgb`, `#rrggbb`, with or without `#`; invalid entries dropped), at most 6 kept; `fonts` comma-separated, trimmed, non-empty, at most 3; `logo` kept as `logoPath` only when it is a relative path with forward slashes, no `..` segment, no leading `/`, no drive letter, no URL scheme; `name` trimmed, at most 80 chars. Returns `undefined` when there is no block or the block yields no fields. Also exports `DESIGN_BRAND_BLOCK_EXAMPLE` (a 5-line example string used by the settings help text).

Steps:
1. Test first (RED): full block parses; limits (7 colors → 6, 4 fonts → 3); invalid color dropped; `logo: ../x.svg`, `/abs.svg`, `C:/x.svg`, `https://x` all dropped; no block → undefined; block with only unknown keys → undefined; second `brand` block ignored; a `css` block is not a brand block.
2. Implement; `pnpm --filter @goatcitadel/skills exec vitest run src/design-brand.test.ts`; typecheck. Expected: pass.
3. Commit: `feat(skills): parse the DESIGN.md brand block`.

### Task 13: Module routes declare context docs; receipts carry them and fail closed on drift

Files: `packages/skills/src/skill-module-routes.ts` (+test), `packages/contracts/src/chat-capability-profile.ts`, `apps/gateway/src/services/governed-skill-instruction-service.ts` (+test), `apps/gateway/src/services/workspace-skill-context-docs.ts` (new, +test), `apps/gateway/src/services/gateway-service.ts`.

Produces:
- `SkillModuleResolution.contextDocs?: SkillContextDocType[]` with `SkillContextDocType = "product" | "design"`; every impeccable route declares `["product", "design"]`; other skills declare nothing. `enumerateSkillRoutes` carries the field.
- Contract: `ChatTurnCapabilityActivatedSkillContextDocument { docType: "product" | "design"; scope: "workspace"; sha256: string; bytes: number; truncated: boolean }` and `ChatTurnCapabilityActivatedSkill.contextDocuments?: …[]` (omitted when empty so earlier frozen profiles stay canonical-JSON-equal).
- `SkillContextDocReader = (docType) => { exists: boolean; content: string }` (sync). `createWorkspaceSkillContextDocReader(host: GuidanceDocumentHost, workspaceId)` reads `workspaces/<id>/PRODUCT.md|DESIGN.md` with `resolveGuidancePath` + `readFileSync`; a missing file is `{ exists: false, content: "" }`.
- `buildGovernedActivatedSkillReceipts` takes `contextDocs?: SkillContextDocReader`; `renderGovernedActivatedSkillInstructions` takes the same. `buildReceipt` reads the route's declared docs (freeze) or the frozen receipt's `contextDocuments` doc types (render): for each existing non-blank doc, `sha256` and `bytes` of the full stored content, content cut to the ceiling on a UTF-8 character boundary with `truncated: true` when cut, scanned with `scanPromptwareContent({ source: "memory_context", sourcePath: "workspace-guidance:<docType>" })`; any finding throws `GuidanceSecurityBlockedError` (`failureClass: "guidance_security_blocked"`, `recoveryAction: "review_workspace_guidance"`, message `Workspace <FILE> blocked the turn before provider execution; review it in Settings › Workspaces.`), never `SkillSecurityBlockedError`. The rendered instruction appends `## Project design context: <FILE> (workspace)` sections after the modules, with `[truncated to 6144 bytes]` as the last line when cut; `instructionSha256`/`instructionBytes` cover them. At render time a doc whose `sha256` differs from the frozen receipt throws `Workspace <FILE> changed after this turn's profile froze; send the message again.` before the generic drift check. A frozen receipt without `contextDocuments` never reads docs.
- `gateway-service.ts`: `resolveActivatedSkills` passes `contextDocs: createWorkspaceSkillContextDocReader(this, input.workspaceId)`; `resolveActivatedSkillInstructions` passes one for `profile.identity.workspaceId`.

Steps:
1. Tests first: route test — impeccable routes carry `contextDocs: ["product", "design"]`, coding route carries none. Service test (impeccable harness + a reader stub): with DESIGN.md `"# Design\n\n```brand\nname: Acme\n```"` the receipt has `contextDocuments: [{ docType: "design", scope: "workspace", sha256, bytes, truncated: false }]` and the instruction contains `Project design context: DESIGN.md (workspace)`; no docs → `contextDocuments` absent and the receipt canonical-equal to the no-reader receipt; 9000-byte DESIGN.md → `truncated: true`, injected text ≤ 6144 bytes + marker; DESIGN.md containing `ignore all previous instructions` → throws `GuidanceSecurityBlockedError` with `failureClass "guidance_security_blocked"`; render with a reader whose DESIGN.md changed → throws `/changed after this turn's profile froze/`; render of a receipt without `contextDocuments` with a reader that throws if called → renders. Reader test — reads an existing file, reports missing, never escapes `workspaces/<id>/`.
2. Run the three test files. Expected: new cases fail.
3. Implement; `pnpm --filter @goatcitadel/contracts build`; rerun with `chat-turn-prep-service.governed-skills.test.ts`; gateway + skills typecheck. Expected: pass.
4. Commit: `feat(gateway): inject workspace design context into impeccable turns with hashed receipts`.

### Task 14: Workspace brand reaches deck and document tools

Files: `apps/gateway/src/services/chat-turn-agent-runner.ts` (`ChatTurnAgentRunnerInput.workspaceDesignBrand?: ArtifactBrandInput`; `attachArtifactDesignSkillArgs(toolName, args, userContent, workspaceBrand?)` fills `design.brand` when the design is non-plain and the model supplied no brand), `chat-turn-agent-runner.loop24.test.ts`, `apps/gateway/src/services/gateway-service.ts` (where the runner input is built: when the frozen profile has an activated-skill receipt whose `contextDocuments` includes `design`, read DESIGN.md through the reader and `parseDesignBrandBlock` it; pass the result as `workspaceDesignBrand`; no receipt → undefined), a focused gateway test for that helper (`workspace-design-brand.test.ts`, new, pure helper `resolveWorkspaceDesignBrand(profile, reader)`).

Steps:
1. Tests first: loop24 — a polished `presentations.create` call with no model brand gets `design.brand` equal to the input brand; a model-supplied brand is kept; a plain-format call gets no brand. Helper test — receipt with design context doc + DESIGN.md with a brand block → brand; receipt without context docs → undefined; DESIGN.md without block → undefined.
2. Run; Expected: fail. Implement; rerun with `pnpm --filter @goatcitadel/gateway typecheck`. Expected: pass.
3. Commit: `feat(gateway): apply the workspace brand block to governed artifact tools`.

### Task 15: Cockpit settings section for PRODUCT.md and DESIGN.md

Files: `apps/mission-control-next/src/cockpit/areas/settings/WorkspaceDesignContextSettings.tsx` (new), `WorkspaceDesignContextSettings.test.tsx` (new), `settings-controls.ts` (preloadable + `"workspaces"` list), `SettingsArea.tsx` (render under `case "workspaces"` after `WorkspaceSettings`, keyed by `activeWorkspaceId`), `settings-index.ts` (add `design context product design brand DESIGN.md PRODUCT.md` to the `workspaces` keywords). Cockpit only; no Classic counterpart.

Produces: a `<section aria-label="Design context">` with, per doc (`PRODUCT.md`, `DESIGN.md`): a textarea bound to the workspace guidance content from `fetchWorkspaceGuidance(workspaceId)`, a Save button calling `updateWorkspaceGuidance(workspaceId, docType, content)`, a status line (`Saved`, errors); a help block with `DESIGN_BRAND_BLOCK_EXAMPLE` copy inlined as a string constant in the component (the cockpit depends on contracts only, not on `@goatcitadel/skills`); and an "Apply a generated artifact" control: a select listing the workspace's generated artifacts from `fetchChatGeneratedArtifacts({ workspaceId, kind: "document" })` whose `content` is non-empty, with buttons "Apply as DESIGN.md" / "Apply as PRODUCT.md" that save `<!-- applied from generated artifact <artifactId> contentHash <contentHash> -->\n` + artifact content, so the applied hash is recorded in the document itself.

Steps:
1. Test first (happy-dom; mock `fetchWorkspaceGuidance`, `updateWorkspaceGuidance`, `fetchChatGeneratedArtifacts` from `@goatcitadel/mission-control-shared/api/client`): renders both editors with fetched content; Save sends `("ws-1", "design", edited)`; Apply sends the provenance comment + artifact content and shows `Saved`.
2. Run `pnpm --filter @goatcitadel/mission-control-next exec vitest run src/cockpit/areas/settings/WorkspaceDesignContextSettings.test.tsx`. Expected: fail (module missing). Implement; rerun; `pnpm --filter @goatcitadel/mission-control-next typecheck`. Expected: pass.
3. Commit: `feat(cockpit): add workspace design context settings for DESIGN.md and PRODUCT.md`.

### Task 16: Root DESIGN.md and PRODUCT.md for repo coding agents

Files: `DESIGN.md` (new, root), `PRODUCT.md` (new, root), `AGENTS.md` (one sentence under "How Agents Should Work" pointing at both). Seeded from the sources listed in the Phase 2 section; the cockpit follows impeccable's craft floor (D6); Classic is marked retiring and out of scope; no personal paths; DESIGN.md carries a `brand` block with the GoatCitadel token colors and fonts so the parser has a real example.

Steps:
1. Write both files (DESIGN.md ≤ 12 KiB, PRODUCT.md ≤ 8 KiB). Add the AGENTS.md sentence.
2. `pnpm --filter @goatcitadel/skills exec vitest run src/design-brand.test.ts` with a case that parses the root DESIGN.md brand block (added test-first in this task); `node scripts/validate-governance-docs.mjs`; `node scripts/verify-repo-hygiene.mjs`. Expected: pass.
3. Commit: `docs: add DESIGN.md and PRODUCT.md for repo coding agents`.

### Task 17: Proof lanes and plan ticks

Steps:
1. `pnpm typecheck`, `pnpm docs:check`, `pnpm verify:routed-context:snapshots`, `pnpm verify:runtime:truth`, `pnpm verify:surface:regression`, `git diff --check`. Expected: pass; record any lane that cannot run locally with its reason.
2. Tick the Phase 2 boxes. Commit: `docs(plan): mark impeccable Phase 2 done`.

---

## Phase 3 Task Breakdown (execution order; TDD per task)

Vocabulary: a **design advisory** is `{ ruleId, line, summary, craftFloorRule? }` produced by the deterministic detector from text alone (never from a rendered page); it carries no excerpt of the scanned content. A **design receipt** is an activated-skill receipt in the frozen capability profile whose skill name is `impeccable` or `design-intelligence`. Advisories are always advisory: nothing in this phase blocks a write, fails a turn, or changes a verification lane's status beyond `advisory`.

### Task 18: Detector rules and the shared anti-slop table

Files: `packages/skills/src/design-detector/rules.ts` (new), `detect.ts` (new), `design-detector.test.ts` (new), `packages/skills/src/design-quality.ts` (import `ANTI_SLOP_PATTERNS` from the detector instead of declaring it), `packages/skills/src/index.ts` (export), `THIRD_PARTY_NOTICES.md` (one line: the regex rules approximate impeccable craft-floor rules by id; they are GoatCitadel-authored and are not impeccable's rule engine; no parity claim).

Produces: `ANTI_SLOP_PATTERNS` (the seven existing `{ id, re }` entries, byte-identical ids and regexes), `DESIGN_DETECTOR_RULES: DesignDetectorRule[]` where `DesignDetectorRule = { id, severity: "advisory", summary, craftFloorRule?: string, re: RegExp }` covering the seven anti-slop ids plus: `gradient-text` (`background-clip: text`, `-webkit-background-clip: text`, `bg-clip-text`), `side-stripe-border` (`border-left|right` ≥ 2px, Tailwind `border-[lr]-[2-9]`), `hard-offset-shadow` (`box-shadow` with non-zero offsets and `0` blur), `glass-by-default` (`backdrop-filter: blur`, `backdrop-blur-`), `numbered-section-marker` (`01 / 02`-style markers), `kicker-eyebrow` (`kicker` or `eyebrow` class or element names), `bounce-easing` (`cubic-bezier` with an overshoot fourth value above 1, `ease-*-back`, `elastic`, `bounce`); `detectDesignAdvisories(text, { maxFindings = 8, maxBytes = 1024 })` returning `DesignAdvisory[]` with 1-based line numbers, first occurrence per rule, sorted by line, truncated to the caps (bytes measured on the JSON of the list). Pointers use the craft-floor comment ids (`skill-ban-gradient-text`, `skill-ban-side-stripe-borders`, `skill-ban-hard-offset-shadow`, `skill-ban-glassmorphism-default`, `skill-ban-numbered-section-markers`, `skill-ban-eyebrow-on-every-section`, `skill-ban-glyph-icons`, `skill-motion-floor`, `skill-copy-design-material`, `skill-reflex-theme-by-habit`).

Steps:
1. Test first: one positive and one negative per rule (17 rules), caps (9 distinct hits → 8; a 50-rule-hit file stays ≤ 1024 bytes), no excerpt of the input in any advisory, `ANTI_SLOP_PATTERNS` ids equal the seven known ids. Run `pnpm --filter @goatcitadel/skills exec vitest run src/design-detector.test.ts`. Expected: fails (module missing).
2. Implement; move the table; rerun with `src/design-quality.test.ts`. Expected: pass, design-quality unchanged. Skills typecheck.
3. Commit: `feat(skills): add the deterministic design advisory detector`.

### Task 19: Runner attaches advisories to design-file writes

Files: `apps/gateway/src/services/chat-turn-agent-runner/design-advisories.ts` (new), `design-advisories.test.ts` (new), `apps/gateway/src/services/chat-turn-agent-runner.ts` (result path after `assertNoToolOutputInjection`), `chat-turn-agent-runner.effect-truth.test.ts` or a new focused runner test.

Produces: `buildToolResultDesignAdvisories({ capabilityProfile, toolName, args }): DesignAdvisory[] | undefined` — `undefined` unless the profile holds a design receipt, the tool is `fs.write` or `fs.patch`, and the path ends in `.tsx .jsx .css .html .vue .svelte`; the scanned text is `args.content` for `fs.write` and `args.newText` for `fs.patch` (never a disk read); `[]` when nothing fires is still attached as `designAdvisories: []`? No: attach only when non-empty. The runner patches the executed tool run's `result` with `designAdvisories` and re-runs `assertNoToolOutputInjection` on the patched result.

Steps:
1. Tests first: helper — design receipt + `fs.write` of a `.css` with `background-clip: text` → one advisory; no receipt → undefined; `fs.patch` scans `newText` only; `.ts` path → undefined; a hostile `content` never appears in the advisories. Runner — with a frozen profile carrying an impeccable receipt, an executed `fs.write` of `hero.css` containing gradient text yields `toolRun.result.designAdvisories` with `ruleId: "gradient-text"`; the same write without the receipt has no `designAdvisories`. Expected: fail.
2. Implement; run both tests and `pnpm --filter @goatcitadel/gateway typecheck`. Expected: pass.
3. Commit: `feat(gateway): attach design advisories to governed UI file writes`.

### Task 20: Generated HTML artifacts carry advisories on read

Files: `packages/contracts/src/chat.ts` (`ChatGeneratedArtifactRecord.designAdvisories?: DesignAdvisory[]`, with `DesignAdvisory` declared in contracts and re-used by the detector), `apps/gateway/src/services/chat-generated-artifact-service.ts` (attach for `kind === "html"` on every read and create response; derived, not persisted), `chat-generated-artifact-service.test.ts`.

Ruling recorded here: advisories are derived on read instead of stored, because the artifact table is column-based on SQLite and PostgreSQL and a new column would need a parity migration for an informational field that must track the current rule set anyway.

Steps:
1. Test first: an HTML artifact with `backdrop-filter: blur(8px)` lists `glass-by-default`; a markdown artifact has no field. Expected: fail. Implement; rerun; contracts build; gateway typecheck. Expected: pass.
2. Commit: `feat(gateway): derive design advisories for HTML generated artifacts`.

### Task 21: Cockpit shows per-turn advisories

Files: `apps/mission-control-next/src/cockpit/areas/chat/ChatTurnDetails.tsx`, `ChatTurnDetails.test.tsx` (new). Cockpit only.

Produces: under each tool run that carries `result.designAdvisories`, a `<ul aria-label="Design advisories">` listing `summary` and `line`, prefixed by a one-line "Design advisories (n) · informational" label; nothing renders without the field.

Steps:
1. Test first (happy-dom): a turn with one executed `fs.write` whose result carries two advisories renders both summaries and the count; a turn without advisories renders no such list. Expected: fail. Implement; rerun; mission-control-next typecheck. Expected: pass.
2. Commit: `feat(cockpit): show design advisories on tool activity`.

### Task 22: Ops quality craft-floor check

Files: `packages/skills/src/design-quality.ts`, `design-quality.test.ts`.

Produces: check `mission-control.craft-floor.scan` ("Craft-floor advisory scan") over `apps/mission-control-next/src/cockpit` and `packages/mission-control-shared/src/components`, excluding `features/native-routes` and `features/threaded-surface`, using `DESIGN_DETECTOR_RULES`; `P2`/`advisory` when any file hits, else `P3`/`passing`; `nextAction` lists hit counts per rule id; never `blocking`.

Steps:
1. Test first: fixture with a cockpit file containing `backdrop-blur-md` → advisory; the same text under `features/native-routes` → passing. Expected: fail. Implement; rerun the file; `pnpm verify:design:quality`. Expected: pass with the new check listed.
2. Commit: `feat(skills): add the craft-floor advisory check to design quality`.

### Task 23: Proof lanes and plan ticks

Steps:
1. `pnpm typecheck`, `pnpm verify:design:quality`, `pnpm verify:gateway:async-boundary`, `git diff --check`; focused suites for skills, gateway (helper, runner, artifact service), cockpit. Expected: pass; record any lane that cannot run locally with its reason.
2. Tick the Phase 3 boxes. Commit: `docs(plan): mark impeccable Phase 3 done`.

---

## Phase 4 Task Breakdown (execution order; TDD per task)

Vocabulary: a **render** is a PNG of an `html` generated artifact at one viewport (`desktop` 1440×900 or `phone` 390×844), produced headless with JavaScript off, offline, under the Mission Control baseline CSP. Renders are stored as chat attachments of the artifact's session (file name `render-<first 16 hex of contentHash>-<viewport>.png`, `image/png`, analysis skipped), so the artifact record is never changed and the existing attachment routes serve the bytes. A **critique** is a normal operator turn in the artifact's session whose content is `@skill impeccable critique` plus the artifact title, with the renders attached when the session's route provider is capability-detected as vision-capable, otherwise a text-only critique whose content says `(not visually inspected: the current model has no vision capability)`.

### Task 24: Playwright runtime module

Files: `packages/policy-engine/src/playwright-runtime.ts` (new), `playwright-runtime.test.ts` (new), `browser-tools.ts` (imports instead of defining), `packages/policy-engine/src/index.ts` (export).

Produces: `loadPlaywright()`, `launchPlaywrightChromium(playwright, headless)`, `BROWSER_CHROMIUM_SECURITY_ARGS`, `BROWSER_CHROMIUM_MANUAL_REQUIRED_DIAGNOSTIC_CODE/MESSAGE`, `isMissingPlaywrightBrowserError`, `browserChromiumManualRequiredError` moved byte-for-byte; `browser-tools.ts` re-exports the two diagnostic constants it exported before.

Steps:
1. Test first: a mocked `playwright` whose `chromium.launch` rejects with `browserType.launch: executable doesn't exist` makes `launchPlaywrightChromium` throw the manual-install diagnostic; a successful launch passes `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`; an import failure makes `loadPlaywright` throw the same diagnostic. Expected: fail (module missing).
2. Implement the move; run the new test plus `browser-tools.manual-chromium.test.ts` and `browser-tools-load-failure.coverage.test.ts`; policy-engine typecheck. Expected: pass unchanged.
3. Commit: `refactor(policy-engine): extract the Playwright runtime from browser tools`.

### Task 25: HTML snapshot renderer

Files: `packages/policy-engine/src/html-render.ts` (new), `html-render.test.ts` (new), `packages/policy-engine/src/index.ts` (export).

Produces: `renderHtmlSnapshot({ html, viewports?, outputDir, writeJailRoots, signal?, timeoutMs? })` → `{ renders: Array<{ viewport, width, height, path, sha256, bytes }>, contentSecurityPolicy }`. Rules: `assertWritePathInJail(outputDir, writeJailRoots)` before any browser work; HTML over `HTML_RENDER_MAX_BYTES` (512 KiB) throws `html_render_too_large`; the page context is `javaScriptEnabled: false`, `offline: true`, and `context.route("**/*", abort)` for every scheme except `data:` and `about:`; a `<meta http-equiv="Content-Security-Policy">` equal to `MISSION_CONTROL_BASELINE_CSP` (exported from this module as the gateway's baseline string with `font-src 'self' data:`, see Task 30) is injected into `<head>`; viewports default to desktop 1440×900 and phone 390×844; `page.setContent` with `waitUntil: "load"` and a 15 s default timeout; missing Chromium surfaces the Task 24 diagnostic unchanged; `signal` aborts between steps.

Steps:
1. Tests first: jail rejection throws before launching (mock `loadPlaywright` and assert it was not called); size cap throws `html_render_too_large`; missing-Chromium diagnostic propagates from a mocked launch; one real render (Chromium is installed here): an HTML page with an `<img src="https://example.test/x.png">` and `<script>document.title="js"</script>` renders two PNGs under a temp jail root, each starting with the PNG signature, the desktop one 1440 px wide, and the page title stays the authored one (JS ran not), with the blocked request recorded in `renders[].blockedRequests`. Expected: fail.
2. Implement; run the test; policy-engine typecheck. Expected: pass.
3. Commit: `feat(policy-engine): render HTML artifacts to offline sandboxed snapshots`.

### Task 26: Gateway render service and route

Files: `apps/gateway/src/services/html-artifact-render-service.ts` (new, +test), `apps/gateway/src/routes/chat.artifact-render.ts` (new, +test), `apps/gateway/src/routes/chat.ts` (register), `apps/gateway/src/services/gateway-route-composition-chat.ts` + `chat-sessions-route-service.ts` (dependency surface), `packages/contracts/src/chat.ts` (`ChatArtifactRenderRecord { artifactId, contentHash, viewport, attachmentId, sha256, width, height, createdAt }` and `ChatArtifactRenderResponse { artifactId, contentHash, renders }`), `packages/mission-control-shared/src/api/chat.ts` (`renderChatGeneratedArtifact(artifactId, workspaceId)`, `listChatArtifactRenders(artifactId, workspaceId)`).

Produces: `POST /api/v1/chat/generated-artifacts/:artifactId/renders` (body `{ workspaceId }`): loads the artifact through `getChatGeneratedArtifact` (workspace-bound), rejects non-`html` kinds and redacted projections with 409, renders into a temp directory inside the workspace write jail, stores each PNG through the chat attachment service with analysis skipped, and returns 201 with the render records; repeated calls for the same `contentHash` return the existing attachments (lookup by session attachments whose file name starts with `render-<hash16>-`) without rendering again. `GET …/renders` returns the stored records. Mutation routes carry `config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } }` and the idempotency plugin markers like the other chat mutations.

Steps:
1. Tests first: route test (mocked services, model `chat.sessions.test.ts`): POST without `workspaceId` is 400; POST for a markdown artifact is 409; POST for an html artifact calls the service with `(artifactId, workspaceId)` and returns 201 with the records; GET returns the list. Service test: stores two attachments named `render-<hash16>-desktop.png` / `-phone.png` with `analysisStatus: "skipped"` and returns them; a second call reuses them (renderer called once). Expected: fail.
2. Implement; run both tests; gateway typecheck; `pnpm verify:gateway:async-boundary`. Expected: pass.
3. Commit: `feat(gateway): render HTML generated artifacts to attached PNG evidence`.

### Task 27: Model-authored HTML documents gated on a design receipt

Files: `packages/policy-engine/src/document-artifacts.ts` (+test), `tool-registry.ts` (`documents.create` gains optional `html: { type: "string" }` with a usage hint "only with a governed design receipt"), `artifact-design.ts` (`ArtifactDesignReport.markup?: "template" | "model-authored"` and `designAdvisories?: DesignAdvisory[]`), `apps/gateway/src/services/chat-turn-agent-runner.ts` (`attachArtifactDesignSkillArgs` deletes `args.html` when the turn has no design receipt; the receipt check reuses `hasDesignSkillReceipt` from Phase 3) + loop24 test.

Produces: with `format: "html"` and a string `html` argument that contains `<html` or `<!doctype`, capped at 512 KiB, the document is written verbatim (after `escapeHtml` is NOT applied) and the design report records `markup: "model-authored"` plus the detector's advisories; without `html` the template path runs with `markup: "template"`.

Steps:
1. Tests first: `document-artifacts.test.ts` — model-authored html is written verbatim and reported; oversize html throws; the template path reports `markup: "template"`. Runner test — `documents.create` args with `html` are stripped without a receipt and kept with one. Expected: fail.
2. Implement; run policy-engine + gateway tests; typechecks. Expected: pass.
3. Commit: `feat(artifacts): accept model-authored HTML documents under a design receipt`.

### Task 28: Critique turn and the trimmed critique reference

Files: `apps/gateway/src/services/html-artifact-render-service.ts` (`critiqueArtifact`), `apps/gateway/src/routes/chat.artifact-render.ts` (`POST …/critique`), `scripts/sync-impeccable.mjs` (vendor `reference/critique.md` with the launcher loop, critique-storage, and detect references removed), `skills/bundled/impeccable/reference/critique.md` (+ `UPSTREAM.md`, `NOTICE` regenerated by the script), `packages/skills/src/bundled-skill-lock.generated.ts` (`pnpm update:skills:lock`), `packages/skills/src/skill-module-routes.ts` (`critique` joins `IMPECCABLE_COMMANDS`, loads `main` + `critique`), `routing-hints.generated.ts` (command summary), `packages/mission-control-shared/src/api/chat.ts` (`critiqueChatGeneratedArtifact`).

Produces: `POST /api/v1/chat/generated-artifacts/:artifactId/critique` (body `{ workspaceId }`): ensures renders exist (rendering if needed), resolves the session's effective route and the provider's `capabilities.vision`, and sends an operator turn through the same service the agent-send route uses, with the render attachment ids when vision is available or the text-only marker otherwise; returns 202 with `{ sessionId, turnId, visuallyInspected }`. The upstream clone is re-created at `.tmp/upstream/impeccable` at the pinned SHA before syncing; the sync test gains the critique transforms.

Steps:
1. Tests first: sync test fixture for `critique.md` (launcher lines and the `impeccable critique-storage` references removed, prose kept); route/service test: vision provider → attachments present and `visuallyInspected: true`; non-vision → no attachments and the marker in the content; route table test: `@skill impeccable critique` → `main` + `critique`. Expected: fail.
2. Implement; re-vendor; `pnpm update:skills:lock`; run `pnpm verify:skills:catalog`, the gateway tests, skills tests; typechecks. Expected: pass.
3. Commit: `feat(design): critique rendered HTML artifacts through a governed chat turn`.

### Task 29: Cockpit render and critique actions

Files: `apps/mission-control-next/src/cockpit/ui/ArtifactRenderActions.tsx` (new, +test), `cockpit/areas/chat/ChatInspector.tsx`, `cockpit/areas/library/LibraryResourceDetail.tsx`, `cockpit/areas/work/RunArtifacts.tsx` (render the actions beside each `GeneratedArtifactViewer` for `html` artifacts).

Produces: two buttons, "Render" and "Critique render", a status line, and the rendered PNGs shown as `<img>` from `/api/v1/chat/attachments/<id>/content` with the viewport as alt text; the critique button reports "Critique sent to the conversation" and, when the model has no vision, "(sent without images: the current model has no vision capability)". Non-html artifacts render nothing. Classic shell untouched.

Steps:
1. Test first (happy-dom, mocked shared API): Render calls the API and shows two images; Critique shows the sent message and the vision marker from the response; a markdown artifact renders no actions. Expected: fail.
2. Implement; run the test and the three touched areas' existing tests; mission-control-next typecheck. Expected: pass.
3. Commit: `feat(cockpit): render and critique HTML artifacts from the viewer`.

### Task 30: Preview CSP (D4)

Files: `apps/gateway/src/app.ts` (`font-src 'self' data:`), `apps/gateway/src/app.test.ts` or the CSP test that pins the baseline, `DESIGN.md` (the font sentence), `docs/1_0_CONTRACT.md` (one sentence on the preview policy and the font limit).

Steps:
1. Test first: the baseline CSP test expects `font-src 'self' data:`. Expected: fail. Implement; rerun; `node scripts/validate-governance-docs.mjs`. Expected: pass.
2. Record in the ledger how the preview CSP was verified: `srcdoc` iframes inherit the embedding document's policy, so the packaged shell (served by the gateway) applies the baseline and the Vite dev server applies none unless configured; note it in the contract sentence.
3. Commit: `feat(gateway): allow embedded fonts in the baseline preview policy`.

### Task 31: Proof lanes and plan ticks

Steps:
1. `pnpm typecheck`, `pnpm verify:gateway:async-boundary`, `pnpm verify:auth:matrix`, `pnpm verify:skills:catalog`, `pnpm verify:surface:regression`, `pnpm verify:visual:regression` (report, do not rebaseline), `git diff --check`; focused suites. A browser proof: render one HTML artifact through the new route and attach the PNG path to the ledger. Expected: pass; record any lane that cannot run locally with its reason.
2. Tick the Phase 4 boxes. Commit: `docs(plan): mark impeccable Phase 4 done`.

## Phase 5 Task Breakdown (execution order; TDD per task)

Phase 5 is independent of Phases 1–4 and branches from `main`. It changes only `packages/policy-engine` renderers and their tests. Before/after renders of the sample deck (PPTX via PowerPoint PNG export, PDF, DOCX) are the visual proof attached to the PR.

### Task 32: Preset by request only

Files: `packages/policy-engine/src/artifact-design.ts`, `artifact-design.test.ts`, `tool-executor-tail.coverage.test.ts`.

Produces: `resolvePreset` returns the explicit `preset` when supplied, else `clean-professional`; the content regex table is gone. The `pitch` preset uses `0F766E` accent and `99F6E4` border (no `7C3AED`). The `design-skill-applied` validation detail reads "Injected governed impeccable design instructions (<register>, <lifecycle>): <skillId> [<modules>]" from the receipt, never "planned".

Steps:
1. Test first: a wellness-flavoured title with no preset resolves `clean-professional`; `preset: "wellness"` still resolves `wellness`; the pitch tokens contain no `7C3AED`; the applied detail lists the receipt modules. Expected: fail. Implement; rerun `artifact-design.test.ts` and the tail coverage test (one expectation pinned the regex-chosen preset). Expected: pass.
2. Commit: `feat(artifact-design): default to clean-professional and report injected modules`.

### Task 33: PPTX frame and containers

Files: `packages/policy-engine/src/presentation-pptx-renderers.ts`, `presentation-pptx-fallback.ts`, `presentation-pptx.test.ts`.

Produces: `drawSlideFrame` draws no 0.13 in accent stripe; `gc:slide-number` is regular weight in `mutedText` at 10 pt (the package audit's semantic font floor for that object; the brief's 9 pt would fail it); `drawImageTextSlide` and `drawStackedListSlide` draw bullets on the background with no roundRect card; two-column and comparison keep their cards; the fallback writer's slide number is regular weight.

Steps:
1. Test first (recording pptxgenjs mock): no shape with `x: 0, w: 0.13`; one quiet slide number per rendered slide; zero roundRects on image-text/stacked-list slides and at least one on two-column; the fallback zip's slide-number run is not bold. Expected: fail. Implement; rerun `presentation-pptx.test.ts`, `presentation-pptx-audit.test.ts`, `tool-executor-tail.coverage.test.ts`, `scripts/verification/lib/pptx-package-audit.test.mjs`. Expected: pass.
2. Commit: `feat(pptx): quiet the slide frame and drop the default body card`.

### Task 34: PDF frame and containers

Files: `packages/policy-engine/src/presentation-pdf.ts`, `presentation-pdf.test.ts`.

Produces: no 9.4 pt stripe; the page number is set in the regular face (`/F1`) in `theme.muted`; stacked pages draw bullets on the background (no `55 54 836 382 re B` card); the cover has no three-rectangle motif.

Steps:
1. Test first (content streams): no ` 9.4 540 re`; regex for a regular-face `(02)` page number and none in `/F2`; no ` 150 110 re`; no stacked card rect; layout names include `image-text`. Expected: fail. Implement; rerun `presentation-pdf.test.ts`. Expected: pass.
2. Commit: `feat(pdf): quiet the deck frame and drop the default body card`.

### Task 35: No placeholder visuals

Files: `packages/policy-engine/src/presentation-pptx.ts`, `presentation-pptx-renderers.ts`, `presentation-pdf.ts`, `document-artifacts.ts`, `artifact-design.ts`, `tool-executor/artifact-executor.ts`, `tool-registry.ts`, `document-artifacts.hero.test.ts` (new), `presentation-pptx.test.ts`, `tool-executor-tail.coverage.test.ts`, `artifact-design.test.ts`.

Produces: `PresentationSlideVisual.dataUri` is optional; with no provider asset a visual is `{ source: "none", altText }`; `buildAbstractVisualDataUri`, its hash helpers, and the pptx `sharp` import are gone; the PPTX has no file under `ppt/media/` and `usedAssetIds` is `["built-in-shapes-icons"]` with `visualCount: 0`; the DOCX hero `ImageRun`, `buildDocxVisualBuffer`, and its `sharp` import are gone (no `word/media/`); the hero layout spans the slide when it has no image; the asset plan's `renderer-generated-visual` entry reads "configured image provider" and is `skipped` with reason "No provider image was supplied; the artifact ships without placeholder visuals." when unused; residual risks and the asset-specificity findings say the artifact ships without visuals (no "local renderer" claim); the tool hint says the same.

Steps:
1. Test first: `document-artifacts.hero.test.ts` (DOCX no media; PPTX no media file, built-in asset only, `visualCount` 0; report marks the generated asset skipped with that reason); pptx tests expect `source: "none"` and no `dataUri` without an asset; the tail coverage docx test expects no `word/media/`. Expected: fail. Implement; rerun those files plus `presentation-pdf.test.ts`, `artifact-design.test.ts`, `presentation-pptx-audit.test.ts`, and gateway `chat-turn-agent-runner.loop24.test.ts`; policy-engine typecheck. Expected: pass.
2. Commit: `feat(artifacts): drop the hashed placeholder visuals`.

### Task 36: After renders and lanes

Steps:
1. Render the sample deck/PDF/DOCX "after" set with the same script as the "before" set and export the PPTX slides to PNG through PowerPoint. Compare: if a layout reads worse without the placeholder art (an empty panel card, for instance), fix it under TDD and commit it as its own `feat(artifacts)` commit.
2. `pnpm typecheck`, `pnpm verify:research-artifact:reliability`, `pnpm verify:research-artifact:powerpoint`, `pnpm verify:ux:budgets`, `pnpm verify:visual:regression` (report only; never rebaseline), `pnpm verify:design:quality`, `git diff --check`. Expected: pass; record any lane that is red for a pre-existing reason with the evidence.
3. Tick the Phase 5 boxes. Commit: `docs(plan): mark impeccable Phase 5 done`.

## Phase 6 Task Breakdown (execution order; TDD per task)

Phase 6 lands in two pull requests: Tasks 37–41 (docs, design-quality checks, craft-floor cleanup, proof) in one, and Task 42 (delete `design-intelligence`) as the small follow-up the plan calls for, once the first has merged and nothing reads that directory any more.

### Task 37: Design-quality checks follow impeccable

Files: `packages/skills/src/design-quality.ts`, `design-quality.test.ts`.

Produces: `readDesignQualityEvidence` reads `skills/bundled/impeccable`. `REQUIRED_SKILL_MODULES` = `SKILL.md`, `reference/craft-floor.md`, `reference/artifacts.md`, `reference/critique.md`, `reference/critique/01-reference-material.md`, `reference/audit.md`, `reference/polish.md` (the modules the routes in `skill-module-routes.ts` load). `REQUIRED_SKILL_PHRASES` = `Vendored from`, `PRODUCT.md`, `DESIGN.md`, `Core principles`, `Not available in this vendored build`. `REQUIRED_ROUTING_PHRASES` = `design quality`, `anti-slop`, `visual polish`, `design-system audit`, `document design`, `presentation design`, `pptx deck`, `html artifact`. Check ids: `impeccable.modules` (P0/blocking when a module is missing), `impeccable.lifecycle` (P1/advisory when a phrase is missing), `impeccable.placeholders` (P0/blocking on a broken local link or placeholder), new `impeccable.provenance` (P0/blocking unless `UPSTREAM.md`, `LICENSE`, and `NOTICE` exist and `UPSTREAM.md` names a 40-hex commit), new `impeccable.launcher-strings` (P0/blocking when any injectable file contains `{{`, `npx impeccable`, `impeccable detect|pin|hooks|context|doctor`, `~/.impeccable`, `.impeccable/`, `grok`, `xai`, or `x.ai`), new `impeccable.artifacts-budget` (P1/advisory when `reference/artifacts.md` exceeds 8 KiB). The routing check's next action names impeccable. Every other check is unchanged.

Steps:
1. Test first: the fixture builder writes an impeccable tree (SKILL.md with the phrases, the seven modules, `UPSTREAM.md` with `Commit: \`<40 hex>\``, `LICENSE`, `NOTICE`); the complete fixture passes with the three new ids present; a missing `reference/craft-floor.md` blocks `impeccable.modules`; a broken link blocks `impeccable.placeholders`; a missing `NOTICE` blocks `impeccable.provenance`; `npx impeccable` in a module blocks `impeccable.launcher-strings`; a 9 KiB `artifacts.md` makes `impeccable.artifacts-budget` advisory. Expected: fail. Implement; rerun the file; `pnpm verify:design:quality` on the real tree. Expected: pass with the raw-color budget unchanged.
2. Commit: `feat(skills): point the design-quality checks at impeccable`.

### Task 38: Contract and state model

Files: `docs/1_0_CONTRACT.md`, `docs/CANONICAL_RUNTIME_STATE_MODEL.md`.

Produces: one contract paragraph after the document-editing paragraph: impeccable prose vendored at a pinned commit with no launcher or binary; module receipts name the injected modules and workspace context documents; the runtime design detector is an advisory subset, never impeccable's engine; renders are evidence, not a quality claim; vision critique is capability-gated. Line 34 (`$` alias) is unchanged because `$` handling did not change. The state model's skill section gains one sentence: receipts carry `contextDocuments` (`docType`, `scope`, `sha256`, `bytes`, `truncated`) for the workspace `PRODUCT.md` / `DESIGN.md` a route injected.

Steps:
1. `pnpm docs:check` before and after. Expected: pass both times (no verbatim-README phrase is touched).
2. Commit: `docs: describe the impeccable design layer in the contract and state model`.

### Task 39: Cockpit craft-floor alignment (D6)

Files: `packages/mission-control-shared/src/components/CommandPalette.tsx`, `GatewayAccessGate.tsx`, `PageErrorBoundary.tsx`, `chat/GeneratedArtifactViewer.tsx`, `apps/mission-control-next/src/cockpit/areas/chat/chat-build-editor.css`, `apps/mission-control-next/src/cockpit/styles/cockpit.css`, and the tests that assert the removed labels.

Produces: the four kicker `<p>` elements (`Command Center`, the access-gate kicker, `Page unavailable`, `Generated artifact`) are gone where the heading already carries the meaning; the `.cockpit-build-editor .mc-next-panel-kicker`, `.cockpit-chat-documents .mc-next-panel-kicker`, and `.cockpit-chat-documents .generated-artifact-kicker` rules are gone. Classic also renders the four components, so its visual baselines shift in the same all-or-nothing rebaseline; no other Classic file changes.

Steps:
1. Test first: the component tests assert the kicker text is absent and the heading is present. Expected: fail. Implement; rerun the shared and cockpit test files; `pnpm verify:design:quality` (the kicker-eyebrow advisory count drops). Expected: pass.
2. Commit: `refactor(ui): drop the kicker labels the headings already carry`.

### Task 40: Ops Quality copy and README

Produces: `QualityDesign.tsx` renders whatever checks the evidence returns, so the new ids appear without a copy change; the README verification table is unchanged because no lane name changed. Both are verified by reading, and recorded in the ledger as rulings if no edit is needed.

### Task 41: Proof lanes and plan ticks

Steps:
1. `pnpm docs:check`, `pnpm verify:design:quality`, `pnpm verify:skills:catalog`, `pnpm verify:fast` (or its gateway/skills/ui shards when the full lane cannot run locally), `pnpm verify:visual:regression` (report; rebaseline only when every page passes), `git diff --check`. Expected: pass; record any lane that is red for a pre-existing reason with the evidence.
2. Tick the Phase 6 boxes except the deletion. Commit: `docs(plan): mark impeccable Phase 6 docs and checks done`.

### Task 42: Delete design-intelligence (follow-up PR)

Files: `skills/bundled/design-intelligence/` (delete), `skills/catalog-coverage.json`, `packages/skills/src/bundled-skill-lock.generated.ts` (via `pnpm update:skills:lock`), `packages/skills/src/routing-hints.generated.ts` and `activation.test.ts`, `packages/mission-control-shared/src/components/chat/chat-tool-diagnostics.ts` and its test (copy says "design instructions"), plus a dual-lineage test that a stale `bundled:design-intelligence` lifecycle row is tolerated by `listSkills` and the Library skills view on an upgraded install.

Steps:
1. Test first: the stale-row test on both the fresh and the upgraded lineage. Expected: fail or not apply; implement; `pnpm verify:skills:catalog`, the skills and gateway skill suites, `pnpm verify:design:quality`. Expected: pass.
2. Commit: `chore(skills): retire the design-intelligence skill`. Tick the last Phase 6 box.
