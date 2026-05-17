# Verification — Model contextWindow truth + Provider catalog refresh

> Verification-note artifact only. This document records the checks from that workstream and must not be cited as current release proof unless rerun on the target commit or backed by current CI evidence.

## Branch

`goatrocity/jolly-allen-0fad0f` — open as PR with title `feat: model contextWindow truth + provider catalog refresh`.

## Plan

`docs/superpowers/plans/2026-05-15-model-contextwindow-truth-catalog-refresh.md`

## Static evidence

### Test coverage added per task

| Task | New test file or assertions | Pass count |
|------|-----------------------------|------------|
| 1+2  | `packages/contracts/src/llm.context-window.test.ts`; one new test in `packages/contracts/src/config-schemas.test.ts` for bedrock-messages zod runtime | 4 + 1 |
| 3    | `packages/contracts/src/llm-model-metadata.test.ts` (4 tests; 25-entry count asserted) | 4 |
| 4    | `apps/gateway/src/services/llm-model-metadata.test.ts` (4 loader + 4 lookup tests + tmpdir cleanup) | 8 |
| 5    | `apps/gateway/src/services/chat-compaction.clamp.test.ts` (5 boundary cases) | 5 |
| 6    | `apps/gateway/src/services/llm-service.contextwindow.test.ts` (decoration + clamp + runtime config + env-var + configFilePath path tiers) | 12 |
| 7    | doctor probe, admin-cli, TUI helper, ChatModelPicker — 2 each + 1 boundary test for formatContextWindow | 9 |
| 8    | `apps/gateway/src/services/llm-providers-example.catalog.test.ts` (xAI, DeepSeek v4-pro, Kimi K2.6, OpenAI Codex GPT-5.5) | 4 |
| 9    | one new test + assertion update in `provider-templates.test.ts` for openai/chat-latest | 1 |

### Gates run

- `pnpm -r typecheck` — PASS (15/15 packages, including apps/gateway, apps/mission-control, apps/mission-control-next)
- `pnpm --filter @goatcitadel/contracts test` — PASS (12 files, 105 tests)
- `pnpm --filter @goatcitadel/gateway test` — PASS (440 files, 2754 tests) after Task 10 fixed two pinned shortlist expectations introduced by Task 9. One pre-existing baseline timeout in `skill-import-service.loop41.test.ts` (zip install) is unchanged from baseline (verified by stashing this branch's changes and re-running). The repo memory note records 22 pre-existing baseline failures; this branch leaves them at the same count.
- `pnpm --filter @goatcitadel/mission-control-shared test` — PASS (86 files, 399 tests)
- `pnpm -r build` — PASS (15/15 packages built)
- `pnpm smoke` — PASS (all sub-smokes green; gateway-events, sessions, chat, prompt-packs, tools, native-tools-expansion, approvals, agents, integrations, secrets, mesh, npu, onboarding)

### Task 10 pre-fix: bedrock-messages apiStyle union widening

Task 2 widened `LlmApiStyle` in `packages/contracts` to a 5-member union. Several hand-maintained narrow 4-member literal unions remained in non-contracts files. Task 10 widened them (commit `0686d38c`):

- `apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx` (ProviderEditorDraft, buildProviderEditorDraft, PROVIDER_API_STYLE_OPTIONS)
- `apps/mission-control/src/api/{types,settings,platform}.ts`
- `apps/mission-control/src/pages/settings/settings-page-constants.ts` (PROVIDER_API_STYLE_OPTIONS now exposes Bedrock Messages option)
- `packages/mission-control-shared/src/api/{types,settings,platform}.ts`
- `apps/gateway/src/routes/{dashboard,onboarding}.ts` (zod enum schemas)

### Task 10 pre-fix: Task 9 shortlist test update

`apps/gateway/src/services/llm-service.test.ts` had two tests pinning the legacy 5-entry OpenAI shortlist. Task 9 (`055291cb`) added `chat-latest`, making the lists 6-entry. Updated both expectations (commit `67a81133`).

## Manual probe checklist (live verification)

These probes cannot run from CI/agent. The user should execute them.

- [ ] Switch active provider to `openai-codex`. Run `pnpm --filter @goatcitadel/gateway exec node dist/admin-cli.js admin llm status`. Assert output contains `Context window: 272,000` and `Output limit: 32,000`.
- [ ] Switch to `anthropic` provider with active model `claude-opus-4-7`. Run the same admin-cli command. Assert `Context window: 1,000,000`.
- [ ] Set `XAI_API_KEY` and switch to `xai` provider with active model `grok-4.3`. Run admin-cli status. Assert `Context window: 1,000,000`.
- [ ] Trigger a chat completion where the LLM service is asked to clamp a summary reserve (this requires a code path that calls `clampActiveModelSummaryReserve`). Inspect logs for the clamp warning text `compaction summary reserve clamped from N to model output limit M`.
- [ ] Open the Mission Control UI. Confirm the ChatModelPicker shows the catalog/probe context-window badge when metadata is present (for example, `272K` for Codex or `1M` for a manifest entry with 1,000,000 tokens). Do not treat the badge as provider-verified unless a live provider probe supplied that metadata.
- [ ] Run `pnpm --filter @goatcitadel/gateway exec node dist/doctor/cli.js --deep`. Confirm the `llm.active-model-metadata` probe is OK when the active model is in the manifest, warns when it isn't.

## Deferred follow-ups (NOT in this PR)

- DeepSeek v4-pro: strip empty `reasoning_content` placeholders before follow-up turns. Needs adapter work in `llm-provider-adapter.ts` or the deepseek transport. Tracked separately.
- Bedrock concrete transport adapter — `bedrock-messages` is added to `LlmApiStyle` and the example zod enums; actual SigV4 + bedrock-runtime client is a separate PR.
- xAI OAuth flow — current provider entry uses `apiKeyEnv`. OAuth would extend `LlmProviderAuthMode` and add an OAuth service stub.
- Doctor probe asymmetric loopback severity (vs `checkDeepRuntime`) — minor consistency fix.
- Admin-cli optional chaining cleanup on a required field — cosmetic.

## Commit history

```
67a81133 test(gateway): update OpenAI shortlist expectations to include chat-latest
0686d38c fix(mc,mc-next,mc-shared,gateway): widen apiStyle unions to include bedrock-messages
055291cb feat(contracts): list openai/chat-latest as ChatGPT Instant alias
f882b40a feat(config,contracts): refresh provider catalog (xAI Grok, DeepSeek v4-pro, Kimi K2.6)
3522fc70 fix(mc-shared): promote ChatModelPicker contextWindow badge to '1M' at sub-million boundary
963e9508 feat(gateway,mc-shared): surface active model contextWindow on doctor, admin-cli, tui, ChatModelPicker
d107caba fix(gateway): per-provider metadata tracks activeModel for active provider; cover env-var + configFilePath path tiers
fe13e65f feat(gateway): enrich LLM model records with manifest metadata; expose clampActiveModelSummaryReserve
548b099a feat(gateway): clamp compaction summary reserve to model output limit
3a3181bc test(gateway): clean up tmpdir + tighten shape-error assertion; remove redundant spread
0f37cad0 feat(gateway): add LLM model metadata loader with glob-pattern lookup
e5964376 test(contracts): hoist manifest fixture to module scope + assert 25-entry count
aa4ad7ff feat(contracts,config): add LLM model metadata manifest with contextWindow/outputTokenLimit
ee67dcf5 test(contracts): add runtime test for bedrock-messages zod enum + clarify describe label
2b0b64c2 feat(contracts): add contextWindow/outputTokenLimit + bedrock-messages api style
```
