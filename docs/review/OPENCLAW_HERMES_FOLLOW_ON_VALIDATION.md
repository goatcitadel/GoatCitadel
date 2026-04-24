# OpenClaw/Hermes Follow-On Validation Notes

Last updated: 2026-04-24

## Package-Filtered Validation

Use package-filtered commands for this tranche. Root Vitest path globs can recurse into stale `.worktrees/*` checkouts and report duplicate or obsolete failures that are not part of the current workspace diff.

Recommended focused lanes:

```powershell
pnpm --filter @goatcitadel/gateway exec vitest run src/dev-diagnostics/service.test.ts src/services/llm-completion-service.test.ts src/services/tool-invocation-coordinator-service.test.ts src/services/chat-turn-stream-service.test.ts src/services/media-voice-service.test.ts src/services/mcp-runtime.test.ts src/tui/render.test.ts
pnpm --filter @goatcitadel/contracts exec vitest run src/provider-templates.test.ts
pnpm --filter @goatcitadel/mission-control-next exec vitest run src/features/native-routes/SettingsNativePage.test.tsx
pnpm --filter @goatcitadel/gateway typecheck
pnpm --filter @goatcitadel/contracts typecheck
pnpm --filter @goatcitadel/mission-control-next typecheck
pnpm --filter @goatcitadel/mission-control typecheck
pnpm dependency:risk -- --out .codex-tmp/dependency-risk-report.json
```

## Dependency Risk Artifact

`pnpm dependency:risk` prints the report to stdout. Add `-- --out <path>` when an artifact is needed for review bundles or release readiness evidence. Missing owner metadata should stay in this generated report or review docs until owners are chosen deliberately; do not stamp package metadata just to silence the report.
