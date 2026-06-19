# EDGES — wiring the four user-provided inputs

This document is the **drop-it-here contract** for the four external inputs the
operator supplies. For each edge it states *exactly* what to provide, *where the
code reads it* (cited to `file:line`), and a *"verify it worked"* step.

Every claim is grounded in the actual integration point — read the cited line
before relying on it. Where an integration point does **not** exist yet (needs
building, not just configuring) it is flagged **⚠ NOT WIRED**.

Companion: the head-to-head benchmark in [`benchmark/`](./benchmark/README.md)
consumes edges 1 (provider keys) and 2 (competitor builds) directly; see
`benchmark/targets.example.json`.

Status at a glance:

| Edge | State | Where it plugs in |
| --- | --- | --- |
| 1. Provider API keys | ✅ Wired (env **and** Settings UI + OS keychain) | `OPENAI_API_KEY` etc. / `POST /api/v1/secrets/providers/:id` |
| 2. Competitor builds | ✅ Wired (benchmark seam) | `benchmark/targets.json` |
| 3. Code-signing + notarization | ✅ Wired (scripts + CI secrets) | `WINDOWS_SIGN_CERT_*`, `GOATCITADEL_MACOS_NOTARY_*` |
| 4. Test channels | ✅ Wired (Settings UI + env-var refs + OS keychain) | `POST /api/v1/channels/drafts…/finalize` |

---

## Edge 1 — Provider API keys

**Provide:** an API key for at least one model provider. Two equivalent paths.

### Path A — environment variables (fastest for dev/CI)

Set the provider's env var before starting the gateway. The canonical names live
in `.env.example` (copy it to `.env`):

| Provider | Env var | `.env.example` |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `.env.example:10` |
| Anthropic | `ANTHROPIC_API_KEY` | `.env.example:11` |
| Claude Code (OAuth, Bearer) | `CLAUDE_CODE_OAUTH_TOKEN` | `.env.example:13-14` |
| Google | `GOOGLE_API_KEY` | `.env.example:15` |
| GLM | `GLM_API_KEY` | `.env.example:16` |
| Moonshot | `MOONSHOT_API_KEY` | `.env.example:17` |
| Perplexity | `PERPLEXITY_API_KEY` | `.env.example:18` |

The provider→env-var binding (`apiKeyEnv` / `apiKeyRef`) is declared per provider in
`config/goatcitadel.example.json:289-394` and defaulted in
`apps/gateway/src/config.ts:1231-1328` (OpenRouter, Mistral, DeepSeek, MiniMax,
LM Studio, etc. are also there).

At runtime the gateway resolves a provider's key with this precedence —
**keychain → env var → inline config** — in `LlmService.resolveApiKey`
(`apps/gateway/src/services/llm-service.ts:1176-1191`; the env read is
`this.env[provider.apiKeyEnv]` at **line 1182**, mirrored at line 1313/576 for
the config-detail and upsert paths).

### Path B — Settings → Providers UI (persisted, OS keychain)

In Mission Control: **Settings → Providers & Models** (the "Providers" tab,
`apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx:675`;
panel `ProvidersSection` at line 2187, titled "Providers & Models" at line 2842).
Pasting a key calls `handleSaveSecret`
(`SettingsNativePage.tsx:2493-2510`) → `saveProviderSecret`
(`packages/mission-control-shared/src/api/platform.ts:523-528`) →
**`POST /api/v1/secrets/providers/:providerId`** with body `{ "apiKey": "<key>" }`
(`apps/gateway/src/routes/secrets.ts:44`, rate-limited 10/min at lines 21-25).

