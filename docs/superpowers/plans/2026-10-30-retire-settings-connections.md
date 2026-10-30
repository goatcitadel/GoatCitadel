# Retire Settings › Connections (Cockpit): plan

Operator decision, 2026-10-30: "retire settings connections since it's no longer needed or current."
Branch `feat/retire-settings-connections`, cut from origin/main bd08f4c77 (#651). Plan 4 (WhatsApp) is already on
main (#650), so its "Set your public web address" link is in scope.

## What the page holds today

`/settings/connections` renders five sections. `/settings/<section>` opens the same page.

| Section | Anchor | What it does | Also reachable elsewhere? |
|---|---|---|---|
| Integrations (default) | `#integration-connections` | Connection create/edit/delete, details, catalog evidence, Meet controls, Google Workspace sign-in; finishes `#google-oauth-return&…` | No. Capabilities lists integrations, but "Set up" sends them here |
| Channels | `#channels`, `?channel=<catalogId>` | Public web address; channel drafts, lifecycle, operations, webhook address and outcome checks for every channel | Partly. Chat › Messaging has pages only for Telegram, Discord, Slack and WhatsApp (bot/socket paths). Every other channel, and their key changes, is set up here |
| MCP servers | `#mcp-servers` | Server list, add custom server/templates/vendor catalog, full editor, delete, inspection, manual OAuth review, elicitation requests, server-mode previews; finishes `#mcp-oauth-return&…` | Partly. Capabilities installs templates, switches on/off, removes, sets approval posture, and has the add-your-own form. The editor, inspection, elicitation and previews are only here |
| Web & Search | `#web-search` | Firecrawl URL, search engine order, Firecrawl/Brave/Parallel keys | No. Capabilities "Set up" sends it here |
| Add-ons & packs (experimental) | `#addons` | Add-on install/update/remove/launch; portable pack preview/import/export | No. Its replacement is Phase 4 (Plugins), which hasn't started |

**So no section can simply be deleted.** Retiring the page means moving each editor, unchanged, to its new home,
then redirecting the old addresses.

**The Filesystem (Local) MCP template** (`mcp-server-templates.ts`, pinned to
`@modelcontextprotocol/server-filesystem@2.0.1`, which needs Node 24) is left out of the Connectors list on purpose
(`EXCLUDED_CONNECTOR_TEMPLATE_IDS`). Its code comment says "Only Settings offers it". Its only intended path is the MCP
servers section's "Use an advertised template" catalog. (The Connectors tab's add-your-own form reuses that same
`McpServerCreate`, unfiltered, so it may already show there too; not checked in a browser.) The plan keeps that path:
the MCP editor moves whole, catalog included. The pin, the exclusion and the template stay as they are while the
operator decides the Node baseline; only the comment's "Settings" wording follows the move.

## What links here (cockpit source, `git grep`)

- **Capabilities** `connector-links.ts`: MCP (`MCP_SETTINGS_LINK`, `CHAT_CONNECTORS_SETTINGS_HREF`), and
  `connectorSettingsHref` → `#web-search` / `#channels` / `#integration-connections`. Used by the panel's "Advanced
  setup in Settings" link and twice in the install panel.
- **Chat › Messaging**: `settingsChannelSetupHref` (every picker tile without a Chat page, plus the Discord, Slack,
  WhatsApp pages and `WhatsAppFailureText`), `ChannelSetupView` (2), `ChannelTokenChange`, `TelegramSetupPage`, and
  `ChannelManageSection` "Change the key" (Mattermost and others).
- `ChannelWebhookAddress` "Set your public web address" → `#channels`.
- **System › Runtime** `RuntimeRecordSections`: "Open Settings › Connections" → `#mcp-servers`.
- **Settings**: First-run verification (`browser-control` → `#mcp-servers`, `extension-sdk` → bare page); Trust policy
  owner links ("Settings / MCP", "Settings / Add-ons").
- **Approval recovery links** on the governed setting controls: Firecrawl and search-engine order → `#web-search`,
  public web address → `#channels`. (Checked while building: the page builds these links itself; approvals don't
  store them.)
- **Channel Change Plan return**: "Return to Channels" in Chat's plan review (shared with Classic) builds
  `/settings/channels?channelPlan=…`. The cockpit redirect carries those fields to Advanced channel setup.
- **Gateway**: `MCP_OAUTH_RETURN_ROUTE` and `GOOGLE_OAUTH_RETURN_ROUTE` = `/settings/connections` (plus fragment).
- **Plumbing**: `settings-destinations.ts`, the `settings-connections` group in `RAIL_GROUPS` (shared with Classic),
  `SettingsSectionTabs` (default section, OAuth fragment aliases), `cockpit-compatibility.ts`, `cockpit-history.ts`,
  the command palette (built from the Settings index), and five `route-release-scope.ts` entries.
- **Proof scripts**: 15 under `scripts/verification/lib/scenarios/` (`cockpit-mcp-*`, `cockpit-integration-*`,
  `cockpit-channels`, `cockpit-addons`, `cockpit-portable-packs`, `channel-guided-setup-lane`).
- **Tests** that only use the URL as a fixture: back guard, history, Sheet history, shell preference, navigation
  provider.

Left alone: Classic (`features/native-routes/settings/sections/*`, `legacy-route-adapter.ts`) stays the rollback
surface with its own pages. Historical plans/specs and the `docs/ux/cockpit-remediation/*.json` evidence registers are
not rewritten.

## New homes (recommended; operator to confirm)

1. **MCP servers, Integrations, Web & Search → Capabilities › Connectors › Advanced setup**,
   `/capabilities/connectors/advanced`, with the same three section tabs and anchors. The Connectors tab stays
   selected. The panel link becomes "Advanced setup", and the Connectors tab gets one "Advanced setup" link.
2. **Channels and the public web address → Chat › Messaging › Advanced channel setup**, `/chat/messaging/advanced`
   (`advanced` becomes a reserved segment like `add`; `?channel=` preselect kept). Picker tiles and links for channels
   without a Chat page go there.
3. **Add-ons & packs → Settings › Advanced**, as its own "Add-ons & packs" section, still marked Experimental, until
   Phase 4 (Plugins) replaces it. This keeps the 1.0 contract's "Settings Add-ons" line true. As on Connections, it
   is a tab only when experimental sections are shown, and otherwise is reached by its link.

Approved by the operator on 2026-10-30 ("Yes, as recommended"). Added while building: the channel picker links
Advanced channel setup, so it is reachable from Chat without picking a channel.

Then the cockpit's Settings drops the Connections page from its tabs, search and the palette. The palette gets entries
for the moved sections at their new homes. Classic keeps its rail: the group is dropped in the cockpit's own Settings
destinations, not in the shared `RAIL_GROUPS`.

## OAuth returns

- Both Gateway return routes become `/capabilities/connectors/advanced`, with tests. The page picks its section from
  the fragment (`#mcp-oauth-return&…` opens MCP servers, `#google-oauth-return&…` opens Integrations), so the same
  editors as before consume the return, broadcast it and show their "you can close this tab" notice. As built, this
  replaced the planned route-independent consumer: it is smaller and keeps the notice.
- An old `/settings/connections#…-oauth-return&…` (an in-flight sign-in during an upgrade) still works: the consumer
  is route-independent and the redirect keeps the fragment.
- Provider redirect URIs are the Gateway callbacks and do not change, so there is no Google Cloud or provider
  reconfiguration.

## Redirects (cockpit compatibility resolver; `?shell=classic` untouched; workspace and query kept)

| Old | New |
|---|---|
| `/settings/connections` (no hash, or an unknown one) | `/capabilities/connectors/advanced` |
| `#integration-connections`, `/settings/integrations` | `/capabilities/connectors/advanced#integration-connections` |
| `#mcp-servers`, `/settings/mcp` | `/capabilities/connectors/advanced#mcp-servers` |
| `#web-search`, `/settings/web-search` | `/capabilities/connectors/advanced#web-search` |
| `#channels` (with `?channel=`), `/settings/channels` | `/chat/messaging/advanced` (with `?channel=`) |
| `#addons`, `/settings/addons` | `/settings/advanced#addons` |
| `#mcp-oauth-return&…` | `/capabilities/connectors/advanced#mcp-oauth-return&…` |
| `#google-oauth-return&…` | `/capabilities/connectors/advanced#google-oauth-return&…` |

## Delivery

One branch and one PR, in small commits, each with its focused tests:

1. The route-independent OAuth return consumer and the new Gateway return routes.
2. Capabilities › Connectors › Advanced setup (move three editors) and its inbound links.
3. Chat › Messaging › Advanced channel setup (move Channels and the public web address) and its inbound links.
4. Add-ons & packs on Settings › Advanced.
5. Drop Connections from the cockpit Settings; redirects; palette; release-scope entries.
6. Proof scripts, docs and claims: README Settings list, `docs/1_0_CONTRACT.md` (only if Add-ons moves out of
   Settings), `CHANNEL_GUIDED_SETUP.md`, `COMMUNICATION_CHANNEL_SETUP_GUIDE.md` ("Settings › Channels" ×6),
   `GOOGLE_WORKSPACE_SIGN_IN.md`, `MCP_VENDOR_CATALOG_PROGRAM.md`, `MISSION_CONTROL_COCKPIT_SETTINGS_PARITY.md`.
   `docs/CANONICAL_RUNTIME_STATE_MODEL.md` doesn't name the page, so it needs no change.

## Proof

- Focused vitest, `--maxWorkers=2`, one heavy job at a time: a redirect table test, settings destinations and index,
  the OAuth consumer, connector links, the channel picker model, `ChannelWebhookAddress`, `RuntimeRecordSections`,
  both new pages, and the Gateway OAuth route tests.
- mc-next and Gateway typecheck, `pnpm docs:check`, `git diff --check`, `verify:architecture:metrics`. No baseline
  update; any C0 allowance is asked for first.
- Browser proof on the testbench at desktop and phone widths, in light and dark: both new pages, every redirect row,
  and a simulated OAuth return.
- No stored data, config or provider setting changes.
