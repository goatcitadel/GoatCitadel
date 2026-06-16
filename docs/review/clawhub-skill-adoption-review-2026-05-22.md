# ClawHub Skill Adoption Review

Reviewed: 2026-05-22

Scope: read-only review of the listed ClawHub skills against the current GoatCitadel repo shape. This is not an install plan. The goal is to decide which ideas should be absorbed natively, which existing systems already cover the need, and which skills should stay reference-only because they conflict with GoatCitadel's approval, policy, runtime-truth, or local-first posture.

## Executive Take

Do not bulk-import these skills as repo-managed runnable skills. Most of the value is conceptual and overlaps GoatCitadel's existing gateway-owned runtime, memory lifecycle, skill import validation, proactive scheduler, managed voice runtime, integration catalog, and A2UI/canvas direction.

The right posture is still: reference first, proposal-backed, inspectable before callable.

Highest-value native ideas:

1. Add a typed memory and relationship layer under `MemoryLifecycleService`, inspired by `ontology`, without allowing raw `memory/ontology/*.jsonl` writes from the UI or skills.
2. Add decision records and retrospectives to the improvement/memory system, inspired by `neosoul-decision-agent`, with confidence, assumptions, reversibility, and outcome review.
3. Strengthen proactive scheduling with an explicit "prompted notification" vs "autonomous durable run" distinction, from `proactive-agent`.
4. Add an Automation Designer flow in Cowork/Ops, from `automation-workflows`, that converts repeated work into governed recipes, cron candidates, and proof requirements.
5. Add a global-only governed search broker, from `multi-search-engine`, but remove the Chinese/domestic engines and avoid cookie-harvesting search scraping.
6. Convert `auto-updater` into an update review scout: check versions, produce a diff/risk/proof plan, and require approval before updating.
7. Treat `desktop-control` as a future high-risk capability family, not a skill import.
8. Keep `openai-whisper` as documentation/input inspiration only because GoatCitadel already has managed `whisper.cpp`.
9. Fold `humanizer`, `superdesign`, and `ui-ux-pro-max` into style review, prompt-pack checks, and frontend guidance, not runtime tools.
10. Use the `canvas` update as a concrete A2UI proof/reference, but keep claims limited until device-node presentation is implemented and proven end to end.

## Repo Reality Anchors

- `apps/mission-control-next` is the canonical shell; `apps/mission-control` is compatibility-only.
- The gateway owns runtime truth, integrations, approvals, memory, policy, durable execution, and runtime APIs.
- `MemoryLifecycleService` is already the operator-facing memory owner for context, learned memory, item list/edit/forget/history, dedupe, scope, and write policy.
- The skill import path already has `reviewDisposition`, `reviewMessage`, native overlap hints, and ClawHub catalog entries for some of this family.
- The bundled `GoatCitadel Native Safe Improvement` skill already covers bounded self-improvement without autonomous self-rewrite.
- Proactive chat already runs through durable-linked proactive ticks.
- Local STT already uses managed `whisper.cpp`.
- Canvas/A2UI exists as a contract and catalog direction, but broader remote canvas/node behavior should not be claimed without proof.

## Recommendation Matrix

