# Claude Code plugin import: spike report

Date: 2026-11-01. Base: `main` at eddec59e3 (after PR 4d, #690). This answers the spike that
`2026-10-25-capabilities-hub-design.md` asks for before Phase 5 ("Optional: Claude Code plugin import"): can a Claude
Code plugin be imported soundly as a GoatCitadel plugin?

What was done:

- Read the current Claude Code plugin docs on 2026-11-01. Every doc fact this report relies on was checked on the live
  page: [plugins/manifest-reference], [plugins/components], [plugins/security], [plugins/marketplace-reference],
  [skills], [mcp], [hooks], and the [Agent Skills spec].
- Read GoatCitadel's plugin manifest, source, inspection and install code, and the Plugins section of
  `docs/CANONICAL_RUNTIME_STATE_MODEL.md`.
- Ran a throwaway, read-only probe (not committed) over 69 real Claude Code plugins:
  - the 54 plugin folders of Anthropic's official marketplace checkout
  - 11 plugins synced from claude.ai (the knowledge-work set)
  - three cached installs (superpowers, supabase, coderabbit)
  - the Anthropic agent-skills marketplace

  It checked each piece against GoatCitadel's current rules. It did not run the Skill Hub's promptware, script or
  network scans, so the skill numbers below are an upper bound.

No product code changed.

## Verdict

**Sound, but narrow.** A Claude Code plugin can be imported honestly only as a *translation* into a GoatCitadel
manifest with two piece kinds:

1. **Skills**, after one change to the Skill Hub review (a Claude Code frontmatter dialect, below).
2. **Remote connectors whose address exactly matches a connector template GoatCitadel already ships.**

Everything else in a Claude Code plugin is code, steers chats outside a skill, or loosens a rule. It is listed under
"Left out" with a plain reason and never runs. That is consistent with every plugin rule GoatCitadel has today: no
executable code, hooks only observe, presets only tighten, connectors only from GoatCitadel's own list.

What that buys, measured on the 69-plugin sample:

| | Count |
|---|---|
| Plugins with at least one piece GoatCitadel could take | 33 of 69 |
| Plugins that would import with nothing left out | 12 of 69 |
| Plugins with no skill and no MCP server (nothing to take) | 25 of 69 (commands, agents, hooks, LSP or output styles only) |
| Skills whose frontmatter passes the Skill Hub review today, unchanged | 41 of 179 |
| Skills that pass once the review ignores Claude Code's harmless keys | 172 of 179 (174 with the `metadata` keys proposed below) |
| Of those 172, skills that would behave the same as in Claude Code | 52 (no shell lines, no placeholders, no supporting files) |
| Distinct remote MCP addresses that match a shipped template exactly | 16 of 60 (44 of 123 remote entries) |
| stdio MCP servers that could be imported | 0 of 10 |

The plugin rows count what maps, before size and source limits. One of the 33 is the agent-skills marketplace, which
can't be fetched as it stands (see Sources).

**Recommendation.** Build Phase 5 only at this narrow scope, labelled experimental, and only if the operator wants skill
bundles (superpowers, the knowledge-work plugins, Anthropic's agent skills) and vendor connector bundles (Notion,
Linear, Asana, Figma and similar) to install in one step. Don't describe it as "Claude Code plugins work in GoatCitadel".
Most plugins carry their value in commands, agents, hooks and local MCP servers, and none of those can come across.

## Piece-by-piece mapping

### The manifest

A GoatCitadel manifest (`packages/contracts/src/plugins.ts:151-169`) is generated from the Claude Code plugin. It is
never hand-written and never read from the Claude Code files as if it were GoatCitadel's own. It then goes through the
same `parsePluginManifest`, so every named refusal applies to it.

| Claude Code (`.claude-plugin/plugin.json`) | GoatCitadel | Notes |
|---|---|---|
| The manifest file itself | Generated `goatcitadel-plugin.json` | Optional in Claude Code ("The manifest is optional"). Without it the layout alone defines the plugin, and the name comes from the folder or marketplace entry. |
| `name` (the only required key) | `pluginId` | All 69 sample names pass `PLUGIN_ID_PATTERN` (`plugins.ts:94`). The existing `PLUGIN_ID_RESERVED` check still applies. |
| `displayName`, else `name` | `name` | |
| `description` (optional) | `description` (required, 1–500 chars) | A plugin without one gets a fixed line that says so. The import never makes up a description. |
| `version` (optional, 36 of 54 have it) | `version` (required) | When it's missing, use the pinned commit's first 12 hex characters, or `content-<12 hex>` for a folder. |
| `author` (an object, `name` required) | `author` (a string) | Name only. |
| `homepage` | `homepage` | Only when `https`. |
| `repository`, `license`, `keywords`, `icon`, URLs, `$schema`, `metadata` | Left out | The license file stays in the snapshot, and the Skill Hub records `LICENSE_PRESENT`. |
| `userConfig` | Left out | Claude Code prompts for these values at enable time and keeps `sensitive` ones in secure storage. GoatCitadel never prompts on a plugin's behalf, and nothing that would read the values is imported anyway. |
| `dependencies` (other plugins) | Left out | Plugins listed here are not fetched. |
| `defaultEnabled`, `settings`, `channels`, `workflows`, `experimental.*` | Left out | |

The inspection contract already has a place for this: `CapabilityPluginInspection.ignored` ("Parts of a foreign plugin
format that were left out", `packages/contracts/src/capability-plugins.ts:50`), which is always `[]` today
(`capability-plugin-inspection-service.ts:232`).

### Components

| Claude Code piece | GoatCitadel piece | Verdict |
|---|---|---|
| `skills/<name>/SKILL.md`, and extra `skills` paths | `skill` | **Maps**, through the Skill Hub review with the dialect below. |
| `.mcp.json` or inline `mcpServers`, remote (`http`, `sse`), address equal to a shipped template's | `connector` (`templateId`) | **Maps.** The connector is GoatCitadel's template, not the plugin's settings (see MCP). |
| Remote MCP server with any other address | — | **Left out.** "This app isn't in GoatCitadel's connector list. Add it yourself in Connectors." |
| stdio MCP server | — | **Left out.** It runs a program (see MCP). |
| `commands/*.md` | — | **Left out.** Claude Code calls commands the older form of skills, with the same frontmatter. They are user-run prompts built around `$ARGUMENTS`, and they have no `name`. Turning one into a skill would mean writing new frontmatter, so the reviewed bytes would no longer be the source's. A later version could map them to explicit-only skills. |
| `agents/*.md` | — | **Left out.** A subagent is a system prompt plus a tool list and model. That steers chats outside a skill (`CHAT_INSTRUCTIONS_NOT_ALLOWED` in spirit), and GoatCitadel's agent roles are owned by `packages/contracts/src/agents.ts`, not plugins. |
| `hooks/hooks.json`, inline `hooks`, hook modules | — | **Left out.** See Hooks. |
| `output-styles/` | — | **Left out.** It rewrites how replies are written: chat steering outside a skill. |
| `.lsp.json` or `lspServers` | — | **Left out.** Each one starts a language server program. In the official marketplace all 12 LSP plugins declare their servers in `marketplace.json`, not in the plugin folder. |
| `monitors/` | — | **Left out.** A background shell command "with your full user permissions and outside the sandbox". |
| `bin/` | — | **Left out.** Executables put on the Bash tool's `PATH`. |
| `settings.json`, `themes/`, `workflows/` | — | **Left out.** |
| Root `SKILL.md` (a one-skill plugin) | `skill` | **Maps**, like `skills/`. |

GoatCitadel's `tool_group_off`, `hook` and `prompt_pack` pieces have no Claude Code source. The import never makes
them.

### Skills and the Skill Hub's rules

Claude Code and GoatCitadel use the same `SKILL.md` folder shape, but not the same frontmatter.

- **The Skill Hub review refuses every frontmatter key it doesn't know.** `assertKnownFrontmatterShape`
  (`apps/gateway/src/services/skill-hub-review-service.ts:718-735`) allows only `name`, `description` and `metadata`,
  with `metadata` keys `version`, `tags`, `tools`, `requires` and `keywords`. Anything else is
  `UNKNOWN_FRONTMATTER_DIMENSION`, a blocker. The runtime parser is lenient (`SkillFrontmatterSchema` is
  `.passthrough()`, `packages/skills/src/frontmatter.ts:31-37`). It does require `name` and `description`, which Claude Code makes
  optional; all 179 sample skills have both.
- **Claude Code skills carry many more keys.** The docs list `when_to_use`, `argument-hint`, `arguments`,
  `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`,
  `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`, `license` and `compatibility`. In the sample:
  `allowed-tools` 54, `argument-hint` 47, `license` 19, `version` 15 (not a documented key), `user-invocable` 10,
  `disallowed-tools` 2, `disable-model-invocation` 2, a non-standard top-level `tools` 2, `compatibility` 2.

The fix that keeps exact-byte provenance is a **Claude Code dialect in the review**, applied only to skills of a
Claude Code-format plugin. Each key falls into one of three groups:

| Group | Keys | Why |
|---|---|---|
| Ignore, and record that it was ignored | `allowed-tools`, `argument-hint`, `license`, `compatibility`, `version`, `model`, `effort`, `when_to_use`, and these `metadata` keys only: `author`, `organization`, `date`, `abstract` | Leaving these out never widens what the model may do. GoatCitadel's own tool rules, approvals and model selection apply. `allowed-tools` is a pre-approval in Claude Code, and GoatCitadel never grants from it. `when_to_use` loses its routing hints, and the panel says so. |
| Ignore, with a visible warning on the piece | `user-invocable` | `user-invocable: false` hides a skill from Claude Code's `/` menu, so only the model starts it. GoatCitadel has no such flag: once the skill is on, the operator can still start it by name (`use <name>`). This widens what the operator can start, never what the model may do. The warning says so. |
| Refuse, with a named code | `disable-model-invocation`, `disallowed-tools`, `paths`, `hooks`, `context`, `agent`, `background` | Leaving these out would loosen the skill or change where it runs. A skill the author kept out of automatic use would become routable, a removed tool would come back, activation limited to some files would widen, or a guard hook would vanish. |
| Refuse, as `UNKNOWN_FRONTMATTER_DIMENSION` | Any other key, top-level or under `metadata` | Same rule as today, so a key Claude Code or an author adds later fails closed until it is reviewed. |

Body features that execute or substitute are a separate check:

- **Shell lines.** `` !`<command>` `` and fenced ```` ```! ```` blocks run shell commands before the skill reaches the
  model in Claude Code ("runs shell commands before the skill content is sent to Claude"). GoatCitadel never runs them,
  but the text would reach the model as an instruction to run a command. **Refuse** these skills (2 in the sample).
- **Placeholders.** `$ARGUMENTS`, `$0`, `$1`… and `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_SESSION_ID}`
  are filled in by Claude Code. GoatCitadel would pass them through as literal text. **Warn** on the piece (42 skills
  use argument placeholders, 9 use `${CLAUDE_*}`).
- **Supporting files.** For every skill except two bundled ones, GoatCitadel puts only `SKILL.md` into the model's
  context (`resolveSkillModules` falls back to `mainRoute`, `packages/skills/src/skill-module-routes.ts:185-209`). Claude Code
  skills often point at `references/`, `scripts/` or `assets/`. **Warn**: "N other files in this skill are kept but
  never read" (80 of the 172 skills have such files).
- **Names.** Claude Code namespaces plugin skills (`/<plugin>:<skill>`), and GoatCitadel's skill names are global.
  Six names occur in more than one sample plugin (`access`, `configure`, `frontend-design`, `skill-creator`,
  `code-review`, `competitive-brief`). For those, the existing check blocks the second import, because both would be
  `extra:<name>` (`RUNTIME_ALREADY_EXISTS`, `skill-hub-operator-service.ts:684`, shown as "A skill with this name is
  already installed."). Keep that block. Renaming would change the reviewed bytes. Two sample skills share a name with
  a bundled GoatCitadel skill (`documentation`, `receiving-code-review`). That check doesn't catch them: a bundled
  skill's id is `bundled:<name>`. The spike didn't verify what routing or `use <name>` does with two skills of one name.

The rest of the review (promptware scan, script and network scans, `install_inactive`, then `activate` under HX-402)
is unchanged. A plugin skill is never callable before activation, as today.

### MCP servers: transports, env and secrets

**Remote (`http`, `sse`).** Match only on transport plus the exact address: lower-case host, path without a trailing
slash, and no query or fragment. The match must also pass `findInstallableConnectorTemplate`
(`apps/gateway/src/services/connector-install-change-plan-adapter.ts:271-290`). That refuses internal and excluded
templates, refuses API-key templates ("needs an API key. Set it up in Settings.", `:280`), and needs a sign-in source
for OAuth ones. The 61 vendor templates (`mcp-vendor-server-templates.ts`) are all remote, signing in with OAuth
metadata discovery or not at all, so they are the realistic targets.

- What comes across is **GoatCitadel's template**: its hosts, its sign-in, its policy, and asking first for changes.
  The plugin's `headers`, `headersHelper`, `oauth` and `env` are dropped, and the panel says "GoatCitadel signs in its
  own way". Example: the official `github` plugin sends `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`, and
  GoatCitadel's `github` template signs in with OAuth instead.
- Addresses with `${VAR}`, a query string (context7's `?client=claude-code-plugin`) or a different path (Atlassian's
  `/v1/mcp` against the template's `/v1/mcp/authv2`) don't match. They are left out, never guessed.
- Plugin values are never copied into GoatCitadel config. GoatCitadel's own model has no `env` value map. A stdio child
  gets only `MCP_SAFE_ENV_KEYS` plus the names in `policy.allowedEnvKeys`, read from the Gateway's environment or the
  keychain-held static environment (`mcp-static-environment-service.ts:19-46`). Remote auth is a Bearer token from one
  declared variable, or OAuth (`mcp-transport-credentials.ts:24-49`). There are no free-form headers. This matches the
  Hermes rule the design borrows: the server rejects env names a manifest didn't declare.

**stdio.** Never imported:

- A plugin's `connector` piece names a shipped template only (`plugins.ts:37`, as the operator decided for Phase 4).
  An arbitrary command has no template.
- The only stdio package GoatCitadel installs through its reviewed path (pinned archives, verified hashes, downloads
  through the allowlist) is the exact Playwright template at `@playwright/mcp@0.0.80`. Other stdio definitions "retain
  their existing trusted-process execution semantics" (`reviewed-mcp-package.ts:23-31`). Importing one would hand an
  unverified plugin a process with the Gateway's authority.
- In the sample, 4 of 10 run the plugin's own bundled code (`bun run --cwd ${CLAUDE_PLUGIN_ROOT} … start`), which breaks
  "runs no code" outright. The rest use `@latest` (`firebase-tools@latest`, `@playwright/mcp@latest`), an unpinned Git
  install (`uvx --from git+https://…`), Docker, or the user's own PHP project. None matches the reviewed Playwright
  package, not even the official `playwright` plugin.

Claude Code starts a plugin's MCP servers as soon as the plugin is enabled. GoatCitadel installs matched connectors
switched off, the way PR 4d does today.

### Hooks

Claude Code hooks are handlers on over 30 events, of types `command`, `http`, `mcp_tool`, `prompt` and `agent`, and
plugins can also ship JavaScript hook modules. They can block (exit code 2), rewrite tool input (`updatedInput`), replace tool
output, decide permissions (`permissionDecision`), and add text to the context (`additionalContext`). All 8 sample
plugins with hooks use `command` hooks.

A GoatCitadel hook piece is an observe-only signed `https` webhook on a GoatCitadel event (`plugins.ts:41`,
`HOOK_TRIGGER_VALUES` in `packages/contracts/src/hooks.ts`). A command hook has no address, and an `http` hook expects
its reply to steer the action. The event sets differ too. **Left out, every kind.** Mapping an `http` hook to an
observe-only webhook would keep the address but drop what the author meant it to do, which is worse than leaving it out.

### Trust

Always **Unverified**, including plugins from Anthropic's official marketplace. Claude Code's own docs say a plugin "can
execute arbitrary code on your machine with your user privileges", and that Anthropic "cannot verify" what plugins
contain or that they won't change. GoatCitadel checks pieces, not authors (`PluginTrust`, `plugins.ts:28-29`). The panel
reads "Claude Code format · Unverified".

### Sources

- **Folder:** works as today (refused on `remote_hardened`).
- **Git:** works only when the repository *is* the plugin. GoatCitadel fetches a whole repository with no subfolder
  (`FetchGitTreeInput`, `hardened-git.ts:550-556`), within 256 files and 8 MiB (`PLUGIN_LIMITS`, `plugins.ts:20-26`).
  In the official marketplace, 152 of 315 entries live in a subfolder (`git-subdir` 99, relative path 53). The
  relative-path ones sit in the marketplace repository itself, which is 581 files and 15 MB. Anthropic's agent-skills
  marketplace defines five plugins as `marketplace.json` entries (`strict: false`) over one shared tree of 446 files.
  Neither repository fits those limits, and a `git-subdir` plugin isn't at its repository's root.
- **Marketplace resolution** (picking a plugin by name from `.claude-plugin/marketplace.json`, following its `source`)
  is a separate feature, left out of a first version.
- Claude Code copies plugins into a cache, installs their Node dependencies automatically, and can update them in the
  background when a marketplace has auto-update on.
  GoatCitadel installs nothing extra, runs no package manager, and stays pinned to the commit or content hash it
  inspected.

## Open risks

1. **A plugin can look installed while its core is missing.** For example, `code-modernization` has no skill and no MCP
   server: it is all commands, agents and hooks. The panel must lead with coverage (wording such as "GoatCitadel can
   use 3 of this plugin's 11 parts") and the left-out list, not bury them under Technical details.
2. **Skills can refer to parts that were left out.** Their text may tell the model to run `/plugin:command`, call
   `mcp__plugin_<plugin>_<server>__<tool>`, use a subagent or run `${CLAUDE_PLUGIN_ROOT}/scripts/…`. The import can flag
   the obvious patterns, but can't prove a skill still makes sense on its own.
3. **Updates are blocked.** Claude Code plugins change often. In GoatCitadel an update is an uninstall and a reinstall,
   and a plugin whose skill was installed can't be installed again until skills can be removed
   (`CANONICAL_RUNTIME_STATE_MODEL.md`, Plugins, "Reinstall"). Phase 5 inherits this limit at its worst.
4. **Real pass rates are lower than this report's numbers.** The Skill Hub's promptware, script and network scans were
   not run on the sample. Agentic skills that tell the model to run commands may well trip them.
5. **Size limits bite.** `small-business` would make 48 pieces against the 32-piece limit, and `code-modernization` has
   two files over 1 MiB.
6. **The translation must not drift.** If apply trusted a manifest stored at inspection time, a translator change
   between inspect and install could install something the operator didn't see. Apply should translate the verified
   snapshot again and refuse when the result's hash differs. Uninstall and the detail view read the manifest too, so
   they need the same translation.
7. **The dialect touches a security check.** `UNKNOWN_FRONTMATTER_DIMENSION` exists so that new permission-bearing keys
   fail closed. The dialect must stay limited to Claude Code-format plugin skills and to keys named in an explicit
   list. A key Claude Code adds later is refused until someone reviews it.
8. **Public claims.** `docs/1_0_CONTRACT.md` and the README must say exactly what comes across and that it is
   experimental. Claude Code's reserved-name rules (no `claude-` or `anthropic-` prefixes) are its own and don't need
   copying. GoatCitadel must not suggest Anthropic endorses an import.
9. **Sample bias.** The sample is what the operator has installed: Anthropic's official marketplace and Anthropic's
   knowledge-work plugins. Community plugins may lean further toward commands, hooks and stdio servers.

## Questions for the operator

1. **Build Phase 5 at this narrow scope, or not at all?** Recommended: build it, labelled experimental.
2. **Frontmatter: a Claude Code dialect in the Skill Hub review** (recommended; exact bytes kept), rewriting `SKILL.md`
   during import (loses exact-byte provenance), or refusing every skill with an extra key (41 of 179 pass)?
3. **Git subfolders** (Claude Code's `git-subdir`) in the first version, or later? Without them, about half of the
   official marketplace can only come in as a folder the operator cloned.
4. **Name clashes:** keep blocking a second skill of the same name (recommended), or install under a
   `<plugin>-<skill>` name? Separately, should a plugin skill that shares a name with a bundled skill be blocked too?
   Today nothing blocks it.

## Rough task list for a Phase 5 plan (if approved)

PR 5a, translation and inspection (contracts and Gateway):

1. Contracts: a source format (`goatcitadel` | `claude_code`) on the inspection, the translator version, the SHA-256 of
   the Claude Code `plugin.json` when there is one, a coverage count, and a filled `ignored` list.
2. A pure, versioned `translateClaudeCodePlugin(snapshotDir)`. It makes bounded reads of the optional `plugin.json`,
   the default folders plus `skills` paths, and `.mcp.json` and inline `mcpServers`. It returns generated manifest
   text, which goes through `parsePluginManifest`, plus one `ignored` entry per left-out part with a plain reason. It
   never executes anything and never follows a path outside the snapshot.
3. Format detection in `CapabilityPluginInspectionService.inspect`: a `goatcitadel-plugin.json` wins. Otherwise a
   `.claude-plugin/plugin.json` or the Claude Code layout uses the translator. Otherwise `MANIFEST_MISSING`, as today. A
   plugin with nothing to take is refused with its full `ignored` list.
4. Connector matching: transport plus exact address against `MCP_SERVER_TEMPLATES`, then
   `findInstallableConnectorTemplate`. stdio and unmatched servers go to `ignored`.
5. Install, uninstall, list and detail read the translated manifest. Apply translates the verified snapshot again and
   refuses when the hash differs.

PR 5b, the Skill Hub dialect:

6. The ignore and refuse lists above for skills whose plugin is Claude Code-format, with named blocker codes. Ignored
   keys are recorded in the review's audit findings.
7. Refuse `` !` `` and ```` ```! ```` shell lines in those skills.
8. Piece warnings for placeholders, supporting files that are never read, and references to left-out parts.

PR 5c, the panel (after the Plugins tab, PR 4e):

9. The "Claude Code format · Unverified" label, the coverage line, a left-out list grouped by kind with reasons, and the
   per-skill warnings.

Throughout:

10. Docs: the Plugins section of `CANONICAL_RUNTIME_STATE_MODEL.md`, `docs/1_0_CONTRACT.md` wording, the plugin and
    extension claims in `README.md` and `AGENTS.md` (scope and experimental status, per risk 8), and the hub design's
    Phase 5 status.
11. Tests on synthetic fixtures for each component kind and each refusal. Live proof: inspect and install a public
    Claude Code plugin pinned to a commit. superpowers is a good candidate: its 15 skills all pass the dialect, and its
    `receiving-code-review` shares a name with a bundled skill, the unverified case above.

Later, and only on request: Git subfolder sources, marketplace resolution, commands as explicit-only skills, and
adding vendor templates for frequently unmatched hosts (Slack, Atlassian `/v1/mcp`, HubSpot) through the normal template
review. That last one is independent of Phase 5.

[plugins/manifest-reference]: https://code.claude.com/docs/en/plugins/manifest-reference
[plugins/components]: https://code.claude.com/docs/en/plugins/components
[plugins/security]: https://code.claude.com/docs/en/plugins/security
[plugins/marketplace-reference]: https://code.claude.com/docs/en/plugins/marketplace-reference
[skills]: https://code.claude.com/docs/en/skills
[mcp]: https://code.claude.com/docs/en/mcp
[hooks]: https://code.claude.com/docs/en/hooks
[Agent Skills spec]: https://agentskills.io/specification
