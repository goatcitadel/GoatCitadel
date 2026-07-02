# 2026-07-02 Findings Remediation

Goal: fix or explicitly retire all 99 verified GoatCitadel review findings with validation evidence.

Baseline:

- Source report: `%USERPROFILE%/Desktop/FINDINGS_REPORT.html`
- Base commit: `67c3adb64a4abb271df7a20a4529c36c3bf669cc`
- Integration branch: `codex/fix-review-findings`
- Current main checkout remains dirty and must not be used for implementation.

Terminal status rules:

- `fixed`: code or docs changed, with targeted proof.
- `merged`: duplicate finding covered by another root fix, with proof named.
- `retired`: not reproducible or intentionally out of scope, with evidence.

## Workstreams

| Owner | Branch | Findings |
|---|---|---|
| Platform/Config | `codex/findings-platform-config` | `XC-windows-parity-1`, `XC-windows-parity-5`, `XC-config-drift-1`, `XC-config-drift-2`, `XC-config-drift-3`, `XC-config-drift-4`, `XC-config-drift-5`, `XC-config-drift-6`, `XC-supply-chain-1`, `XC-supply-chain-2`, `XC-supply-chain-3`, `XC-supply-chain-4`, `XC-supply-chain-5` |
| Security/Policy | `codex/findings-security-policy` | `GW-api-authz-1`, `GW-toolpolicy-a-1`, `GW-toolpolicy-a-2`, `GW-toolpolicy-a-3`, `GW-toolpolicy-b-1`, `GW-toolpolicy-b-2`, `GW-toolpolicy-b-3`, `XC-authz-injection-chains-1`, `XC-authz-injection-chains-2`, `XC-authz-injection-chains-3`, `XC-authz-injection-chains-4`, `XC-authz-injection-chains-5`, `XC-authz-injection-chains-6`, `XC-secrets-redaction-1`, `XC-secrets-redaction-2`, `XC-secrets-redaction-3`, `XC-secrets-redaction-4` |
| Runtime/Orchestration/Memory | `codex/findings-runtime-orchestration` | `GW-concurrency-1`, `GW-concurrency-3`, `GW-concurrency-4`, `GW-orchestrator-a-1`, `GW-orchestrator-a-2`, `GW-orchestrator-a-3`, `GW-orchestrator-b-1`, `GW-orchestrator-b-2`, `GW-orchestrator-b-3`, `GW-orchestrator-b-4`, `GW-orchestrator-b-5`, `GW-turn-pipeline-1`, `GW-turn-pipeline-2`, `GW-turn-pipeline-3`, `GW-memory-1`, `GW-memory-2`, `GW-memory-3`, `GW-memory-4` |
| Storage/CodeMode/Lifecycle | `codex/findings-storage-lifecycle` | `GW-storage-correctness-1`, `GW-storage-correctness-2`, `GW-storage-correctness-3`, `GW-storage-correctness-4`, `GW-storage-perf-1`, `GW-storage-perf-2`, `GW-storage-perf-3`, `GW-codemode-1`, `GW-codemode-2`, `GW-codemode-3`, `GW-resource-leaks-1`, `GW-resource-leaks-2`, `GW-resource-leaks-3`, `GW-resource-leaks-4`, `GW-resource-leaks-5`, `GW-resource-leaks-6`, `XC-perf-system-1`, `XC-perf-system-2`, `XC-perf-system-3` |
| Mission Control Shell/A11y | `codex/findings-ui-shell` | `MC-responsive-1`, `MC-responsive-2`, `MC-responsive-3`, `MC-a11y-1`, `MC-a11y-2`, `MC-a11y-3`, `MC-a11y-4`, `MC-css-tokens-1`, `MC-css-tokens-2`, `MC-css-tokens-3`, `MC-wip-changeset-2`, `MC-wip-changeset-3`, `MC-wip-changeset-4` |
| Mission Control Rendering/Streaming | `codex/findings-ui-rendering` | `MC-chat-render-markdown-1`, `MC-chat-render-markdown-2`, `MC-chat-render-markdown-3`, `MC-chat-render-turncard-1`, `MC-chat-render-turncard-2`, `MC-chat-render-turncard-3`, `MC-streaming-ux-1`, `MC-streaming-ux-2`, `MC-streaming-ux-3`, `MC-streaming-ux-4`, `MC-state-hooks-1`, `MC-state-hooks-2`, `MC-state-hooks-3`, `MC-virtualization-perf-1`, `MC-virtualization-perf-2`, `MC-virtualization-perf-3`, `MC-virtualization-perf-4` |

## Known Duplicate Roots

- Windows spawn: `XC-windows-parity-1` covers `XC-supply-chain-2`.
- Split/unified config drift: `XC-config-drift-2` covers `XC-config-drift-5`.
- Cron metadata drift: `XC-config-drift-3` covers `XC-config-drift-4`.
- Cowork GET reconciliation writes: `GW-orchestrator-b-2`, `GW-concurrency-3`, and `XC-perf-system-3`.
- Tool coordinator policy bypass: `GW-toolpolicy-a-3` and `XC-authz-injection-chains-5`.
- Cowork tabpanel blank/focus: `MC-wip-changeset-4` and `MC-a11y-4`.
- Markdown renderer contract: `MC-chat-render-markdown-1`, `MC-chat-render-markdown-2`, `MC-chat-render-markdown-3`, and `MC-virtualization-perf-1`.

## Final Proof Checklist

- `pnpm verify:repo:hygiene`
- `pnpm verify:extensions:package`
- `pnpm --filter @goatcitadel/storage test`
- Postgres storage lane if available in this checkout
- focused gateway security/runtime tests named in worker reports
- focused Mission Control shared/threaded/next tests named in worker reports
- `pnpm typecheck`
- `pnpm docs:check`
- `pnpm verify:fast`
- `pnpm verify:runtime:truth`
- `pnpm verify:durable:recovery`
- `pnpm verify:agentic:governance`
- `pnpm verify:surface:regression`
- `git diff --check`

## Closeout Log

Worker results and coordinator merge decisions go here before the final commit.
