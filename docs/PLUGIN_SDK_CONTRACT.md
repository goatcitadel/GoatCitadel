# Extensions SDK Contract

Last updated: 2026-10-31
Scope: `GC-P2-11` extension SDK breadth

## Purpose

This document defines what the `@goatcitadel/extensions-sdk` package contains today and where author-facing extension work ends and GoatCitadel's own checks begin.

It is the contract baseline for:

- people who build against GoatCitadel's tool catalog
- people who write a plugin and want to check its manifest
- maintainers deciding what the SDK may export

The file keeps its old name, `PLUGIN_SDK_CONTRACT.md`, so existing links still work.

## What This Document Is

- the public contract for the SDK package and its version line
- a separation line between author concerns and operator concerns

## What This Document Is Not

- a guarantee that every ecosystem surface is already feature-complete
- a stable compatibility promise across major architecture changes outside the documented package contract

## The Package

`@goatcitadel/extensions-sdk` lives in `packages/extensions-sdk/`.

| Version | State | Contents |
|---|---|---|
| `@goatcitadel/extensions-sdk@2.0.0` | In the workspace; not published yet | The effective-tool snapshot helpers, the plugin manifest validator and the `goatcitadel-plugin-preflight` command |
| `@goatcitadel/extensions-sdk@1.0.0` | The last published version, on GitHub Packages | The helpers above, plus the retired add-on and integration-plugin helpers |

`@goatcitadel/extensions-sdk@1.0.0` remains the last published version until 2.0.0 is tagged and published. Treat the retired helpers in 1.0.0 as unsupported against current GoatCitadel.

### What 2.0.0 exports

Two groups. The first comes from `effective-tools` and reads a compact tool directory snapshot that the GoatCitadel Gateway produces from its callable catalog:

- `validateCompactToolDirectorySnapshot` checks the snapshot's shape and reports every problem it finds
- `listEffectiveCallableTools` returns the tools a snapshot lists
- `findEffectiveToolByName` returns one tool from a snapshot, or nothing
- `buildToolSchemaRefIndex` maps tool names and schema ref ids to schema refs
- `dereferenceEffectiveToolSchema` fetches one tool's schema through a function you supply

These helpers read data. They grant no tool, activate nothing and run nothing. The Gateway's callable catalog stays the only authority on what a tool may do.

The second group checks a plugin manifest, `goatcitadel-plugin.json`. The schema and the parser live in `@goatcitadel/contracts`, and the SDK re-exports them:

- `parsePluginManifest(text)` checks the text of a manifest and answers either the parsed manifest with its SHA-256, or a refusal with a code and the field it found the problem in. It never throws
- `pluginManifestSchema` is the strict schema behind it
- `loadPluginManifest(dir)` reads the manifest from a plugin folder and parses it. It reads that one file and at most 64 KiB plus one byte of it, and it refuses a manifest that is a symbolic link. It never runs, imports or requires anything from the folder
- `PLUGIN_MANIFEST_FILENAME` and `PLUGIN_LIMITS` are the file name and the size limits

The package also ships one command, `goatcitadel-plugin-preflight [PLUGIN_FOLDER]`. It calls `loadPluginManifest`, prints `ok <pluginId> <manifestSha256>` and exits 0, or prints the refusal code and message and exits 1.

A reference plugin, with a manifest, one skill and one prompt pack, ships in the package under `templates/plugins/reference-plugin/`. Copy it to start a plugin.

### What 2.0.0 removed

- the add-on manifest validator and loader
- the integration-plugin manifest validator, loader and source resolver
- the configuration-form validator and the static author preflight
- the `goatcitadel-extension-preflight` command, which the plugin command above replaces
- the reference scaffolds and templates that shipped inside the package

## Extension Families

### 1. Add-ons (removed)

Add-ons, including the Arena add-on, were removed. GoatCitadel no longer has an add-on catalog, service, or install, launch and stop routes, and Settings › Advanced shows capability packs only. Plugins replace add-ons; see Plugins below.

### 2. Integration plugins (removed)

Integration plugins were removed. GoatCitadel no longer installs, lists, enables or disables them. The package files an earlier version saved stay in the `integration-plugins` folder inside the data folder; GoatCitadel does not read or delete them.

This does not touch integrations in general. Connections to services and MCP servers are not plugins and are not affected.

### 3. Plugins

A plugin is a bundle of pieces that runs no code. Its manifest, `goatcitadel-plugin.json`, lists them. Five kinds of piece exist:

