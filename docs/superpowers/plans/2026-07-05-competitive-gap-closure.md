# GoatCitadel Competitive-Gap Closure Program

## Context

The 2026-07-05 daily competitive-watch report (GoatCitadel 0.1.0-rc.1 vs OpenClaw, Hermes Agent, SwarmClaw, openclaw-code-agent) found GoatCitadel decisively ahead on governance, signed evidence, supply-chain proof, and mesh — but exposed on **reach and autonomy** (channel breadth, voice, self-improving memory, scheduler surface, provider breadth). User-approved scope: the report's recommended set (3 critical gaps + scheduler, aggregator, utility-model tier), as a phased program doc; mobile/visual-builder/serverless/external-harness explicitly deferred.

**Key finding from exploration:** the report was built from public README/CHANGELOG only, and the docs badly undersell shipped code. In reality:

- **Channels**: 15 setup definitions exist (`apps/gateway/src/services/channel-setup-definitions/`) including WhatsApp (stable, signed webhook inbound + rich media), Signal (outbound-only via bridge), iMessage, Teams, Google Chat, LINE, Zalo. README line 90 claims ~5. Signal inbound was investigated and is deliberately quarantined until a bridge offers durable acknowledgement/replay; the remaining gap is truthful breadth and diagnostics, not unsafe polling.
- **Voice**: `media-voice-service.ts` (bounded whisper.cpp transcription), `voice-runtime/` managed installer already exist — but inbound channel voice is a text placeholder (`"[whatsapp audio]"`; Telegram voice notes silently dropped) and **no TTS engine exists** in the repo.
- **Aggregator**: OpenRouter template + `openai-chat-completions` adapter + env-allowlisted `OPENROUTER_API_KEY` already exist. Real gap: model-discovery sync, metadata/pricing, and data-sensitivity posture.
- **Scheduler**: cron CRUD, durable runtime, model-callable `schedule.manage` (capped), `deliveryChannel` to channels, and an ops-schedules UI page all exist. Real gap: `cron_job_executed` is not an evidence kind; runs carry no envelope; README says nothing.
- **Memory**: `proposeTraceMemoryCandidate` / `promoteTraceMemoryCandidate` already exist. Real gap: a scheduled trace-mining producer, batch approval, dedup search, threshold config.
- **Utility model tier**: genuinely absent — but note titles/compaction are heuristic (no LLM); the real consumers are improvement/background-review/proactive-planner/judge/classifier services.

First deliverable of execution: copy this program doc to `docs/superpowers/plans/2026-07-05-competitive-gap-closure.md`.

## Program conventions (apply to every phase)

- **Feature flags are inert without 5 edits**: `packages/contracts/src/config-schemas.ts` (FeatureFlagsConfig ~line 672), `apps/gateway/src/config.ts` (interface ~77, env map ~686, defaults ~1220), `apps/gateway/src/services/gateway-service.ts` (`readFeatureFlags` ~8663 + `updateFeatureFlags` ~8604), and `gateway-service.feature-flags.roundtrip.test.ts` `ALL_FLAGS_SET` (compile-time exhaustive — build breaks until complete).
- **Testing**: never run vitest and tsc concurrently; `--maxWorkers=2`; run whole test files (not `-t` name filters — non-matching silently skip). `provider-templates.test.ts` pins `knownModels` exactly.
- **Mission-control UI**: bespoke CSS design system, `--accent` tokens only (never `--mc-accent`), no Tailwind.
- Each slice is independently shippable and kill-switched; land as separate PRs.

---

## Phase 0 — Documentation truth (ship first, zero code risk)

Fixes the exact inputs the competitive scan measures. No flag.

- `README.md:90` + mermaid at `:375`: enumerate real channel breadth (14 named channels + generic webhooks, with outbound-only/bridge caveats for Signal/iMessage); add a "Governed schedules" feature bullet (capped `schedule.manage`, review queue, channel delivery — evidence claim added in Phase 3).
- `docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md`: per-channel matrix (archetype, inbound/outbound posture, media) sourced from `CHANNEL_RULES` in `packages/gateway-core/src/channel-core.ts`.
- Optional drift guard: small test asserting catalog channel count matches the guide's claim.

**Verify**: docs render; `validate-governance-docs.mjs` still green (do not touch its verbatim-pinned phrases).

