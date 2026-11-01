<p align="center">
  <img src="./docs/brand/goatcitadel-lockup-readme.png" alt="GoatCitadel — Scalable Personal AI" width="420" />
</p>

<p align="center">
  <strong>Build a protected AI Citadel around anything you need help running.</strong>
</p>

<p align="center">
  <a href="https://goatcitadel.app"><img alt="Website" src="https://img.shields.io/badge/website-goatcitadel.app-22d3ee?style=for-the-badge"></a>
  <a href="./CHANGELOG.md"><img alt="Release" src="https://img.shields.io/badge/release-0.1.0--rc.1-1ec8a5?style=for-the-badge"></a>
  <a href="./apps/mission-control-next"><img alt="Mission Control Cockpit" src="https://img.shields.io/badge/ui-Mission%20Control%20Cockpit-0f172a?style=for-the-badge"></a>
  <a href="./apps/gateway"><img alt="Fastify Gateway" src="https://img.shields.io/badge/runtime-Fastify%20Gateway-123c52?style=for-the-badge"></a>
  <a href="./package.json"><img alt="pnpm monorepo" src="https://img.shields.io/badge/monorepo-pnpm-f69220?style=for-the-badge"></a>
  <a href="./LICENSE"><img alt="License Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-6366f1?style=for-the-badge"></a>
  <a href="https://deepwiki.com/goatcitadel/GoatCitadel"><img alt="Ask DeepWiki" src="https://deepwiki.com/badge.svg"></a>
</p>

<p align="center">
  <a href="#quickstart"><strong>Start</strong></a>
  ·
  <a href="#tour-the-cockpit"><strong>Tour</strong></a>
  ·
  <a href="#what-is-a-citadel"><strong>Citadels</strong></a>
  ·
  <a href="#current-release-truth"><strong>Release truth</strong></a>
  ·
  <a href="#verification"><strong>Verify</strong></a>
  ·
  <a href="./docs/1_0_CONTRACT.md"><strong>1.0 contract</strong></a>
</p>

README last updated: 2026-10-11

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="./docs/screenshots/mission-control-next/chat-light.png" />
    <img src="./docs/screenshots/mission-control-next/chat.png" alt="GoatCitadel Mission Control Cockpit: the Chat area with the area sidebar, conversation list, a launch-planning conversation, and the composer" />
  </picture>
</p>

**GoatCitadel** is a local-first AI command center for operators who want more leverage than a chat box and more control than a hidden-state agent platform. You work in one unified surface — conversation, supervised agentic runs, and governed code execution — inside **Citadels**: protected AI operating spaces with their own charter, memory boundary, agents, approval rules, sealed secrets, and durable evidence.

