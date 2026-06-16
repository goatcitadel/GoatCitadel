# GoatCitadel Product Gap Review

> **⚠️ SUPERSEDED (2026-05-31).** Several P0/P1 gaps below were closed within ~24–48h of this
> review and no longer reflect `main`. In particular: Universal Run Detail (`RunDetailRoutePage.tsx`)
> and the unified Trust & Policy surface (`TrustPolicySection.tsx`) shipped in `50b4f1694`; the Ops
> quality dashboard in `c6df40fbd`; the Code Mode execution-backend registry in `267882b5c`;
> semantic memory recall is wired into `packages/memory-core/src/candidate-ranker.ts`. The truth-
> reconciliation concerns (remote-MCP catalog honesty, memory "default-enabled") were verified as
> already truthful in code. Read this doc as historical context, not a live blocker list. See
> `~/.claude/plans/please-review-goatcitadel-for-golden-candy.md` for the current verdict.

> Reviewer: Claude (independent product & platform strategy pass)
> Date: 2026-05-30
> Method: 3-pass review (internal subsystem reading → external comparison → synthesis), grounded in a multi-agent fan-out over the repo plus direct file reads. File-path citations are to the live checkout on `main`.
> Scope discipline: this is a product/platform strategy review, not a bug or vulnerability report. Where I cite security primitives, it is as *product capabilities* (permission UX, trust, audit, approvals), never as CVEs.

This review is deliberately opinionated. Where I think the project's own stated direction is wrong, I say so. Confidence levels and "what would change my mind" are in the final section.

---

## 1. Executive Summary

**What GoatCitadel already is strong at.** This is not an early-stage project missing basics. It is a genuinely mature local-first AI operations console: 687 gateway service files, a deny-wins policy engine with path jails and a hardened network guard, durable resumable runs with leases/heartbeats/dead-letter recovery, a real approval lifecycle with replay evidence, a governed capability/skills system, a citation-grounded memory lifecycle, an MCP client with per-server trust tiers, 13 chat-channel adapters, browser tooling, voice, and a seven-surface Mission Control. Its governance posture (approval gates, artifact hashing, audit, release-proof `verify:*` lanes) is **ahead of nearly every competitor in this review**. That is the asset.

**The biggest product gap, stated bluntly:** *GoatCitadel has built a trust machine and then hidden it.* The single most consistent finding across every subsystem reader is a **backend-rich, UI-poor** product. Browser sessions have full CRUD APIs and **zero** Mission Control surface ([apps/gateway/src/routes/browser-sessions.ts](apps/gateway/src/routes/browser-sessions.ts)). Permission profiles, tool grants, and operator overrides have complete route-level CRUD and **no editor UI** ([apps/gateway/src/routes/tools.ts](apps/gateway/src/routes/tools.ts)). Durable run timelines and checkpoints are queryable and **not surfaced** ([apps/gateway/src/services/durable-run-service.ts](apps/gateway/src/services/durable-run-service.ts)). For a product whose 1.0 contract literally forbids "raw JSON-only" surfaces and whose North Star is "Trust Is a Feature," the trust controls are the least visible part of the product. **Closing the backend↔UI gap is worth more than any new capability.**

