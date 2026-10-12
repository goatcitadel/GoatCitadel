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

- [ ] Modify `packages/contracts/src/workspaces.ts` `GuidanceDocType`: add `"product" | "design"`.
- [ ] Modify `apps/gateway/src/services/guidance-doc-files.ts`: map to `PRODUCT.md` and `DESIGN.md`.
- [ ] Modify `apps/gateway/src/services/guidance-service.ts`: add both to `WORKSPACE_GUIDANCE_DOC_TYPES`; do not add to `RUNTIME_GUIDANCE_DOC_TYPES` (the 6000-character shared budget must not be spent on design text every turn); exclude from global listing and global writes (D3).
- [ ] Modify `apps/gateway/src/routes/workspaces.ts`: add both to the workspace zod enum only.
- [ ] Modify `governed-skill-instruction-service.ts`: when a module route declares `contextDocs`, read the workspace docs; scan them with a distinct guidance-security error (not "skill security"); truncate deterministically to about 6 KiB each with a `truncated` flag; append a "Project design context" section; record `contextDocuments?: [{docType, scope, sha256, bytes, truncated}]` in the receipt.
- [ ] Modify `packages/contracts/src/chat-capability-profile.ts`: optional receipt field, omitted when empty so earlier frozen profiles stay canonical-JSON-equal.
- [ ] Brand block: define a small fenced block in DESIGN.md (name, up to six hex colors, up to three font names, optional logo path inside the workspace jail) parsed by a pure helper in `packages/skills`; `attachArtifactDesignSkillArgs` fills `design.brand` from it when the turn has a design receipt and the model supplied none, so `artifact-design.ts` `applyBrandColors`/`resolveTypography` use the workspace brand for decks and documents.
- [ ] Writing the documents (`init` / `document` commands): the model drafts PRODUCT.md/DESIGN.md as a normal reply; the operator saves it as a generated artifact (existing `createChatGeneratedArtifactFromTurn`); a new explicit operator action "Apply as workspace DESIGN.md / PRODUCT.md" calls `updateWorkspaceGuidance` and records the artifact hash. Add a minimal guidance editor plus apply control as a new cockpit settings section (`apps/mission-control-next/src/cockpit/areas/settings/WorkspaceDesignContextSettings.tsx`, following `AppearanceSettings.tsx` patterns), since no guidance editor UI exists in the cockpit today. No Classic counterpart.
- [ ] Create root `DESIGN.md` and `PRODUCT.md` for repo coding agents only, seeded from `docs/superpowers/specs/2026-09-27-mission-control-cockpit-design.md`, `docs/superpowers/specs/2026-09-22-goatcitadel-mark-and-icons-design.md`, `docs/review/mission-control-claude-design-convergence-audit.md`, `apps/mission-control-next/src/styles/mission-control-next-tokens.css`, `apps/mission-control-next/src/cockpit/styles/cockpit-tokens.css`, and the AGENTS.md North Star / UI-UX Direction sections; the cockpit follows impeccable's craft floor (D6) and Classic is marked retiring and out of scope. One sentence in AGENTS.md pointing to them.

### Tests

- [ ] `guidance-service.test.ts`: workspace-only types; global listing excludes them.
- [ ] `routes/workspaces.test.ts`: enum.
- [ ] Receipt test: context hash drift fails closed with a clear message; old receipts unaffected.
- [ ] Mission Control component test for the apply action.

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

- [ ] Create `packages/policy-engine/src/playwright-runtime.ts`: move and export `loadPlaywright` and `launchPlaywrightChromium` (with the existing WebRTC security args) out of `browser-tools.ts`, which then imports them.
- [ ] Create `packages/policy-engine/src/html-render.ts` with `renderHtmlSnapshot({ html, viewports, outputPath, writeJailRoots, signal })`: `assertWritePathInJail`; HTML size cap (about 512 KiB) and timeout; `javaScriptEnabled: false` to match the preview's `sandbox=""`; `offline: true` and block every route except `data:` and `about:`; inject a CSP `<meta>` equal to the Mission Control baseline so the critique sees what the operator sees; PNG at 1440×900 and 390×844 plus optional `page.pdf()`; missing Chromium returns the existing manual-install diagnostic.
- [ ] Create gateway `html-artifact-render-service.ts` and route `POST /api/v1/chat/artifacts/:artifactId/render`: workspace-bound, idempotency plugin, rate-limited. PNGs stored as evidence linked to the artifact `contentHash`; the artifact itself is never changed (`1_0_CONTRACT.md` line 42 holds).
- [ ] Modify `packages/policy-engine/src/document-artifacts.ts` and `tool-registry.ts`: `documents.create` with `format: "html"` accepts an optional full `html` document argument when the turn carries a design receipt; the detector runs on it; the design report records `markup: "model-authored"` instead of the ten-rule template. Without a receipt the existing template path stays.
- [ ] Critique: an explicit operator action opens a normal Chat turn with `@skill impeccable critique` and the PNGs attached, only when the route model is capability-detected as vision-capable; otherwise a text-only critique labelled "not visually inspected". A follow-up produces a new artifact version; nothing edits in place. This phase also re-vendors a trimmed `critique` reference without the launcher loop.
- [ ] Cockpit only: "Render" and "Critique render" actions beside the three cockpit `GeneratedArtifactViewer` uses: `cockpit/areas/chat/ChatInspector.tsx`, `cockpit/areas/library/LibraryResourceDetail.tsx`, `cockpit/areas/work/RunArtifacts.tsx`. The Classic consumers (`features/threaded-surface/*`, `features/native-routes/library/LibraryArtifactsSection.tsx`) are left untouched.
- [ ] D4: verify the preview CSP in both dev (Vite) and packaged shells; document the font limit.