- `skill`: a folder that holds a `SKILL.md`
- `connector`: one of GoatCitadel's shipped connector templates, with how much of it asks first
- `tool_group_off`: holds a tool group off while the plugin is installed
- `hook`: a webhook that only watches one event
- `prompt_pack`: a `.md` file

A manifest can add pieces and tighten rules. It cannot loosen anything. `parsePluginManifest` refuses, by name and before the strict schema runs: feature flags and runtime presets, chat instructions outside a skill, a hook that changes what happens or runs code, a connector that asks first about nothing, a tool group turned on, a piece kind it does not know, and a piece path that is absolute, climbs out of the folder, is not NFC, or that GoatCitadel's copy of the plugin can't hold (an empty or `.` part, a `:`, a name that ends in a dot or a space, a `.git` folder or a Windows device name; `isPortablePluginPath`, the rule the Gateway's copy uses too). Unknown keys, a duplicate piece id and a manifest over 64 KiB are refused too. The `name` and `author` may not hold a control character, a line or paragraph separator (U+2028, U+2029) or a bidi control (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), and the `description` may not hold a control character other than a tab or a line break, or a bidi control; any other character, such as an emoji's zero-width joiner, is allowed. The hook triggers are the ones in `HOOK_TRIGGER_VALUES`.

The Gateway inspects, installs and uninstalls plugins through its Capabilities API, governed by Change Plans. Mission Control has no Plugins tab yet, and GoatCitadel has no plugin trust or marketplace surface. Passing the manifest check installs nothing and grants nothing.

### 4. Skill Bundles

Skill bundles are a separate import workflow, and they are unaffected by the SDK trim.

Current repo-native baseline:

- `apps/gateway/src/services/skill-import-service.ts`
- Optional portable manifest: `goatcitadel.skill-bundle.json`
- Manifest version: `goatcitadel.skill-bundle.v1`
- Allowed asset locations: `SKILL.md`, `references/`, `templates/`, `scripts/`, plus known root metadata files such as `HEARTBEAT.md`, `MESSAGING.md`, `RULES.md`, and `skill.json`
- Required asset evidence: per-asset `sha256`; scripts must declare `callable: false` and the manifest-level `scriptDisposition` must be `review_only_non_callable`

This manifest is a review and portability contract. It lets GoatCitadel validate hosted or local skill bundle assets and preserve source evidence, but it does not make scripts callable, enable a skill, grant tools, or bypass approvals.

## Author Surface Vs Operator Surface

This separation should remain explicit.

- Author surface is what a builder reads and produces: the tool directory snapshot the SDK helpers consume, a plugin manifest and a skill bundle's manifest.
- Operator surface is what GoatCitadel uses to review, approve, activate or remove anything: the Gateway's checks, approvals, grants and diagnostics.

The SDK sits wholly on the author side. Nothing it exports can approve, activate or call anything.

## Current Constraints

These are still true after this document lands:

- the source of the package lives in `packages/extensions-sdk/`
- `pnpm verify:extensions:package` builds the package, packs it, extracts the tarball, and checks that the export map resolves, that the packed barrel exports only the names listed above, that the package declares exactly one command, and that the command accepts the reference plugin in the workspace and in the packed copy
- compatibility depends on the documented package contract plus the Gateway surfaces that produce the snapshots

## Safe Claims Now

- GoatCitadel publishes `@goatcitadel/extensions-sdk`; `1.0.0` is the last published version.
- The workspace version, `2.0.0`, keeps the effective-tool snapshot helpers and adds the plugin manifest validator, with `loadPluginManifest` and the `goatcitadel-plugin-preflight` command, and is not published yet.
- Add-ons and integration plugins are removed. The Gateway inspects, installs and uninstalls plugins through its Capabilities API, governed by Change Plans. Mission Control has no Plugins tab yet, and GoatCitadel has no plugin trust or marketplace surface.
- The SDK can check a plugin manifest. A manifest that passes the check has not been installed, approved or granted anything.
- Skill bundles keep their review-only manifest contract.

## Recommended Next Slice

1. Add the Capabilities › Plugins tab to Mission Control over the Gateway's plugin routes, so an operator can inspect, install and uninstall a plugin without calling the API.
2. Publish `@goatcitadel/extensions-sdk@2.0.0`, so the published line moves off the retired helpers. Bump and publish `@goatcitadel/contracts` in step: the packed SDK depends on the published contracts version, and `@goatcitadel/contracts@1.0.0` has no plugin exports.
3. Keep `@goatcitadel/extensions-sdk` versioned and prepublish-checked as the public author boundary.