---

## Track A — Intelligence

### Phase A1 — Utility-model tier (`utilityModelRoutingV1Enabled`, default off)

Smallest slice; A3 consolidation drafts on this tier, so it lands first. Flag off ⇒ byte-identical behavior.

- Add optional `utilityProviderId`/`utilityModel` slot to `LlmConfigFileSchema` (`packages/contracts/src/config-schemas.ts:262`) + runtime types in `packages/contracts/src/llm.ts`; plumb through `LlmService` (`llm-service.ts` ~255/342/385).
- Replace `GatewayService.getPromptRunnerModelDefaults()` (`gateway-service.ts:4078`) with `getModelDefaultsForPurpose("main" | "utility")`; utility returns the slot only when flag on + provider `hasApiKey`, else falls through to main (keep old method as alias; keep glm/moonshot fallback chain last).
- Flip background consumers to `"utility"` one at a time (independently revertable): `improvement-service.ts` (:376/:5007), `background-review-service.ts`, `chat-proactive-denovo-planner.ts`, `surface-router-judge.ts`, `gateway/commitment-classifier-service.ts`. Do NOT touch chat-turn/orchestration/research paths.

**Verify**: `llm-service.test.ts` slot roundtrip; resolver matrix tests (off→main, on+no-key→main, on+key→utility); flag roundtrip test; manual: set cheap utility model, force-run weekly improvement job, confirm `chat.completion.start` diagnostics log utility provider/model.

### Phase A2 — Aggregator (OpenRouter) completion (`aggregatorCatalogSyncV1Enabled`)

- **Step 1 (trace first — flagged assumption)**: confirm whether builtin `ProviderProfile.modelDiscovery` (`provider-templates.ts:252`) is consumed by `fetchModelsForResolvedProviderUncached` (`llm-service.ts:1610`); add an OpenRouter `/models` parser (nested `context_length`, `pricing`) feeding `ModelCatalogItem` (source union already includes `"openrouter"`).
- Feed discovered `context_length` into the `activeModelContextWindow` paths (`llm-service.ts:329-337`); extend `llm-pricing.ts` to prefer discovery-reported pricing for aggregators.
- **Governance (ships unflagged — a restriction, not a feature)**: export `AGGREGATOR_PROVIDER_IDS` in `provider-templates.ts` (do NOT reuse `FOREIGN_MODEL_PROVIDER_IDS` — it includes local hosts); add posture helper in `packages/contracts/src/citadel-model-routing.ts`: aggregator = cloud AND denied for `prefer_local`/`local_only`/`never_send`; allowed for `any_approved`/`approved_cloud_or_local`/`cloud_with_approval`. Enforce at `routeModelForSensitivity` consumers (verify call sites during implementation).
- Setup/docs: onboarding-tui copy; optional mission-control provider settings surfacing.

**Verify**: contracts posture-matrix test (6 sensitivities × local/cloud/aggregator); discovery parsing against a canned fixture (no live network); update `provider-templates.test.ts` pins if `knownModels` changes; manual e2e: discover models, chat via an OpenRouter model, confirm cost tagging, confirm a `sensitive`-chamber request refuses the aggregator with a clear error.

### Phase A3 — Governed background memory consolidation (`memoryConsolidationV1Enabled`, default off; also gated by `autonomyV1Disabled`)

Largest slice; proposal-first on existing rails — the job never writes approved memory.

