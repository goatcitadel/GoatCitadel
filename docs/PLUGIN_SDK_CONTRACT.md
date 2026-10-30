# Plugin And Add-on SDK Contract

Last updated: 2026-10-30
Scope: `GC-P2-11` extension / plugin SDK breadth

## Purpose

This document defines the current GoatCitadel author-facing contract for third-party extension work.

It now serves as the published package and repo-native contract baseline for:

- add-on authors
- integration plugin authors
- maintainers deciding where author surface ends and operator lifecycle begins

## What This Document Is

- the public contract for author-facing extension work
- a separation line between author concerns and operator concerns
- the baseline that starter kits, examples, and the published SDK package follow

## What This Document Is Not

- a guarantee that every ecosystem surface is already feature-complete
- a stable compatibility promise across major architecture changes outside the documented package contract

## Current Extension Families

### 1. Add-ons (removed)

Add-ons, including the Arena add-on, were removed. GoatCitadel no longer has an add-on catalog, service, or install, launch and stop routes, and Settings › Advanced shows capability packs only. Plugins replace add-ons in a later release.

The add-on contract types in `packages/contracts/src/addons.ts` and the add-on helpers in `@goatcitadel/extensions-sdk` stay only until the SDK is trimmed. They are not an operator surface.

### 2. Integration Plugins

Integration plugins are gateway-managed connectivity or capability units that participate in the integrations surface.

Current repo-native operator surface:

- `apps/gateway/src/routes/integrations.ts`

Today’s plugin lifecycle includes:

- install from a declared source
- optional metadata discovery from a local `goatcitadel.integration-plugin.json` manifest
- enable or disable
- connection and catalog visibility
- status and config handling through integration routes

### 3. Skill Bundles

Skill bundles are not the same as add-ons or integration plugins, but they are part of the broader extension story because they define a reusable author/import workflow.

Current repo-native baseline:

- `apps/gateway/src/services/skill-import-service.ts`
- Optional portable manifest: `goatcitadel.skill-bundle.json`
- Manifest version: `goatcitadel.skill-bundle.v1`
- Allowed asset locations: `SKILL.md`, `references/`, `templates/`, `scripts/`, plus known root metadata files such as `HEARTBEAT.md`, `MESSAGING.md`, `RULES.md`, and `skill.json`
- Required asset evidence: per-asset `sha256`; scripts must declare `callable: false` and the manifest-level `scriptDisposition` must be `review_only_non_callable`

This manifest is a review and portability contract. It lets GoatCitadel validate hosted or local skill bundle assets and preserve source evidence, but it does not make scripts callable, enable a skill, grant tools, install an add-on, or bypass approvals.

## Author Surface Vs Operator Surface

This separation should remain explicit.

### Author Surface

Author surface is what a third-party builder needs in order to create a valid extension target.

That includes:

- expected metadata
- packaging shape
- trust declarations
- runtime expectations
- health-check expectations
- install-source expectations

### Operator Surface

Operator surface is what GoatCitadel uses to install, run, inspect, approve, or remove an extension.

That includes:

- catalog browsing
- install/update/uninstall routes
- launch/stop/runtime state
- consent capture
- connection records
- admin status and diagnostics

The operator surface already exists in code. The author surface is what this document is standardizing.

## Minimum Add-on Author Contract

Retired: add-ons were removed in Phase 4 (see above). This section stays only until the SDK trim removes the add-on helpers.

The last add-on author contract was:

### Metadata

- unique `addonId`
- human-readable `label`
- short `description`
- `owner`
- upstream `repoUrl`

### Trust And Distribution

- explicit `trustTier`
- explicit `sameOwnerAsGoatCitadel`
- `requiresSeparateRepoDownload = true`

### Runtime Model

- `runtimeType = "separate_repo_app"`
- declared `webEntryMode`
- optional `launchUrl`
- optional `launch` contract (data only): `command` and `args` run in the install directory with a secret-free environment plus static `env`; `dataFiles` keep durable files under the add-ons data root and pass their paths in named env vars; `health` is a loopback `http` JSON probe whose `readyWhen` fields must all match within `readyTimeoutMs`. An add-on without `launch` cannot be launched from GoatCitadel. The SDK validator and the Gateway both enforce this shape.

### Install UX

- one or more `installCommands`
- install instructions that work without hidden manual repo surgery

### Health Model

- declared `healthChecks`
- truthful runtime/error reporting

## Minimum Integration Plugin Contract

Integration plugin authors should assume:

- a stable plugin identifier
- install source that can be reviewed and reproduced
- a local manifest file named `goatcitadel.integration-plugin.json` when the source is a repo or directory scaffold
- explicit enable/disable behavior
- no silent mutation of connection state
- config and status that can be surfaced honestly through integration routes

## Current Constraints

These are still true after this document lands:

- the published author package is `@goatcitadel/extensions-sdk@1.0.0`
- the source of that package lives in `packages/extensions-sdk/`
- the local installable reference integration-plugin scaffold lives in `templates/integration-plugins/reference-integration-plugin/`
- compatibility still depends on the documented package contract plus the repo-native operator/runtime surfaces that consume it

## Safe Claims Now

- GoatCitadel has a documented author contract baseline for integration plugins and broader extension work.
- GoatCitadel now has a published `@goatcitadel/extensions-sdk` package for manifest validation and file-loading helpers.
- GoatCitadel now has a schema-validated reference add-on scaffold in `templates/addons/reference-separate-repo-addon/`.
- GoatCitadel now has a local installable reference integration-plugin scaffold in `templates/integration-plugins/reference-integration-plugin/`.
- GoatCitadel already has a meaningful operator lifecycle for integration plugins.
- The public SDK story is anchored in the published `@goatcitadel/extensions-sdk` package and the reference scaffolds.
- npm plugin packages are downloaded through the network allowlist and verified against SRI sha512 (operator-pinned or registry-published) before they are recorded as verified; local plugin folders get a deterministic sha256 file-manifest hash; git and URL sources are recorded as unverified. A mismatch quarantines and disables the plugin. The registry host (`registry.npmjs.org`) must be in the network allowlist, otherwise npm plugins are recorded as unverified and disabled; local hashes are checked at install time only.

## Recommended Next Slice

1. Add install/enable/disable/reporting smoke coverage before widening the public claim past the current package contract.
2. Keep `@goatcitadel/extensions-sdk` versioned and prepublish-checked as the public author boundary.
3. Only after that, widen the runtime contract beyond lifecycle metadata if it is still justified.