The Gateway and Mission Control run locally; models can run locally or through a configured cloud provider. A Fastify gateway owns runtime truth (policy, approvals, orchestration, memory, audit, realtime events), Mission Control gives you an operator console over it, and governed actions leave inspectable evidence. [goatcitadel.app](https://goatcitadel.app) is the public product site; this repository remains the implementation source of truth for runtime behavior, release evidence, installation details, and supported technical claims.

## Pick Your Path

| I want to... | Start here |
| --- | --- |
| See what the app looks like | [Tour the Cockpit](#tour-the-cockpit) |
| Install the app on Windows | [Windows packaged installer](#windows-recommended-packaged-installer) |
| Run from source | [Source clone](#source-clone) |
| Run with Docker Compose | [Docker / Compose](#docker--compose) |
| Understand the Citadel model | [What is a Citadel](#what-is-a-citadel) |
| Understand what is actually shipped | [Current release truth](#current-release-truth) |
| Check supported claims and proof | [Claims boundaries](#claims-boundaries) and [Verification](#verification) |
| Contribute safely | [Development posture](#development-posture) and [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Report a vulnerability | [SECURITY.md](./SECURITY.md) — private advisory, not a public issue |

## Tour The Cockpit

Mission Control opens in the **Cockpit** layout: seven areas built around one question, _what needs me right now?_ The sidebar carries **Chat**, **Inbox**, **Work**, **Capabilities**, **Library**, and **System**, with **Settings** in the gear menu. **Capabilities** holds your connectors, with **Advanced setup** for the full MCP server, integration and web search settings behind them, a **Tools** tab where you switch a group of built-in tools, such as Files, Web search or Browser, off for the AI (the Core group always stays on), and a **Skills** tab that lists your installed skills by category, with a switch that follows your approval setting, how often each was used, and a panel that shows the skill's instructions. The Skills tab's **Discover** view lists the skill packs that ship with GoatCitadel, curated skill sources and, when you search, listings from the AgentSkill and SkillsMP marketplaces, and **Import from Git** takes a repository address. After GoatCitadel's checks, one confirmation installs a pack, or a skill from a GitHub, GitLab, Bitbucket or Codeberg repository, and then switches it on; each of the two steps is its own approval, which opens where you are unless your approval setting skips it. Today only the shipped packs and skills from those four Git sites can be installed from there; marketplace and curated entries are view only. The switcher at the top of the sidebar picks the active Citadel and workspace; it changes your view, not who owns the work or what it may access.

The images are regenerated from a sanitized demo runtime built from shipped defaults (captured 2026-10-11). Every conversation, task, and record in them is fictional demo content, and the seeded Chat answers are labeled as seeded rather than model-generated. Release visual proof is owned by the checked-in visual regression baselines and `pnpm verify:visual:regression`.

### Chat — talk, plan, run, and review in one place

The hero image above is Chat. Conversation, planning, research, supervised agentic runs, approvals, artifacts, and governed code work all happen here; there are no separate Cowork or Code panes.

- **Composer controls**: choose the provider, model, and thinking effort; toggle Plan, Web (Off / Auto / Quick / Deep), and Review; attach files; queue follow-ups; stop a response.
- **Slash commands**: `/plan`, `/goal`, `/steer`, `/queue`, `/btw`, `/model`, `/mcp`, and `/skill`, plus local `/schedule`, `/timer`, and `/status` commands that never reach the model.
- **Answers you can audit**: each answer carries a receipt with the model, tools, sources, latency, and cost (labeled provider-reported or estimated), and a run card that opens the durable evidence behind it.
- **Decisions inline**: approval requests show an exact preview of the action, and agent questions wait for your answer right in the thread. The inspector shows Run, Message, Sources, Context, Files, Conversation, and Background work.
- **Iterate freely**: retry, edit and resend, start a new conversation from any message, and switch between answer versions.
- **Projects**: group conversations, import a local folder or a GitHub repository, and grant time-limited automatic fan-out.
- **Voice and images**: live voice, push-to-talk, transcription, spoken replies, and image creation or editing appear when the host supports them, and say why when it does not.
- **Channel voice**: inbound Telegram, WhatsApp, Slack, and Discord voice messages are transcribed by the local voice runtime by default and fall back to plain text when it is missing; set `GOATCITADEL_FEATURE_CHANNEL_VOICE_INBOUND_V1_ENABLED=false` to turn it off.

### Inbox — every decision in one queue

![Cockpit Inbox with two approval requests waiting for a decision](./docs/screenshots/mission-control-next/inbox.png)

- Items are grouped as **Needs decision**, **Proposals**, **Needs attention**, and **Updates**, with an outstanding-decision badge on the sidebar.
- Approve or deny with the exact action preview; answer agent questions so their runs resume; review change plans (the Gateway rechecks the exact revision before applying), memory proposals, document patches with diffs, and improvement proposals.
- Retry failed or stopped runs from the item that reports them.
- Triage from the keyboard (`j`/`k` to move, `o` to open, `a`/`d` to approve or deny), reject all pending approvals in one step, and replay approval history.
- Every item links back to its source conversation and the page that owns it.

### Work — tasks, runs, and schedules

<table>
  <tr>
    <td width="50%"><img src="./docs/screenshots/mission-control-next/work-board.png" alt="Cockpit Work board with decisions waiting and tasks grouped by state" /></td>
    <td width="50%"><img src="./docs/screenshots/mission-control-next/work-schedules.png" alt="Cockpit Work schedules listing recurring jobs with cadence and state" /></td>
  </tr>
</table>

- **Board**: workspace tasks and recent Chat and supervised-plan runs, grouped as Active, Needs attention, Failed runs, and Done, with anything waiting on you surfaced first. Bulk retry, unblock, close, or cancel.
- **Run detail**: pause, resume, cancel, retry, or recover a run; follow its delegation lineage, artifacts, and timeline; download its signed evidence receipt.
- **History**: durable runs, conversations, and activity over time.
- **Schedules**: governed recurring jobs with daily, weekday, hourly, or custom cadences, plus pause, resume, and run now.
- **Archive and Automation Designer**: restore archived tasks, or preview an automation recipe and copy it as an Activepieces or n8n template.

### Library — what the system knows and can do

![Cockpit Library showing the capability catalog with an inspector](./docs/screenshots/mission-control-next/library-capabilities.png)

- **Candidates and mesh**: candidate skills, proposals, and mesh entries in one catalog with type, status, and trust filters, lifecycle inspectors, and changes that go through approval. Installed skills and tools live in Capabilities.
- **Memory and Notes**: scoped memory you can edit, forget, or pin, memory proposals that stay untrusted until promoted, and notes with revisions and reminders.
- **Files, Artifacts, Agents, and Knowledge**: reviewed uploads and downloads, generated documents and decks, agent profiles, and knowledge ingest and query with governed external sources.
- **Mail and Prompt packs**: mail accounts with compose that needs one high-risk approval to send, and the prompt-pack workbench.

### System — health, spend, and proof

![Cockpit System health with gateway, database, runtime, backup, and channel checks](./docs/screenshots/mission-control-next/system-health.png)

- **Health**: owner-reported status for the gateway, database, runtime service, backups, local models, and channels, with **Back up now** one click away.
- **Spend**: seven days of known cost by day, provider attribution, budget posture, and per-call cost provenance.
- **Quality and Diagnostics**: release gates and evaluations (read-only), durable queue recovery, daemon logs, diagnostics export, and the runtime authority map.
- **Activity, Dashboards, and Browser sessions**: the activity log, saved boards with live widgets and a layout editor, and browser-session grants you can create, rotate, or revoke.

### Settings — set up once, adjust safely

<table>
  <tr>
    <td width="50%"><img src="./docs/screenshots/mission-control-next/settings-citadel.png" alt="Cockpit Settings Citadel overview with charter templates" /></td>
    <td width="50%"><img src="./docs/screenshots/mission-control-next/settings-safety.png" alt="Cockpit Settings Safety with Chat permission profiles" /></td>
  </tr>
</table>

- **General**: Bright sky (light) and Lifted navy (dark) themes, comfortable or compact density, Guided or Expert mode, notifications, and application updates.
- **Models**: guided provider setup, model catalog and routing, ChatGPT sign-in for OpenAI Codex, and Local AI.
- **Safety**: Chat permission profiles, tool approval mode and grants, trust and policy, lifecycle hooks, and budgets.
- **Citadel**: overview, workspaces, guided setup with the Mason, Wards, Council, Vault, and Blueprint.
- **Access and Advanced**: device access and gateway auth, managed runtime, daemon diagnostics, voice runtime, llama.cpp setup, and the experimental Capability packs.

MCP servers, integration connections, and web search keys are set up in **Capabilities › Connectors › Advanced setup**, and every channel's full settings and the public web address are in **Chat › Messaging › Advanced channel setup**.

### First run — your first answer in three steps

![Cockpit first-run setup: choose a model, set your safety posture, send a test message](./docs/screenshots/mission-control-next/first-run.png)

A fresh install opens a focused setup: **choose a model**, **set your safety posture**, and **send a test message**. Finishing setup does not run a model; your first completed Chat answer is what confirms the model works. You can also explore sample records or review optional defaults, and opening those controls changes no data.

### Getting around

- `Ctrl/Cmd+K` opens the command palette: start a new chat, choose the default model, jump to any area, search conversations, Inbox items, and Library records, or change theme and density.
- Press `g` then `c`, `i`, `w`, `a`, `l`, `s`, or `t` to jump to Chat, Inbox, Work, Capabilities, Library, System, or Settings. `Ctrl/Cmd+B` toggles the sidebar and `?` lists every shortcut.
- On phones, a bottom tab bar carries Chat, Inbox, Work, and Library, with Capabilities, System, Settings, search, and scope under More.
- Prefer the previous layout? Choose **Switch to classic Mission Control** from the gear menu or palette, or open `?shell=classic`; `?shell=cockpit` switches back, and either choice is saved in the browser. A few detailed views still open in Classic and are labeled when they do. See [cockpit implementation status](./docs/MISSION_CONTROL_COCKPIT_PROGRESS.md) for remaining verification boundaries.

[Open the generated screenshot gallery.](./docs/screenshots/mission-control-next/index.html) Regenerate it from a throwaway sanitized runtime:

```bash
pnpm screenshots:capture
```

## What Is A Citadel

A Citadel is not a chat folder, a project, or a dashboard. It is a protected AI operating space you build around a durable domain — your personal life, a company, a household, a client, a studio — with governance that the runtime actually enforces. Two Citadels are seeded out of the box: `personal` (a private operating world for single-operator use) and `company` (a ready parent for organization-level workspaces), and both stay approval-governed by default.

| Citadel part | What it owns | Where it lives |
| --- | --- | --- |
| **Charter & Chambers** | The Citadel's identity, purpose, and operating posture | Settings → Citadel → Citadel overview |
| **The Mason** | Guided setup: design, stage, and safely activate a Citadel | Settings → Citadel → Citadel setup |
| **Gatehouse Wards** | Access rules enforced at the policy gate on every tool invocation — `deny`, `require_approval`, and `redact` (tool-output secret scrub) ward effects are enforced and every matched ward is audited; for integration actions and A2A outbound/push, `require_approval` opens an operator approval that executes the exact approved request once on approve and re-checks the ward at execution (deny still wins); `require_dry_run` is enforced for integration actions and A2A outbound/push callers through the shared side-effect runner; `route_local` is enforced for Chat model routing (the turn keeps or switches to a model on a loopback host, fails closed with `citadel_ward_route_local_unavailable` when none is available, and every model dispatch that carries Chat content re-checks it (turns and their tool loops, repairs and fallbacks, delegation workers, assembly calls, and utility calls with a session or turn lineage)) and a `deny` ward on `model.chat.*` blocks those dispatches; utility calls without a session or turn lineage, embedding and image-generation calls, and `model.tool.*` actions are not ward-gated yet | Settings → Citadel → Wards |
| **Council** | The agents seated in the Citadel, by reference | Settings → Citadel → Council |
| **Vault** | Sealed per-Citadel secrets behind the OS keychain; fails closed when the keychain is unavailable | Settings → Citadel → Vault |
| **Blueprint** | Portable `citadel.blueprint.yaml` export/import that never contains secrets, credentials, or live grants | Settings → Citadel → Blueprint |

The same Citadel pages are linked from the top of Library. Scope is hierarchical and fail-closed: a **Citadel** owns the domain charter, global rules, memory boundary, and provider/tool defaults; **workspaces** are functional zones inside it (Engineering, Finance, Family Admin); **projects** are bounded work inside one workspace. Citadel rules cascade downward — workspace rules may specialize them but cannot weaken Citadel-level governance, safety, memory boundaries, approval requirements, path jails, deny rules, auth boundaries, or tool restrictions. The gateway resolves effective scope before policy, memory, approvals, tool grants, and durable execution decisions, so inheritance lives in the control plane, not in UI state.

Full model: [docs/CITADELS_OPERATING_MODEL.md](./docs/CITADELS_OPERATING_MODEL.md).

## At A Glance

| What GoatCitadel gives you | How it stays trustworthy |
| --- | --- |
| One Chat work surface for conversation, planning, agentic work, approvals, and governed code-capability context | Runtime decisions, tools, memory, approvals, and code execution evidence stay visible without switching panes |
| One Inbox for every decision the runtime is waiting on | Exact action previews, revision-checked change plans, and links back to the source conversation and owning record |
| Citadels: protected operating spaces with charters, wards, councils, vaults, and blueprints | Always-on Ward deny/approval enforcement at the policy gate, fail-closed scope resolution, sealed secrets behind the OS keychain |
| Supervised agentic work with plans, checkpoints, retries, approval waits, and parallel sub-agent fan-out | Durable mission sessions, retained operator evidence, and orchestration decision traces in Run Detail |
| Governed trusted-code execution for implementation, review, and debugging | Explicit approval, artifact hashes, execution-time checks, path jails, policy gates, and adversarial sandbox canaries |
| Local-first memory, skills, tools, integrations, and multi-provider models (cloud or llama.cpp local) | Operator-visible lifecycle controls, provenance, and inspectable/callable catalog separation |
| Signed evidence receipts and offline-verifiable compliance export bundles | Digest, signature, and structure proof that verifies without trusting the runtime that produced it |
| Native Windows and Docker-backed local/shared-host operation | Runtime boundaries that do not replace auth, approvals, allowlists, or policy |

## Under The Hood

- **Real parallel agentic execution.** Chat turns can spawn bounded sub-agents through the `agent.fanout` tool (policy-gated, audited, recursion blocked by construction), and the planner can declare independent worker steps that run concurrently. Read-only, low-risk tool batches pre-execute in parallel while per-tool policy and audit order is preserved.
- **It feels fast.** Terminal synthesizer tokens stream live during agentic runs instead of buffering until the pipeline completes, trivial asks skip the planner entirely, planner drafts route to a speed-biased model, live-tail readers wake on append instead of polling, and a per-chunk idle watchdog turns hung provider streams into recoverable errors instead of infinite spinners.
- **Evidence you can hand to an auditor.** Runs produce signed, offline-verifiable evidence receipts (digest, signature, structure proof), and operators can export compliance bundles that verify without trusting the runtime that produced them. Orchestration decision traces (planner, policy gates, model selection) are visible in Run Detail.
- **Governance down to a single tool call.** Citadel Wards are enforced at the policy gate on every invocation, MCP tools and skills can be allowlisted per workspace/Citadel (enforced at MCP invocation), and skills carry declared governance metadata (approval, risk tier, trust scope) surfaced in the Trust UI.
- **Documents and decks as artifacts.** Chat can produce documents and slide decks as saved artifacts, including deck-style PDFs rendered from the same slide layout as `.pptx` output, and research PDFs have their citations checked before the approval step.
- **Governed Code Mode.** Code Mode is an approval-gated trusted-code capability with artifact hash checks and configured execution backends. Windows AppContainer hostile-sandbox canary proof is a platform-specific promotion slice; GoatCitadel does not claim cross-platform hostile-code sandboxing.
- **Optional OpenCode handoff.** Chat can delegate to an operator-installed, independently authenticated OpenCode CLI through the existing approved `shell.exec` path. Results are redacted and shown as bounded activity and file/diff previews. OpenCode keeps its own provider and permission settings; this integration does not provide per-action Gateway enforcement inside OpenCode. See [docs/OPENCODE_INTEGRATION.md](./docs/OPENCODE_INTEGRATION.md).
- **Models, cloud and local.** Built-in provider templates cover OpenAI, OpenAI Codex (ChatGPT sign-in), Anthropic, Claude Code (Claude subscription), Google, Vertex AI, OpenRouter, Vercel AI Gateway, Mistral, DeepSeek, GLM, Moonshot, Perplexity, Fireworks, MiniMax, and Hugging Face, plus local LM Studio, Ollama, `llama.cpp`, and LocalAI. Orchestration routes each step to a capability-selected model, and guided setup and diagnostics cover local runtimes. See [docs/LLAMA_CPP_INTEGRATION_MEMO.md](./docs/LLAMA_CPP_INTEGRATION_MEMO.md).
- **Reach it from where you work.** Guided Mission Control setup for 13 channels — Telegram, Slack, Discord, WhatsApp, Microsoft Teams, Google Chat, LINE, Mattermost, Matrix, QQBot, WeCom, Nextcloud Talk, and Zalo OA — plus ntfy push (with opt-in inbound from a subscribed topic: the token gates reading, anyone able to publish to the topic can start turns, and messages published while the gateway is down are skipped) and generic webhook channels. Telegram, Slack, WhatsApp, LINE, Nextcloud Talk, Mattermost (opt-in bot WebSocket), Matrix (opt-in `/sync` long-poll that resumes from a persisted sync token after a restart; if the homeserver rejects that token the runtime re-primes and messages in the gap are skipped), Google Chat (Chat app mode with a service-account key and Google-signed request verification), QQBot (ed25519-signed webhook), and WeCom (SHA-1-signed, AES-encrypted callback) accept governed inbound messages behind default-deny sender allowlists; Discord inbound is governed by guild/channel/role pairing rules instead. The remaining channels are outbound delivery today ([docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md](./docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md)).
- **Governed scheduled automations.** A durable cron scheduler runs recurring agent turns under a restricted scheduled-turn permission profile, with a model-callable `schedule.manage` tool (per-creator caps, 15-minute minimum interval, scheduled-run recursion blocked), a human review queue for run warnings and watchdog findings, and delivery of run output to any configured channel.
- **Release proof tooling.** Tagged releases assemble signed installer checksums with cosign certificate sidecars, a CycloneDX SBOM, and a commit-bound `release-certificate.json` covering lane status, artifact digests, and scan results.

The complete change record is [CHANGELOG.md](./CHANGELOG.md).

## Current Release Truth

| Area | Current truth |
| --- | --- |
| Canonical shell | [apps/mission-control-next](./apps/mission-control-next) is the `1.0` Mission Control shell. It opens in the Cockpit layout by default; Classic remains available through an explicit saved preference or `?shell=classic`. |
| Cockpit default | The operator authorized the Cockpit default on October 2, 2026. That change does not certify the remaining parity, approved visual, installed-profile, or complete release gates; some detailed views still hand off to Classic and are labeled when they do. |
| Retired shell | `apps/mission-control` source is archived from disk. Generated build/runtime residue may still exist locally, but it is not a shipped compatibility source. |
| Runtime owner | [apps/gateway](./apps/gateway) is the Fastify control plane for runtime APIs, orchestration, approvals, memory, integrations, audit, policy, realtime events, and persistence coordination. |
| Visible IA | Cockpit navigation is `Chat / Inbox / Work / Capabilities / Library / System / Settings`: conversation, planning, and implementation share the single Chat surface, and Work projects operational tasks and runs. Classic keeps `Work / Projects / Library / Ops / Settings`, with Work representing Chat. Legacy `cowork` and `code` routes normalize to Chat or Ops Kanban. |
| Unified surface routing | The gateway normalizes conversation mode to Chat. Planning, research, approvals, and Code Mode context run as Chat capabilities rather than separate primary surfaces. |
| Route scope | The current visible route surface is 50 routes: 44 `ship`, 0 `needs_release_polish`, and 6 `experimental`. See [docs/1_0_RELEASE_SURFACE_SCOPE.md](./docs/1_0_RELEASE_SURFACE_SCOPE.md). |
| Citadels | Six Citadel routes ship (Overview, Mason, Wards, Council, Blueprint, Vault). Gatehouse Ward `deny`, `require_approval`, and `redact` effects are enforced at the policy gate on every tool invocation and every matched ward is audited; for integration actions and A2A outbound/push, `require_approval` opens an operator approval that executes the exact approved request once on approve and re-checks the ward at execution (deny still wins); `require_dry_run` is enforced for integration actions and A2A outbound/push callers through the shared side-effect runner; `route_local` is enforced for Chat model routing: the turn keeps or switches to a model on a loopback host, fails closed with `citadel_ward_route_local_unavailable` when none is available, and every model dispatch that carries Chat content re-checks it (turns and their tool loops, repairs and fallbacks, delegation workers, assembly calls, and utility calls with a session or turn lineage); a `deny` ward on `model.chat.*` blocks those dispatches, and utility calls without a session or turn lineage, embedding and image-generation calls, and `model.tool.*` actions are not ward-gated yet. Vault secrets are sealed per Citadel behind the OS keychain and fail closed. |
| Capability scoping | MCP tools and skills can be allowlisted per workspace/Citadel; scope is enforced at MCP invocation. The dedicated capability-scoping Settings panels remain `hide` (not part of the certified release surface) while agent-side skill-discovery scoping and visual coverage land. |
| Durable execution | Durable runs own the shipped resumable mission-session Chat flow set. Chat turns may fan out to bounded, policy-gated sub-agents via `agent.fanout` and planner-declared parallel workers. |
| Evidence & compliance | Runs produce signed, offline-verifiable evidence receipts, compliance export bundles carry content plus signed receipt plus structure proof, and orchestration decision traces are visible in Run Detail. |
| Code Mode | Code Mode v1 is a governed trusted-code capability launched from Chat with explicit approval, recorded artifact hashes, execution-time hash checks, and separate `hostileSandboxClaim` metadata. The Windows AppContainer hostile-sandbox promotion slice now has green adversarial canary proof; the public cross-platform hostile-code claim remains not promoted until Linux, macOS, and Windows proof all pass. |
| Code backends | The trusted-code host runner is the default. Docker is selectable only when explicitly configured and its sandbox image is digest-pinned fail-closed. The Aider adapter is Docker-backed and audit-only: pinned runs are seeded from the Chat workbench HEAD in an isolated baseline, and a `patch_produced` pinned run changes the workspace only through a separate approved, hash-checked promote (applied at most once through the workbench; an interrupted promotion is never re-applied and is left for manual review); a finished pinned run can be replayed as a new run behind its own approval at the same pinned HEAD, with its patch going through the same promote path; candidate promotion is not claimed. The Docker runner is proven against a digest-pinned image by `pnpm verify:code-mode:docker`. |
| Governed activation | Autonomous high-risk activation is opt-in through expiring operator grants scoped by workspace, surface, risk tier, capability/tool patterns, budget/count, grantor, reason, expiry, and revocation. Activations still pass deny-wins policy, path jails, auth, provenance, and health checks before durable evidence is recorded. |
| Memory | `MemoryLifecycleService` owns operator-facing memory lifecycle behavior, explicit recall, trace-derived memory proposals, feedback, dedupe, scope, and write policy. Memory composition is Citadel/workspace scope-aware. |
| Models | The shipped model catalog spans Anthropic (including `claude-opus-4-8` and `fable-5`), OpenAI, Google, GLM, Moonshot, and Perplexity, with capability-selected per-step model routing inside orchestration and `llama.cpp` as a first-class guided local runtime option. |
| Mesh | `packages/mesh-core` readiness is evidence-gated by `verify:mesh:readiness`, covering join-token, mTLS/tailnet posture, leases, owner failover, replication offsets, Settings visibility, and Gateway diagnostics. |
| MCP | Local `stdio` servers, the built-in Approval Inbox path, and remote records with supported auth are the visible runtime-invokable MCP surface. Remote records connect over Streamable HTTP (`http`) or the legacy HTTP+SSE handshake (`sse`, which only POSTs to a same-origin, allowlisted message endpoint) through the same Gateway policy, approval, network-allowlist, and audit path as `stdio`. Requester-scoped remote records use Streamable HTTP only; a requester-scoped `sse` record is not callable. The explicit experimental flag only permits creating remote records whose auth is not runtime-supported, and those stay non-callable. Governed remote records support no-auth, token-env, and OAuth2 with OS secret-store token refs, refresh near expiry, `Authorization: Bearer ...` injection, and redacted audit/errors; missing tokens surface as `needs_auth`, expired tokens surface as `expired` and remain blocked until reconnect/refresh. Durable runs are exposed as MCP Tasks (list/get/cancel), and MCP elicitations route into the Approval Inbox. |
| Release line | The published release line is the `0.1.0-rc.1` release candidate, shipped as the GitHub prerelease `GoatCitadel 0.1.0 RC`. The earlier `v1.0.0` tag remains in git history, and installer/DMG/tarball artifact names plus embedded release manifests carry the RC version. |
| Desktop/installers | Windows x64 and arm64 installer paths are part of the product shape. macOS arm64 has an experimental ad-hoc-signed DMG lane for friend smoke only; macOS/Linux release artifacts are development-only until their workflow matrices produce signed proof. Public-trust signed EXE/DMG distribution requires exact-SHA proof plus release evidence; unsigned or ad-hoc convenience installers must be labeled as such. |
| Docker | Docker is a supported local/shared-host runtime boundary. It does not replace auth, approvals, path jails, allowlists, or policy. |

The authoritative claim set is [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md), [docs/1_0_RELEASE_EVIDENCE.md](./docs/1_0_RELEASE_EVIDENCE.md), and [docs/CANONICAL_RUNTIME_STATE_MODEL.md](./docs/CANONICAL_RUNTIME_STATE_MODEL.md).

## Quickstart

### Windows (recommended): packaged installer

For most Windows users, install from the packaged `.exe` release assets
(`GoatCitadel-Setup-windows-x64.exe` / `GoatCitadel-Setup-windows-arm64.exe`); see
[docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md). Until public Authenticode
signing is configured, those `.exe`s ship as clearly-labeled **unsigned convenience
installers**. Verify the published SHA-256 from the release proof bundle before running.

### Windows source bootstrap (advanced)

> **Security note:** the one-liner below pipes a remote script straight into PowerShell with
> no signature or checksum verification, and clones the repo from `main` unpinned. Prefer the
> packaged installer above, or use the download-and-inspect flow so you can review the script
> and pin a release tag before executing it.

Power-user one-liner:

```powershell
iwr -useb https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.ps1 | iex
```

Safer download-and-run flow:

```powershell
iwr https://raw.githubusercontent.com/goatcitadel/GoatCitadel/main/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The source bootstrap clones or updates the repo and adds the `goatcitadel` and `goat` launchers. It does not create packaged Windows desktop shortcuts. Packaged Windows installer assets install the native WinUI 3 / Windows App SDK Mission Control desktop host.

Full setup, update, uninstall, and troubleshooting guidance lives in [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md).

### macOS Apple Silicon installer smoke (experimental)

The first macOS installer lane is for Apple Silicon friend smoke only. It builds an
ad-hoc-signed, non-notarized DMG and should not be treated as a supported public
release asset yet.

Build it on an Apple Silicon Mac:

```bash
pnpm package:bundle --target macos-arm64 --skip-desktop
pnpm package:macos --target macos-arm64
```

Expected artifact (the filename carries the current workspace version):

```text
artifacts/installers/macos/GoatCitadel-<version>-macos-arm64.dmg
```

The DMG embeds the immutable GoatCitadel runtime inside the Tauri app at
`Contents/Resources/goatcitadel`. Mutable runtime state, including `runtime-root`,
logs, pid files, config, data, and artifacts, lives under
`~/Library/Application Support/GoatCitadel`. Because the app is ad-hoc signed and
not notarized, Gatekeeper warning/override behavior is expected during this
stage. Public macOS support still requires real Mac smoke evidence plus the
release workflow, signing, notarization, and installer proof gates.

### Source Clone

Use this path for development, contribution, and raw GitHub validation.

```bash
git clone https://github.com/goatcitadel/GoatCitadel.git
cd GoatCitadel
corepack enable
corepack prepare pnpm@10.31.0 --activate
pnpm install --frozen-lockfile
pnpm config:sync
pnpm dev
```

`pnpm dev` starts the gateway plus `@goatcitadel/mission-control-next`.

Default source endpoints:

- Mission Control: `http://localhost:5173`
- Gateway health: `http://127.0.0.1:8787/health`

For a fresh Windows source-development test, run:

```powershell
pnpm clear
pnpm dev
```

`clear` is a GoatCitadel package script. It stops this checkout's identifiable dev processes and bundled native PostgreSQL, archives untracked local settings (including `.env`), database/history/memory, runtime state, and generated Chat output, and removes GoatCitadel's Windows PasswordVault credentials, including ChatGPT OAuth. The next dev page load resets GoatCitadel browser preferences, auth transport state, and drafts once per browser origin/tab. Reload existing tabs after restarting. ChatGPT website cookies remain; use a private browser window if you also want to test signing into ChatGPT from scratch.

Preview with `pnpm clear -WhatIf`. Files are backed up under `.codex-tmp/fresh-reset-*`; removed keychain credentials are not backed up. PasswordVault entries are shared across GoatCitadel installs for your Windows account, so other installs will also need their credentials reconnected. Use `pnpm clear -KeepCredentials` to retain them. Source edits, tracked files, dependencies, skills, fixtures, downloaded models outside the reset roots, and Git worktrees are preserved. This command is for the default local source profile; it refuses production environments, external database modes, custom storage roots, linked paths, or a gateway/UI still running on the default dev ports. It does not reset installed-app profiles or external services. Existing environment variables in your terminal remain active.

Want to click around without touching your own data? `pnpm testbench` starts an isolated sandbox gateway and Mission Control built from shipped defaults, with a deterministic stub model, and deletes the sandbox when you stop it.

### Docker / Compose

Use Docker when you want a stronger local or shared-host runtime boundary than a raw host install.

```powershell
pnpm secrets:docker | Tee-Object -FilePath .env
docker compose up --build
```

Or, from a packaged/source launcher:

```powershell
goatcitadel secrets generate --docker-env | Tee-Object -FilePath .env
docker compose up --build
```

Default container endpoints:

- Mission Control: `http://localhost:4173`
- Gateway health: `http://127.0.0.1:8787/health`

Before exposing GoatCitadel beyond your own machine, set long generated values for:

- `GOATCITADEL_AUTH_TOKEN`
- `GOATCITADEL_POSTGRES_PASSWORD`
- `GOATCITADEL_ALLOWED_ORIGINS`

The compose file binds published ports to `127.0.0.1` by default. Set `GOATCITADEL_DOCKER_BIND_IP` only when you intentionally want another host or interface to reach the stack.

## Platform Support

| OS | Arch | Package | Status |
| --- | --- | --- | --- |
| Windows | x64 | `GoatCitadel-Setup-windows-x64.exe` | Supported |
| Windows | arm64 | `GoatCitadel-Setup-windows-arm64.exe` | Supported |
| macOS | arm64 | `GoatCitadel-<version>-macos-arm64.dmg` | Experimental friend-smoke only |
| macOS | x64 | source/dev install | Development-only |
| Linux | x64 | source/dev install or Docker | Development-only |
| Linux | arm64 | n/a | Not shipped |

See [docs/supported-platforms.md](./docs/supported-platforms.md) for runtime expectations and installer notes.

## Configuration Basics

Tracked config ships as templates:

- tracked: `config/*.example.json`
- local runtime copies: `config/*.json`

Fresh installs and raw clones materialize local runtime config through `goatcitadel install`, `goatcitadel update`, or `pnpm config:sync`.

Create a local env file for repo-based development or provider setup:

```bash
cp .env.example .env
```

Windows:

```powershell
Copy-Item .env.example .env -Force
```

Set at least one model provider key if you plan to use cloud models:

```env
OPENAI_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
CLAUDE_CODE_OAUTH_TOKEN=your_token_here
GOOGLE_API_KEY=your_key_here
GLM_API_KEY=your_key_here
MOONSHOT_API_KEY=your_key_here
PERPLEXITY_API_KEY=your_key_here
```

`CLAUDE_CODE_OAUTH_TOKEN` is the long-lived Claude subscription token from `claude setup-token`; unlike `ANTHROPIC_API_KEY`, it is sent as Bearer OAuth. Provider secrets prefer OS secure-store persistence and may fall back to local env/config storage when secure-store persistence is unavailable or disabled.

You can also skip the env file and connect providers from **Settings → Models** or the first-run setup.

Prefer local inference? `llama.cpp` is a guided first-class local runtime option — see [docs/LLAMA_CPP_INTEGRATION_MEMO.md](./docs/LLAMA_CPP_INTEGRATION_MEMO.md).

## Useful Commands

Everyday local commands:

```bash
pnpm dev
pnpm testbench
pnpm verify:install
pnpm doctor:deep
pnpm typecheck
pnpm test
pnpm build
pnpm docs:check
```

Installed launcher basics:

```bash
goatcitadel help
goatcitadel status --json
goatcitadel launch --no-open --json --wait
goatcitadel up
goatcitadel stop --json
```

PowerShell note: prefer `goatcitadel` or `goat`. GoatCitadel does not install `gc` because PowerShell already uses it as the built-in alias for `Get-Content`.

## Architecture At A Glance

```mermaid
flowchart LR
  MC["Mission Control<br/>Cockpit · Chat · Inbox · Work · Capabilities · Library · System"] --> GW
  CH["Channels (14 built-in)<br/>Telegram · Slack · Discord · WhatsApp · Matrix · Teams · LINE · … · webhooks"] --> GW
  GW["Gateway control plane<br/>Fastify · runtime APIs · realtime events"] --> POL
  POL["Policy engine<br/>Citadel scope · Wards · deny-wins · path jails · approvals"] --> DUR
  GW --> MEM["Memory lifecycle · skills · capability catalog"]
  DUR["Durable executor<br/>resumable runs · retries · approval wake/resume · sub-agent fan-out"] --> ST
  DUR --> PRV
  ST["Storage<br/>SQLite / Postgres + JSONL transcripts · audit · evidence"]
  PRV["Model providers<br/>cloud APIs · subscription sign-in · llama.cpp / Ollama / LM Studio / LocalAI"]
```

- Gateway runtime is the operational source of truth for runtime APIs, orchestration, approvals, policy, integrations, audit, realtime events, and persistence coordination.
- Mission Control is an API client for Chat, Inbox, Work, Capabilities, Library, System, and Settings (and the Classic layout). It should not bypass gateway-owned runtime state.
- Effective Citadel/workspace scope is resolved in the control plane before policy, memory, approvals, tool grants, and durable execution decisions.
- Durable execution owns resumable mission-session work, approval wait/resume, recovery, retries, cancellation truth, and dead-letter handling.
- Capability and skills catalogs split inspectable review state from callable runtime state. Inactive candidates and proposals are never callable.
- Memory lifecycle is explicit, scoped, and operator-visible. Trace-derived memory remains proposal-first.
- Deny-wins policy, Citadel Wards, approval gates, path jails, allowlists, auth boundaries, and tool grants remain authoritative.
- Filesystem tools write only inside the runtime write jail and operator write roots that the operator opens in Settings. Deleting inside a root requires that root's own opt-in, and the runtime config, secrets, database (SQLite and bundled Postgres) and audit paths are never writable by tools. See [Filesystem Write Authority](docs/FILESYSTEM_WRITE_AUTHORITY.md).
- Canonical state belongs in repositories and durable logs. Retained realtime events are operator signals, not the complete historical record.

## What Ships In This Repo

Apps:

- [apps/mission-control-next](./apps/mission-control-next): canonical React/Vite Mission Control shell (Cockpit by default, Classic on request) used by `pnpm dev`
- [apps/mission-control-windows](./apps/mission-control-windows): canonical Windows desktop host using C#/.NET, WinUI 3, Windows App SDK, and WebView2
- [apps/mission-control-desktop](./apps/mission-control-desktop): Tauri rollback host for Windows during migration and experimental macOS packaging work
- [apps/gateway](./apps/gateway): Fastify control plane and runtime APIs
- NPU sidecar support was retired from the `1.0` source and installer path; local model work should use llama.cpp, Ollama, LM Studio, LocalAI, or external providers until real NPU hardware proof justifies a new implementation.

Shared packages:

- [packages/contracts](./packages/contracts): shared contracts and schemas
- [packages/gateway-core](./packages/gateway-core): shared gateway runtime primitives
- [packages/storage](./packages/storage): SQLite/Postgres repositories and persistence helpers
- [packages/policy-engine](./packages/policy-engine): tool policy, Citadel Wards, wrappers, and runtime guardrails
- [packages/orchestration](./packages/orchestration): agent and workflow primitives
- [packages/memory-core](./packages/memory-core): context and memory composition utilities
- [packages/mesh-core](./packages/mesh-core): multi-node mesh runtime primitives (join tokens, mTLS/tailnet posture, leases, owner failover, replication)
- [packages/skills](./packages/skills): skill loading and activation support
- [packages/extensions-sdk](./packages/extensions-sdk): author SDK for the effective-tool snapshot helpers and the plugin manifest validator
- [packages/threaded-surface-core](./packages/threaded-surface-core): shared threaded-surface runtime components behind Chat
- [packages/mission-control-shared](./packages/mission-control-shared): shared Mission Control API clients, hooks, and UI primitives

## Verification

Use the smallest lane that proves your change. The full lane set:

| Theme | Lanes |
| --- | --- |
| Everyday | `verify:fast` · `verify:install` · `verify:review` · `verify:all` · `verify:soak` |
| Live end-to-end product proof | `verify:runtime:truth` · `verify:durable:recovery` · `verify:operator:proof` · `verify:surface:regression` · `verify:visual:regression` · `verify:backup:roundtrip` · `verify:desktop` |
| Agentic runtime & orchestration | `verify:agentic:contracts` · `verify:agentic:governance` · `verify:agentic:harnesses` · `verify:agentic:proof` · `verify:agentic:parity` · `verify:orchestration:perf` · `verify:harness:availability` · `verify:self-improvement:trust` |
| Code Mode & sandbox | `verify:code-mode:sandbox` · `verify:code-mode:hostile-sandbox` · `verify:code:workbench-loop` |
| Contracts & compatibility | `verify:api:compat` · `verify:auth:matrix` · `verify:ui:parity` · `verify:catalog:parity` · `verify:memory:truth` · `verify:realtime:truth` · `verify:mesh:readiness` · `verify:mcp:conformance` · `verify:a2a:full` · `verify:channels:runtime` · `verify:storage:migration-parity` |
| Security & supply chain | `security:trivy` · `verify:supply-chain` · `verify:security:evals` · `verify:artifacts:redaction` · `verify:repo:hygiene` |
| Ecosystem & packaging | `verify:extensions:package` · `verify:extensions:package:from-build` · `verify:skills:catalog` · `verify:workflows` · `verify:design:quality` · `verify:deep:core` · `verify:deep:ecosystem` |
| Architecture guard | `verify:architecture:metrics` |

`verify:review` is the final review step for a completed `verify:all` artifact. It intentionally refuses an
unfinalized, implicitly selected, or unexpected non-`all` latest run. Capture the fresh `verify:all` run id from
`artifacts/verification/latest-run.json`, then run `pnpm verify:review -- --run-id=<runId>`; automation may also
set an ISO-8601 lower bound with `--started-after=<timestamp>`. The release-proof matrix may review one exact
non-`all` lane by also passing `--expected-lane=<lane>`; this override never accepts a different latest lane.

Proof-type shorthand:

- Live end-to-end proof: `verify:runtime:truth`, `verify:durable:recovery`, `verify:operator:proof`, `verify:surface:regression`, `verify:visual:regression`, `verify:backup:roundtrip`, and `verify:desktop`.
- Targeted contract/behavior proof: `verify:auth:matrix`, `verify:code-mode:sandbox`, `verify:code-mode:hostile-sandbox`, `verify:mesh:readiness`, `verify:agentic:governance`, `verify:agentic:proof`, `verify:memory:truth`, `verify:realtime:truth`, and `verify:api:compat`. `verify:code-mode:hostile-sandbox` is a promotion gate for native hostile-sandbox claim metadata and adversarial canary coverage; it runs current-platform native canaries when the adapter is available. On Windows, the lane proves AppContainer outside-root read/write denial, network denial, env-secret absence, symlink/path traversal denial, process/job limits, artifact hash integrity, and fail-closed required mode, but it does not allow a public cross-platform hostile-code claim until every Linux, macOS, and Windows proof is green. `verify:agentic:proof` is targeted contract/behavior proof for retained agentic evidence, orchestration lineage anchors, and governance/harness proof families; it is not live end-to-end product proof.
- REST/SSE compatibility proof: `verify:api:compat` snapshots REST route/status compatibility and realtime event envelopes. It is not a full response-schema diff.
- Backup proof: `verify:backup:roundtrip` now restores and verifies the full minimum operator backup set.
- Parity sample: `verify:catalog:parity` now executes the runtime-backed operator action classes declared in its parity scenario; it is a parity sample, not proof every future visible catalog entry has a live action.
- Architecture debt guard: `verify:architecture:metrics` fails on coupling regressions and reports large-service debt. It is not proof broad `GatewayService` decomposition is complete.
- Architecture baseline provenance: update the accepted snapshot only with `pnpm architecture:baseline:update`. By default the generator refuses dirty measured Gateway or collector source and binds the regenerated metrics to the clean `HEAD` revision. An explicitly uncommitted review candidate may use `pnpm architecture:baseline:update -- --allow-dirty-review-candidate`; that exception records `sourceTreeState: "dirty"`, the base `HEAD`, and a SHA-256 digest of the exact measured Gateway and collector source. Do not hand-edit the metric values or provenance fields.

For UI changes, include browser or visual proof when practical. `verify:visual:regression` compares checked-in shell and route baselines for the current Mission Control Next surface. Intentional visual baseline updates go through:

```bash
pnpm verify:visual:rebaseline
pnpm verify:visual:regression
```

## Claims Boundaries

Safe public claims today:

- The GoatCitadel `1.0` product contract is defined by [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md) and backed by [docs/1_0_RELEASE_EVIDENCE.md](./docs/1_0_RELEASE_EVIDENCE.md); the published release line delivering that contract is the `0.1.0-rc.1` release candidate.
- Chat is the single governed Work surface, backed by shared runtime foundations for conversation, planning, agentic execution, approvals, artifacts, and Code Mode context.
- Citadels are the operator-facing governance model: Citadel → workspace → project scope resolution is fail-closed, Gatehouse Ward `deny` and `require_approval` effects are enforced at the policy gate on every tool invocation, Vault secrets are sealed per Citadel behind the OS keychain, and Blueprints export/import without secrets.
- Durable execution owns the shipped mission-session resumable flow set, including bounded policy-gated sub-agent fan-out via `agent.fanout` and planner-declared parallel workers.
- Runs produce signed, offline-verifiable evidence receipts, and compliance export bundles verify offline via digest, signature, and structure proof.
- The capability system governs tools, runtime skills, generated candidates, proposals, and Code Mode runs, and MCP/skill capability scoping is enforced per workspace/Citadel at MCP invocation.
- Code Mode v1 is trusted-code, approval-gated execution with recorded artifact hashes and execution-time hash checks.
- Windows-native AppContainer hostile-sandbox proof is green as a current-platform promotion slice under `verify:code-mode:hostile-sandbox`; public cross-platform hostile-code sandboxing remains unclaimed.
- High-risk autonomous activation is governed by expiring operator grants, deny-wins policy, path jails, auth, provenance, health checks, durable audit/evidence, and an emergency revoke path.
- Runtime-invokable MCP is local `stdio`, the built-in Approval Inbox path, and Gateway-mediated remote invocation over Streamable HTTP or the legacy HTTP+SSE handshake (same-origin, allowlisted message endpoint only; requester-scoped records use Streamable HTTP only) for supported no-auth, token-env, and OAuth2 records, including OAuth token refs in the OS secret store, refresh near expiry, bearer injection, readiness blockers, and redacted audit/errors.
- `packages/mesh-core` has a named readiness lane, `verify:mesh:readiness`, for release evidence over join tokens, mTLS/tailnet posture, leases, owner failover, replication offsets, Settings, and Gateway diagnostics.
- Visible `beta` integrations in Mission Control now expose real operator actions backed by runtime handlers instead of diagnostics-only shells.
- Backup create/list/verify are shipped, and backup verify reports both archive integrity and `contractVerified` minimum-set truth.
- `verify:backup:roundtrip` now restores and verifies the full minimum operator backup set: SQLite state, transcripts, audit logs, and every runtime `config/*.json` file.
- Filesystem-backed restore is offline-only for `1.0`; the live admin restore route returns `offline_restore_required` instead of mutating an active runtime.
- `@goatcitadel/extensions-sdk` is the author boundary for the effective-tool snapshot helpers and the plugin manifest validator. `1.0.0` is the last published version; the workspace's `2.0.0` keeps the snapshot helpers and adds the plugin manifest validator (`parsePluginManifest` and `loadPluginManifest`) and the `goatcitadel-plugin-preflight` command, and is not published yet. The Gateway inspects, installs and uninstalls plugins through its Capabilities API, governed by Change Plans; Mission Control has no Plugins tab yet, and there is no plugin trust or marketplace surface.
- Docker adds a useful runtime boundary when paired with auth and policy configuration.
- Multi-user RBAC is not shipped for `1.0`; gateway auth is deployment-level while permission profiles, tool grants, route access classes, Local Operator Override, and deny-wins policy govern actions inside the authenticated runtime.

Do not claim without fresh proof:

- cross-platform or general hostile-code sandboxing for Code Mode beyond the named Windows-native proof slice
- ungoverned autonomous high-risk tool activation
- full Citadel Ward effect enforcement across every effect: `deny`/`require_approval`/`redact` are enforced and all matched wards are audited, and `route_local` is enforced only for model dispatches that carry Chat content (`model.chat.*`); utility calls without a session or turn lineage, embedding and image-generation calls, and `model.tool.*` actions are not ward-gated yet; `route_local` trusts any loopback endpoint as this machine, so a loopback proxy that forwards to a remote provider is not detected; remote worker Chat placement (`chatRemotePlacementV1Enabled`, off by default) is not ward-gated
- the workspace/Citadel capability-scoping Settings panels as certified release surface, or agent-side skill-discovery scoping as complete
- multi-user Citadel sharing or cross-operator Citadel membership
- NPU sidecar maturity or local-inference completeness as a `1.0` signal; that path is retired from the shipped 1.0 source and installer.
- `packages/mesh-core` readiness without a green `verify:mesh:readiness` evidence lane
- compatibility shell parity as canonical product readiness
- remote MCP records with unsupported auth as callable; the explicit experimental flag only permits creating them as non-callable records
- remote MCP invocation that bypasses Gateway policy, approvals, network allowlists, audit, or supported auth
- OAuth-backed remote MCP invocation without OAuth metadata, OS secret-store token refs, ready auth state, and redacted refresh/runtime evidence
- generated screenshot, release proof, installer signing, or backup restore guarantee that was not actually produced

## Public Docs

- [goatcitadel.app](https://goatcitadel.app)
- [CHANGELOG.md](./CHANGELOG.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [docs/1_0_CONTRACT.md](./docs/1_0_CONTRACT.md)
- [docs/1_0_RELEASE_EVIDENCE.md](./docs/1_0_RELEASE_EVIDENCE.md)
- [docs/1_0_RELEASE_SURFACE_SCOPE.md](./docs/1_0_RELEASE_SURFACE_SCOPE.md)
- [docs/CANONICAL_RUNTIME_STATE_MODEL.md](./docs/CANONICAL_RUNTIME_STATE_MODEL.md)
- [docs/CITADELS_OPERATING_MODEL.md](./docs/CITADELS_OPERATING_MODEL.md)
- [docs/CAPABILITY_SYSTEM_V1.md](./docs/CAPABILITY_SYSTEM_V1.md)
- [docs/MISSION_CONTROL_COCKPIT_PROGRESS.md](./docs/MISSION_CONTROL_COCKPIT_PROGRESS.md)
- [docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md](./docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md)
- [docs/LLAMA_CPP_INTEGRATION_MEMO.md](./docs/LLAMA_CPP_INTEGRATION_MEMO.md)
- [docs/INSTALL_SETUP_TESTING.md](./docs/INSTALL_SETUP_TESTING.md)
- [docs/ENGINEERING_HANDBOOK.md](./docs/ENGINEERING_HANDBOOK.md)
- [docs/PLUGIN_SDK_CONTRACT.md](./docs/PLUGIN_SDK_CONTRACT.md) (Extensions SDK contract)
- [docs/security/findings-triage.md](./docs/security/findings-triage.md)

## Repo Layout

```text
apps/                                      product runtimes and UI
packages/                                  shared libraries and runtime modules
scripts/                                   repo automation and verification
templates/                                 companion, Obsidian, and verification templates
config/*.example.json                      public config templates
docs/brand/                                optimized public brand assets used by this README
scripts/verification/baselines/visual/     checked-in Mission Control visual baselines
docs/screenshots/mission-control-next/     sanitized public screenshot gallery
artifacts/verification/                    local verification output, regenerated by proof lanes
```

## Development Posture

When changing this repo:

- inspect the current runtime owner before editing
- prefer implementation truth over stale plans or review notes
- keep diffs surgical and avoid unrelated formatting churn
- preserve public truth across docs, UI copy, release notes, and implementation
- do not mutate user data, secrets, generated evidence, or runtime state casually
- validate proportionally to risk and report what remains uncertain

Before acting on a GitHub Security finding, read [docs/security/findings-triage.md](./docs/security/findings-triage.md).

## Contributing

| Document | What it covers |
| --- | --- |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Setup, quality gates, PR expectations, and the AI-assisted contribution bar |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | Community standards and the enforcement path |
| [AGENTS.md](./AGENTS.md) | Required reading for coding agents: source-of-truth order, validation lanes, and claims that need fresh proof |
| [SECURITY.md](./SECURITY.md) | Private vulnerability reporting, safe harbor, and supported lines |

Pull requests use one of two templates: the default human template, or
[`.github/PULL_REQUEST_TEMPLATE/agent.md`](./.github/PULL_REQUEST_TEMPLATE/agent.md)
for agent-authored changes, which asks for the validation lanes that actually
ran and the ones that did not.

## License And Credits

GoatCitadel source is licensed under the [Apache License 2.0](./LICENSE).

Bundled third-party assets carry their own licenses and are tracked separately —
see [ASSET_LICENSES.md](./ASSET_LICENSES.md) and [CREDITS.md](./CREDITS.md).
Shipped assets are restricted to CC0 / Public Domain, CC BY 4.0, and the SIL
Open Font License 1.1 for bundled fonts.
