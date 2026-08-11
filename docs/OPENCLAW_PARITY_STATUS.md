# OpenClaw Parity Status

Last updated: 2026-08-08

This document preserves the contract-aligned status of the original GoatCitadel
parity epic IDs. The aggregate execution order, including newer self-repair,
remote-worker, UI, mobile, and packaging dependencies, is owned by
[MASTER_COMPLETION_PROGRAM.md](./MASTER_COMPLETION_PROGRAM.md).

The active July 2026 broad-capability program, including Hermes Agent and operator-owned worker parity, is tracked in [OPENCLAW_HERMES_PARITY_PROGRAM.md](./OPENCLAW_HERMES_PARITY_PROGRAM.md). This file remains the contract-aligned ledger for the original OpenClaw epic IDs.

## Epic Status

| Epic | Label | Status |
|---|---|---|
| `GC-P0-01` | Shared channel runtime semantics | complete |
| `GC-P0-02` | Stabilize core beta channels | complete |
| `GC-P0-03` | Ship Tier-1 planned channels | complete |
| `GC-P0-05` | Channel action API completeness | complete |
| `GC-P0-06` | Browser control parity | complete |
| `GC-P0-07` | Canvas / A2UI parity | complete |
| `GC-P1-04` | Ship Tier-2 planned channels | complete |
| `GC-P1-08` | Companion apps / nodes / device surfaces | complete |
| `GC-P1-09` | Packaging and remote deployment parity | in_progress |
| `GC-P1-10` | Long-tail parity register | complete |
| `GC-P2-11` | Extension / plugin SDK breadth | complete |
| `GC-P2-12` | Voice Wake / Talk Mode parity | complete |
| `GC-P2-13` | Council / facilitated specialist synthesis (name TBD) | deferred |
| `GC-P0-14` | Governed self-configuration and self-repair | partial |

## Current Focus

- `GC-P1-09` remains the only open epic from the original completion program
  and closes under master tranche `M9`.
- `GC-P0-14` is partial rather than complete: the first credential repair path
  exists, but its owner contract still holds broader repair classes and real
  packaged/browser/live-provider proof. It closes under master tranche `M5`.
- `GC-P0-06`, `GC-P0-07`, `GC-P1-08`, `GC-P1-10`, `GC-P2-11`, and
  `GC-P2-12` remain visible only as completed references. `GC-P2-13` remains a
  deferred product-design reminder.
- New implementation work updates the relevant owner contract and the master
  program rather than creating another competing parity ledger.

## Shipped post-1.0

The 2026-05-17 OpenClaw / Hermes review rechecked earlier MISSING/PARTIAL claims against current code and found many items already implemented. Keep this ledger current before running another upstream gap pass.

