# Hermes Agent vs GoatCitadel Parity Audit - 2026-05-02

## Evidence Baseline

- Hermes snapshot: `5d3be898a8671eb9fb99cf18f43165502f54e7f4`.
- GoatCitadel baseline: local `F:\code\personal-ai`, including the uncommitted channel/personality slice present on 2026-05-02.
- Hermes anchors reviewed for this slice: `README.md`, `RELEASE_v0.12.0.md`, `gateway/`, messaging user/developer docs, channel directory, pairing, command registry, delivery, platform adapters, toolset configuration, and platform-adapter checklist.
- GoatCitadel anchors reviewed for this slice: `packages/contracts/src/channels.ts`, `apps/gateway/src/routes/integration-webhooks.ts`, `apps/gateway/src/routes/integrations.ts`, `apps/gateway/src/services/channel-setup-definitions.ts`, `apps/gateway/src/services/channel-target-directory.ts`, `apps/gateway/src/services/telegram-channel-commands.ts`, `apps/gateway/src/services/discord-runtime-bridge-service.ts`, `apps/gateway/src/services/approval-runtime-service.ts`, `apps/gateway/src/services/approval-connector-delivery.ts`, `apps/gateway/src/services/curation-review-service.ts`, and `docs/personalities/`.

## Current Feature Matrix

| Area | Hermes status | GoatCitadel status | Parity mark | Adoption target |
| --- | --- | --- | --- | --- |
| Shared channel gateway vocabulary | Single gateway vocabulary across adapters: inbound normalize, auth, command dispatch, active-run guard, reply delivery. | Webhook route factory exists, with per-platform normalizers and Discord runtime bridge. New shared channel command contract now starts a common vocabulary. | weekend candidate | Keep consolidating command definitions and status rendering across Telegram and Discord. |
| Telegram runtime feel | Telegram is a first-class daily surface with pairing, home channel, slash commands, native buttons, compact status, tool visibility, media-friendly replies. | Telegram webhook, setup definitions, target discovery, commands, personalities, pairing gate, callback approval resolution, home channel, and compact tool posture now exist. | covered but weaker | Prove real remote terminal approval and compact final delivery manually. |
| Discord runtime feel | Discord adapter participates in gateway model and shared commands. | Discord gateway mode exists, including mention/runtime path and `/new`; shared command contract is ready but not fully wired into Discord. | true gap | Reuse channel command contract for `/status`, `/sethome`, `/personality`, `/tools`, `/skills`, `/stop`. |
| Slack | Hermes leans on Socket Mode and manifest setup. | GoatCitadel has Slack OAuth, webhook normalization, setup checks, and comms tools. | covered but weaker | Borrow manifest/checklist diagnostics; defer Socket Mode until Telegram/Discord are proven. |
| Pairing and allowlists | Clear pairing explanation, code, operator approval, allowlist posture. | Discord pairing existed; Telegram pairing now has pending/approved config state, inbound hard gate, pairing code, approval API, and clear copy. | weekend candidate | Move Telegram pairing state to durable typed storage if config-backed state becomes too cramped. |
| Active-run guard | Gateway-level protection keeps channels from starting conflicting runs. | Some runtime write leases and Discord handling exist; channel-specific active-run UX is not complete. | true gap | Add shared active-run guard response for Telegram/Discord. |
| Home channel delivery | Home channel is a core concept for cron/background/cross-platform results. | `IntegrationConnection.defaultChannelId` is now treated as Telegram home; `/sethome` sets it; target directory includes config source. | covered but weaker | Route scheduled/background summaries through `defaultChannelId`. |
| Target directory | Hermes resolves human-readable channel names with cache, enumeration, session fallback, labels, exact/prefix/ambiguity behavior. | TypeScript target directory now handles Telegram discovery/config/session-style entries and exact/prefix/ambiguity resolution. | possible direct reuse | Keep algorithm shape; expand to Discord and Slack. |
| Command registry | Hermes has a consistent command list across platforms. | New `SHARED_CHANNEL_COMMANDS` contract defines common commands and platform availability. | weekend candidate | Wire Discord next; expose command list in Mission Control. |
| Channel toolsets | Hermes exposes platform tool families so mobile channels can request useful work. | New toolset posture exposes conversation, skills, web, terminal, filesystem, browser, cron, messaging with policy/approval labels. | weekend candidate | Connect tool requests to compact approval/status rendering. |
| Approvals | Hermes feels good because approval is native and compact. | GoatCitadel has stronger approval lifecycle and remote tokens; Telegram callback data and `/approve`/`/deny` token-id fallback now resolve through the same lifecycle. | weekend candidate | Send real Telegram inline keyboards from connector delivery, not only callback-compatible payloads/text fallback. |
| Skills | Hermes can bind behavior/toolsets to channels. | GoatCitadel has richer skill governance. Channel skill bindings are visible config and `/skills`/`/skill` only expose approved bindings. | covered but weaker | Make `/skill <alias>` start an actual skill-scoped run through existing policy. |
| Curator/self-improvement | Hermes has curator review/mutation patterns. | GoatCitadel curation scaffold creates report/proposals without silent mutation, with provenance/trust/rollback fields. | possible direct reuse | Add routed report generation and approval-backed mutation actions. |
| Personalities/SOUL files | Hermes makes personalities feel like a product feature. | GoatCitadel now has categorized built-ins, soul files, Telegram commands, status visibility, and prompt overlay hook for channel replies. | weekend candidate | Add Mission Control selection and Discord support. |
| Memory/session search | Hermes offers channel-facing recall/search feel. | GoatCitadel has thread knowledge, memory governance, and retrieval policy but little channel-native UX. | true gap | Add channel commands for compact memory/session lookup only after approval/trust copy is clear. |
| Providers/model routing | Hermes uses its runtime stack. | GoatCitadel is stronger: multi-provider contracts, routing, fallback, local/cloud posture. | already covered | Do not copy Hermes runtime here. |
| MCP/plugins | Hermes platform plugin host is clean. | GoatCitadel has MCP/admin/connectors and plugin visibility, but channel UX around plugins is early. | covered but weaker | Expose plugin/tool family posture per channel. |
| Voice/media | Hermes channel adapters account for media/typing/native platform behavior. | GoatCitadel has some channel/media plumbing but not a polished channel media story. | true gap | Later: Telegram images/files, Discord attachments, WhatsApp media. |
| Observability/logging | Hermes gateway flow labels are easy to reason about. | GoatCitadel has richer traces but channel paths need simpler operator labels. | possible direct reuse | Use labels: adapter -> authorization -> command dispatch -> active agent guard -> reply delivery. |
| Runtime backends | Hermes benefits from Python because its agent runtime/adapters live there. | GoatCitadel should stay TypeScript-native to avoid split contracts, deployment, diagnostics, and tests. | not aligned | Do not adopt Python gateway runtime. |
| Onboarding/setup | Hermes setup docs/checklists reduce missed steps. | GoatCitadel setup definitions exist and are now stronger for Telegram. | possible direct reuse | Continue adding missed-step probes and manifest-style adapter checklist. |
| TUI/Mission Control/mobile positioning | Hermes channels are the primary surface. | GoatCitadel has Mission Control, mobile ambitions, and stronger governance, but Mission Control UI/UX needs a separate pass. | covered but weaker | Keep this weekend slice channel-first with minimal trust visibility only. |

