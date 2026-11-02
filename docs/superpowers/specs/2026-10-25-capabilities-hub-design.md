# Capabilities hub: skills, plugins, connectors and tools in one place

Status: approved by the operator on 2026-10-25. The builder check is done and both operator questions are answered. Each phase gets its own plan under `docs/superpowers/plans/`, starting with `2026-10-25-capabilities-hub-phase-1.md`. The mockups the operator reacted to are described in this document; they were throwaway HTML and are not in the repo.

## Intent

Today, adding something GoatCitadel's AI can use means guessing which page owns it. Skills live in Library › Skills and tools. MCP servers, integrations, channels, web search and add-ons sit on Settings › Connections. Tool rules are under Settings › Safety, and workspace selections are under Settings › Citadel. The operator's last attempt to add something ended up in Settings › Integrations, and that word covers too many unrelated things.

Hermes Agent (Nous Research, MIT licence) has a Capabilities page with four tabs: Skills, Plugins, Connectors and Tools. The operator finds it "super smooth and easy". What they want from it is that **all the different integrations are easy to view and install**. This design brings that page to the GoatCitadel cockpit. It keeps GoatCitadel's rule that the Gateway owns state and policy.

The operator said to borrow freely from how Hermes does things. A study of a local Hermes Agent checkout informs the details below; see **Borrowed from Hermes**.

## Goals

- One top-level **Capabilities** area in the cockpit's main navigation, with four tabs: Skills, Plugins, Connectors and Tools.
- From that page you can see what is available, see what is already connected or on, and install, connect, switch on or off, or manage it without leaving the page.
- Installing something takes one decision in a side panel. The panel says what it lets the AI do, how it signs in, and what will still ask first.
- One consistent visual system across the four tabs: a two-column list of rows, Hermes-style switches, and a side panel.
- "Plugin" means exactly one thing in the UI: a bundle of capabilities.

## Non-goals

- App icons. Rows use letter placeholders for now; sourcing real logos is a later task.
- A featured banner, hero carousel or image-heavy cards. The operator does not want them.
- A plugin system that runs third-party code inside GoatCitadel.
- A hosted community plugin registry with stars. Plugins come from GoatCitadel itself, from Git, or from a folder.
- Redesigning the detailed MCP, integration and channel editors in Settings. They stay as the advanced setup that the side panels link to.
- The Classic shell. DESIGN.md scopes new design work to the cockpit only.
- Model providers. They stay in Settings › Models.

## Anti-goals

These count as failures even if the page works:

- Something on the page that can't actually be used. For example, the 17 imported "external connectors" are `catalog_only` and `callable: false`, so they must not appear as installable.
- A count, status or "connected" state the browser made up. Missing evidence shows as missing, never as 0 or healthy.
- The browser joining catalogs, writing config, or fetching third-party catalogs directly. Hermes does all three.
- An install that bypasses the network allowlist, Skill Hub checks or deny-wins policy. A one-click install does the governed steps for you; it does not skip them.
- The operator being asked to approve their own click after opting in with #572's setting (outside `remote_hardened`). Or the opposite: an action shown as done while it is still waiting in Inbox.
- An AI-initiated action losing its approval gate because something was installed from this page.
- Plugin code running with app authority. Hermes desktop plugins do this.

## Constraints

- **The Gateway owns every read and write.** Merged lists (connectors, tool groups, plugin pieces) are Gateway projections with their own routes. Mission Control renders them and sends actions to them (`apps/mission-control-next/AGENTS.md`, "Frontend Authority Boundary").
- **Policy stays authoritative.** Deny-wins, approvals for AI-initiated risky actions, path jails, the network allowlist, wards and permission profiles all still apply. Switching something on never overrides a deny that comes from elsewhere.
- **Operator actions follow #572's opt-in.** Install, connect, switch on or off and uninstall from this page are the operator's own decisions, and they are always recorded as audit events. Whether they also raise an approval to that same operator follows #572's `settingsApprovalSkipEnabled`, with its scope extended to cover Capabilities actions:
  - **Setting on:** the click goes straight through.
  - **Setting off:** today's approvals still happen (Skill Hub, HX-402 `skill.lifecycle`, allowlist change plans). The panel and row say "Waiting on you in Inbox", with a link, and never show the action as done.
  - **`remote_hardened`:** always asks.

  The HX-402 lifecycle rule and its `verify:journey:producers` check keep working unchanged when the setting is off. The floors that stop the model or untrusted content acting on its own stay either way.
