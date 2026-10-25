# Google Workspace Sign-In

Last updated: 2026-10-25

## Scope

Native Google sign-in for the existing Gmail and Calendar tools (`gmail.read`, `gmail.send`, `calendar.list`, `calendar.create_event`) and the Gmail operator actions. It replaces the pasted access token those tools used to read from connection config. Gmail Pub/Sub push and Drive, Sheets or Docs are out of scope.

Google Workspace has no vendor-hosted MCP server, so Google sign-in is native to the Gateway. The OpenClaw `gog` CLI skill is not shipped: no CLI skill ships for a service GoatCitadel integrates natively, and the Skill Hub `google_cli_oauth` rule still routes Google CLI/OAuth skills here (see [MCP_VENDOR_CATALOG_PROGRAM.md](./MCP_VENDOR_CATALOG_PROGRAM.md)).

## Flow

Google's installed-app OAuth, the same path `gog` and Hermes Agent use:

1. The operator creates an OAuth client of type **Desktop app** in a Google Cloud project with the Gmail API and Google Calendar API enabled, then saves its client ID on a **Gmail and Google Calendar** connection (`automation.gmail`) in Settings › Connections › Integrations.
2. **Connect Google** opens a scope review. Each capability maps to one scope and is requested only when ticked:

   | Capability | Scope | Tools |
   | --- | --- | --- |
   | Read Gmail | `gmail.readonly` | `gmail.read`, the Gmail Read Messages action |
   | Send Gmail | `gmail.send` | `gmail.send`, the Send Test Email action |
   | Read Calendar events | `calendar.events.readonly` | `calendar.list` |
   | Create Calendar events | `calendar.events` | `calendar.create_event` |

3. `POST …/google-oauth/start` stores the client secret (when entered) in the OS keychain, creates a PKCE S256 verifier kept only in Gateway memory for ten minutes, and returns Google's consent URL with `access_type=offline` and `prompt=consent`. Installed apps get no incremental consent, so every connect asks for the whole reviewed set.
4. Google redirects to the loopback callback `http://127.0.0.1:<GATEWAY_PORT>/api/v1/integrations/google/oauth/callback` (override per connection with `redirectUri`, loopback HTTP with this path only). The callback is the shared MCP fragment hand-off: it exchanges nothing and forwards `state` and `code` to `/settings/connections#google-oauth-return&…`; the tab that started Connect Google completes it over a same-origin `BroadcastChannel`.
5. `POST …/google-oauth/complete` checks the single-use state and verifier, exchanges the code (`code_verifier`, `client_secret`, `redirect_uri`) and records the scopes Google actually granted. Capabilities the operator unticked on Google's page stay off.

## Custody and ledger

- The access token, refresh token, expiry, granted scopes and account label live in one OS keychain entry (`integration:google-workspace:<connectionId>:oauth`). The client secret lives in `integration:google-workspace:<connectionId>:client-secret`, or comes from the `clientSecretEnv` environment variable (`GMAIL_` prefix rules apply). Connection config keeps only the public client ID and the four capability switches.
- Every request to Google's token and revocation endpoints runs through the shared external side-effect ledger on boundary `google_oauth_token` (`authorization_code`, `refresh_token`, `revoke`). The ledger records the request kind only, never codes, tokens or secrets. A request whose outcome is unknown stays in manual review and is never retried automatically.

## Runtime

- The policy engine resolves a token through the Gateway hook `resolveGoogleWorkspaceAccessToken` immediately before the provider request. The hook refuses with `blocked:` when the capability is switched off, Google did not grant its scope, the sign-in is missing or needs renewal, or the client ID changed; these refusals are recorded before the external boundary. Tokens are refreshed when fewer than five minutes remain, once per connection for concurrent calls, and every call re-checks its own capability switch and grant against the stored sign-in afterwards, so a reconnect during a refresh never widens what a pending call may do. A refresh refused with `invalid_grant` marks the sign-in for renewal.
- `gmail.read` lists matching messages, then reads only their metadata (`messages.get?format=metadata`: From, To, Subject, Date, snippet, labels). Bodies and attachments are never fetched. Every field is single-line, stripped of control and format characters, and bounded (subject and headers 300 characters, snippet 500, at most 25 messages). The result carries `contentTrust: "untrusted_external"`, an untrusted-content notice and source attribution with `trustLevel: "untrusted_external"`.
- `gmail.send` and `calendar.create_event` remain `danger` tools with `requiresApproval: true`, on the existing ledgered send path and the fixed outbound hosts `gmail.googleapis.com` and `www.googleapis.com`. A Google sign-in never substitutes for the approval.
- **Disconnect Google** revokes the refresh token at Google (RFC 7009), then always removes the stored sign-in and marks the connection disconnected. It also cancels a pending Connect: a sign-in that was already completing saves nothing, and the grant Google just issued for it is revoked. When Google does not confirm, the operator is told to remove the app under Third-party access in their Google Account. Deleting the connection also revokes and removes both keychain entries, best effort.
- Diagnostics report the client ID, switched-on capabilities, a leftover pasted token (ignored), keychain availability, client secret source, sign-in state and each switched-on scope, without contacting Google.

## Known limits

- The redirect must reach the Gateway on the operator's own computer. A Mission Control opened from another machine, or a Gateway in a container without its port published on host loopback, cannot complete the hand-off.
- The tab that started Connect Google must stay open; a Gateway restart mid-flow means starting again.
- A Google Cloud project whose consent screen is in **Testing** issues refresh tokens that expire after seven days. Publish the consent screen (or reconnect weekly) for a lasting sign-in.
- Live sign-in against a real Google account has not been proven in CI; the flow is covered against a fake Google token endpoint.