| Skill | Fit | Adopt | Avoid |
|---|---:|---|---|
| [auto-updater](https://clawhub.ai/maximeprades/auto-updater) | Medium | Update scout that checks GoatCitadel, skills, dependencies, migrations, and proof lanes, then creates an approval-backed update proposal. | Silent daily self-update, package-manager mutation, or automatic skill replacement. |
| [free-ride](https://clawhub.ai/shaivpidadi/free-ride) | Medium | Cost-aware provider suggestions, free/low-cost model labels, fallback health probes, OpenRouter diagnostics. | Auto-editing provider config, gateway restarts, or chasing free models as the main product strategy. |
| [github](https://clawhub.ai/steipete/github) | Medium-high | A GitHub CLI/operator playbook: structured `gh --json`, CI triage, PR status, repo scoping, clear auth errors. | Treating `gh` as an ungoverned shell escape. |
| [ontology](https://clawhub.ai/oswalpalash/ontology) | High | Typed memory entities and relations: Project, Task, Decision, Document, Person, Tool, Capability, Approval. Store provenance, confidence, scope, and delete/forget history. | A separate file-owned graph that bypasses `MemoryLifecycleService` or stores secrets/person data casually. |
| [humanizer](https://clawhub.ai/biostartechnology/humanizer) | Medium | Plain-language copy lint for docs, public pages, release notes, and generated reports. Prefer specificity, remove inflated wording, flag vague sourcing. | Framing as "evade AI detection" or applying personality rewrites to technical truth. |
| [multi-search-engine](https://clawhub.ai/gpyangyoujun/multi-search-engine) | Medium | Governed global search planner using Google/Bing global, DuckDuckGo, Brave, Startpage, Ecosia, Qwant, WolframAlpha, and official APIs where possible. | Chinese/domestic engines, Google HK by default, cookie harvesting, automated scraping bursts, or ToS-hostile behavior. |
| [proactive-agent](https://clawhub.ai/halthelobster/proactive-agent) | High | Explicit cron mode taxonomy, working-buffer concepts mapped to durable run/session state, tool migration checklist, "verify mechanism not text" guardrail. | User-profile file sprawl, silent self-edits, or autonomous behavior that bypasses approvals. |
| [gog](https://clawhub.ai/steipete/gog) | Medium | Google Workspace connector diagnostics/playbooks for Gmail, Calendar, Drive, Contacts, Sheets, Docs with OAuth state, dry runs, and confirmation gates. | Direct CLI credential setup from a skill; sending mail or creating events without confirmation. |
| [self-improving](https://clawhub.ai/ivangdavila/self-improving) | Medium | Promotion/demotion rules, correction logs, weekly digest, source citations for memory use. | New global `~/self-improving` state or direct AGENTS/SOUL/MEMORY mutation. Existing native skill should remain the route. |
| [self-improving-agent](https://clawhub.ai/pskoett/self-improving-agent) | Medium | Structured learning IDs, error/request logs, recurrence detection, skill extraction criteria as proposal drafts. | Hook scripts that inspect command output by default, committed `.learnings/` noise, broad promotion into guidance files. |
| [desktop-control](https://clawhub.ai/matagul/desktop-control) | Low-now, high-risk future | Future `desktop.automation` capability with active-window evidence, screenshot before/after, operator approval, allowlisted apps/actions, failsafe, and audit logs. | Importing PyAutoGUI/OpenCV as a general skill; clipboard reads, credential form filling, admin prompts, or coordinate automation without proof. |
| [openai-whisper](https://clawhub.ai/steipete/openai-whisper) | Low | Add/confirm docs for file transcription, translation/SRT exports, model-speed tradeoffs, and managed runtime status. | Duplicating GoatCitadel's managed `whisper.cpp` runtime with a separate Whisper CLI path. |
| [automation-workflows](https://clawhub.ai/jk-0001/automation-workflows) | High | Cowork/Ops Automation Designer: audit repetitive tasks, compute ROI, generate trigger/condition/action/error-handling recipes, promote to cron/proposal after approval. | No-code tool recommendations as product claims; direct Zapier/Make/n8n mutation without connectors and proof. |
| [neosoul-decision-agent](https://clawhub.ai/0xneosoul/neosoul-decision-agent) | High | Decision journal: options, assumptions, risk profile, confidence, chosen path, reversibility, follow-up date, retrospective outcome. | Letting the agent "make" the decision or infer personal risk profile from weak signals. |
| [elite-longterm-memory](https://clawhub.ai/nextfrontierbuilds/elite-longterm-memory) | Medium | HOT/WARM/COLD vocabulary, WAL-like state snapshots, memory hygiene, sub-agent context handoff patterns. | SuperMemory/Mem0/cloud backup claims, git-notes as hidden storage, silent memory writes, "bulletproof" memory promises. |
| [superdesign](https://clawhub.ai/mpociot/superdesign) | Medium | Design workflow reminders, tokens, accessibility checklist, motion durations, OKLCH preference where the app already supports it. | Generic landing-page aesthetics, CDN Flowbite/Tailwind injection, heavy glassmorphism, or designs that fight GoatCitadel's ops-console language. |
| [ui-ux-pro-max](https://clawhub.ai/xobi667/ui-ux-pro-max) | Medium-high | A UI/UX review mode that always covers IA, states, accessibility, tokens, implementation plan, and acceptance criteria. | Separate skill runtime if the existing frontend guidance and visual regression proof can absorb it. |
| [canvas](https://clawhub.ai/lura2/canvas) | High for A2UI direction | Canvas host/node contract ideas: live reload, URL/bind diagnostics, node targeting, present/hide/navigate/snapshot/eval actions behind grants. | Claiming device canvas parity before a GoatCitadel host, bridge, node registry, and proof artifact are implemented. |

## Native Work Packages

### 1. Skill Source Policy Refresh

Update the ClawHub fallback catalog and review policy so these updated skills classify correctly:

- `auto-updater`: `reference_only`, family `auto_updates`
- `free-ride`: `conditional`, family `provider_cost_optimizer`
- `github`: `conditional`, family `github_cli_ops`
- `ontology`: `reference_only` or `conditional`, family `typed_memory_graph`
- `humanizer`: `conditional`, family `copy_style_lint`
- `multi-search-engine`: `reference_only`, family `governed_global_search`
- `proactive-agent`: `reference_only`, family `proactive_automation`
- `gog`: `conditional`, family `google_cli_oauth`
- `self-improving` and `self-improving-agent`: reject/import-block as duplicate self-improvement family
- `desktop-control`: reject/import-block until a governed desktop automation capability exists
- `openai-whisper`: reference-only because managed voice runtime exists
- `automation-workflows`: reference-only or conditional, family `automation_recipe_design`
- `neosoul-decision-agent`: reference-only, family `decision_memory`
- `elite-longterm-memory`: reference-only, family `memory_architecture`
- `superdesign` and `ui-ux-pro-max`: reference-only/conditional, family `frontend_guidance`
- `canvas`: conditional, family `canvas_a2ui`

The catalog can list them, but install buttons should route through native overlap warnings and proposal language rather than treating all of them as directly runnable.

### 2. Typed Memory And Ontology

Best target: `MemoryLifecycleService`, contracts under `packages/contracts/src/memory.ts`, and the Library/Memory route.

Minimal useful shape:

- Entity type: `project`, `task`, `decision`, `document`, `person`, `tool`, `capability`, `approval`, `run`
- Relation type: `blocks`, `depends_on`, `owns`, `mentions`, `derived_from`, `validated_by`, `supersedes`
- Fields: `workspaceId`, `scope`, `confidence`, `sourceRef`, `provenance`, `createdAt`, `updatedAt`, `status`
- Governance: explicit write authority, forget/history support, no secrets, no raw direct file writes

This would make GoatCitadel's memory and Library surfaces more useful without inventing a second memory backend.

### 3. Decision Journal

Best target: improvement service plus memory lifecycle.

Add a decision record model that captures:

- decision prompt
- options considered
- selected option
- assumptions
- confidence
- risk/reversibility
- evidence links
- follow-up date
- retrospective outcome

This is a strong GoatCitadel fit because it reinforces "what the system did, why it did it, and what still needs human judgment."

### 4. Proactive And Automation Hardening

Best targets: `ChatProactiveService`, cron review items, durable runs, Cowork.

Adopt the updated `proactive-agent` distinction:

- Prompted event: visible suggestion or reminder in the main session.
- Autonomous durable work: isolated durable run with bounded permissions, own evidence, and operator-visible result.

Add a tool migration checklist and "verify mechanism, not prompt text" checklist to review prompts and proof lanes.

For `automation-workflows`, create an Automation Designer that emits:

- task audit
- trigger
- conditions
- actions
- failure handling
- proof lane
- rollback plan
- approval requirements
- ROI estimate

### 5. Governed Global Search

The `multi-search-engine` idea is useful, but the direct implementation is not.

Recommended GoatCitadel version:

- No Chinese/domestic engines: omit Baidu, Bing CN, 360, Sogou, WeChat, Shenma, and Google HK by default.
- Prefer official APIs or existing browser/search tools.
- Keep source attribution, timestamps, query variants, and per-source confidence.
- Respect provider limits and policy allowlists.
- Do not store or reuse search-engine cookies.

Search should become a planning/research capability, not a mass scraper.

### 6. Update Scout

Translate `auto-updater` into:

- check available app/package/skill/provider-template updates
- compare current vs latest
- classify risk
- cite changelogs
- propose validation lanes
- create approval/proposal record
- apply only after explicit approval

This belongs in Ops, not as a silent cron.

### 7. Provider Cost And Fallback Optimizer

The `free-ride` idea should become a provider advisor:

- surface free/cheap OpenRouter candidates
- live-probe model availability
- preserve current primary provider unless the operator chooses a switch
- explain quality/cost/rate-limit tradeoffs
- support fallbacks through existing provider config, not direct file edits

Do not build a watcher that mutates config because inference failed.

### 8. Desktop Automation Boundary

`desktop-control` is tempting but crosses the highest-risk boundary in this list.

Before any implementation, define:

- allowed applications and window-title patterns
- action classes: screenshot, focus, type, click, hotkey, clipboard
- per-action approval rules
- before/after screenshots and active-window evidence
- emergency stop and timeout behavior
- secure-app and credential-field denials
- audit log and replay record

This is a Code/Cowork governed capability, not a general skill.

### 9. Canvas/A2UI

`canvas` maps well to GoatCitadel's A2UI direction.

Adopt:

- canvas host config and diagnostics
- bind-mode truth: loopback vs LAN vs tailnet
- node capability registry
- present/hide/navigate/snapshot actions
- live reload for dev
- proof artifact for one end-to-end node presentation

Do not claim platform canvas parity until the host, bridge, node app, action grant, and proof lane exist.

### 10. Writing And UI Guidance

Fold `humanizer`, `superdesign`, and `ui-ux-pro-max` into review systems:

- Prompt Lab style lint for docs/public copy
- frontend review rubric for Mission Control Next
- design token audit
- empty/loading/error/focus-state checklist
- visual regression acceptance criteria

Keep GoatCitadel's design language: dense, scannable, high-trust, cyberpunk but legible. Avoid generic marketing-site patterns.

## Suggested Priority

1. Catalog/policy refresh for these exact ClawHub links.
2. Decision journal + typed memory schema proposal.
3. Automation Designer MVP in Cowork/Ops.
4. Proactive scheduler taxonomy and proof checklist.
5. Governed global search broker.
6. Canvas/A2UI proof spike.
7. Update scout.
8. Desktop automation design doc only.
9. UI/copy lint integration.
10. Provider cost advisor.

## Bottom Line

The updated ClawHub set validates the direction GoatCitadel is already taking: durable state, memory governance, capability catalogs, explicit approvals, and operator-visible evidence. The strongest new ideas are not raw skill installs. They are product-native layers: typed memory, decision retrospectives, automation design, proactive run taxonomy, and canvas proof.

The riskiest mistake would be importing the self-improving, auto-updating, desktop-control, search-scraping, or cloud-memory parts as callable skills. GoatCitadel should absorb the good patterns while keeping gateway ownership, approval gates, path jails, provenance, and proof intact.

