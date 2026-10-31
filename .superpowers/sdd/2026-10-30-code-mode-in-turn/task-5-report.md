# Task 5 report
- Added collectGapEvidence/GapEvidence, unreadableAttachments input, evidence-gated code_mode_build (no keyword-only, none after code_mode.request), new titles.
- Attachment lookup lives in chat-capability-scout.ts (withUnreadableTurnAttachments); gateway-service.ts net 0 lines (line budget 13132).
- Fixture: apps/gateway/src/services/__fixtures__/scout-saturday-session.ts
- RED: 2 new tests failed before implementation. GREEN: chat-capability-scout.test.ts 14/14; gateway tsc clean.

## Fix round 1

Finding 1 (Important, gapEvidence widened every lane): in `scoutCapabilityUpgradeSuggestions` the two early-return gates are restored to their original form (tool-oriented/artifact intent AND GAP_SIGNAL/missing-artifact) as `legacyGate`. When `legacyGate` fails, evidence only produces the Code Mode build suggestion (unless the turn already ran `code_mode.request`) and returns without touching the skill, source-lookup or MCP-template lanes. When `legacyGate` passes, behaviour is as before, including the evidence-driven Code Mode fallback.

Covering tests: `apps/gateway/src/services/chat-capability-scout.test.ts` (new test "evidence alone never runs the skill, source or MCP lanes" uses throwing deps on an evidence-only turn).

Command: `pnpm --dir apps/gateway exec vitest run src/services/chat-capability-scout.test.ts --maxWorkers=2`
Output: 1 file passed, 15 tests passed.