- **Build from a freshly fetched `origin/main`.** It holds the vendor MCP catalog (#561), native Google sign-in (#568), and #572's opt-in `settingsApprovalSkipEnabled`, which lets the operator skip approvals on their own Settings saves; `remote_hardened` ignores it. The local `main` and the `fix/chat-collapse-tool-output-and-settled-approvals` branch were both behind when this was written.
- **Scope of the page.** The page shows and changes the install as a whole. Where a piece is workspace- or Citadel-bound, it uses the active workspace and Citadel:
  - Skill Hub review snapshots
  - binding a new integration connection
  - which Vault holds a connector's secrets

  When the active workspace's capability selections hide an installed skill, MCP server or integration, its row says "Hidden in this workspace" and links to the selection. It never shows plain "On".
- **Tool-group off applies everywhere the AI calls tools.** It is enforced in the policy engine, not in the Chat runner. That covers Chat, scheduled turns, durable runs, MCP server mode, remote workers and mesh, and Code Mode.
- **Third-party code.** Hermes Agent is MIT, copyright Nous Research. Any copied code keeps its notice in `THIRD_PARTY_NOTICES.md`. Its `optional-mcps` catalog was already adapted this way in #561.
- **DESIGN.md and PRODUCT.md apply,** except where this design changes DESIGN.md (see **Design-system changes**).
- **Truth beats theater.** Experimental or partial pieces say so, for example plugin import from Claude Code's format if it ships partial.

## Decided by the operator

- One Capabilities page with Skills, Plugins, Connectors and Tools tabs, with its own spot in the main navigation.
- Connectors use **layout A**: a two-column list of app rows, with connected apps first, then available ones, plus category buttons and search. No featured banner.
- Built-in integrations, MCP servers and channels appear as **one list of apps**, each with a small label: Built in, MCP or Channel.
- **Install and Manage open a side panel**, not a separate settings page. The panel shows what the app can do, how it connects and what asks first, and one button does the rest.
- **Default approval posture for an installed connector:** reading runs without asking; creating or changing something asks first in Chat. This can be changed later in Manage.
- Model providers stay in Settings › Models. Non-callable external connectors are left out.
- Icons can wait. Function and readability come first, and letter placeholders are fine if they stay easy to read.
- **Plugins are bundles** of skills, connectors, tool rules, hooks and prompt packs. They run no code of their own inside GoatCitadel. They install from the built-in list, Git or a folder, the panel lists every piece before you confirm, and uninstalling removes them all.
- **Arena is dead.** Remove it, along with the add-on machinery. Rebuild the Plugins section from the ground up in the cockpit. Capability packs fold into plugins, and integration plugins go away.
- Reading **Claude Code's plugin format** is worth checking. It is not promised.
- **Tools tab:** about 14 tool groups, each with a switch, risk label and call count, plus a "Most used" row. Off means the AI can't use that group in any chat. Detailed allow/deny rules stay in Settings › Safety.
- **Skills tab:** Installed and Discover views with category buttons, a switch per skill and usage counts. Discover uses the skill sources GoatCitadel already searches, plus Import from Git. **Installing is one step:** GoatCitadel runs its checks, shows the result, and one confirmation installs and switches it on.
- **Hermes-style switches become the cockpit's standard on/off control**, not just on this page.
- DESIGN.md may change to allow this look.
- Borrow how Hermes does things freely, minus the parts listed under **Not borrowed**.
- **Approving your own clicks** follows #572's opt-in: when the setting is on, the operator's own clicks on Capabilities don't ask them to approve; `remote_hardened` still asks.
- **Connectors can be set to "Nothing asks"** as a per-connector opt-in, with destructive actions still asking. The operator answered "yes to 1", which Claude read as yes to this question, because the first question had already been answered by button.

## The page

- **Navigation.** A new primary cockpit area, Capabilities, between Work and Library. Each tab has its own route (for example `/capabilities/connectors`), so tabs are linkable and survive reloads. An open item is linkable too, the way Hermes uses `?connector=` and `?plugin=`.
- **Tab bar.** Tabs read Skills, Plugins, Connectors, Tools. A count shows next to a tab only when the Gateway reports one. When it can't, there is no count, never a 0.
- **Search box.** It is shared across tabs and shows the current tab's name as a badge. It carries that tab's own buttons on the right: Import from Git, Install from Git, or Add your own. The placeholder suggests a real term from the operator's own data, like Hermes's "Try 'creative'".
- **Filters.** Category buttons sit under the search box. A few show at once, the rest go under a "+N" menu, and a selected one always stays visible.
- **Rows.** Rows sit in two columns, collapsing to one below the `sm` breakpoint. Each row has:
  - a letter icon
  - the name and a kind label
  - a one-line description
  - a state: a dot plus a short reason, never colour alone
  - one action button or a switch
- **Side panel.** Install, Manage and details all open in the cockpit inspector, which becomes a bottom sheet on phones. The page underneath stays put. Closing the panel returns focus to the row.
- **Feel**, borrowed from Hermes:
  - Lists paint from cached data straight away and refresh in the background.
  - Switches flip immediately and roll back only the row that failed, with a short message.
  - Install shows progress in place: the button becomes a spinner, then the switch or Connected state. If something fails, the last useful lines of the log show in the panel.
  - "Takes effect in new chats" appears wherever that's true.
  - Empty and error states always offer the next action, such as Clear filters or Retry.

## Connectors tab

**What's in the list.** One Gateway projection merges:
- the 61 vendor MCP templates from #561 and the 12 bundled MCP templates
- the operator's own saved MCP servers
- integration catalog entries that are real and usable: channels, plus the productivity and automation entries with working connections, Google sign-in for Gmail and Calendar among them
- Web & Search (Firecrawl and the search engines)

It excludes model providers and the non-callable external connectors. When the same app exists in more than one source, the installed or connected entry wins, the way Hermes merges on a shared slug.

**Which integrations count.** An integration catalog entry is listed only if it has tools the AI can call and a connect flow that works today. The current `runnable` marking is not enough, because it marks every native and beta entry. Entries that only expose operator buttons (Notion, GitHub and Trello today) are left out, and so are beta entries without that proof. Phase 1's PR lists every included and excluded entry for the operator to check.

**Local and internal MCP servers:**
- **GoatCitadel's own internal MCP surfaces** (`approval-inbox`, `durable-tasks`) are not apps and are not listed.
- **`filesystem` and `fetch`** duplicate the built-in Files and Web tools, which are bounded by path jails and the network allowlist. They are left out.
- **The other local templates** (`context7`, `gpt-researcher`, `openspec`) appear in an "On this device" group, a group Hermes also has. Their install panel shows the exact command and says plainly that the program runs on this computer and its own network use is not limited by GoatCitadel's allowlist. Versions are pinned: no `@latest`.

**Usable in Chat.** MCP tools reach Chat only when `chatStaticMcpV1Enabled` and the durable kernel are on. Neither the default (off) nor the flag's rollout changes. Instead:
- When MCP in Chat is off, the install panel adds a visible, pre-ticked line, "Also let Chat use connectors". It runs as part of the same operator action.
- A connected row whose tools Chat can't reach says so: "Connected · not available in Chat", or "… while tool autonomy is Manual". It has a one-click fix where one exists. It never shows plain "Connected".

**Groups.** Connected comes first, with broken ones at the top of it. Then Available, then Turned off. Category buttons come from the MCP template categories (data, development, automation, creative, research and so on). Channels get a Messaging category.

**Row states.** The states are:
- connected
- needs sign-in
- sign-in expired
- broken
- available
- turned off

Each state has exactly one action: Connect, Install, Reconnect, Try again or Turn back on.

**Install panel.** It shows:
- what the app lets GoatCitadel do (its tool list)
- how it connects: the sign-in host, or the fields it needs such as an API key or bot token
- what asks first

One button, "Sign in and install" or "Install", does the governed steps in order:
1. Allow the app's host in the network allowlist. This is the operator's audited action.
2. Create the server or connection from the template.
3. Run sign-in through the existing OAuth discovery and return flow from #561, or the Google flow from #568.
4. Switch it on.

If a step fails, the panel says which step failed and what changed. Hermes is worth borrowing from here for env and secret fields: the Gateway rejects any field name the template didn't declare, and secrets go to the Vault, never back to the browser.

**Approval posture.** Today the vendor templates are approval-first on every call. The new default for a newly installed connector is that reads run freely and anything that creates or changes something asks first. MCP servers saved before this ships keep their current posture until the operator changes it. Manage offers three settings:
- **Everything asks.**
- **Reads free, changes ask.** This is the default for new installs.
- **Nothing asks.** A per-connector opt-in, chosen by the operator in Manage and audited. Changes run without asking. It relies on the app's own `destructiveHint`: anything the app marks destructive, or leaves unlabelled, still asks, and sends the app marks non-destructive run on their own. Money-moving connectors (`movesMoney` templates such as Stripe, PayPal, Square, Plaid, Robinhood and RentAHuman) can't select it. It is never the default, and a plugin preset can't select it. The builder must find how to tell reads from writes per MCP tool: MCP tool annotations such as `readOnlyHint` and `destructiveHint` where present, and a safe fallback of "asks first" where they are missing. Everything still runs through `mcp.invoke` and tool policy.

**Manage panel.** It shows status and the reason for it, the tool list, the approval posture, an off switch, Reconnect, and Disconnect or Remove. Remove is a danger action, with confirmation per DESIGN.md. "Advanced setup in Settings" links to the existing detailed editor.

**Add your own.** This hosts today's custom MCP server setup (`McpServerCreate`) inside the panel.

## Skills tab

**Views.** Installed and Discover are two segments over the same search and filters.

**Categories.** There is no curated category field today. Skills have frontmatter `metadata.tags` and `keywords`, `routingHints` and `capabilityCategory`. The builder adds a single category per skill, either a frontmatter field or a mapping kept beside `skills/catalog-coverage.json`, so the category buttons are stable. A second filter group shows where a skill came from: Built in, Imported, Self-authored or Workspace.

**Installed.** Each row has a switch and a usage count from `usageCount`. The switch maps to enabled or disabled (`PATCH /skills/:id/state`). The third state, paused (`sleep`), lives inside the skill's panel.

**Discover.** It uses `GET /api/v1/skills/sources` (AgentSkill, SkillsMP and the curated entries). Entries already installed are marked, not hidden. Import from Git uses the existing import validation with a `git_url`.

**One-step install.** Pressing Install opens the panel, and the Gateway runs the Skill Hub review checks. The panel shows the result: provenance, trust label, what the skill asks for, and any scan findings. One confirmation then runs `install_inactive` and `activate` in sequence through the Gateway. Each step is still recorded as its own Skill Hub operation. A skill is never callable before activation succeeds. If the scan blocks it, the panel says why in plain words, as Hermes does, and offers the details.

**Skill panel.** It shows the SKILL.md body, source and provenance, trust and lifecycle state, uses and last use, and clickable tags that search. The existing lifecycle and policy inspectors from Library move into a collapsed Technical details section.

**Candidates.** Self-generated candidate skills and proposals stay in Library, alongside Skill curator and Journey. The Skills tab shows a "N candidates waiting in Library" link when there are any.

## Tools tab

**Tool groups.** About 14 groups replace the flat list of about 99 registry tools, for example:
- Files
- Web search
- Browser
- Memory
- Shell and code
- Git
- Email and calendar
- Documents
- Messaging
- Webhooks

The group map lives in `@goatcitadel/contracts`, beside the registry's existing `ToolCategory` and `ToolPack`. Every registry tool belongs to exactly one group, and a test enforces that. MCP tools are not listed here; they belong to their connector.

**Groups that can't be switched off.** `mcp.invoke` is not in a switchable group, because connectors control MCP. The session tools, and the memory tools that system jobs depend on, sit in a "Core" group that is shown but has no switch. It explains in one line why.

**Switch.** Off is a Gateway-owned setting that denies the group's tools in every chat (deny-wins). It is recorded as an operator audit event, with no approval request. On only removes that one deny. If a group is on but its tools are denied elsewhere (permission profile, ward or grant), the row says so and links to the rule.

**Row.** Each row shows the group name, its tools, a risk label taken from its riskiest tool (Safe, Caution, Danger or Nuclear), a call count and the switch.

**Call counts.** A new Gateway route aggregates `chat_tool_runs` by tool over the last 365 days, and the groups sum their tools. Zero shows as "No calls yet". When the data is unavailable, the count shows as unknown, never 0. Hermes caches its counts for 10 minutes and bypasses the cache on an explicit refresh, which is worth copying.

**Most used.** This row shows the top 4 groups by calls, once 4 groups have any. Until then it shows the essentials: Files, Web search, Memory and Browser.

**Group panel.** It lists the individual tools with their risk, whether each asks first, and last use. It links to Settings › Safety for detailed grants.

## Plugins tab

**What a plugin is.** A plugin is a manifest that lists pieces:
- skills
- connector (MCP) templates
- tool-group and approval presets
- hooks
- prompt packs, meaning this repo's model-evaluation suites (Library › Prompt packs)

It contributes no executable code that runs inside GoatCitadel. Anything that acts does so through connectors and tools, which are already governed.

**What a plugin may change about governance.** Plugins can come from unverified sources, so a plugin may only add pieces and tighten governance:
- **Presets may only tighten.** They can make something ask first or switch a group off. They can never relax an approval, turn a group on, or lower a risk level.
- **Hooks may only observe.** They can receive lifecycle events. These hook kinds are rejected at inspection:
  - hooks that change approvals (risk level or preview at `approval.create.before`)
  - hooks that rewrite tool names or arguments
  - hooks that set `requiresApproval: false`
  - `managed_package` hooks, which run code
- **No feature flags.** Plugins never carry feature-flag presets. The `runtime_preset` piece type is dropped, so uninstalling a plugin can never switch off durable execution or memory flags.
- **No chat instructions.** Instructions that steer chats arrive only as skills, which go through Skill Hub checks. A plugin has no separate prompt-injection route.

**Built on capability packs.** Capability packs (`packages/contracts/src/capability-packs.ts`) already have asset kinds `skill | addon | mcp_template | plugin | runtime_preset`. Rename the concept to plugin in the UI and contracts, and drop the `addon`, old `plugin` and `runtime_preset` asset kinds. Two of the three built-in packs are Cowork-era bundles made only of feature-flag presets, and the third ends with one. None of them ships as a built-in plugin. If the third has useful non-flag pieces, those can return as a new built-in plugin.

**Sources and trust labels:**
- Built in: shipped with GoatCitadel.
- Installed from Git or a folder: labelled Unverified. The Gateway, never the browser, clones and inspects the source, and the operator can pin a commit.

A Verified tier can come later if there is ever a reviewed external list.

**Install panel.** It lists every piece the plugin will add, what each one asks first, and the source and pin. Inspection must succeed before Install enables. Each piece goes through its own normal checks: skills through Skill Hub review, connectors through host allowlisting, and so on. All of that happens behind one operator confirmation.

**Ownership and uninstall.** Pieces a plugin added show "From plugin X" and can't be edited individually, the same way Hermes treats plugin-supplied MCP servers. Uninstall removes exactly the pieces that plugin added, never ones the operator installed separately.

**Claude Code plugin format.** Investigate this as a spike before promising it. A Claude Code plugin is `.claude-plugin/plugin.json` with `skills/` (the same SKILL.md format) and `.mcp.json`. Importing its skills and MCP servers as a GoatCitadel plugin looks feasible. Its commands, agents and hooks probably don't map, and would be listed as "not supported, ignored" in the panel. The spike ran on 2026-11-01 (`2026-11-01-claude-code-plugin-import-spike.md`) and corrects this paragraph. The two formats share the `SKILL.md` folder shape but not its frontmatter, so skills would come across only through a translation, labelled experimental. MCP import would cover only remote `http`/`sse` servers that exactly match a connector template GoatCitadel ships. stdio servers and other remote servers are left out. Phase 5 waits on the operator's answers there.

**Removals:**
- The Arena add-on, the add-ons service and its `/api/v1/addons/*` routes, add-on dashboard slots, and the Settings › Add-ons & packs page.
- Integration plugins: the `goatcitadel.integration-plugin.json` manifest, `POST /integrations/plugins/install`, the plugin runtime list, and the "Installed plugin trust" UI.
- `packages/extensions-sdk` keeps only what plugins still need.

The builder must handle any stored add-on or integration-plugin records with a migration, and update docs and public claims (`docs/1_0_CONTRACT.md`, extension claims in README and AGENTS.md).

**Naming.** The Citadel and workspace capability scope labelled "Plugins" (`CapabilityScopesSettings.tsx`) actually holds integration connection IDs. Relabel it to match what it holds, so "Plugins" in the UI only ever means this tab.

## Design-system changes

- **DESIGN.md.** Add a scoped exception for catalog surfaces (the Capabilities area). Inside it, a two-column grid of row cards is allowed as the page structure, and so is the Tools tab's "Most used" row of four cards. Banners and hero images stay out.
- **Switch.** Add a shared switch primitive modelled on Hermes's: a pill track filled with the accent when on, a white knob, and a visible On/Off label so the state never relies on colour alone. It needs hover, focus, disabled, pending and error states, and an accessible name that starts with the visible label. DESIGN.md names it the standard on/off control. Capabilities uses it from day one. Migrating existing on/off controls elsewhere in the cockpit can follow, phase by phase.

## Existing pages

- **Library › Skills and tools** (the capability catalog) is replaced by Capabilities one tab at a time. Each Library route redirects only in the phase that ships its matching tab: `/library/skills` with Skills, `/library/tools` with Tools, `/library/capabilities` once both have shipped. Until then the old catalog stays. Its inspectors move into the side panels as each tab ships.
- **Code Mode, mesh entries, candidates and proposals** (`code_mode`, `mesh_tool`, `mesh_mcp_server`, `mesh_skill`, `candidate_skill`, `proposal`) are not on the four tabs in this design. They stay inspectable in Library, in a slimmed catalog view kept for them, so the 1.0 Code Mode inspectability claim holds. Folding mesh entries into the matching tabs with a "From a mesh node" label can come later.
- **Tabs appear as they ship.** Phase 1 shows only Connectors. There are no "coming soon" tabs.
- **Settings › Connections.** Add-ons & packs is removed. MCP servers, Integrations, Channels and Web & Search stay for now as the advanced setup that the panels link to. Whether to retire them from Settings navigation is decided after phase 1 ships.
- **Command palette.** Capability results open the Capabilities item instead of Library.

## Delivery order

Each phase is its own PR, cut from `main`:

1. **Foundation and Connectors.**
   - the Capabilities area and tab shell
   - the switch primitive and the DESIGN.md change
   - the merged connector projection route
   - the Connectors tab with its install and manage panels
   - redirects from the Library routes
2. **Tools.** The group map, the group on/off setting in policy, the call-count route and the Tools tab.
3. **Skills.** Category metadata, the Skills tab and one-step install.
4. **Plugins.** The bundle model on capability packs, Git and folder install, the removals (Arena, add-ons, integration plugins) and the Plugins tab.
5. **Optional: Claude Code plugin import.** Only if the spike says it's sound.

## Borrowed from Hermes

- A shared search with a tab badge and a placeholder drawn from real data, and filter buttons with "+N" overflow.
- One state dot, one reason and one action per row.
- Grouping connectors by state, with broken ones first.
- Optimistic switches with per-row rollback, install-in-place progress, cached instant paint, and "takes effect in new chats" hints.
- Revision-checked saves with a conflict screen ("Reload their version / Save over"), for policy and approval-posture edits.
- The server rejects env names a manifest didn't declare, and plugin-supplied pieces are read-only.
- Scan-blocked failures are turned into a plain explanation.
- Tool-group call counts with a "Most used" row.

## Not borrowed

- The browser writing whole config maps, raw JSON editors as a main path, and secrets passing to `.env` from the browser.
- The renderer fetching catalogs and images from GitHub directly.
- Install and toggle with no governance at all, and auto-enabling unverified sources.
- Desktop plugin code running in the renderer.
- Stars and a 800-entry community plugin catalog.

## Left to the builder

- Exact routes, projection shapes and query keys.
- How the "group off" setting is stored, as long as it is Gateway-owned, deny-wins and audited.
- The exact tool-group list, as long as there are about 14 groups, every tool is in one, and the names are plain.
- How tab counts are computed, and which tabs show one.
- The letter-icon colour rule, which must pass contrast in both themes.
- Whether the Connectors category set needs a mapping from integration kinds.
- How far the switch migration reaches outside Capabilities in each phase.

## Claude's calls (not discussed; check these)

- Capabilities sits between Work and Library in the navigation, and opens on the last tab used, with Connectors on the first visit.
- Web & Search (Firecrawl and the search engines) counts as a connector.
- A "Turned off" group exists on the Connectors tab.
- Settings › Connections pages stay as advanced setup for now, rather than being removed.
- Candidate skills, Skill curator and Journey stay in Library.
- Skill paused state lives in the panel, not on the switch.
- Tool counts cover 365 days, as in Hermes.
- Plugin trust labels are Built in and Unverified at launch, with no Verified tier yet.
- The Citadel "Plugins" scope gets relabelled.
- The phase order above.
- The page acts on the whole install, and uses the active workspace and Citadel for the pieces bound to them (see **Constraints**).
- Tool-group off is enforced in the policy engine, so it reaches every surface. The Core group and `mcp.invoke` can't be switched off.
- An integration is listed only if it has AI-callable tools and a working connect flow.
- Internal MCP surfaces and the `filesystem` and `fetch` templates are left out. The other local templates go under "On this device", with a warning and pinned versions.
- Installing a connector offers, pre-ticked, to let Chat use connectors when that is off. No flag defaults change.
- Plugins may only add pieces and tighten governance. Hooks may only observe, and plugins carry no feature-flag presets. The Cowork-era built-in packs don't become plugins.
- Saved MCP servers keep their current approval posture. The new default applies to new installs.
- Library routes redirect one phase at a time. Code Mode, mesh entries, candidates and proposals stay in a slimmed Library view.