Server-side that calls `persistProviderApiKeyWithFallback`
(`apps/gateway/src/services/provider-secret-persistence.ts:42`), which writes to
the **OS secret store first** (`setProviderApiKey`, line 49) — Windows Credential
Manager / macOS Keychain / Linux secret-tool, service name `"goatcitadel"`
(`apps/gateway/src/services/secret-store-service.ts:4`, platform branches at
lines 44-50 / 77-85). It only falls back to writing a plaintext `.env` when
`GOATCITADEL_ALLOW_ENV_SECRET_FALLBACK=1` is set
(`provider-secret-persistence.ts:65,136`); otherwise env-fallback is refused.

> Direct API equivalent (no UI): `curl -X POST $GW/api/v1/secrets/providers/openai
> -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)"
> -d '{"apiKey":"sk-..."}'`. The `Idempotency-Key` header is required on all
> mutating requests.

### ✅ Verify it worked

`GET /api/v1/llm/config` (`apps/gateway/src/routes/llm.ts:297`) returns a
`providers[]` array where each entry carries `hasApiKey` and `apiKeySource`
(`"inline" | "env" | "keychain" | "none"` — type at
`apps/gateway/src/services/llm-service.ts:122-123`). The provider you configured
must show `"hasApiKey": true`:

```bash
curl -s $GW/api/v1/llm/config | jq '.providers[] | {providerId, hasApiKey, apiKeySource}'
```

Or run `node benchmark/run.mjs --scenario capability` — `capability.agent-task`
auto-detects the configured provider and drives a real completion. (It reports
**skip** if the key is present but *rejected* by the provider, so a placeholder
key is distinguishable from a valid one.)

---

## Edge 2 — Competitor builds (OpenClaw + Hermes)

**Provide:** the OpenClaw and Hermes binaries (or running instances) so the
benchmark can score GoatCitadel head-to-head.

**Where it plugs in:** `benchmark/targets.json` (gitignored — copy from
`benchmark/targets.example.json`). Each competitor takes either a `command` (a
binary path the runner spawns) **or** a `baseUrl` (an already-running instance),
plus optional `auth`:

```jsonc
{
  "openclaw": { "command": "C:\\tools\\openclaw\\openclaw.exe", "args": [], "baseUrl": null,
                "auth": { "mode": "none", "token": null } },
  "hermes":   { "command": null, "baseUrl": "http://127.0.0.1:9100",
                "auth": { "mode": "token", "token": "..." } }
}
```

The loader is `benchmark/lib/targets.mjs` (`normalizeCompetitor`); a competitor is
"configured" iff a `command` or `baseUrl` is present, otherwise every one of its
scenarios is reported **`skipped: <id> not configured`** rather than failing. Env
overrides exist for CI: `BENCH_OPENCLAW_COMMAND`, `BENCH_OPENCLAW_BASE_URL`,
`BENCH_OPENCLAW_TOKEN` (and `BENCH_HERMES_*`) — see `ENV_OVERRIDES` in
`benchmark/lib/targets.mjs`.

> ⚠ **Adapter not implemented yet (by design):** the harness has the *seam* but
> does not yet *drive* OpenClaw/Hermes protocols. `capability.agent-task` returns
> a clear "adapter not implemented yet" skip for a configured competitor
> (`benchmark/scenarios/capability-agent-task.mjs`). When their HTTP/agent shape is
> known, implement the competitor branch in each scenario's `run(target)`. The
> trust/reliability scenarios are GoatCitadel-contract proofs and intentionally
> skip competitors that expose no equivalent API.

### ✅ Verify it worked

```bash
node benchmark/run.mjs --list      # competitors show "configured" instead of "SKIPPED — not configured"
node benchmark/run.mjs             # scorecard verdict compares pass-counts where a competitor is configured
```

The scorecard (`benchmark/out/scorecard.md`) renders a competitor as
`pending build` until configured, then switches to an actual
`GoatCitadel is ahead of/tied with/behind <competitor>` verdict line.

---

## Edge 3 — Code-signing (Windows) + notarization (macOS)

**Provide:** an Authenticode certificate (Windows) and an Apple Developer ID
certificate + notarization credentials (macOS). **This edge is fully wired** in
the packaging scripts and the release workflow — you supply secrets, no code
changes required.