| Capability | Status | Implementation anchor |
|---|---|---|
| `/steer` mid-run injection | shipped | `apps/gateway/src/services/chat-steer-service.ts`, `apps/gateway/src/services/chat-steer-route.ts` |
| `/goal` Ralph loop | shipped | `apps/gateway/src/services/chat-goal-command.ts` |
| Multi-agent Kanban operator surface | shipped | `apps/mission-control-next/src/features/native-routes/ops/KanbanRoutePage.tsx` |
| Hallucination distress gate | shipped | `packages/contracts/src/task-distress.ts` |
| Auto-block on incomplete durable exit | shipped | `apps/gateway/src/services/durable-run-service.ts` |
| Subagent first-message materialization | shipped | `apps/gateway/src/services/chat-delegation-service.ts` |
| Checkpoint auto-resume and orphan pruning | shipped | `apps/gateway/src/services/durable-run-service.ts`, `packages/storage/src/durable-run-repo.ts` |
| Model `contextWindow` truth and refreshed provider catalog | shipped | `packages/contracts/src/llm.ts`, `packages/contracts/src/provider-templates.ts` |
| `loadAndSanitize<T>()` JSON-store quarantine | shipped | `packages/storage/src/load-and-sanitize.ts` |
| Autonomous curator | shipped | `apps/gateway/src/services/curator-service.ts` |
| Configurable child timeout and depth | shipped | `apps/gateway/src/services/subagent-budget-enforcer.ts` |
| Cron `no_agent`, `context_from`, `workdir`, and `run --wait` | shipped | `apps/gateway/src/services/gateway/cron-no-agent-support.ts`, `apps/gateway/src/cron-cli.ts` |
| Runtime hooks including `tool.call.before` intercept | shipped | `packages/contracts/src/hooks.ts` |
| `[[as_document]]` directive | shipped | `apps/gateway/src/services/skill-output-directives.ts`, `apps/gateway/src/services/connector-delivery.ts` |
| Channel bot-loop guard | shipped | `apps/gateway/src/services/channel-bot-loop-guard.ts` |
| Tree-sitter shell command explainer | shipped | `apps/gateway/src/services/approval-lifecycle-service.ts` |
| Compaction reserve clamp | shipped | `apps/gateway/src/services/chat-compaction.ts` |
| Secret redaction, env/auth perms, SSRF floor, approval actor binding, media sniffing, MCP aborts, Docker hardening | shipped | `packages/gateway-core/src/logger.ts`, `apps/gateway/src/env-file.ts`, `packages/policy-engine/src/sandbox/network-guard.ts`, `apps/gateway/src/routes/approvals.ts`, `apps/gateway/src/services/media-voice-service.ts`, `packages/policy-engine/src/browser-tools.ts`, `docker-compose.yaml` |
| Provider-owned JSON errors and transport split | shipped | `apps/gateway/src/services/llm-service.ts`, `packages/contracts/src/llm.ts` |
| Trajectory export malformed JSONL tolerance and cron doctor repair | shipped | `packages/storage/src/transcript-log.ts`, `apps/gateway/src/orchestration/engine.cron-repair.test.ts` |
| Telegram home delivery, inline approvals, pairing, personalities, target directory, and config mtime cache | shipped | `apps/gateway/src/services/telegram-channel-commands.ts`, `apps/gateway/src/services/approval-connector-delivery.ts`, `apps/gateway/src/services/telegram-channel-pairing.ts`, `apps/gateway/src/services/channel-personalities.ts`, `apps/gateway/src/services/channel-target-directory.ts`, `apps/gateway/src/config.ts` |
| Plugin `tool_override` | shipped | `apps/gateway/src/services/plugin-tool-override-service.ts`, `apps/gateway/src/services/tool-invocation-coordinator-service.ts` |
| Native Telegram/Discord channel attachment upload | shipped; hardened 2026-05-18 | `apps/gateway/src/services/channel-attachment-payload.ts`, `packages/policy-engine/src/tool-executor.ts` |
| Lazy provider imports | reclassified audit-only | No eager `openai`, `@anthropic-ai/sdk`, or `firecrawl` SDK imports were found in gateway provider dispatch during the 2026-05-18 recheck. |
| Link summarizer SSRF | N/A as standalone gap | Browser/search/ingestion fetch paths use `packages/policy-engine/src/sandbox/network-guard.ts` for public egress and host-class checks; the canonical local Firecrawl path keeps loopback fetch for the bundled service while still validating delegated source/final URLs. No separate gateway link summarizer was found. |
| Dashboard plugin script SRI | N/A pending dynamic script support | No Mission Control dynamic plugin `<script src>` injection path was found in the 2026-05-18 audit. |

## Future Gap Review Methodology

Any future MISSING conclusion must include:

- upstream feature name and behavior
- at least 3 grep terms, including synonyms and GoatCitadel naming variants
- files opened after empty grep results to confirm the concept is not implemented under another name
- a second independent verification pass before the item enters the report

Any future PARTIAL conclusion must also include:

- exact file paths and line numbers for what exists
- the specific upstream delta, not a vague “weaker than” claim
