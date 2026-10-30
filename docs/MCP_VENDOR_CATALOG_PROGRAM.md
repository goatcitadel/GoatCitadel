# MCP Vendor Catalog Program

Last updated: 2026-10-24

## Goal

Let an operator connect the common third-party services through paths that already work in other agent runtimes, instead of new GoatCitadel-specific connectors:

- vendor-hosted remote MCP servers (the reviewed list Hermes Agent ships in `optional-mcps/`), and
- for services with no vendor MCP server, the CLI-backed skills OpenClaw and Hermes Agent ship (`himalaya`, `github`; `gog` is not shipped, see E).

Everything stays under the existing Gateway governance: deny-wins policy, the network allowlist, connection reviews, first-tool approval (except where the operator sets a connector to let reads or changes run on their own), approval-gated `shell.exec`, and governed skill activation.

## Sources

- Hermes Agent `optional-mcps/*/manifest.yaml` (MIT, Nous Research). Each entry names a vendor-documented Streamable HTTP endpoint and its auth type. Upstream commit: `07ee800dc7`.
- OpenClaw `skills/himalaya` and `skills/github` (MIT, OpenClaw Foundation), with `skills/gog` reviewed but not shipped. Upstream commit: `7559fb21a57`.
- The official MCP TypeScript SDK (`@modelcontextprotocol/sdk`, already in the workspace lockfile) for the OAuth discovery, client registration and PKCE helpers. Hermes Agent uses the Python SDK's equivalent.

## Current gaps this closes

1. MCP OAuth needs a hand-entered `authorizationUrl`, `tokenUrl` and client-id env var. Vendor MCP servers instead publish RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata and RFC 7591 dynamic client registration, and require PKCE. The existing GitHub and Stripe templates therefore report `missing_oauth_config`.
2. The redirect lands on a Gateway path with no handler, so operators copy the code by hand.
3. The Cockpit template picker is a flat list of twelve rows with no search, category, host or provenance detail.
4. No supported path exists for Google Workspace, generic IMAP mail, or GitHub CLI work from Chat. (Google Workspace later got native sign-in for the Gmail and Calendar tools: see [GOOGLE_WORKSPACE_SIGN_IN.md](./GOOGLE_WORKSPACE_SIGN_IN.md).)

## Design

### A. Standards-based MCP OAuth (Gateway)

- When an `oauth2` HTTP/SSE server has no static endpoints, `startMcpOAuth` discovers them with the SDK's `discoverOAuthServerInfo` (RFC 9728, then RFC 8414 / OIDC).
- When no client id is configured, the Gateway registers a public client with `registerClient` (RFC 7591, `token_endpoint_auth_method: "none"`). Registrations that demand a client secret fail closed with an operator-readable message. Static `clientIdEnv` / `clientSecretEnv` keep working.
- Every authorization uses PKCE S256 via `startAuthorization`. The verifier stays in Gateway memory only, keyed by the OAuth `state`, with a ten-minute expiry, following the OpenAI Codex OAuth precedent. A Gateway restart mid-flow requires a fresh Connect.
- Discovered servers send the RFC 8707 `resource` parameter (the server URL) on authorization, exchange and refresh, as the MCP authorization spec requires.
- The discovered endpoints and registered client id persist in the MCP auth-state record as a strictly validated `authorizationServer` object. No secret is stored there. The public auth state exposes only its issuer.
- Every request goes through `fetchAllowlisted` with the operator network allowlist, bounded in time and size. Discovery never widens the allowlist. The token service now reads the live allowlist, so hosts added in Settings apply without a restart.
- Opt in per server with `oauth.metadataDiscovery: true`. Saved `authorizationUrl` / `tokenUrl` always win.
- Token requests keep the existing durable side-effect ledger, fences and connection reviews unchanged.

### B. OAuth callback hand-off (Gateway)

`GET /api/v1/mcp/oauth/callback` (public, rate-limited, silent request logging) exchanges nothing. When the sign-in was started from an allowed Mission Control origin, it redirects there (`/settings/connections#mcp-oauth-return&state=…&code=…`) with the result in the URL fragment only. That tab clears the fragment and forwards the result over a same-origin `BroadcastChannel` to the tab holding the in-memory request, which pre-fills the code and state. In Settings, the operator still completes the exchange through the existing reviewed "Review authorization completion" step; a Capabilities install or Connect completes it on its own when the returned state matches the sign-in it started. Unknown, expired or malformed callbacks render a page and never redirect.

### C. Vendor templates (Gateway)

- 61 Hermes catalog entries become `McpServerTemplateRecord`s (`mcp-vendor-server-templates.ts`), alongside the existing templates. Left out: n8n self-hosted and Unreal Engine (both need an operator-supplied URL) and Stripe, Context7 and Microsoft Learn (already templates; Stripe moves to discovery). Every vendor template is `trustTier: "restricted"`, `requireFirstToolApproval: true`, `redactionMode: "strict"` and `enabledByDefault: false`.
- New optional template fields: `networkHosts` (the hosts the operator must allowlist), `provenance` (catalog source, upstream commit, vendor documentation URL) and `riskNotes`.
- Money-moving servers (Stripe, Robinhood trading, PayPal, Square, Plaid, RentAHuman) carry a `riskNotes` warning and `movesMoney: true`. They still require first-tool approval unless the operator sets them to let reads run on their own, and they can't be set to "Nothing asks": the Gateway refuses that setting and decides a saved one as "Reading is free". A Capabilities install saves every connector, money-moving ones included, with "Reading is free" by default.
- GitHub keeps its existing template. Hermes leaves GitHub's hosted MCP server out because generic dynamic registration does not work there; the template states that a configured OAuth app or token is required.

