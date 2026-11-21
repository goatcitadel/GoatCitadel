# Google Workspace Sign-In

Last updated: 2026-11-18

## Scope

Native Google sign-in for Gmail search, complete messages/threads, attachment export, sending/replying/forwarding, drafts and inbox management; and Calendar discovery, availability, events and RSVPs. It replaces pasted access tokens. Gmail Pub/Sub push and Drive, Sheets, Docs and Contacts are out of scope.

Google Workspace has no vendor-hosted MCP server, so Google sign-in is native to the Gateway. The OpenClaw `gog` CLI skill is not shipped: no CLI skill ships for a service GoatCitadel integrates natively, and the Skill Hub `google_cli_oauth` rule still routes Google CLI/OAuth skills here (see [MCP_VENDOR_CATALOG_PROGRAM.md](./MCP_VENDOR_CATALOG_PROGRAM.md)).

## Flow

Google's installed-app OAuth, the same path `gog` and Hermes Agent use:

1. The operator creates an OAuth client of type **Desktop app** in a Google Cloud project with the Gmail API and Google Calendar API enabled, then saves its client ID on a **Gmail and Google Calendar** connection (`automation.gmail`) in Capabilities › Connectors › Advanced setup › Integrations.
2. **Connect Google** opens a scope review. Each capability maps to one scope and is requested only when ticked:

   | Capability | Scope | Tools |
   | --- | --- | --- |
   | Search Gmail | `gmail.readonly` | `gmail.read`, `gmail.list_labels` |
   | Send Gmail | `gmail.send` | `gmail.send`, `gmail.reply`, `gmail.forward`, `gmail.send_draft` |
   | Read Calendar events | `calendar.events.readonly` | `calendar.list`, `calendar.get_event` |
   | Change Calendar events | `calendar.events` | `calendar.create_event`, `calendar.respond_event`, `calendar.update_event`, `calendar.delete_event` |
   | Read complete Gmail messages | `gmail.readonly` | `gmail.get_message`, `gmail.get_thread`, `gmail.download_attachment`; also required for reply/forward |
   | Manage Gmail inbox | `gmail.modify` | `gmail.modify_message`, `gmail.create_label`, `gmail.update_label` |
   | Manage Gmail drafts | `gmail.compose` | `gmail.list_drafts`, `gmail.get_draft`, `gmail.save_draft`, `gmail.delete_draft`, `gmail.send_draft` |
   | Discover calendars | `calendar.calendarlist.readonly` | `calendar.list_calendars`; also required for secondary-calendar RSVP identity verification |
   | Check calendar availability | `calendar.freebusy` | `calendar.free_busy` |

   Google groups some capabilities under shared or broader scopes. GoatCitadel still requires each capability switch separately. Sending a draft requires both draft and send switches/grants; replies and forwards require both complete-message and send switches/grants. Added capabilities default off; reconnect and select them explicitly. Existing snippet-search and Calendar-list allowances remain limited to those exact tools.

3. `POST …/google-oauth/start` stores the client secret (when entered) in the OS keychain, creates a PKCE S256 verifier kept only in Gateway memory for ten minutes, and returns Google's consent URL with `access_type=offline` and `prompt=consent`. Installed apps get no incremental consent, so every connect asks for the whole reviewed set.
4. Google redirects to the loopback callback `http://127.0.0.1:<GATEWAY_PORT>/api/v1/integrations/google/oauth/callback` (override per connection with `redirectUri`, loopback HTTP with this path only). The callback is the shared MCP fragment hand-off: it exchanges nothing and forwards `state` and `code` to `/capabilities/connectors/advanced#google-oauth-return&…` (an older `/settings/connections#google-oauth-return&…` address redirects there with its fragment); the tab that started Connect Google completes it over a same-origin `BroadcastChannel`.
5. `POST …/google-oauth/complete` checks the single-use state and verifier, exchanges the code (`code_verifier`, `client_secret`, `redirect_uri`) and records the scopes Google actually granted. Capabilities the operator unticked on Google's page stay off.

## Custody and ledger

- The access token, refresh token, expiry, granted scopes and account label live in one OS keychain entry (`integration:google-workspace:<connectionId>:oauth`). The client secret lives in `integration:google-workspace:<connectionId>:client-secret`, or comes from the `clientSecretEnv` environment variable (`GMAIL_` prefix rules apply). Connection config keeps only the public client ID and capability switches.
- Every request to Google's token and revocation endpoints runs through the shared external side-effect ledger on boundary `google_oauth_token` (`authorization_code`, `refresh_token`, `revoke`). The ledger records the request kind only, never codes, tokens or secrets. A request whose outcome is unknown stays in manual review and is never retried automatically.