**Highest-leverage improvements (the four I'd fund first):**
1. **A "Trust & Policy" Mission Control surface** — make the capability firewall (profiles, grants, overrides, MCP trust tiers, audit log, diff previews) a first-class, editable, inspectable product. This is the differentiator made visible.
2. **Governed remote MCP transport** — the catalog already advertises GitHub/Stripe/Microsoft Learn MCP servers the runtime cannot invoke ([apps/gateway/src/services/mcp-server-templates.ts](apps/gateway/src/services/mcp-server-templates.ts) vs [apps/gateway/src/services/mcp-template-visibility.ts](apps/gateway/src/services/mcp-template-visibility.ts)). This is dead catalog today and the single biggest ecosystem-standards gap.
3. **Semantic memory retrieval + governed self-editing memory** — live retrieval is lexical-substring + recency buckets only ([packages/memory-core/src/candidate-ranker.ts](packages/memory-core/src/candidate-ranker.ts)); embeddings exist but aren't wired in; the structured entity/relation graph is "retrieval-dead."
4. **Native security/red-team eval packs gated on release** — injection defense today is five regexes wired only into self-improvement ([apps/gateway/src/services/assembled-prompt-injection-guard.ts](apps/gateway/src/services/assembled-prompt-injection-guard.ts)). This is the weakest spot *and* the strongest latent differentiator.

**The biggest strategic risk:** the **OpenClaw parity program is quietly redefining the product.** GoatCitadel is spending its roadmap chasing a consumer multi-channel assistant's feature checklist (23 channels, voice wake, canvas, companion devices) while its actual moat is operator-grade governance. Parity scoreboards optimize for *sameness*. I think GoatCitadel should declare parity "good enough" and pivot the roadmap to the governance/observability/trust surfaces no competitor has. More on this in §10 and Contrarian Takes.

**The biggest differentiation opportunity:** be the **governed control plane for everyone else's agents and connectors** — a deny-wins, approval-gated, audited MCP *provider* and the policy brain over an integration layer (Activepieces/n8n) and delegated coding/browser workers — rather than re-implementing every connector, coding agent, and sandbox in-house.

**A truth-in-advertising flag.** For a product whose first principle is "Truth Beats Theater," there are internal contradictions that are an existential *brand* risk: 1.0 is claimed as of 2026-04-11 yet parity epics remain open through late May; `MemoryLifecycleService` is documented "enabled by default" but is feature-flagged in config; MCP templates advertise transports the runtime blocks. These aren't bugs — they're the product telling two stories. Fix the stories.

---

## 2. What GoatCitadel Appears To Be

**It is, today, three products wearing one shell — and the repo is honest that this is intentional, but not honest about the tension.**

- **A local-first AI operations console** (the README/AGENTS.md framing): seven operator surfaces, runtime truth, release proof, governance. This is the *strongest and most defensible* identity and the one the architecture actually serves best.
- **An OpenClaw-style personal multi-channel assistant** (the parity-program framing): chat channels, voice wake/talk mode, canvas/A2UI, companion devices, proactive heartbeat. This is a *consumer* product shape grafted onto an *operator* product.
- **A coding-agent control plane** (Code/Cowork surfaces, worktrees, Code Mode, agentic-harness probing): real but deliberately self-limited ("trusted code, not hostile-code sandbox; no autonomous PR push").

**Honest read of the mixed signals:** the engineering center of gravity (policy engine, durable runs, capability system, audit, release-proof lanes) says "operator console / governed agent runtime." The *roadmap* center of gravity (the parity register) says "catch up to a consumer assistant." These are not the same product, and the parity program is currently winning the roadmap while the console identity is winning the architecture. That mismatch is the root cause of the backend↔UI gap: the team keeps *building capabilities to reach parity* faster than it *surfaces them as operator product*.

My recommendation, stated up front: **commit to "governed agent control plane / operator console" as the primary identity.** Treat chat channels as a secondary delivery surface, not a parity scoreboard. Everything in this review follows from that stance.

---

## 3. Competitive Landscape

| Category | Projects | One-line relevance to GoatCitadel |
|---|---|---|
| **Direct peers** | OpenClaw, Hermes Agent, QwenPaw, CowAgent, DeerFlow, Agent Zero, Goose | Same "personal AI control plane" niche. GoatCitadel leads on governance, trails on memory-as-user-model (Hermes/Honcho), per-thread sandbox isolation (DeerFlow), onboarding UX (OpenClaw), and MCP ecosystem reach (Goose). |
| **Orchestration frameworks** | LangGraph, CrewAI, AG2/AutoGen, Agno, CAMEL/OWL, OpenManus | Mostly Python, governance-light. Only **LangGraph's graph+interrupt model** is worth adapting; the rest are pattern references, not dependencies. GoatCitadel's role/ownership/durability model is already comparable-or-stronger. |
| **Memory systems** | Letta, Honcho, Mem0, Zep/Graphiti | GoatCitadel has the *lifecycle/audit* layer (arguably best-in-class) but the weakest *retrieval* (lexical-only). Mem0 (semantic+extraction) is the integrate target; Letta (self-editing) and Honcho (user model) and Zep (bi-temporal) are concept adaptations. |
| **Browser / computer-use** | browser-use, Stagehand, Skyvern, BrowserOS, CUA, Agent S, Bytebot | GoatCitadel browses with brittle selector scripts, headless, invisible — contradicting its own safety doc. **Stagehand** (deterministic+AI-fallback, schema extract) is the copy target; **BrowserOS** (watchable/takeover session) the UX lesson. Full desktop (Bytebot) is correctly out of charter. |
| **Coding agents** | OpenHands, SWE-agent, Aider, OpenCode, Open SWE | GoatCitadel should **delegate**, not re-implement. OpenHands as a sandboxed backend, Aider patterns into the worktree spine, Open SWE's async-PR-for-review model onto durable runs + approval inbox. |
| **Workflow/integration** | n8n, Activepieces, Dify, Flowise | GoatCitadel is *not* a connector platform and shouldn't become one. **Activepieces** (TS/MIT/MCP-native) or n8n is the integrate target as the connector+visual-flow muscle under GoatCitadel's policy brain. Dify/Flowise are control-plane conflicts → ignore. |
| **Sandboxing backends** | E2B, Daytona, Sandbox0, k8s agent-sandbox, AIO Sandbox | Build a pluggable `ExecutionBackend` interface (80% there in the host-sandbox adapter) + a **Docker backend**. **Reject cloud sandbox vendors** (E2B/Daytona/k8s) as core backends — they break the local-first/privacy promise. AIO's *composition* idea (one workspace = browse+shell+code+file) is worth stealing. |
| **Observability / evals** | Langfuse, Phoenix, Opik, Promptfoo | GoatCitadel already owns most of native tracing+eval+replay (better-aligned to its surfaces and local-first). Add an **optional OTel/OpenInference exporter** (one emitter serves Langfuse/Phoenix/Opik). **Promptfoo's red-team model** is the real gap → build native. |
| **Standards** | MCP (client/server/remote/registry), Agent Skills/SKILL.md, AGENTS.md | AGENTS.md: model implementation (immutable safety footer) → keep. SKILL.md: behind on portable bundles (export is preview-only, no import) → adapt. MCP: client strong, **remote transport + server mode are the gaps** → integrate/adapt. |

---

## 4. Parity Matrix

Status legend: **Strong** (shipped, competitive or better) · **Partial** (exists but materially incomplete or unsurfaced) · **Missing** · **Unclear** · **N/A**.

| Capability | GoatCitadel | OpenClaw | Hermes | QwenPaw | CowAgent | DeerFlow | Agent Zero | Goose |
|---|---|---|---|---|---|---|---|---|
| Multi-channel chat assistant | Strong (13 adapters) | Strong (~23) | Strong | Strong | Strong | Partial | Partial | Partial |
| Skills / plugins | Strong (governed) | Strong | Strong | Strong | Strong | Strong | Strong (dynamic) | Strong (MCP) |
| MCP client (local) | **Strong** | Partial | Strong | Partial | Partial | Partial | Partial | **Strong** |
| MCP remote transport | **Missing** (flag-gated) | Unclear | Partial | Unclear | Unclear | Unclear | Unclear | **Strong** |
| Long-term memory | Partial (lexical retrieval) | Partial | **Strong** (Honcho) | Partial | **Strong** (3-tier) | Partial | Partial | Partial |
| Project/workspace memory | Strong (scoped, audited) | Partial | Partial | Partial | Partial | Partial | Partial | Partial |
| Scheduled automations / heartbeat | Strong (cron + proactive) | Strong | Strong | Strong | Strong | Partial | Partial | Partial |
| Subagents / delegation | Strong (depth/budget caps) | Strong | Strong | Partial | Partial | **Strong** (DAG) | Strong (recursive) | Partial |
| Browser automation | Partial (selector-scripts) | Strong | Strong | Partial | Partial | Strong | Strong | Partial |
| Full computer-use | N/A (out of charter) | Partial | Strong | Missing | Missing | Partial | Strong | Missing |
| Sandboxed execution | Partial (host-sandbox, not hostile) | Partial | **Strong** | Partial | Partial | **Strong** (Docker/thread) | Strong (Docker) | Partial |
| Runtime backend abstraction | **Missing** (hardcoded host) | Unclear | Strong | Partial | Partial | Strong | Partial | Strong (providers) |
| Coding-agent workflow | Partial (Code Mode, no PR) | Partial | Partial | Missing | Partial | Strong | Strong | Strong |
| Workflow automation (connectors) | **Missing** (chat-only) | Partial | Partial | Partial | Partial | Partial | Partial | Partial |
| Human approvals | **Strong** (lifecycle+replay) | Partial | Partial | Missing | Missing | Partial | Missing | Partial |
| Tool permissions / firewall | **Strong backend / Missing UI** | Partial | Partial | Missing | Missing | Partial | Missing | Partial |
| Observability / tracing | Partial (native, unsurfaced) | Partial | Partial | Missing | Missing | Partial | Partial | Partial |
| Eval / regression / red-team | Partial (no red-team) | Missing | Partial | Missing | Missing | Partial | Missing | Missing |
| Mission Control / dashboard UX | **Strong** (7 surfaces) | Strong | Partial | Partial | Partial | Strong | Partial | Strong (desktop) |
| Artifact management | Strong (provenance, hashes) | Partial | Partial | Missing | Partial | Strong | Partial | Partial |
| Secrets management | Partial (keychain + .env fallback) | Partial | Strong | Partial | Partial | Partial | Partial | Partial |
| Self-hosting / deployment quality | Partial (GC-P1-09 open) | Strong | Strong (hibernation) | **Strong** (pip) | **Strong** (1-line) | Partial | Partial | **Strong** (distros) |

**Reading of the matrix:** GoatCitadel's bold cells are almost all in the **governance/approvals/Mission-Control** column — that is the moat. Its weak cells cluster in **memory retrieval, runtime/connector/sandbox abstraction, remote MCP, and deployment ergonomics**. Note the standout cell: **tool permissions = Strong backend / Missing UI.** That single cell is the whole thesis of this review.

---

## 5. Product Gaps

Ordered by leverage. Each is a *product* gap, not a bug.

### Gap 1 — The capability firewall is invisible and partly unenforced (P0)
- **Why it matters:** "Trust Is a Feature" is the North Star. A trust feature you can't see, edit, or audit from the product isn't a feature — it's a config file. Non-CLI operators literally cannot adjust who can do what.
- **Evidence:** Full CRUD for permission profiles, tool grants, and local operator overrides exists in [apps/gateway/src/routes/tools.ts](apps/gateway/src/routes/tools.ts); no editor components exist under `apps/mission-control-next/src/features/native-routes/settings`. MCP `McpTrustTier` (`trusted/restricted/quarantined`) is defined in [packages/contracts/src/mcp.ts](packages/contracts/src/mcp.ts) but **quarantine is documented, not enforced** — no code path holds an untrusted server disabled-by-default. Approval previews are free-form strings with **no structured diff** before file writes ([apps/gateway/src/services/approval-explainer-service.ts](apps/gateway/src/services/approval-explainer-service.ts)). Credential scopes (`authContext.secretRefs`) are carried but **not enforced** — a granted tool can read any secret in scope.
- **External inspiration:** none needed — this is GoatCitadel's own latent strength. The bar to beat is "every competitor with weaker governance and no policy UI."
- **Recommended direction:** Ship a **Trust & Policy** surface: profile/grant editor, active-override viewer with TTL, MCP trust-tier toggle with real quarantine enforcement, structured diff previews on write approvals, per-tool credential allowlists, and a searchable audit-log viewer. Enforce quarantine for unknown MCP/skills/add-ons.
- **Priority P0 · Complexity Medium (UI over existing APIs; enforcement is small) · Risk Low.**

### Gap 2 — Memory retrieves lexically; the structured graph is retrieval-dead (P1)
- **Why it matters:** Users experience "it forgot" precisely when paraphrased/semantically-related memories aren't recalled. GoatCitadel's live context path is substring + recency buckets only ([packages/memory-core/src/candidate-ranker.ts](packages/memory-core/src/candidate-ranker.ts)); embeddings exist but only behind the separate Knowledge/RAG facade ([apps/gateway/src/services/memory-facade-service.ts](apps/gateway/src/services/memory-facade-service.ts)) and are never wired into composition. The entity/relation/decision graph ([apps/gateway/src/services/memory-lifecycle-service.ts](apps/gateway/src/services/memory-lifecycle-service.ts)) is manual-create-only and never traversed into context.
- **External inspiration:** **Mem0** (semantic + LLM extraction + conflict-aware lifecycle) → *integrate existing in-house parts*. **Letta** (governed self-editing memory tools) → *adapt*. **Honcho** (durable operator profile) → *adapt*. **Zep/Graphiti** (bi-temporal valid_from/valid_to, contradiction-via-invalidation) → *adapt concept, not Neo4j*.
- **Recommended direction:** (a) fuse vector recall into the candidate collector/ranker; (b) LLM-extract learnings into the structured graph automatically; (c) expose a small set of governed `memory.propose/supersede/forget` tools through the existing write gate so the agent gets smarter across sessions; (d) add a workspace-scoped "operator profile" injected into every context pack.
- **Priority P1 · Complexity Medium (embeddings + store already exist) · Risk Medium (self-editing memory is a poisoning surface; gate it).**

### Gap 3 — Remote MCP transport is advertised but not invocable (P1)
- **Why it matters:** The entire commercial hosted-MCP ecosystem (GitHub, Stripe, Linear, Notion, Atlassian, Sentry, Microsoft Learn) ships as remote HTTP/SSE, not stdio. GoatCitadel can't reach it, yet its template catalog *lists those servers* — dead entries that erode trust.
- **Evidence:** [apps/gateway/src/services/mcp-template-visibility.ts](apps/gateway/src/services/mcp-template-visibility.ts) allows only `transport==='stdio'` unless `GOATCITADEL_EXPERIMENTAL_REMOTE_MCP_TRANSPORTS=true`; remote templates already shipped in [apps/gateway/src/services/mcp-server-templates.ts](apps/gateway/src/services/mcp-server-templates.ts). OAuth start/complete handlers, policy context, trust tiers, and the SSRF network guard already exist.
- **External inspiration:** **Goose** (freely consumes the 3,000+ server registry).
- **Recommended direction:** wire a Streamable HTTP/SSE MCP client behind the existing flag, route remote URLs through `network-guard`, keep the deny-wins/approval/trust-tier wrapper. Then optionally ingest a remote registry feed under the same trust gating.
- **Priority P1 · Complexity Medium-High (net-new egress, token storage, streaming abort) · Risk Medium (governable via existing guards).**

### Gap 4 — No security/red-team eval lane (P1)
- **Why it matters:** Injection defense is five regexes wired only into self-improvement assembly ([apps/gateway/src/services/assembled-prompt-injection-guard.ts](apps/gateway/src/services/assembled-prompt-injection-guard.ts)) — **not** applied to user-facing tool output, retrieved memory, or web/Firecrawl results. There is no adversarial eval corpus, no tool-injection test, no poisoned-memory regression. For a governance-first product this is the most glaring inconsistency between pitch and proof.
- **External inspiration:** **Promptfoo** (attack-plugin library, CI red-team) → *adapt the model into existing prompt-pack + replay-regression machinery*.
- **Recommended direction:** author native prompt-injection / tool-injection / memory-poisoning eval packs scored on existing robustness/honesty rubrics; add a `verify:security:evals` gate; upgrade the runtime guard to a boundary-aware classifier at every untrusted-content ingress.
- **Priority P1 · Complexity Medium (eval plumbing exists) · Risk Medium (classifier false-positive tuning).**

### Gap 5 — Durable runs aren't replay-safe and aren't inspectable (P1, with a P0 edge)
- **Why it matters:** Retried durable runs re-execute side effects (sends, writes, MCP calls) — no result caching keyed by step determinism ([apps/gateway/src/services/durable-execution-service.ts](apps/gateway/src/services/durable-execution-service.ts)). And the rich timeline/checkpoint data is queryable but has **no Mission Control surface** — operators see "paused/failed," not "which step, what error, how many retries."
- **External inspiration:** **LangGraph** (checkpoint-per-node, interrupt-and-resume, time-travel); **Temporal/Agno** (activity result caching).
- **Recommended direction:** add side-effect idempotency keys for external actions; add within-step interrupt HITL (yield a typed "awaiting human" checkpoint); surface a run-trace/timeline viewer.
- **Priority P0 for side-effect safety, P1 for the trace UI · Complexity High (replay semantics) / Medium (UI) · Risk Medium-High.**

### Gap 6 — No execution-backend abstraction; "Docker is a boundary" is aspirational (P1)
- **Why it matters:** Code Mode is locked to per-OS host sandboxing; there is no way to opt a run into a stronger boundary. The README says "Docker is a runtime boundary, not a sandbox," but **no code routes a run into a container** — `docker` appears only as a filename pattern and compose-file hardening.
- **Evidence:** `CodeModeHostSandboxAdapter` ([apps/gateway/src/services/code-mode-sandbox/host-sandbox-adapter.ts](apps/gateway/src/services/code-mode-sandbox/host-sandbox-adapter.ts)) is a backend interface in all but name but switches only on `os.platform()`; `config.ts` hardcodes `mode: 'best_effort_host'`.
- **External inspiration:** the *interface* idea shared by E2B/Daytona/k8s — **but reject the cloud vendors** for a local-first product. AIO Sandbox's composition idea → adapt.
- **Recommended direction:** promote `mode` to an `ExecutionBackend` enum; ship `local-host` + `docker` reference backends; leave `ssh`/`k8s` as documented interface slots with zero code.
- **Priority P1 · Complexity Medium (interface refactor is contained) · Risk Medium (keep opt-in; degrade to host with advisory-unsandboxed posture).**

### Gap 7 — Browser automation is brittle, headless, and invisible — contradicting its own safety doc (P1)
- **Why it matters:** [docs/DESKTOP_AUTOMATION_SAFETY.md](docs/DESKTOP_AUTOMATION_SAFETY.md) promises "visible screen/cursor state" and "immediate stop." Reality: fresh headless Chromium per tool call, caller-pre-authored CSS selector scripts ([packages/policy-engine/src/browser-tools.ts](packages/policy-engine/src/browser-tools.ts)), no model-in-the-loop, no live view, no takeover, and **no browser surface in Mission Control at all**.
- **External inspiration:** **Stagehand** (act/extract/observe; zod-typed extract) → *copy*. **browser-use** (indexed interactive-element map) → *adapt inside the approval gate*. **BrowserOS** (watchable/takeover session) → *adapt the UX onto the existing session/grant ledger*.
- **Recommended direction:** add `observe()`/schema-typed `extract()`/natural-language `act()` as a bounded AI fallback over deterministic Playwright; add a live screencast + takeover/stop surface on the existing `browser-sessions` ledger.
- **Priority P1 · Complexity Medium-High · Risk Medium (page-content injection; mitigated by existing content guard + approvals).**

### Gap 8 — Onboarding is terminal-only; first-run is a wall for non-CLI operators (P2)
- **Why it matters:** A "1.0 operator console" whose only guided setup is a TUI ([apps/gateway/src/onboarding-tui.ts](apps/gateway/src/onboarding-tui.ts)) loses the exact users the seven-surface UI is for. `route-model.ts` promises a "Start Here / setup center" the Settings/onboarding section doesn't deliver.
- **External inspiration:** **OpenClaw Onboard** (graphical provider→channel→skill walkthrough).
- **Recommended direction:** a Mission Control onboarding wizard over the existing onboarding routes: provider key → model pick → first Chat → first Cowork task → first proof artifact.
- **Priority P2 · Complexity Low-Medium · Risk Low.**

### Gap 9 — No connector/integration breadth, and no human-visible automation flows (P2)
- **Why it matters:** The connector registry is **chat-channel-centric only** ([apps/gateway/src/services/connector-registry.ts](apps/gateway/src/services/connector-registry.ts)) — every kind is a messaging transport. There is no Notion/Gmail/Salesforce-as-a-step and no visual flow graph operators can read/edit.
- **External inspiration:** **Activepieces** (TS/MIT/MCP-native) or **n8n** → *integrate as the muscle under GoatCitadel's policy brain*. **Dify/Flowise** → *ignore* (control-plane conflict).
- **Recommended direction:** integrate one self-hosted automation platform via webhooks + MCP; external actions must route back through policy-engine/approvals. Do **not** build a connector treadmill.
- **Priority P2 · Complexity Medium (the governance seam is the real work) · Risk Medium.**

### Gap 10 — Code surface stops at "apply patch"; no issue-to-PR loop, no delegation (P2)
- **Why it matters:** A credible coding control plane needs issue ingestion → branch → test → diff review → PR-for-approval. GoatCitadel probes external harnesses ([apps/gateway/src/services/agentic-harness-availability.ts](apps/gateway/src/services/agentic-harness-availability.ts)) but never invokes them, and explicitly stops before PR push.
- **External inspiration:** **OpenHands** (sandboxed worker) → *integrate/delegate*; **Aider** (git-native edit loop) → *adapt into the worktree spine*; **Open SWE** (async task→sandbox→PR-for-review) → *adapt onto durable runs + approval inbox*; **OpenCode** → *ignore* (redundant).
- **Recommended direction:** add an issue→task front door and an "open PR for human review" step on durable runs; delegate heavy execution to OpenHands behind the approval inbox rather than expanding in-house.
- **Priority P2 · Complexity High · Risk Medium.**

---

## 6. Mission Control Review

Mission Control is, paradoxically, both the strongest and the weakest part of the product. Strong where it's built (Approvals, Memory inspector, Ops runtime, Skills manager, Cowork board are genuinely good, ~1500 LOC of real approval UX). Weak in that **the backend keeps outrunning it.** This section is the heart of the review.

**Missing or shell-only screens (backend exists, UI doesn't):**
- **Trust & Policy editor** — profiles/grants/overrides CRUD exists; no UI. *(P0)*
- **Browser/computer-use session viewer** — full session/grant/event API; zero UI. *(P1)*
- **Run-trace / tool-call inspector** — orchestration + per-turn trace data exists; only approval-scoped evidence is rendered; AGENTS.md forbids raw-JSON surfaces, so the absence is also a contract violation. *(P1)*
- **Durable run timeline / checkpoint browser** — `listDurableRunTimeline`/checkpoint APIs exist; no route. *(P1)*
- **Eval / regression / red-team dashboard** — `prompt-pack` eval engine + replay-regression exist but are feature-flagged and siloed in the Library prompt-pack panel, not a first-class Observe/Evals surface. *(P1)*
- **Secrets/credentials manager** — secrets API exists; zero UI. *(P2)*
- **Subagent / delegation tree** — only a numeric "active subagents" metric; the multi-agent Kanban is experimental. *(P2)*
- **Automation recipe editor** — `draftAutomationRecipe` is API-first with a bare text form; no preview/edit/iterate. *(P2)*
- **Workspace manager** — modal-only switching; no multi-workspace overview. *(P3)*
- **Error-recovery / self-repair proposal surface** — referenced in notifications, no dedicated UI. *(P3)*

**Confusing/weak flows:**
- Onboarding is TUI-only (Gap 8).
- Approval payloads can't be edited before approve/reject (`editedPayload` exists in the service, no form binding) — operators must reject-and-resubmit.
- "Improvement" and "Curator" carry real auto-tuning weight but are labeled experimental, so the most interesting trust-and-learning behavior is hidden behind experimental flags.

**Scaling cliffs to watch (will become limiting):**
- `SettingsNativePage.tsx` (>8k LOC, 14 sections) and `RuntimeRoutePage.tsx` (>2k LOC, 8 Ops sections) are monoliths. New surfaces (the ones recommended above) will hit component-size walls; budget for decomposition *before* adding the Trust & Policy and Observe surfaces, not after.

**The one-sentence Mission Control verdict:** *Stop adding backend capability until the existing backend is visible.* The fastest way to make GoatCitadel feel like a 1.0 product is to surface what's already built, not to build more.

---

## 7. Architecture and Platform Opportunities

- **MCP three ways.** Client (local) is **Strong, keep**. Remote transport is the **highest-leverage integrate** (Gap 3). **MCP server mode** — exposing GoatCitadel *as* a governed MCP server so other agents/IDEs call its tools through deny-wins/approval gates — is a genuine *differentiation* bet: most MCP servers are ungoverned; an approval-gated, audited one is rare. Sequence it after remote-transport (shared infra), and note inbound authz is harder because multi-user RBAC isn't shipped.
- **Skill packaging.** Skills are folder-based on disk but the loader surfaces only the `SKILL.md` body + frontmatter; bundled scripts/templates/assets aren't carried, export is **preview-only**, and there is **no import path** ([packages/skills/src/export-renderer.ts](packages/skills/src/export-renderer.ts), [packages/skills/src/loader.ts](packages/skills/src/loader.ts)). Adapt to true portable bundles (asset enumeration + governed import/export to/from the Claude/Codex ecosystem the export targets already name), keeping the "instructions don't grant tools" invariant.
- **Execution-backend interface** (Gap 6): build it; it's 80% present.
- **Memory abstraction** (Gap 2): wire embeddings + extraction + temporal columns onto the existing tables — evolution, not rewrite.
- **Graph orchestration**: adapt LangGraph's DAG + interrupt model onto the existing (production-grade) durable machinery; do not rip out the bespoke engine.
- **Observability export**: one OTel/OpenInference emitter, opt-in, redaction-aware, serves Langfuse/Phoenix/Opik.
- **Plugin trust model**: the lifecycle/trust-tier scaffolding (`SkillLifecycleState`, `trustLabel`, `reviewWarning`, inspectable-vs-callable) is excellent and ahead of most marketplaces. The gap is *enforcement* (quarantine) and *breadth* (registry ingestion), not design.

---

## 8. Security, Permissions, and Trust as Product Features

Not a vulnerability report — an assessment of whether the *trust controls are productized*. GoatCitadel has built more trust machinery than anyone in this review and surfaced the least of it.

| Capability | State | Product action |
|---|---|---|
| Capability firewall (deny-wins, grants, profiles) | **Strong backend, no UI** | Ship the Trust & Policy surface (Gap 1). |
| Tool/skill/MCP permission manifests | Partial (frontmatter advisory, policy authoritative — correct design) | Expose a portable declared-tools field for import/export. |
| MCP server trust policies | Partial (tiers defined, **quarantine not enforced**) | Enforce quarantine-by-default; surface the toggle. |
| Human approval queue | **Strong** (lifecycle, replay, evidence) | Add payload edit + structured diff preview. |
| Dry-run mode | **Partial/misleading** — `dryRun` surfaces the policy decision but does **not** prevent execution | Either make dry-run a true no-op preview or rename it; today it risks implying "safe preview." |
| Quarantine mode (unknown skills/tools/MCP) | Documented, **not enforced** | Implement the hold gate the docs already promise. |
| Audit trails | Strong (JSONL, secret redaction, retention) | Add an in-product audit-log viewer; consider optional central aggregation. |
| Diff previews before writes | **Missing** (free-form preview string) | Structured before/after diffs on write approvals. |
| Scoped credentials | **Carried, not enforced** | Per-tool secret allowlists. |
| Workspace isolation | Strong (path jails, ownership matrix, worktrees) | Keep; expose per-agent policy in UI. |
| Network/file restrictions | Strong (network-guard, path-jail) | Surface allow/deny lists as editable policy. |
| Risk labels | Partial (global, not surface-aware) | Make risk surface-aware (a write tool in Chat ≠ in Code). |

**The strategic point:** trust is GoatCitadel's *only* durable moat — every competitor can copy channels, skills, and a chat box, but almost none will rebuild deny-wins + approvals + audit + release-proof. **Make trust the product, not the plumbing.**

---

## 9. Recommended Roadmap

### Immediate / P0 — clarify the product and make trust visible
1. **Trust & Policy Mission Control surface** + enforce MCP/skill quarantine + structured diff previews (Gap 1, §8).
2. **Durable side-effect idempotency** so retries don't double-send/write (Gap 5).
3. **Resolve the truth-drift**: reconcile 1.0 claims with open parity epics and feature-flagged "default-enabled" subsystems; stop advertising MCP transports the runtime blocks (§Contrarian #5). This is a docs/positioning P0 for a "truth-first" brand.
4. **Decide the identity** (operator console vs OpenClaw parity) and re-scope the roadmap accordingly.

### Near-term / P1 — close the capability gaps that competitors are ahead on
5. **Governed remote MCP transport** + optional registry feed (Gap 3).
6. **Semantic memory retrieval + governed self-editing memory + operator profile** (Gap 2).
7. **Native security/red-team eval packs + `verify:security:evals` gate + boundary-aware injection classifier** (Gap 4).
8. **Run-trace / durable-timeline / Observe-&-Evals surface** (consolidate native tracing+eval+replay out of feature flags) (Gap 5, §6).
9. **Stagehand-style browser primitives + watchable/takeover browser session UI** (Gap 7).
10. **Mission Control onboarding wizard** (Gap 8).

### Medium-term / P2 — platform leverage via integration, not reinvention
11. **`ExecutionBackend` interface + Docker backend** (Gap 6).
12. **Integrate one automation platform (Activepieces/n8n)** as the connector + visual-flow layer under the policy brain (Gap 9).
13. **Delegate coding to OpenHands/Aider; add issue→PR-for-review loop** on durable runs (Gap 10).
14. **True portable skill bundles** (import/export) (§7).
15. **Optional OTel/OpenInference trace exporter** (§7).

### Long-term / P3 — strategic bets
16. **MCP server mode** — GoatCitadel as a governed MCP provider other agents plug into (§7). The highest-ceiling differentiation play; depends on remote-transport infra and an inbound authz story (and therefore on the RBAC question).
17. **Bi-temporal memory graph** (valid_from/valid_to, point-in-time recall) — turns audit/release-proof into a memory superpower (Gap 2 / Zep).
18. **Optional stronger isolation tier** (Docker→gVisor, or a browser-only CUA-style sandbox) *if and only if* a hostile-code or less-trusted-task tier is ever chartered.

---

## 10. Things Not To Copy

Strong opinions on what GoatCitadel should explicitly *refuse*, even though it's popular.

- **Don't chase OpenClaw channel breadth (23 transports) as a parity goal.** Each adapter is a perpetual auth/loop-guard maintenance liability, and consumer-IM breadth is *not* what an operator console is for. Add channels on demand, governance-wrapped; never as a scoreboard. *(The parity register is currently doing the opposite.)*
- **Don't adopt cloud sandbox vendors (E2B, Daytona, k8s agent-sandbox) as core backends.** They send user code + workspace data + secrets to a third party — a direct contradiction of the local-first/privacy pitch. Build the interface, ship Docker, leave vendor slots empty.
- **Don't copy Agent Zero's "agent writes its own tools in an open Linux box."** It is the precise inverse of GoatCitadel's governed thesis; adopting it would dissolve the moat.
- **Don't copy Skyvern/Bytebot (scale form-bots, full desktop control).** CAPTCHA-defeat and unattended bulk automation breach the product's own `DESKTOP_AUTOMATION_SAFETY` charter. Browser-only, approval-gated is the on-brand ceiling.
- **Don't build a visual workflow builder (Dify/Flowise) in-house.** It's a second control plane with a weaker governance model. Integrate one, don't become one.
- **Don't rip out the bespoke durable engine for LangGraph.** The lease/heartbeat/dead-letter/budget machinery is production-grade and policy-coupled; adapt the graph+interrupt *ideas*, keep the engine.
- **Don't ship more memory that writes silently.** Self-editing memory without the write-gate + audit envelope is a poisoning vector; GoatCitadel's discipline here is a feature — don't trade it for Honcho-style looseness.
- **Don't expand Code Mode toward autonomous PR push before the delegation + approval-before-push loop exists.** Sequence the governance before the autonomy.

---

## 11. Suggested First 10 Tickets

Product/platform tickets, not bugfixes.

**T1 — Trust & Policy Mission Control surface (P0).**
*Problem:* the capability firewall is editable only via API/CLI; quarantine is unenforced; write approvals lack diffs. *Direction:* new Settings/Trust route over existing `tools.ts` + `approvals.ts` APIs: profile/grant/override editors, MCP trust-tier toggle with enforced quarantine, structured diff previews, per-tool credential allowlists, audit-log viewer. *Acceptance:* an operator can create/scope/revoke a tool grant, quarantine an MCP server (and it is disabled until promoted), and see a before/after diff on a write approval — all in-UI; `verify:surface:regression` updated. *Dependencies:* SettingsNativePage decomposition. *Priority P0.*

**T2 — Durable side-effect idempotency (P0).**
*Problem:* retried durable runs re-execute external sends/writes/MCP calls. *Direction:* idempotency keys keyed by (runId, stepId, payload-hash); cache external-action results; short-circuit on replay. *Acceptance:* a forced retry of a run that sent a channel message does not re-send; regression added. *Dependencies:* `durable-execution-service.ts`. *Priority P0.*

**T3 — Positioning/truth reconciliation (P0, docs).**
*Problem:* 1.0 claims vs open parity epics vs feature-flagged "default" subsystems vs advertised-but-blocked MCP transports. *Direction:* one canonical status pass; gate the remote MCP templates behind the same flag that blocks their runtime, or ship the runtime (T6). *Acceptance:* no shipped catalog entry advertises a capability the runtime refuses; `docs:check` enforces it. *Priority P0.*

**T4 — Observe & Evals surface (P1).**
*Problem:* native tracing/eval/replay exist but are feature-flagged and siloed. *Direction:* promote replay-regression out of flag + prompt-pack silo; add a run/session waterfall over per-turn traces; join cost/token rollups. *Acceptance:* an operator can open a run, see its tool-call timeline, replay it, and view a regression delta vs baseline. *Dependencies:* `chat-turn-trace-*`, `prompt-pack-service.ts`. *Priority P1.*

**T5 — Semantic memory retrieval (P1).**
*Problem:* lexical-only recall misses paraphrases. *Direction:* fuse vector recall (existing Knowledge embeddings) into the candidate collector/ranker behind the qmd flag; fix cache-key to include vector candidates. *Acceptance:* a semantically-related-but-lexically-distinct memory is retrieved into context; A/B vs lexical baseline shows recall lift. *Priority P1.*

**T6 — Governed remote MCP transport (P1).**
*Problem:* the hosted-MCP ecosystem is unreachable. *Direction:* Streamable HTTP/SSE client behind the experimental flag, routed through `network-guard`, wrapped in approval/trust-tier. *Acceptance:* the GitHub/Stripe templates connect, list tools, and a `tools/call` is approval-gated and audited. *Priority P1.*

**T7 — Security/red-team eval packs + gate (P1).**
*Problem:* injection defense is 5 regexes in one place; no adversarial corpus. *Direction:* native prompt-injection/tool-injection/memory-poisoning packs scored on robustness/honesty; `verify:security:evals` lane; boundary-aware classifier at every untrusted-content ingress. *Acceptance:* the gate fails on a seeded injection regression; classifier applied to tool output + retrieved memory + web results. *Priority P1.*

**T8 — Browser session viewer + Stagehand primitives (P1).**
*Problem:* invisible headless browsing contradicts the safety doc; selector scripts are brittle. *Direction:* live screencast + takeover/stop on the `browser-sessions` ledger; add `observe()`/zod `extract()`/bounded `act()` over deterministic Playwright inside the approval gate. *Acceptance:* operator watches a browse, can take over/stop; `extract` returns schema-typed data. *Priority P1.*

**T9 — Mission Control onboarding wizard (P1/P2).**
*Problem:* setup is TUI-only. *Direction:* graphical provider→model→first-chat→first-cowork→first-artifact flow over onboarding routes. *Acceptance:* a non-CLI user reaches a successful first Cowork run without a terminal. *Priority P2 (treat as P1 if conversion matters).*

**T10 — ExecutionBackend interface + Docker backend (P2).**
*Problem:* execution is hardcoded to host sandboxing; "Docker is a boundary" is aspirational. *Direction:* promote `mode` to a backend enum; generalize `CodeModeHostSandboxAdapter`; ship `local-host` + opt-in `docker` (network=none, read-only rootfs, cap-drop, mem/cpu limits, cleanup). *Acceptance:* a Code Mode run executes in a container when selected and degrades to host with advisory-unsandboxed posture otherwise. *Priority P2.*

---

## 12. Open Questions for the Product Owner

These materially change direction:

1. **Identity:** Is GoatCitadel primarily a *governed operator console / agent control plane*, an *OpenClaw-style personal assistant*, or a *coding-agent control plane*? The architecture says the first; the roadmap says the second. Pick one to lead. *(I recommend the first — strongly.)*
2. **Parity vs differentiation:** Is "OpenClaw parity" still a goal, or has it served its purpose? I think the parity register should be retired in favor of a governance/observability roadmap. Do you agree?
3. **Local-first absolutism:** Will you ever accept a cloud dependency (sandbox vendor, hosted tracer, cloud coding agent) as a *core* path, or only as opt-in edges? This decides E2B/Daytona/Langfuse/Open SWE verdicts.
4. **Multi-user / RBAC:** Is single-operator the permanent model, or is team/multi-tenant coming? This gates MCP server mode (inbound authz), audit aggregation, and k8s relevance.
5. **Connectors:** Build in-house, or integrate Activepieces/n8n? (I strongly recommend integrate.) If integrate, are you willing to run a second self-hosted service?
6. **Coding autonomy:** Should the Code surface delegate to OpenHands/Aider and open PRs-for-review, or stay a single-step patch tool? How much autonomy before push?
7. **Agent default autonomy:** What is the default approval posture — approve-all, approve-risky, or bypass — and which actions must *always* require approval regardless of profile? (Irreversible external side effects? Memory writes? Money/purchases?)
8. **Third-party skills/MCP:** Will users install skills/MCP servers from third parties? If yes, the quarantine + import-trust + sandbox story must ship *before* a marketplace, not after.
9. **Memory autonomy:** Should the agent self-edit memory (Letta-style)? If yes, what are the write-rate caps, per-namespace limits, and approval thresholds?

---

## Contrarian Takes

1. **Kill the OpenClaw parity scoreboard.** It is the most dangerous artifact in the repo. Parity programs optimize for *looking like the thing you're chasing*, and GoatCitadel's value is in *not* being a consumer assistant. Every epic spent reaching channel/voice/canvas parity is an epic not spent on the governance surfaces that are actually unique. The parity docs even admit re-discovering that "many items were already implemented" — that's a tell that the program has become busywork. Declare victory, archive it, and write a roadmap around the moat.

2. **The "1.0" badge is premature and, for a truth-first brand, self-harming.** Shipping a `1.0` while parity epics are open, `MemoryLifecycleService` is feature-flagged behind a "default-enabled" claim, and the MCP catalog advertises transports the runtime blocks is exactly the "Truth Beats Theater" violation the product's own North Star forbids. The version number is theater. I'd rather see an honest `0.9 / release-candidate` than a `1.0` that contradicts itself — because the *one* thing this product cannot afford to lose is its credibility on truthfulness.

3. **"Code Mode is not a hostile-code sandbox" is a strategic dead-end posing as a safety stance.** It's an honest disclaimer today, but it quietly caps the product: you can never let an agent run anything you don't already trust, which neuters the entire "supervised autonomous work" pitch for real-world inputs. The fix is not to overclaim — it's to *build the boundary* (Docker backend → optional gVisor/browser-only sandbox) so the disclaimer becomes a per-run policy choice instead of a permanent ceiling. Refusing to build isolation isn't safety; it's just a smaller product.

4. **Most of the agent-framework ecosystem in the brief is noise for this product — say so.** LangGraph (one idea), Activepieces (integrate), OpenHands (delegate), Stagehand (copy), Mem0 (integrate), Promptfoo (model). *Everything else* — CrewAI, AG2, Agno, CAMEL/OWL, OpenManus, Dify, Flowise, Agent Zero, Skyvern, Bytebot, E2B, Daytona, k8s-sandbox, Sandbox0, Opik — is **ignore** for GoatCitadel, either because it's a Python cross-language dependency, a governance-light control-plane conflict, or off-charter. A review that recommends adopting twenty frameworks is a review that will get the product killed by integration debt. The discipline *is* the recommendation.

5. **The biggest competitive threat isn't a feature — it's that Goose already speaks the MCP the market publishes and GoatCitadel doesn't.** While GoatCitadel built a beautiful governed *local-stdio* MCP client, the entire commercial ecosystem moved to remote HTTP servers. "Supports MCP" and "speaks the MCP people actually ship" are different products. This one gap silently makes GoatCitadel look a generation behind, regardless of how good its governance is. It should be treated as an emergency, not a P1.

6. **Stop building backend; the product is 40% invisible.** I'll restate this as a contrarian take because it cuts against engineering instinct: the right move for the next two months is to write *almost no new gateway services* and instead surface the dozens already shipped (browser sessions, policy editors, durable timelines, secrets, evals). A team that has built 687 services and can't show its users a browser session it fully controls has a *product* problem, not an *engineering* one — and the cure is restraint.

7. **Memory's "anti-hallucination, citation-grounded" discipline is being used as an excuse not to ship retrieval that works.** Lexical-substring recall isn't conservative — it's just weak. You can have semantic recall *and* citation discipline; they're orthogonal. The citation framing is being quietly conflated with "we don't do embeddings in the memory path," and users pay for it every time the assistant "forgets" a paraphrase.

8. **MCP *server mode* is a bigger bet than the whole channel program — and it's not on the roadmap.** Turning GoatCitadel into a *governed MCP provider* — the one approval-gated, audited server in an ecosystem full of ungoverned ones — repositions it from "an app" to "the trust layer other agents plug into." That's a platform play with a real moat. It's mentioned nowhere in the parity docs because the parity lens can't see it.

---

## Confidence Notes

**High confidence**
- *Backend-rich/UI-poor is the core product gap; ship the Trust & Policy + Observe surfaces first.* Verified across every internal reader against real route files lacking UI counterparts. **Would change my mind:** if those UIs exist under a path the readers and I both missed — but the route-model manifest and feature-folder scan make that unlikely.
- *Remote MCP transport is the top ecosystem gap.* Verified directly: templates advertise remote servers, `mcp-template-visibility.ts` blocks them. **Would change my mind:** evidence the flag is on by default in shipped builds, or that the target users only need stdio servers.
- *Lexical-only memory retrieval is a real weakness; embeddings exist but aren't wired in.* Verified in `candidate-ranker.ts` / `memory-facade-service.ts`. **Would change my mind:** a hidden vector path in the live compose pipeline.
- *Security/red-team eval is the weakest spot.* Verified: the injection guard is 5 regexes with one self-improvement call site. **Would change my mind:** a separate, broader injection-defense layer applied at tool/memory/web ingress that I didn't find.
- *Don't adopt cloud sandbox vendors as core; build the interface + Docker.* High confidence given the explicit local-first/privacy positioning.

**Medium confidence**
- *Retire the OpenClaw parity program / re-anchor identity.* This is a judgment call about strategy, not a fact. It depends on Open Question #1–#2. **Would change my mind:** if the actual revenue/user base is consumer-assistant users who value channel breadth over governance — then parity is correct and I'm wrong.
- *Integrate Activepieces/n8n instead of building connectors.* Strong architecturally, but depends on willingness to run a second service and on the governance-seam working cleanly. **Would change my mind:** evidence that policy enforcement can't be guaranteed across the seam, which would make integration *worse* than a small native connector set.
- *Delegate coding to OpenHands/Aider rather than expanding Code Mode.* Depends on Open Question #6. **Would change my mind:** if in-house Code Mode is already close to an issue→PR loop, making delegation redundant.
- *External competitor capability claims* (Hermes/Honcho memory, DeerFlow sandboxing, Goose registry reach, the memory/sandbox/observability vendors). These rest on the comparison agents' training knowledge and partial web verification; the *GoatCitadel-side* claims are file-verified, the *competitor-side* are version-sensitive. **Would change my mind:** fresh primary-source checks showing a competitor has moved.

**Low confidence**
- *MCP server mode as a strategic platform bet.* High ceiling, but unproven demand and blocked by the unresolved RBAC/authz question. I believe in it directionally; I would not fund it before the P0/P1 work. **Would change my mind:** evidence of concrete demand (other agents/IDEs wanting to call GoatCitadel) or a decision to ship multi-user RBAC.
- *Bi-temporal memory graph.* Strategically an elegant fit with the audit/release-proof story, but heavy and speculative until semantic retrieval (T5) proves the structured graph earns its keep. **Would change my mind:** if simpler semantic recall already satisfies users, making temporal modeling over-engineering.
- *Some "light-scan" verdicts* (Agno, CAMEL/OWL, OpenManus, Sandbox0) rest on partial/uncertain external knowledge; I default them to "ignore" precisely because I couldn't verify a distinct capability. **Would change my mind:** a verified unique capability in any of them that maps to a real GoatCitadel user need.