- **Create** `apps/gateway/src/services/memory-consolidation-service.ts`: gate (both flags, checked at job start AND before promotion) → mine hydrated turns since watermark via `runtime-lifecycle-read-service.ts` / `chat-turn-trace-repo.ts` → quality thresholds from a new `MemoryConsolidationConfigSchema` in `config-schemas.ts` (reflection `outcome ∈ {recovered, not_needed}`, `maxReflectionAttempts`, `minRetrievalConfidence` L0-L2, `minCandidateConfidence`, `maxCandidatesPerRun` — note `reflection` has no numeric score; thresholds are over outcome/attempts/confidences) → draft insights on the **utility tier** (A1) → dedup via new `findSimilarMemories()` on `MemoryLifecycleService` (embedding cosine via `memory-embedding-metadata.ts:22` + existing BM25/lexical scoring) → `proposeTraceMemoryCandidate(input, "consolidation-job")` after `MemoryWriteGateService.evaluate`.
- **Batch approval**: one `ApprovalRequest` per run, `kind: "memory.consolidation.batch"` (kind is a free string), `riskLevel: "low"`, preview lists candidates; flows through `mcp-approval-inbox.ts` automatically. Resolution in `approval-resolution-effects-service.ts`: approve → `promoteTraceMemoryCandidate` per candidate (v1 all-or-nothing unless the existing `edit` decision path supports partial — flagged assumption); deny → mark rejected.
- **Audit/rollback**: every promotion recorded via `autonomyControlService.recordAutonomousMutation` (`:113`) with rollback payload so `revertAutonomousChangesSince` (`:151`) can supersede/forget.
- **Cron wiring**: `MEMORY_CONSOLIDATION_WEEKLY_JOB_ID` in `gateway/cron-job-ids.ts`; register in `cron-automation-service.ts` `SYSTEM_CRON_JOB_IDS` (:80); seed disabled in `cron-job-config-helpers.ts` (pattern: `MEMORY_FLUSH_DAILY`); dispatch in `gateway-service.ts` (~3082-3122 pattern).
- **Sensitivity**: skip turns from `sensitive`+ chambers unless the utility model is local (enforce via A2's posture helper).

**Verify**: new service tests (threshold filtering, dedup skip, batch proposal, zero writes when flag off / kill switch on, watermark advance); resolution-effects tests (approve→promote+audit, deny→rejected, kill-switch-mid-resolution→no promotion); cron registration test; flag roundtrip; manual e2e: enable, force-run, review candidates in `MemoryRoutePage`, approve batch from inbox, confirm promotion, then `revertAutonomousChangesSince` and confirm supersede.

---

## Track B — Reach

### Phase B1 — Channel completion

**B1a WhatsApp hardening (no flag — existing stable path)**: negative-path tests in `whatsapp-webhook.test.ts` (signature mismatch, missing app secret, replayed eventId, non-allowlisted sender rejected pre-ingest, oversized body); tighten wizard copy in `channel-setup-definitions/whatsapp.ts` (inbound requires app secret + verify token, matching `channel-core.ts:449-453`); full Cloud API walkthrough in the setup guide.

**B1b Signal inbound — retired/quarantined 2026-07-13.** The evaluated bridge receive operation has no durable acknowledgement or replay contract. Because a crash after destructive receive but before local commit could lose a message, production must not poll it. Signal remains outbound-only through the existing JSON-RPC send path. Legacy `signalInboundV1Enabled=true`, connection `inboundEnabled=true`, and polling interval settings fail closed with operator-visible diagnostics. Revisit inbound only when a bridge can prove durable cursor/acknowledgement and replay semantics.

**Verify**: gateway + gateway-core vitest; `pnpm run verify:channels:runtime`; production-source scan proving no receive endpoint or inbound dispatch wiring; legacy inbound settings produce diagnostics without scheduling or fetching; outbound sandbox send remains available.

### Phase B2 — Voice via channels

**B2a Inbound voice → transcription → governed turn (`channelVoiceInboundV1Enabled`)**
- Webhook parsers emit structured `voiceMedia` instead of placeholders: `whatsapp-webhook.ts` audio case (:154-156), `telegram-webhook.ts` handle `message.voice`/`message.audio` (currently dropped, :112).
- **Create** `apps/gateway/src/services/channel-voice-inbound-service.ts`: per-channel media download (WhatsApp Cloud API media GET — net-new, SSRF-safe via `isConnectionUrlAllowlisted` pattern; Telegram `getFile`), 8MB cap, → `mediaVoiceService.transcribeVoice()` (`media-voice-service.ts:602`, already bounded/sniffed).
- `webhook-handler-factory.ts`: **trust gate first, transcription only for allowlisted senders**; ack webhook fast, transcribe async, ingest transcript framed as `[voice transcript — untrusted, auto-transcribed] …`; transcription failure falls back to placeholder ingest (never silently dropped). Transcripts are **excluded from channel command parsing and approval-token resolution** — voice is spoofable; commands require typed text.

**B2b TTS reply out (`channelVoiceReplyV1Enabled`, independent kill switch)**
- Add a Piper (or equivalent) lane to `voice-runtime/` catalog/download/installer/status (same sha256-pinned shape as whisper); `media-voice-service.ts` gains `synthesizeSpeech()` with bounded subprocess + ffmpeg per-channel format (Telegram ogg/opus).
- **Create** `channel-voice-reply-service.ts`; deliver via existing outbound attachment lane (`channel-attachment-payload.ts`, no new transport). Pref `voiceReplyMode: off | voice-on-voice | always` (default off); text reply always sent too. TTS renders only the already-policy-gated reply — no new input surface. Talk mode / wake word out of scope.

**Verify**: mime-sniff/size-cap/allowlist tests mirroring `media-voice-service.sniff.security.test.ts`; non-allowlisted sender never spawns whisper; manual: Telegram voice note in → transcript turn → ogg voice reply back.

### Phase B3 — Scheduler elevation

**B3a Evidence on every cron run (`cronEvidenceV1Enabled`)**
- `packages/contracts/src/evidence.ts`: add `"cron_job_executed"` to the event-kind union (verified absent).
- `packages/contracts/src/monitoring.ts`: `CronJobRecord.lastRunEvidenceEnvelopeId?`.
- `gateway/cron-automation-service.ts`: add `recordEvidenceEnvelope` to deps (copy durable-run threading at `gateway-service.ts:1297` with the try/catch wrapper at `:1517` — envelope failure never fails the run); create envelope in `recordCronRunSuccess` (:734) and `recordCronRunFailure` (payload: jobId, action, schedule, status, outputHash, childDurableRunId/TurnId, profilePosture, deliveryChannel); `CronRunSnapshot.evidenceEnvelopeId` populated in `findCronRunById` (:567). Do NOT touch `schedule-tool-support.ts` caps.
- Honest limitation: cron persistence is last-run-pointer; the append-only envelope chain IS the durable per-run history (a `cron_run_history` table is an optional follow-up).

**B3b Operator surface**: enhance the existing schedules page (`apps/mission-control-next/.../ops/RuntimeRoutePage.tsx` case "schedules", :452) — last-run status/evidence chip, delivery target, review-queue link; extend the `data.timeline?.scheduler` data source (flagged assumption: feeding hook/endpoint not yet traced — locate before extending).

**B3c Docs**: README scheduler bullet gains "per-run signed evidence"; new `docs/SCHEDULER_GOVERNANCE.md` (caps, `SCHEDULED_TURN_PERMISSION_PROFILE`, deliveryChannel, evidence semantics).

**Verify**: cron-automation + evidence-chain tests (cron envelope chains under HMAC tests); mission-control vitest; `pnpm run verify:surface:regression`; manual: 15-min `agent_turn` job with Telegram delivery → output on channel, envelope id in UI resolves in the evidence repo.

---

## Suggested execution order

Phase 0 → A1 → A2 → B1a → B1b quarantine → B3 → B2a → A3 → B2b. Rationale: docs fix the scoreboard immediately; A1 is the smallest code slice and a dependency of A3; B1/B3 are contained; B2a needs B1's dispatch seam settled; A3 and B2b are the largest/newest-surface slices. Tracks A and B are independent and can interleave freely.

## Flagged assumptions to resolve during implementation

1. Signal inbound remains blocked unless a future pinned bridge version exposes and proves durable cursor/acknowledgement and replay semantics.
2. Whether builtin `modelDiscovery` descriptors are consumed by `llm-service.ts` discovery (A2 step 1 is "trace this first").
3. Mission-control data source for the schedules timeline payload.
4. Whether the approval `edit` decision path supports per-candidate partial batch approval (else A3 v1 is all-or-nothing).
5. WhatsApp Cloud API media download is net-new code (no existing helper).
6. No TTS engine exists anywhere in the repo (verified in voice-runtime; broad grep elsewhere clean).

## Program-level verification

Per slice: package-scoped `pnpm vitest run --maxWorkers=2` (contracts, storage, gateway-core, gateway, mission-control-next as touched), flag roundtrip test compiles, then the slice's manual e2e probe listed above. Per phase: husky pre-commit green; `verify:channels:runtime` (B1/B2), `verify:surface:regression` (B3b). Program end: re-run the daily competitive-watch routine and confirm the parity matrix rows for channels/voice/scheduler/memory/providers move from partial/none.