### Windows Authenticode

The MSIX packager signs with `signtool` when a cert is supplied
(`scripts/packaging/build-windows-msix.mjs:73-88`, resolving `signtool.exe` from
the Windows SDK at line 73). It reads:

| Env var | Meaning | Line |
| --- | --- | --- |
| `WINDOWS_SIGN_CERT_BASE64` | base64-encoded PFX (decoded to a temp file) | `build-windows-msix.mjs:236,244` |
| `WINDOWS_SIGN_CERT_PASSWORD` | PFX password | `build-windows-msix.mjs:228` |
| `GOATCITADEL_WINDOWS_MSIX_PUBLISHER` | publisher CN (default `CN=GoatCitadel`) | `build-windows-msix.mjs:52` |

It can also take `--cert-path`/`--cert-password` args; signing is **required**
unless `--allow-unsigned` is passed (`build-windows-msix.mjs:92`). The Inno-Setup
`.exe` installer itself (`scripts/packaging/build-windows-native-installer.mjs`)
is **signed at the CI layer**, not inside that script.

In CI (`.github/workflows/release-installers.yml`), the Windows job consumes repo
**secrets** `WINDOWS_SIGN_CERT_BASE64` and `WINDOWS_SIGN_CERT_PASSWORD` (scoped to
the signing step only) to sign the desktop `.exe`, the MSIX, and the installer
`.exe`, each followed by `signtool verify /pa`. Set those as GitHub Actions
repository secrets (and optionally a `WINDOWS_MSIX_PUBLISHER` repo *variable*).

### macOS Developer ID + notarization

The macOS packager codesigns with the Developer ID identity and notarizes via
`xcrun notarytool submit … --wait` + `stapler staple`
(`scripts/packaging/build-macos-native-installer.mjs:201` onward), gated on the
`--notarize` flag (line 142). It reads:

| Env var | Meaning | Line |
| --- | --- | --- |
| `GOATCITADEL_MACOS_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` (default `-` = ad-hoc) | `build-macos-native-installer.mjs:36` |
| `GOATCITADEL_MACOS_NOTARY_APPLE_ID` | Apple ID (email) for notarytool | `:191` |
| `GOATCITADEL_MACOS_NOTARY_TEAM_ID` | Apple Developer Team ID | `:192` |
| `GOATCITADEL_MACOS_NOTARY_PASSWORD` | app-specific password (NOT your login) | `:193` |

In CI, the macOS job imports a Developer ID cert from secrets
`MACOS_DEVELOPER_ID_CERT_BASE64` / `MACOS_DEVELOPER_ID_CERT_PASSWORD` into a
temporary keychain, then maps `MACOS_DEVELOPER_ID_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` onto the `GOATCITADEL_MACOS_*`
vars above and runs `pnpm package:macos --target macos-arm64 --notarize`.

> Note: release artifacts are *additionally* cosign-signed for provenance
> (`scripts/release/sign-release-artifacts.mjs`, `COSIGN_YES=true`) — that is a
> separate SBOM-integrity signature, not OS trust, and needs no Apple/Windows cert.

### ✅ Verify it worked

- **Windows:** the packager runs `signtool verify /pa <artifact>`
  (`build-windows-msix.mjs:88`); a clean exit = a trusted signature. Locally:
  `signtool verify /pa GoatCitadel-...msix`.
- **macOS:** the script runs `xcrun stapler staple` + (in workflow) `spctl`
  assessment; locally `spctl -a -vvv -t install GoatCitadel-...dmg` should report
  `accepted` / `source=Notarized Developer ID`.
- **CI dry-check without certs:** the release workflow surfaces `*_PRESENT`
  booleans (e.g. `WINDOWS_SIGN_CERT_BASE64_PRESENT`) so you can confirm the secrets
  are visible to the job before a real signed run.

---