## Runtime

- The policy engine resolves a token through the Gateway hook `resolveGoogleWorkspaceAccessToken` immediately before the provider request. The hook refuses with `blocked:` when the capability is switched off, Google did not grant its scope, the sign-in is missing or needs renewal, or the client ID changed; these refusals are recorded before the external boundary. Tokens are refreshed when fewer than five minutes remain, once per connection for concurrent calls, and every call re-checks its own capability switch and grant against the stored sign-in afterwards, so a reconnect during a refresh never widens what a pending call may do. A refresh refused with `invalid_grant` marks the sign-in for renewal.
- `gmail.read` lists matching messages, then reads only their metadata (`messages.get?format=metadata`: From, To, Subject, Date, snippet, labels). Bodies and attachments are never fetched. Every field is single-line, stripped of control and format characters, and bounded (subject and headers 300 characters, snippet 500, at most 25 messages). The result carries `contentTrust: "untrusted_external"`, an untrusted-content notice and source attribution with `trustLevel: "untrusted_external"`.
- `gmail.send`, `calendar.create_event` and `calendar.respond_event` are `danger` tools with `requiresApproval: true`, on the existing ledgered send path and the fixed outbound hosts `gmail.googleapis.com` and `www.googleapis.com`. A Google sign-in never substitutes for the approval.
- `calendar.respond_event` accepts `accepted`, `declined` or `tentative`. Supply the saved `connectionId`, event ID and exact `etag` from a read. It re-reads the event, refuses stale/cancelled invitations and uses an `If-Match` guarded partial-attendee update with organizer notifications. Primary-calendar RSVP uses the single self attendee. Secondary-calendar RSVP requires discovery consent and verifies the authenticated account through its primary calendar identity; a secondary calendar's self flag alone is insufficient. Ambiguous mutations require checking Calendar before retrying and are never automatically resent.
- Complete-message reads return bounded untrusted text and attachment descriptors, never raw binary. Exporting one attachment writes a hash-identified file inside the configured workspace write root and requires separate approval. Outgoing attachments require a governed local path and exact SHA-256; no remote URLs are fetched. Replies/forwards and draft changes refer to a successful complete source read from the same Chat, workspace, account and sign-in.
- Mail approvals freeze MIME bytes in private, hash-verified review artifacts and show To/Cc/Bcc, body, source and attachments. Draft sending rechecks the saved message identity and uses those frozen bytes. Unusual duplicate/oversized or inconsistent draft headers are refused; save a fresh draft instead. Draft review includes HTML alternatives converted to text with link/resource targets. Inbox deletion means Trash, with an explicit restore action; permanent message purging is unavailable.
- Calendar creation and changes support timed or all-day dates (exclusive all-day end), recurrence, reminders and optional Google Meet creation. Meet links can remain pending at Google. Changes/deletion require the current event etag; recurring changes require explicit occurrence or series selection. Attendee notifications default to `all`; a silent change must explicitly request `none` and is shown in review. Free/busy POST is a read and reports per-calendar failures as unchecked, never free.
- Search and calendar lists return explicit continuation tokens bound to the account and query. Limits: 25 Gmail search results per page, 50 messages/1 MiB decoded text per thread page, 128 KiB text per message, 10 MiB per attachment, 20 MiB outgoing MIME, and 20 calendars over 31 days per availability query. Truncation and continuation are explicit.
- **Disconnect Google** removes the locally stored sign-in before requesting revocation at Google (RFC 7009). A pending refresh cannot restore it. A sign-in already completing is rejected and its new grant is submitted for revocation. If Google cannot confirm revocation, the app directs the operator to Third-party access in their Google Account. Deleting the connection also attempts revocation and removes the stored client secret.
- Diagnostics report the client ID, switched-on capabilities, a leftover pasted token (ignored), keychain availability, client secret source, sign-in state and each switched-on scope, without contacting Google.

## Known limits

- The redirect must reach the Gateway on the operator's own computer. A Mission Control opened from another machine, or a Gateway in a container without its port published on host loopback, cannot complete the hand-off.
- The tab that started Connect Google must stay open; a Gateway restart mid-flow means starting again.
- A Google Cloud project whose consent screen is in **Testing** issues refresh tokens that expire after seven days. Publish the consent screen (or reconnect weekly) for a lasting sign-in.
- Live sign-in against a real Google account has not been proven in CI; the flow is covered against a fake Google token endpoint.