### Tests

- [ ] `html-render.test.ts`: jail rejection, blocked network request, JS disabled, size cap, missing-Chromium diagnostic (model on `browser-tools.manual-chromium.test.ts`).
- [ ] Route tests: auth, workspace scope, idempotency.
- [ ] `document-artifacts.test.ts`: raw-HTML path gated on receipt.
- [ ] Mission Control component test for the actions.

### Proof

Focused vitest, `pnpm verify:surface:regression`, `pnpm verify:visual:regression`, `pnpm verify:auth:matrix`, plus a browser proof screenshot of a rendered artifact.

### Out of scope

A new preview component; running JavaScript in renders; replacing `presentations.create` with an HTML-first deck; live mode.

---

## Phase 5: Native renderer craft (impeccable cannot do this)

- [ ] Modify `packages/policy-engine/src/presentation-pptx-renderers.ts`: remove the 0.13-inch accent side stripe and the bold accent `01` slide number; quiet page number; drop the bordered card as the default body container on narrative slides. Update `presentation-pptx-audit.ts`, `presentation-pptx-fallback.ts`, and `scripts/verification/lib/pptx-package-audit.mjs` together (the audit keys on `gc:slide-number` and `gc:layout:`).
- [ ] Modify `packages/policy-engine/src/presentation-pdf.ts` for the same frame and container changes.
- [ ] Modify `packages/policy-engine/src/artifact-design.ts`: stop choosing a preset by content regex; default `clean-professional` unless an explicit `preset` or `brand` is supplied; replace `7C3AED` in the `pitch` preset; make `design-skill-applied` report the injected module list from the receipt rather than "planned".
- [ ] Modify `packages/policy-engine/src/presentation-pptx.ts` and `document-artifacts.ts`: replace the hashed SVG blob with no visual or a typographic treatment when no provider image exists; never ship the blob as a DOCX hero.
- [ ] PDF font embedding (`pdf-writer.ts`, Helvetica only) is flagged as a separate large item; not bundled here.

### Tests

- [ ] `presentation-pptx.test.ts`, `presentation-pptx-audit.test.ts`, `presentation-pdf.test.ts`, `artifact-design.test.ts`, `document-artifacts.test.ts`, `pptx-package-audit.test.mjs`.

### Proof

`pnpm verify:research-artifact:reliability`, `pnpm verify:research-artifact:powerpoint` (Windows), `pnpm verify:ux:budgets`, `pnpm verify:visual:regression` (re-baselining is all-or-nothing), plus rendered before/after deck PNGs attached to the PR.

### Out of scope

DOCX theming beyond the blob removal; PDF font embedding.

---

## Phase 6: Docs, contract, evidence

- [ ] `docs/1_0_CONTRACT.md`: one paragraph on the design layer: vendored impeccable prose at a pinned SHA with no launcher or binary; module receipts; the advisory detector is a subset, not impeccable's engine; rendering is evidence, not a quality claim; vision critique is capability-gated. Line 42 stays. Fix line 34 if `$` handling changes.
- [ ] `docs/CANONICAL_RUNTIME_STATE_MODEL.md`: receipts with `contextDocuments`.
- [ ] `packages/skills/src/design-quality.ts`: switch `REQUIRED_SKILL_MODULES`, `REQUIRED_SKILL_PHRASES`, and `REQUIRED_ROUTING_PHRASES` to the impeccable module set and routing entry; add impeccable checks (`UPSTREAM.md`, `LICENSE`, `NOTICE` present; no launcher strings; no broken links; `artifacts.md` ≤ 8 KiB).
- [ ] Delete `skills/bundled/design-intelligence/` in a small follow-up PR after D1 has shipped, and remove `bundled:design-intelligence` from `skills/catalog-coverage.json`. Confirm a stale lifecycle row for a skill that no longer loads is tolerated by `listSkills` and the Library skills view on an upgraded install (dual-lineage test).
- [ ] Cockpit craft-floor alignment (D6): remove the kicker label from the four shared components the cockpit embeds (`packages/mission-control-shared/src/components/CommandPalette.tsx`, `GatewayAccessGate.tsx`, `PageErrorBoundary.tsx`, `chat/GeneratedArtifactViewer.tsx`) where the heading already carries the meaning, and drop the three cockpit CSS hooks (`cockpit/areas/chat/chat-build-editor.css`, `cockpit/styles/cockpit.css`). Classic also renders those four components, so its baselines shift in the same all-or-nothing visual rebaseline; no other Classic file is touched.
- [ ] Ops Quality UI copy in the cockpit (`cockpit/areas/system/quality/QualityDesign.tsx`) lists the new checks; the Classic `QualityDashboardRoutePage.tsx` is not updated.
- [ ] README verification table: mention the new checks only if a lane name changes.

### Proof

`pnpm docs:check`, `pnpm verify:design:quality`, `pnpm verify:skills:catalog`, `pnpm verify:fast`, `git diff --check`.

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
