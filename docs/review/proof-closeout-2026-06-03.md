# GoatCitadel Proof Closeout - 2026-06-03

Proof-start SHA: `c4802137607622f0231c4c4df0a289d949f1eaa6`

Evidence scope: local proof run from `F:\code\personal-ai` on `main`, starting at the SHA above and then applying the OAuth/MCP proof diff recorded in this commit. Pre-existing untracked dirty files were preserved. A committed file cannot contain the hash of the commit that contains it, so the pushed commit SHA must be supplied by remote ref parity after commit/push. CI exact-SHA workflow proof was not triggered or inspected in this local pass.

## Evidence Index

| Lane | Command | Status | Artifact |
|---|---|---:|---|
| Code Mode sandbox | `pnpm verify:code-mode:sandbox` | passed | `artifacts/verification/2026-06-03T17-13-31-552Z-code-mode-sandbox-1d46d3b7/manifest.json` |
| Code Mode hostile sandbox | `pnpm verify:code-mode:hostile-sandbox` | passed | `artifacts/verification/2026-06-03T17-13-31-545Z-code-mode-hostile-sandbox-bb5419c5/manifest.json` |
| Agentic governance | `pnpm verify:agentic:governance` | passed | `artifacts/verification/2026-06-03T17-44-58-742Z-agentic-governance-730233f4/manifest.json` |
| Agentic proof | `pnpm verify:agentic:proof` | passed | `artifacts/verification/2026-06-03T18-46-11-544Z-agentic-proof-8b539d36/manifest.json` |
| Focused MCP/OAuth proof | `node scripts/verification/run.mjs agentic-mcp-oauth` | passed | `artifacts/verification/2026-06-03T18-45-57-428Z-agentic-mcp-oauth-5e046247/manifest.json` |
| Mesh package tests | `pnpm --filter @goatcitadel/mesh-core test` | passed | console output only |
| Mesh readiness | `pnpm verify:mesh:readiness` | passed | `artifacts/verification/2026-06-03T17-13-54-331Z-mesh-readiness-c09074a1/manifest.json` |
| Canonical shell parity | `pnpm verify:ui:parity` | passed | `artifacts/verification/2026-06-03T17-16-00-852Z-ui-parity-554b6b45/manifest.json` |
| API compatibility | `pnpm verify:api:compat` | passed | `artifacts/verification/2026-06-03T17-16-37-210Z-api-compat-0f4fb515/manifest.json` |
| Legacy/Next boundary | `pnpm check:legacy:next` | passed | console output only |
| Docs truth | `pnpm docs:check` | passed | console output only |
| Visual regression | `pnpm verify:visual:regression` | passed | `artifacts/verification/2026-06-03T17-17-06-069Z-visual-regression-0f616bc2/manifest.json` |
| Backup roundtrip | `pnpm verify:backup:roundtrip` | passed | `artifacts/verification/2026-06-03T17-28-10-118Z-backup-roundtrip-06255d74/manifest.json` |
| Artifact redaction | `pnpm verify:artifacts:redaction` | passed | console output only |

## Claim Matrix