## Edge 4 — Test channels (Telegram / Discord / Slack)

**Provide:** a bot token (and channel/chat target) for a messaging channel so the
agent can send/receive. **Wired** through the channel-setup flow with OS-keychain
storage; you supply tokens, no code changes required.

### Where each field/secret lives

Channel definitions declare their fields and which are secrets via
`secretFieldKeys`:

| Channel | Token / secret fields | `secretFieldKeys` line |
| --- | --- | --- |
| Telegram | `botToken` (+ `botTokenEnv` env-ref), `webhookSecret`, `targets`/`defaultChatId` | `apps/gateway/src/services/channel-setup-definitions/telegram.ts:252` |
| Discord | `botToken` (+ `botTokenEnv`), `webhookUrl`, `defaultChannelId` | `…/discord.ts:262` (env-ref field at `discord.ts:119`) |
| Slack | `botToken`, `webhookUrl`, `signingSecret` (+ OAuth install) | `…/slack.ts:227` |

Each token field has an `*Env` sibling (e.g. Telegram `botTokenEnv`,
`telegram.ts:295`) so you can store the **name of an env var** holding the token
instead of the token itself; the value is then read from the environment at
runtime rather than persisted. Other channels exist too (Teams, Signal, Google
Chat, iMessage, Line, Mattermost, Nextcloud Talk, ntfy, WhatsApp, Zalo) under the
same `channel-setup-definitions/` directory.

### Setup flow (Settings → Channels)

UI: **Settings → Channels** (`ChannelsSection`,
`apps/mission-control-next/src/features/native-routes/SettingsNativePage.tsx:5670`;
tab at line 700). The flow is a draft lifecycle over these routes
(`apps/gateway/src/routes/integrations-channel-setup-routes.ts`):

1. `POST /api/v1/channels/drafts` — start a draft for a channel (line 40)
2. `PATCH /api/v1/channels/drafts/:draftId` — fill fields incl. the bot token (line 52)
3. `POST /api/v1/channels/drafts/:draftId/validate` (line 70) and `…/test` (line 82)
4. `POST /api/v1/channels/drafts/:draftId/finalize` — persist + connect (line 94)

On finalize, fields named in `secretFieldKeys` are stored in the **same OS secret
store** as provider keys (`secret-store-service.ts`, service `"goatcitadel"`) and
are never returned to the UI afterward (they hydrate as opaque). Inbound is
default-safe: new connections stamp `inboundAccessMode: "allowlist"` and an empty
allowlist denies all senders (`packages/contracts/src/channel-access.ts:115-182`;
enforced on the inbound webhook at
`apps/gateway/src/routes/integration-webhooks.ts:104-159`).

> Env-var route (no UI): set e.g. `TELEGRAM_BOT_TOKEN` and reference it by name in
> the connection's `botTokenEnv` field. There is **no default `.env` slot** for
> channel tokens in `.env.example` — the connection config carries the env-var
> *name*, not the value.

### ✅ Verify it worked

- Run the in-flow probe: `POST /api/v1/channels/drafts/:draftId/test`
  (`integrations-channel-setup-routes.ts:82`) returns a connectivity result for the
  token before you finalize.
- After finalize, `POST /api/v1/channels/connections/:connectionId/retest`
  (route registered in the same file) re-checks a live connection.
- Send yourself a message from the channel and confirm it is accepted (an unknown
  sender is dropped with reason `sender_not_allowlisted` per the allowlist gate
  above — add your sender id to the connection's allowlist if so).

---

## Edges that need *building*, not just configuring

None of the four edges are missing their integration point — all four are wired.
The only deliberate gap is **Edge 2's competitor protocol adapter**: the benchmark
exposes the target seam and skips cleanly, but actually *driving* OpenClaw/Hermes
requires implementing each scenario's competitor branch once their API shape is
known (see the `⚠` note under Edge 2). Everything else is "supply the secret/path
and verify."