### D. Cockpit configuration and management (Mission Control Next)

- A searchable vendor catalog in Settings › Connections › MCP servers › Register, with category filter, sign-in type, required hosts, provenance and risk notes on each card.
- A "Needs network access" notice with an explicit operator action that adds the named hosts to the network allowlist, following the Firecrawl settings precedent. The change goes through the governed settings patch, so it may wait for approval in Inbox.
- The connect flow picks up the callback fragment, pre-fills the code and state, and leaves the reviewed completion step in place. Readiness (`needs_auth`, `ready`, `expired`) stays visible on each server.

### E. Shipped skill packs (skills tree, Skill Hub, Cockpit Capabilities)

- Adapted `himalaya` and `github` (as `github-cli`) skills live under `skills/import-packs/<packId>/` with an `UPSTREAM.md` and the upstream MIT licence. The skill loader does not scan this folder, so nothing becomes callable by being shipped.
- Skill Hub source review accepts a `packId` from `SHIPPED_SKILL_PACKS` (contracts) as an alternative to an HTTPS source. The Gateway resolves the directory itself, then runs the unchanged production admission (validation, promptware scan, tool mapping, exact-byte CAS snapshot). Both packs pass admission.
- The packs install from Capabilities › Skills › Discover: the install panel runs the Skill Hub review, then the existing Skill Hub `install_inactive` and `activate` approvals from one confirmation, each approved in place unless the operator's setting to skip approvals for their own changes applies, with every step read from the Gateway's Skill Hub projection. The Library no longer has its own skill-packs panel.
- Each command runs through `shell.exec`, which requires approval by default. The skills tell the model never to request credentials in Chat, and to have the operator install and sign in to the CLI in a terminal. Multi-line bodies go through one explicit `sh -c` or `pwsh -Command` call, because imported skills cannot declare `fs.write`.
- **`gog` is not shipped.** Native Google sign-in covers Google Workspace for the `gmail.*` and `calendar.*` tools (see [GOOGLE_WORKSPACE_SIGN_IN.md](./GOOGLE_WORKSPACE_SIGN_IN.md)), and no CLI skill ships for a service GoatCitadel integrates natively. The Skill Hub `google_cli_oauth` admission rule stays as it is, routing Google CLI/OAuth skills to the native integration.

### Hardening from independent review

- A reviewed start runs every admission check, then discovery, before the review commits. A stale review, an ineligible server, a blocked host or a provider without dynamic registration returns a 400 that names the reason and changes nothing. Servers with a configured client id get a metadata-only probe before admission.
- A registered client is reused while issuer, resource and redirect still match, so reconnecting does not register a new client each time.
- Every discovered URL (server, authorization server, issuer, authorization, token and registration endpoints) must be HTTPS, or plain HTTP on loopback only.
- The Cockpit shows the sign-in host and the requested scopes before the operator opens the provider page. Without operator-set scopes, discovery requests the scopes the server advertises, as the MCP authorization spec describes.
- Completion fails before any token reservation when the flow's PKCE verifier is gone (Gateway restart or more than ten minutes). The verifier is kept only after the new state is saved.

### Known limits

- Dynamic client registration runs through the shared external side-effect ledger (`mcp_oauth_client_registration`), recorded completed, failed before sending, or unknown after sending, with public identifiers only. A start that stops after registration reached the vendor says the provider may hold an unused client instead of "nothing changed"; the client itself is not cleaned up automatically.
- A shipped pack's snapshot records its absolute directory as `sourceRef`, so moving the installation changes the pack's source identity.
- The provider return lands on Cockpit Settings › Connections, which opens the MCP section so it can hand the result back; the Classic shell does not consume it.
- "Allow host" adds the MCP server's own host. The sign-in provider may use other hosts, which the error names when they are blocked.
- The default redirect is `http://127.0.0.1:8787/api/v1/mcp/oauth/callback`; a Gateway on another port needs `oauth.redirectUri`.

## Out of scope

- Gmail push / Pub/Sub inbound triggers.
- Typed native Google Workspace tools (a later slice on the existing `gmail.*` and `calendar.*` tools).
- Confidential-client dynamic registration that returns a client secret.
- Hermes's third-party `plugin-catalog`.
- xAI / X surfaces from either upstream (`xurl`, `grok`, the X channel).

## Validation

- Gateway unit tests for discovery, registration, PKCE, resource and the callback page, using a stubbed fetch.
- Template contract tests (unique ids, HTTPS URLs, hosts covering the URL, provenance present).
- Cockpit component tests for catalog search and filter, the allowlist action and callback pre-fill.
- `pnpm verify:skills:catalog`, `pnpm docs:check`, full `pnpm typecheck`, the gateway MCP suites, `verify:architecture:metrics`, `git diff --check`.

Not proven by this program: a live sign-in against each vendor. The catalog records the vendor-documented endpoint; operators confirm each connection from Settings.
