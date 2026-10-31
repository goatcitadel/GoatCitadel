# Extensions SDK Contract

Last updated: 2026-10-30
Scope: `GC-P2-11` extension SDK breadth

## Purpose

This document defines what the `@goatcitadel/extensions-sdk` package contains today and where author-facing extension work ends and GoatCitadel's own checks begin.

It is the contract baseline for:

- people who build against GoatCitadel's tool catalog
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
| `@goatcitadel/extensions-sdk@2.0.0` | In the workspace; not published yet | The effective-tool snapshot helpers only |
| `@goatcitadel/extensions-sdk@1.0.0` | The last published version, on GitHub Packages | The helpers above, plus the retired add-on and integration-plugin helpers |

`@goatcitadel/extensions-sdk@1.0.0` remains the last published version until 2.0.0 is tagged and published. Treat the retired helpers in 1.0.0 as unsupported against current GoatCitadel.

### What 2.0.0 exports

All of it comes from `effective-tools` and reads a compact tool directory snapshot that the GoatCitadel Gateway produces from its callable catalog:

- `validateCompactToolDirectorySnapshot` checks the snapshot's shape and reports every problem it finds
- `listEffectiveCallableTools` returns the tools a snapshot lists
- `findEffectiveToolByName` returns one tool from a snapshot, or nothing
- `buildToolSchemaRefIndex` maps tool names and schema ref ids to schema refs
- `dereferenceEffectiveToolSchema` fetches one tool's schema through a function you supply

These helpers read data. They grant no tool, activate nothing and run nothing. The Gateway's callable catalog stays the only authority on what a tool may do.

### What 2.0.0 removed

- the add-on manifest validator and loader
- the integration-plugin manifest validator, loader and source resolver
- the configuration-form validator and the static author preflight
- the `goatcitadel-extension-preflight` command
- the reference scaffolds and templates that shipped inside the package

A plugin manifest validator arrives in a later release. Until then, nothing in the SDK validates plugin manifests.

## Extension Families

### 1. Add-ons (removed)

Add-ons, including the Arena add-on, were removed. GoatCitadel no longer has an add-on catalog, service, or install, launch and stop routes, and Settings › Advanced shows capability packs only. Plugins replace add-ons in a later release.

### 2. Integration plugins (removed)

Integration plugins were removed. GoatCitadel no longer installs, lists, enables or disables them. The package files an earlier version saved stay in the `integration-plugins` folder inside the data folder; GoatCitadel does not read or delete them.

This does not touch integrations in general. Connections to services and MCP servers are not plugins and are not affected.

### 3. Skill Bundles

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

- Author surface is what a builder reads and produces: the tool directory snapshot the SDK helpers consume, and a skill bundle's manifest.
- Operator surface is what GoatCitadel uses to review, approve, activate or remove anything: the Gateway's checks, approvals, grants and diagnostics.

The SDK sits wholly on the author side. Nothing it exports can approve, activate or call anything.

## Current Constraints

These are still true after this document lands:

- the source of the package lives in `packages/extensions-sdk/`
- `pnpm verify:extensions:package` builds the package, packs it, extracts the tarball, and checks that the export map resolves and that the packed barrel exports only the helpers listed above
- compatibility depends on the documented package contract plus the Gateway surfaces that produce the snapshots

## Safe Claims Now

- GoatCitadel publishes `@goatcitadel/extensions-sdk`; `1.0.0` is the last published version.
- The workspace version, `2.0.0`, keeps only the effective-tool snapshot helpers and is not published yet.
- Add-ons and integration plugins are removed. GoatCitadel has no plugin install, trust or marketplace surface today.
- Skill bundles keep their review-only manifest contract.

## Recommended Next Slice

1. Add the plugin manifest validator in a later release.
2. Publish `@goatcitadel/extensions-sdk@2.0.0`, so the published line moves off the retired helpers.
3. Keep `@goatcitadel/extensions-sdk` versioned and prepublish-checked as the public author boundary.