| Claim | Local closeout status | Proof | Boundary that remains |
|---|---|---|---|
| Cross-platform or general hostile-code sandboxing for Code Mode beyond the named Windows-native proof slice | Windows-native slice proved; broader public claim blocked | `verify:code-mode:sandbox` and `verify:code-mode:hostile-sandbox` passed. `diagnostics/code-mode-hostile-sandbox-proof.json` reports `platform: win32`, `currentPlatformProof.status: pass`, and AppContainer hostile canaries passing for outside-root read/write denial, network denial, env secret absence, symlink traversal denial, process/job limits, artifact hash integrity, and fail-closed required mode. | Do not claim cross-platform/general hostile-code sandboxing. The hostile proof diagnostic keeps `claim.publicClaimAllowed: false`; Linux Firejail and macOS Seatbelt proof remain missing, and CI exact-SHA workflow proof was not inspected in this local pass. |
| Ungoverned autonomous high-risk tool activation | Done as a negative claim: ungoverned activation is not claimed; governed grant path is proved | `verify:agentic:governance` passed. `diagnostics/agentic-governance-autonomy-grants.json` shows deny before grant, matching expiring operator grant, runtime policy/approval still checked, grant revocation, and deny after revoke. Aggregate `verify:agentic:proof` also passed. | High-risk activation is still subordinate to deny-wins policy, approvals, auth, path jails, provenance, health checks, and audit/evidence. Do not mark ungoverned activation implemented. |
| `packages/mesh-core` readiness without a green `verify:mesh:readiness` evidence lane | Done locally | `pnpm --filter @goatcitadel/mesh-core test` passed. `verify:mesh:readiness` passed and `diagnostics/mesh-readiness.json` reports final readiness `ready`, no blockers, and passing checks for local node, join-token lifecycle, mTLS/tailnet posture, lease lifecycle, owner failover, replication offsets, Gateway route visibility, and Settings visibility. | Release-grade marking still needs the committed SHA/CI artifact if this diff is promoted. |
| Compatibility shell parity as canonical product readiness | Done as a negative/canonical-boundary claim: current shell proof is against `apps/mission-control-next`; compatibility shell parity is not claimed as readiness | `verify:ui:parity`, `verify:api:compat`, `check:legacy:next`, and `docs:check` passed. UI parity artifact uses the Next shell diagnostics (`ui-parity-next-*`). | Do not claim compatibility shell parity as canonical product readiness. `apps/mission-control-next` remains the canonical shell proof target. |
| Remote MCP invocation that bypasses Gateway policy, approvals, network allowlists, audit, or supported auth | Done as a negative claim: bypass is not claimed; Gateway-governed invocation is proved | Focused gateway MCP/OAuth suite passed directly and inside `verify:agentic:proof`. Aggregate artifact contains `agentic.mcp-oauth.gateway-governed` with 90 focused tests passed, including routes, admin service, OAuth token service, runtime, and tool invocation coordinator. `verify:api:compat`, `verify:agentic:governance`, and `docs:check` also passed. | Only the Gateway-governed path is closed. Do not claim or expose remote MCP invocation outside Gateway policy, approvals, network allowlists, audit, redaction, realtime/evidence handling, and supported auth boundaries. |
| OAuth-backed remote MCP invocation without OAuth metadata, OS secret-store token refs, ready auth state, and redacted refresh/runtime evidence | Done locally for the governed path | `completeMcpOAuth` now requires an active stored `oauthState` and exact returned `state`, with distinct failures for omitted state, mismatched state, and no active/already-completed handshake. Focused tests cover OAuth token exchange, OS secret-store refs, near-expiry refresh, missing refresh token fail-closed behavior, public `authState` readiness, bearer injection for remote HTTP calls, and no raw-token serialization. `agentic.mcp-oauth.gateway-governed.json` records the focused suite in the named proof lane. | Public API shape remains `/api/v1/mcp/*`, `mcp_auth_state_v1`, and `McpServerRecord.authState`. Final release marking still needs CI or rerun evidence on the pushed commit SHA. |
| Generated screenshot, release proof, installer signing, or backup restore guarantee that was not actually produced | Partially closed: visual regression and backup roundtrip are proved; generated screenshot refresh, signed installer proof, and release proof are not produced | `verify:visual:regression` passed with 344 scenarios, 0 failures, and 0 degraded cases. `screenshots:capture` was not run, so no refreshed generated screenshot files are claimed. `verify:backup:roundtrip` passed and archives `diagnostics/backup-roundtrip-runtime-config.json`. | Signed installer proof and release proof remain blocked/not produced. No unsigned installer smoke was run. No signed installer claim is allowed until the release installer workflow runs with `allow_unsigned=false`, signing secrets present, `signtool verify /pa` green for desktop exe and installer, both Windows targets present, silent install/uninstall smoke green, and `release-certificate.json` green with empty `acceptedFailures`. |

## OAuth/MCP Implementation Notes

- `apps/gateway/src/services/mcp-server-admin-service.ts` now refuses OAuth completion without an active stored handshake state.
- Missing returned `state`, wrong returned `state`, and replay/no active handshake are distinct failures.
- `apps/gateway/src/services/mcp-oauth-token-service.test.ts` adds focused coverage for authorization-code exchange, secret-store token refs, refresh, missing refresh token fail-closed behavior, public readiness projection, and stale token-ref deletion.
- `apps/gateway/src/services/mcp-runtime.test.ts` proves resolved OAuth bearer injection for remote MCP HTTP calls without echoing the raw token.
- `scripts/verification/agentic-proof.mjs`, `scripts/verification/lib/scenarios.mjs`, and `scripts/verification/run.mjs` add a named `agentic-mcp-oauth` scenario and include it in `verify:agentic:proof`.

## Not Produced Or Not Claimed

- Cross-platform hostile-code sandboxing: not claimed; Linux and macOS native canary proof is missing and `publicClaimAllowed` remains false.
- Remote MCP Gateway bypass: not claimed; only the Gateway-governed path is proved.
- Ungoverned autonomous high-risk activation: not claimed; governed grants remain revocable and approval/policy checked.
- Refreshed generated screenshots: not produced because `pnpm screenshots:capture` was not run.
- Signed installer proof: not produced.
- CI exact-SHA workflow proof: not triggered or inspected in this local pass.
