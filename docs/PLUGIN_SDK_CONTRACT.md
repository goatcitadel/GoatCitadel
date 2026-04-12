# Plugin And Add-on SDK Contract

Last updated: 2026-04-11
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

### 1. Add-ons

Add-ons are repo-external applications with explicit catalog and lifecycle management.

Current repo-native contract surface:

- `packages/contracts/src/addons.ts`
- `apps/gateway/src/routes/addons.ts`

Today’s add-on model assumes:

- `runtimeType = "separate_repo_app"`
- explicit trust and consent handling
- install, update, launch, stop, and uninstall lifecycle routes
- optional web entry behavior via `webEntryMode`
- explicit health checks and runtime status

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

An add-on author should currently assume the following minimum contract:

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
- the repo-native starter-pack export path bundles the current contract doc plus reference scaffolds
- the local installable reference integration-plugin scaffold lives in `templates/integration-plugins/reference-integration-plugin/`
- compatibility still depends on the documented package contract plus the repo-native operator/runtime surfaces that consume it

## Safe Claims Now

- GoatCitadel has a documented author contract baseline for add-ons and broader extension work.
- GoatCitadel now has a published `@goatcitadel/extensions-sdk` package for manifest validation and file-loading helpers.
- GoatCitadel now has a schema-validated reference add-on scaffold in `templates/addons/reference-separate-repo-addon/`.
- GoatCitadel now has a local installable reference integration-plugin scaffold in `templates/integration-plugins/reference-integration-plugin/`.
- GoatCitadel now has a repo-native starter-pack export path that bundles the contract doc plus the reference add-on and integration-plugin scaffolds.
- GoatCitadel already has a meaningful operator lifecycle for add-ons and integration plugins.
- The public SDK story is anchored in the published `@goatcitadel/extensions-sdk` package, the reference scaffolds, and the tested starter-pack export path.

## Recommended Next Slice

1. Add install/enable/disable/reporting smoke coverage before widening the public claim past the current starter-pack export path.
2. Keep `@goatcitadel/extensions-sdk` versioned and prepublish-checked as the public author boundary.
3. Only after that, widen the runtime contract beyond lifecycle metadata if it is still justified.