## Hermes Feels Good Because

Hermes treats channels as the product surface, not as a side door into a web app. The user can pair, set a home channel, choose a personality, run a skill, approve a tool, and receive results without leaving Telegram. The happy path has very few dead ends: commands are consistent, status is compact, approval is native, and background delivery has a clear destination.

The important product lesson is not Python or Socket Mode. It is the operating model: every inbound message flows through a small number of understandable gates, and the platform reply speaks in the platform's native shape. GoatCitadel should keep its stronger governance, but make Telegram/Discord feel like first-class control surfaces.

## Transferable Units

- Channel directory algorithm: keep exact id, normalized label, platform-prefixed label, unambiguous prefix, ambiguity response, cache source, and session fallback.
- Setup checklist shape: bot token valid, platform reachable, bot has seen target, target discovered, home channel selected/skipped, pairing explained, runtime ready.
- Adapter checklist: setup definition, capabilities, target directory, inbound normalizer, command dispatcher, approval rendering, personality support, diagnostics, Mission Control visibility, tests.
- Gateway flow labels: `adapter -> authorization -> command dispatch -> active agent guard -> reply delivery`.
- Pairing copy: short unknown-user explanation, pairing code, exact approval instruction, and reminder that powerful tools remain approval-gated.
- Approval rendering pattern: compact risk summary, requester, target workspace, tool/action, rollback note, approve/reject controls, fallback text command.
- Personality shape: visible preset id/label/description/soul file plus bounded overlay that cannot override safety, tool, memory, approval, or privacy policy.

## Do Not Copy

- No full Hermes Python gateway runtime. GoatCitadel's contracts, diagnostics, tests, provider routing, and Mission Control are TypeScript-native.
- No broad Slack Socket Mode implementation in this weekend slice. Socket Mode is Slack's persistent WebSocket event path using app-level `xapp` token plus bot token; useful later, but not the Telegram-first proof.
- No silent curator mutation. Review/reporting is useful; mutations need approval, provenance, trust state, affected surfaces, and rollback.
- No personality overlay that can override policy. Personalities change voice and framing only.
- No unapproved terminal execution from channels. Telegram may request terminal/file/web/tool workflows, but execution remains policy-gated, approval-gated, logged, and attributable.

## Weekend Incorporation Plan

1. Finish Telegram proof:
   - Pair unknown users, approve pairing code, `/sethome`, `/personality operator`, `/status`.
   - Request a terminal-backed task from Telegram, generate an approval, approve via callback or `/approve <token-id>`, receive compact progress/final result.
   - Confirm background delivery uses `defaultChannelId`.

2. Lift shared command contract into Discord:
   - Add `/status`, `/sethome`, `/personality`, `/tools`, `/skills`, `/stop`, `/new` using the same definitions and trust copy.
   - Keep guild/channel allowlists and mention gating explicit.

3. Make approval rendering truly native:
   - Extend channel send payloads with platform render hints.
   - For Telegram, send inline keyboard buttons for approve/reject and keep `/approve`/`/deny` fallback.

4. Route curation review:
   - Generate report-only reviews over skills/memory candidates.
   - Convert mutations into approval items with provenance/trust/rollback before any write.

5. Keep Mission Control minimal for this slice:
   - Show home channel, active personality, pairing state, tool posture, and skill bindings.
   - Leave larger Mission Control UI/UX repair for the separate overhaul.
